import { describe, it, expect } from 'vitest';
import { TermiiOtpProvider } from './termii-otp.provider.js';
import type { IEmailProvider } from './email.provider.js';

function setup(responses: Array<{ status?: number; json?: unknown; throws?: Error }>) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const queue = [...responses];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    const next = queue.shift() ?? { json: { code: 'ok', message_id: 'm1' } };
    if (next.throws) throw next.throws;
    return new Response(JSON.stringify(next.json ?? {}), { status: next.status ?? 200 });
  }) as unknown as typeof fetch;
  const sent: Array<{ to: string; subject: string; text?: string }> = [];
  const email: IEmailProvider = {
    send: async (e) => {
      sent.push({ to: e.to, subject: e.subject, text: e.text });
      return { success: true, messageId: 'e1' };
    },
    sendMultiple: async () => [],
  };
  return { calls, sent, otp: new TermiiOtpProvider({ apiKey: 'K', senderId: 'Urgent' }, email, { fetchImpl }) };
}

describe('TermiiOtpProvider', () => {
  it('sends the code as a plain SMS to the number without the plus sign', async () => {
    const { otp, calls } = setup([{ json: { code: 'ok', message_id: 'abc', message: 'Successfully Sent' } }]);
    expect(await otp.sendSms('+2348030000000', '123456')).toEqual({ success: true, messageId: 'abc' });
    expect(calls[0].url).toBe('https://api.ng.termii.com/api/sms/send');
    expect(calls[0].body).toMatchObject({ to: '2348030000000', from: 'Urgent', type: 'plain', channel: 'generic', api_key: 'K' });
    expect(String(calls[0].body.sms)).toContain('123456');
  });

  it('answers a refusal as a result and a network or server failure as a retryable error', async () => {
    const { otp } = setup([{ status: 400, json: { message: 'Insufficient balance' } }, { status: 503 }, { throws: new Error('ECONNRESET') }]);
    expect(await otp.sendSms('+2348030000000', '1')).toEqual({ success: false, error: 'Insufficient balance' });
    await expect(otp.sendSms('+2348030000000', '1')).rejects.toMatchObject({ name: 'ProviderError', options: { retryable: true } });
    await expect(otp.sendSms('+2348030000000', '1')).rejects.toMatchObject({ name: 'ProviderError', options: { retryable: true } });
  });

  it('sends the email code through the email provider', async () => {
    const { otp, sent } = setup([]);
    expect(await otp.sendEmail('ada@example.com', '654321')).toMatchObject({ success: true });
    expect(sent[0]).toMatchObject({ to: 'ada@example.com', subject: 'Your Urgent.ng code' });
    expect(sent[0].text).toContain('654321');
  });

  it('reports email as not configured when there is no email provider', async () => {
    const otp = new TermiiOtpProvider({ apiKey: 'K', senderId: 'U' }, null);
    expect(await otp.sendEmail('a@b.co', '1')).toMatchObject({ success: false });
  });
});
