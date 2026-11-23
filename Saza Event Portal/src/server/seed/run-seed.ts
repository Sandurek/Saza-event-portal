// src/server/seed/run-seed.ts
import path from 'node:path';
import { Database } from '../db/database.ts';
import { seedDatabase, SEED_TIME_ISO } from './seed-data.ts';

const dbPath = path.resolve(process.cwd(), 'event_portal.db');
console.log(`[Seed] Инициализиране на база данни: ${dbPath}`);

const db = new Database(dbPath);
const result = seedDatabase(db);

console.log(`[Seed] Успешно зареден seed спрямо фиксирано време: ${SEED_TIME_ISO}`);
console.log(`[Seed] Организации: ${result.orgA.name} (${result.orgA.id}), ${result.orgB.name} (${result.orgB.id})`);
console.log(`[Seed] Събития:`);
console.log(` - Сватба (45 дни): ${result.events.weddingA.title} [${result.events.weddingA.id}]`);
console.log(` - Корпоративно (14 дни): ${result.events.corporateA.title} [${result.events.corporateA.id}]`);
console.log(` - Отменен празник: ${result.events.cancelledA.title} [${result.events.cancelledA.id}]`);
console.log(` - Събитие в Орг Б: ${result.events.eventB.title} [${result.events.eventB.id}]`);
console.log(`[Seed] Потребители: owner, manager, coordinator, client_a, client_b, client_viewer, user_org_b`);
console.log(`[Seed] Активен бюджет: 5 000 EUR, Предложен бюджет: 5 300 EUR (+300 EUR)`);
console.log(`[Seed] Готово!`);
db.close();
