import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import type { MailAdapter } from '../mail/mail-adapter.ts';

export class OutboxWorker {
  private db: Database;
  private policy: AccessPolicy;
  private mailAdapter?: MailAdapter;

  constructor(db: Database, mailAdapter?: MailAdapter) {
    this.db = db;
    this.policy = new AccessPolicy(db);
    this.mailAdapter = mailAdapter;
  }

  private escapeHtml(input: string): string {
    return String(input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }

  /**
   * Атомарно заключване на партида чакащи или изтекли (stuck processing) записи
   */
  private claimPendingBatch(batchSize: number, nowIso: string, leaseUntil: string): {
    id: string;
    org_id: string;
    event_id: string | null;
    recipient_id: string;
    type: string;
    dedupe_key: string;
    attempts: number;
    payload: string;
  }[] {
    return this.db.transaction(() => {
      const items = this.db.prepare(`
        SELECT id, org_id, event_id, recipient_id, type, dedupe_key, attempts, payload
        FROM notification_outbox
        WHERE (
          ((state = 'pending' OR state = 'retry') AND available_at <= ? AND (lease_until IS NULL OR lease_until < ?))
          OR (state = 'processing' AND lease_until IS NOT NULL AND lease_until < ?)
        )
        LIMIT ?
      `).all(nowIso, nowIso, nowIso, batchSize) as {
        id: string;
        org_id: string;
        event_id: string | null;
        recipient_id: string;
        type: string;
        dedupe_key: string;
        attempts: number;
        payload: string;
      }[];

      for (const item of items) {
        this.db.prepare(`
          UPDATE notification_outbox SET lease_until = ?, state = 'processing', updated_at = ?
          WHERE id = ?
        `).run(leaseUntil, nowIso, item.id);
      }

      return items;
    });
  }

  /**
   * Обработка на партида от чакащи известия
   */
  public processBatch(batchSize: number = 10, simulateEmailFailure: boolean = false): {
    processed: number;
    sent: number;
    retried: number;
    droppedDueToRevocation: number;
  } {
    const nowIso = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 60000).toISOString(); // 1 минута lease

    let sent = 0;
    let retried = 0;
    let dropped = 0;

    // Взимане и заключване на чакащи записи с lease
    const records = this.claimPendingBatch(batchSize, nowIso, leaseUntil);

    for (const item of records) {
      // T32 & Section 12.3: Проверка на действащия достъп на получателя непосредствено преди изпращане!
      if (item.event_id) {
        const canRead = this.policy.canReadEvent(item.event_id, item.recipient_id);
        if (!canRead) {
          // Отнет достъп: прекратяваме изпращането без разкриване на данни
          this.db.prepare(`
            UPDATE notification_outbox 
            SET state = 'failed', last_error = 'Recipient access revoked prior to dispatch', lease_until = NULL, updated_at = ?
            WHERE id = ?
          `).run(new Date().toISOString(), item.id);
          dropped++;
          continue;
        }
      }

      // Симулация на грешка при изпращане (T30)
      if (simulateEmailFailure) {
        const nextAttempt = item.attempts + 1;
        const backoffSeconds = Math.pow(2, nextAttempt) * 5;
        const nextAvailableAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        const newState = nextAttempt >= 5 ? 'failed' : 'retry';

        this.db.prepare(`
          UPDATE notification_outbox 
          SET state = ?, attempts = ?, available_at = ?, lease_until = NULL, last_error = 'SMTP dispatch failed', updated_at = ?
          WHERE id = ?
        `).run(newState, nextAttempt, nextAvailableAt, new Date().toISOString(), item.id);
        retried++;
        continue;
      }

      // Успешно изпращане
      this.db.prepare(`
        UPDATE notification_outbox 
        SET state = 'sent', provider_message_id = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(`mock-msg-${item.id}`, new Date().toISOString(), item.id);
      sent++;
    }

    return {
      processed: records.length,
      sent,
      retried,
      droppedDueToRevocation: dropped
    };
  }

  /**
   * Асинхронна обработка на партида с реално изпращане през MailAdapter
   */
  public async processBatchAsync(batchSize: number = 10): Promise<{
    processed: number;
    sent: number;
    retried: number;
    droppedDueToRevocation: number;
  }> {
    const nowIso = new Date().toISOString();
    const leaseUntil = new Date(Date.now() + 60000).toISOString();

    let sent = 0;
    let retried = 0;
    let dropped = 0;

    const records = this.claimPendingBatch(batchSize, nowIso, leaseUntil);

    for (const item of records) {
      if (item.event_id) {
        const canRead = this.policy.canReadEvent(item.event_id, item.recipient_id);
        if (!canRead) {
          this.db.prepare(`
            UPDATE notification_outbox 
            SET state = 'failed', last_error = 'Recipient access revoked prior to dispatch', lease_until = NULL, updated_at = ?
            WHERE id = ?
          `).run(new Date().toISOString(), item.id);
          dropped++;
          continue;
        }
      }

      const profile = this.db.prepare(`
        SELECT email, display_name FROM profiles WHERE user_id = ?
      `).get(item.recipient_id) as { email: string; display_name: string } | undefined;

      const recipientEmail = profile?.email || `${item.recipient_id}@example.test`;
      const recipientName = profile?.display_name || 'Клиент';

      let parsedPayload: any = {};
      try {
        parsedPayload = JSON.parse(item.payload);
      } catch {
        parsedPayload = { raw: item.payload };
      }

      const subject = parsedPayload.subject || `Известие за събитие [${item.type}]`;
      const safeRecipientName = this.escapeHtml(recipientName);
      const safeMessage = this.escapeHtml(parsedPayload.message || 'Имате ново събитие в клиентския портал.');
      const htmlBody = `
        <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2>Здравейте, ${safeRecipientName}!</h2>
          <p>${safeMessage}</p>
          <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
          <p style="color: #64748b; font-size: 13px;">Saza Event Portal &bull; Система за управление на събития</p>
        </div>
      `;

      try {
        let providerMsgId = `mock-msg-${item.id}`;
        if (this.mailAdapter) {
          const sendRes = await this.mailAdapter.sendMail({
            to: recipientEmail,
            subject,
            html: htmlBody,
            text: parsedPayload.message || subject,
          });
          providerMsgId = sendRes.messageId;
        }

        this.db.prepare(`
          UPDATE notification_outbox 
          SET state = 'sent', provider_message_id = ?, lease_until = NULL, updated_at = ?
          WHERE id = ?
        `).run(providerMsgId, new Date().toISOString(), item.id);
        sent++;
      } catch (err: any) {
        const nextAttempt = item.attempts + 1;
        const backoffSeconds = Math.pow(2, nextAttempt) * 5;
        const nextAvailableAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        const newState = nextAttempt >= 5 ? 'failed' : 'retry';

        this.db.prepare(`
          UPDATE notification_outbox 
          SET state = ?, attempts = ?, available_at = ?, lease_until = NULL, last_error = ?, updated_at = ?
          WHERE id = ?
        `).run(newState, nextAttempt, nextAvailableAt, err.message, new Date().toISOString(), item.id);
        retried++;
      }
    }

    return {
      processed: records.length,
      sent,
      retried,
      droppedDueToRevocation: dropped,
    };
  }
}

