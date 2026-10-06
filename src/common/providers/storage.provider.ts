/**
 * Object storage provider interface (Backend PRD section 23).
 *
 * File bytes do not pass through the API: clients upload and download
 * directly with presigned URLs. The backend only issues those URLs, checks an
 * uploaded object (head), and reads or writes objects inside workers and the
 * verification service.
 */

export interface PresignedUpload {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the upload. */
  headers: Record<string, string>;
  key: string;
  expiresAt: Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface StoredObjectInfo {
  exists: boolean;
  sizeBytes?: number;
  contentType?: string;
}

export interface IStorageProvider {
  /** URL the client uploads to. The size and type limits are enforced by the signature. */
  createPresignedUpload(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    expiresInSeconds: number;
  }): Promise<PresignedUpload>;

  /** Short-lived URL the client downloads from. */
  createPresignedDownload(
    key: string,
    expiresInSeconds: number,
  ): Promise<PresignedDownload>;

  /** Existence, size and type of an uploaded object, used by the confirm step. */
  headObject(key: string): Promise<StoredObjectInfo>;

  /** Read an object. Used only by workers and the verification service. */
  getObject(key: string): Promise<Buffer>;

  /** Write an object. Used only by the media worker for processed output. */
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;

  deleteObject(key: string): Promise<void>;
}

export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');
