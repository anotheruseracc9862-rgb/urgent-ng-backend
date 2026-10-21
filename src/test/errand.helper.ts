/** Helpers for errand tests (real database; categories and prohibited-item rules are seeded here). */

import { randomUUID } from 'node:crypto';
import type { ErrandStatus } from '@prisma/client';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { API, bearer } from './auth.helper.js';
import { getTestPrisma } from './database.helper.js';

/** The five seeded categories (Backend PRD 11.2), returned by key. */
export async function seedCategories(): Promise<Record<string, string>> {
  const prisma = getTestPrisma();
  const rows: Array<[string, string, boolean, boolean, boolean, 'TRANSIT' | 'SERVICE']> = [
    ['delivery', 'Delivery', true, true, true, 'TRANSIT'],
    ['pickup', 'Pickup', true, false, true, 'TRANSIT'],
    ['shopping_purchase', 'Shopping & Purchase', false, true, false, 'TRANSIT'],
    ['document', 'Document', true, true, false, 'TRANSIT'],
    ['other', 'Other', true, false, false, 'TRANSIT'],
    ['car_wash', 'Car Wash', false, true, false, 'SERVICE'],
  ];
  const ids: Record<string, string> = {};
  for (const [index, [key, name, pickup, destination, popular, flow]] of rows.entries()) {
    const found = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO categories (key, name, flow, requires_pickup, requires_destination, sort_order, is_popular, updated_at)
      VALUES (${key}, ${name}, ${flow}::"CategoryFlow", ${pickup}, ${destination}, ${index}, ${popular}, now())
      RETURNING id::text
    `;
    ids[key] = found[0].id;
  }
  return ids;
}

export async function seedProhibitedItems(keywords: string[] = ['cocaine', 'pistol', 'ak47']): Promise<void> {
  const prisma = getTestPrisma();
  for (const keyword of keywords) {
    await prisma.$executeRaw`
      INSERT INTO prohibited_item_rules (category, keyword, description, status, effective_from, policy_version, updated_at)
      VALUES ('illegal', ${keyword}, ${`${keyword} is not allowed`}, 'ACTIVE', now() - interval '1 day', '1.0', now())
    `;
  }
}

export interface InsertErrandOptions {
  requesterId: string;
  categoryId: string;
  status?: ErrandStatus;
  title?: string;
  description?: string;
  timeMode?: 'ASAP' | 'SCHEDULED';
  scheduledAt?: Date;
  /** Hours from now (negative = already passed). */
  expiresInHours?: number;
  statusBeforeDispute?: ErrandStatus;
  lat?: number;
  lng?: number;
  area?: string;
  /** The stored location: a pickup (default), or the destination of a service. */
  locationType?: 'ERRAND_PICKUP' | 'ERRAND_DESTINATION';
}

/** An errand in any status, with a pickup location, inserted directly (bypasses the API). */
export async function insertErrand(options: InsertErrandOptions): Promise<string> {
  const prisma = getTestPrisma();
  const status = options.status ?? 'OPEN';
  const draft = status === 'DRAFT';
  const timeMode = options.timeMode ?? 'ASAP';
  const id = randomUUID();
  const hours = options.expiresInHours ?? 24;
  const lat = options.lat ?? 6.5244;
  const lng = options.lng ?? 3.3792;

  await prisma.$executeRaw`
    INSERT INTO errands (
      id, requester_id, category_id, title, description, status, status_before_dispute, priority, time_mode, scheduled_at,
      prohibited_items_confirmed_at, prohibited_policy_version, published_at, expires_at,
      delivered_at, completed_at, cancelled_at, cancellation_reason, feed_point, updated_at
    ) VALUES (
      ${id}::uuid, ${options.requesterId}::uuid, ${options.categoryId}::uuid,
      ${options.title ?? 'Collect a parcel'}, ${options.description ?? 'Pick up a small parcel and bring it over'},
      ${status}::"ErrandStatus", ${options.statusBeforeDispute ?? null}::"ErrandStatus",
      ${timeMode === 'ASAP' ? 'URGENT' : 'STANDARD'}::"ErrandPriority", ${draft ? null : timeMode}::"TimeMode",
      ${options.scheduledAt ?? null}::timestamptz,
      ${draft || status === 'CANCELLED' ? null : new Date()}::timestamptz, ${draft || status === 'CANCELLED' ? null : '1.0'},
      ${draft || status === 'CANCELLED' ? null : new Date()}::timestamptz,
      ${draft || status === 'CANCELLED' ? null : new Date(Date.now() + hours * 3_600_000)}::timestamptz,
      ${status === 'DELIVERED' ? new Date() : null}::timestamptz,
      ${status === 'COMPLETED' ? new Date() : null}::timestamptz,
      ${status === 'CANCELLED' ? new Date() : null}::timestamptz,
      ${status === 'CANCELLED' ? 'REQUESTER_CANCELLED' : null}::"ErrandCancellationReason",
      ST_SetSRID(ST_MakePoint(${lng + 0.002}::float8, ${lat + 0.002}::float8), 4326)::geography,
      now()
    )
  `;
  await prisma.$executeRaw`
    INSERT INTO errand_locations (errand_id, type, exact_point, approx_point, area, lga, state, state_id, lga_id, source, updated_at)
    VALUES (${id}::uuid, ${options.locationType ?? 'ERRAND_PICKUP'}::"LocationType",
            ST_SetSRID(ST_MakePoint(${lng}::float8, ${lat}::float8), 4326)::geography,
            ST_SetSRID(ST_MakePoint(${lng + 0.002}::float8, ${lat + 0.002}::float8), 4326)::geography,
            ${options.area ?? 'Yaba'}, 'Lagos Mainland', 'Lagos', 'ng-lagos', 'ng-lagos:lagos-mainland', 'MAP_PIN'::"LocationSource", now())
  `;
  return id;
}

// ---- HTTP helpers (the real API, fake providers) ----


type SignedInUser = { accessToken: string };

export const LAGOS_PICKUP = { lat: 6.5244, lng: 3.3792 };
// Both stops fit the default runner's 5 km circle; coverage now checks every stop.
export const LAGOS_DESTINATION = { lat: 6.55, lng: 3.39 };

/** A complete delivery draft: both locations, ASAP. Override or add fields as needed. */
export const draftBody = (categoryId: string, extra: Record<string, unknown> = {}) => ({
  categoryId,
  title: 'Deliver a parcel',
  description: 'Take a small parcel to my sister in Ikeja',
  timeMode: 'ASAP',
  pickup: { point: LAGOS_PICKUP, landmark: 'Opposite the Shell station' },
  destination: { point: LAGOS_DESTINATION, addressText: '14 Allen Avenue, Ikeja' },
  ...extra,
});

export const createDraft = (app: INestApplication, user: SignedInUser, body: Record<string, unknown>) =>
  request(app.getHttpServer()).post(`${API}/errands`).set(...bearer(user.accessToken)).send(body);

export const publishErrand = (app: INestApplication, user: SignedInUser, id: string, options: { key?: string; confirmed?: boolean } = {}) =>
  request(app.getHttpServer())
    .post(`${API}/errands/${id}/publish`)
    .set(...bearer(user.accessToken))
    .set('Idempotency-Key', options.key ?? randomUUID())
    .send({ prohibitedItemsConfirmed: options.confirmed ?? true });

/** Create a complete draft and publish it. Returns the id. */
export async function openErrand(app: INestApplication, user: SignedInUser, categoryId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const draft = await createDraft(app, user, draftBody(categoryId, extra));
  if (draft.status !== 201) throw new Error(`draft failed: ${draft.status} ${JSON.stringify(draft.body)}`);
  const published = await publishErrand(app, user, draft.body.data.id);
  if (published.status !== 201) throw new Error(`publish failed: ${published.status} ${JSON.stringify(published.body)}`);
  return draft.body.data.id as string;
}
