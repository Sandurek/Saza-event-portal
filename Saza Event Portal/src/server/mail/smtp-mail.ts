// src/server/mail/smtp-mail.ts
// Native Node.js SMTP Client (node:net & node:tls, без външни библиотеки като nodemailer)

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { MailAdapter, SendMailOptions, SendMailResult } from './mail-adapter.ts';

export interface SmtpConfig {
  host: string;
  port: number;
  secure?: boolean; // true за SSL/TLS (port 465)
  user?: string;
  pass?: string;
  defaultFrom?: string;
  timeoutMs?: number;
}

export class SmtpMailAdapter implements MailAdapter {
  private config: SmtpConfig;

  constructor(config: SmtpConfig) {
    this.config = {
      timeoutMs: 15000,
      ...config,
    };
  }

  private extractAddress(addr: string): string {
    const match = addr.match(/<([^>]+)>/);
    return (match ? match[1] : addr).trim();
  }

  async sendMail(options: SendMailOptions): Promise<SendMailResult> {
    const from = options.from || this.config.defaultFrom || 'portal@eventagency.test';
    const fromEnvelope = this.extractAddress(from);
    const recipients = (Array.isArray(options.to) ? options.to : [options.to]).map(r => r.trim()).filter(Boolean);
    if (recipients.length === 0) {
      throw new Error('[SMTP] Липсва получател за имейла');
    }
    const messageId = `<${Date.now()}.${crypto.randomBytes(8).toString('hex')}@${this.config.host}>`;

    return new Promise((resolve, reject) => {
      let socket: net.Socket | tls.TLSSocket;
      let buffer = '';
      let currentStep = 0;
      let rcptIndex = 0;
      let timer: NodeJS.Timeout;

      const cleanup = () => {
        clearTimeout(timer);
        if (socket && !socket.destroyed) {
          socket.destroy();
        }
      };

      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`[SMTP] Връзката към ${this.config.host}:${this.config.port} изтече по време`));
      }, this.config.timeoutMs);

      const send = (line: string) => {
        socket.write(`${line}\r\n`);
      };

      const handleReply = (code: number, line: string) => {
        // Проверка за SMTP статус грешки (4xx, 5xx)
        if (code >= 400) {
          cleanup();
          return reject(new Error(`[SMTP] Грешка ${code}: ${line}`));
        }

        switch (currentStep) {
          case 0: // Greeting
            if (code === 220) {
              currentStep = 1;
              send(`EHLO localhost`);
            }
            break;

          case 1: // EHLO response
            if (code === 250) {
              if (this.config.user && this.config.pass) {
                currentStep = 2;
                send('AUTH LOGIN');
              } else {
                currentStep = 4;
                send(`MAIL FROM:<${fromEnvelope}>`);
              }
            }
            break;

          case 2: // AUTH LOGIN Username prompt
            if (code === 334) {
              currentStep = 3;
              send(Buffer.from(this.config.user || '').toString('base64'));
            }
            break;

          case 3: // AUTH LOGIN Password prompt
            if (code === 334) {
              currentStep = 35; // wait for 235 Authentication successful
              send(Buffer.from(this.config.pass || '').toString('base64'));
            }
            break;

          case 35: // Auth success
            if (code === 235) {
              currentStep = 4;
              send(`MAIL FROM:<${fromEnvelope}>`);
            }
            break;

          case 4: // MAIL FROM ok
            if (code === 250) {
              currentStep = 5;
              rcptIndex = 0;
              send(`RCPT TO:<${this.extractAddress(recipients[rcptIndex])}>`);
            }
            break;

          case 5: // RCPT TO ok
            if (code === 250 || code === 251) {
              rcptIndex++;
              if (rcptIndex < recipients.length) {
                send(`RCPT TO:<${this.extractAddress(recipients[rcptIndex])}>`);
              } else {
                currentStep = 6;
                send('DATA');
              }
            }
            break;

          case 6: // DATA prompt
            if (code === 354) {
              currentStep = 7;
              const dateStr = new Date().toUTCString();
              const headers = [
                `From: ${from}`,
                `To: ${recipients.join(', ')}`,
                `Subject: ${options.subject}`,
                `Date: ${dateStr}`,
                `Message-ID: ${messageId}`,
                `MIME-Version: 1.0`,
                `Content-Type: text/html; charset=UTF-8`,
                `Content-Transfer-Encoding: 8bit`,
                '',
              ].join('\r\n');

              const rawBody = options.html || options.text || '';
              const safeBody = rawBody.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
              // SMTP Data end is CRLF.CRLF
              socket.write(`${headers}\r\n${safeBody}\r\n.\r\n`);
            }
            break;

          case 7: // Mail queued / accepted
            if (code === 250) {
              currentStep = 8;
              send('QUIT');
              cleanup();
              resolve({
                messageId,
                delivered: true,
                driver: 'smtp',
              });
            }
            break;
        }
      };

      const onData = (data: Buffer) => {
        buffer += data.toString('utf8');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() ?? ''; // оставяме непълния ред

        for (const line of lines) {
          if (!line) continue;
          // Код е първите 3 цифри. Ако 4-тият символ е тире '-', това е многоредов отговор
          const match = line.match(/^(\d{3})([ -])(.*)$/);
          if (match) {
            const code = parseInt(match[1], 10);
            const isMultiline = match[2] === '-';
            if (!isMultiline) {
              handleReply(code, line);
            }
          }
        }
      };

      if (this.config.secure) {
        socket = tls.connect(
          {
            host: this.config.host,
            port: this.config.port,
            rejectUnauthorized: false,
          },
          () => {}
        );
      } else {
        socket = net.connect(
          {
            host: this.config.host,
            port: this.config.port,
          },
          () => {}
        );
      }

      socket.on('data', onData);
      socket.on('error', (err) => {
        cleanup();
        reject(new Error(`[SMTP] Сокет грешка: ${err.message}`));
      });
    });
  }
}
