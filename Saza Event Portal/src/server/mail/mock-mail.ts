// src/server/mail/mock-mail.ts
// Mock Mail Adapter за разработка и тестове
// Записва изпратените съобщения в директория storage/mail-log и конзолата

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { MailAdapter, SendMailOptions, SendMailResult } from './mail-adapter.ts';

export class MockMailAdapter implements MailAdapter {
  private logDir: string;

  constructor(logDir = './storage/mail-log') {
    this.logDir = path.resolve(logDir);
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  async sendMail(options: SendMailOptions): Promise<SendMailResult> {
    const messageId = `mock-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date().toISOString();

    const record = {
      messageId,
      timestamp,
      to: options.to,
      from: options.from || 'default-sender',
      replyTo: options.replyTo,
      subject: options.subject,
      text: options.text,
      html: options.html,
    };

    const cleanTo = Array.isArray(options.to) ? options.to.join('_') : options.to;
    const safeFilename = `${Date.now()}-${cleanTo.replace(/[^a-zA-Z0-9@._-]/g, '_')}.json`;
    const filePath = path.join(this.logDir, safeFilename);

    try {
      await fsp.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
    } catch (err: any) {
      console.warn(`[MockMail] Неуспешно записване на лог файл: ${err.message}`);
    }

    console.log(`[MockMail] ✉️  Изпратен имейл до: ${Array.isArray(options.to) ? options.to.join(', ') : options.to} | Относно: "${options.subject}"`);

    return {
      messageId,
      delivered: true,
      driver: 'mock',
    };
  }
}
