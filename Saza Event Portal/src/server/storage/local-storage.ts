// src/server/storage/local-storage.ts
// Локален filesystem storage адаптер — за разработка и тестване
// Файловете се записват в: STORAGE_LOCAL_DIR/{objectKey}

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { StorageAdapter, UploadResult, DownloadResult } from './storage-adapter.ts';

export class LocalStorageAdapter implements StorageAdapter {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = path.resolve(baseDir);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private resolvePath(objectKey: string): string {
    // Сигурност: нормализираме пътя и проверяваме за path traversal
    const normalized = path.normalize(objectKey).replace(/^(\.\.(\/|\\|$))+/, '');
    return path.join(this.baseDir, normalized);
  }

  async upload(params: {
    objectKey: string;
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  }): Promise<UploadResult> {
    const filePath = this.resolvePath(params.objectKey);
    const dir = path.dirname(filePath);

    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(filePath, params.buffer);

    const sha256 = crypto.createHash('sha256').update(params.buffer).digest('hex');

    return {
      objectKey: params.objectKey,
      byteSize: params.buffer.byteLength,
      sha256,
    };
  }

  async download(objectKey: string): Promise<DownloadResult> {
    const filePath = this.resolvePath(objectKey);

    if (!fs.existsSync(filePath)) {
      throw new Error(`[LocalStorage] Файлът не е намерен: ${objectKey}`);
    }

    const stat = await fsp.stat(filePath);
    const stream = fs.createReadStream(filePath) as unknown as NodeJS.ReadableStream;

    // Определяме MIME типа по разширение (опростено)
    const ext = path.extname(objectKey).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
    };

    return {
      stream,
      mimeType: mimeMap[ext] ?? 'application/octet-stream',
      byteSize: stat.size,
      filename: path.basename(objectKey),
    };
  }

  async exists(objectKey: string): Promise<boolean> {
    const filePath = this.resolvePath(objectKey);
    return fs.existsSync(filePath);
  }

  async delete(objectKey: string): Promise<void> {
    const filePath = this.resolvePath(objectKey);
    if (fs.existsSync(filePath)) {
      await fsp.unlink(filePath);
    }
  }

  /** Локален driver не поддържа presigned URLs — връща file:// URL за dev */
  async presignedUrl(objectKey: string, _expiresInSeconds = 3600): Promise<string> {
    return `/api/documents/download/${encodeURIComponent(objectKey)}`;
  }
}
