// src/server/http/middleware.ts
// HTTP Middleware: CORS, Автентикация, Сесии, JSON & Multipart парсинг, Статични файлове
// Без външни зависимости — използва само native Node.js модули

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config/env.ts';
import { Database } from '../db/database.ts';

// ─── CORS ────────────────────────────────────────────────────────────────────

export function handleCors(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const origin = req.headers.origin;

  // Ако origin е в разрешените (или в dev режим)
  if (origin && (config.isDev || config.cors.origins.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin && config.isDev) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Idempotency-Key, Correlation-ID, X-Requested-With, X-Jobs-Secret'
  );
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }
  return false;
}

// ─── JSON Responses ──────────────────────────────────────────────────────────

export function sendJson(res: http.ServerResponse, statusCode: number, data: any): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(
  res: http.ServerResponse,
  statusCode: number,
  code: string,
  message: string,
  correlationId?: string
): void {
  const corr = correlationId || `corr-${crypto.randomBytes(4).toString('hex')}`;
  sendJson(res, statusCode, {
    error: {
      code,
      message,
      correlationId: corr,
    },
  });
}

// ─── Body Parsing ────────────────────────────────────────────────────────────

export async function parseJsonBody(req: http.IncomingMessage, maxBytes = 10 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        return reject(new Error('Размерът на тялото на заявката надвишава лимита'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(JSON.parse(raw));
      } catch (err: any) {
        reject(new Error(`Невалиден JSON формат: ${err.message}`));
      }
    });

    req.on('error', reject);
  });
}

export interface ParsedMultipart {
  fields: Record<string, string>;
  files: Record<string, { filename: string; mimeType: string; buffer: Buffer; byteSize: number }>;
}

export async function parseMultipartBody(
  req: http.IncomingMessage,
  maxBytes = 25 * 1024 * 1024
): Promise<ParsedMultipart> {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    throw new Error('Липсва multipart boundary в Content-Type');
  }
  const boundary = match[1] || match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const endBoundaryBuf = Buffer.from(`--${boundary}--`);

  const rawBuffer: Buffer = await new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        return reject(new Error('Файлът надвишава максимално допустимия размер'));
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });

  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; mimeType: string; buffer: Buffer; byteSize: number }> = {};

  // Разделяме по boundary
  let startIdx = 0;
  while (startIdx < rawBuffer.length) {
    const bIdx = rawBuffer.indexOf(boundaryBuf, startIdx);
    if (bIdx === -1) break;

    const nextBIdx = rawBuffer.indexOf(boundaryBuf, bIdx + boundaryBuf.length);
    if (nextBIdx === -1) break;

    // Взимаме сегмента между двете boundaries
    const part = rawBuffer.subarray(bIdx + boundaryBuf.length, nextBIdx);
    startIdx = nextBIdx;

    // Намираме разделителя между хедъри и тяло (\r\n\r\n)
    const headerSep = Buffer.from('\r\n\r\n');
    const headerSepIdx = part.indexOf(headerSep);
    if (headerSepIdx === -1) continue;

    const headerStr = part.subarray(0, headerSepIdx).toString('utf8');
    // Тялото завършва с \r\n преди следващия boundary
    let body = part.subarray(headerSepIdx + 4);
    if (body.length >= 2 && body[body.length - 2] === 13 && body[body.length - 1] === 10) {
      body = body.subarray(0, body.length - 2);
    }

    const dispMatch = headerStr.match(/Content-Disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]+)")?/i);
    if (!dispMatch) continue;

    const fieldName = dispMatch[1];
    const filename = dispMatch[2];

    if (filename !== undefined) {
      // Това е файл
      const typeMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
      const mimeType = typeMatch ? typeMatch[1].trim() : 'application/octet-stream';

      files[fieldName] = {
        filename,
        mimeType,
        buffer: body,
        byteSize: body.length,
      };
    } else {
      // Обикновено текстово поле
      fields[fieldName] = body.toString('utf8');
    }
  }

  return { fields, files };
}

// ─── Сесии и Автентикация ────────────────────────────────────────────────────

export function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const list: Record<string, string> = {};
  const rc = req.headers.cookie;
  if (!rc) return list;

  for (const cookie of rc.split(';')) {
    const parts = cookie.split('=');
    const key = parts.shift()?.trim();
    if (key) {
      list[key] = decodeURIComponent(parts.join('='));
    }
  }
  return list;
}

export function signSession(data: { userId: string; role?: string; orgId?: string }): string {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const hmac = crypto.createHmac('sha256', config.security.sessionSecret).update(payload).digest('base64url');
  return `${payload}.${hmac}`;
}

export function verifySession(token: string): { userId: string; role?: string; orgId?: string } | null {
  if (!token || !token.includes('.')) return null;
  const [payload, hmac] = token.split('.');
  const expectedHmac = crypto.createHmac('sha256', config.security.sessionSecret).update(payload).digest('base64url');

  if (crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) {
    try {
      return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  }
  return null;
}

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  isStaff: boolean;
  role?: string;
  orgId?: string;
}

export function authenticate(req: http.IncomingMessage, db: Database): AuthContext | null {
  let userId: string | null = null;

  // 1. Bearer Token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    const session = verifySession(token);
    if (session) {
      userId = session.userId;
    } else if (config.isDev && token.startsWith('usr-')) {
      // Dev helper: директен userId в Bearer хедъра
      userId = token;
    }
  }

  // 2. Cookie
  if (!userId) {
    const cookies = parseCookies(req);
    if (cookies.saza_session) {
      const session = verifySession(cookies.saza_session);
      if (session) userId = session.userId;
    }
  }

  // 3. Dev Header (удобно за API тестове в разработка)
  if (!userId && config.isDev && req.headers['x-actor-user-id']) {
    userId = String(req.headers['x-actor-user-id']);
  }

  // 4. Client Token (X-Client-Token header или ?token= query param)
  if (!userId) {
    const url = new URL(req.url || '/', 'http://localhost');
    const clientToken = req.headers['x-client-token'] || url.searchParams.get('token');
    if (clientToken) {
      const row = db.prepare(`SELECT user_id FROM event_memberships WHERE access_token = ? AND status = 'active'`).get(clientToken) as any;
      if (row) userId = row.user_id;
    }
  }

  if (!userId) return null;

  const profile = db.prepare(`
    SELECT user_id, display_name, email, locale, timezone
    FROM profiles WHERE user_id = ?
  `).get(userId) as { user_id: string; display_name: string; email: string } | undefined;

  if (!profile) return null;

  // Проверка за staff роля
  const staffMem = db.prepare(`
    SELECT role, org_id FROM organization_memberships WHERE user_id = ? AND status = 'active' LIMIT 1
  `).get(userId) as { role: string; org_id: string } | undefined;

  return {
    userId: profile.user_id,
    email: profile.email,
    displayName: profile.display_name,
    isStaff: !!staffMem,
    role: staffMem?.role,
    orgId: staffMem?.org_id,
  };
}

// ─── Статични файлове ────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
};

export async function serveStaticFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  publicDir: string
): Promise<boolean> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;

  let pathname = new URL(req.url || '/', `http://${req.headers.host}`).pathname;
  if (pathname === '/') pathname = '/index.html';

  // Предотвратяване на Directory Traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = path.join(path.resolve(publicDir), safePath);

  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_MAP[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': config.isProd ? 'public, max-age=0, must-revalidate' : 'no-cache, no-store, must-revalidate',
    });

    if (req.method === 'HEAD') {
      res.end();
      return true;
    }

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
    return true;
  } catch {
    return false;
  }
}
