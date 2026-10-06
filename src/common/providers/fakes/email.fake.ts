/**
 * Fake email provider for testing
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import { IEmailProvider, Email, EmailResult } from '../email.provider.js';

@Injectable()
export class FakeEmailProvider extends BaseFake implements IEmailProvider {
  async send(email: Email): Promise<EmailResult> {
    this.recordCall('send', email);

    if (this.hasScriptedOutcome('send')) {
      return this.getNextOutcome<EmailResult>('send')!;
    }

    return {
      success: true,
      messageId: `fake-email-${Date.now()}`,
    };
  }

  async sendMultiple(emails: Email[]): Promise<EmailResult[]> {
    this.recordCall('sendMultiple', emails);

    if (this.hasScriptedOutcome('sendMultiple')) {
      return this.getNextOutcome<EmailResult[]>('sendMultiple')!;
    }

    return emails.map(() => ({
      success: true,
      messageId: `fake-email-${Date.now()}-${Math.random()}`,
    }));
  }
}
