// src/server/storage/storage-factory.ts
// Фабрика за файлово хранилище според конфигурацията (local fs vs S3)

import { config } from '../config/env.ts';
import type { StorageAdapter } from './storage-adapter.ts';
import { LocalStorageAdapter } from './local-storage.ts';
import { S3StorageAdapter } from './s3-storage.ts';

let defaultAdapter: StorageAdapter | null = null;

export function createStorageAdapter(forceNew = false): StorageAdapter {
  if (defaultAdapter && !forceNew) {
    return defaultAdapter;
  }

  let adapter: StorageAdapter;

  if (config.storage.driver === 's3') {
    adapter = new S3StorageAdapter({
      endpoint: config.storage.s3.endpoint,
      region: config.storage.s3.region,
      bucket: config.storage.s3.bucket,
      accessKeyId: config.storage.s3.accessKeyId,
      secretAccessKey: config.storage.s3.secretAccessKey,
      publicUrl: config.storage.s3.publicUrl,
    });
  } else {
    adapter = new LocalStorageAdapter(config.storage.local.dir);
  }

  if (!forceNew) {
    defaultAdapter = adapter;
  }

  return adapter;
}
