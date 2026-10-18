import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DojahKycProvider } from './dojah-kyc.provider.js';
import { FakeKycProvider } from './fakes/kyc.fake.js';
import type { KycVerifyResult } from './kyc.provider.js';

/**
 * Contract tests. A local server plays Dojah: it checks the request the adapter sends
 * (path, headers, body shape) and answers the way Dojah documents. The same normalised result
 * shape is asserted for the real adapter and for the fake.
 *
 * Not covered here: the live Dojah sandbox. Run the adapter against https://sandbox.dojah.io
 * with real sandbox credentials before launch.
 */

const NIN = '12345678901';
const SELFIE = 'c2VsZmllLWJ5dGVz';

type Handler = (req: IncomingMessage, body: Record<string, unknown>) => { status: number; body?: unknown; delayMs?: number; headers?: Record<string, string> };

describe('DojahKycProvider (contract)', () => {
  let server: Server;
  let baseUrl: string;
  let handler: Handler;
  let seen: Array<{ method?: string; url?: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }>;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Record<string, unknown>;
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        const answer = handler(req, body);
        setTimeout(() => {
          res.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
          res.end(JSON.stringify(answer.body ?? {}));
        }, answer.delayMs ?? 0);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  beforeEach(() => {
    seen = [];
  });

  const provider = (retryDelaysMs = [1, 1]) =>
    new DojahKycProvider({ appId: 'app-123', secretKey: 'secret-key-xyz', baseUrl }, { retryDelaysMs });
  const verify = (p = provider(), extra: { timeoutMs?: number } = {}) =>
    p.verifyNinWithSelfie({ nin: NIN, selfieImageBase64: SELFIE, threshold: 90, ...extra });
  const match = (value: boolean, confidence = 97.5) => ({ entity: { selfie_verification: { match: value, confidence_value: confidence } } });

  it('sends the documented request: path, raw Authorization, AppId and the three body fields', async () => {
    handler = () => ({ status: 200, body: match(true) });

    await verify();

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
    expect(seen[0].url).toBe('/api/v1/kyc/nin/verify');
    expect(seen[0].headers.authorization).toBe('secret-key-xyz');
    expect(seen[0].headers.appid).toBe('app-123');
    expect(seen[0].body).toEqual({ nin: NIN, selfie_image: SELFIE, threshold: 90 });
  });

  it('match = true: VERIFIED with the confidence, masked attributes and the registry name and date of birth', async () => {
    handler = () => ({
      status: 200,
      body: {
        entity: {
          first_name: 'ADA',
          last_name: 'OKAFOR',
          date_of_birth: '15-Apr-1985',
          phone_number: '08012345678',
          nin: NIN,
          selfie_verification: { match: true, confidence_value: 98.2 },
        },
      },
    });

    const result = await verify();

    expect(result).toMatchObject({
      outcome: 'VERIFIED',
      confidence: 98.2,
      countsAgainstAllowance: true,
      maskedAttributes: { ninLast4: '8901' },
      identity: { firstName: 'ADA', lastName: 'OKAFOR', dateOfBirth: '1985-04-15' },
    });
    // Nothing else from the record leaks: not the number, not the phone.
    expect(JSON.stringify(result)).not.toContain(NIN);
    expect(JSON.stringify(result)).not.toContain('08012345678');
  });

  it('match = true with the firstname/surname/birthdate shape reads the same record', async () => {
    handler = () => ({
      status: 200,
      body: { entity: { firstname: 'ADA', surname: 'OKAFOR', birthdate: '10-06-1983', selfie_verification: { match: true, confidence_value: 95 } } },
    });

    expect(await verify()).toMatchObject({ outcome: 'VERIFIED', identity: { firstName: 'ADA', lastName: 'OKAFOR', dateOfBirth: '1983-06-10' } });
  });

  it('match = true but no readable name or date: VERIFIED without identity (the service refuses it)', async () => {
    handler = () => ({ status: 200, body: match(true) });

    const result = await verify();

    expect(result.outcome).toBe('VERIFIED');
    expect(result.identity).toBeUndefined();
  });

  describe('BVN', () => {
    const BVN = '22222222222';
    const verifyBvn = (p = provider()) => p.verifyBvnWithSelfie({ bvn: BVN, selfieImageBase64: SELFIE, threshold: 90 });

    it('posts to the BVN path with the bvn field and masks as bvnLast4', async () => {
      handler = () => ({
        status: 200,
        body: {
          entity: {
            bvn: '2*****41123',
            first_name: 'JOHN',
            middle_name: 'DOE',
            last_name: 'MUSA',
            date_of_birth: '15-Apr-1985',
            selfie_verification: { match: true, confidence_value: 99.99 },
          },
        },
      });

      const result = await verifyBvn();

      expect(seen[0].url).toBe('/api/v1/kyc/bvn/verify');
      expect(seen[0].headers.authorization).toBe('secret-key-xyz');
      expect(seen[0].body).toEqual({ bvn: BVN, selfie_image: SELFIE, threshold: 90 });
      expect(result).toMatchObject({
        outcome: 'VERIFIED',
        maskedAttributes: { bvnLast4: '2222' },
        identity: { firstName: 'JOHN', middleName: 'DOE', lastName: 'MUSA', dateOfBirth: '1985-04-15' },
      });
      expect(JSON.stringify(result)).not.toContain(BVN);
    });

    it('maps the same failures as the NIN call', async () => {
      handler = () => ({ status: 200, body: match(false, 30) });
      expect(await verifyBvn()).toMatchObject({ failureReason: 'SELFIE_MISMATCH', countsAgainstAllowance: true });
      handler = () => ({ status: 404 });
      expect(await verifyBvn()).toMatchObject({ failureReason: 'IDENTITY_MISMATCH', countsAgainstAllowance: true });
      handler = () => ({ status: 402 });
      expect(await verifyBvn()).toMatchObject({ failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false });
    });
  });

  it('match = false: FAILED / SELFIE_MISMATCH, counts', async () => {
    handler = () => ({ status: 200, body: match(false, 41) });

    expect(await verify()).toMatchObject({ outcome: 'FAILED', failureReason: 'SELFIE_MISMATCH', confidence: 41, countsAgainstAllowance: true });
  });

  it('404: FAILED / IDENTITY_MISMATCH with detail ID_NOT_FOUND, counts', async () => {
    handler = () => ({ status: 404, body: { error: 'Record not found' } });

    expect(await verify()).toMatchObject({ outcome: 'FAILED', failureReason: 'IDENTITY_MISMATCH', failureDetail: 'ID_NOT_FOUND', countsAgainstAllowance: true });
  });

  it('400 about the NIN: DOCUMENT_INVALID; 400 about the image: INSUFFICIENT_DATA; both count', async () => {
    handler = () => ({ status: 400, body: { error: 'Invalid NIN' } });
    expect(await verify()).toMatchObject({ failureReason: 'DOCUMENT_INVALID', failureDetail: 'ID_INVALID', countsAgainstAllowance: true });

    handler = () => ({ status: 400, body: { error: 'selfie_image is not a valid base64 image' } });
    expect(await verify()).toMatchObject({ failureReason: 'INSUFFICIENT_DATA', failureDetail: 'SELFIE_UNUSABLE', countsAgainstAllowance: true });
  });

  it('400 "BVN Not Found": FAILED / IDENTITY_MISMATCH with detail ID_NOT_FOUND, counts', async () => {
    handler = () => ({ status: 400, body: { error: 'BVN Not Found' } });

    expect(await verify()).toMatchObject({ failureReason: 'IDENTITY_MISMATCH', failureDetail: 'ID_NOT_FOUND', countsAgainstAllowance: true });
  });

  it.each([401, 402])('%s: PROVIDER_ERROR, does not count', async (status) => {
    handler = () => ({ status, body: { error: 'nope' } });

    expect(await verify()).toMatchObject({ outcome: 'FAILED', failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false });
  });

  it('5xx: PROVIDER_ERROR, does not count', async () => {
    handler = () => ({ status: 503 });

    expect(await verify()).toMatchObject({ failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false });
  });

  it('200 without a match result is a provider error, never a verification', async () => {
    handler = () => ({ status: 200, body: { entity: {} } });

    expect(await verify()).toMatchObject({ outcome: 'FAILED', failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false });
  });

  it('429: retries with a pause, then succeeds', async () => {
    let calls = 0;
    handler = () => (++calls < 3 ? { status: 429 } : { status: 200, body: match(true) });

    const result = await verify(provider([1, 1]));

    expect(result.outcome).toBe('VERIFIED');
    expect(seen).toHaveLength(3);
  });

  it('429 on every try: PROVIDER_ERROR after the retries, does not count', async () => {
    handler = () => ({ status: 429 });

    const result = await verify(provider([1, 1]));

    expect(result).toMatchObject({ failureReason: 'PROVIDER_ERROR', countsAgainstAllowance: false });
    expect(seen).toHaveLength(3);
  });

  it('no answer within the timeout: PROVIDER_TIMEOUT, does not count', async () => {
    handler = () => ({ status: 200, body: match(true), delayMs: 400 });

    const result = await verify(provider(), { timeoutMs: 50 });

    expect(result).toMatchObject({ outcome: 'FAILED', failureReason: 'PROVIDER_TIMEOUT', countsAgainstAllowance: false });
  });

  it('a network failure is PROVIDER_ERROR', async () => {
    const dead = new DojahKycProvider({ appId: 'a', secretKey: 's', baseUrl: 'http://127.0.0.1:1' });

    expect(await dead.verifyNinWithSelfie({ nin: NIN, selfieImageBase64: SELFIE })).toMatchObject({
      failureReason: 'PROVIDER_ERROR',
      countsAgainstAllowance: false,
    });
  });

  it('never puts the NIN or the selfie in any result', async () => {
    for (const status of [200, 400, 404, 500]) {
      handler = () => ({ status, body: status === 200 ? match(true) : { error: `echo ${NIN} ${SELFIE}` } });
      const text = JSON.stringify(await verify());
      expect(text).not.toContain(NIN);
      expect(text).not.toContain(SELFIE);
    }
  });

  describe('same normalised shape as the fake', () => {
    const allowed = new Set(['outcome', 'failureReason', 'failureDetail', 'confidence', 'countsAgainstAllowance', 'providerRequestId', 'maskedAttributes', 'identity']);
    const assertShape = (result: KycVerifyResult) => {
      expect(Object.keys(result).filter((key) => !allowed.has(key))).toEqual([]);
      expect(['VERIFIED', 'FAILED']).toContain(result.outcome);
      expect(typeof result.countsAgainstAllowance).toBe('boolean');
      if (result.outcome === 'FAILED') expect(result.failureReason).toBeDefined();
      if (result.outcome === 'VERIFIED') expect(result.failureReason).toBeUndefined();
    };

    it('real adapter and fake agree on the shape for every outcome', async () => {
      const fake = new FakeKycProvider();
      for (const nin of ['12345670000', '12345671111', '12345678888', '12345679999', '12345678901']) {
        assertShape(await fake.verifyNinWithSelfie({ nin, selfieImageBase64: SELFIE }));
      }
      for (const answer of [{ status: 200, body: match(true) }, { status: 200, body: match(false) }, { status: 404 }, { status: 400 }, { status: 401 }, { status: 500 }]) {
        handler = () => answer;
        assertShape(await verify());
      }
    });

    it('both map the same situations to the same failure reasons', async () => {
      const fake = new FakeKycProvider();
      const pairs: Array<[string, { status: number; body?: unknown }]> = [
        ['12345670000', { status: 200, body: match(false) }],
        ['12345671111', { status: 404 }],
        ['12345679999', { status: 401 }],
      ];
      for (const [nin, answer] of pairs) {
        handler = () => answer;
        const fromFake = await fake.verifyNinWithSelfie({ nin, selfieImageBase64: SELFIE });
        const fromReal = await verify();
        expect(fromReal.failureReason).toBe(fromFake.failureReason);
        expect(fromReal.countsAgainstAllowance).toBe(fromFake.countsAgainstAllowance);
      }
    });
  });
});

/** Runs only when sandbox credentials are present (never in CI by default). */
describe.skipIf(!process.env.DOJAH_SANDBOX_APP_ID)('Dojah sandbox', () => {
  it('answers a sandbox request in the normalised shape', async () => {
    const real = new DojahKycProvider({
      appId: process.env.DOJAH_SANDBOX_APP_ID!,
      secretKey: process.env.DOJAH_SANDBOX_SECRET_KEY!,
      baseUrl: 'https://sandbox.dojah.io',
    });

    const result = await real.verifyNinWithSelfie({ nin: '70123456789', selfieImageBase64: SELFIE, threshold: 90 });

    expect(['VERIFIED', 'FAILED']).toContain(result.outcome);
  });
});
