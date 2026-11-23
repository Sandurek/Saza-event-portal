// src/server/db/database.ts
// Релационна база данни, базирана на вградения node:sqlite в Node.js 24
// Поддържа транзакции, външни ключове, индекси и пълния модел от раздел 14

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

export function hashPassword(password: string, salt?: string): { hash: string; salt: string } {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, actualSalt, 64).toString('hex');
  return { hash, salt: actualSalt };
}

export function verifyPassword(password: string, hash: string, salt: string): boolean {
  try {
    const calculated = crypto.scryptSync(password, salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(calculated, 'hex'));
  } catch {
    return false;
  }
}

export class Database {
  private db: DatabaseSync;

  constructor(dbPath: string = ':memory:') {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new DatabaseSync(dbPath);
    this.initPragmas();
    this.initSchema();
  }

  private initPragmas() {
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA journal_mode = WAL;');
  }

  private initSchema() {
    this.db.exec(`
      -- Organizations
      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        brand_settings TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
        created_at TEXT NOT NULL
      );

      -- Profiles
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY,
        username TEXT UNIQUE,
        password_hash TEXT,
        password_salt TEXT,
        display_name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        locale TEXT NOT NULL DEFAULT 'bg',
        timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Organization Memberships
      CREATE TABLE IF NOT EXISTS organization_memberships (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'coordinator')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, user_id)
      );

      -- Events
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('corporate', 'wedding', 'personal', 'other')),
        starts_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
        venue_label TEXT,
        lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'planning', 'ready', 'completed', 'cancelled', 'archived')),
        primary_coordinator_id TEXT REFERENCES profiles(user_id) ON DELETE SET NULL,
        archived_at TEXT,
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, id)
      );

      -- Event Memberships
      CREATE TABLE IF NOT EXISTS event_memberships (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
        member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'client')),
        client_role TEXT CHECK (client_role IS NULL OR client_role IN ('client_decision_maker', 'client_viewer')),
        can_view_budget INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
        access_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (event_id, user_id),
        FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
      );

      -- Invitations
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('staff', 'client')),
        event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        normalized_email TEXT NOT NULL,
        intended_role TEXT NOT NULL CHECK (intended_role IN ('owner', 'manager', 'coordinator', 'client_decision_maker', 'client_viewer')),
        budget_permission INTEGER NOT NULL DEFAULT 0,
        token_hash TEXT NOT NULL UNIQUE,
        expires_at TEXT NOT NULL,
        accepted_at TEXT,
        revoked_at TEXT,
        invited_by TEXT NOT NULL REFERENCES profiles(user_id),
        created_at TEXT NOT NULL
      );

      -- Event Templates
      CREATE TABLE IF NOT EXISTS event_templates (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('corporate', 'wedding', 'personal', 'other')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        current_version_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Template Versions
      CREATE TABLE IF NOT EXISTS template_versions (
        id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL REFERENCES event_templates(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        schema_version INTEGER NOT NULL DEFAULT 1,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (template_id, version_no)
      );

      -- Milestones
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        assigned_to TEXT REFERENCES profiles(user_id) ON DELETE SET NULL,
        due_date TEXT,
        timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
        is_required INTEGER NOT NULL DEFAULT 1,
        criticality TEXT NOT NULL DEFAULT 'medium' CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
        is_relative INTEGER NOT NULL DEFAULT 0,
        offset_days INTEGER,
        status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'awaiting_client', 'confirmed', 'not_applicable')),
        health TEXT NOT NULL DEFAULT 'normal' CHECK (health IN ('normal', 'at_risk', 'delayed')),
        next_step TEXT,
        completion_rule TEXT,
        published_at TEXT,
        last_verified_at TEXT,
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Milestone Drafts
      CREATE TABLE IF NOT EXISTS milestone_drafts (
        id TEXT PRIMARY KEY,
        milestone_id TEXT NOT NULL UNIQUE REFERENCES milestones(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        draft_json TEXT NOT NULL,
        edited_by TEXT NOT NULL REFERENCES profiles(user_id),
        row_version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      -- Tasks (Internal only)
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
        title TEXT NOT NULL,
        internal_description TEXT,
        assignee_id TEXT REFERENCES profiles(user_id) ON DELETE SET NULL,
        due_at TEXT,
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
        priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        blocked_reason TEXT,
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Task Dependencies
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        UNIQUE (task_id, depends_on_task_id)
      );

      -- Published Updates
      CREATE TABLE IF NOT EXISTS published_updates (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
        sequence_no INTEGER NOT NULL,
        public_text TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        published_by TEXT NOT NULL REFERENCES profiles(user_id),
        published_at TEXT NOT NULL,
        requires_budget_permission INTEGER NOT NULL DEFAULT 0,
        UNIQUE (event_id, sequence_no)
      );

      -- Change Requests
      CREATE TABLE IF NOT EXISTS change_requests (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
        requested_by TEXT NOT NULL REFERENCES profiles(user_id),
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'approved', 'declined')),
        proposed_impact TEXT,
        linked_proposal_id TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Proposals
      CREATE TABLE IF NOT EXISTS proposals (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        milestone_id TEXT REFERENCES milestones(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK (kind IN ('general', 'option_selection', 'budget')),
        title TEXT NOT NULL,
        current_version_id TEXT,
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Proposal Versions
      CREATE TABLE IF NOT EXISTS proposal_versions (
        id TEXT PRIMARY KEY,
        proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        body_json TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'submitted', 'superseded')),
        requires_budget_permission INTEGER NOT NULL DEFAULT 0,
        budget_version_id TEXT,
        submitted_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (proposal_id, version_no)
      );

      -- Proposal Options
      CREATE TABLE IF NOT EXISTS proposal_options (
        id TEXT PRIMARY KEY,
        proposal_version_id TEXT NOT NULL REFERENCES proposal_versions(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        total_cents INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      -- Approval Requests
      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        proposal_id TEXT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
        proposal_version_id TEXT NOT NULL REFERENCES proposal_versions(id) ON DELETE CASCADE,
        assignee_user_id TEXT NOT NULL REFERENCES profiles(user_id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested', 'expired', 'withdrawn', 'superseded')),
        expires_at TEXT NOT NULL,
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Approval Responses
      CREATE TABLE IF NOT EXISTS approval_responses (
        id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE REFERENCES approval_requests(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL REFERENCES profiles(user_id),
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
        selected_option_id TEXT REFERENCES proposal_options(id) ON DELETE SET NULL,
        comment TEXT,
        decided_at TEXT NOT NULL,
        request_hash TEXT NOT NULL
      );

      -- Budget Versions
      CREATE TABLE IF NOT EXISTS budget_versions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'proposed', 'active', 'superseded')),
        currency TEXT NOT NULL DEFAULT 'EUR',
        total_cents INTEGER NOT NULL DEFAULT 0,
        base_version_id TEXT,
        approved_response_id TEXT REFERENCES approval_responses(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (event_id, version_no)
      );

      -- Budget Items
      CREATE TABLE IF NOT EXISTS budget_items (
        id TEXT PRIMARY KEY,
        budget_version_id TEXT NOT NULL REFERENCES budget_versions(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        category TEXT NOT NULL,
        client_description TEXT NOT NULL,
        total_cents INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      -- Internal Costs (Hidden from client)
      CREATE TABLE IF NOT EXISTS internal_costs (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        budget_item_id TEXT REFERENCES budget_items(id) ON DELETE SET NULL,
        supplier_name TEXT NOT NULL,
        cost_cents INTEGER NOT NULL,
        internal_note TEXT,
        created_at TEXT NOT NULL
      );

      -- Payment Schedules
      CREATE TABLE IF NOT EXISTS payment_schedules (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        label TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        due_date TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'partial', 'paid', 'overdue')),
        row_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Payment Entries
      CREATE TABLE IF NOT EXISTS payment_entries (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        schedule_id TEXT REFERENCES payment_schedules(id) ON DELETE SET NULL,
        signed_amount_cents INTEGER NOT NULL,
        effective_date TEXT NOT NULL,
        reference TEXT,
        reversal_of_id TEXT REFERENCES payment_entries(id),
        recorded_by TEXT NOT NULL REFERENCES profiles(user_id),
        created_at TEXT NOT NULL
      );

      -- Documents
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        audience TEXT NOT NULL DEFAULT 'client' CHECK (audience IN ('team', 'client')),
        requires_budget_permission INTEGER NOT NULL DEFAULT 0,
        current_version_id TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Document Versions
      CREATE TABLE IF NOT EXISTS document_versions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        object_key TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        scan_state TEXT NOT NULL DEFAULT 'quarantined' CHECK (scan_state IN ('uploading', 'quarantined', 'ready', 'rejected', 'deleted')),
        uploaded_by TEXT NOT NULL REFERENCES profiles(user_id),
        created_at TEXT NOT NULL,
        UNIQUE (document_id, version_no)
      );

      -- Proposal Attachments
      CREATE TABLE IF NOT EXISTS proposal_attachments (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        proposal_version_id TEXT NOT NULL REFERENCES proposal_versions(id) ON DELETE CASCADE,
        document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        UNIQUE (proposal_version_id, document_version_id)
      );

      -- Threads
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        milestone_id TEXT REFERENCES milestones(id) ON DELETE CASCADE,
        proposal_version_id TEXT REFERENCES proposal_versions(id) ON DELETE CASCADE,
        document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
        audience TEXT NOT NULL DEFAULT 'client' CHECK (audience IN ('team', 'client')),
        requires_budget_permission INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      -- Comments
      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        author_id TEXT NOT NULL REFERENCES profiles(user_id),
        body TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL
      );

      -- Comment Revisions
      CREATE TABLE IF NOT EXISTS comment_revisions (
        id TEXT PRIMARY KEY,
        comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
        org_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        previous_body TEXT NOT NULL,
        changed_by TEXT NOT NULL REFERENCES profiles(user_id),
        reason TEXT,
        created_at TEXT NOT NULL
      );

      -- Notifications
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        safe_payload TEXT NOT NULL,
        read_at TEXT,
        created_at TEXT NOT NULL
      );

      -- Notification Preferences
      CREATE TABLE IF NOT EXISTS notification_preferences (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        progress_mode TEXT NOT NULL DEFAULT 'immediate_decisions_daily_digest',
        digest_local_time TEXT NOT NULL DEFAULT '18:00',
        timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
        updated_at TEXT NOT NULL,
        UNIQUE (user_id, org_id)
      );

      -- Notification Outbox
      CREATE TABLE IF NOT EXISTS notification_outbox (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id) ON DELETE CASCADE,
        recipient_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
        channel TEXT NOT NULL DEFAULT 'email',
        type TEXT NOT NULL,
        source_id TEXT,
        dedupe_key TEXT NOT NULL UNIQUE,
        payload TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'sent', 'retry', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        provider_message_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- Audit Log (Append only)
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
        actor_id TEXT REFERENCES profiles(user_id) ON DELETE SET NULL,
        actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        safe_diff TEXT,
        correlation_id TEXT,
        created_at TEXT NOT NULL
      );

      -- Idempotency Keys
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        actor_id TEXT NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
        operation TEXT NOT NULL,
        key TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_snapshot TEXT,
        state TEXT NOT NULL DEFAULT 'processing' CHECK (state IN ('processing', 'completed', 'failed')),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (org_id, actor_id, operation, key)
      );

      -- Job Runs
      CREATE TABLE IF NOT EXISTS job_runs (
        id TEXT PRIMARY KEY,
        job_name TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        scheduled_for TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed')),
        attempt INTEGER NOT NULL DEFAULT 1,
        started_at TEXT,
        finished_at TEXT,
        error_code TEXT,
        created_at TEXT NOT NULL,
        UNIQUE (job_name, scope_key, scheduled_for)
      );
    `);

    // Безопасни миграции за съществуващи таблици
    const safeAlter = (query: string) => {
      try {
        this.db.exec(query);
      } catch {}
    };

    safeAlter('ALTER TABLE profiles ADD COLUMN username TEXT;');
    safeAlter('ALTER TABLE profiles ADD COLUMN password_hash TEXT;');
    safeAlter('ALTER TABLE profiles ADD COLUMN password_salt TEXT;');
    safeAlter('ALTER TABLE event_memberships ADD COLUMN access_token TEXT;');
  }

  public prepare(sql: string) {
    return this.db.prepare(sql);
  }

  public exec(sql: string) {
    return this.db.exec(sql);
  }

  public transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE TRANSACTION;');
    try {
      const result = fn();
      this.db.exec('COMMIT;');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  public close() {
    this.db.close();
  }
}
