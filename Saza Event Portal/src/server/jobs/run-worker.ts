// src/server/jobs/run-worker.ts
// Автономен Outbox Worker процес за периодично изпращане на имейли и известия

import { config } from '../config/env.ts';
import { Database } from '../db/database.ts';
import { createMailAdapter } from '../mail/mail-factory.ts';
import { OutboxWorker } from './outbox-worker.ts';

const db = new Database(config.db.path);
const mailAdapter = createMailAdapter();
const worker = new OutboxWorker(db, mailAdapter);

let isRunning = true;
const isOnce = process.argv.includes('--once');
const INTERVAL_MS = 5000;

console.log(`[Worker] Стартиран Outbox Worker (Mail Driver: ${config.mail.driver})`);
if (isOnce) {
  console.log('[Worker] Режим: Еднократно изпълнение (--once)');
}

async function runLoop() {
  while (isRunning) {
    try {
      const stats = await worker.processBatchAsync(config.mail.outboxBatchSize);
      if (stats.processed > 0) {
        console.log(`[Worker] Обработени: ${stats.processed} (Изпратени: ${stats.sent}, Повторни опити: ${stats.retried}, Отказани: ${stats.droppedDueToRevocation})`);
      }
    } catch (err: any) {
      console.error(`[Worker] Грешка при обработка на outbox: ${err.message}`);
    }

    if (isOnce) break;

    // Пауза преди следващия цикъл
    await new Promise(resolve => setTimeout(resolve, INTERVAL_MS));
  }

  console.log('[Worker] Worker процесът приключи.');
  process.exit(0);
}

process.on('SIGINT', () => {
  console.log('\n[Worker] Получен сигнал за спиране (SIGINT)...');
  isRunning = false;
});

process.on('SIGTERM', () => {
  console.log('\n[Worker] Получен сигнал за спиране (SIGTERM)...');
  isRunning = false;
});

runLoop();
