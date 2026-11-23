// src/server/services/payment-service.ts
// Управление на планове, постъпления, частични плащания и корекции (Section 10.3)

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import { formatCentsToEUR } from '../../domain/rules.ts';

export class PaymentService {
  private db: Database;
  private policy: AccessPolicy;

  constructor(db: Database) {
    this.db = db;
    this.policy = new AccessPolicy(db);
  }

  /**
   * Добавяне на вноска към графика (само manager или owner)
   */
  public addScheduleItem(params: {
    eventId: string;
    actorUserId: string;
    label: string;
    amountCents: number;
    dueDate: string;
  }): { scheduleId: string } {
    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string } | undefined;
    if (!event) throw new Error('Събитието не съществува');

    const role = this.policy.getStaffRole(event.org_id, params.actorUserId);
    if (role !== 'owner' && role !== 'manager') {
      throw new Error('Само Owner или Manager може да създава плащания в графика');
    }

    const scheduleId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO payment_schedules (id, org_id, event_id, label, amount_cents, due_date, state, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `).run(scheduleId, event.org_id, params.eventId, params.label, params.amountCents, params.dueDate, nowIso, nowIso);

    return { scheduleId };
  }

  /**
   * Потвърждаване на постъпление (FR019 & FR022)
   * Постъпление се потвърждава САМО от owner или manager.
   */
  public recordPayment(params: {
    eventId: string;
    actorUserId: string;
    amountCents: number;
    effectiveDate: string;
    scheduleId?: string | null;
    reference?: string | null;
  }): { paymentId: string } {
    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string } | undefined;
    if (!event) throw new Error('Събитието не съществува');

    const role = this.policy.getStaffRole(event.org_id, params.actorUserId);
    if (role !== 'owner' && role !== 'manager') {
      throw new Error('Само Owner или Manager може да потвърждава постъпления');
    }

    if (params.amountCents <= 0) {
      throw new Error('Сумата на постъплението трябва да бъде положителна');
    }

    const paymentId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO payment_entries (
          id, org_id, event_id, schedule_id, signed_amount_cents,
          effective_date, reference, reversal_of_id, recorded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        paymentId,
        event.org_id,
        params.eventId,
        params.scheduleId || null,
        params.amountCents,
        params.effectiveDate,
        params.reference || null,
        params.actorUserId,
        nowIso
      );

      // Обновяване на състоянието на вноската при свързан график
      if (params.scheduleId) {
        const sched = this.db.prepare(`SELECT amount_cents FROM payment_schedules WHERE id = ?`).get(params.scheduleId) as { amount_cents: number };
        const paidRow = this.db.prepare(`
          SELECT SUM(signed_amount_cents) as total_paid FROM payment_entries WHERE schedule_id = ?
        `).get(params.scheduleId) as { total_paid: number };

        const totalPaid = paidRow.total_paid || 0;
        const newState = totalPaid >= sched.amount_cents ? 'paid' : totalPaid > 0 ? 'partial' : 'pending';

        this.db.prepare(`
          UPDATE payment_schedules SET state = ?, updated_at = ? WHERE id = ?
        `).run(newState, nowIso, params.scheduleId);
      }

      // Одит
      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, safe_diff, created_at)
        VALUES (?, ?, ?, ?, 'user', 'payment_recorded', 'payment_entry', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        event.org_id,
        params.eventId,
        params.actorUserId,
        paymentId,
        JSON.stringify({ amountCents: params.amountCents, ref: params.reference }),
        nowIso
      );

      return { paymentId };
    });
  }

  /**
   * Сторно / Коригиращ запис на плащане (FR021 & Section 14.4)
   * Корекцията се записва като насрещен запис с отрицателна стойност.
   * Сборът на корекциите срещу едно постъпление не може да надвишава самото постъпление.
   */
  public reversePayment(params: {
    eventId: string;
    actorUserId: string;
    originalPaymentId: string;
    reversalAmountCents: number;
    effectiveDate: string;
    reason: string;
  }): { reversalId: string } {
    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string } | undefined;
    if (!event) throw new Error('Събитието не съществува');

    const role = this.policy.getStaffRole(event.org_id, params.actorUserId);
    if (role !== 'owner' && role !== 'manager') {
      throw new Error('Само Owner или Manager може да въвежда корекции');
    }

    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      const orig = this.db.prepare(`
        SELECT id, signed_amount_cents, reversal_of_id, schedule_id FROM payment_entries WHERE id = ? AND event_id = ?
      `).get(params.originalPaymentId, params.eventId) as {
        id: string; signed_amount_cents: number; reversal_of_id: string | null; schedule_id: string | null;
      } | undefined;

      if (!orig) {
        throw new Error('Оригиналният запис не е намерен');
      }

      if (orig.signed_amount_cents <= 0 || orig.reversal_of_id !== null) {
        throw new Error('Не може да се коригира насрещен коригиращ запис (забранена вложена верига)');
      }

      // Проверка на общата сума на досегашните корекции срещу този оригинал
      const prevReversals = this.db.prepare(`
        SELECT COALESCE(SUM(ABS(signed_amount_cents)), 0) as total_rev
        FROM payment_entries
        WHERE reversal_of_id = ?
      `).get(orig.id) as { total_rev: number };

      const availableToReverse = orig.signed_amount_cents - prevReversals.total_rev;
      if (params.reversalAmountCents > availableToReverse) {
        throw new Error(`Сумата на корекцията (${params.reversalAmountCents} цента) надвишава наличния остатък от постъплението (${availableToReverse} цента)`);
      }

      const reversalId = crypto.randomUUID();
      const signedReversalCents = -Math.abs(params.reversalAmountCents);

      this.db.prepare(`
        INSERT INTO payment_entries (
          id, org_id, event_id, schedule_id, signed_amount_cents,
          effective_date, reference, reversal_of_id, recorded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        reversalId,
        event.org_id,
        params.eventId,
        orig.schedule_id,
        signedReversalCents,
        params.effectiveDate,
        `Корекция: ${params.reason}`,
        orig.id,
        params.actorUserId,
        nowIso
      );

      // Одит
      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, safe_diff, created_at)
        VALUES (?, ?, ?, ?, 'user', 'payment_reversed', 'payment_entry', ?, ?, ?)
      `).run(
        crypto.randomUUID(),
        event.org_id,
        params.eventId,
        params.actorUserId,
        reversalId,
        JSON.stringify({ originalId: orig.id, reversedCents: params.reversalAmountCents, reason: params.reason }),
        nowIso
      );

      return { reversalId };
    });
  }

  /**
   * Финансов преглед за събитието (Section 10.3)
   */
  public getPaymentSummary(eventId: string, userId: string): {
    activeBudgetTotalEUR?: string;
    netPaidEUR: string;
    balanceEUR: string;
    isOverpaid: boolean;
    schedules: any[];
    entries: any[];
  } | null {
    if (!this.policy.canReadBudget(eventId, userId)) {
      return null;
    }

    const activeBudget = this.db.prepare(`
      SELECT total_cents FROM budget_versions WHERE event_id = ? AND state = 'active'
    `).get(eventId) as { total_cents: number } | undefined;

    const netPaidRow = this.db.prepare(`
      SELECT COALESCE(SUM(signed_amount_cents), 0) as net_paid
      FROM payment_entries
      WHERE event_id = ?
    `).get(eventId) as { net_paid: number };

    const netPaidCents = netPaidRow.net_paid || 0;
    const activeCents = activeBudget ? activeBudget.total_cents : 0;
    const balanceCents = activeCents - netPaidCents;
    const isOverpaid = netPaidCents > activeCents;

    const schedules = this.db.prepare(`
      SELECT id, label, amount_cents, due_date, state
      FROM payment_schedules WHERE event_id = ? ORDER BY due_date ASC
    `).all(eventId);

    const entries = this.db.prepare(`
      SELECT pe.id, pe.signed_amount_cents, pe.effective_date, pe.reference, pe.reversal_of_id, pe.created_at,
             p.display_name as recorded_by_name
      FROM payment_entries pe
      LEFT JOIN profiles p ON p.user_id = pe.recorded_by
      WHERE pe.event_id = ?
      ORDER BY pe.effective_date DESC, pe.created_at DESC
    `).all(eventId);

    return {
      activeBudgetTotalEUR: activeBudget ? formatCentsToEUR(activeCents) : undefined,
      netPaidEUR: formatCentsToEUR(netPaidCents),
      balanceEUR: formatCentsToEUR(Math.abs(balanceCents)),
      isOverpaid,
      schedules: schedules.map((s: any) => ({
        ...s,
        amountEUR: formatCentsToEUR(s.amount_cents)
      })),
      entries: entries.map((e: any) => ({
        ...e,
        amountEUR: formatCentsToEUR(e.signed_amount_cents)
      }))
    };
  }
}
