import type { EmailBrand } from './email-layout.js';

/**
 * Where email links and the logo point.
 *
 *   WEB_APP_URL     the public address of the web app. Links in emails start here.
 *   API_PUBLIC_URL  the public address of this backend. The logo is served from it at
 *                   /assets/email/logo.png (the file lives in backend/assets/email).
 *   EMAIL_LOGO_URL  optional: use another absolute https image instead.
 *
 * Both addresses are required in production. In development they default to the local servers.
 */
export function emailBrand(env: NodeJS.ProcessEnv = process.env): EmailBrand {
  const trim = (value: string | undefined) => value?.trim().replace(/\/+$/, '') ?? '';
  const origin = trim(env.WEB_APP_URL) || 'http://localhost:4001';
  const api = trim(env.API_PUBLIC_URL) || `http://localhost:${env.PORT?.trim() || '4000'}`;
  return { origin, logoUrl: env.EMAIL_LOGO_URL?.trim() || `${api}/assets/email/logo.png` };
}
