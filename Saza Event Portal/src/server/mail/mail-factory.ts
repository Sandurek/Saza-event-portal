// src/server/mail/mail-factory.ts
// Фабрика за избор на MailAdapter според конфигурацията (mock, resend, smtp)

import { config } from '../config/env.ts';
import type { MailAdapter } from './mail-adapter.ts';
import { MockMailAdapter } from './mock-mail.ts';
import { ResendMailAdapter } from './resend-mail.ts';
import { SmtpMailAdapter } from './smtp-mail.ts';

let defaultAdapter: MailAdapter | null = null;

export function createMailAdapter(forceNew = false): MailAdapter {
  if (defaultAdapter && !forceNew) {
    return defaultAdapter;
  }

  let adapter: MailAdapter;

  switch (config.mail.driver) {
    case 'resend':
      adapter = new ResendMailAdapter(
        config.mail.resendApiKey,
        `${config.mail.fromName} <${config.mail.fromAddress}>`
      );
      break;

    case 'smtp':
      adapter = new SmtpMailAdapter({
        host: config.mail.smtp.host,
        port: config.mail.smtp.port,
        secure: config.mail.smtp.secure,
        user: config.mail.smtp.user,
        pass: config.mail.smtp.pass,
        defaultFrom: `${config.mail.fromName} <${config.mail.fromAddress}>`,
      });
      break;

    case 'mock':
    default:
      adapter = new MockMailAdapter('./storage/mail-log');
      break;
  }

  if (!forceNew) {
    defaultAdapter = adapter;
  }

  return adapter;
}
