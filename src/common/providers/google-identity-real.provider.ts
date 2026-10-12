import { ProviderError } from './provider.error.js';
import type { GoogleIdentity, IGoogleIdentityProvider } from './google-identity.provider.js';

export interface GoogleIdentitySettings {
  /** The OAuth client id the token must have been issued for. */
  clientId: string;
  tokenInfoUrl?: string;
  timeoutMs?: number;
}

type FetchLike = typeof fetch;

/**
 * Verifies a Google ID token with Google's token-info endpoint, then checks the audience and
 * issuer ourselves. Needs no extra dependency. An invalid token answers `null`.
 */
export class GoogleIdentityProvider implements IGoogleIdentityProvider {
  private readonly tokenInfoUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly settings: GoogleIdentitySettings,
    options: { fetchImpl?: FetchLike } = {},
  ) {
    this.tokenInfoUrl = settings.tokenInfoUrl ?? 'https://oauth2.googleapis.com/tokeninfo';
    this.timeoutMs = settings.timeoutMs ?? 8000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async verifyIdToken(idToken: string): Promise<GoogleIdentity | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.tokenInfoUrl}?id_token=${encodeURIComponent(idToken)}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ProviderError('google', 'Could not reach Google to verify the token.', { retryable: true, cause: error });
    }
    if (response.status >= 500 || response.status === 429) {
      throw new ProviderError('google', `Google answered ${response.status}.`, { retryable: true });
    }
    if (!response.ok) {
      return null;
    }
    const body = (await response.json().catch(() => null)) as Record<string, string> | null;
    if (!body || typeof body.sub !== 'string') {
      return null;
    }
    const issuerOk = body.iss === 'accounts.google.com' || body.iss === 'https://accounts.google.com';
    const expired = Number(body.exp) * 1000 <= Date.now();
    if (body.aud !== this.settings.clientId || !issuerOk || expired) {
      return null;
    }
    return {
      subject: body.sub,
      email: typeof body.email === 'string' ? body.email.toLowerCase() : null,
      emailVerified: body.email_verified === 'true' || (body.email_verified as unknown) === true,
      name: typeof body.name === 'string' ? body.name : null,
    };
  }
}
