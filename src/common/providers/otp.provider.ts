/**
 * OTP delivery provider interface (SMS and Email)
 */

export interface OtpDeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface IOtpProvider {
  /**
   * Send OTP via SMS
   */
  sendSms(phone: string, code: string): Promise<OtpDeliveryResult>;

  /**
   * Send OTP via email
   */
  sendEmail(email: string, code: string): Promise<OtpDeliveryResult>;
}

export const OTP_PROVIDER = Symbol('OTP_PROVIDER');
