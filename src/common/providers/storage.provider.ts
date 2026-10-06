/**
 * Cloud storage provider interface
 */

export interface UploadResult {
  success: boolean;
  url?: string;
  key?: string;
  error?: string;
}

export interface SignedUrlResult {
  success: boolean;
  url?: string;
  expiresAt?: Date;
  error?: string;
}

export interface IStorageProvider {
  /**
   * Upload file to storage
   */
  upload(
    key: string,
    buffer: Buffer,
    contentType: string,
    metadata?: Record<string, string>,
  ): Promise<UploadResult>;

  /**
   * Generate a signed URL for accessing a file
   */
  getSignedUrl(key: string, expiresInSeconds: number): Promise<SignedUrlResult>;

  /**
   * Delete a file from storage
   */
  delete(key: string): Promise<{ success: boolean; error?: string }>;

  /**
   * Check if a file exists
   */
  exists(key: string): Promise<boolean>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
