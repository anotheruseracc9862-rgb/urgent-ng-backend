import type { NotificationCategory, Prisma } from '@prisma/client';
import { DEFAULTS } from '../../src/config/business-config.defaults.js';
import { recomputeUserStats } from '../../src/ratings/user-stats.service.js';
import { completedScenarios, demoId, demoRequesters, demoRunners, demoUsers, errandId, minutes, runnerFor, type DemoContext } from './demo-data.js';

async function seedReviews({ tx }: DemoContext) {
  for (const requester of demoRequesters) {
    for (const [index, scenario] of completedScenarios.slice(0, 3).entries()) {
      const assignment = await tx.assignment.findUnique({ where: { id: demoId(`assignment:${errandId(requester, scenario)}`) } });
      if (!assignment || assignment.status !== 'COMPLETED' || !assignment.completedAt) continue;
      for (const direction of ['REQUESTER_TO_RUNNER', 'RUNNER_TO_REQUESTER']) {
        if (await tx.rating.findFirst({ where: { assignmentId: assignment.id, direction } })) continue;
        const toRunner = direction === 'REQUESTER_TO_RUNNER';
        const createdAt = minutes(assignment.completedAt, 5);
        const score = (requester.index + index) % 3 === 0 ? 4 : 5;
        const dimensions = toRunner ? ['OVERALL', 'RELIABILITY', 'COMMUNICATION', 'TIMELINESS'] as const : ['OVERALL', 'COMMUNICATION', 'PAYMENT_CONDUCT'] as const;
        await tx.rating.create({ data: {
          id: demoId(`rating:${assignment.id}:${direction}`), assignmentId: assignment.id, direction,
          raterId: toRunner ? assignment.requesterId : assignment.runnerId, rateeId: toRunner ? assignment.runnerId : assignment.requesterId,
          review: toRunner ? ['Careful delivery and clear updates. I would book again.', 'Friendly, reliable and handled the parcel well.', 'Everything arrived safely. Thank you for the help.'][index] : ['Clear instructions and a smooth handover.', 'Easy to reach and payment was agreed clearly.', 'A pleasant errand with a well-prepared pickup.'][index],
          status: 'PUBLISHED', createdAt, revealedAt: minutes(createdAt, 2), editableUntil: minutes(createdAt, DEFAULTS.RATING_EDIT_HOURS * 60),
          scores: { create: dimensions.map((dimension) => ({ dimension, score })) },
        } });
      }
    }
  }
  for (const user of demoUsers) await recomputeUserStats(tx, user.id);
}

async function seedConversations({ tx, now }: DemoContext) {
  const ids = demoRequesters.flatMap((requester) => [
    ...completedScenarios.map((scenario, index) => demoId(`offer:${errandId(requester, scenario)}:${runnerFor(requester, index).id}`)),
    ...['pending', 'active'].map((scenario) => demoId(`offer:${errandId(requester, scenario)}:${runnerFor(requester).id}`)),
    ...['open', 'open-scheduled'].flatMap((scenario) => [0, 1].map((index) => demoId(`offer:${errandId(requester, scenario)}:${runnerFor(requester, index).id}`))),
  ]);
  const offers = await tx.offer.findMany({ where: { id: { in: ids }, deletedAt: null } });
  for (const offer of offers) {
    const id = demoId(`conversation:${offer.id}`);
    // Respect conversations/messages the tester already created through the app.
    if (await tx.conversation.findFirst({ where: { offerId: offer.id } })) continue;
    const replyId = demoId(`message:${id}:reply`);
    const createdAt = minutes(offer.createdAt, 1);
    await tx.conversation.create({ data: {
      id, offerId: offer.id, errandId: offer.errandId, requesterId: offer.requesterId, runnerId: offer.runnerId,
      status: 'ACTIVE', createdAt, lastMessageAt: minutes(createdAt, 1),
      participants: { create: [{ userId: offer.requesterId }, { userId: offer.runnerId }] },
      messages: { create: [
        { id: demoId(`message:${id}:first`), senderId: offer.runnerId, type: 'TEXT', body: 'Hello! Is the parcel ready for collection at the shop entrance?', status: 'READ', clientMessageId: `demo:${id}:first`, deliveredAt: createdAt, readAt: minutes(createdAt, 1), createdAt },
        { id: replyId, senderId: offer.requesterId, type: 'TEXT', body: 'Yes, it is ready. Please message me when you arrive. Thank you!', status: 'DELIVERED', clientMessageId: `demo:${id}:reply`, deliveredAt: minutes(createdAt, 1), createdAt: minutes(createdAt, 1) },
      ] },
    } });
    await tx.conversationParticipant.updateMany({ where: { conversationId: id, userId: offer.requesterId }, data: { lastReadMessageId: replyId } });
    await tx.offer.update({ where: { id: offer.id }, data: { conversationId: id, updatedAt: offer.updatedAt } });
  }
  for (const requester of demoRequesters) {
    const runner = demoRunners.find((row) => row.index === requester.index)!;
    const id = errandId(requester, 'open');
    if (!(await tx.savedErrand.findFirst({ where: { userId: runner.id, errandId: id } }))) {
      await tx.savedErrand.create({ data: { id: demoId(`save:${runner.id}:${id}`), userId: runner.id, errandId: id, createdAt: now } });
    }
  }
}

async function seedNotifications({ tx, now }: DemoContext) {
  for (const user of demoUsers) {
    const requester = demoRequesters.find((row) => row.index === user.index)!;
    const id = errandId(requester, 'pending');
    const completedId = errandId(requester, 'completed-1');
    const assignmentId = demoId(`assignment:${id}`);
    const offerId = demoId(`offer:${id}:${demoRunners.find((row) => row.index === user.index)!.id}`);
    const notices: Array<{ type: string; category: NotificationCategory; title: string; body: string; data: Prisma.InputJsonObject }> = [
      { type: user.mode === 'RUNNER' ? 'assignment.selected' : 'offer.new', category: 'TRANSACTIONAL', title: user.mode === 'RUNNER' ? 'You were selected' : 'New offer on your errand', body: 'Your local errand has a new update. Open it to continue.', data: { errandId: id, assignmentId, offerId } },
      { type: 'message.new', category: 'MESSAGING', title: 'New message', body: 'You have an unread message about your errand.', data: { conversationId: demoId(`conversation:${offerId}`), errandId: id } },
      { type: 'rating.received', category: 'TRANSACTIONAL', title: 'You received a review', body: 'Your completed errand has a new review.', data: { errandId: completedId } },
      { type: 'verification.verified', category: 'TRANSACTIONAL', title: 'Identity verified', body: 'Your demo account is verified and ready to use.', data: {} },
    ];
    for (const [index, notice] of notices.entries()) {
      const notificationId = demoId(`notification:${user.id}:${index}`);
      if (await tx.notification.findUnique({ where: { id: notificationId } })) continue;
      await tx.notification.create({ data: {
        id: notificationId, userId: user.id, ...notice, dedupeKey: `demo:${user.id}:${index}`,
        createdAt: minutes(now, -5 - index * 30), readAt: index > 1 ? minutes(now, -1) : null,
        deliveries: { create: { channel: 'IN_APP', status: 'SENT', providerRef: 'local-demo-only' } },
      } });
    }
  }
}

async function seedBilling({ tx, now }: DemoContext) {
  for (const [index, type] of (['RUNNER_PRO', 'RUNNER_PRO', 'BOOST'] as const).entries()) {
    const key = `billing:${index}`;
    const orderId = demoId(key);
    if (await tx.order.findUnique({ where: { id: orderId } })) continue;
    const expired = index === 1;
    const user = index === 2 ? demoRequesters[0] : demoRunners[index];
    const product = await tx.commercialProduct.findFirstOrThrow({ where: { code: type === 'BOOST' ? 'PRIORITY_BOOST' : 'RUNNER_PRO', deletedAt: null } });
    const price = await tx.priceVersion.findFirstOrThrow({ where: { productId: product.id, effectiveFrom: { lte: now } }, orderBy: { effectiveFrom: 'desc' } });
    const paidAt = minutes(now, expired ? -60 * 24 * 60 : -24 * 60);
    await tx.order.create({ data: { id: orderId, userId: user.id, type, productId: product.id, priceVersionId: price.id, amountMinor: price.amountKobo, status: 'PAID', paidAt, createdAt: paidAt, targetErrandId: type === 'BOOST' ? errandId(user, 'open') : null, idempotencyKey: `local-demo:${key}`, metadata: { synthetic: true, note: 'Local fixture only: no funds were charged.' } } });
    await tx.payment.create({ data: { id: demoId(`payment:${key}`), orderId, provider: 'LOCAL_DEMO', providerReference: `local-demo:${orderId}`, status: 'SUCCEEDED', amountMinor: price.amountKobo, paidAt, createdAt: paidAt } });
    if (type === 'RUNNER_PRO') {
      const subscriptionId = demoId(`subscription:${key}`);
      const end = minutes(paidAt, 30 * 24 * 60);
      await tx.subscription.create({ data: { id: subscriptionId, userId: user.id, status: expired ? 'EXPIRED' : 'ACTIVE', currentPeriodStart: paidAt, currentPeriodEnd: end, autoRenew: false, latestOrderId: orderId, createdAt: paidAt } });
      await tx.entitlement.create({ data: { id: demoId(`entitlement:${key}`), userId: user.id, type: 'RUNNER_PRO', source: 'SUBSCRIPTION', sourceId: subscriptionId, validFrom: paidAt, validUntil: end, createdAt: paidAt } });
    } else {
      await tx.boost.create({ data: { id: demoId(`boost:${key}`), errandId: errandId(user, 'open'), orderId, status: 'ACTIVE', activatesAt: now, expiresAt: minutes(now, 60), createdAt: now } });
    }
  }
}

export async function seedDemoActivity(context: DemoContext): Promise<void> {
  await seedReviews(context);
  await seedConversations(context);
  await seedNotifications(context);
  await seedBilling(context);
}
