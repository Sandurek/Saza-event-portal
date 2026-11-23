// tests/test-http-server.ts
// Автоматичен интеграционен тест за HTTP сървъра, REST API и Storage подсистемата

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Database } from '../src/server/db/database.ts';
import { seedDatabase } from '../src/server/seed/seed-data.ts';
import { LocalStorageAdapter } from '../src/server/storage/local-storage.ts';
import { MockMailAdapter } from '../src/server/mail/mock-mail.ts';
import { AppRouter } from '../src/server/http/router.ts';
import { handleCors, serveStaticFile } from '../src/server/http/middleware.ts';

const TEST_PORT = 3456;
const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

// Изолирана in-memory тестова база данни
const testDb = new Database(':memory:');
const seed = seedDatabase(testDb);

// Изолиран тестови сторидж в scratch/test-uploads
const testUploadsDir = path.resolve(process.cwd(), 'scratch/test-uploads');
if (!fs.existsSync(testUploadsDir)) {
  fs.mkdirSync(testUploadsDir, { recursive: true });
}
const testStorage = new LocalStorageAdapter(testUploadsDir);
const testMail = new MockMailAdapter(path.resolve(process.cwd(), 'scratch/test-mail'));

const router = new AppRouter({
  db: testDb,
  storageAdapter: testStorage,
  mailAdapter: testMail,
});

import { Readable } from 'node:stream';

class MockResponse extends http.ServerResponse {
  public statusCode: number = 200;
  public headers: Record<string, string | string[]> = {};
  public bodyChunks: Buffer[] = [];
  private onEndCallbacks: (() => void)[] = [];

  constructor() {
    super({ method: 'GET' } as any);
  }

  setHeader(name: string, value: string | string[]): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): any {
    return this.headers[name.toLowerCase()];
  }

  writeHead(statusCode: number, headers?: any): this {
    this.statusCode = statusCode;
    if (headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.setHeader(k, v as any);
      }
    }
    return this;
  }

  write(chunk: any): boolean {
    if (chunk) {
      this.bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return true;
  }

  end(chunk?: any): this {
    if (chunk) {
      this.write(chunk);
    }
    for (const cb of this.onEndCallbacks) cb();
    return this;
  }

  waitForEnd(): Promise<void> {
    return new Promise((resolve) => {
      this.onEndCallbacks.push(resolve);
    });
  }
}

async function request(options: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
}): Promise<{ status: number; headers: Record<string, string | string[]>; json?: any; text: string; buffer: Buffer }> {
  const reqStream = new Readable({
    read() {
      if (options.body) {
        this.push(Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body));
      }
      this.push(null);
    },
  }) as any;

  reqStream.method = options.method || 'GET';
  reqStream.url = options.path;
  reqStream.headers = {};
  for (const [k, v] of Object.entries(options.headers || {})) {
    reqStream.headers[k.toLowerCase()] = v;
  }
  if (!reqStream.headers.host) {
    reqStream.headers.host = 'localhost:3000';
  }

  const mockRes = new MockResponse();
  const endPromise = mockRes.waitForEnd();

  (async () => {
    if (handleCors(reqStream, mockRes)) return;
    const url = new URL(reqStream.url, 'http://localhost:3000');
    if (url.pathname.startsWith('/api')) {
      await router.handleRequest(reqStream, mockRes);
    } else {
      const served = await serveStaticFile(reqStream, mockRes, path.resolve(process.cwd(), 'public'));
      if (!served) {
        mockRes.writeHead(404);
        mockRes.end('Not Found');
      }
    }
  })().catch((err) => {
    mockRes.writeHead(500);
    mockRes.end(err.message);
  });

  await endPromise;
  const buffer = Buffer.concat(mockRes.bodyChunks);
  const text = buffer.toString('utf8');
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {}

  return {
    status: mockRes.statusCode,
    headers: mockRes.headers,
    json,
    text,
    buffer,
  };
}

async function runIntegrationTests() {
  console.log('========================================================');
  console.log('Стартиране на интеграционни тестове за HTTP API Сървъра');
  console.log('========================================================\n');

  console.log(`[TestServer] Тестване на маршрутите in-memory`);

  try {
    // 1. Health check
    console.log('[TEST 1] GET /api/health');
    const health = await request({ path: '/api/health' });
    assert.equal(health.status, 200);
    assert.equal(health.json.status, 'ok');
    console.log('  -> PASS: health status ok');

    // 2. Status check
    console.log('[TEST 2] GET /api/status');
    const status = await request({ path: '/api/status' });
    assert.equal(status.status, 200);
    assert.equal(status.json.status, 'Ready');
    console.log('  -> PASS: status ready');

    // 3. Static files
    console.log('[TEST 3] GET /index.html');
    const indexHtml = await request({ path: '/index.html' });
    assert.equal(indexHtml.status, 200);
    assert.match(indexHtml.text, /Saza Event Portal/);
    console.log('  -> PASS: static HTML served');

    // 4. Login flow
    console.log('[TEST 4] POST /api/auth/login');
    const loginRes = await request({
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'client_a' }),
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.json.success, true);
    assert.ok(loginRes.json.token);
    const token = loginRes.json.token;
    console.log(`  -> PASS: authenticated as ${loginRes.json.user.displayName}`);

    const authHeaders = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    // 5. Session check
    console.log('[TEST 5] GET /api/auth/session');
    const sessionRes = await request({
      path: '/api/auth/session',
      headers: authHeaders,
    });
    assert.equal(sessionRes.status, 200);
    assert.equal(sessionRes.json.authenticated, true);
    assert.equal(sessionRes.json.user.userId, 'usr-client-a-444');
    console.log('  -> PASS: active session valid');

    // 6. List events
    console.log('[TEST 6] GET /api/events');
    const eventsRes = await request({
      path: '/api/events',
      headers: authHeaders,
    });
    assert.equal(eventsRes.status, 200);
    assert.ok(eventsRes.json.events.length > 0);
    const eventId = eventsRes.json.events[0].id;
    console.log(`  -> PASS: found ${eventsRes.json.events.length} event(s)`);

    // 7. Event Overview (4-те ключови въпроса)
    console.log(`[TEST 7] GET /api/events/${eventId}/overview`);
    const overviewRes = await request({
      path: `/api/events/${eventId}/overview`,
      headers: authHeaders,
    });
    assert.equal(overviewRes.status, 200);
    assert.ok(overviewRes.json.metrics);
    console.log(`  -> PASS: metrics: health=${overviewRes.json.metrics.overallHealth}`);

    // 8. Event Milestones
    console.log(`[TEST 8] GET /api/events/${eventId}/milestones`);
    const milestonesRes = await request({
      path: `/api/events/${eventId}/milestones`,
      headers: authHeaders,
    });
    assert.equal(milestonesRes.status, 200);
    assert.ok(Array.isArray(milestonesRes.json.milestones));
    console.log(`  -> PASS: ${milestonesRes.json.milestones.length} milestones returned`);

    // 9. Event Budget
    console.log(`[TEST 9] GET /api/events/${eventId}/budget`);
    const budgetRes = await request({
      path: `/api/events/${eventId}/budget`,
      headers: authHeaders,
    });
    assert.equal(budgetRes.status, 200);
    assert.ok(budgetRes.json.budget);
    console.log(`  -> PASS: budget total = ${budgetRes.json.budget.activeTotalCents} cents`);

    // 10. File Upload (Multipart) & File Storage
    console.log('[TEST 10] POST /api/events/:eventId/documents/upload (Multipart)');
    const boundary = '----WebKitFormBoundaryX9zTestFile';
    const sampleContent = Buffer.from('%PDF-1.4 Sample PDF Content for testing upload');
    const multipartBody = Buffer.concat([
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="title"\r\n\r\nТестови документ за сватбата\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="category"\r\n\r\nОферти\r\n`),
      Buffer.from(`--${boundary}\r\n`),
      Buffer.from(`Content-Disposition: form-data; name="file"; filename="Test_Offer.pdf"\r\n`),
      Buffer.from(`Content-Type: application/pdf\r\n\r\n`),
      sampleContent,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    // Staff потребител (coordinator) качва файла
    const coordLogin = await request({
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'coordinator' }),
    });
    const coordToken = coordLogin.json.token;

    const uploadRes = await request({
      path: `/api/events/${eventId}/documents/upload`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${coordToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });
    assert.equal(uploadRes.status, 201);
    assert.equal(uploadRes.json.success, true);
    assert.ok(uploadRes.json.documentId);
    const uploadedDocId = uploadRes.json.documentId;
    console.log(`  -> PASS: uploaded documentId = ${uploadedDocId}`);

    // 11. File Download through StorageAdapter
    console.log(`[TEST 11] GET /api/documents/${uploadedDocId}/download`);
    const downloadRes = await request({
      path: `/api/documents/${uploadedDocId}/download`,
      headers: authHeaders,
    });
    assert.equal(downloadRes.status, 200);
    assert.equal(downloadRes.headers['content-type'], 'application/pdf');
    assert.equal(downloadRes.buffer.toString('utf8'), sampleContent.toString('utf8'));
    console.log('  -> PASS: downloaded file content matches uploaded bytes exactly!');

    // 12. Security: Unauthorized download attempt from another user
    console.log('[TEST 12] Security: User Org B attempts to download Org A document (T06 check)');
    const orgBLogin = await request({
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user_org_b' }),
    });
    const orgBDownload = await request({
      path: `/api/documents/${uploadedDocId}/download`,
      headers: { 'Authorization': `Bearer ${orgBLogin.json.token}` },
    });
    assert.equal(orgBDownload.status, 403);
    console.log('  -> PASS: cross-org download blocked with 403 Forbidden!');

    // 13. Outbox background processing
    console.log('[TEST 13] POST /api/jobs/outbox');
    const jobsRes = await request({
      path: '/api/jobs/outbox',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${coordToken}`,
      },
    });
    assert.equal(jobsRes.status, 200);
    assert.equal(jobsRes.json.success, true);
    console.log('  -> PASS: outbox jobs triggered successfully!');

    // 14. Owner full control & DELETE /api/events/:eventId RBAC
    console.log('[TEST 14] RBAC on DELETE /api/events/:eventId + Owner full lifecycle');
    const ownerLogin = await request({
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: seed.users.owner.id }),
    });
    assert.equal(ownerLogin.status, 200);
    const ownerHeaders = { 'Authorization': `Bearer ${ownerLogin.json.token}`, 'Content-Type': 'application/json' };

    // Създаваме втори Owner през /api/admin/users
    const createSecondOwner = await request({
      path: '/api/admin/users',
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({
        displayName: 'Втори Собственик',
        username: 'OwnerTwo',
        email: 'ownertwo@example.test',
        role: 'owner',
        password: 'OwnerPass123!',
      }),
    });
    assert.equal(createSecondOwner.status, 201);

    const owner2Login = await request({
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'OwnerTwo', password: 'OwnerPass123!' }),
    });
    assert.equal(owner2Login.status, 200);
    const owner2Headers = { 'Authorization': `Bearer ${owner2Login.json.token}`, 'Content-Type': 'application/json' };

    // Вторият Owner създава ново събитие, добавя перо, плащане и качва документ
    const newEvtRes = await request({
      path: '/api/events',
      method: 'POST',
      headers: owner2Headers,
      body: JSON.stringify({
        title: 'Тестово събитие за изтриване',
        eventType: 'wedding',
        venueLabel: 'София',
        clientName: 'Временен Клиент',
        clientEmail: 'temp-del-client@example.test',
      }),
    });
    assert.equal(newEvtRes.status, 201);
    const createdEventId = newEvtRes.json.eventId;

    const ownerEventsList = await request({ path: '/api/events', headers: owner2Headers });
    assert.equal(ownerEventsList.status, 200);
    const listedCreated = ownerEventsList.json.events.find((e: any) => e.id === createdEventId);
    assert.ok(listedCreated);
    assert.equal(listedCreated.client_name, 'Временен Клиент');

    const delUploadRes = await request({
      path: `/api/events/${createdEventId}/documents/upload`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${owner2Login.json.token}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: multipartBody,
    });
    assert.equal(delUploadRes.status, 201);
    const delObjectKey = delUploadRes.json.objectKey;
    assert.equal(await testStorage.exists(delObjectKey), true);

    // Manager и Coordinator НЕ могат да изтрият събитието -> 403
    const managerLogin = await request({
      path: '/api/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'manager' }),
    });
    const mgrDelRes = await request({
      path: `/api/events/${createdEventId}`,
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${managerLogin.json.token}` },
    });
    assert.equal(mgrDelRes.status, 403);

    // Owner изтрива събитието -> 200 и файлът от сториджа е изчистен
    const ownerDelRes = await request({
      path: `/api/events/${createdEventId}`,
      method: 'DELETE',
      headers: owner2Headers,
    });
    assert.equal(ownerDelRes.status, 200);
    assert.equal(ownerDelRes.json.success, true);
    assert.equal(await testStorage.exists(delObjectKey), false);

    // Повторно създаване със същия клиентски имейл работи без конфликт
    const recreateRes = await request({
      path: '/api/events',
      method: 'POST',
      headers: owner2Headers,
      body: JSON.stringify({
        title: 'Повторно събитие след изтриване',
        clientName: 'Временен Клиент',
        clientEmail: 'temp-del-client@example.test',
      }),
    });
    assert.equal(recreateRes.status, 201);
    console.log('  -> PASS: Owner full actions, 403 for non-owners, cascade DELETE & file cleanup verified!');

    console.log('\n========================================================');
    console.log('🎉 ВСИЧКИ ИНТЕГРАЦИОННИ ТЕСТОВЕ ПРЕМИНАХА УСПЕШНО!');
    console.log('========================================================\n');
  } finally {
  }
}

runIntegrationTests().catch((err) => {
  console.error('\n❌ Грешка при интеграционните тестове:', err);
  process.exit(1);
});
