/**
 * Google sign-in provider interface. The client sends the Google ID token it got from Google's
 * sign-in button; this provider checks it and answers who the Google account is. The token is
 * used once and never stored.
 *
 * An invalid, expired or wrong-audience token is a business outcome (`null`), not an error.
 * Transport failures throw `ProviderError`.
 */
export interface GoogleIdentity {
  /** Google's stable account id (`sub`). The key we link accounts by. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
}

export interface IGoogleIdentityProvider {
  verifyIdToken(idToken: string): Promise<GoogleIdentity | null>;
}

export const GOOGLE_IDENTITY_PROVIDER = Symbol('GOOGLE_IDENTITY_PROVIDER');
