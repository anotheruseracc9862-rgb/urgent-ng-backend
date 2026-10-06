import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { Test } from '@nestjs/testing';
import { Body, Controller, HttpCode, INestApplication, Post } from '@nestjs/common';
import request from 'supertest';
import { DatabaseModule } from '../../database/database.module.js';
import { IdempotencyModule } from './idempotency.module.js';
import { Idempotent } from './idempotent.decorator.js';
import { cleanDatabase, getTestPrisma } from '../../test/database.helper.js';
import { testConfigModule } from '../../test/test-modules.js';

const USER_ID = '123e4567-e89b-12d3-a456-426614174000';

let executions = 0;
let gate: Promise<void> | null = null;

@Controller('idem')
class IdemController {
  @Post('create')
  @Idempotent({ operation: 'create-thing' })
  async create(@Body() body: { name: string; fail?: boolean }) {
    executions += 1;
    if (gate) await gate;
    if (body.fail) throw new Error('boom');
    return { id: `thing-${executions}`, name: body.name };
  }

  @Post('ok')
  @HttpCode(200)
  @Idempotent({ operation: 'ok-thing' })
  async ok() {
    executions += 1;
    return { done: true };
  }
}

describe('IdempotencyInterceptor (integration)', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  const key = (n: string) => `test-key-${n}-0001`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [testConfigModule(), DatabaseModule, IdempotencyModule],
      controllers: [IdemController],
    }).compile();

    app = moduleRef.createNestApplication();
    app.use((req: { user?: { id: string } }, _res: unknown, next: () => void) => {
      req.user = { id: USER_ID };
      next();
    });
    await app.init();
  });

  beforeEach(async () => {
    executions = 0;
    gate = null;
    await cleanDatabase();
  });

  afterAll(async () => {
    await app.close();
  });

  const post = (path: string, idempotencyKey: string | undefined, body: object) => {
    const req = request(app.getHttpServer()).post(path);
    if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
    return req.send(body);
  };

  it('rejects a request without an Idempotency-Key header', async () => {
    await post('/idem/create', undefined, { name: 'a' }).expect(400);
    expect(executions).toBe(0);
  });

  it('rejects a malformed Idempotency-Key', async () => {
    await post('/idem/create', 'short', { name: 'a' }).expect(400);
    await post('/idem/create', 'has spaces in it!', { name: 'a' }).expect(400);
    expect(executions).toBe(0);
  });

  it('runs the handler once and replays the stored response for the same key', async () => {
    const first = await post('/idem/create', key('a'), { name: 'a' }).expect(201);
    const second = await post('/idem/create', key('a'), { name: 'a' }).expect(201);

    expect(executions).toBe(1);
    expect(second.body).toEqual(first.body);

    const [row] = await prisma.idempotencyKey.findMany();
    expect(row.responseStatus).toBe(201);
  });

  it('stores and replays the @HttpCode status (not a guessed one)', async () => {
    await post('/idem/ok', key('b'), {}).expect(200);
    await post('/idem/ok', key('b'), {}).expect(200);

    expect(executions).toBe(1);
    const [row] = await prisma.idempotencyKey.findMany();
    expect(row.responseStatus).toBe(200);
  });

  it('returns 409 when the same key is reused with a different body', async () => {
    await post('/idem/create', key('c'), { name: 'a' }).expect(201);
    await post('/idem/create', key('c'), { name: 'different' }).expect(409);

    expect(executions).toBe(1);
  });

  it('returns 409 while the first request with the key is still running', async () => {
    let release!: () => void;
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const inFlight = post('/idem/create', key('d'), { name: 'a' }).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 300));

    await post('/idem/create', key('d'), { name: 'a' }).expect(409);

    release();
    await inFlight;
    expect(executions).toBe(1);
  });

  it('releases the key when the handler fails, so a retry can run again', async () => {
    await post('/idem/create', key('e'), { name: 'a', fail: true }).expect(500);

    const [failed] = await prisma.idempotencyKey.findMany();
    expect(failed.failedAt).not.toBeNull();
    expect(failed.responseStatus).toBeNull();

    // same key and same body: allowed to run again (and fails again here)
    await post('/idem/create', key('e'), { name: 'a', fail: true }).expect(500);
    expect(executions).toBe(2);
  });

  it('scopes keys per operation', async () => {
    await post('/idem/create', key('f'), { name: 'a' }).expect(201);
    await post('/idem/ok', key('f'), {}).expect(200);

    expect(executions).toBe(2);
  });
});
