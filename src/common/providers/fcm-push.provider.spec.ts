import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { FcmPushProvider, parseServiceAccount, type FetchLike } from './fcm-push.provider.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const account = { project_id: 'urgent-ng-test', client_email: 'push@urgent-ng-test.iam.gserviceaccount.com', private_key: privateKey };
const note = { token: 'device-token', title: 'Hello', body: 'World', data: { errandId: 'e-1' } };

const reply = (status: number, body: unknown) => ({ status, json: async () => body });

/** A fetch that answers the token exchange, then each FCM call in turn. */
function server(fcm: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const queue = [...fcm];
  const fetchImpl: FetchLike = vi.fn(async (url, init) => {
    calls.push({ url, headers: init.headers, body: init.body });
    if (url.includes('oauth2')) return reply(200, { access_token: `token-${calls.length}`, expires_in: 3600 });
    const next = queue.shift() ?? { status: 200, body: { name: 'projects/p/messages/default' } };
    return reply(next.status, next.body);
  });
  return { fetchImpl, calls };
}

describe('FcmPushProvider', () => {
  it('signs the service-account assertion, then posts the message with the access token', async () => {
    const { fetchImpl, calls } = server([{ status: 200, body: { name: 'projects/urgent-ng-test/messages/123' } }]);
    const provider = new FcmPushProvider(account, fetchImpl);

    const result = await provider.send(note);

    expect(result).toEqual({ success: true, messageId: 'projects/urgent-ng-test/messages/123' });
    const exchange = calls[0];
    const assertion = decodeURIComponent(exchange.body.split('assertion=')[1]);
    const [header, claims, signature] = assertion.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'RS256' });
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
    });
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);

    const send = calls[1];
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/urgent-ng-test/messages:send');
    expect(send.headers.Authorization).toBe('Bearer token-1');
    const message = JSON.parse(send.body).message;
    expect(message).toMatchObject({ token: 'device-token', notification: { title: 'Hello', body: 'World' }, data: { errandId: 'e-1' } });
    // Immediate delivery, and a day to reach a phone that is off.
    expect(message.android).toEqual({ priority: 'HIGH', ttl: '86400s' });
    expect(message.webpush.headers).toEqual({ Urgency: 'high', TTL: '86400' });
    expect(message.apns.headers['apns-priority']).toBe('10');
  });

  it('caches the access token between sends', async () => {
    const { fetchImpl, calls } = server([]);
    const provider = new FcmPushProvider(account, fetchImpl);
    await provider.send(note);
    await provider.send(note);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
  });

  it('asks for a new token after the old one expires', async () => {
    let clock = 1_000_000;
    const { fetchImpl, calls } = server([]);
    const provider = new FcmPushProvider(account, fetchImpl, () => clock);
    await provider.send(note);
    clock += 3_600_000;
    await provider.send(note);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
  });

  it('refreshes the token once when FCM answers 401', async () => {
    const { fetchImpl, calls } = server([
      { status: 401, body: { error: { status: 'UNAUTHENTICATED' } } },
      { status: 200, body: { name: 'projects/p/messages/1' } },
    ]);
    const result = await new FcmPushProvider(account, fetchImpl).send(note);
    expect(result.success).toBe(true);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
  });

  it.each([
    ['UNREGISTERED in details', 404, { error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }],
    ['404 without details', 404, { error: { status: 'NOT_FOUND' } }],
    ['malformed token', 400, { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not valid' } }],
  ])('marks the token invalid: %s', async (_name, status, body) => {
    const { fetchImpl } = server([{ status, body }]);
    const result = await new FcmPushProvider(account, fetchImpl).send(note);
    expect(result.success).toBe(false);
    expect(result.invalidToken).toBe(true);
  });

  it('does not mark the token invalid on a provider outage or throttle', async () => {
    for (const status of [429, 500, 503]) {
      const { fetchImpl } = server([{ status, body: { error: { status: 'UNAVAILABLE' } } }]);
      const result = await new FcmPushProvider(account, fetchImpl).send(note);
      expect(result.success, String(status)).toBe(false);
      expect(result.invalidToken, String(status)).toBe(false);
    }
  });

  it('turns a network failure into a failed result', async () => {
    const fetchImpl: FetchLike = vi.fn().mockRejectedValue(new Error('socket hang up'));
    const result = await new FcmPushProvider(account, fetchImpl).send(note);
    expect(result).toEqual({ success: false, error: 'socket hang up' });
  });

  it('omits the image when there is none and sends several in order', async () => {
    const { fetchImpl } = server([{ status: 200, body: { name: 'm1' } }, { status: 404, body: {} }]);
    const results = await new FcmPushProvider(account, fetchImpl).sendMultiple([note, note]);
    expect(results.map((r) => r.success)).toEqual([true, false]);
    expect(results[1].invalidToken).toBe(true);
  });
});

describe('parseServiceAccount', () => {
  const json = JSON.stringify({ project_id: 'p', client_email: 'e@p.iam', private_key: '-----BEGIN-----\\nabc\\n-----END-----' });

  it('reads plain JSON and base64 JSON, and restores escaped newlines in the key', () => {
    expect(parseServiceAccount(json).private_key).toContain('\nabc\n');
    expect(parseServiceAccount(Buffer.from(json).toString('base64')).project_id).toBe('p');
  });

  it('refuses an incomplete account', () => {
    expect(() => parseServiceAccount('{"project_id":"p"}')).toThrow(/client_email/);
  });
});
