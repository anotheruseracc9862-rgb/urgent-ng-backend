/**
 * OTP Delivery Provider
 * 
 * Abstracts OTP delivery mechanism (SMS/Email) for testing and real implementations.
 * PRD §9: Registration and OTP
 */

export interface OtpDeliveryPayload {
  identifier: string; // phone or email
  code: string; // 6-digit OTP
  purpose: 'registration' | 'login' | 'verification';
}

export interface OtpDeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface IOtpDeliveryProvider {
  /**
   * Send OTP code to the given identifier
   */
  send(payload: OtpDeliveryPayload): Promise<OtpDeliveryResult>;
}

/**
 * Fake OTP Delivery Provider for development and testing
 * 
 * Does not send real SMS/email, only logs to console.
 * In production, replace with real SMS/email provider.
 */
export class FakeOtpDeliveryProvider implements IOtpDeliveryProvider {
  private readonly sentCodes = new Map<string, string[]>();

  async send(payload: OtpDeliveryPayload): Promise<OtpDeliveryResult> {
    console.log(
      `[FakeOtpDeliveryProvider] Would send OTP to ${payload.identifier} for ${payload.purpose}`,
    );
    // DO NOT log the actual code in production - this is development only
    console.log(`[FakeOtpDeliveryProvider] Code: ${payload.code}`);

    // Track sent codes for testing
    const existing = this.sentCodes.get(payload.identifier) || [];
    existing.push(payload.code);
    this.sentCodes.set(payload.identifier, existing);

    return {
      success: true,
      messageId: `fake-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    };
  }

  /**
   * Test helper: retrieve sent codes for an identifier
   */
  getSentCodes(identifier: string): string[] {
    return this.sentCodes.get(identifier) || [];
  }

  /**
   * Test helper: clear sent codes
   */
  clearSentCodes(): void {
    this.sentCodes.clear();
  }
}
