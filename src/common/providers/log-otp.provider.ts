import { Logger } from '@nestjs/common';
import type { IOtpProvider, OtpDeliveryResult } from './otp.provider.js';
import type { IEmailProvider } from './email.provider.js';
import { renderEmail } from '../../notifications/email/email-layout.js';
import { emailBrand } from '../../notifications/email/email-brand.js';
import { otpEmail } from '../../notifications/email/email-messages.js';


/**
 * One-time codes for an environment that has no SMS vendor yet (development only): the code is
 * written to the backend log instead of being sent. Email codes still go out through the real email
 * provider when one is configured, and are logged otherwise.
 *
 * This writes a phone number and a live code to the log on purpose. In production it is built
 * only when ALLOW_LOG_OTP=true is set explicitly (a temporary switch for a deployment with no SMS
 * vendor yet); otherwise the factory refuses and the environment check requires SMS keys.
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
    const message = renderEmail(otpEmail(code), emailBrand());
    const result = await this.email.send({ to: email, subject: message.subject, text: message.text, html: message.html });
    return { success: result.success, messageId: result.messageId, error: result.error };
  }
}
