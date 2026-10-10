/**
 * Real push provider over the Firebase Cloud Messaging HTTP v1 API (Backend Build Plan P8-06).
 *
 * No SDK: the adapter signs a service-account JWT with Node's crypto, exchanges it for an OAuth2
 * access token, and posts to `projects/{id}/messages:send`. A token the provider says is dead is
 * reported as `invalidToken` so the notification engine deactivates the device (PRD 19.4).
 */

import { createSign } from 'node:crypto';
import type { IPushProvider, PushNotification, PushNotificationResult } from './push.provider.js';

export interface FcmServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';

const base64Url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

/** Parse `FIREBASE_CREDENTIALS`: the service-account JSON, or the same JSON base64-encoded. */
export function parseServiceAccount(raw: string): FcmServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  const parsed = JSON.parse(text) as Partial<FcmServiceAccount>;
  if (!parsed.project_id || !parsed.client_email || !parsed.private_key) {
    throw new Error('FIREBASE_CREDENTIALS must be a service account with project_id, client_email and private_key');
  }
  return { ...parsed, private_key: parsed.private_key.replace(/\\n/g, '\n') } as FcmServiceAccount;
}

export class FcmPushProvider implements IPushProvider {
  private accessToken?: { value: string; expiresAt: number };

  constructor(
    private readonly account: FcmServiceAccount,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init) as ReturnType<FetchLike>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async send(notification: PushNotification): Promise<PushNotificationResult> {
    try {
      let response = await this.post(notification, await this.token());
      if (response.status === 401) {
        // The cached token was refused: fetch a new one once.
        this.accessToken = undefined;
        response = await this.post(notification, await this.token());
      }
      return this.interpret(response.status, response.body);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'FCM request failed' };
    }
  }

  async sendMultiple(notifications: PushNotification[]): Promise<PushNotificationResult[]> {
    const results: PushNotificationResult[] = [];
    for (const notification of notifications) {
      results.push(await this.send(notification));
    }
    return results;
  }

  private interpret(status: number, body: unknown): PushNotificationResult {
    const json = (body ?? {}) as { name?: string; error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> } };
    if (status >= 200 && status < 300) {
      return { success: true, messageId: json.name };
    }
    const code = json.error?.details?.find((d) => d.errorCode)?.errorCode ?? json.error?.status;
    // UNREGISTERED: the app was uninstalled or the token rotated. A malformed token is dead too.
    const dead = status === 404 || code === 'UNREGISTERED' || (status === 400 && (code === 'INVALID_ARGUMENT' || code === 'INVALID_REGISTRATION'));
    return { success: false, error: `${status} ${code ?? json.error?.message ?? 'FCM error'}`, invalidToken: dead };
  }

  private async post(notification: PushNotification, token: string) {
    const url = `https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: notification.token,
          notification: { title: notification.title, body: notification.body, ...(notification.imageUrl ? { image: notification.imageUrl } : {}) },
          data: notification.data ?? {},
        },
      }),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }

  /** An OAuth2 access token for the service account, cached until a minute before it expires. */
  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt - 60_000 > this.now()) {
      return this.accessToken.value;
    }
    const tokenUri = this.account.token_uri ?? DEFAULT_TOKEN_URI;
    const issuedAt = Math.floor(this.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = base64Url(
      JSON.stringify({ iss: this.account.client_email, scope: SCOPE, aud: tokenUri, iat: issuedAt, exp: issuedAt + 3600 }),
    );
    const signature = createSign('RSA-SHA256').update(`${header}.${claims}`).sign(this.account.private_key);
    const assertion = `${header}.${claims}.${base64Url(signature)}`;

    const response = await this.fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${assertion}`,
    });
    const json = (await response.json()) as { access_token?: string; expires_in?: number };
    if (response.status !== 200 || !json.access_token) {
      throw new Error(`Could not get an FCM access token (${response.status})`);
    }
    this.accessToken = { value: json.access_token, expiresAt: this.now() + (json.expires_in ?? 3600) * 1000 };
    return json.access_token;
  }
}
