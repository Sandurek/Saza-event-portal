// src/server/storage/storage-adapter.ts
// Абстрактен интерфейс за файлово хранилище
// Поддръжа: Local filesystem (dev) и S3-compatible (prod)

export interface UploadResult {
  objectKey: string;
  publicUrl?: string;
  byteSize: number;
  sha256: string;
}

export interface DownloadResult {
  stream: NodeJS.ReadableStream;
  mimeType: string;
  byteSize: number;
  filename: string;
}

export interface StorageAdapter {
  /** Записва файл и връща object key и SHA-256 хеш */
  upload(params: {
    objectKey: string;
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  }): Promise<UploadResult>;

  /** Изтегля файл по object key */
  download(objectKey: string): Promise<DownloadResult>;

  /** Проверява дали файлът съществува */
  exists(objectKey: string): Promise<boolean>;

  /** Изтрива файл (за rejected/deleted статуси) */
  delete(objectKey: string): Promise<void>;

  /** Генерира временен signed URL за изтегляне (само при S3) */
  presignedUrl?(objectKey: string, expiresInSeconds?: number): Promise<string>;
}
