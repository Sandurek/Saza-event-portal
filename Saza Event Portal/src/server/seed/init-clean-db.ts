// src/server/seed/init-clean-db.ts
// Инициализира напълно чиста база данни с единствен акаунт на Sando и 0 събития

import { config } from '../config/env.ts';
import { Database, hashPassword } from '../db/database.ts';

export function resetToCleanDatabase(db: Database) {
  const nowIso = new Date().toISOString();
  const { hash, salt } = hashPassword('Sandoelud4');

  return db.transaction(() => {
    // 1. Изчистване на всички стари данни
    const tables = [
      'audit_events',
      'idempotency_keys',
      'notification_outbox',
      'job_runs',
      'thread_messages',
      'communication_threads',
      'document_versions',
      'documents',
      'payment_reversals',
      'payments',
      'payment_schedules',
      'budget_items',
      'budget_versions',
      'approval_responses',
      'approval_requests',
      'proposal_options',
      'proposal_versions',
      'proposals',
      'milestone_status_history',
      'milestone_versions',
      'milestones',
      'template_versions',
      'event_templates',
      'invitations',
      'event_memberships',
      'events',
      'organization_memberships',
      'profiles',
      'organizations'
    ];

    for (const t of tables) {
      try {
        db.exec(`DELETE FROM ${t};`);
      } catch {}
    }

    // 2. Създаване на единствената агенция (Saza Events)
    const orgId = 'org-saza-agency-01';
    db.prepare(`
      INSERT INTO organizations (id, name, brand_settings, timezone, created_at)
      VALUES (?, ?, ?, 'Europe/Sofia', ?)
    `).run(
      orgId,
      'Агенция за събития Saza',
      JSON.stringify({ agencyName: 'Saza Events', primaryColor: '#2563eb' }),
      nowIso
    );

    // 3. Създаване на администраторския акаунт за Sando
    const userId = 'usr-sando-owner';
    db.prepare(`
      INSERT INTO profiles (
        user_id, username, password_hash, password_salt,
        display_name, email, locale, timezone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'bg', 'Europe/Sofia', ?, ?)
    `).run(
      userId,
      'Sando',
      hash,
      salt,
      'Sando',
      'sando@sazaevents.com',
      nowIso,
      nowIso
    );

    // 4. Членство като Owner на агенцията
    db.prepare(`
      INSERT INTO organization_memberships (
        id, org_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 'active', ?, ?)
    `).run(
      'mem-sando-owner',
      orgId,
      userId,
      nowIso,
      nowIso
    );

    // 5. Втори администраторски акаунт за ZMoskov
    const zmoskovPass = hashPassword('Zahomidata69');
    const zmoskovUserId = 'usr-zmoskov-owner';
    db.prepare(`
      INSERT INTO profiles (
        user_id, username, password_hash, password_salt,
        display_name, email, locale, timezone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'bg', 'Europe/Sofia', ?, ?)
    `).run(
      zmoskovUserId,
      'ZMoskov',
      zmoskovPass.hash,
      zmoskovPass.salt,
      'ZMoskov',
      'zmoskov@sazaevents.com',
      nowIso,
      nowIso
    );

    db.prepare(`
      INSERT INTO organization_memberships (
        id, org_id, user_id, role, status, created_at, updated_at
      ) VALUES (?, ?, ?, 'owner', 'active', ?, ?)
    `).run(
      'mem-zmoskov-owner',
      orgId,
      zmoskovUserId,
      nowIso,
      nowIso
    );

    return {
      orgId,
      userId,
      username: 'Sando',
    };
  });
}

// Ако се стартира директно от CLI
const isDirectRun = process.argv[1]?.includes('init-clean-db');
if (isDirectRun) {
  const db = new Database(config.db.path);
  resetToCleanDatabase(db);
  console.log('========================================================');
  console.log('✅ Базата данни е напълно нулирана (Празен сайт)!');
  console.log('👤 Потребителско име: Sando');
  console.log('🔑 Парола:            Sandoelud4');
  console.log('📅 Създадени събития: 0 (празен списък)');
  console.log('========================================================');
}
