// src/server/seed/seed-data.ts
// Повторяеми синтетични данни според раздел 24 от техническото задание

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';

export const SEED_TIME_ISO = '2026-10-12T10:00:00.000Z';
export const SECRET_MARKER = 'SECRET_INTERNAL_NOTE_MARKER_999';

export interface SeedResult {
  orgA: { id: string; name: string };
  orgB: { id: string; name: string };
  users: {
    owner: { id: string; email: string };
    manager: { id: string; email: string };
    coordinator: { id: string; email: string };
    clientA: { id: string; email: string };
    clientB: { id: string; email: string };
    clientViewer: { id: string; email: string };
    userOrgB: { id: string; email: string };
  };
  events: {
    weddingA: { id: string; title: string };
    corporateA: { id: string; title: string };
    cancelledA: { id: string; title: string };
    eventB: { id: string; title: string };
  };
  proposals: {
    weddingMenu: { id: string; v1Id: string; v2Id: string; requestId: string };
  };
  budgets: {
    weddingActive5000: { id: string; totalCents: number };
    weddingProposed5300: { id: string; totalCents: number };
  };
}

export function seedDatabase(db: Database): SeedResult {
  const seedDate = new Date(SEED_TIME_ISO);

  // Изчисляване на дати спрямо фиксираното контролирано seed време
  const addDays = (d: Date, days: number): string => {
    const res = new Date(d);
    res.setDate(res.getDate() + days);
    return res.toISOString();
  };

  const weddingStartsAt = addDays(seedDate, 45); // след 45 дни
  const weddingEndsAt = addDays(seedDate, 45);
  const corporateStartsAt = addDays(seedDate, 14); // след 14 дни
  const corporateEndsAt = addDays(seedDate, 14);
  const cancelledStartsAt = addDays(seedDate, -10); // преди 10 дни (отменено)
  const cancelledEndsAt = addDays(seedDate, -9);
  const eventBStartsAt = addDays(seedDate, 30);
  const eventBEndsAt = addDays(seedDate, 30);

  return db.transaction(() => {
    // 1. Организации
    const orgAId = 'org-a-1111-1111-1111-111111111111';
    const orgBId = 'org-b-2222-2222-2222-222222222222';

    db.prepare(`
      INSERT INTO organizations (id, name, brand_settings, timezone, created_at)
      VALUES (?, ?, ?, 'Europe/Sofia', ?)
    `).run(orgAId, 'Агенция за събития Saza', JSON.stringify({ agencyName: 'Saza Events', primaryColor: '#2563eb' }), SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO organizations (id, name, brand_settings, timezone, created_at)
      VALUES (?, ?, ?, 'Europe/Sofia', ?)
    `).run(orgBId, 'Агенция Премиум B', JSON.stringify({ agencyName: 'Premium B', primaryColor: '#059669' }), SEED_TIME_ISO);

    // 2. Профили
    const profiles = [
      { id: 'usr-owner-111', email: 'owner@example.test', name: 'Александър Собственик (Owner)' },
      { id: 'usr-manager-222', email: 'manager@example.test', name: 'Мария Мениджър (Manager)' },
      { id: 'usr-coord-333', email: 'coordinator@example.test', name: 'Константин Координатор' },
      { id: 'usr-client-a-444', email: 'client_a@example.test', name: 'Елена Клиент А (Сватба)' },
      { id: 'usr-client-b-555', email: 'client_b@example.test', name: 'Борис Клиент Б (Корпоративно)' },
      { id: 'usr-viewer-666', email: 'client_viewer@example.test', name: 'Виктория Наблюдател (Viewer)' },
      { id: 'usr-org-b-777', email: 'user_org_b@example.test', name: 'Георги от Орг Б' }
    ];

    for (const p of profiles) {
      db.prepare(`
        INSERT INTO profiles (user_id, display_name, email, locale, timezone, created_at, updated_at)
        VALUES (?, ?, ?, 'bg', 'Europe/Sofia', ?, ?)
      `).run(p.id, p.name, p.email, SEED_TIME_ISO, SEED_TIME_ISO);
    }

    // 3. Организационни членства (Staff)
    db.prepare(`INSERT INTO organization_memberships (id, org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)`).run(crypto.randomUUID(), orgAId, 'usr-owner-111', SEED_TIME_ISO, SEED_TIME_ISO);
    db.prepare(`INSERT INTO organization_memberships (id, org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'manager', 'active', ?, ?)`).run(crypto.randomUUID(), orgAId, 'usr-manager-222', SEED_TIME_ISO, SEED_TIME_ISO);
    db.prepare(`INSERT INTO organization_memberships (id, org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'coordinator', 'active', ?, ?)`).run(crypto.randomUUID(), orgAId, 'usr-coord-333', SEED_TIME_ISO, SEED_TIME_ISO);
    db.prepare(`INSERT INTO organization_memberships (id, org_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'active', ?, ?)`).run(crypto.randomUUID(), orgBId, 'usr-org-b-777', SEED_TIME_ISO, SEED_TIME_ISO); // в Орг Б

    // 4. Събития
    const weddingId = 'evt-wedding-aaa-01';
    const corporateId = 'evt-corp-aaa-02';
    const cancelledId = 'evt-personal-aaa-03';
    const eventBId = 'evt-premium-bbb-04';

    db.prepare(`
      INSERT INTO events (id, org_id, title, event_type, starts_at, ends_at, timezone, venue_label, lifecycle, primary_coordinator_id, created_at, updated_at)
      VALUES (?, ?, 'Сватбено тържество на Елена и Виктор', 'wedding', ?, ?, 'Europe/Sofia', 'Резиденция Тера', 'planning', 'usr-coord-333', ?, ?)
    `).run(weddingId, orgAId, weddingStartsAt, weddingEndsAt, SEED_TIME_ISO, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO events (id, org_id, title, event_type, starts_at, ends_at, timezone, venue_label, lifecycle, primary_coordinator_id, created_at, updated_at)
      VALUES (?, ?, 'Годишна корпоративна конференция 2026', 'corporate', ?, ?, 'Europe/Sofia', 'Гранд Хотел София', 'planning', 'usr-coord-333', ?, ?)
    `).run(corporateId, orgAId, corporateStartsAt, corporateEndsAt, SEED_TIME_ISO, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO events (id, org_id, title, event_type, starts_at, ends_at, timezone, venue_label, lifecycle, primary_coordinator_id, created_at, updated_at)
      VALUES (?, ?, 'Юбилей 50 години (Отменен)', 'personal', ?, ?, 'Europe/Sofia', 'Ресторант Панорама', 'cancelled', 'usr-coord-333', ?, ?)
    `).run(cancelledId, orgAId, cancelledStartsAt, cancelledEndsAt, SEED_TIME_ISO, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO events (id, org_id, title, event_type, starts_at, ends_at, timezone, venue_label, lifecycle, primary_coordinator_id, created_at, updated_at)
      VALUES (?, ?, 'Лятно гала събитие Организация Б', 'corporate', ?, ?, 'Europe/Sofia', 'Варна Палас', 'planning', 'usr-org-b-777', ?, ?)
    `).run(eventBId, orgBId, eventBStartsAt, eventBEndsAt, SEED_TIME_ISO, SEED_TIME_ISO);

    // 5. Членства в събития
    // Екип
    db.prepare(`INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, status, created_at, updated_at) VALUES (?, ?, ?, 'usr-coord-333', 'staff', 'active', ?, ?)`).run(crypto.randomUUID(), orgAId, weddingId, SEED_TIME_ISO, SEED_TIME_ISO);
    db.prepare(`INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, status, created_at, updated_at) VALUES (?, ?, ?, 'usr-coord-333', 'staff', 'active', ?, ?)`).run(crypto.randomUUID(), orgAId, corporateId, SEED_TIME_ISO, SEED_TIME_ISO);

    // Клиенти
    // Клиент А: сватба, client_decision_maker, can_view_budget = 1
    db.prepare(`
      INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, client_role, can_view_budget, status, created_at, updated_at)
      VALUES (?, ?, ?, 'usr-client-a-444', 'client', 'client_decision_maker', 1, 'active', ?, ?)
    `).run(crypto.randomUUID(), orgAId, weddingId, SEED_TIME_ISO, SEED_TIME_ISO);

    // Клиент Viewer: сватба, client_viewer, can_view_budget = 0
    db.prepare(`
      INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, client_role, can_view_budget, status, created_at, updated_at)
      VALUES (?, ?, ?, 'usr-viewer-666', 'client', 'client_viewer', 0, 'active', ?, ?)
    `).run(crypto.randomUUID(), orgAId, weddingId, SEED_TIME_ISO, SEED_TIME_ISO);

    // Клиент Б: корпоративно, client_decision_maker, can_view_budget = 1
    db.prepare(`
      INSERT INTO event_memberships (id, org_id, event_id, user_id, member_type, client_role, can_view_budget, status, created_at, updated_at)
      VALUES (?, ?, ?, 'usr-client-b-555', 'client', 'client_decision_maker', 1, 'active', ?, ?)
    `).run(crypto.randomUUID(), orgAId, corporateId, SEED_TIME_ISO, SEED_TIME_ISO);

    // 6. Етапи за сватбата:
    // - Публикуван потвърден етап: Локация
    const m1Id = 'mls-venue-01';
    db.prepare(`
      INSERT INTO milestones (
        id, org_id, event_id, title, category, sort_order, status, health, next_step,
        due_date, published_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Избор и резервация на локация', 'Локация', 1, 'confirmed', 'normal', 'Договорът е подписан и депозитът е платен', ?, ?, ?, ?, ?)
    `).run(m1Id, orgAId, weddingId, addDays(seedDate, -15).slice(0, 10), addDays(seedDate, -20), addDays(seedDate, -2), SEED_TIME_ISO, SEED_TIME_ISO);

    // - Публикуван етап: Риск (health = 'at_risk'): Декорация
    const m2Id = 'mls-decor-02';
    db.prepare(`
      INSERT INTO milestones (
        id, org_id, event_id, title, category, sort_order, status, health, next_step,
        due_date, published_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Флорална концепция и декорация', 'Декорация', 2, 'in_progress', 'at_risk', 'Очаква се потвърждение на наличност на цветята от вносителя', ?, ?, ?, ?, ?)
    `).run(m2Id, orgAId, weddingId, addDays(seedDate, 10).slice(0, 10), addDays(seedDate, -5), addDays(seedDate, -1), SEED_TIME_ISO, SEED_TIME_ISO);

    // - Едно просрочие (status = in_progress, due_date в миналото, напр. преди 3 дни): Фото и Видео
    const m3Id = 'mls-photo-03';
    db.prepare(`
      INSERT INTO milestones (
        id, org_id, event_id, title, category, sort_order, status, health, next_step,
        due_date, published_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Договаряне на фотограф и видеограф', 'Медия', 3, 'in_progress', 'delayed', 'Срокът за избор на пакет изтече, чака се окончателен отговор', ?, ?, ?, ?, ?)
    `).run(m3Id, orgAId, weddingId, addDays(seedDate, -3).slice(0, 10), addDays(seedDate, -10), addDays(seedDate, -1), SEED_TIME_ISO, SEED_TIME_ISO);

    // - Остаряла проверка (last_verified_at преди повече от 8 дни): Кетъринг
    const m4Id = 'mls-cater-04';
    db.prepare(`
      INSERT INTO milestones (
        id, org_id, event_id, title, category, sort_order, status, health, next_step,
        due_date, published_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Кетъринг и сватбено меню', 'Кетъринг', 4, 'awaiting_client', 'normal', 'Очаква се одобрение на финално 4-степенно меню от клиента', ?, ?, ?, ?, ?)
    `).run(m4Id, orgAId, weddingId, addDays(seedDate, 15).slice(0, 10), addDays(seedDate, -12), addDays(seedDate, -9), SEED_TIME_ISO, SEED_TIME_ISO);

    // - Непубликуван етап (чернова, published_at = NULL): Финална координация
    const m5Id = 'mls-final-05';
    db.prepare(`
      INSERT INTO milestones (
        id, org_id, event_id, title, category, sort_order, status, health, next_step,
        due_date, published_at, last_verified_at, created_at, updated_at
      ) VALUES (?, ?, ?, 'Финална организация и сценарий по минути', 'Координация', 5, 'planned', 'normal', 'Вътрешна подготовка на чернова на график', ?, NULL, NULL, ?, ?)
    `).run(m5Id, orgAId, weddingId, addDays(seedDate, 40).slice(0, 10), SEED_TIME_ISO, SEED_TIME_ISO);

    // 7. Вътрешни задачи за екипа
    db.prepare(`
      INSERT INTO tasks (id, org_id, event_id, milestone_id, title, internal_description, assignee_id, due_at, status, priority, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Свързване с главния сомелиер', 'Да се провери специалната винена листа за отстъпки', 'usr-coord-333', ?, 'doing', 'normal', ?, ?)
    `).run(crypto.randomUUID(), orgAId, weddingId, m4Id, addDays(seedDate, 5), SEED_TIME_ISO, SEED_TIME_ISO);

    // Вътрешна бележка с уникален тестов маркер (T10 & Section 24)
    const threadId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO threads (id, org_id, event_id, milestone_id, audience, requires_budget_permission, created_at)
      VALUES (?, ?, ?, ?, 'team', 0, ?)
    `).run(threadId, orgAId, weddingId, m4Id, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO comments (id, thread_id, org_id, event_id, author_id, body, created_at)
      VALUES (?, ?, ?, ?, 'usr-coord-333', ?, ?)
    `).run(crypto.randomUUID(), threadId, orgAId, weddingId, `Вътрешна бележка на координатора: ${SECRET_MARKER} - доставчикът предлага 15% тайна отстъпка за агенцията`, SEED_TIME_ISO);

    // 8. Предложение с 2 версии:
    // Предложение: Избор на меню
    const propId = 'prop-menu-01';
    db.prepare(`
      INSERT INTO proposals (id, org_id, event_id, milestone_id, kind, title, row_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'option_selection', 'Избор на меню за вечерята', 2, ?, ?)
    `).run(propId, orgAId, weddingId, m4Id, SEED_TIME_ISO, SEED_TIME_ISO);

    // Версия 1 (superseded)
    const v1Id = 'prop-ver-menu-v1';
    db.prepare(`
      INSERT INTO proposal_versions (id, proposal_id, org_id, event_id, version_no, body_json, content_hash, state, requires_budget_permission, submitted_at, created_at)
      VALUES (?, ?, ?, ?, 1, '{"desc":"Първоначален вариант на меню"}', 'hash-v1', 'superseded', 0, ?, ?)
    `).run(v1Id, propId, orgAId, weddingId, addDays(seedDate, -15), addDays(seedDate, -20));

    // Версия 2 (submitted & pending approval)
    const v2Id = 'prop-ver-menu-v2';
    db.prepare(`
      INSERT INTO proposal_versions (id, proposal_id, org_id, event_id, version_no, body_json, content_hash, state, requires_budget_permission, submitted_at, created_at)
      VALUES (?, ?, ?, ?, 2, '{"desc":"Обновено 4-степенно меню с включени вегетариански опции"}', 'hash-v2', 'submitted', 0, ?, ?)
    `).run(v2Id, propId, orgAId, weddingId, addDays(seedDate, -2), addDays(seedDate, -2));

    db.prepare(`UPDATE proposals SET current_version_id = ? WHERE id = ?`).run(v2Id, propId);

    // Варианти за Версия 2
    const opt1Id = 'opt-menu-v2-1';
    const opt2Id = 'opt-menu-v2-2';
    db.prepare(`INSERT INTO proposal_options (id, proposal_version_id, org_id, event_id, title, description, total_cents, sort_order, created_at) VALUES (?, ?, ?, ?, 'Класическо средиземноморско меню', 'Телешко филе и лаврак', 7500, 1, ?)`).run(opt1Id, v2Id, orgAId, weddingId, SEED_TIME_ISO);
    db.prepare(`INSERT INTO proposal_options (id, proposal_version_id, org_id, event_id, title, description, total_cents, sort_order, created_at) VALUES (?, ?, ?, ?, 'Традиционно гурме меню', 'Патешко магре и сьомга', 8200, 2, ?)`).run(opt2Id, v2Id, orgAId, weddingId, SEED_TIME_ISO);

    // Активно искане за одобрение за Версия 2
    const reqV2Id = 'req-menu-v2-active';
    db.prepare(`
      INSERT INTO approval_requests (id, org_id, event_id, proposal_id, proposal_version_id, assignee_user_id, status, expires_at, row_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'usr-client-a-444', 'pending', ?, 1, ?, ?)
    `).run(reqV2Id, orgAId, weddingId, propId, v2Id, addDays(new Date(), 7), addDays(seedDate, -2), addDays(seedDate, -2));

    // Изтекло решение (Section 24: изтекло решение)
    const expiredPropId = 'prop-expired-02';
    const expiredVerId = 'prop-ver-exp-v1';
    const expiredReqId = 'req-expired-01';

    db.prepare(`INSERT INTO proposals (id, org_id, event_id, kind, title, current_version_id, created_at, updated_at) VALUES (?, ?, ?, 'general', 'Избор на DJ и музикална програма', ?, ?, ?)`).run(expiredPropId, orgAId, weddingId, expiredVerId, SEED_TIME_ISO, SEED_TIME_ISO);
    db.prepare(`INSERT INTO proposal_versions (id, proposal_id, org_id, event_id, version_no, body_json, content_hash, state, submitted_at, created_at) VALUES (?, ?, ?, ?, 1, '{"desc":"Плейлист и водещ"}', 'hash-exp', 'submitted', ?, ?)`).run(expiredVerId, expiredPropId, orgAId, weddingId, addDays(seedDate, -10), addDays(seedDate, -10));
    db.prepare(`
      INSERT INTO approval_requests (id, org_id, event_id, proposal_id, proposal_version_id, assignee_user_id, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'usr-client-a-444', 'expired', ?, ?, ?)
    `).run(expiredReqId, orgAId, weddingId, expiredPropId, expiredVerId, addDays(seedDate, -2), addDays(seedDate, -10), addDays(seedDate, -2));

    // 9. Бюджет:
    // Активен бюджет 5 000 EUR (500 000 цента) и предложен бюджет 5 300 EUR (530 000 цента)
    const activeBudgetId = 'bgt-active-5000';
    const proposedBudgetId = 'bgt-proposed-5300';

    db.prepare(`
      INSERT INTO budget_versions (id, org_id, event_id, version_no, state, currency, total_cents, created_at, updated_at)
      VALUES (?, ?, ?, 1, 'active', 'EUR', 500000, ?, ?)
    `).run(activeBudgetId, orgAId, weddingId, addDays(seedDate, -20), addDays(seedDate, -20));

    db.prepare(`
      INSERT INTO budget_items (id, budget_version_id, org_id, event_id, category, client_description, total_cents, sort_order, created_at)
      VALUES (?, ?, ?, ?, 'Локация', 'Наем на зала и градина', 250000, 1, ?)
    `).run(crypto.randomUUID(), activeBudgetId, orgAId, weddingId, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO budget_items (id, budget_version_id, org_id, event_id, category, client_description, total_cents, sort_order, created_at)
      VALUES (?, ?, ?, ?, 'Кетъринг', 'Основен пакет храна и напитки', 250000, 2, ?)
    `).run(crypto.randomUUID(), activeBudgetId, orgAId, weddingId, SEED_TIME_ISO);

    // Вътрешни разходи за активния бюджет (строго скрити)
    db.prepare(`
      INSERT INTO internal_costs (id, org_id, event_id, supplier_name, cost_cents, internal_note, created_at)
      VALUES (?, ?, ?, 'Резиденция Тера ООД', 180000, 'Вътрешна себестойност на наема', ?)
    `).run(crypto.randomUUID(), orgAId, weddingId, SEED_TIME_ISO);

    // Предложен бюджет 5 300 EUR (+300 EUR за допълнителен бар)
    db.prepare(`
      INSERT INTO budget_versions (id, org_id, event_id, version_no, state, currency, total_cents, base_version_id, created_at, updated_at)
      VALUES (?, ?, ?, 2, 'proposed', 'EUR', 530000, ?, ?, ?)
    `).run(proposedBudgetId, orgAId, weddingId, activeBudgetId, addDays(seedDate, -2), addDays(seedDate, -2));

    db.prepare(`
      INSERT INTO budget_items (id, budget_version_id, org_id, event_id, category, client_description, total_cents, sort_order, created_at)
      VALUES (?, ?, ?, ?, 'Локация', 'Наем на зала и градина', 250000, 1, ?)
    `).run(crypto.randomUUID(), proposedBudgetId, orgAId, weddingId, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO budget_items (id, budget_version_id, org_id, event_id, category, client_description, total_cents, sort_order, created_at)
      VALUES (?, ?, ?, ?, 'Кетъринг', 'Основен пакет храна и напитки', 250000, 2, ?)
    `).run(crypto.randomUUID(), proposedBudgetId, orgAId, weddingId, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO budget_items (id, budget_version_id, org_id, event_id, category, client_description, total_cents, sort_order, created_at)
      VALUES (?, ?, ?, ?, 'Коктейлен бар', 'Премиум барман и авторски коктейли', 30000, 3, ?)
    `).run(crypto.randomUUID(), proposedBudgetId, orgAId, weddingId, SEED_TIME_ISO);

    // 10. Плащания: частично постъпление (2 000 EUR = 200 000 цента) и примерен коригиращ запис (-200 EUR = -20 000 цента)
    const sched1Id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO payment_schedules (id, org_id, event_id, label, amount_cents, due_date, state, created_at, updated_at)
      VALUES (?, ?, ?, 'Капаро и първа вноска', 200000, ?, 'paid', ?, ?)
    `).run(sched1Id, orgAId, weddingId, addDays(seedDate, -15).slice(0, 10), addDays(seedDate, -20), addDays(seedDate, -14));

    const sched2Id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO payment_schedules (id, org_id, event_id, label, amount_cents, due_date, state, created_at, updated_at)
      VALUES (?, ?, ?, 'Втора междинна вноска', 150000, ?, 'pending', ?, ?)
    `).run(sched2Id, orgAId, weddingId, addDays(seedDate, 20).slice(0, 10), addDays(seedDate, -20), addDays(seedDate, -20));

    // Първоначално плащане от 2 000 EUR
    const pay1Id = 'pay-entry-2000-eur';
    db.prepare(`
      INSERT INTO payment_entries (id, org_id, event_id, schedule_id, signed_amount_cents, effective_date, reference, reversal_of_id, recorded_by, created_at)
      VALUES (?, ?, ?, ?, 200000, ?, 'Банков превод BG98UNCR70001', NULL, 'usr-manager-222', ?)
    `).run(pay1Id, orgAId, weddingId, sched1Id, addDays(seedDate, -14).slice(0, 10), addDays(seedDate, -14));

    // Коригиращ запис от -200 EUR (надплатена такса)
    const rev1Id = 'pay-rev-200-eur';
    db.prepare(`
      INSERT INTO payment_entries (id, org_id, event_id, schedule_id, signed_amount_cents, effective_date, reference, reversal_of_id, recorded_by, created_at)
      VALUES (?, ?, ?, ?, -20000, ?, 'Корекция: надплатена такса за сомелиер', ?, 'usr-manager-222', ?)
    `).run(rev1Id, orgAId, weddingId, sched1Id, addDays(seedDate, -10).slice(0, 10), pay1Id, addDays(seedDate, -10));

    // 11. Синтетични документи (PDF и изображения)
    const doc1Id = crypto.randomUUID();
    const docVer1Id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO documents (id, org_id, event_id, title, category, audience, requires_budget_permission, current_version_id, created_at, updated_at)
      VALUES (?, ?, ?, 'Договор за наем на резиденция Тера.pdf', 'Договори', 'client', 0, ?, ?, ?)
    `).run(doc1Id, orgAId, weddingId, docVer1Id, SEED_TIME_ISO, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO document_versions (id, document_id, org_id, event_id, version_no, object_key, original_name, mime_type, byte_size, sha256, scan_state, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, 1, ?, 'Договор_Тера_2026.pdf', 'application/pdf', 1048576, 'sha-contract-pdf', 'ready', 'usr-coord-333', ?)
    `).run(docVer1Id, doc1Id, orgAId, weddingId, `${orgAId}/${weddingId}/${doc1Id}/${docVer1Id}`, SEED_TIME_ISO);

    // Документ с изискване за бюджет (Оферта за кетъринг)
    const docBudgetId = crypto.randomUUID();
    const docBudgetVerId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO documents (id, org_id, event_id, title, category, audience, requires_budget_permission, current_version_id, created_at, updated_at)
      VALUES (?, ?, ?, 'Финансова оферта за кетъринг и напитки.pdf', 'Оферти', 'client', 1, ?, ?, ?)
    `).run(docBudgetId, orgAId, weddingId, docBudgetVerId, SEED_TIME_ISO, SEED_TIME_ISO);

    db.prepare(`
      INSERT INTO document_versions (id, document_id, org_id, event_id, version_no, object_key, original_name, mime_type, byte_size, sha256, scan_state, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, 1, ?, 'Оферта_Кетъринг_2026.pdf', 'application/pdf', 524288, 'sha-catering-offer', 'ready', 'usr-coord-333', ?)
    `).run(docBudgetVerId, docBudgetId, orgAId, weddingId, `${orgAId}/${weddingId}/${docBudgetId}/${docBudgetVerId}`, SEED_TIME_ISO);

    return {
      orgA: { id: orgAId, name: 'Агенция за събития Saza' },
      orgB: { id: orgBId, name: 'Агенция Премиум B' },
      users: {
        owner: { id: 'usr-owner-111', email: 'owner@example.test' },
        manager: { id: 'usr-manager-222', email: 'manager@example.test' },
        coordinator: { id: 'usr-coord-333', email: 'coordinator@example.test' },
        clientA: { id: 'usr-client-a-444', email: 'client_a@example.test' },
        clientB: { id: 'usr-client-b-555', email: 'client_b@example.test' },
        clientViewer: { id: 'usr-viewer-666', email: 'client_viewer@example.test' },
        userOrgB: { id: 'usr-org-b-777', email: 'user_org_b@example.test' }
      },
      events: {
        weddingA: { id: weddingId, title: 'Сватбено тържество на Елена и Виктор' },
        corporateA: { id: corporateId, title: 'Годишна корпоративна конференция 2026' },
        cancelledA: { id: cancelledId, title: 'Юбилей 50 години (Отменен)' },
        eventB: { id: eventBId, title: 'Лятно гала събитие Организация Б' }
      },
      proposals: {
        weddingMenu: { id: propId, v1Id, v2Id, requestId: reqV2Id }
      },
      budgets: {
        weddingActive5000: { id: activeBudgetId, totalCents: 500000 },
        weddingProposed5300: { id: proposedBudgetId, totalCents: 530000 }
      }
    };
  });
}
