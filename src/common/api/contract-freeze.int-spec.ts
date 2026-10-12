/**
 * P12-06: the API contract is frozen. `openapi.json` is what the web and admin apps are built
 * against; this test fails when the running API describes something different. Change the API on
 * purpose, run `npm run build && npm run openapi`, and commit the new file with the change.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { createTestApp } from '../../test/app.factory.js';
import { buildOpenApiDocument } from './openapi.js';

describe('API contract freeze (P12-06)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });
  afterAll(async () => {
    await app.close();
  });

  it('openapi.json lists the same routes, access rules and answers as the API', () => {
    type Doc = { paths: Record<string, Record<string, Record<string, unknown>>>; components: { schemas: Record<string, unknown> } };
    const live = JSON.parse(JSON.stringify(buildOpenApiDocument(app))) as Doc;
    const frozen = JSON.parse(readFileSync(join(process.cwd(), 'openapi.json'), 'utf8')) as Doc;

    // A test run reads the DTOs without the Nest build plugin, so field-level detail (query
    // properties, summaries, examples) can differ here. The routes, who may call them, the answers
    // they can give are compared; `npm run contract:check` compares everything
    // against a freshly built API.
    const shape = (doc: Doc) =>
      Object.fromEntries(
        Object.entries(doc.paths).flatMap(([path, item]) =>
          Object.entries(item).map(([method, op]) => {
            const responses = Object.keys((op.responses as Record<string, unknown> | undefined) ?? {}).sort();
            return [`${method.toUpperCase()} ${path}`, { security: op.security ?? [], responses }];
          }),
        ),
      );
    expect(shape(live)).toEqual(shape(frozen));
  });
});
