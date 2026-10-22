import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from '../test/app.factory.js';
import { cleanAll, getTestPrisma } from '../test/database.helper.js';
import {
  API,
  adminLogin,
  bearer,
  createAdmin,
  seedAdminRoles,
  seedPolicies,
} from '../test/auth.helper.js';
import { seedCategories } from '../test/errand.helper.js';
import { acceptedScene } from '../test/assignment.helper.js';

process.env.RATE_LIMIT_DISABLED = 'true';

describe('Admin connected history regression', () => {
  let app: INestApplication;
  const prisma = getTestPrisma();
  let category: string;
  let token: string;
  beforeAll(async () => {
    app = await createTestApp();
  });
  beforeEach(async () => {
    await cleanAll();
    await seedPolicies();
    await seedAdminRoles();
    category = (await seedCategories()).delivery;
    token = (
      await adminLogin(app, await createAdmin(app, { roles: ['SUPER_ADMIN'] }))
    ).accessToken!;
  });
  afterAll(async () => {
    await app.close();
  });
  const get = (path: string) =>
    request(app.getHttpServer())
      .get(`${API}/admin/${path}`)
      .set(...bearer(token));

  it.each(['disputes', 'reports'])(
    'traverses %s priority deadlines, ties and nulls independently of creation time',
    async (source) => {
      const s = await acceptedScene(app, category);
      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        const common = {
          errandId: s.errandId,
          assignmentId: s.assignmentId,
          createdAt: new Date(`2025-01-0${i + 1}T00:00:00Z`),
          slaDueAt:
            i < 3
              ? new Date(
                  i === 0 ? '2025-02-02T00:00:00Z' : '2025-02-01T00:00:00Z',
                )
              : null,
        };
        // Disputes are unique per assignment; use separate scenes for these fixtures.
        const scene =
          source === 'disputes' && i > 0
            ? await acceptedScene(app, category)
            : s;
        const row =
          source === 'disputes'
            ? await prisma.dispute.create({
                data: {
                  ...common,
                  errandId: scene.errandId,
                  assignmentId: scene.assignmentId,
                  type: 'ITEM_NOT_DELIVERED',
                  claim: 'Test',
                  openedBy: scene.requester.userId,
                },
              })
            : await prisma.report.create({
                data: {
                  ...common,
                  type: 'USER_BEHAVIOR',
                  targetType: 'USER',
                  reporterId: s.requester.userId,
                  targetUserId: s.runner.userId,
                  description: 'Test',
                },
              });
        ids.push(row.id);
      }
      const expected = [
        ...ids.slice(1, 3).sort(),
        ids[0],
        ...ids.slice(3).sort(),
      ];
      for (const filter of ['unassigned=true', 'overdue=true', '']) {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const res = await get(
            `${source}?${filter}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
          ).expect(200);
          seen.push(...res.body.data.map((r: { id: string }) => r.id));
          cursor = res.body.meta.nextCursor;
          expect(seen.length).toBeLessThanOrEqual(5);
        } while (cursor);
        expect(seen).toEqual(
          filter === ''
            ? [...ids].reverse()
            : filter === 'overdue=true'
              ? expected.slice(0, 3)
              : expected,
        );
      }
      const filtered = await get(
        `${source}?assignmentId=${s.assignmentId}&errandId=${s.errandId}`,
      ).expect(200);
      expect(
        filtered.body.data.every(
          (r: { assignmentId: string }) => r.assignmentId === s.assignmentId,
        ),
      ).toBe(true);
      expect(filtered.body.data[0]).toMatchObject({ categoryFlow: 'TRANSIT' });
      expect(
        (
          await get(
            `${source}?errandId=00000000-0000-4000-8000-000000000000`,
          ).expect(200)
        ).body.data,
      ).toEqual([]);
      await get(`${source}?assignmentId=invalid`).expect(400);
      if (source === 'disputes') {
        expect(
          (await get(`disputes/${ids[0]}`).expect(200)).body.data,
        ).toMatchObject({
          assignmentId: s.assignmentId,
          errand: { category: { flow: 'TRANSIT' } },
        });
      }
    },
  );

  it('pages sensitive messages with ties, retaining reason and permission requirements', async () => {
    const s = await acceptedScene(app, category);
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { errandId: s.errandId },
    });
    const dispute = await prisma.dispute.create({
      data: {
        errandId: s.errandId,
        assignmentId: s.assignmentId,
        openedBy: s.requester.userId,
        type: 'ITEM_NOT_DELIVERED',
        claim: 'Test',
      },
    });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const m = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          senderId: s.requester.userId,
          type: 'TEXT',
          body: `Message ${i}`,
          createdAt: new Date('2025-01-01'),
        },
      });
      ids.push(m.id);
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const res = await get(
        `conversations/${conversation.id}/messages?reasonCode=SAFETY_RISK&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
      ).expect(200);
      seen.push(...res.body.data.map((m: { id: string }) => m.id));
      cursor = res.body.meta.nextCursor;
      expect(seen.length).toBeLessThanOrEqual(4);
    } while (cursor);
    expect(seen).toEqual(ids.sort());
    const first = (
      await get(
        `disputes/${dispute.id}/chat?reasonCode=SAFETY_RISK&limit=2`,
      ).expect(200)
    ).body.data;
    const second = (
      await get(
        `disputes/${dispute.id}/chat?reasonCode=SAFETY_RISK&limit=2&cursor=${first.meta.nextCursor}`,
      ).expect(200)
    ).body.data;
    expect(
      [...first.messages, ...second.messages].map((m: { id: string }) => m.id),
    ).toEqual(ids.sort());
    expect(second.meta.hasNextPage).toBe(false);
    await get(
      `conversations/${conversation.id}/messages?reasonCode=SAFETY_RISK&cursor=invalid`,
    ).expect(400);
    await get(`conversations/${conversation.id}/messages`).expect(400);
    expect(
      await prisma.auditLog.count({
        where: { entityId: conversation.id, action: 'admin.sensitive_view' },
      }),
    ).toBe(5);
  });

  it('projects flow and locates chat without content only for sensitive viewers; filters assignment history', async () => {
    const s = await acceptedScene(app, category);
    const serviceCategory = await prisma.category.findUniqueOrThrow({
      where: { key: 'home_cleaning' },
    });
    const service = await acceptedScene(app, serviceCategory.id, {
      locationType: 'ERRAND_DESTINATION',
    });
    expect(
      (await get(`assignments/${service.assignmentId}`).expect(200)).body.data,
    ).toMatchObject({ errand: { category: { flow: 'SERVICE' } } });
    expect(
      (await get(`errands/${service.errandId}`).expect(200)).body.data,
    ).toMatchObject({ category: { flow: 'SERVICE' } });
    expect(
      (await get(`errands?requesterId=${service.requester.userId}`).expect(200))
        .body.data,
    ).toMatchObject([{ categoryFlow: 'SERVICE' }]);
    const conversation = await prisma.conversation.findFirstOrThrow({
      where: { errandId: s.errandId },
    });
    const detail = (await get(`assignments/${s.assignmentId}`).expect(200)).body
      .data;
    expect(detail).toMatchObject({
      errand: { category: { flow: 'TRANSIT' } },
      conversationId: conversation.id,
    });
    expect(
      (await get(`errands/${s.errandId}`).expect(200)).body.data,
    ).toMatchObject({
      category: { flow: 'TRANSIT' },
      conversationId: conversation.id,
    });
    expect(detail).not.toHaveProperty('messages');
    await request(app.getHttpServer())
      .post(`${API}/admin/assignments/${s.assignmentId}/cancel`)
      .set(...bearer(token))
      .send({ reasonCode: 'POLICY_VIOLATION' })
      .expect(200);
    const list = (await get(`assignments?errandId=${s.errandId}`).expect(200))
      .body.data;
    expect(list).toMatchObject([
      { id: s.assignmentId, status: 'CANCELLED', categoryFlow: 'TRANSIT' },
    ]);
    expect(list).toHaveLength(1);
    token = (
      await adminLogin(
        app,
        await createAdmin(app, { roles: ['SUPPORT_AGENT'] }),
      )
    ).accessToken!;
    expect(
      (await get(`assignments/${s.assignmentId}`).expect(200)).body.data,
    ).not.toHaveProperty('conversationId');
    expect(
      (await get(`errands/${s.errandId}`).expect(200)).body.data,
    ).not.toHaveProperty('conversationId');
    await get(
      `conversations/${conversation.id}/messages?reasonCode=SAFETY_RISK`,
    ).expect(403);
  });
});
