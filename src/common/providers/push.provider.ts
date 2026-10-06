/**
 * Push notification provider interface (FCM)
 */

export interface PushNotificationResult {
  success: boolean;
  messageId?: string;
  error?: string;
  invalidToken?: boolean; // Token should be deactivated
}

export interface PushNotification {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export interface IPushProvider {
  /**
   * Send a push notification to a device
   */
  send(notification: PushNotification): Promise<PushNotificationResult>;

  /**
   * Send push notifications to multiple devices
   */
  sendMultiple(notifications: PushNotification[]): Promise<PushNotificationResult[]>;
}

export const PUSH_PROVIDER = Symbol('PUSH_PROVIDER');
