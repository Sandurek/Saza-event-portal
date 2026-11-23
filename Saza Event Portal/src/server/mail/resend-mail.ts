// src/server/mail/resend-mail.ts
// Resend.com Mail Adapter (native node:https)

import https from 'node:https';
import type { MailAdapter, SendMailOptions, SendMailResult } from './mail-adapter.ts';

export class ResendMailAdapter implements MailAdapter {
  private apiKey: string;
  private defaultFrom: string;

  constructor(apiKey: string, defaultFrom = 'onboarding@resend.dev') {
    this.apiKey = apiKey;
    this.defaultFrom = defaultFrom;
    if (!this.apiKey) {
      throw new Error('[ResendMail] Липсва MAIL_RESEND_API_KEY в конфигурацията.');
    }
  }

  async sendMail(options: SendMailOptions): Promise<SendMailResult> {
    const payload = JSON.stringify({
      from: options.from || this.defaultFrom,
      to: Array.isArray(options.to) ? options.to : [options.to],
      subject: options.subject,
      html: options.html,
      text: options.text,
      reply_to: options.replyTo,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.resend.com',
          port: 443,
          path: '/emails',
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 10000,
        },
        (res) => {
          let responseBody = '';
          res.on('data', chunk => {
            responseBody += chunk;
          });
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(responseBody);
                resolve({
                  messageId: parsed.id || `resend-${Date.now()}`,
                  delivered: true,
                  driver: 'resend',
                });
              } catch {
                resolve({
                  messageId: `resend-${Date.now()}`,
                  delivered: true,
                  driver: 'resend',
                });
              }
            } else {
              reject(new Error(`[ResendMail] API грешка (${res.statusCode}): ${responseBody}`));
            }
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('[ResendMail] Заявката към Resend API изтече по време (timeout)'));
      });

      req.on('error', (err) => {
        reject(new Error(`[ResendMail] Мрежова грешка: ${err.message}`));
      });

      req.write(payload);
      req.end();
    });
  }
}
