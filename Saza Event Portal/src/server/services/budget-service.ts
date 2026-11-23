// src/server/services/budget-service.ts
// Управление на бюджетни версии, позиции и вътрешна себестойност

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import { formatCentsToEUR } from '../../domain/rules.ts';

export class BudgetService {
  private db: Database;
  private policy: AccessPolicy;

  constructor(db: Database) {
    this.db = db;
    this.policy = new AccessPolicy(db);
  }

  /**
   * Създаване на бюджетна чернова от екипа (owner, manager, coordinator)
   */
  public createBudgetDraft(params: {
    eventId: string;
    actorUserId: string;
    items: {
      category: string;
      clientDescription: string;
      totalCents: number;
      internalCostCents?: number;
      supplierName?: string;
    }[];
  }): { budgetVersionId: string; totalCents: number } {
    if (!this.policy.canManageEvent(params.eventId, params.actorUserId)) {
      throw new Error('Нямате права да създавате бюджет');
    }

    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string };
    const versionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const totalCents = params.items.reduce((sum, item) => sum + item.totalCents, 0);

    return this.db.transaction(() => {
      const maxVer = this.db.prepare(`
        SELECT COALESCE(MAX(version_no), 0) as max_v FROM budget_versions WHERE event_id = ?
      `).get(params.eventId) as { max_v: number };
      const versionNo = maxVer.max_v + 1;

      // Текуща активна версия като базова
      const activeVer = this.db.prepare(`
        SELECT id FROM budget_versions WHERE event_id = ? AND state = 'active'
      `).get(params.eventId) as { id: string } | undefined;

      this.db.prepare(`
        INSERT INTO budget_versions (
          id, org_id, event_id, version_no, state, currency, total_cents,
          base_version_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'draft', 'EUR', ?, ?, ?, ?)
      `).run(versionId, event.org_id, params.eventId, versionNo, totalCents, activeVer ? activeVer.id : null, nowIso, nowIso);

      let sortOrder = 0;
      for (const item of params.items) {
        const itemId = crypto.randomUUID();
        this.db.prepare(`
          INSERT INTO budget_items (id, budget_version_id, org_id, event_id, category, client_description, total_cents, sort_order, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(itemId, versionId, event.org_id, params.eventId, item.category, item.clientDescription, item.totalCents, sortOrder++, nowIso);

        // Вътрешна себестойност (само за екипа, строго скрита от клиента)
        if (item.internalCostCents !== undefined && item.supplierName) {
          this.db.prepare(`
            INSERT INTO internal_costs (id, org_id, event_id, budget_item_id, supplier_name, cost_cents, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(crypto.randomUUID(), event.org_id, params.eventId, itemId, item.supplierName, item.internalCostCents, nowIso);
        }
      }

      return { budgetVersionId: versionId, totalCents };
    });
  }

  /**
   * Предлагане на бюджетна версия (само owner или manager)
   */
  public proposeBudgetVersion(eventId: string, versionId: string, actorUserId: string): boolean {
    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(eventId) as { org_id: string } | undefined;
    if (!event) throw new Error('Събитието не съществува');

    const role = this.policy.getStaffRole(event.org_id, actorUserId);
    if (role !== 'owner' && role !== 'manager') {
      throw new Error('Само Owner или Manager може да предлага бюджетна версия към клиента');
    }

    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      this.db.prepare(`
        UPDATE budget_versions SET state = 'proposed', updated_at = ? WHERE id = ? AND event_id = ?
      `).run(nowIso, versionId, eventId);

      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, ?, 'user', 'budget_proposed', 'budget_version', ?, ?)
      `).run(crypto.randomUUID(), event.org_id, eventId, actorUserId, versionId, nowIso);

      return true;
    });
  }

  /**
   * Клиентски преглед на бюджета (Section 6.4 & 10.1)
   * Достъпен САМО за клиент с can_view_budget = 1!
   */
  public getBudgetForClient(eventId: string, userId: string): {
    hasActiveBudget: boolean;
    activeTotalEUR?: string;
    activeTotalCents?: number;
    proposedTotalEUR?: string;
    proposedDiffEUR?: string;
    items: {
      category: string;
      description: string;
      totalEUR: string;
    }[];
  } | null {
    if (!this.policy.canReadBudget(eventId, userId)) {
      return null;
    }

    const activeVer = this.db.prepare(`
      SELECT id, total_cents FROM budget_versions WHERE event_id = ? AND state = 'active'
    `).get(eventId) as { id: string; total_cents: number } | undefined;

    const proposedVer = this.db.prepare(`
      SELECT id, total_cents FROM budget_versions WHERE event_id = ? AND state = 'proposed'
    `).get(eventId) as { id: string; total_cents: number } | undefined;

    const displayVer = activeVer || proposedVer;
    if (!displayVer) {
      return {
        hasActiveBudget: false,
        items: []
      };
    }

    const items = this.db.prepare(`
      SELECT category, client_description, total_cents
      FROM budget_items
      WHERE budget_version_id = ?
      ORDER BY sort_order ASC
    `).all(displayVer.id) as { category: string; client_description: string; total_cents: number }[];

    let proposedDiffEUR: string | undefined;
    if (activeVer && proposedVer) {
      const diff = proposedVer.total_cents - activeVer.total_cents;
      const sign = diff >= 0 ? '+' : '';
      proposedDiffEUR = `${sign}${formatCentsToEUR(diff)}`;
    }

    return {
      hasActiveBudget: !!activeVer,
      activeTotalEUR: activeVer ? formatCentsToEUR(activeVer.total_cents) : undefined,
      activeTotalCents: activeVer ? activeVer.total_cents : undefined,
      proposedTotalEUR: proposedVer ? formatCentsToEUR(proposedVer.total_cents) : undefined,
      proposedDiffEUR,
      items: items.map(i => ({
        category: i.category,
        description: i.client_description,
        totalEUR: formatCentsToEUR(i.total_cents)
      }))
    };
  }
}
