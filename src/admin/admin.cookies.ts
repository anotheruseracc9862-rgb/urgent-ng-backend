import type { CookieOptions, Response } from 'express';
import type { AdminTokenPair } from './admin-session.service.js';

/** Admin cookie namespace, separate from the consumer cookies (Backend PRD 24.1). */
export const ADMIN_ACCESS_COOKIE = 'ung_admin_at';
export const ADMIN_REFRESH_COOKIE = 'ung_admin_rt';
const ADMIN_REFRESH_PATH = '/api/v1/admin/auth';

function base(): CookieOptions {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' };
}

export function setAdminCookies(res: Response, tokens: AdminTokenPair): void {
  res.cookie(ADMIN_ACCESS_COOKIE, tokens.accessToken, { ...base(), path: '/', maxAge: tokens.expiresIn * 1000 });
  res.cookie(ADMIN_REFRESH_COOKIE, tokens.refreshToken, {
    ...base(),
    path: ADMIN_REFRESH_PATH,
    maxAge: tokens.refreshExpiresIn * 1000,
  });
}

export function clearAdminCookies(res: Response): void {
  res.clearCookie(ADMIN_ACCESS_COOKIE, { ...base(), path: '/' });
  res.clearCookie(ADMIN_REFRESH_COOKIE, { ...base(), path: ADMIN_REFRESH_PATH });
}
