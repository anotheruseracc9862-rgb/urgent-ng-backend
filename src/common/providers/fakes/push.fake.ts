/**
 * Fake push notification provider for testing
 */

import { Injectable } from '@nestjs/common';
import { BaseFake } from './base.fake.js';
import {
  IPushProvider,
  PushNotification,
  PushNotificationResult,
} from '../push.provider.js';

@Injectable()
export class FakePushProvider extends BaseFake implements IPushProvider {
  async send(notification: PushNotification): Promise<PushNotificationResult> {
    this.recordCall('send', notification);

    if (this.hasScriptedOutcome('send')) {
      return this.getNextOutcome<PushNotificationResult>('send')!;
    }

    return {
      success: true,
      messageId: `fake-push-${Date.now()}`,
    };
  }

  async sendMultiple(notifications: PushNotification[]): Promise<PushNotificationResult[]> {
    this.recordCall('sendMultiple', notifications);

    if (this.hasScriptedOutcome('sendMultiple')) {
      return this.getNextOutcome<PushNotificationResult[]>('sendMultiple')!;
    }

    return notifications.map(() => ({
      success: true,
      messageId: `fake-push-${Date.now()}-${Math.random()}`,
    }));
  }
}
