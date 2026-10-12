/**
 * Milestone check M7 (Backend PRD 24.4): the twenty capability areas each have endpoints, every
 * admin route is behind admin authentication, and every admin write asks for a reason.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { OpenAPIObject } from '@nestjs/swagger';
import { createTestApp } from '../test/app.factory.js';
import { buildOpenApiDocument } from '../common/api/openapi.js';

type Op = { path: string; method: string; op: Record<string, any> };

describe('Admin API milestone (M7)', () => {
  let app: INestApplication;
  let ops: Op[];
  let doc: OpenAPIObject;

  beforeAll(async () => {
    app = await createTestApp();
    doc = buildOpenApiDocument(app);
    ops = Object.entries(doc.paths).flatMap(([path, item]) =>
      (['get', 'post', 'put', 'patch', 'delete'] as const)
        .filter((method) => (item as Record<string, unknown>)[method])
        .map((method) => ({ path, method, op: (item as Record<string, any>)[method] as Record<string, any> })),
    );
  });
  afterAll(async () => {
    await app.close();
  });

  const admin = () => ops.filter((o) => o.path.startsWith('/api/v1/admin/'));
  const has = (method: string, fragment: string) => admin().some((o) => o.method === method && o.path.includes(fragment));

  /** Backend PRD 24.4: each area and a route that proves it exists. */
  const AREAS: Array<[string, string, string]> = [
    ['1 Users', 'get', '/admin/users'],
    ['2 Verification', 'post', '/admin/verifications/{attemptId}/approve'],
    ['3 Errands', 'post', '/admin/errands/{id}/cancel'],
    ['4 Offers', 'post', '/admin/offers/{id}/close'],
    ['5 Assignments', 'post', '/admin/assignments/{id}/release'],
    ['6 Disputes', 'post', '/admin/disputes/{id}/resolve'],
    ['7 Reports', 'post', '/admin/reports/{id}/resolve'],
    ['8 Enforcement', 'post', '/admin/enforcement'],
    ['9 Ratings and badges', 'post', '/admin/ratings/{id}/moderate'],
    ['10 Messaging', 'get', '/admin/conversations/{id}/messages'],
    ['11 Billing', 'post', '/admin/payments/{id}/refund'],
    ['12 Offer limits', 'post', '/admin/offer-limits/{userId}/reset'],
    ['13 Pro and boosts', 'post', '/admin/boosts/{id}/end'],
    ['14 Pricing and config', 'put', '/admin/config/{key}'],
    ['15 Reference data', 'post', '/admin/policies'],
    ['16 Notifications', 'post', '/admin/notifications/announcements'],
    ['17 Operations', 'post', '/admin/ops/outbox/{id}/retry'],
    ['18 Audit', 'get', '/admin/audit'],
    ['19 Analytics', 'get', '/admin/analytics/overview'],
    ['20 Admin accounts', 'post', '/admin/admins/invite'],
  ];

  it.each(AREAS)('has endpoints for area %s', (_name, method, fragment) => {
    expect(has(method, fragment), `${method} ${fragment}`).toBe(true);
  });

  it('guards every admin route with admin authentication, except sign-in and accepting an invitation', () => {
    const PUBLIC = ['/admin/auth/login', '/admin/auth/mfa/enrol', '/admin/auth/mfa/verify', '/admin/auth/refresh', '/admin/auth/accept-invite'];
    const open = admin().filter((o) => !PUBLIC.some((p) => o.path.endsWith(p)) && !o.op.security?.some((s: Record<string, unknown>) => 'admin' in s || 'admin-cookie' in s));
    expect(open.map((o) => `${o.method} ${o.path}`)).toEqual([]);
  });

  it('asks for a reason on every admin write that changes something, in its request body', () => {
    const SKIP = [
      '/admin/auth/', // sign-in, MFA, logout
      '/approvals/', // a decision carries its own note
      '/notes', // a note is the explanation itself
      '/data-requests/{id}', // a status update carries its own resolution
    ];
    const missing: string[] = [];
    for (const o of admin().filter((x) => x.method !== 'get')) {
      if (SKIP.some((s) => o.path.includes(s))) continue;
      const body = o.op.requestBody?.content?.['application/json']?.schema as { $ref?: string } | undefined;
      const name = body?.$ref?.replace('#/components/schemas/', '');
      const schema = name ? ((doc.components?.schemas ?? {}) as Record<string, { properties?: Record<string, unknown> }>)[name] : undefined;
      if (!schema?.properties || !('reasonCode' in schema.properties)) {
        missing.push(`${o.method} ${o.path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
