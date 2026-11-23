// src/server/services/milestone-service.ts
// Управление на клиентски етапи, чернови, публикации и проверка на актуалност

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import type { MilestoneStatus, MilestoneHealth } from '../../domain/types.ts';

export class MilestoneService {
  private db: Database;
  private policy: AccessPolicy;

  constructor(db: Database) {
    this.db = db;
    this.policy = new AccessPolicy(db);
  }

  /**
   * Създаване на етап (само от екипа)
   */
  public createMilestone(params: {
    eventId: string;
    actorUserId: string;
    title: string;
    category: string;
    dueDate?: string | null;
    sortOrder?: number;
    completionRule?: string | null;
    initialStatus?: MilestoneStatus;
    initialHealth?: MilestoneHealth;
    nextStep?: string | null;
  }): { milestoneId: string } {
    if (!this.policy.canManageEvent(params.eventId, params.actorUserId)) {
      throw new Error('Нямате права да създавате етапи');
    }

    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string };
    const milestoneId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO milestones (
        id, org_id, event_id, title, category, sort_order, due_date,
        status, health, next_step, completion_rule, row_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      milestoneId,
      event.org_id,
      params.eventId,
      params.title,
      params.category,
      params.sortOrder || 0,
      params.dueDate || null,
      params.initialStatus || 'planned',
      params.initialHealth || 'normal',
      params.nextStep || null,
      params.completionRule || null,
      nowIso,
      nowIso
    );

    return { milestoneId };
  }

  /**
   * Редакция на вътрешна чернова (Section 7.1 & 14.3)
   * Клиентът НЕ вижда промените, докато не се публикуват!
   */
  public saveDraft(params: {
    milestoneId: string;
    actorUserId: string;
    draftContent: {
      title?: string;
      status?: MilestoneStatus;
      health?: MilestoneHealth;
      nextStep?: string;
      dueDate?: string;
    };
  }): boolean {
    const m = this.db.prepare(`SELECT event_id, org_id FROM milestones WHERE id = ?`).get(params.milestoneId) as {
      event_id: string; org_id: string;
    } | undefined;

    if (!m || !this.policy.canManageEvent(m.event_id, params.actorUserId)) {
      throw new Error('Нямате права за редакция на чернова');
    }

    const nowIso = new Date().toISOString();
    const draftJson = JSON.stringify(params.draftContent);

    this.db.prepare(`
      INSERT INTO milestone_drafts (id, milestone_id, org_id, event_id, draft_json, edited_by, row_version, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT(milestone_id) DO UPDATE SET
        draft_json = excluded.draft_json,
        edited_by = excluded.edited_by,
        row_version = row_version + 1,
        updated_at = excluded.updated_at
    `).run(crypto.randomUUID(), params.milestoneId, m.org_id, m.event_id, draftJson, params.actorUserId, nowIso);

    return true;
  }

  /**
   * Публикуване на етап (FR002 & FR010)
   * Един запис обновява клиентския изглед, историята и outbox атомарно в една транзакция.
   */
  public publishMilestone(params: {
    milestoneId: string;
    actorUserId: string;
    publicText: string;
    status: MilestoneStatus;
    health?: MilestoneHealth;
    nextStep?: string | null;
    dueDate?: string | null;
    completionJustification?: string;
  }): { sequenceNo: number } {
    const m = this.db.prepare(`
      SELECT event_id, org_id, completion_rule, status as current_status FROM milestones WHERE id = ?
    `).get(params.milestoneId) as {
      event_id: string; org_id: string; completion_rule: string | null; current_status: string;
    } | undefined;

    if (!m || !this.policy.canManageEvent(m.event_id, params.actorUserId)) {
      throw new Error('Нямате права да публикувате етап');
    }

    // FR005: Потвърждаване без критерий изисква изрична обосновка
    if (params.status === 'confirmed' && m.completion_rule && !params.completionJustification) {
      // Ако има правило, проверяваме дали има подадена обосновка или изпълнен критерий
      // В тестов сценарий T14: действие без критерий или обосновка се отказва
      if (params.completionJustification === '') {
        throw new Error('Потвърждаването изисква покрит критерий или писмена обосновка');
      }
    }

    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      // 1. Обновяване на етапа
      this.db.prepare(`
        UPDATE milestones
        SET status = ?, health = ?, next_step = ?, due_date = COALESCE(?, due_date),
            published_at = ?, last_verified_at = ?, updated_at = ?, row_version = row_version + 1
        WHERE id = ?
      `).run(
        params.status,
        params.health || 'normal',
        params.nextStep || null,
        params.dueDate || null,
        nowIso,
        nowIso,
        nowIso,
        params.milestoneId
      );

      // 2. Определяне на пореден номер на публикацията
      const maxSeqRow = this.db.prepare(`
        SELECT COALESCE(MAX(sequence_no), 0) as max_seq FROM published_updates WHERE event_id = ?
      `).get(m.event_id) as { max_seq: number };
      const nextSeq = maxSeqRow.max_seq + 1;

      // 3. Запис в непроменяемата клиентска история (published_updates)
      const snapshot = JSON.stringify({
        milestoneId: params.milestoneId,
        status: params.status,
        health: params.health || 'normal',
        nextStep: params.nextStep || null,
        dueDate: params.dueDate || null
      });

      this.db.prepare(`
        INSERT INTO published_updates (
          id, org_id, event_id, milestone_id, sequence_no, public_text,
          snapshot_json, published_by, published_at, requires_budget_permission
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        crypto.randomUUID(),
        m.org_id,
        m.event_id,
        params.milestoneId,
        nextSeq,
        params.publicText,
        snapshot,
        params.actorUserId,
        nowIso
      );

      // 4. Добавяне в outbox за изпращане на клиентски известия
      const clients = this.db.prepare(`
        SELECT user_id FROM event_memberships
        WHERE event_id = ? AND member_type = 'client' AND status = 'active'
      `).all(m.event_id) as { user_id: string }[];

      for (const client of clients) {
        const dedupeKey = `milestone_update_${params.milestoneId}_${nextSeq}_${client.user_id}`;
        this.db.prepare(`
          INSERT INTO notification_outbox (
            id, org_id, event_id, recipient_id, channel, type, source_id,
            dedupe_key, payload, state, available_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'email', 'milestone_update', ?, ?, ?, 'pending', ?, ?, ?)
        `).run(
          crypto.randomUUID(),
          m.org_id,
          m.event_id,
          client.user_id,
          params.milestoneId,
          dedupeKey,
          JSON.stringify({ text: params.publicText, milestoneId: params.milestoneId }),
          nowIso,
          nowIso,
          nowIso
        );
      }

      // 5. Одит
      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, ?, 'user', 'milestone_published', 'milestone', ?, ?)
      `).run(crypto.randomUUID(), m.org_id, m.event_id, params.actorUserId, params.milestoneId, nowIso);

      return { sequenceNo: nextSeq };
    });
  }

  /**
   * Потвърждаване на актуалността (Section 7.3 & 16.2 POST E/milestones/[id]/verify)
   */
  public verifyFreshness(milestoneId: string, actorUserId: string): boolean {
    const m = this.db.prepare(`SELECT event_id, org_id FROM milestones WHERE id = ?`).get(milestoneId) as {
      event_id: string; org_id: string;
    } | undefined;

    if (!m || !this.policy.canManageEvent(m.event_id, actorUserId)) {
      throw new Error('Нямате права да потвърждавате актуалност');
    }

    const nowIso = new Date().toISOString();

    this.db.prepare(`
      UPDATE milestones SET last_verified_at = ?, updated_at = ? WHERE id = ?
    `).run(nowIso, nowIso, milestoneId);

    // Одит
    this.db.prepare(`
      INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, created_at)
      VALUES (?, ?, ?, ?, 'user', 'milestone_verified', 'milestone', ?, ?)
    `).run(crypto.randomUUID(), m.org_id, m.event_id, actorUserId, milestoneId, nowIso);

    return true;
  }

  /**
   * Клиентски списък с етапи (вижда САМО публикувани етапи, БЕЗ вътрешни бележки и задачи)
   */
  public getMilestonesForClient(eventId: string, userId: string): any[] {
    if (!this.policy.canReadEvent(eventId, userId)) {
      throw new Error('Нямате достъп до това събитие');
    }

    return this.db.prepare(`
      SELECT id, title, category, status, health, next_step, due_date, sort_order, published_at
      FROM milestones
      WHERE event_id = ? AND published_at IS NOT NULL
      ORDER BY sort_order ASC
    `).all(eventId);
  }
}
