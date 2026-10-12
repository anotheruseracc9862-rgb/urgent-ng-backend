import { ProviderError } from './provider.error.js';
import type { IOtpProvider, OtpDeliveryResult } from './otp.provider.js';
import type { IEmailProvider } from './email.provider.js';

export interface TermiiSettings {
  apiKey: string;
  /** The registered sender id shown on the phone. */
  senderId: string;
  baseUrl?: string;
  /** `generic` works for most numbers; `dnd` reaches numbers on the do-not-disturb list. */
  channel?: 'generic' | 'dnd' | 'whatsapp';
  timeoutMs?: number;
}

type FetchLike = typeof fetch;

const message = (code: string) => `Your Urgent.ng code is ${code}. Do not share it with anyone.`;

/**
 * One-time codes: SMS through Termii's HTTP API, email through the email provider. A refused
 * message is a result (`success: false`); a network error, a timeout or a 5xx is a `ProviderError`
 * so the caller can tell "try again" from "this number cannot receive it".
 */
export class TermiiOtpProvider implements IOtpProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly settings: TermiiSettings,
    private readonly email: IEmailProvider | null,
    options: { fetchImpl?: FetchLike } = {},
  ) {
    this.baseUrl = (settings.baseUrl ?? 'https://api.ng.termii.com').replace(/\/$/, '');
    this.timeoutMs = settings.timeoutMs ?? 10_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async sendSms(phone: string, code: string): Promise<OtpDeliveryResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/api/sms/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Termii wants the number without the plus sign: 2348030000000.
        body: JSON.stringify({
          to: phone.replace(/^\+/, ''),
          from: this.settings.senderId,
          sms: message(code),
          type: 'plain',
          channel: this.settings.channel ?? 'generic',
          api_key: this.settings.apiKey,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError('sms', 'Could not reach the SMS provider.', { retryable: true, cause: error });
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ProviderError('sms', `The SMS provider answered ${response.status}.`, { retryable: true });
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (response.ok && body && (body.code === 'ok' || typeof body.message_id === 'string')) {
      return { success: true, messageId: String(body.message_id ?? body.message_id_str ?? '') };
    }
    // A 4xx is the provider refusing this message (bad number, no balance, sender not approved).
    return { success: false, error: typeof body?.message === 'string' ? body.message : `The SMS provider answered ${response.status}.` };
  }

  async sendEmail(email: string, code: string): Promise<OtpDeliveryResult> {
    if (!this.email) {
      return { success: false, error: 'Email delivery is not configured.' };
    }
    const result = await this.email.send({
      to: email,
      subject: 'Your Urgent.ng code',
      text: message(code),
      html: `<p>Your Urgent.ng code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p><p>Do not share it with anyone. If you did not ask for it, ignore this email.</p>`,
    });
    return { success: result.success, messageId: result.messageId, error: result.error };
  }
}
