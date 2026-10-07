import type { CookieOptions, Response } from 'express';
import type { TokenPair } from './session.service.js';

/** Web clients get both tokens as HTTP-only cookies (Backend PRD 9.3). */
export const ACCESS_COOKIE = 'ung_at';
export const REFRESH_COOKIE = 'ung_rt';

/** The refresh cookie is only sent to the auth endpoints that need it. */
const REFRESH_COOKIE_PATH = '/api/v1/auth';

function base(): CookieOptions {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  };
}

export function setAuthCookies(res: Response, tokens: TokenPair): void {
  res.cookie(ACCESS_COOKIE, tokens.accessToken, {
    ...base(),
    path: '/',
    maxAge: tokens.expiresIn * 1000,
  });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, {
    ...base(),
    path: REFRESH_COOKIE_PATH,
    maxAge: tokens.refreshExpiresIn * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(), path: REFRESH_COOKIE_PATH });
}

/** Mobile and other non-browser clients ask for tokens in the body with `X-Client: mobile`. */
export function wantsBodyTokens(clientHeader: unknown): boolean {
  return clientHeader === 'mobile';
}
