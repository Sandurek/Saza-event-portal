// src/server/services/event-service.ts
// Управление на събития, клиентски обзор и жизнения цикъл

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import { calculateOverallHealth, formatCentsToEUR } from '../../domain/rules.ts';
import type { EventLifecycle, EventType, OverviewMetrics } from '../../domain/types.ts';

export class EventService {
  private db: Database;
  private policy: AccessPolicy;

  constructor(db: Database) {
    this.db = db;
    this.policy = new AccessPolicy(db);
  }

  /**
   * Създаване на ново събитие от Manager или Owner
   */
  public createEvent(params: {
    orgId: string;
    actorUserId: string;
    title: string;
    eventType: EventType;
    startsAt: string;
    endsAt: string;
    timezone?: string;
    venueLabel?: string;
    primaryCoordinatorId?: string;
  }): { eventId: string } {
    if (!this.policy.canCreateEvent(params.orgId, params.actorUserId)) {
      throw new Error('Само потребители с роля Owner или Manager могат да създават събития');
    }

    const eventId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO events (
          id, org_id, title, event_type, starts_at, ends_at, timezone, venue_label,
          lifecycle, primary_coordinator_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      `).run(
        eventId,
        params.orgId,
        params.title,
        params.eventType,
        params.startsAt,
        params.endsAt,
        params.timezone || 'Europe/Sofia',
        params.venueLabel || null,
        params.primaryCoordinatorId || null,
        nowIso,
        nowIso
      );

      // Добавяне на създателя и координатора като екипни членове на събитието
      this.db.prepare(`
        INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'staff', 'active', ?, ?)
      `).run(crypto.randomUUID(), params.orgId, eventId, params.actorUserId, nowIso, nowIso);

      if (params.primaryCoordinatorId && params.primaryCoordinatorId !== params.actorUserId) {
        this.db.prepare(`
          INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'staff', 'active', ?, ?)
        `).run(crypto.randomUUID(), params.orgId, eventId, params.primaryCoordinatorId, nowIso, nowIso);
      }

      // Одит
      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, ?, 'user', 'event_created', 'event', ?, ?)
      `).run(crypto.randomUUID(), params.orgId, eventId, params.actorUserId, eventId, nowIso);
    });

    return { eventId };
  }

  /**
   * Клиентски обзор (Section 6.2):
   * Връща отговорите на четирите основни въпроса:
   * 1. Какво е потвърдено? (Брой потвърдени етапи от всички приложими)
   * 2. Какво се прави сега? (Текущ етап и следваща стъпка)
   * 3. Какво следва? (Следващи етапи по план)
   * 4. Какво се очаква от клиента? (Чакащи решения с техния краен срок)
   */
  public getClientOverview(eventId: string, userId: string): {
    event: {
      id: string;
      title: string;
      eventType: string;
      startsAt: string;
      endsAt: string;
      venueLabel: string | null;
      coordinatorName: string | null;
      lifecycle: string;
    };
    metrics: OverviewMetrics;
    pendingDecisions: {
      requestId: string;
      proposalId: string;
      title: string;
      expiresAt: string;
      isAssignedToMe: boolean;
    }[];
    recentUpdates: {
      sequenceNo: number;
      text: string;
      publishedAt: string;
    }[];
    currentMilestone: {
      title: string;
      nextStep: string | null;
      status: string;
      dueDate: string | null;
    } | null;
  } {
    if (!this.policy.canReadEvent(eventId, userId)) {
      throw new Error('Нямате достъп до това събитие');
    }

    const event = this.db.prepare(`
      SELECT e.id, e.title, e.event_type, e.starts_at, e.ends_at, e.venue_label, e.lifecycle,
             p.display_name as coordinator_name
      FROM events e
      LEFT JOIN profiles p ON p.user_id = e.primary_coordinator_id
      WHERE e.id = ?
    `).get(eventId) as {
      id: string;
      title: string;
      event_type: string;
      starts_at: string;
      ends_at: string;
      venue_label: string | null;
      lifecycle: string;
      coordinator_name: string | null;
    };

    // Само публикувани етапи за клиента!
    const milestones = this.db.prepare(`
      SELECT id, title, status, health, next_step, due_date, published_at, last_verified_at, sort_order
      FROM milestones
      WHERE event_id = ? AND published_at IS NOT NULL
      ORDER BY sort_order ASC
    `).all(eventId) as {
      id: string;
      title: string;
      status: any;
      health: any;
      next_step: string | null;
      due_date: string | null;
      published_at: string;
      last_verified_at: string | null;
      sort_order: number;
    }[];

    const canViewBudget = this.policy.canReadBudget(eventId, userId);

    // Чакащи решения за клиента
    const pendingReqs = this.db.prepare(`
      SELECT ar.id as request_id, ar.proposal_id, p.title, ar.expires_at, ar.assignee_user_id
      FROM approval_requests ar
      JOIN proposals p ON p.id = ar.proposal_id
      JOIN proposal_versions pv ON pv.id = ar.proposal_version_id
      WHERE ar.event_id = ? AND ar.status = 'pending'
      ORDER BY ar.expires_at ASC
    `).all(eventId) as {
      request_id: string;
      proposal_id: string;
      title: string;
      expires_at: string;
      assignee_user_id: string;
    }[];

    const userPendingDecisions = pendingReqs.map(r => ({
      requestId: r.request_id,
      proposalId: r.proposal_id,
      title: r.title,
      expiresAt: r.expires_at,
      isAssignedToMe: r.assignee_user_id === userId
    }));

    // Последни до 5 публикувани обновления
    const recentUpdates = this.db.prepare(`
      SELECT sequence_no, public_text as text, published_at
      FROM published_updates
      WHERE event_id = ? AND (requires_budget_permission = 0 OR ? = 1)
      ORDER BY sequence_no DESC
      LIMIT 5
    `).all(eventId, canViewBudget ? 1 : 0) as {
      sequence_no: number;
      text: string;
      published_at: string;
    }[];

    // Метрики
    const totalMilestones = milestones.length;
    const confirmedMilestones = milestones.filter(m => m.status === 'confirmed').length;
    const applicableMilestones = milestones.filter(m => m.status !== 'not_applicable').length;

    // Време на последна проверка от екипа
    const latestVerified = milestones.reduce<string | null>((max, m) => {
      if (!m.last_verified_at) return max;
      return !max || m.last_verified_at > max ? m.last_verified_at : max;
    }, null);

    const latestPublished = milestones.reduce<string | null>((max, m) => {
      if (!m.published_at) return max;
      return !max || m.published_at > max ? m.published_at : max;
    }, null);

    const healthCalc = calculateOverallHealth({
      eventLifecycle: event.lifecycle,
      milestones: milestones.map(m => ({ status: m.status, health: m.health, dueDate: m.due_date })),
      lastVerifiedAt: latestVerified,
      eventStartsAt: event.starts_at,
      nowIso: new Date().toISOString(),
      hasPendingClientDecisions: userPendingDecisions.length > 0
    });

    // Бюджетна информация (само при can_view_budget)
    let activeBudgetEUR: string | undefined;
    let proposedBudgetDiffEUR: string | undefined;

    if (canViewBudget) {
      const activeBudget = this.db.prepare(`
        SELECT total_cents FROM budget_versions WHERE event_id = ? AND state = 'active'
      `).get(eventId) as { total_cents: number } | undefined;

      if (activeBudget) {
        activeBudgetEUR = formatCentsToEUR(activeBudget.total_cents);
      }

      const proposedBudget = this.db.prepare(`
        SELECT total_cents, base_version_id FROM budget_versions WHERE event_id = ? AND state = 'proposed'
      `).get(eventId) as { total_cents: number; base_version_id: string | null } | undefined;

      if (proposedBudget && activeBudget) {
        const diff = proposedBudget.total_cents - activeBudget.total_cents;
        const sign = diff >= 0 ? '+' : '';
        proposedBudgetDiffEUR = `${sign}${formatCentsToEUR(diff)}`;
      }
    }

    const currentMilestone = milestones.find(m => m.status === 'in_progress' || m.status === 'awaiting_client') || milestones[0] || null;

    return {
      event: {
        id: event.id,
        title: event.title,
        eventType: event.event_type,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        venueLabel: event.venue_label,
        coordinatorName: event.coordinator_name,
        lifecycle: event.lifecycle
      },
      metrics: {
        totalMilestones,
        confirmedMilestones,
        applicableMilestones,
        overallHealth: healthCalc.overallHealth as any,
        primaryIssueText: healthCalc.statusText,
        lastVerifiedAt: latestVerified,
        lastPublishedAt: latestPublished,
        pendingDecisionsCount: userPendingDecisions.length,
        requiresClientAction: userPendingDecisions.some(d => d.isAssignedToMe),
        activeBudgetEUR,
        proposedBudgetDiffEUR
      },
      pendingDecisions: userPendingDecisions,
      recentUpdates,
      currentMilestone: currentMilestone ? {
        title: currentMilestone.title,
        nextStep: currentMilestone.next_step,
        status: currentMilestone.status,
        dueDate: currentMilestone.due_date
      } : null
    };
  }

  /**
   * Смяна на дата на събитие (Section 5.6 & 16.2)
   */
  public rescheduleEvent(params: {
    eventId: string;
    actorUserId: string;
    newStartsAt: string;
    newEndsAt: string;
    reason: string;
  }): boolean {
    if (!this.policy.canManageEvent(params.eventId, params.actorUserId)) {
      throw new Error('Нямате права да променяте датата на събитието');
    }

    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      const event = this.db.prepare(`SELECT org_id, starts_at, ends_at FROM events WHERE id = ?`).get(params.eventId) as {
        org_id: string; starts_at: string; ends_at: string;
      };

      this.db.prepare(`
        UPDATE events SET starts_at = ?, ends_at = ?, updated_at = ?, row_version = row_version + 1
        WHERE id = ?
      `).run(params.newStartsAt, params.newEndsAt, nowIso, params.eventId);

      // Одит
      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, safe_diff, created_at)
        VALUES (?, ?, ?, ?, 'user', 'event_rescheduled', 'event', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        event.org_id,
        params.eventId,
        params.actorUserId,
        params.eventId,
        JSON.stringify({ previousStartsAt: event.starts_at, newStartsAt: params.newStartsAt, reason: params.reason }),
        nowIso
      );

      return true;
    });
  }

  /**
   * Архивиране на събитие (Section 5.6, 17.3)
   */
  public archiveEvent(eventId: string, actorUserId: string): boolean {
    if (!this.policy.canManageEvent(eventId, actorUserId)) {
      throw new Error('Нямате права да архивирате събитието');
    }

    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(eventId) as { org_id: string };

      this.db.prepare(`
        UPDATE events SET lifecycle = 'archived', archived_at = ?, updated_at = ? WHERE id = ?
      `).run(nowIso, nowIso, eventId);

      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, ?, 'user', 'event_archived', 'event', ?, ?)
      `).run(crypto.randomUUID(), event.org_id, eventId, actorUserId, eventId, nowIso);

      return true;
    });
  }

  /**
   * Пълно изтриване на събитие и всички свързани с него записи (само Owner)
   */
  public deleteEvent(eventId: string, actorUserId: string): {
    deletedEventId: string;
    title: string;
    objectKeys: string[];
  } {
    const event = this.db.prepare(`
      SELECT id, org_id, title FROM events WHERE id = ?
    `).get(eventId) as { id: string; org_id: string; title: string } | undefined;

    if (!event) {
      throw new Error('Събитието не съществува');
    }

    if (!this.policy.isOwner(event.org_id, actorUserId)) {
      throw new Error('Само Owner може да изтрива събития');
    }

    const docRows = this.db.prepare(`
      SELECT object_key FROM document_versions WHERE event_id = ?
    `).all(eventId) as { object_key: string }[];
    const objectKeys = docRows.map(r => r.object_key).filter(Boolean);

    const clientRows = this.db.prepare(`
      SELECT DISTINCT p.user_id
      FROM event_memberships em
      JOIN profiles p ON p.user_id = em.user_id
      WHERE em.event_id = ? AND em.member_type = 'client' AND p.username IS NULL
    `).all(eventId) as { user_id: string }[];

    const nowIso = new Date().toISOString();

    this.db.transaction(() => {
      // Освобождаваме кръстосани/самореферентни FK преди каскадното изтриване
      this.db.prepare(`UPDATE budget_versions SET approved_response_id = NULL WHERE event_id = ?`).run(eventId);
      this.db.prepare(`UPDATE payment_entries SET reversal_of_id = NULL WHERE event_id = ?`).run(eventId);

      for (const table of [
        'proposal_attachments',
        'payment_entries',
        'internal_costs',
        'budget_items',
        'budget_versions',
        'approval_responses',
        'approval_requests',
        'document_versions',
        'documents',
      ]) {
        this.db.prepare(`DELETE FROM ${table} WHERE event_id = ?`).run(eventId);
      }

      this.db.prepare(`DELETE FROM events WHERE id = ?`).run(eventId);

      // Изчистваме клиентски профили без останали връзки в системата
      const refChecks: [string, string][] = [
        ['organization_memberships', 'user_id'],
        ['event_memberships', 'user_id'],
        ['invitations', 'invited_by'],
        ['milestone_drafts', 'edited_by'],
        ['published_updates', 'published_by'],
        ['change_requests', 'requested_by'],
        ['approval_requests', 'assignee_user_id'],
        ['approval_responses', 'actor_user_id'],
        ['payment_entries', 'recorded_by'],
        ['document_versions', 'uploaded_by'],
        ['comments', 'author_id'],
        ['comment_revisions', 'changed_by'],
      ];

      for (const { user_id: clientUserId } of clientRows) {
        const stillReferenced = refChecks.some(([tbl, col]) =>
          Boolean(this.db.prepare(`SELECT 1 FROM ${tbl} WHERE ${col} = ? LIMIT 1`).get(clientUserId))
        );
        if (!stillReferenced) {
          this.db.prepare(`DELETE FROM profiles WHERE user_id = ? AND username IS NULL`).run(clientUserId);
        }
      }

      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, safe_diff, created_at)
        VALUES (?, ?, NULL, ?, 'user', 'event_deleted', 'event', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        event.org_id,
        actorUserId,
        eventId,
        JSON.stringify({ title: event.title }),
        nowIso
      );
    });

    return {
      deletedEventId: eventId,
      title: event.title,
      objectKeys,
    };
  }
}
