/**
 * Fake OTP provider for testing
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import { IOtpProvider, OtpDeliveryResult } from '../otp.provider.js';

@Injectable()
export class FakeOtpProvider extends BaseFake implements IOtpProvider {
  async sendSms(phone: string, code: string): Promise<OtpDeliveryResult> {
    this.recordCall('sendSms', phone, code);

    if (this.hasScriptedOutcome('sendSms')) {
      return this.getNextOutcome<OtpDeliveryResult>('sendSms')!;
    }

    // Default success response
    return {
      success: true,
      messageId: `fake-sms-${Date.now()}`,
    };
  }

  async sendEmail(email: string, code: string): Promise<OtpDeliveryResult> {
    this.recordCall('sendEmail', email, code);

    if (this.hasScriptedOutcome('sendEmail')) {
      return this.getNextOutcome<OtpDeliveryResult>('sendEmail')!;
    }

    // Default success response
    return {
      success: true,
      messageId: `fake-email-${Date.now()}`,
    };
  }
}
