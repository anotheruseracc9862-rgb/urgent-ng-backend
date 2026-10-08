import { describe, it, expect } from 'vitest';
import { S3StorageProvider } from './s3-storage.provider.js';

const provider = () => new S3StorageProvider({ region: 'us-east-1', bucket: 'b', accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret' });
const failWith = (target: S3StorageProvider, error: unknown) => {
  (target as unknown as { client: { send: () => Promise<never> } }).client = { send: () => Promise.reject(error) };
};

describe('S3StorageProvider.headObject', () => {
  it('answers "does not exist" for a 404', async () => {
    const s3 = provider();
    failWith(s3, Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    await expect(s3.headObject('k')).resolves.toEqual({ exists: false });
  });

  it('turns a 403 into an error that names the missing permission (a missing key looks like 403 without ListBucket)', async () => {
    const s3 = provider();
    failWith(s3, Object.assign(new Error('Forbidden'), { $metadata: { httpStatusCode: 403 } }));
    await expect(s3.headObject('k')).rejects.toThrow(/s3:ListBucket/);
  });

  it('passes other errors through', async () => {
    const s3 = provider();
    const boom = Object.assign(new Error('boom'), { $metadata: { httpStatusCode: 500 } });
    failWith(s3, boom);
    await expect(s3.headObject('k')).rejects.toBe(boom);
  });
});
