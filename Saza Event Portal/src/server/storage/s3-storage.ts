// src/server/storage/s3-storage.ts
// S3-compatible storage адаптер (AWS S3 / Cloudflare R2 / MinIO)
// Имплементиран с native Node.js https без external SDK за минимални зависимости.
// За продукция препоръчваме @aws-sdk/client-s3 — вижте коментарите по-долу.

import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';
import type { StorageAdapter, UploadResult, DownloadResult } from './storage-adapter.ts';

interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  publicUrl?: string;
}

/**
 * AWS Signature V4 signing
 * Имплементиран нативно за да избегнем зависимост от @aws-sdk в dev среда.
 * ВАЖНО: За продукционна среда инсталирайте `@aws-sdk/client-s3` и `@aws-sdk/s3-request-presigner`
 * и заменете тази имплементация.
 */
export class S3StorageAdapter implements StorageAdapter {
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;
    if (!config.endpoint || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
      throw new Error('[S3Storage] Непълна S3 конфигурация. Проверете .env файла.');
    }
  }

  private hmac(key: Buffer | string, data: string): Buffer {
    return crypto.createHmac('sha256', key).update(data).digest();
  }

  private sha256Hex(data: Buffer | string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  private getSigningKey(dateStamp: string): Buffer {
    const kDate = this.hmac(`AWS4${this.config.secretAccessKey}`, dateStamp);
    const kRegion = this.hmac(kDate, this.config.region);
    const kService = this.hmac(kRegion, 's3');
    return this.hmac(kService, 'aws4_request');
  }

  private buildAuthHeader(params: {
    method: string;
    objectKey: string;
    contentHash: string;
    contentType?: string;
    amzDate: string;
    dateStamp: string;
  }): string {
    const host = new URL(this.config.endpoint).host;
    const canonicalUri = `/${this.config.bucket}/${params.objectKey}`;
    const canonicalQuerystring = '';

    const headers: Record<string, string> = {
      'host': host,
      'x-amz-content-sha256': params.contentHash,
      'x-amz-date': params.amzDate,
    };
    if (params.contentType) {
      headers['content-type'] = params.contentType;
    }

    const sortedHeaderKeys = Object.keys(headers).sort();
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headers[k]}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      params.method,
      canonicalUri,
      canonicalQuerystring,
      canonicalHeaders,
      signedHeaders,
      params.contentHash,
    ].join('\n');

    const credentialScope = `${params.dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      params.amzDate,
      credentialScope,
      this.sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = this.hmac(this.getSigningKey(params.dateStamp), stringToSign).toString('hex');

    return `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  }

  private async request(options: {
    method: string;
    objectKey: string;
    body?: Buffer;
    contentType?: string;
  }): Promise<{ statusCode: number; body: Buffer; headers: Record<string, string> }> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const contentHash = this.sha256Hex(options.body ?? Buffer.alloc(0));
    const endpointUrl = new URL(this.config.endpoint);

    const authHeader = this.buildAuthHeader({
      method: options.method,
      objectKey: options.objectKey,
      contentHash,
      contentType: options.contentType,
      amzDate,
      dateStamp,
    });

    const reqHeaders: Record<string, string> = {
      'Authorization': authHeader,
      'x-amz-content-sha256': contentHash,
      'x-amz-date': amzDate,
      'Host': endpointUrl.host,
    };
    if (options.contentType) reqHeaders['Content-Type'] = options.contentType;
    if (options.body) reqHeaders['Content-Length'] = String(options.body.byteLength);

    const requestOptions = {
      hostname: endpointUrl.hostname,
      port: endpointUrl.port || (endpointUrl.protocol === 'https:' ? 443 : 80),
      path: `/${this.config.bucket}/${options.objectKey}`,
      method: options.method,
      headers: reqHeaders,
    };

    return new Promise((resolve, reject) => {
      const protocol = endpointUrl.protocol === 'https:' ? https : http;
      const req = protocol.request(requestOptions, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({
          statusCode: res.statusCode ?? 0,
          body: Buffer.concat(chunks),
          headers: res.headers as Record<string, string>,
        }));
      });
      req.on('error', reject);
      if (options.body) req.write(options.body);
      req.end();
    });
  }

  async upload(params: {
    objectKey: string;
    buffer: Buffer;
    mimeType: string;
    originalName: string;
  }): Promise<UploadResult> {
    const sha256 = this.sha256Hex(params.buffer);

    const result = await this.request({
      method: 'PUT',
      objectKey: params.objectKey,
      body: params.buffer,
      contentType: params.mimeType,
    });

    if (result.statusCode !== 200 && result.statusCode !== 204) {
      throw new Error(`[S3Storage] Upload неуспешен: HTTP ${result.statusCode} — ${result.body.toString()}`);
    }

    const publicUrl = this.config.publicUrl
      ? `${this.config.publicUrl}/${params.objectKey}`
      : undefined;

    return {
      objectKey: params.objectKey,
      publicUrl,
      byteSize: params.buffer.byteLength,
      sha256,
    };
  }

  async download(objectKey: string): Promise<DownloadResult> {
    const result = await this.request({ method: 'GET', objectKey });

    if (result.statusCode !== 200) {
      throw new Error(`[S3Storage] Download неуспешен: HTTP ${result.statusCode}`);
    }

    const mimeType = result.headers['content-type'] ?? 'application/octet-stream';
    const ext = objectKey.split('.').pop()?.toLowerCase();
    const filename = `${objectKey.split('/').pop() ?? 'file'}.${ext ?? 'bin'}`;

    const { Readable } = await import('node:stream');
    const stream = Readable.from(result.body) as unknown as NodeJS.ReadableStream;

    return {
      stream,
      mimeType,
      byteSize: result.body.byteLength,
      filename,
    };
  }

  async exists(objectKey: string): Promise<boolean> {
    const result = await this.request({ method: 'HEAD', objectKey });
    return result.statusCode === 200;
  }

  async delete(objectKey: string): Promise<void> {
    const result = await this.request({ method: 'DELETE', objectKey });
    if (result.statusCode !== 204 && result.statusCode !== 200) {
      throw new Error(`[S3Storage] Delete неуспешен: HTTP ${result.statusCode}`);
    }
  }

  async presignedUrl(objectKey: string, expiresInSeconds = 3600): Promise<string> {
    // Presigned URL генерация за S3
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const expiresStr = String(expiresInSeconds);
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const credential = `${this.config.accessKeyId}/${credentialScope}`;
    const endpointUrl = new URL(this.config.endpoint);

    const queryParams = [
      `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
      `X-Amz-Credential=${encodeURIComponent(credential)}`,
      `X-Amz-Date=${amzDate}`,
      `X-Amz-Expires=${expiresStr}`,
      `X-Amz-SignedHeaders=host`,
    ].join('&');

    const canonicalRequest = [
      'GET',
      `/${this.config.bucket}/${objectKey}`,
      queryParams,
      `host:${endpointUrl.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      this.sha256Hex(canonicalRequest),
    ].join('\n');

    const signature = this.hmac(this.getSigningKey(dateStamp), stringToSign).toString('hex');

    return `${this.config.endpoint}/${this.config.bucket}/${objectKey}?${queryParams}&X-Amz-Signature=${signature}`;
  }
}
