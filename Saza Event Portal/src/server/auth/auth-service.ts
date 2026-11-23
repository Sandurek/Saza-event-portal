// src/server/auth/auth-service.ts
// Управление на идентичност, покани, сесии и отнемане на достъп

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import type { UserSession } from '../../domain/types.ts';

export class AuthService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  public hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Създаване на покана (Staff или Client)
   */
  public createInvitation(params: {
    orgId: string;
    kind: 'staff' | 'client';
    eventId?: string | null;
    email: string;
    intendedRole: string;
    budgetPermission?: boolean;
    invitedBy: string;
    validHours?: number;
  }): { invitationId: string; rawToken: string; expiresAt: string } {
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    const validHours = params.validHours || 72;
    const expiresAt = new Date(Date.now() + validHours * 3600 * 1000).toISOString();
    const id = crypto.randomUUID();
    const normalizedEmail = params.email.trim().toLowerCase();

    this.db.prepare(`
      INSERT INTO invitations (
        id, org_id, kind, event_id, normalized_email, intended_role, budget_permission,
        token_hash, expires_at, invited_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.orgId,
      params.kind,
      params.eventId || null,
      normalizedEmail,
      params.intendedRole,
      params.budgetPermission ? 1 : 0,
      tokenHash,
      expiresAt,
      params.invitedBy,
      new Date().toISOString()
    );

    return { invitationId: id, rawToken, expiresAt };
  }

  /**
   * Приемане на покана (еднократно, транзакционно)
   */
  public acceptInvitation(rawToken: string, user: { userId: string; email: string; displayName?: string }): {
    success: boolean;
    kind?: string;
    eventId?: string | null;
    error?: string;
  } {
    const tokenHash = this.hashToken(rawToken);
    const normalizedEmail = user.email.trim().toLowerCase();
    const nowIso = new Date().toISOString();

    return this.db.transaction(() => {
      const inv = this.db.prepare(`
        SELECT * FROM invitations WHERE token_hash = ?
      `).get(tokenHash) as {
        id: string;
        org_id: string;
        kind: 'staff' | 'client';
        event_id: string | null;
        normalized_email: string;
        intended_role: string;
        budget_permission: number;
        expires_at: string;
        accepted_at: string | null;
        revoked_at: string | null;
      } | undefined;

      if (!inv) {
        return { success: false, error: 'Невалидна или несъществуваща покана' };
      }

      if (inv.revoked_at) {
        return { success: false, error: 'Поканата е оттеглена' };
      }

      if (inv.expires_at <= nowIso) {
        return { success: false, error: 'Срокът на поканата е изтекъл' };
      }

      if (inv.normalized_email !== normalizedEmail) {
        return { success: false, error: 'Поканата е издадена за друг имейл адрес' };
      }

      // Ако вече е приета, връщаме успех без дублиране
      if (inv.accepted_at) {
        return { success: true, kind: inv.kind, eventId: inv.event_id };
      }

      // Уверяваме се, че профилът съществува
      const existingProfile = this.db.prepare(`SELECT user_id FROM profiles WHERE user_id = ?`).get(user.userId);
      if (!existingProfile) {
        this.db.prepare(`
          INSERT INTO profiles (user_id, display_name, email, locale, timezone, created_at, updated_at)
          VALUES (?, ?, ?, 'bg', 'Europe/Sofia', ?, ?)
        `).run(user.userId, user.displayName || user.email, normalizedEmail, nowIso, nowIso);
      }

      // Добавяне на членство
      if (inv.kind === 'staff') {
        const mem = this.db.prepare(`
          SELECT id FROM organization_memberships WHERE org_id = ? AND user_id = ?
        `).get(inv.org_id, user.userId) as { id: string } | undefined;

        if (!mem) {
          this.db.prepare(`
            INSERT INTO organization_memberships (id, org_id, user_id, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)
          `).run(crypto.randomUUID(), inv.org_id, user.userId, inv.intended_role, nowIso, nowIso);
        }
      } else if (inv.kind === 'client' && inv.event_id) {
        const eventMem = this.db.prepare(`
          SELECT id FROM event_memberships WHERE event_id = ? AND user_id = ?
        `).get(inv.event_id, user.userId) as { id: string } | undefined;

        if (!eventMem) {
          this.db.prepare(`
            INSERT INTO event_memberships (
              id, org_id, event_id, user_id, member_type, client_role, can_view_budget, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'client', ?, ?, 'active', ?, ?)
          `).run(
            crypto.randomUUID(),
            inv.org_id,
            inv.event_id,
            user.userId,
            inv.intended_role,
            inv.budget_permission,
            nowIso,
            nowIso
          );
        }
      }

      // Маркиране на поканата като приета
      this.db.prepare(`
        UPDATE invitations SET accepted_at = ? WHERE id = ?
      `).run(nowIso, inv.id);

      return { success: true, kind: inv.kind, eventId: inv.event_id };
    });
  }

  /**
   * Отнемане на клиентски достъп към събитие
   */
  public revokeEventMembership(eventId: string, userId: string, actorUserId: string): boolean {
    return this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT id, org_id FROM event_memberships WHERE event_id = ? AND user_id = ?
      `).get(eventId, userId) as { id: string; org_id: string } | undefined;

      if (!row) return false;

      this.db.prepare(`
        UPDATE event_memberships SET status = 'revoked', updated_at = ? WHERE id = ?
      `).run(new Date().toISOString(), row.id);

      // Прекратяване на всички чакащи искания за одобрение към този клиент
      this.db.prepare(`
        UPDATE approval_requests 
        SET status = 'withdrawn', updated_at = ? 
        WHERE event_id = ? AND assignee_user_id = ? AND status = 'pending'
      `).run(new Date().toISOString(), eventId, userId);

      // Одит
      this.db.prepare(`
        INSERT INTO audit_log (id, org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, created_at)
        VALUES (?, ?, ?, ?, 'user', 'membership_revoked', 'event_membership', ?, ?)
      `).run(crypto.randomUUID(), row.org_id, eventId, actorUserId, row.id, new Date().toISOString());

      return true;
    });
  }

  /**
   * Извличане на потребителска сесия
   */
  public getUserSession(userId: string): UserSession | null {
    const profile = this.db.prepare(`
      SELECT user_id, display_name, email FROM profiles WHERE user_id = ?
    `).get(userId) as { user_id: string; display_name: string; email: string } | undefined;

    if (!profile) return null;

    const orgMem = this.db.prepare(`
      SELECT org_id, role, status FROM organization_memberships WHERE user_id = ? AND status = 'active'
    `).get(userId) as { org_id: string; role: 'owner' | 'manager' | 'coordinator'; status: string } | undefined;

    const eventMems = this.db.prepare(`
      SELECT event_id, member_type, client_role, can_view_budget, status, access_expires_at 
      FROM event_memberships WHERE user_id = ?
    `).all(userId) as {
      event_id: string;
      member_type: 'staff' | 'client';
      client_role?: 'client_decision_maker' | 'client_viewer';
      can_view_budget: number;
      status: 'active' | 'revoked';
      access_expires_at?: string | null;
    }[];

    return {
      userId: profile.user_id,
      displayName: profile.display_name,
      email: profile.email,
      orgId: orgMem ? orgMem.org_id : '',
      orgRole: orgMem ? orgMem.role : undefined,
      isStaff: !!orgMem,
      eventMemberships: eventMems.map(m => ({
        eventId: m.event_id,
        memberType: m.member_type,
        clientRole: m.client_role,
        canViewBudget: m.can_view_budget === 1,
        status: m.status,
        accessExpiresAt: m.access_expires_at
      }))
    };
  }
}
