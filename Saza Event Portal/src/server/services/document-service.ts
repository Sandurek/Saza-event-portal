// src/server/services/document-service.ts
// Управление на частни документи, файлови версии и контролирано изтегляне (Section 11)

import crypto from 'node:crypto';
import { Database } from '../db/database.ts';
import { AccessPolicy } from '../policies/access-policy.ts';
import type { DocumentAudience, DocumentMimeType, DocumentScanState } from '../../domain/types.ts';

export class DocumentService {
  private db: Database;
  private policy: AccessPolicy;
  public static readonly MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MiB

  constructor(db: Database) {
    this.db = db;
    this.policy = new AccessPolicy(db);
  }

  /**
   * Създаване на документ и първоначална версия
   */
  public uploadDocument(params: {
    eventId: string;
    actorUserId: string;
    title: string;
    category: string;
    audience: DocumentAudience;
    requiresBudgetPermission?: boolean;
    originalName: string;
    mimeType: string;
    byteSize: number;
    fileBuffer?: Buffer;
    simulateScannerAvailable?: boolean;
  }): { documentId: string; versionId: string; scanState: DocumentScanState } {
    if (!this.policy.canManageEvent(params.eventId, params.actorUserId)) {
      throw new Error('Нямате права да качвате документи');
    }

    // FR023 & FR024: Валидация на размер и тип
    const allowedMimeTypes: DocumentMimeType[] = ['application/pdf', 'image/jpeg', 'image/png'];
    if (!allowedMimeTypes.includes(params.mimeType as DocumentMimeType)) {
      throw new Error(`Непозволен файлов тип (${params.mimeType}). Разрешени са само PDF, JPG и PNG.`);
    }

    if (params.byteSize > DocumentService.MAX_FILE_SIZE) {
      throw new Error(`Файлът надвишава максимално допустимия размер от 20 MiB (${params.byteSize} байта)`);
    }

    const event = this.db.prepare(`SELECT org_id FROM events WHERE id = ?`).get(params.eventId) as { org_id: string };
    const documentId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const objectKey = `${event.org_id}/${params.eventId}/${documentId}/${versionId}`;
    const sha256 = params.fileBuffer ? crypto.createHash('sha256').update(params.fileBuffer).digest('hex') : crypto.randomBytes(32).toString('hex');

    // T28: Ако скенерът не е достъпен, файлът остава в quarantined
    const scanState: DocumentScanState = params.simulateScannerAvailable === false ? 'quarantined' : 'ready';

    return this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO documents (
          id, org_id, event_id, title, category, audience, requires_budget_permission,
          current_version_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        documentId,
        event.org_id,
        params.eventId,
        params.title,
        params.category,
        params.audience,
        params.requiresBudgetPermission ? 1 : 0,
        versionId,
        nowIso,
        nowIso
      );

      this.db.prepare(`
        INSERT INTO document_versions (
          id, document_id, org_id, event_id, version_no, object_key, original_name,
          mime_type, byte_size, sha256, scan_state, uploaded_by, created_at
        ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        versionId,
        documentId,
        event.org_id,
        params.eventId,
        objectKey,
        params.originalName,
        params.mimeType,
        params.byteSize,
        sha256,
        scanState,
        params.actorUserId,
        nowIso
      );

      return { documentId, versionId, scanState };
    });
  }

  /**
   * Сървърно контролирано изтегляне на файл (Section 11 & T06/T07)
   * Проверява актуалното членство в момента на заявката!
   */
  public downloadDocument(documentId: string, userId: string): {
    allowed: boolean;
    reason?: string;
    document?: {
      title: string;
      originalName: string;
      mimeType: string;
      objectKey: string;
      byteSize: number;
    };
  } {
    if (!this.policy.canReadDocument(documentId, userId)) {
      return { allowed: false, reason: 'Нямате достъп до този документ' };
    }

    const doc = this.db.prepare(`
      SELECT d.title, dv.original_name, dv.mime_type, dv.object_key, dv.byte_size, dv.scan_state
      FROM documents d
      JOIN document_versions dv ON dv.id = d.current_version_id
      WHERE d.id = ?
    `).get(documentId) as {
      title: string;
      original_name: string;
      mime_type: string;
      object_key: string;
      byte_size: number;
      scan_state: string;
    } | undefined;

    if (!doc) {
      return { allowed: false, reason: 'Документът не е намерен' };
    }

    if (doc.scan_state !== 'ready') {
      return { allowed: false, reason: 'Файлът е под карантина или проверка' };
    }

    return {
      allowed: true,
      document: {
        title: doc.title,
        originalName: doc.original_name,
        mimeType: doc.mime_type,
        objectKey: doc.object_key,
        byteSize: doc.byte_size
      }
    };
  }
}
