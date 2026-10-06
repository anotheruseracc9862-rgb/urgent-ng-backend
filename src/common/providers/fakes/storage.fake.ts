/**
 * Fake storage provider for testing.
 *
 * Objects live in memory. `simulateClientUpload` stands in for the browser
 * uploading to the presigned URL, so tests can walk the whole upload flow.
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import {
  IStorageProvider,
  PresignedDownload,
  PresignedUpload,
  StoredObjectInfo,
} from '../storage.provider.js';

@Injectable()
export class FakeStorageProvider extends BaseFake implements IStorageProvider {
  private objects = new Map<string, { body: Buffer; contentType: string }>();
  private maxBytesByKey = new Map<string, number>();

  async createPresignedUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload> {
    this.recordCall('createPresignedUpload', input);

    if (this.hasScriptedOutcome('createPresignedUpload')) {
      return this.getNextOutcome<PresignedUpload>('createPresignedUpload')!;
    }

    this.maxBytesByKey.set(input.key, input.maxBytes);
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);

    return {
      url: `https://fake-storage.local/upload/${input.key}?expires=${expiresAt.getTime()}`,
      method: 'PUT',
      headers: { 'Content-Type': input.contentType },
      key: input.key,
      expiresAt,
    };
  }

  async createPresignedDownload(
    key: string,
    expiresInSeconds: number,
  ): Promise<PresignedDownload> {
    this.recordCall('createPresignedDownload', key, expiresInSeconds);

    if (this.hasScriptedOutcome('createPresignedDownload')) {
      return this.getNextOutcome<PresignedDownload>('createPresignedDownload')!;
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
    return {
      url: `https://fake-storage.local/download/${key}?expires=${expiresAt.getTime()}`,
      expiresAt,
    };
  }

  async headObject(key: string): Promise<StoredObjectInfo> {
    this.recordCall('headObject', key);

    if (this.hasScriptedOutcome('headObject')) {
      return this.getNextOutcome<StoredObjectInfo>('headObject')!;
    }

    const object = this.objects.get(key);
    if (!object) {
      return { exists: false };
    }
    return {
      exists: true,
      sizeBytes: object.body.length,
      contentType: object.contentType,
    };
  }

  async getObject(key: string): Promise<Buffer> {
    this.recordCall('getObject', key);

    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`Object not found: ${key}`);
    }
    return object.body;
  }

  async putObject(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    this.recordCall('putObject', key, body.length, contentType);
    this.objects.set(key, { body, contentType });
  }

  async deleteObject(key: string): Promise<void> {
    this.recordCall('deleteObject', key);
    this.objects.delete(key);
  }

  /**
   * Test helper: behave like a browser PUT to the presigned URL. Enforces the
   * size limit the real signature would enforce.
   */
  simulateClientUpload(key: string, body: Buffer, contentType: string): void {
    const max = this.maxBytesByKey.get(key);
    if (max !== undefined && body.length > max) {
      throw new Error('Upload exceeds the size limit in the presigned URL');
    }
    this.objects.set(key, { body, contentType });
  }

  override reset(): void {
    super.reset();
    this.objects.clear();
    this.maxBytesByKey.clear();
  }
}
