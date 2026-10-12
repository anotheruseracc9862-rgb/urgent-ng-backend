import { Logger } from '@nestjs/common';
import type { IOtpProvider, OtpDeliveryResult } from './otp.provider.js';
import type { IEmailProvider } from './email.provider.js';

/**
 * One-time codes for an environment that has no SMS vendor yet (development only): the code is
 * written to the backend log instead of being sent. Email codes still go out through the real email
 * provider when one is configured, and are logged otherwise.
 *
 * This writes a phone number and a live code to the log on purpose. It is never built in
 * production (the factory refuses and the environment check requires SMS keys there).
 */
export class LogOtpProvider implements IOtpProvider {
  private readonly logger = new Logger('OtpDelivery');

  constructor(private readonly email: IEmailProvider | null) {}

  async sendSms(phone: string, code: string): Promise<OtpDeliveryResult> {
    this.logger.warn(`[no SMS vendor] one-time code for ${phone}: ${code}`);
    return { success: true, messageId: `log-sms-${Date.now()}` };
  }

  async sendEmail(email: string, code: string): Promise<OtpDeliveryResult> {
    if (!this.email) {
      this.logger.warn(`[no email vendor] one-time code for ${email}: ${code}`);
      return { success: true, messageId: `log-email-${Date.now()}` };
    }
    const result = await this.email.send({
      to: email,
      subject: 'Your Urgent.ng code',
      text: `Your Urgent.ng code is ${code}. Do not share it with anyone.`,
      html: `<p>Your Urgent.ng code is <strong style="font-size:20px;letter-spacing:2px">${code}</strong>.</p><p>Do not share it with anyone.</p>`,
    });
    return { success: result.success, messageId: result.messageId, error: result.error };
  }
}
