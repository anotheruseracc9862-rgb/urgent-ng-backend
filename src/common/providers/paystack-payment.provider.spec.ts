import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { PaystackPaymentProvider } from './paystack-payment.provider.js';
import { ProviderError } from './provider.error.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function provider(responses: Array<{ status?: number; json?: unknown; throws?: Error }>, settings: { webhookSecret?: string } = {}) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const next = queue.shift() ?? { status: 200, json: { status: true, data: {} } };
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { calls, subject: new PaystackPaymentProvider({ secretKey: 'sk_test_abc', baseUrl: 'https://paystack.test', ...settings }, { fetchImpl }) };
}

describe('PaystackPaymentProvider (Backend PRD 22.2)', () => {
  it('opens a checkout in kobo with the bearer key', async () => {
    const { calls, subject } = provider([
      { json: { status: true, data: { authorization_url: 'https://checkout.paystack.com/x', access_code: 'ac_1', reference: 'UNG-1' } } },
    ]);

    const result = await subject.initializeTransaction({ email: 'a@b.ng', amountKobo: 500_000, reference: 'UNG-1', metadata: { orderId: 'o1' } });

    expect(result).toEqual({ authorizationUrl: 'https://checkout.paystack.com/x', accessCode: 'ac_1', reference: 'UNG-1' });
    expect(calls[0]).toMatchObject({ url: 'https://paystack.test/transaction/initialize', method: 'POST' });
    expect(calls[0].headers.Authorization).toBe('Bearer sk_test_abc');
    expect(calls[0].body).toMatchObject({ email: 'a@b.ng', amount: 500_000, reference: 'UNG-1', currency: 'NGN' });
  });

  it('maps a verified transaction, keeping a reusable authorisation only', async () => {
    const { subject, calls } = provider([
      {
        json: {
          status: true,
          data: {
            status: 'success',
            reference: 'UNG-1',
            amount: 500_000,
            paid_at: '2026-10-12T08:00:00.000Z',
            customer: { email: 'a@b.ng' },
            authorization: { authorization_code: 'AUTH_x', reusable: true },
          },
        },
      },
      { json: { status: true, data: { status: 'success', reference: 'UNG-2', amount: 100, authorization: { authorization_code: 'AUTH_y', reusable: false } } } },
    ]);

    const first = await subject.verifyTransaction('UNG-1');
    const second = await subject.verifyTransaction('UNG-2');

    expect(first).toMatchObject({ status: 'success', amountKobo: 500_000, authorizationCode: 'AUTH_x', customerEmail: 'a@b.ng' });
    expect(first.paidAt?.toISOString()).toBe('2026-10-12T08:00:00.000Z');
    expect(second.authorizationCode).toBeUndefined();
    expect(calls[0].url).toBe('https://paystack.test/transaction/verify/UNG-1');
    expect(calls[0].method).toBe('GET');
  });

  it('maps every gateway status', async () => {
    const statuses: Array<[string, string]> = [
      ['success', 'success'],
      ['failed', 'failed'],
      ['reversed', 'failed'],
      ['abandoned', 'abandoned'],
      ['ongoing', 'pending'],
      ['pending', 'pending'],
      ['queued', 'pending'],
    ];
    for (const [given, expected] of statuses) {
      const { subject } = provider([{ json: { status: true, data: { status: given, reference: 'r', amount: 1 } } }]);
      expect((await subject.verifyTransaction('r')).status, given).toBe(expected);
    }
  });

  it('treats an unknown reference as nothing paid, not as a fault', async () => {
    const { subject } = provider([{ status: 404, json: { status: false, message: 'Transaction reference not found' } }]);

    expect(await subject.verifyTransaction('nope')).toEqual({ status: 'abandoned', reference: 'nope', amountKobo: 0 });
  });

  it('charges a saved authorisation', async () => {
    const { subject, calls } = provider([{ json: { status: true, data: { status: 'success', reference: 'UNG-R', amount: 500_000 } } }]);

    const result = await subject.chargeAuthorization({ email: 'a@b.ng', authorizationCode: 'AUTH_x', amountKobo: 500_000, reference: 'UNG-R' });

    expect(result).toMatchObject({ status: 'success', amountKobo: 500_000 });
    expect(calls[0].url).toBe('https://paystack.test/transaction/charge_authorization');
    expect(calls[0].body).toMatchObject({ authorization_code: 'AUTH_x', amount: 500_000, reference: 'UNG-R' });
  });

  it('refunds and maps the gateway answer', async () => {
    const processed = provider([{ json: { status: true, data: { id: 991, status: 'processed' } } }]);
    const pending = provider([{ json: { status: true, data: { id: 992, status: 'pending' } } }]);
    const failed = provider([{ json: { status: true, data: { id: 993, status: 'failed' } } }]);

    expect(await processed.subject.refund({ reference: 'UNG-1', amountKobo: 1000 })).toEqual({ providerRefundRef: '991', status: 'processed' });
    expect(processed.calls[0].body).toMatchObject({ transaction: 'UNG-1', amount: 1000 });
    expect((await pending.subject.refund({ reference: 'UNG-1' })).status).toBe('pending');
    expect((await failed.subject.refund({ reference: 'UNG-1' })).status).toBe('failed');
  });

  it('raises a provider error for a transport failure, a timeout, a server error and a refused key', async () => {
    const cases: Array<{ status?: number; json?: unknown; throws?: Error }> = [
      { throws: new Error('connect ECONNREFUSED') },
      { status: 503, json: {} },
      { status: 429, json: {} },
      { status: 401, json: { status: false, message: 'Invalid key' } },
    ];
    for (const one of cases) {
      const { subject } = provider([one]);
      await expect(subject.verifyTransaction('r')).rejects.toBeInstanceOf(ProviderError);
    }
  });

  it('marks a transport fault retryable, and a refused key not', async () => {
    const down = provider([{ status: 503, json: {} }]);
    const refused = provider([{ status: 401, json: { status: false } }]);

    await expect(down.subject.verifyTransaction('r')).rejects.toMatchObject({ retryable: true });
    await expect(refused.subject.verifyTransaction('r')).rejects.toMatchObject({ retryable: false });
  });

  it('verifies a webhook signature against the raw body, in constant time', () => {
    const { subject } = provider([]);
    const body = Buffer.from('{"event":"charge.success","data":{"reference":"UNG-1"}}');
    const good = createHmac('sha512', 'sk_test_abc').update(body).digest('hex');

    expect(subject.verifyWebhookSignature(body, good)).toBe(true);
    expect(subject.verifyWebhookSignature(body, good.toUpperCase())).toBe(true);
    expect(subject.verifyWebhookSignature(body, good.slice(0, -1) + (good.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(subject.verifyWebhookSignature(Buffer.from('{"event":"charge.success","data":{"reference":"UNG-2"}}'), good)).toBe(false);
    expect(subject.verifyWebhookSignature(body, '')).toBe(false);
    expect(subject.verifyWebhookSignature(body, 'short')).toBe(false);
  });

  it('signs with the webhook secret when one is set', () => {
    const { subject } = provider([], { webhookSecret: 'whsec_other' });
    const body = Buffer.from('{}');

    expect(subject.verifyWebhookSignature(body, createHmac('sha512', 'whsec_other').update(body).digest('hex'))).toBe(true);
    expect(subject.verifyWebhookSignature(body, createHmac('sha512', 'sk_test_abc').update(body).digest('hex'))).toBe(false);
  });
});
