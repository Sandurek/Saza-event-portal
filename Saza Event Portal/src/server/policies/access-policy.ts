// src/server/policies/access-policy.ts
// Централизирани проверки за права на достъп (Section 4 & 15)

import { Database } from '../db/database.ts';

export class AccessPolicy {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Проверка дали потребителят е активен служител на организацията
   */
  public isActiveOrgStaff(orgId: string, userId: string): boolean {
    const row = this.db.prepare(`
      SELECT role FROM organization_memberships
      WHERE org_id = ? AND user_id = ? AND status = 'active'
    `).get(orgId, userId) as { role: string } | undefined;

    return !!row;
  }

  /**
   * Проверка за роля на служител (owner, manager, coordinator)
   */
  public getStaffRole(orgId: string, userId: string): string | null {
    const row = this.db.prepare(`
      SELECT role FROM organization_memberships
      WHERE org_id = ? AND user_id = ? AND status = 'active'
    `).get(orgId, userId) as { role: string } | undefined;

    return row ? row.role : null;
  }

  /**
   * Проверка дали потребителят е активен собственик (Owner) на организацията
   */
  public isOwner(orgId: string, userId: string): boolean {
    return this.getStaffRole(orgId, userId) === 'owner';
  }

  /**
   * Право за създаване на ново събитие:
   * - Потребители с роля 'owner' или 'manager' в организацията
   */
  public canCreateEvent(orgId: string, userId: string): boolean {
    const role = this.getStaffRole(orgId, userId);
    return role === 'owner' || role === 'manager';
  }

  /**
   * Право за изтриване на събитие:
   * - Само активен потребител с роля 'owner' в организацията на събитието
   */
  public canDeleteEvent(eventId: string, userId: string): boolean {
    const event = this.db.prepare(`
      SELECT org_id FROM events WHERE id = ?
    `).get(eventId) as { org_id: string } | undefined;

    if (!event) return false;
    return this.isOwner(event.org_id, userId);
  }

  /**
   * Право за управление на събитие:
   * - Owner или Manager на организацията
   * - Назначен координатор на събитието
   */
  public canManageEvent(eventId: string, userId: string): boolean {
    const event = this.db.prepare(`
      SELECT org_id, primary_coordinator_id FROM events WHERE id = ?
    `).get(eventId) as { org_id: string; primary_coordinator_id: string } | undefined;

    if (!event) return false;

    const staffRole = this.getStaffRole(event.org_id, userId);
    if (!staffRole) return false;

    if (staffRole === 'owner' || staffRole === 'manager') return true;
    if (staffRole === 'coordinator') {
      if (event.primary_coordinator_id === userId) return true;
      const mem = this.db.prepare(`
        SELECT 1 FROM event_memberships 
        WHERE event_id = ? AND user_id = ? AND member_type = 'staff' AND status = 'active'
      `).get(eventId, userId);
      return !!mem;
    }
    return false;
  }

  /**
   * Право за четене на събитие:
   * - Екип с право за събитието
   * - Клиент с активно членство в събитието (и неизтекъл срок за достъп)
   */
  public canReadEvent(eventId: string, userId: string): boolean {
    const event = this.db.prepare(`
      SELECT org_id, lifecycle, primary_coordinator_id FROM events WHERE id = ?
    `).get(eventId) as { org_id: string; lifecycle: string; primary_coordinator_id: string } | undefined;

    if (!event) return false;

    const staffRole = this.getStaffRole(event.org_id, userId);
    if (staffRole === 'owner' || staffRole === 'manager') return true;
    if (staffRole === 'coordinator') {
      if (event.primary_coordinator_id === userId) return true;
      const staffMem = this.db.prepare(`
        SELECT 1 FROM event_memberships 
        WHERE event_id = ? AND user_id = ? AND member_type = 'staff' AND status = 'active'
      `).get(eventId, userId);
      if (staffMem) return true;
    }

    // Проверка за клиентско членство
    const nowIso = new Date().toISOString();
    const clientMem = this.db.prepare(`
      SELECT status, access_expires_at FROM event_memberships
      WHERE event_id = ? AND user_id = ? AND member_type = 'client' AND status = 'active'
    `).get(eventId, userId) as { status: string; access_expires_at: string | null } | undefined;

    if (clientMem) {
      if (clientMem.access_expires_at && clientMem.access_expires_at <= nowIso) {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Право за преглед на бюджет и финансови данни:
   * - Екип (owner, manager, coordinator)
   * - Клиент с can_view_budget = 1 и действащо членство
   */
  public canReadBudget(eventId: string, userId: string): boolean {
    if (!this.canReadEvent(eventId, userId)) return false;

    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(eventId) as { org_id: string } | undefined;
    if (!event) return false;

    if (this.isActiveOrgStaff(event.org_id, userId)) return true;

    const nowIso = new Date().toISOString();
    const clientMem = this.db.prepare(`
      SELECT can_view_budget, access_expires_at FROM event_memberships
      WHERE event_id = ? AND user_id = ? AND member_type = 'client' AND status = 'active'
    `).get(eventId, userId) as { can_view_budget: number; access_expires_at: string | null } | undefined;

    if (clientMem && clientMem.can_view_budget === 1) {
      if (clientMem.access_expires_at && clientMem.access_expires_at <= nowIso) {
        return false;
      }
      return true;
    }

    return false;
  }

  /**
   * Право за четене на документ:
   * - Документът не е изтрит
   * - За аудитория 'team' -> само екип
   * - За аудитория 'client' -> клиент на събитието
   * - Ако requires_budget_permission = 1 -> задължително canReadBudget
   */
  public canReadDocument(documentId: string, userId: string): boolean {
    const doc = this.db.prepare(`
      SELECT org_id, event_id, audience, requires_budget_permission, deleted_at 
      FROM documents WHERE id = ?
    `).get(documentId) as { org_id: string; event_id: string; audience: string; requires_budget_permission: number; deleted_at: string | null } | undefined;

    if (!doc || doc.deleted_at !== null) return false;

    if (doc.requires_budget_permission === 1 && !this.canReadBudget(doc.event_id, userId)) {
      return false;
    }

    if (doc.audience === 'team') {
      return this.canManageEvent(doc.event_id, userId);
    }

    return this.canReadEvent(doc.event_id, userId);
  }

  /**
   * Право за отговор на искане за одобрение:
   * - Искането е pending и срокът не е изтекъл
   * - Активен собственик (Owner) на организацията може да изпълнява всяко действие
   * - Или потребителят е точно назначеният assignee с роля client_decision_maker
   */
  public canRespondToApprovalRequest(requestId: string, userId: string): { allowed: boolean; reason?: string } {
    const req = this.db.prepare(`
      SELECT id, org_id, event_id, assignee_user_id, status, expires_at 
      FROM approval_requests WHERE id = ?
    `).get(requestId) as { id: string; org_id: string; event_id: string; assignee_user_id: string; status: string; expires_at: string } | undefined;

    if (!req) return { allowed: false, reason: 'Request not found' };

    if (req.status !== 'pending') {
      return { allowed: false, reason: `Request is not pending (status: ${req.status})` };
    }

    const nowIso = new Date().toISOString();
    if (req.expires_at <= nowIso) {
      return { allowed: false, reason: 'Request has expired' };
    }

    if (this.isOwner(req.org_id, userId)) {
      return { allowed: true };
    }

    if (req.assignee_user_id !== userId) {
      return { allowed: false, reason: 'User is not the assigned decision maker' };
    }

    const mem = this.db.prepare(`
      SELECT client_role, status, access_expires_at 
      FROM event_memberships 
      WHERE event_id = ? AND user_id = ? AND member_type = 'client'
    `).get(req.event_id, userId) as { client_role: string; status: string; access_expires_at: string | null } | undefined;

    if (!mem || mem.status !== 'active') {
      return { allowed: false, reason: 'Client membership is revoked or missing' };
    }

    if (mem.client_role !== 'client_decision_maker') {
      return { allowed: false, reason: 'Only client_decision_maker can approve' };
    }

    if (mem.access_expires_at && mem.access_expires_at <= nowIso) {
      return { allowed: false, reason: 'Client event access has expired' };
    }

    return { allowed: true };
  }
}
