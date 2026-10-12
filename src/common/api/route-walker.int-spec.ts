/**
 * P12-04: the route walker. Every route of the API has to carry a decision about who may call it:
 * a consumer or admin guard, or an entry in the list of public routes below with the reason.
 * A new route that forgets to decide fails here. Admin routes also have to name a permission,
 * except the few that any signed-in admin may call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import request from 'supertest';
import { createTestApp } from '../../test/app.factory.js';
import { buildOpenApiDocument } from './openapi.js';
import { ConsumerAuthGuard } from '../../auth/guards/consumer-auth.guard.js';
import { AdminAuthGuard } from '../../admin/guards/admin-auth.guard.js';
import { SseAuthGuard } from '../../realtime/sse-auth.guard.js';
import { REQUIRED_PERMISSIONS_KEY } from '../../admin/guards/permission.guard.js';

process.env.RATE_LIMIT_DISABLED = 'true';

/** Routes anyone may call. Each one says why. A route is written `METHOD /path` without the API prefix. */
const PUBLIC_ROUTES: Record<string, string> = {
  'GET /health': 'overall health probe',
  'GET /health/live': 'liveness probe',
  'GET /health/ready': 'readiness probe',
  'POST /auth/register': 'sign-up',
  'POST /auth/login': 'sign-in',
  'POST /auth/refresh': 'token refresh (the refresh token is the credential)',
  'POST /auth/logout': 'ends the session named by the refresh token',
  'POST /auth/otp/verify': 'one-time code check (the code is the credential)',
  'POST /auth/otp/resend': 'one-time code resend, rate limited',
  'POST /auth/password/forgot': 'password reset request, never reveals whether an account exists',
  'POST /auth/password/reset': 'password reset (the reset code is the credential)',
  'POST /auth/google': 'Google sign-in (the Google token is the credential)',
  'GET /reference/categories': 'public reference data',
  'GET /reference/policies': 'public policy documents',
  'GET /reference/popular-categories': 'public reference data',
  'GET /reference/prohibited-items': 'public reference data',
  'GET /reference/policies/{type}': 'public policy documents',
  'GET /billing/products/public': 'public price list',
  'GET /shared/{token}': 'read-only trusted-contact link (the unguessable token is the credential)',
  'POST /shared/{token}/concern': 'trusted-contact concern (the unguessable token is the credential)',
  'POST /webhooks/paystack': 'payment webhook (verified by signature)',
  'GET /dev/last-otp': 'development only: last code sent by the fake SMS provider',
  'POST /admin/auth/login': 'admin sign-in',
  'POST /admin/auth/mfa/enrol': 'admin MFA set-up (the pending login token is the credential)',
  'POST /admin/auth/mfa/verify': 'admin MFA check (the pending login token is the credential)',
  'POST /admin/auth/refresh': 'admin token refresh',
  'POST /admin/auth/accept-invite': 'invitation (the invite token is the credential)',
};

/** Admin routes that need a signed-in admin but no particular permission: they act on the admin themself. */
const ANY_ADMIN_ROUTES = new Set([
  'GET /admin/auth/me',
  'POST /admin/auth/logout',
  'GET /admin/reason-codes',
  'GET /admin/approvals',
  'GET /admin/approvals/{id}',
  'POST /admin/approvals/{id}/approve',
  'POST /admin/approvals/{id}/reject',
  'POST /admin/approvals/{id}/cancel',
  // The permission depends on what the file is (selfie, ID document, photo); MediaAccessService checks it and audits the view.
  'GET /admin/media/{id}/url',
]);

/** Guards that decide who is calling. SseAuthGuard takes the session cookie or a one-time ticket. */
const DECIDING: unknown[] = [ConsumerAuthGuard, AdminAuthGuard, SseAuthGuard];

describe('Route walker (P12-04)', () => {
  let app: INestApplication;
  const routes: Array<{ key: string; guards: unknown[]; permissions: string[] | undefined; handler: string; limit: number | undefined }> = [];

  beforeAll(async () => {
    app = await createTestApp();
    const discovery = app.get(DiscoveryService);
    const scanner = new MetadataScanner();
    const reflector = app.get(Reflector);
    const join = (...parts: string[]) =>
      '/' + parts.flatMap((p) => p.split('/')).filter(Boolean).map((seg) => (seg.startsWith(':') ? `{${seg.slice(1)}}` : seg)).join('/');
    const verbs = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL', 'OPTIONS', 'HEAD'];

    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const base = (Reflect.getMetadata(PATH_METADATA, metatype) as string | string[] | undefined) ?? '';
      const classGuards = (Reflect.getMetadata(GUARDS_METADATA, metatype) as unknown[] | undefined) ?? [];
      const proto = Object.getPrototypeOf(instance);
      for (const name of scanner.getAllMethodNames(proto)) {
        const handler = proto[name] as (...args: unknown[]) => unknown;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (method === undefined) continue;
        const sub = (Reflect.getMetadata(PATH_METADATA, handler) as string | undefined) ?? '';
        const guards = [...classGuards, ...((Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined) ?? [])];
        const permissions = reflector.getAllAndOverride<string[] | undefined>(REQUIRED_PERMISSIONS_KEY, [handler, metatype]);
        const verb = verbs[method] ?? String(method);
        const baseStr = Array.isArray(base) ? base[0] : base;
        const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', handler) as number | undefined;
        routes.push({ key: `${verb} ${join('/', baseStr, sub)}`, guards, permissions, handler: `${metatype.name}.${name}`, limit });
      }
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('finds the routes it is meant to walk', () => {
    expect(routes.length).toBeGreaterThan(250);
  });

  it('gives every route an authentication decision: a guard, or an entry in the public list', () => {
    const undecided = routes
      .filter((r) => !r.guards.some((g) => DECIDING.includes(g)) && !(r.key in PUBLIC_ROUTES))
      .map((r) => `${r.key}  (${r.handler})`);
    expect(undecided).toEqual([]);
  });

  it('lists no public route that does not exist, and none that is also guarded', () => {
    const known = new Map(routes.map((r) => [r.key, r]));
    const stale = Object.keys(PUBLIC_ROUTES).filter((key) => !known.has(key));
    expect(stale).toEqual([]);
    const guarded = Object.keys(PUBLIC_ROUTES).filter((key) =>
      known.get(key)?.guards.some((g) => DECIDING.includes(g)),
    );
    expect(guarded).toEqual([]);
  });

  it('names a permission on every admin route, except those any signed-in admin may call', () => {
    const adminRoutes = routes.filter((r) => r.guards.includes(AdminAuthGuard));
    expect(adminRoutes.length).toBeGreaterThan(100);
    const open = adminRoutes.filter((r) => (r.permissions ?? []).length === 0 && !ANY_ADMIN_ROUTES.has(r.key)).map((r) => `${r.key}  (${r.handler})`);
    expect(open).toEqual([]);
  });

  it('puts a named rate limit on every public route that takes a credential, a code or a token', () => {
    // Read-only public lists stay on the global limit; the development helpers are absent in production.
    const OPEN_READS = (key: string) => /^(GET \/(health|reference|billing\/products\/public)|\w+ \/dev\/)/.test(key);
    const unlimited = Object.keys(PUBLIC_ROUTES)
      .filter((key) => !OPEN_READS(key))
      .filter((key) => routes.find((r) => r.key === key)?.limit === undefined);
    // The webhook is called by the payment provider and verified by signature; logout guesses nothing
    // (it ends the session named by a token the caller already holds).
    expect(unlimited.filter((key) => !['POST /webhooks/paystack', 'POST /auth/logout'].includes(key))).toEqual([]);
  });

  it('refuses every protected route when no credentials are sent', async () => {
    const doc = buildOpenApiDocument(app);
    const failures: string[] = [];
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
        const op = (item as Record<string, { security?: unknown[] } | undefined>)[method];
        if (!op) continue;
        const key = `${method.toUpperCase()} ${path.replace('/api/v1', '')}`;
        if (key in PUBLIC_ROUTES) continue;
        const url = path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000000');
        const res = await request(app.getHttpServer())[method](url).send({});
        if (res.status !== 401) failures.push(`${key} answered ${res.status}`);
      }
    }
    expect(failures).toEqual([]);
  }, 120_000);
});
