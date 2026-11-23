// src/server/services/proposal-service.ts
// Управление на предложения, версии, варианти и транзакционни клиентски одобрения

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import { computeContentHash } from '../../domain/rules.ts';
import type { ApprovalDecision, ProposalKind } from '../../domain/types.ts';

export class ProposalService {
  private db: Database;
  private policy: AccessPolicy;

  constructor(db: Database) {
    this.db = db;
    this.policy = new AccessPolicy(db);
  }

  /**
   * Създаване на предложение
   */
  public createProposal(params: {
    eventId: string;
    actorUserId: string;
    title: string;
    kind: ProposalKind;
    milestoneId?: string | null;
  }): { proposalId: string } {
    if (!this.policy.canManageEvent(params.eventId, params.actorUserId)) {
      throw new Error('Нямате права да създавате предложения');
    }

    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string };
    const proposalId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO proposals (id, org_id, event_id, milestone_id, kind, title, row_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(proposalId, event.org_id, params.eventId, params.milestoneId || null, params.kind, params.title, nowIso, nowIso);

    return { proposalId };
  }

  /**
   * Създаване на версия с варианти
   */
  public createProposalVersion(params: {
    proposalId: string;
    actorUserId: string;
    body: Record<string, any>;
    requiresBudgetPermission?: boolean;
    budgetVersionId?: string | null;
    options?: { title: string; description?: string; totalCents?: number }[];
  }): { versionId: string; versionNo: number } {
    const prop = this.db.prepare(`SELECT org_id, event_id FROM proposals WHERE id = ?`).get(params.proposalId) as {
      org_id: string; event_id: string;
    } | undefined;

    if (!prop || !this.policy.canManageEvent(prop.event_id, params.actorUserId)) {
      throw new Error('Нямате права да добавяте версия');
    }

    const versionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const contentHash = computeContentHash(params.body);

    return this.db.transaction(() => {
      const maxVer = this.db.prepare(`
        SELECT COALESCE(MAX(version_no), 0) as max_v FROM proposal_versions WHERE proposal_id = ?
      `).get(params.proposalId) as { max_v: number };
      const versionNo = maxVer.max_v + 1;

      this.db.prepare(`
        INSERT INTO proposal_versions (
          id, proposal_id, org_id, event_id, version_no, body_json, content_hash,
          state, requires_budget_permission, budget_version_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      `).run(
        versionId,
        params.proposalId,
        prop.org_id,
        prop.event_id,
        versionNo,
        JSON.stringify(params.body),
        contentHash,
        params.requiresBudgetPermission ? 1 : 0,
        params.budgetVersionId || null,
        nowIso
      );

      if (params.options) {
        let sortOrder = 0;
        for (const opt of params.options) {
          this.db.prepare(`
            INSERT INTO proposal_options (id, proposal_version_id, org_id, event_id, title, description, total_cents, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            versionId,
            prop.org_id,
            prop.event_id,
            opt.title,
            opt.description || null,
            opt.totalCents !== undefined ? opt.totalCents : null,
            sortOrder++,
            nowIso
          );
        }
      }

      return { versionId, versionNo };
    });
  }

  /**
   * Изпращане на версия към клиента (Section 9.1 & 16.2)
   */
  public submitProposalVersion(params: {
    proposalId: string;
    versionId: string;
    actorUserId: string;
    assigneeUserId: string;
    validHours?: number;
  }): { requestId: string; expiresAt: string } {
    const prop = this.db.prepare(`SELECT org_id, event_id FROM proposals WHERE id = ?`).get(params.proposalId) as {
      org_id: string; event_id: string;
    } | undefined;

    if (!prop || !this.policy.canManageEvent(prop.event_id, params.actorUserId)) {
      throw new Error('Нямате права да изпращате предложение');
    }

    const version = this.db.prepare(`
      SELECT id, state, requires_budget_permission FROM proposal_versions WHERE id = ? AND proposal_id = ?
    `).get(params.versionId, params.proposalId) as { id: string; state: string; requires_budget_permission: number } | undefined;

    if (!version) {
      throw new Error('Версията не съществува');
    }

    // Проверка дали назначеният одобряващ е валиден клиент
    const mem = this.db.prepare(`
      SELECT client_role, can_view_budget, status FROM event_memberships
      WHERE event_id = ? AND user_id = ? AND member_type = 'client'
    `).get(prop.event_id, params.assigneeUserId) as { client_role: string; can_view_budget: number; status: string } | undefined;

    if (!mem || mem.status !== 'active') {
      throw new Error('Назначеният потребител няма активно клиентско членство в събитието');
    }

    if (mem.client_role !== 'client_decision_maker') {
      throw new Error('Само потребител с роля client_decision_maker може да бъде назначен за одобряващ');
    }

    if (version.requires_budget_permission === 1 && mem.can_view_budget !== 1) {
      throw new Error('Назначеният одобряващ няма необходимото право за преглед на бюджет');
    }

    const requestId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + (params.validHours || 72) * 3600 * 1000).toISOString();

    return this.db.transaction(() => {
      // Маркиране на предходни чакащи искания като superseded
      this.db.prepare(`
        UPDATE approval_requests SET status = 'superseded', updated_at = ?
        WHERE proposal_id = ? AND status = 'pending'
      `).run(nowIso, params.proposalId);

      // Заключване на версията (state = 'submitted')
      this.db.prepare(`
        UPDATE proposal_versions SET state = 'submitted', submitted_at = ? WHERE id = ?
      `).run(nowIso, params.versionId);

      // Обновяване на proposals.current_version_id
      this.db.prepare(`
        UPDATE proposals SET current_version_id = ?, updated_at = ?, row_version = row_version + 1
        WHERE id = ?
      `).run(params.versionId, nowIso, params.proposalId);

      // Създаване на искане за одобрение
      this.db.prepare(`
        INSERT INTO approval_requests (
          id, org_id, event_id, proposal_id, proposal_version_id, assignee_user_id,
          status, expires_at, row_version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?)
      `).run(requestId, prop.org_id, prop.event_id, params.proposalId, params.versionId, params.assigneeUserId, expiresAt, nowIso, nowIso);

      // Известие към клиента
      this.db.prepare(`
        INSERT INTO notifications (id, org_id, event_id, recipient_id, type, safe_payload, created_at)
        VALUES (?, ?, ?, ?, 'decision_required', ?, ?)
      `).run(
        crypto.randomUUID(),
        prop.org_id,
        prop.event_id,
        params.assigneeUserId,
        JSON.stringify({ requestId, proposalId: params.proposalId, expiresAt }),
        nowIso
      );

      return { requestId, expiresAt };
    });
  }

  /**
   * Транзакционно клиентско решение (Section 9.3)
   */
  public respondToApproval(params: {
    requestId: string;
    actorUserId: string;
    decision: ApprovalDecision;
    selectedOptionId?: string | null;
    comment?: string | null;
    idempotencyKey: string;
  }): {
    success: boolean;
    responseId?: string;
    decision?: string;
    error?: string;
    isDuplicate?: boolean;
  } {
    const requestPayload = {
      requestId: params.requestId,
      decision: params.decision,
      selectedOptionId: params.selectedOptionId || null,
      comment: params.comment || null
    };
    const requestHash = computeContentHash(requestPayload);
    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      // 1. Проверка за идемпотентност (преди мутация)
      const existingIdem = this.db.prepare(`
        SELECT request_hash, response_snapshot FROM idempotency_keys
        WHERE actor_id = ? AND operation = 'approval_response' AND key = ?
      `).get(params.actorUserId, params.idempotencyKey) as {
        request_hash: string; response_snapshot: string;
      } | undefined;

      if (existingIdem) {
        if (existingIdem.request_hash !== requestHash) {
          throw new Error('Същият Idempotency-Key е използван с различни параметри (409 Conflict)');
        }
        const cached = JSON.parse(existingIdem.response_snapshot);
        return { success: true, ...cached, isDuplicate: true };
      }

      const req = this.db.prepare(`
        SELECT ar.id, ar.org_id, ar.event_id, ar.proposal_id, ar.proposal_version_id,
               ar.assignee_user_id, ar.status, ar.expires_at, pv.requires_budget_permission,
               pv.budget_version_id
        FROM approval_requests ar
        JOIN proposal_versions pv ON pv.id = ar.proposal_version_id
        WHERE ar.id = ?
      `).get(params.requestId) as {
        id: string;
        org_id: string;
        event_id: string;
        proposal_id: string;
        proposal_version_id: string;
        assignee_user_id: string;
        status: string;
        expires_at: string;
        requires_budget_permission: number;
        budget_version_id: string | null;
      } | undefined;

      if (!req) {
        return { success: false, error: 'Искането за одобрение не е намерено' };
      }

      // 2. Валидация на права и статус
      const authCheck = this.policy.canRespondToApprovalRequest(params.requestId, params.actorUserId);
      if (!authCheck.allowed) {
        throw new Error(`Отказ на решение: ${authCheck.reason}`);
      }

      if (req.requires_budget_permission === 1 && !this.policy.canReadBudget(req.event_id, params.actorUserId)) {
        throw new Error('Липсва право за преглед на бюджет към това предложение');
      }

      // Валидация на вариант
      if (params.decision === 'approved' && params.selectedOptionId) {
        const option = this.db.prepare(`
          SELECT id FROM proposal_options WHERE id = ? AND proposal_version_id = ?
        `).get(params.selectedOptionId, req.proposal_version_id);

        if (!option) {
          throw new Error('Избраният вариант не принадлежи към изпратената версия на предложението');
        }
      }

      // При искане за промяна коментарът е задължителен
      if (params.decision === 'changes_requested') {
        if (!params.comment || params.comment.trim().length === 0) {
          throw new Error('Коментарът с обяснение е задължителен при искане за промяна');
        }
      }

      // 3. Запис на непроменяемия отговор
      const responseId = crypto.randomUUID();
      this.db.prepare(`
        INSERT INTO approval_responses (
          id, request_id, org_id, event_id, actor_user_id, decision,
          selected_option_id, comment, decided_at, request_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        responseId,
        params.requestId,
        req.org_id,
        req.event_id,
        params.actorUserId,
        params.decision,
        params.selectedOptionId || null,
        params.comment || null,
        nowIso,
        requestHash
      );

      // 4. Обновяване на статуса на искането
      this.db.prepare(`
        UPDATE approval_requests SET status = ?, updated_at = ?, row_version = row_version + 1
        WHERE id = ?
      `).run(params.decision, nowIso, params.requestId);

      // 5. Ако е одобрено бюджетно предложение -> атомарно активиране на новия бюджет!
      if (params.decision === 'approved' && req.budget_version_id) {
        // Деактивиране на предходна активна бюджетна версия
        this.db.prepare(`
          UPDATE budget_versions SET state = 'superseded', updated_at = ?
          WHERE event_id = ? AND state = 'active'
        `).run(nowIso, req.event_id);

        // Активиране на новата бюджетна версия
        this.db.prepare(`
          UPDATE budget_versions SET state = 'active', approved_response_id = ?, updated_at = ?
          WHERE id = ?
        `).run(responseId, nowIso, req.budget_version_id);
      }

      // 6. Одит
      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, safe_diff, created_at)
        VALUES (?, ?, ?, ?, 'user', ?, 'approval_request', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        req.org_id,
        req.event_id,
        params.actorUserId,
        `decision_${params.decision}`,
        params.requestId,
        JSON.stringify({ decision: params.decision, option: params.selectedOptionId, comment: params.comment }),
        nowIso
      );

      const result = {
        success: true,
        responseId,
        decision: params.decision,
        decidedAt: nowIso
      };

      // 7. Запазване на идемпотентността
      this.db.prepare(`
        INSERT INTO idempotency_keys (
          id, org_id, actor_id, operation, key, request_hash, response_snapshot, state, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'approval_response', ?, ?, ?, 'completed', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        req.org_id,
        params.actorUserId,
        params.idempotencyKey,
        requestHash,
        JSON.stringify(result),
        new Date(Date.now() + 86400000).toISOString(),
        nowIso,
        nowIso
      );

      return result;
    });
  }
}
