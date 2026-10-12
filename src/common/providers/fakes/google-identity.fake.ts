import { BaseFake } from './base.fake.js';
import type { GoogleIdentity, IGoogleIdentityProvider } from '../google-identity.provider.js';

/**
 * Fake Google sign-in. A token is `fake-google:<subject>:<email>:<name>` (email `-` means none,
 * `unverified+<email>` marks the email unverified). Anything else is an invalid token.
 */
export class FakeGoogleIdentityProvider extends BaseFake implements IGoogleIdentityProvider {
  verifyIdToken(idToken: string): Promise<GoogleIdentity | null> {
    this.recordCall('verifyIdToken', idToken);
    const parts = idToken.split(':');
    if (parts[0] !== 'fake-google' || parts.length < 4 || !parts[1]) {
      return Promise.resolve(null);
    }
    const rawEmail = parts[2];
    const unverified = rawEmail.startsWith('unverified+');
    const email = rawEmail === '-' ? null : unverified ? rawEmail.slice('unverified+'.length) : rawEmail;
    return Promise.resolve({
      subject: parts[1],
      email,
      emailVerified: email !== null && !unverified,
      name: parts.slice(3).join(':') || null,
    });
  }

  /** The token a test sends for a given Google account. */
  static token(subject: string, email: string | null, name = 'Google User', options: { unverified?: boolean } = {}): string {
    const mail = email === null ? '-' : options.unverified ? `unverified+${email}` : email;
    return `fake-google:${subject}:${mail}:${name}`;
  }
}
