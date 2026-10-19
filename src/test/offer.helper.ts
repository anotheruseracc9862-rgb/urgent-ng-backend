/** Helpers for offer and negotiation tests (real app over HTTP, fake providers). */

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { API, bearer } from './auth.helper.js';

type Authed = { accessToken: string };

export const offerBody = (extra: Record<string, unknown> = {}) => ({
  amountMinor: 50_000,
  durationMinutes: 30,
  availabilityConfirmed: true,
  ...extra,
});

export const submitOffer = (app: INestApplication, runner: Authed, errandId: string, extra: Record<string, unknown> = {}, key = randomUUID()) =>
  request(app.getHttpServer())
    .post(`${API}/errands/${errandId}/offers`)
    .set(...bearer(runner.accessToken))
    .set('Idempotency-Key', key)
    .send(offerBody(extra));

export const offerAction = (
  app: INestApplication,
  user: Authed,
  method: 'post' | 'patch' | 'get',
  offerId: string,
  action: string,
  body: Record<string, unknown> = {},
) =>
  request(app.getHttpServer())
    [method](`${API}/offers/${offerId}${action ? `/${action}` : ''}`)
    .set(...bearer(user.accessToken))
    .send(body);

export const listOffers = (app: INestApplication, user: Authed, errandId: string, sort?: string) =>
  request(app.getHttpServer())
    .get(`${API}/errands/${errandId}/offers${sort ? `?sort=${sort}` : ''}`)
    .set(...bearer(user.accessToken));
