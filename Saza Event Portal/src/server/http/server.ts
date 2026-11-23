// src/server/http/server.ts
// Главен HTTP сървър за Saza Event Portal (Раздел 16 от Спецификацията)

import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { config } from '../config/env.ts';
import { Database } from '../db/database.ts';
import { createStorageAdapter } from '../storage/storage-factory.ts';
import { createMailAdapter } from '../mail/mail-factory.ts';
import { handleCors, serveStaticFile } from './middleware.ts';
import { AppRouter } from './router.ts';
import { OutboxWorker } from '../jobs/outbox-worker.ts';

// ─── Инициализация на ресурсите ──────────────────────────────────────────────

// Проверка и инициализация на базата данни
const dbPath = path.resolve(config.db.path);
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

console.log(`[Database] Зареждане на база данни от: ${dbPath}`);
const db = new Database(dbPath);

// Проверка дали има потребители
const profileCount = db.prepare(`SELECT count(*) as count FROM profiles`).get() as { count: number };
if (profileCount.count === 0) {
  console.log('[Database] Базата е празна. Автоматично създаване на акаунт за Sando...');
  const { resetToCleanDatabase } = await import('../seed/init-clean-db.ts');
  resetToCleanDatabase(db);
  console.log('[Database] Чистата база данни за Sando е инициализирана успешно!');
}

// Файлово хранилище и Имейл адаптери
const storageAdapter = createStorageAdapter();
const mailAdapter = createMailAdapter();

console.log(`[Storage] Активен драйвер: ${config.storage.driver.toUpperCase()}`);
if (config.storage.driver === 'local') {
  console.log(`[Storage] Локална директория: ${path.resolve(config.storage.local.dir)}`);
} else {
  console.log(`[Storage] S3 Endpoint: ${config.storage.s3.endpoint} (Bucket: ${config.storage.s3.bucket})`);
}

console.log(`[Mail] Активен драйвер: ${config.mail.driver.toUpperCase()}`);

// Инициализация на REST API Рутера
const router = new AppRouter({
  db,
  storageAdapter,
  mailAdapter,
});

// Фонов Outbox Worker за автоматично изпращане на имейли на всеки 5 секунди
const outboxWorker = new OutboxWorker(db, mailAdapter);
const outboxInterval = setInterval(async () => {
  try {
    const stats = await outboxWorker.processBatchAsync(config.mail.outboxBatchSize);
    if (stats.sent > 0) {
      console.log(`[Outbox Worker] Изпратени ${stats.sent} известия/имейли`);
    }
  } catch (err: any) {
    // игнориране при празен списък
  }
}, 5000);
outboxInterval.unref();

const publicDir = path.resolve(process.cwd(), 'public');

// ─── HTTP Сървър ─────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // 1. CORS префлайт и хедъри
  if (handleCors(req, res)) {
    return;
  }

  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // 2. REST API Маршрути (/api/...)
  if (url.pathname.startsWith('/api')) {
    return router.handleRequest(req, res);
  }

  // 3. Статични файлове от public/
  const served = await serveStaticFile(req, res, publicDir);
  if (served) {
    return;
  }

  // 4. SPA Fallback (за всякакви други пътища зареждаме index.html)
  const fallbackServed = await serveStaticFile(
    Object.assign(Object.create(req), { url: '/index.html' }),
    res,
    publicDir
  );
  if (!fallbackServed) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
});

// ─── Стартиране ──────────────────────────────────────────────────────────────

server.listen(config.port, config.host, () => {
  const interfaces = os.networkInterfaces();
  const localIps: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIps.push(iface.address);
      }
    }
  }

  console.log('\n=============================================================');
  console.log('       🎉 SAZA EVENT PORTAL СЪРВЪРЪТ СТАРТИРА УСПЕШНО!        ');
  console.log('=============================================================');
  console.log(`  💻 Локално (този компютър):   http://localhost:${config.port}`);
  console.log(`  🌍 Публичен интернет адрес:   https://www.sandurek.com`);
  if (localIps.length > 0) {
    localIps.forEach(ip => {
      console.log(`  📱 Други устройства (LAN):    http://${ip}:${config.port}`);
    });
  }
  console.log(`  📁 Статични файлове:         ${publicDir}`);
  console.log(`  💾 База данни:               ${dbPath}`);
  console.log(`  📦 Storage Driver:           ${config.storage.driver.toUpperCase()}`);
  console.log(`  📧 Mail Driver:              ${config.mail.driver.toUpperCase()}`);
  console.log(`  ⚙️  Режим:                   ${config.nodeEnv.toUpperCase()}`);
  console.log('-------------------------------------------------------------');
  console.log('  Натиснете Ctrl+C за спиране на сървъра.');
  console.log('=============================================================\n');
});

// ─── Graceful Shutdown ───────────────────────────────────────────────────────

function shutdown() {
  console.log('\n[Server] Спиране на HTTP сървъра...');
  clearInterval(outboxInterval);
  server.close(() => {
    console.log('[Server] Всички връзки са затворени.');
    process.exit(0);
  });
  // Ако за 3 секунди не затвори, форсираме изход
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
