import { Injectable } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type {
  IStorageProvider,
  PresignedDownload,
  PresignedUpload,
  StoredObjectInfo,
} from './storage.provider.js';

export interface S3Settings {
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/**
 * Real storage provider (AWS S3). The bucket must be private: every download goes through a
 * short-lived signed URL that the media module only issues after an access check.
 *
 * The upload URL signs `Content-Type` and `Content-Length`, so S3 rejects an upload whose type
 * or size differs from what was requested. `maxBytes` is the exact size the client declared.
 */
@Injectable()
export class S3StorageProvider implements IStorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(settings: S3Settings) {
    this.bucket = settings.bucket;
    this.client = new S3Client({
      region: settings.region,
      credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
    });
  }

  async createPresignedUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.maxBytes,
      }),
      { expiresIn: input.expiresInSeconds, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      key: input.key,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async createPresignedDownload(key: string, expiresInSeconds: number): Promise<PresignedDownload> {
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseCacheControl: `private, max-age=${expiresInSeconds}`,
      }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  async headObject(key: string): Promise<StoredObjectInfo> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return { exists: true, sizeBytes: head.ContentLength, contentType: head.ContentType };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error as { name?: string }).name === 'NotFound') {
        return { exists: false };
      }
      throw error;
    }
  }

  async getObject(key: string): Promise<Buffer> {
    const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await response.Body!.transformToByteArray());
  }

  async putObject(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ServerSideEncryption: 'AES256',
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
