// src/server/config/env.ts
// Централизирано зареждане и валидиране на конфигурацията от .env
// Поддържа: local fs storage, S3-compatible storage, mock/resend/smtp mail

import fs from 'node:fs';
import path from 'node:path';

/** Зарежда .env файл от дадена директория (без външни зависимости) */
function loadDotEnv(cwd: string): void {
  const envPath = path.resolve(cwd, '.env');
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    // Не презаписваме вече зададени ENV променливи
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadDotEnv(process.cwd());

function requireEnv(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined || val === '') {
    throw new Error(`[Config] Задължителна ENV променлива "${key}" не е зададена.`);
  }
  return val;
}

function optionalEnv(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

function boolEnv(key: string, fallback = false): boolean {
  const v = optionalEnv(key, fallback ? 'true' : 'false');
  return v === 'true' || v === '1';
}

function intEnv(key: string, fallback: number): number {
  const v = optionalEnv(key, String(fallback));
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

// ─── Типове ──────────────────────────────────────────────────────────────────

export type StorageDriver = 'local' | 's3';
export type MailDriver = 'mock' | 'resend' | 'smtp';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  nodeEnv: string;
  isDev: boolean;
  isProd: boolean;
  appBaseUrl: string;
  port: number;
  host: string;

  db: {
    path: string;
  };

  storage: {
    driver: StorageDriver;
    local: {
      dir: string;
    };
    s3: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      publicUrl: string;
    };
    maxFileSizeBytes: number;
  };

  mail: {
    driver: MailDriver;
    fromAddress: string;
    fromName: string;
    resendApiKey: string;
    smtp: {
      host: string;
      port: number;
      secure: boolean;
      user: string;
      pass: string;
    };
    outboxBatchSize: number;
  };

  security: {
    sessionSecret: string;
    jobsSecret: string;
  };

  fileScanner: {
    enabled: boolean;
    url: string;
    apiKey: string;
  };

  cors: {
    origins: string[];
  };

  monitoring: {
    dsn: string;
  };

  logLevel: LogLevel;
}

// ─── Изграждане на конфигурацията ────────────────────────────────────────────

const nodeEnv = optionalEnv('NODE_ENV', 'development');
const isDev = nodeEnv !== 'production';

export const config: AppConfig = {
  nodeEnv,
  isDev,
  isProd: !isDev,
  appBaseUrl: optionalEnv('APP_BASE_URL', 'http://localhost:3000'),
  port: intEnv('PORT', 3000),
  host: optionalEnv('HOST', '0.0.0.0'),

  db: {
    path: optionalEnv('DB_PATH', './event_portal.db'),
  },

  storage: {
    driver: (optionalEnv('STORAGE_DRIVER', 'local') as StorageDriver),
    local: {
      dir: optionalEnv('STORAGE_LOCAL_DIR', './storage/uploads'),
    },
    s3: {
      endpoint: optionalEnv('STORAGE_S3_ENDPOINT'),
      region: optionalEnv('STORAGE_S3_REGION', 'auto'),
      bucket: optionalEnv('STORAGE_S3_BUCKET'),
      accessKeyId: optionalEnv('STORAGE_S3_ACCESS_KEY_ID'),
      secretAccessKey: optionalEnv('STORAGE_S3_SECRET_ACCESS_KEY'),
      publicUrl: optionalEnv('STORAGE_S3_PUBLIC_URL'),
    },
    maxFileSizeBytes: intEnv('MAX_FILE_SIZE_BYTES', 20 * 1024 * 1024),
  },

  mail: {
    driver: (optionalEnv('MAIL_DRIVER', 'mock') as MailDriver),
    fromAddress: optionalEnv('MAIL_FROM_ADDRESS', 'portal@eventagency.test'),
    fromName: optionalEnv('MAIL_FROM_NAME', 'Saza Event Portal'),
    resendApiKey: optionalEnv('MAIL_RESEND_API_KEY'),
    smtp: {
      host: optionalEnv('MAIL_SMTP_HOST', 'localhost'),
      port: intEnv('MAIL_SMTP_PORT', 587),
      secure: boolEnv('MAIL_SMTP_SECURE', false),
      user: optionalEnv('MAIL_SMTP_USER'),
      pass: optionalEnv('MAIL_SMTP_PASS'),
    },
    outboxBatchSize: intEnv('MAIL_OUTBOX_BATCH_SIZE', 20),
  },

  security: {
    sessionSecret: requireEnv('SESSION_SECRET', isDev ? 'dev-only-insecure-session-secret-change-in-prod' : undefined),
    jobsSecret: requireEnv('JOBS_SECRET', isDev ? 'dev-only-jobs-secret' : undefined),
  },

  fileScanner: {
    enabled: boolEnv('FILE_SCANNER_ENABLED', false),
    url: optionalEnv('FILE_SCANNER_URL'),
    apiKey: optionalEnv('FILE_SCANNER_API_KEY'),
  },

  cors: {
    origins: optionalEnv('CORS_ORIGINS', 'http://localhost:3000')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  },

  monitoring: {
    dsn: optionalEnv('MONITORING_DSN'),
  },

  logLevel: (optionalEnv('LOG_LEVEL', 'info') as LogLevel),
};

export default config;
