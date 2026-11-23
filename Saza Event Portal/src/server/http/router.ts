// src/server/http/router.ts
// REST API Рутер за Saza Event Portal (Section 16.2 & API_DOCUMENTATION.md)
// Без външни библиотеки — чист Node.js http router

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Database, verifyPassword, hashPassword } from '../db/database.ts';
import { config } from '../config/env.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import { AuthService } from '../auth/auth-service.ts';
import { EventService } from '../services/event-service.ts';
import { MilestoneService } from '../services/milestone-service.ts';
import { ProposalService } from '../services/proposal-service.ts';
import { BudgetService } from '../services/budget-service.ts';
import { PaymentService } from '../services/payment-service.ts';
import { DocumentService } from '../services/document-service.ts';
import { CommunicationService } from '../services/communication-service.ts';
import { OutboxWorker } from '../jobs/outbox-worker.ts';
import type { StorageAdapter } from '../storage/storage-adapter.ts';
import type { MailAdapter } from '../mail/mail-adapter.ts';
import {
  sendJson,
  sendError,
  parseJsonBody,
  parseMultipartBody,
  authenticate,
  signSession,
  type AuthContext,
} from './middleware.ts';

export class AppRouter {
  private db: Database;
  private policy: AccessPolicy;
  private authService: AuthService;
  private eventService: EventService;
  private milestoneService: MilestoneService;
  private proposalService: ProposalService;
  private budgetService: BudgetService;
  private paymentService: PaymentService;
  private documentService: DocumentService;
  private commService: CommunicationService;
  private outboxWorker: OutboxWorker;
  private storageAdapter: StorageAdapter;
  private mailAdapter: MailAdapter;

  constructor(params: {
    db: Database;
    storageAdapter: StorageAdapter;
    mailAdapter: MailAdapter;
  }) {
    this.db = params.db;
    this.storageAdapter = params.storageAdapter;
    this.mailAdapter = params.mailAdapter;

    this.policy = new AccessPolicy(this.db);
    this.authService = new AuthService(this.db);
    this.eventService = new EventService(this.db);
    this.milestoneService = new MilestoneService(this.db);
    this.proposalService = new ProposalService(this.db);
    this.budgetService = new BudgetService(this.db);
    this.paymentService = new PaymentService(this.db);
    this.documentService = new DocumentService(this.db);
    this.commService = new CommunicationService(this.db);
    this.outboxWorker = new OutboxWorker(this.db, this.mailAdapter);
  }

  private getBaseUrl(req: http.IncomingMessage): string {
    const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host;
    return host ? `${proto}://${host}` : config.appBaseUrl;
  }

  private isOwner(auth: AuthContext | null): boolean {
    return auth?.role === 'owner';
  }

  private isOwnerOrManager(auth: AuthContext | null): boolean {
    return auth?.role === 'owner' || auth?.role === 'manager';
  }

  private isTeamOrOwner(auth: AuthContext | null): boolean {
    return !!auth && (auth.isStaff || auth.role === 'owner');
  }

  public async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;
    const method = req.method || 'GET';

    try {
      // ─── 1. Health & Status ───────────────────────────────────────────────
      if (pathname === '/api/health' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'ok',
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
          environment: config.nodeEnv,
        });
      }

      if (pathname === '/api/status' && method === 'GET') {
        return sendJson(res, 200, {
          status: 'Ready',
          environment: config.nodeEnv,
          storage: config.storage.driver,
          mail: config.mail.driver,
          database: 'sqlite',
        });
      }

      if (pathname === '/api/tests/report' && method === 'GET') {
        const reportPath = path.resolve(process.cwd(), 'TEST_REPORT.md');
        if (fs.existsSync(reportPath)) {
          const report = fs.readFileSync(reportPath, 'utf8');
          return sendJson(res, 200, { report });
        }
        return sendJson(res, 200, { report: 'No test report generated yet' });
      }

      // ─── 2. Auth & Session ───────────────────────────────────────────────
      if (pathname === '/api/auth/login' && method === 'POST') {
        const body = await parseJsonBody(req);
        const username = body.username || body.userId || body.email;
        const password = body.password;

        let profile: any = null;

        if (username) {
          profile = this.db.prepare(`
            SELECT user_id, username, password_hash, password_salt, display_name, email
            FROM profiles
            WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?) OR user_id = ?
          `).get(username, username, username);
        } else if (body.role) {
          // Dev / demo fallback
          const roleMap: Record<string, string> = {
            sando: 'usr-sando-owner',
            owner: 'usr-sando-owner',
            client_a: 'usr-client-a-444',
            client_b: 'usr-client-b-555',
            coordinator: 'usr-coord-333',
            manager: 'usr-manager-222',
            user_org_b: 'usr-org-b-777',
          };
          const uid = roleMap[body.role] || body.role;
          profile = this.db.prepare(`
            SELECT user_id, username, password_hash, password_salt, display_name, email
            FROM profiles WHERE user_id = ?
          `).get(uid);
        }

        if (!profile) {
          return sendError(res, 401, 'UNAUTHORIZED', 'Невалидно потребителско име или парола');
        }

        // Проверка за деактивиран профил или задължителна парола за staff акаунти
        if (profile.password_hash === 'DISABLED') {
          return sendError(res, 401, 'UNAUTHORIZED', 'Този акаунт е деактивиран');
        }

        // Ако акаунтът има username (организатор/собственик), паролата е задължителна
        if (profile.username) {
          if (!profile.password_hash || !profile.password_salt) {
            return sendError(res, 401, 'UNAUTHORIZED', 'Акаунтът е деактивиран');
          }
          if (!password) {
            return sendError(res, 401, 'UNAUTHORIZED', 'Моля, въведете парола');
          }
          const isMatch = verifyPassword(password, profile.password_hash, profile.password_salt);
          if (!isMatch) {
            return sendError(res, 401, 'UNAUTHORIZED', 'Невалидно потребителско име или парола');
          }
        } else if (profile.password_hash && profile.password_salt) {
          if (!password) {
            return sendError(res, 401, 'UNAUTHORIZED', 'Моля, въведете парола');
          }
          const isMatch = verifyPassword(password, profile.password_hash, profile.password_salt);
          if (!isMatch) {
            return sendError(res, 401, 'UNAUTHORIZED', 'Невалидно потребителско име или парола');
          }
        }

        // Взимаме ролята
        const staffMem = this.db.prepare(`
          SELECT role, org_id FROM organization_memberships WHERE user_id = ? AND status = 'active' LIMIT 1
        `).get(profile.user_id) as any;

        if (profile.username && !staffMem) {
          return sendError(res, 403, 'FORBIDDEN', 'Достъпът на този профил до организацията е деактивиран');
        }

        const sessionToken = signSession({
          userId: profile.user_id,
          role: staffMem?.role,
          orgId: staffMem?.org_id || 'org-saza-agency-01',
        });

        res.setHeader(
          'Set-Cookie',
          `saza_session=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
        );

        return sendJson(res, 200, {
          success: true,
          token: sessionToken,
          user: {
            userId: profile.user_id,
            username: profile.username || profile.display_name,
            displayName: profile.display_name,
            email: profile.email,
            isStaff: !!staffMem,
            role: staffMem?.role,
            orgId: staffMem?.org_id || 'org-saza-agency-01',
          },
        });
      }

      if (pathname === '/api/auth/logout' && method === 'POST') {
        res.setHeader('Set-Cookie', `saza_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
        return sendJson(res, 200, { success: true });
      }

      // ─── 3. Client Portal Access via Magic Link Token ─────────────────────
      if (pathname === '/api/portal/access' && method === 'GET') {
        const token = url.searchParams.get('token') || (req.headers['x-client-token'] as string);
        if (!token) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Липсва токен за клиентски достъп');
        }

        const mem = this.db.prepare(`
          SELECT em.id as membership_id, em.event_id, em.user_id, em.client_role, em.can_view_budget, em.status,
                 e.title as event_title, e.event_type, e.starts_at, e.ends_at, e.venue_label, e.lifecycle, e.org_id,
                 p.display_name as client_name, p.email as client_email,
                 o.name as agency_name
          FROM event_memberships em
          JOIN events e ON e.id = em.event_id
          JOIN profiles p ON p.user_id = em.user_id
          JOIN organizations o ON o.id = e.org_id
          WHERE (em.access_token = ? OR em.id = ?) AND em.status = 'active'
        `).get(token, token) as any;

        if (!mem) {
          return sendError(res, 404, 'NOT_FOUND', 'Невалиден или неактивен линк за събитие');
        }

        // Задаваме клиентска сесия за последващи действия
        const clientSessionToken = signSession({ userId: mem.user_id, orgId: mem.org_id });
        res.setHeader(
          'Set-Cookie',
          `saza_session=${encodeURIComponent(clientSessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
        );

        // Публикувани етапи за клиента
        const milestones = this.db.prepare(`
          SELECT id, category, title, status, health, next_step, due_date, published_at
          FROM milestones
          WHERE event_id = ? AND published_at IS NOT NULL
          ORDER BY due_date ASC
        `).all(mem.event_id);

        // Предложения за избор
        const proposals = this.db.prepare(`
          SELECT p.id, p.title, p.kind, p.current_version_id, pv.version_no, pv.body_json,
                 ar.id as active_request_id, ar.status as request_status, ar.expires_at, ar.assignee_user_id
          FROM proposals p
          LEFT JOIN proposal_versions pv ON pv.id = p.current_version_id
          LEFT JOIN approval_requests ar ON ar.proposal_id = p.id
          WHERE p.event_id = ?
          ORDER BY p.created_at DESC
        `).all(mem.event_id) as any[];

        const proposalsWithOptions = proposals.map(prop => {
          const options = this.db.prepare(`
            SELECT id, title, description, total_cents, sort_order
            FROM proposal_options
            WHERE proposal_version_id = ?
            ORDER BY sort_order ASC
          `).all(prop.current_version_id) as any[];

          const response = prop.active_request_id ? this.db.prepare(`
            SELECT selected_option_id, decision, comment, decided_at
            FROM approval_responses WHERE request_id = ?
          `).get(prop.active_request_id) as any : null;

          return {
            ...prop,
            options: options.map(o => ({
              ...o,
              total_cents: mem.can_view_budget === 1 ? o.total_cents : null,
            })),
            response,
          };
        });

        // Документи, публикувани за клиента
        const documents = this.db.prepare(`
          SELECT d.id, d.title, d.category, dv.original_name, dv.mime_type, dv.byte_size, dv.created_at
          FROM documents d
          JOIN document_versions dv ON dv.id = d.current_version_id
          WHERE d.event_id = ? AND d.audience = 'client' AND dv.scan_state = 'ready'
          ORDER BY d.created_at DESC
        `).all(mem.event_id);

        // Бюджет (само ако има право)
        let budgetSummary = null;
        if (mem.can_view_budget === 1) {
          const activeBudget = this.db.prepare(`
            SELECT total_cents, currency FROM budget_versions WHERE event_id = ? AND state = 'active' LIMIT 1
          `).get(mem.event_id) as any;

          const paidSum = this.db.prepare(`
            SELECT coalesce(sum(signed_amount_cents), 0) as paid_cents FROM payment_entries WHERE event_id = ?
          `).get(mem.event_id) as any;

          if (activeBudget) {
            budgetSummary = {
              totalCents: activeBudget.total_cents,
              paidCents: paidSum?.paid_cents || 0,
              currency: activeBudget.currency,
            };
          }
        }

        return sendJson(res, 200, {
          token,
          event: {
            id: mem.event_id,
            title: mem.event_title,
            eventType: mem.event_type,
            startsAt: mem.starts_at,
            endsAt: mem.ends_at,
            venueLabel: mem.venue_label,
            lifecycle: mem.lifecycle,
            agencyName: mem.agency_name,
          },
          client: {
            userId: mem.user_id,
            name: mem.client_name,
            email: mem.client_email,
            role: mem.client_role,
            canViewBudget: mem.can_view_budget === 1,
          },
          milestones,
          proposals: proposalsWithOptions,
          documents,
          budget: budgetSummary,
        });
      }

      // ─── 3b. Background Jobs (преди общия auth check, ако има X-Jobs-Secret) ──
      if (pathname === '/api/jobs/outbox' && method === 'POST') {
        const jobsSecret = req.headers['x-jobs-secret'];
        const hasValidSecret = !!jobsSecret && jobsSecret === config.security.jobsSecret;
        const jobAuth = hasValidSecret ? null : authenticate(req, this.db);
        const isAuthorized = hasValidSecret || this.isTeamOrOwner(jobAuth);

        if (!isAuthorized) {
          return sendError(res, 403, 'FORBIDDEN', 'Невалиден X-Jobs-Secret код');
        }

        const stats = await this.outboxWorker.processBatchAsync(config.mail.outboxBatchSize);
        return sendJson(res, 200, {
          success: true,
          stats,
          driver: config.mail.driver,
        });
      }

      // Автентикация за защитените маршрути
      const auth = authenticate(req, this.db);

      if (pathname === '/api/auth/session' && method === 'GET') {
        if (!auth) {
          return sendJson(res, 200, { authenticated: false });
        }
        const memberships = this.db.prepare(`
          SELECT em.event_id, em.client_role, em.can_view_budget, em.status, em.access_token, e.title as event_title
          FROM event_memberships em
          JOIN events e ON e.id = em.event_id
          WHERE em.user_id = ? AND em.status = 'active'
        `).all(auth.userId);

        return sendJson(res, 200, {
          authenticated: true,
          user: auth,
          memberships,
        });
      }

      // Всички следващи маршрути изискват валиден потребител (или клиентски токен)
      if (!auth) {
        return sendError(res, 401, 'UNAUTHORIZED', 'Изисква се автентикация за достъп');
      }

      // ─── 4. Events ────────────────────────────────────────────────────────
      if (pathname === '/api/events' && method === 'GET') {
        const orgId = auth.orgId || 'org-saza-agency-01';
        let events: any[] = [];
        if (this.isTeamOrOwner(auth)) {
          const isCoordinator = !this.isOwnerOrManager(auth);
          const scopeWhere = isCoordinator
            ? `WHERE e.org_id = ? AND (e.primary_coordinator_id = ? OR EXISTS (SELECT 1 FROM event_memberships sem WHERE sem.event_id = e.id AND sem.user_id = ? AND sem.member_type = 'staff' AND sem.status = 'active'))`
            : `WHERE e.org_id = ?`;
          const queryParams = isCoordinator ? [orgId, auth.userId, auth.userId] : [orgId];

          events = this.db.prepare(`
            SELECT e.id, e.org_id, e.title, e.event_type, e.lifecycle, e.starts_at, e.ends_at, e.timezone, e.venue_label,
                   cem.access_token as client_token,
                   cem.client_name,
                   cem.client_email,
                   COALESCE(bv.total_cents, 0) as budget_cents,
                   COALESCE(pe.paid_cents, 0) as paid_cents,
                   COALESCE(ms.milestones_count, 0) as milestones_count,
                   COALESCE(pr.proposals_count, 0) as proposals_count
            FROM events e
            LEFT JOIN (
              SELECT em.event_id,
                     MAX(em.access_token) as access_token,
                     MIN(p.display_name) as client_name,
                     MIN(p.email) as client_email
              FROM event_memberships em
              JOIN profiles p ON p.user_id = em.user_id
              WHERE em.member_type = 'client' AND em.status = 'active'
              GROUP BY em.event_id
            ) cem ON cem.event_id = e.id
            LEFT JOIN (
              SELECT event_id, total_cents FROM budget_versions WHERE state = 'active'
            ) bv ON bv.event_id = e.id
            LEFT JOIN (
              SELECT event_id, SUM(signed_amount_cents) as paid_cents FROM payment_entries GROUP BY event_id
            ) pe ON pe.event_id = e.id
            LEFT JOIN (
              SELECT event_id, COUNT(*) as milestones_count FROM milestones GROUP BY event_id
            ) ms ON ms.event_id = e.id
            LEFT JOIN (
              SELECT event_id, COUNT(*) as proposals_count FROM proposals GROUP BY event_id
            ) pr ON pr.event_id = e.id
            ${scopeWhere}
            ORDER BY e.created_at DESC
          `).all(...queryParams);
        } else {
          events = this.db.prepare(`
            SELECT e.id, e.org_id, e.title, e.event_type, e.lifecycle, e.starts_at, e.ends_at, e.timezone, e.venue_label,
                   em.client_role, em.can_view_budget
            FROM events e
            JOIN event_memberships em ON em.event_id = e.id
            WHERE em.user_id = ? AND em.status = 'active'
            ORDER BY e.starts_at ASC
          `).all(auth.userId);
        }
        return sendJson(res, 200, { events });
      }

      // ─── 4b. Общ финансов център на агенцията (Staff & Owner) ────────────
      if (pathname === '/api/finances/overview' && method === 'GET') {
        if (!this.isTeamOrOwner(auth)) {
          return sendError(res, 403, 'FORBIDDEN', 'Само екипът има достъп до финансите');
        }

        const orgId = auth.orgId || 'org-saza-agency-01';
        const isCoordinator = auth.role === 'coordinator';
        const scopeClause = isCoordinator
          ? `WHERE e.org_id = ? AND (e.primary_coordinator_id = ? OR EXISTS (SELECT 1 FROM event_memberships sem WHERE sem.event_id = e.id AND sem.user_id = ? AND sem.member_type = 'staff' AND sem.status = 'active'))`
          : `WHERE e.org_id = ?`;
        const scopeParams = isCoordinator ? [orgId, auth.userId, auth.userId] : [orgId];

        const events = this.db.prepare(`
          SELECT e.id, e.title, e.event_type, e.starts_at, e.venue_label, e.lifecycle,
                 p.display_name as client_name, p.email as client_email,
                 bv.total_cents as budget_cents,
                 COALESCE(pe.paid_cents, 0) as paid_cents,
                 COALESCE(ic.supplier_cents, 0) as supplier_cents
          FROM events e
          LEFT JOIN (
            SELECT em.event_id, MIN(pr.display_name) as display_name, MIN(pr.email) as email
            FROM event_memberships em
            JOIN profiles pr ON pr.user_id = em.user_id
            WHERE em.member_type = 'client' AND em.status = 'active'
            GROUP BY em.event_id
          ) p ON p.event_id = e.id
          LEFT JOIN (
            SELECT event_id, total_cents FROM budget_versions WHERE state = 'active'
          ) bv ON bv.event_id = e.id
          LEFT JOIN (
            SELECT event_id, SUM(signed_amount_cents) as paid_cents FROM payment_entries GROUP BY event_id
          ) pe ON pe.event_id = e.id
          LEFT JOIN (
            SELECT event_id, SUM(cost_cents) as supplier_cents FROM internal_costs GROUP BY event_id
          ) ic ON ic.event_id = e.id
          ${scopeClause}
          ORDER BY e.starts_at ASC
        `).all(...scopeParams) as any[];

        let totalBudgetCents = 0;
        let totalPaidCents = 0;
        let totalSupplierCents = 0;

        const eventItems = events.map(ev => {
          const budget = ev.budget_cents || 0;
          const paid = ev.paid_cents || 0;
          const supplier = ev.supplier_cents || 0;
          const balance = budget - paid;
          const margin = budget - supplier;

          totalBudgetCents += budget;
          totalPaidCents += paid;
          totalSupplierCents += supplier;

          return {
            id: ev.id,
            title: ev.title,
            eventType: ev.event_type,
            startsAt: ev.starts_at,
            venueLabel: ev.venue_label,
            lifecycle: ev.lifecycle,
            clientName: ev.client_name,
            clientEmail: ev.client_email,
            budgetCents: budget,
            budgetEUR: (budget / 100).toFixed(2),
            paidCents: paid,
            paidEUR: (paid / 100).toFixed(2),
            balanceCents: balance,
            balanceEUR: (Math.abs(balance) / 100).toFixed(2),
            isOverpaid: paid > budget,
            supplierCents: supplier,
            supplierEUR: (supplier / 100).toFixed(2),
            marginCents: margin,
            marginEUR: (margin / 100).toFixed(2),
            marginPercent: budget > 0 ? Math.round((margin / budget) * 100) : 0,
            status: paid >= budget && budget > 0 ? 'paid' : (paid > 0 ? 'partial' : 'pending'),
          };
        });

        const totalPendingCents = Math.max(0, totalBudgetCents - totalPaidCents);
        const totalMarginCents = totalBudgetCents - totalSupplierCents;
        const totalMarginPercent = totalBudgetCents > 0 ? Math.round((totalMarginCents / totalBudgetCents) * 100) : 0;

        const recentPayments = this.db.prepare(`
          SELECT pe.id, pe.event_id, pe.signed_amount_cents, pe.effective_date, pe.reference, pe.created_at,
                 e.title as event_title, p.display_name as recorded_by_name
          FROM payment_entries pe
          JOIN events e ON e.id = pe.event_id
          JOIN profiles p ON p.user_id = pe.recorded_by
          ${scopeClause}
          ORDER BY pe.effective_date DESC, pe.created_at DESC
          LIMIT 10
        `).all(...scopeParams) as any[];

        const upcomingSchedules = this.db.prepare(`
          SELECT ps.id, ps.event_id, ps.label, ps.amount_cents, ps.due_date, ps.state,
                 e.title as event_title
          FROM payment_schedules ps
          JOIN events e ON e.id = ps.event_id
          ${scopeClause} AND ps.state != 'paid'
          ORDER BY ps.due_date ASC
          LIMIT 10
        `).all(...scopeParams) as any[];

        return sendJson(res, 200, {
          totalBudgetCents,
          totalBudgetEUR: (totalBudgetCents / 100).toFixed(2),
          totalPaidCents,
          totalPaidEUR: (totalPaidCents / 100).toFixed(2),
          totalPendingCents,
          totalPendingEUR: (totalPendingCents / 100).toFixed(2),
          totalSupplierCents,
          totalSupplierEUR: (totalSupplierCents / 100).toFixed(2),
          totalMarginCents,
          totalMarginEUR: (totalMarginCents / 100).toFixed(2),
          totalMarginPercent,
          events: eventItems,
          recentPayments: recentPayments.map(p => ({
            ...p,
            amountEUR: (p.signed_amount_cents / 100).toFixed(2)
          })),
          upcomingSchedules: upcomingSchedules.map(s => ({
            ...s,
            amountEUR: (s.amount_cents / 100).toFixed(2)
          }))
        });
      }

      // Създаване на ново събитие (Owner или Manager)
      if (pathname === '/api/events' && method === 'POST') {
        const orgId = auth.orgId || 'org-saza-agency-01';
        const canCreate = this.isOwner(auth) || this.policy.canCreateEvent(orgId, auth.userId);

        if (!canCreate) {
          return sendError(res, 403, 'FORBIDDEN', 'Само потребители с роля Owner или Manager могат да създават събития');
        }
        const body = await parseJsonBody(req);
        if (!body.title) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Заглавието на събитието е задължително');
        }

        const eventId = `evt-${crypto.randomUUID().slice(0, 8)}`;
        const nowIso = new Date().toISOString();

        const startsAt = body.startsAt || new Date(Date.now() + 30 * 86400000).toISOString();
        const endsAt = body.endsAt || startsAt;

        const clientName = String(body.clientName || 'Клиент').trim();
        const clientEmail = String(body.clientEmail || `client-${Date.now()}@example.com`).trim().toLowerCase();
        const clientToken = `tok_${crypto.randomBytes(16).toString('hex')}`;

        const existingClient = this.db.prepare(`
          SELECT user_id, username FROM profiles WHERE LOWER(email) = LOWER(?) LIMIT 1
        `).get(clientEmail) as { user_id: string; username: string | null } | undefined;

        if (existingClient?.username) {
          return sendError(res, 409, 'CONFLICT', `Имейл "${clientEmail}" принадлежи на акаунт от екипа`);
        }

        const clientUserId = existingClient?.user_id || `usr-client-${crypto.randomUUID().slice(0, 8)}`;

        this.db.transaction(() => {
          // 1. Събитие
          this.db.prepare(`
            INSERT INTO events (id, org_id, title, event_type, starts_at, ends_at, venue_label, lifecycle, primary_coordinator_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'planning', ?, ?, ?)
          `).run(
            eventId, orgId, body.title, body.eventType || 'wedding', startsAt, endsAt,
            body.venueLabel || '', auth.userId, nowIso, nowIso
          );

          // 2. Клиентски профил (създава нов или използва съществуващ клиент по имейл)
          if (!existingClient) {
            this.db.prepare(`
              INSERT INTO profiles (user_id, display_name, email, locale, timezone, created_at, updated_at)
              VALUES (?, ?, ?, 'bg', 'Europe/Sofia', ?, ?)
            `).run(clientUserId, clientName, clientEmail, nowIso, nowIso);
          } else if (clientName) {
            this.db.prepare(`
              UPDATE profiles SET display_name = ?, updated_at = ? WHERE user_id = ?
            `).run(clientName, nowIso, clientUserId);
          }

          // 3. Членство на клиента с access_token
          this.db.prepare(`
            INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, client_role, can_view_budget, access_token, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'client', 'client_decision_maker', ?, ?, 'active', ?, ?)
          `).run(crypto.randomUUID(), orgId, eventId, clientUserId, body.canViewBudget ? 1 : 0, clientToken, nowIso, nowIso);

          // 4. Членство на организатора
          this.db.prepare(`
            INSERT OR IGNORE INTO event_memberships (id, org_id, event_id, user_id, member_type, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'staff', 'active', ?, ?)
          `).run(crypto.randomUUID(), orgId, eventId, auth.userId, nowIso, nowIso);
        });

        const clientLink = `${this.getBaseUrl(req)}/?token=${clientToken}`;
        return sendJson(res, 201, {
          success: true,
          eventId,
          clientToken,
          clientLink,
        });
      }

      // Нормализиране на eventId от път /api/events/:eventId/...
      const eventMatch = pathname.match(/^\/api\/(?:orgs\/[^/]+\/)?events\/([^/]+)(.*)$/);
      if (eventMatch) {
        const eventId = eventMatch[1];
        const subPath = eventMatch[2];

        if (!this.policy.canReadEvent(eventId, auth.userId)) {
          return sendError(res, 404, 'NOT_FOUND', 'Събитието не съществува или нямате достъп');
        }

        // Връзка за клиента
        if (subPath === '/client-link' && method === 'GET') {
          let clientMem = this.db.prepare(`
            SELECT access_token FROM event_memberships WHERE event_id = ? AND member_type = 'client' AND status = 'active' LIMIT 1
          `).get(eventId) as { access_token: string } | undefined;

          let token = clientMem?.access_token;
          if (!token) {
            token = `tok_${crypto.randomBytes(16).toString('hex')}`;
            this.db.prepare(`
              UPDATE event_memberships SET access_token = ? WHERE event_id = ? AND member_type = 'client'
            `).run(token, eventId);
          }

          return sendJson(res, 200, {
            token,
            clientLink: `${this.getBaseUrl(req)}/?token=${token}`,
          });
        }

        // Детайли за събитието
        if (subPath === '' && method === 'GET') {
          const event = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(eventId) as any;
          const clientMem = this.db.prepare(`
            SELECT em.access_token, p.display_name, p.email, em.can_view_budget
            FROM event_memberships em
            JOIN profiles p ON p.user_id = em.user_id
            WHERE em.event_id = ? AND em.member_type = 'client' LIMIT 1
          `).get(eventId) as any;

          return sendJson(res, 200, {
            event: {
              ...event,
              clientToken: clientMem?.access_token,
              clientLink: clientMem?.access_token ? `${this.getBaseUrl(req)}/?token=${clientMem.access_token}` : null,
              clientName: clientMem?.display_name,
              clientEmail: clientMem?.email,
              canViewBudget: clientMem?.can_view_budget === 1,
            },
          });
        }

        // Изтриване на събитие (само за Owner)
        if (subPath === '' && method === 'DELETE') {
          if (!this.isOwner(auth)) {
            return sendError(res, 403, 'FORBIDDEN', 'Само потребители с роля Собственик (Owner) могат да изтриват събития');
          }

          const deleted = this.eventService.deleteEvent(eventId, auth.userId);
          for (const objectKey of deleted.objectKeys) {
            try {
              await this.storageAdapter.delete(objectKey);
            } catch (storageErr) {
              console.warn(`[Storage] Неуспешно изтриване на файл ${objectKey}:`, storageErr);
            }
          }

          return sendJson(res, 200, {
            success: true,
            deletedEventId: deleted.deletedEventId,
            title: deleted.title,
            message: 'Събитието е изтрито успешно',
          });
        }

        // Клиентски обзор
        if (subPath === '/overview' && method === 'GET') {
          const overview = this.eventService.getClientOverview(eventId, auth.userId);
          return sendJson(res, 200, overview);
        }

        // Етапи (Milestones)
        if (subPath === '/milestones' && method === 'GET') {
          const milestones = this.isTeamOrOwner(auth)
            ? this.db.prepare(`
                SELECT id, category, title, status, health, next_step, due_date, published_at,
                       CASE WHEN published_at IS NOT NULL THEN 1 ELSE 0 END as is_published
                FROM milestones
                WHERE event_id = ?
                ORDER BY due_date ASC
              `).all(eventId)
            : this.milestoneService.getMilestonesForClient(eventId, auth.userId);

          return sendJson(res, 200, { milestones });
        }

        // Добавяне на етап (Milestone) от организатора
        if (subPath === '/milestones' && method === 'POST') {
          if (!this.isTeamOrOwner(auth)) return sendError(res, 403, 'FORBIDDEN', 'Нямате права да добавяте етапи');
          const body = await parseJsonBody(req);
          const milestoneId = `mls-${crypto.randomUUID().slice(0, 8)}`;
          const nowIso = new Date().toISOString();
          const orgId = auth.orgId || 'org-saza-agency-01';

          this.db.prepare(`
            INSERT INTO milestones (
              id, org_id, event_id, title, category, due_date,
              status, health, next_step, published_at, row_version, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'normal', ?, ?, 1, ?, ?)
          `).run(
            milestoneId,
            orgId,
            eventId,
            body.title,
            body.category || 'Организация',
            body.dueDate || null,
            body.status || 'planned',
            body.nextStep || 'В процес на подготовка',
            body.isPublished ? nowIso : null,
            nowIso,
            nowIso
          );

          return sendJson(res, 201, { success: true, milestoneId });
        }

        // Бюджет
        if (subPath === '/budget' && method === 'GET') {
          if (!this.policy.canReadBudget(eventId, auth.userId)) {
            return sendError(res, 403, 'FORBIDDEN', 'Нямате право да преглеждате бюджетна информация');
          }
          const budget = this.budgetService.getBudgetForClient(eventId, auth.userId);
          const payments = this.paymentService.getPaymentSummary(eventId, auth.userId);

          // Ако е служител/owner, добавяме детайлите за доставчици и вътрешна себестойност
          let internalItems: any[] = [];
          if (this.isTeamOrOwner(auth)) {
            internalItems = this.db.prepare(`
              SELECT bi.id, bi.category, bi.client_description, bi.total_cents,
                     ic.supplier_name, ic.cost_cents as internal_cost_cents, ic.internal_note
              FROM budget_items bi
              LEFT JOIN internal_costs ic ON ic.budget_item_id = bi.id
              WHERE bi.event_id = ?
              ORDER BY bi.sort_order ASC
            `).all(eventId);
          }

          return sendJson(res, 200, { budget, payments, internalItems });
        }

        // Записване на плащане за събитие (капаро / вноска / финално)
        if (subPath === '/payments' && method === 'POST') {
          if (!this.isTeamOrOwner(auth)) {
            return sendError(res, 403, 'FORBIDDEN', 'Само служители могат да записват плащания');
          }
          const body = await parseJsonBody(req);
          const amountCents = Math.round(Number(body.amount || body.amountEUR || 0) * 100) || Number(body.amountCents || 0);
          if (amountCents <= 0) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Сумата на плащането трябва да е по-голяма от 0');
          }

          const result = this.paymentService.recordPayment({
            eventId,
            actorUserId: auth.userId,
            amountCents,
            effectiveDate: body.effectiveDate || new Date().toISOString().slice(0, 10),
            scheduleId: body.scheduleId || null,
            reference: body.reference || body.note || 'Плащане от клиент',
          });

          return sendJson(res, 201, { success: true, paymentId: result.paymentId });
        }

        // Добавяне на ново перо към бюджета на събитието
        if (subPath === '/budget-items' && method === 'POST') {
          if (!this.isTeamOrOwner(auth)) {
            return sendError(res, 403, 'FORBIDDEN', 'Само служители могат да редактират бюджета');
          }
          const body = await parseJsonBody(req);
          const totalCents = Math.round(Number(body.totalEUR || 0) * 100) || Number(body.totalCents || 0);
          const internalCostCents = Math.round(Number(body.supplierCostEUR || 0) * 100) || Number(body.internalCostCents || 0);

          if (!body.category || !body.description) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Категорията и описанието са задължителни');
          }

          // Намираме или създаваме активна бюджетна версия
          let activeVer = this.db.prepare(`
            SELECT id FROM budget_versions WHERE event_id = ? AND state = 'active'
          `).get(eventId) as { id: string } | undefined;

          const nowIso = new Date().toISOString();
          const orgId = auth.orgId || 'org-saza-agency-01';

          if (!activeVer) {
            const versionId = crypto.randomUUID();
            this.db.prepare(`
              INSERT INTO budget_versions (id, org_id, event_id, version_no, state, currency, total_cents, created_at, updated_at)
              VALUES (?, ?, ?, 1, 'active', 'EUR', 0, ?, ?)
            `).run(versionId, orgId, eventId, nowIso, nowIso);
            activeVer = { id: versionId };
          }

          const itemId = crypto.randomUUID();
          this.db.transaction(() => {
            this.db.prepare(`
              INSERT INTO budget_items (id, budget_version_id, org_id, event_id, category, client_description, total_cents, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(itemId, activeVer!.id, orgId, eventId, body.category, body.description, totalCents, nowIso);

            if (internalCostCents > 0 || body.supplierName) {
              this.db.prepare(`
                INSERT INTO internal_costs (id, org_id, event_id, budget_item_id, supplier_name, cost_cents, internal_note, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `).run(crypto.randomUUID(), orgId, eventId, itemId, body.supplierName || 'Подизпълнител', internalCostCents, body.note || null, nowIso);
            }

            const sumRow = this.db.prepare(`
              SELECT COALESCE(SUM(total_cents), 0) as s FROM budget_items WHERE budget_version_id = ?
            `).get(activeVer!.id) as { s: number };
            this.db.prepare(`UPDATE budget_versions SET total_cents = ?, updated_at = ? WHERE id = ?`).run(sumRow.s, nowIso, activeVer!.id);
          });

          return sendJson(res, 201, { success: true, itemId });
        }

        // Добавяне на вноска към графика на плащанията
        if (subPath === '/payment-schedules' && method === 'POST') {
          if (!this.isTeamOrOwner(auth)) {
            return sendError(res, 403, 'FORBIDDEN', 'Само служители могат да добавят вноски');
          }
          const body = await parseJsonBody(req);
          const amountCents = Math.round(Number(body.amountEUR || 0) * 100) || Number(body.amountCents || 0);
          if (!body.label || amountCents <= 0 || !body.dueDate) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Етикет, падежна дата и сума са задължителни');
          }

          const result = this.paymentService.addScheduleItem({
            eventId,
            actorUserId: auth.userId,
            label: body.label,
            amountCents,
            dueDate: body.dueDate,
          });

          return sendJson(res, 201, { success: true, scheduleId: result.scheduleId });
        }

        // Предложения (Proposals)
        if (subPath === '/proposals' && method === 'GET') {
          const proposals = this.db.prepare(`
            SELECT p.id, p.title, p.kind, p.current_version_id, pv.version_no, pv.body_json, pv.requires_budget_permission,
                   ar.id as active_request_id, ar.status as request_status, ar.expires_at, ar.assignee_user_id
            FROM proposals p
            LEFT JOIN proposal_versions pv ON pv.id = p.current_version_id
            LEFT JOIN approval_requests ar ON ar.proposal_id = p.id
            WHERE p.event_id = ?
            ORDER BY p.created_at DESC
          `).all(eventId) as any[];

          const canBudget = this.policy.canReadBudget(eventId, auth.userId);
          const filtered = proposals.map(prop => {
            const options = this.db.prepare(`
              SELECT id, title, description, total_cents, sort_order
              FROM proposal_options
              WHERE proposal_version_id = ?
              ORDER BY sort_order ASC
            `).all(prop.current_version_id) as any[];

            const response = prop.active_request_id ? this.db.prepare(`
              SELECT selected_option_id, decision, comment, decided_at
              FROM approval_responses WHERE request_id = ?
            `).get(prop.active_request_id) as any : null;

            return {
              ...prop,
              options: options.map(opt => ({
                ...opt,
                total_cents: canBudget ? opt.total_cents : null,
              })),
              response,
            };
          });

          return sendJson(res, 200, { proposals: filtered });
        }

        // Създаване на предложение с варианти от организатора (Proposal with Options)
        if (subPath === '/proposals' && method === 'POST') {
          if (!this.isTeamOrOwner(auth)) return sendError(res, 403, 'FORBIDDEN', 'Нямате права да създавате предложения');
          const body = await parseJsonBody(req);
          if (!body.title) return sendError(res, 400, 'VALIDATION_ERROR', 'Заглавието е задължително');

          const propId = `prop-${crypto.randomUUID().slice(0, 8)}`;
          const verId = `propv-${crypto.randomUUID().slice(0, 8)}`;
          const reqId = `req-${crypto.randomUUID().slice(0, 8)}`;
          const orgId = auth.orgId || 'org-saza-agency-01';
          const nowIso = new Date().toISOString();
          const expiresAt = new Date(Date.now() + 14 * 86400000).toISOString();

          // Намираме клиента за събитието
          const clientMem = this.db.prepare(`
            SELECT user_id FROM event_memberships WHERE event_id = ? AND member_type = 'client' LIMIT 1
          `).get(eventId) as { user_id: string } | undefined;

          const assigneeUserId = clientMem?.user_id || auth.userId;

          this.db.transaction(() => {
            this.db.prepare(`
              INSERT INTO proposals (id, org_id, event_id, kind, title, current_version_id, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(propId, orgId, eventId, body.kind || 'general', body.title, verId, nowIso, nowIso);

            this.db.prepare(`
              INSERT INTO proposal_versions (id, proposal_id, org_id, event_id, version_no, body_json, content_hash, state, submitted_at, created_at)
              VALUES (?, ?, ?, ?, 1, ?, 'hash', 'submitted', ?, ?)
            `).run(verId, propId, orgId, eventId, JSON.stringify({ description: body.description || body.title }), nowIso, nowIso);

            const optionsList = Array.isArray(body.options) && body.options.length > 0
              ? body.options
              : [{ title: 'Основен вариант', description: 'Стандартно изпълнение', totalCents: 0 }];

            for (let i = 0; i < optionsList.length; i++) {
              const opt = optionsList[i];
              const optId = `opt-${crypto.randomUUID().slice(0, 8)}`;
              this.db.prepare(`
                INSERT INTO proposal_options (id, proposal_version_id, org_id, event_id, title, description, total_cents, sort_order, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).run(optId, verId, orgId, eventId, opt.title, opt.description || '', opt.totalCents || 0, i + 1, nowIso);
            }

            this.db.prepare(`
              INSERT INTO approval_requests (id, org_id, event_id, proposal_id, proposal_version_id, assignee_user_id, status, expires_at, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
            `).run(reqId, orgId, eventId, propId, verId, assigneeUserId, expiresAt, nowIso, nowIso);
          });

          return sendJson(res, 201, { success: true, proposalId: propId, requestId: reqId });
        }

        // Документи (Documents)
        if (subPath === '/documents' && method === 'GET') {
          const canBudget = this.policy.canReadBudget(eventId, auth.userId);
          const docs = this.db.prepare(`
            SELECT d.id, d.title, d.category, d.audience, d.requires_budget_permission,
                   dv.id as version_id, dv.version_no, dv.original_name, dv.mime_type, dv.byte_size, dv.scan_state, dv.created_at
            FROM documents d
            JOIN document_versions dv ON dv.id = d.current_version_id
            WHERE d.event_id = ? AND dv.scan_state = 'ready'
            ORDER BY d.created_at DESC
          `).all(eventId) as any[];

          const filtered = docs.filter(doc => {
            if (!this.isTeamOrOwner(auth) && doc.audience !== 'client') return false;
            if (!canBudget && doc.requires_budget_permission === 1) return false;
            return true;
          });

          return sendJson(res, 200, { documents: filtered });
        }

        // Качване на документ (Multipart Upload)
        if (subPath === '/documents/upload' && method === 'POST') {
          const parsed = await parseMultipartBody(req, config.storage.maxFileSizeBytes);
          const fileField = parsed.files.file || Object.values(parsed.files)[0];

          if (!fileField) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Не е прикачен файл за качване');
          }

          const title = parsed.fields.title || fileField.filename;
          const category = parsed.fields.category || 'Общи';
          const rawAudience = parsed.fields.audience;
          const audience = rawAudience === 'team' || rawAudience === 'staff_only' ? 'team' : 'client';
          const requiresBudget = parsed.fields.requiresBudgetPermission === 'true' || parsed.fields.requiresBudgetPermission === '1';

          const docRes = this.documentService.uploadDocument({
            eventId,
            actorUserId: auth.userId,
            title,
            category,
            audience,
            requiresBudgetPermission: requiresBudget,
            originalName: fileField.filename,
            mimeType: fileField.mimeType,
            byteSize: fileField.byteSize,
            fileBuffer: fileField.buffer,
          });

          const ver = this.db.prepare(`SELECT object_key FROM document_versions WHERE id = ?`).get(docRes.versionId) as { object_key: string };

          const storageRes = await this.storageAdapter.upload({
            objectKey: ver.object_key,
            buffer: fileField.buffer,
            mimeType: fileField.mimeType,
            originalName: fileField.filename,
          });

          return sendJson(res, 201, {
            success: true,
            documentId: docRes.documentId,
            versionId: docRes.versionId,
            scanState: docRes.scanState,
            objectKey: storageRes.objectKey,
          });
        }
      }

      // ─── 5. Proposals & Approval Decisions ──────────────────────────────
      const respondMatch = pathname.match(/^\/api\/proposals\/([^/]+)\/respond$/);
      if (respondMatch && method === 'POST') {
        const requestId = respondMatch[1];
        const body = await parseJsonBody(req);
        const idempotencyKey = String(
          req.headers['idempotency-key'] || body.idempotencyKey || `idem-${crypto.randomUUID()}`
        );

        const result = this.proposalService.respondToApproval({
          requestId,
          actorUserId: auth.userId,
          decision: body.decision,
          selectedOptionId: body.selectedOptionId,
          comment: body.comment,
          idempotencyKey,
        });

        return sendJson(res, 200, result);
      }

      // ─── 6. Document Download ────────────────────────────────────────────
      const downloadMatch = pathname.match(/^\/api\/documents\/([^/]+)\/download$/);
      if (downloadMatch && method === 'GET') {
        const documentId = downloadMatch[1];

        const check = this.documentService.downloadDocument(documentId, auth.userId);
        if (!check.allowed || !check.document) {
          return sendError(res, 403, 'FORBIDDEN', check.reason || 'Нямате право да изтеглите този файл');
        }

        const doc = check.document;
        const downloadStream = await this.storageAdapter.download(doc.objectKey);

        res.writeHead(200, {
          'Content-Type': doc.mimeType || downloadStream.mimeType,
          'Content-Length': doc.byteSize || downloadStream.byteSize,
          'Content-Disposition': `attachment; filename="${encodeURIComponent(doc.originalName || downloadStream.filename)}"`,
          'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        });

        downloadStream.stream.pipe(res);
        return;
      }

      // ─── 8. Екип и Управление на Акаунти & Профили ──────────────────────
      // GET /api/team — базов списък на екипа на агенцията (достъпен за всички роли от екипа)
      if (pathname === '/api/team' && method === 'GET') {
        if (!this.isTeamOrOwner(auth)) {
          return sendError(res, 403, 'FORBIDDEN', 'Само членове на екипа имат достъп');
        }
        const orgId = auth.orgId || 'org-saza-agency-01';
        const team = this.db.prepare(`
          SELECT p.user_id, p.username, p.display_name, om.role, om.status, p.created_at
          FROM organization_memberships om
          JOIN profiles p ON p.user_id = om.user_id
          WHERE om.org_id = ?
          ORDER BY
            CASE om.role WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 WHEN 'coordinator' THEN 3 ELSE 4 END,
            p.created_at ASC
        `).all(orgId) as any[];

        return sendJson(res, 200, {
          users: team.map((u: any) => ({
            userId: u.user_id,
            username: u.username,
            displayName: u.display_name,
            role: u.role,
            status: u.status,
            createdAt: u.created_at,
          })),
        });
      }

      // GET /api/admin/users — пълен списък с всички профили: екип + клиенти (само за Owner)
      if (pathname === '/api/admin/users' && method === 'GET') {
        if (auth.role !== 'owner') {
          return sendError(res, 403, 'FORBIDDEN', 'Само собственици могат да управляват акаунтите');
        }
        const orgId = auth.orgId || 'org-saza-agency-01';

        const staffRows = this.db.prepare(`
          SELECT p.user_id, p.username, p.display_name, p.email, p.created_at, p.updated_at,
                 p.password_hash, om.role, om.status
          FROM profiles p
          LEFT JOIN organization_memberships om ON om.user_id = p.user_id AND om.org_id = ?
          WHERE p.username IS NOT NULL OR om.id IS NOT NULL
          ORDER BY
            CASE COALESCE(om.role, 'coordinator') WHEN 'owner' THEN 1 WHEN 'manager' THEN 2 WHEN 'coordinator' THEN 3 ELSE 4 END,
            p.created_at ASC
        `).all(orgId) as any[];

        const clientRows = this.db.prepare(`
          SELECT p.user_id, p.display_name, p.email, p.created_at,
                 em.event_id, em.client_role, em.can_view_budget, em.status, em.access_token,
                 e.title as event_title
          FROM event_memberships em
          JOIN profiles p ON p.user_id = em.user_id
          JOIN events e ON e.id = em.event_id
          WHERE em.org_id = ? AND em.member_type = 'client'
          ORDER BY p.created_at DESC
        `).all(orgId) as any[];

        return sendJson(res, 200, {
          users: staffRows.map((u: any) => ({
            userId: u.user_id,
            username: u.username || u.display_name,
            displayName: u.display_name,
            email: u.email,
            role: u.role || 'coordinator',
            status: (u.password_hash === 'DISABLED' || u.status === 'revoked') ? 'revoked' : (u.status || 'active'),
            isActive: u.status === 'active' && !!u.password_hash && u.password_hash !== 'DISABLED',
            createdAt: u.created_at,
          })),
          clients: clientRows.map((c: any) => ({
            userId: c.user_id,
            displayName: c.display_name,
            email: c.email,
            eventId: c.event_id,
            eventTitle: c.event_title,
            clientRole: c.client_role,
            canViewBudget: c.can_view_budget === 1,
            status: c.status,
            clientLink: c.access_token ? `${this.getBaseUrl(req)}/?token=${c.access_token}` : null,
            createdAt: c.created_at,
          })),
        });
      }

      // POST /api/admin/users — създаване на нов акаунт (само за Owner)
      if (pathname === '/api/admin/users' && method === 'POST') {
        if (auth.role !== 'owner') {
          return sendError(res, 403, 'FORBIDDEN', 'Само собственици могат да създават акаунти');
        }
        const body = await parseJsonBody(req);
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const displayName = String(body.displayName || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const role = String(body.role || '').trim();

        if (!username || !password || !displayName || !email) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Потребителско име, парола, пълно име и имейл са задължителни');
        }
        if (!['owner', 'manager', 'coordinator'].includes(role)) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Невалидна роля. Разрешени: owner, manager, coordinator');
        }
        if (password.length < 6) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Паролата трябва да е поне 6 символа');
        }

        // Проверка за уникалност на username и email
        const existingUser = this.db.prepare(`SELECT user_id FROM profiles WHERE LOWER(username) = LOWER(?)`).get(username) as any;
        if (existingUser) {
          return sendError(res, 409, 'CONFLICT', `Потребителско име "${username}" вече съществува`);
        }
        const existingEmail = this.db.prepare(`SELECT user_id FROM profiles WHERE LOWER(email) = LOWER(?)`).get(email) as any;
        if (existingEmail) {
          return sendError(res, 409, 'CONFLICT', `Имейл "${email}" вече се използва от друг профил`);
        }

        const slug = username.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'user';
        const userId = `usr-${slug}-${crypto.randomUUID().slice(0, 8)}`;
        const { hash, salt } = hashPassword(password);
        const nowIso = new Date().toISOString();
        const orgId = auth.orgId || 'org-saza-agency-01';

        this.db.transaction(() => {
          this.db.prepare(`
            INSERT INTO profiles (user_id, username, display_name, email, locale, timezone, created_at, updated_at, password_hash, password_salt)
            VALUES (?, ?, ?, ?, 'bg', 'Europe/Sofia', ?, ?, ?, ?)
          `).run(userId, username, displayName, email, nowIso, nowIso, hash, salt);

          this.db.prepare(`
            INSERT INTO organization_memberships (id, org_id, user_id, role, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'active', ?, ?)
          `).run(crypto.randomUUID(), orgId, userId, role, nowIso, nowIso);
        });

        return sendJson(res, 201, {
          success: true,
          userId,
          username,
          displayName,
          email,
          role,
        });
      }

      // PATCH /api/admin/users/:userId — промяна на роля, парола, статус или данни (само за Owner)
      const adminPatchMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminPatchMatch && method === 'PATCH') {
        if (auth.role !== 'owner') {
          return sendError(res, 403, 'FORBIDDEN', 'Само собственици могат да редактират акаунти');
        }
        const targetUserId = decodeURIComponent(adminPatchMatch[1]);
        const targetProfile = this.db.prepare(`SELECT user_id, email, password_hash FROM profiles WHERE user_id = ?`).get(targetUserId) as any;
        if (!targetProfile) {
          return sendError(res, 404, 'NOT_FOUND', 'Потребителят не е намерен');
        }

        const body = await parseJsonBody(req);
        const nowIso = new Date().toISOString();
        const orgId = auth.orgId || 'org-saza-agency-01';

        if (body.role !== undefined) {
          if (!['owner', 'manager', 'coordinator'].includes(body.role)) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Невалидна роля. Разрешени: owner, manager, coordinator');
          }
          // Предотвратяване на понижаване на последния активен Owner
          if (body.role !== 'owner') {
            const activeOwners = this.db.prepare(`
              SELECT user_id FROM organization_memberships WHERE org_id = ? AND role = 'owner' AND status = 'active'
            `).all(orgId) as { user_id: string }[];
            if (activeOwners.length === 1 && activeOwners[0].user_id === targetUserId) {
              return sendError(res, 400, 'VALIDATION_ERROR', 'Трябва да има поне един активен собственик (Owner) в агенцията');
            }
          }
        }

        if (body.status !== undefined) {
          if (!['active', 'suspended', 'revoked'].includes(body.status)) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Невалиден статус');
          }
          if (targetUserId === auth.userId && body.status !== 'active') {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Не можете да деактивирате собствения си акаунт');
          }
          if (body.status === 'active' && targetProfile.password_hash === 'DISABLED' && !body.password) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'За повторно активиране въведете нова парола (поне 6 символа)');
          }
        }

        if (body.password !== undefined && body.password !== '') {
          if (String(body.password).length < 6) {
            return sendError(res, 400, 'VALIDATION_ERROR', 'Паролата трябва да е поне 6 символа');
          }
        }

        if (body.email !== undefined && String(body.email).trim()) {
          const cleanEmail = String(body.email).trim().toLowerCase();
          const emailConflict = this.db.prepare(`SELECT user_id FROM profiles WHERE LOWER(email) = LOWER(?) AND user_id != ?`).get(cleanEmail, targetUserId) as any;
          if (emailConflict) {
            return sendError(res, 409, 'CONFLICT', `Имейл "${cleanEmail}" вече се използва от друг профил`);
          }
        }

        this.db.transaction(() => {
          const hasOrg = this.db.prepare(`SELECT id, role, status FROM organization_memberships WHERE org_id = ? AND user_id = ?`).get(orgId, targetUserId) as any;

          if (body.role || body.status) {
            const newRole = body.role || hasOrg?.role || 'coordinator';
            const newStatus = body.status || hasOrg?.status || 'active';
            if (hasOrg) {
              this.db.prepare(`UPDATE organization_memberships SET role = ?, status = ?, updated_at = ? WHERE org_id = ? AND user_id = ?`)
                .run(newRole, newStatus, nowIso, orgId, targetUserId);
            } else {
              this.db.prepare(`INSERT INTO organization_memberships (id, org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
                .run(crypto.randomUUID(), orgId, targetUserId, newRole, newStatus, nowIso, nowIso);
            }
          }

          if (body.displayName && String(body.displayName).trim()) {
            this.db.prepare(`UPDATE profiles SET display_name = ?, updated_at = ? WHERE user_id = ?`)
              .run(String(body.displayName).trim(), nowIso, targetUserId);
          }

          if (body.email && String(body.email).trim()) {
            this.db.prepare(`UPDATE profiles SET email = ?, updated_at = ? WHERE user_id = ?`)
              .run(String(body.email).trim().toLowerCase(), nowIso, targetUserId);
          }

          if (body.password && String(body.password).length >= 6) {
            const { hash, salt } = hashPassword(String(body.password));
            this.db.prepare(`UPDATE profiles SET password_hash = ?, password_salt = ?, updated_at = ? WHERE user_id = ?`)
              .run(hash, salt, nowIso, targetUserId);
          } else {
            this.db.prepare(`UPDATE profiles SET updated_at = ? WHERE user_id = ?`).run(nowIso, targetUserId);
          }
        });

        return sendJson(res, 200, { success: true, message: 'Акаунтът е обновен успешно' });
      }

      // DELETE /api/admin/users/:userId — деактивиране на акаунт (само за Owner)
      const adminDelMatch = pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
      if (adminDelMatch && method === 'DELETE') {
        if (auth.role !== 'owner') {
          return sendError(res, 403, 'FORBIDDEN', 'Само собственици могат да деактивират акаунти');
        }
        const targetUserId = decodeURIComponent(adminDelMatch[1]);

        if (targetUserId === auth.userId) {
          return sendError(res, 400, 'VALIDATION_ERROR', 'Не можете да деактивирате собствения си акаунт');
        }

        const targetProfile = this.db.prepare(`SELECT user_id FROM profiles WHERE user_id = ?`).get(targetUserId) as any;
        if (!targetProfile) {
          return sendError(res, 404, 'NOT_FOUND', 'Потребителят не е намерен');
        }

        const nowIso = new Date().toISOString();
        const orgId = auth.orgId || 'org-saza-agency-01';

        this.db.transaction(() => {
          this.db.prepare(`UPDATE organization_memberships SET status = 'revoked', updated_at = ? WHERE org_id = ? AND user_id = ?`)
            .run(nowIso, orgId, targetUserId);
          this.db.prepare(`UPDATE profiles SET password_hash = 'DISABLED', password_salt = 'DISABLED', updated_at = ? WHERE user_id = ?`)
            .run(nowIso, targetUserId);
        });

        return sendJson(res, 200, { success: true, message: 'Акаунтът е деактивиран' });
      }

      return sendError(res, 404, 'NOT_FOUND', `API маршрутът ${method} ${pathname} не е намерен`);
    } catch (err: any) {
      console.error(`[API Error] ${method} ${pathname}:`, err);
      const msg = String(err?.message || '');
      const isConflict = msg.includes('409') || msg.includes('Конфликт');
      const isForbidden = msg.includes('Отказ') || msg.includes('Нямате права') || msg.includes('Само Owner') || msg.includes('Само потребители');
      const isNotFound = msg.includes('не е намерен') || msg.includes('не съществува');
      const isBadRequest = msg.includes('Request has expired')
        || msg.includes('Невалиден JSON')
        || msg.includes('Непозволен файлов тип')
        || msg.includes('надвишава')
        || msg.includes('трябва да')
        || msg.includes('задължителен')
        || msg.includes('не принадлежи')
        || msg.includes('multipart boundary');
      const statusCode = isConflict ? 409 : isForbidden ? 403 : isNotFound ? 404 : isBadRequest ? 400 : 500;
      const code = statusCode === 409 ? 'CONFLICT' : statusCode === 403 ? 'FORBIDDEN' : statusCode === 404 ? 'NOT_FOUND' : statusCode === 400 ? 'VALIDATION_ERROR' : 'INTERNAL_ERROR';
      return sendError(res, statusCode, code, msg || 'Възникна вътрешна грешка');
    }
  }
}
