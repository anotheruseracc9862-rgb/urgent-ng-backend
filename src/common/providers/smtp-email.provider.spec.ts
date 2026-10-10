import { describe, expect, it, vi } from 'vitest';
import { SmtpEmailProvider } from './smtp-email.provider.js';

const settings = { host: 'smtp.example.test', port: 465, user: 'u', pass: 'p', from: 'Urgent.ng <no-reply@urgent.ng>' };
const email = { to: 'ada@example.com', subject: 'Hello', html: '<p>Hi</p>', text: 'Hi' };

describe('SmtpEmailProvider', () => {
  it('sends with the default From address and returns the message id', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<abc@example>', rejected: [] });
    const provider = new SmtpEmailProvider(settings, { sendMail } as never);

    const result = await provider.send(email);

    expect(result).toEqual({ success: true, messageId: '<abc@example>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: settings.from, to: 'ada@example.com', subject: 'Hello' }));
  });

  it('uses the sender given on the message', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x', rejected: [] });
    await new SmtpEmailProvider(settings, { sendMail } as never).send({ ...email, from: 'Support <help@urgent.ng>' });
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ from: 'Support <help@urgent.ng>' }));
  });

  it('reports a rejected address as a failure', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: 'x', rejected: ['ada@example.com'] });
    const result = await new SmtpEmailProvider(settings, { sendMail } as never).send(email);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/rejected/);
  });

  it('turns a transport error into a failed result without throwing, and without the recipient or body', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:465'));
    const result = await new SmtpEmailProvider(settings, { sendMail } as never).send(email);
    expect(result).toEqual({ success: false, error: 'connect ECONNREFUSED 10.0.0.1:465' });
    expect(JSON.stringify(result)).not.toContain('ada@example.com');
  });

  it('sends several in order and keeps each result', async () => {
    const sendMail = vi.fn().mockResolvedValueOnce({ messageId: '1', rejected: [] }).mockRejectedValueOnce(new Error('boom'));
    const results = await new SmtpEmailProvider(settings, { sendMail } as never).sendMultiple([email, email]);
    expect(results.map((r) => r.success)).toEqual([true, false]);
  });
});
