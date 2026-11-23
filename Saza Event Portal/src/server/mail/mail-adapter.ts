// src/server/mail/mail-adapter.ts
// Абстрактен интерфейс за изпращане на имейл известия (Section 12 & 13)

export interface SendMailOptions {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  from?: string;
  replyTo?: string;
}

export interface SendMailResult {
  messageId: string;
  delivered: boolean;
  driver: string;
  error?: string;
}

export interface MailAdapter {
  sendMail(options: SendMailOptions): Promise<SendMailResult>;
}
