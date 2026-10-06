/**
 * Fake storage provider for testing
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import { IStorageProvider, UploadResult, SignedUrlResult } from '../storage.provider.js';

@Injectable()
export class FakeStorageProvider extends BaseFake implements IStorageProvider {
  private storage = new Map<string, { buffer: Buffer; contentType: string; metadata?: Record<string, string> }>();

  async upload(
    key: string,
    buffer: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<UploadResult> {
    this.recordCall('upload', key, buffer, contentType, metadata);

    if (this.hasScriptedOutcome('upload')) {
      return this.getNextOutcome<UploadResult>('upload')!;
    }

    // Store in memory
    this.storage.set(key, { buffer, contentType, metadata });

    return {
      success: true,
      url: `https://fake-storage.com/${key}`,
      key,
    };
  }

  async getSignedUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult> {
    this.recordCall('getSignedUrl', key, expiresInSeconds);

    if (this.hasScriptedOutcome('getSignedUrl')) {
      return this.getNextOutcome<SignedUrlResult>('getSignedUrl')!;
    }

    const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

    return {
      success: true,
      url: `https://fake-storage.com/${key}?signature=fake&expires=${expiresAt.getTime()}`,
      expiresAt,
    };
  }

  async delete(key: string): Promise<{ success: boolean; error?: string }> {
    this.recordCall('delete', key);

    if (this.hasScriptedOutcome('delete')) {
      return this.getNextOutcome<{ success: boolean; error?: string }>('delete')!;
    }

    this.storage.delete(key);

    return { success: true };
  }

  async exists(key: string): Promise<boolean> {
    this.recordCall('exists', key);

    if (this.hasScriptedOutcome('exists')) {
      return this.getNextOutcome<boolean>('exists')!;
    }

    return this.storage.has(key);
  }

  override reset(): void {
    super.reset();
    this.storage.clear();
  }
}
