// src/server/services/communication-service.ts
// Разговори по контекст, вътрешни бележки и известия (Section 12)

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import type { DocumentAudience } from '../../domain/types.ts';

export class CommunicationService {
  private db: Database;
  private policy: AccessPolicy;

  constructor(db: Database) {
    this.db = db;
    this.policy = new AccessPolicy(db);
  }

  /**
   * Почистване на текст от опасен HTML/JS (T38 & Section 18.2)
   */
  public sanitizeText(input: string): string {
    return input
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Създаване на нишка за разговор по контекст
   */
  public getOrCreateThread(params: {
    eventId: string;
    actorUserId: string;
    milestoneId?: string | null;
    proposalVersionId?: string | null;
    documentId?: string | null;
    audience: DocumentAudience;
    requiresBudgetPermission?: boolean;
  }): { threadId: string } {
    if (!this.policy.canReadEvent(params.eventId, params.actorUserId)) {
      throw new Error('Нямате достъп до това събитие');
    }

    if (params.audience === 'team' && !this.policy.canManageEvent(params.eventId, params.actorUserId)) {
      throw new Error('Само екипът може да създава вътрешни бележки');
    }

    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string };

    const existing = this.db.prepare(`
      SELECT id FROM threads
      WHERE event_id = ?
        AND (milestone_id IS ? OR milestone_id = ?)
        AND (proposal_version_id IS ? OR proposal_version_id = ?)
        AND (document_id IS ? OR document_id = ?)
        AND audience = ?
    `).get(
      params.eventId,
      params.milestoneId || null, params.milestoneId || null,
      params.proposalVersionId || null, params.proposalVersionId || null,
      params.documentId || null, params.documentId || null,
      params.audience
    ) as { id: string } | undefined;

    if (existing) {
      return { threadId: existing.id };
    }

    const threadId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO threads (
        id, org_id, event_id, milestone_id, proposal_version_id, document_id,
        audience, requires_budget_permission, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      threadId,
      event.org_id,
      params.eventId,
      params.milestoneId || null,
      params.proposalVersionId || null,
      params.documentId || null,
      params.audience,
      params.requiresBudgetPermission ? 1 : 0,
      nowIso
    );

    return { threadId };
  }

  /**
   * Добавяне на коментар
   */
  public addComment(params: {
    threadId: string;
    actorUserId: string;
    body: string;
  }): { commentId: string; safeBody: string } {
    const thread = this.db.prepare(`
      SELECT org_id, event_id, audience, requires_budget_permission FROM threads WHERE id = ?
    `).get(params.threadId) as {
      org_id: string; event_id: string; audience: string; requires_budget_permission: number;
    } | undefined;

    if (!thread) throw new Error('Нишката не съществува');

    if (thread.audience === 'team' && !this.policy.canManageEvent(thread.event_id, params.actorUserId)) {
      throw new Error('Нямате достъп до тази вътрешна нишка');
    }

    if (!this.policy.canReadEvent(thread.event_id, params.actorUserId)) {
      throw new Error('Нямате достъп до това събитие');
    }

    if (thread.requires_budget_permission === 1 && !this.policy.canReadBudget(thread.event_id, params.actorUserId)) {
      throw new Error('Липсва финансово право за тази тема');
    }

    const commentId = crypto.randomUUID();
    const safeBody = this.sanitizeText(params.body);
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO comments (id, thread_id, org_id, event_id, author_id, body, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(commentId, params.threadId, thread.org_id, thread.event_id, params.actorUserId, safeBody, nowIso);

    return { commentId, safeBody };
  }

  /**
   * Извличане на коментари (T10: Вътрешна бележка никога не се показва в клиентски отговори!)
   */
  public getComments(threadId: string, userId: string): {
    id: string;
    authorName: string;
    body: string;
    createdAt: string;
  }[] {
    const thread = this.db.prepare(`
      SELECT event_id, audience, requires_budget_permission FROM threads WHERE id = ?
    `).get(threadId) as { event_id: string; audience: string; requires_budget_permission: number } | undefined;

    if (!thread) return [];

    if (thread.audience === 'team' && !this.policy.canManageEvent(thread.event_id, userId)) {
      return []; // Строго скриване на вътрешни бележки за клиента
    }

    if (!this.policy.canReadEvent(thread.event_id, userId)) {
      return [];
    }

    if (thread.requires_budget_permission === 1 && !this.policy.canReadBudget(thread.event_id, userId)) {
      return [];
    }

    const rows = this.db.prepare(`
      SELECT c.id, c.body, c.created_at, p.display_name as author_name
      FROM comments c
      JOIN profiles p ON p.user_id = c.author_id
      WHERE c.thread_id = ? AND c.deleted_at IS NULL
      ORDER BY c.created_at ASC
    `).all(threadId) as { id: string; body: string; created_at: string; author_name: string }[];

    return rows.map(r => ({
      id: r.id,
      authorName: r.author_name,
      body: r.body,
      createdAt: r.created_at
    }));
  }
}
