import type { ErrandStatus } from '@prisma/client';
import configuration from '../../src/config/configuration.js';
import { DEFAULTS } from '../../src/config/business-config.defaults.js';
import { encrypt } from '../../src/common/utils/crypto.helper.js';
import { approximatePoint } from '../../src/errands/location-privacy.js';
import { activeScenario, completedScenarios, demoErrandRoute, demoId, demoRequesters, errandId, minutes, runnerFor, type DemoContext, type DemoUser } from './demo-data.js';

const titles: Record<string, string> = {
  'completed-1': 'Deliver a birthday parcel', 'completed-2': 'Collect a pharmacy order', 'completed-3': 'Deliver office documents', 'completed-unreviewed': 'Collect a laundry order',
  draft: 'Pick up groceries for the weekend', open: 'Collect a small parcel', 'open-scheduled': 'Deliver a document envelope',
  pending: 'Pick up a lunch order', active: 'Deliver a sealed package', cancelled: 'Collect a forgotten charger', expired: 'Pick up a bakery order',
};

async function writeDemoLocations({ tx, now }: DemoContext, requester: DemoUser, scenario: string) {
  const id = errandId(requester, scenario);
  const route = demoErrandRoute(requester, scenario);
  const settings = configuration();
  for (const type of ['ERRAND_PICKUP', 'ERRAND_DESTINATION'] as const) {
    const location = type === 'ERRAND_PICKUP' ? route.pickup : route.destination;
    const { point } = location;
    const approx = approximatePoint(point, id, type, settings.security.hmacSecret, { gridMeters: DEFAULTS.APPROX_GRID_METERS, maxOffsetMeters: DEFAULTS.APPROX_MAX_OFFSET_METERS });
    await tx.$executeRaw`
      INSERT INTO errand_locations (id, errand_id, type, exact_point, approx_point, address_text, landmark, area, lga, state, state_id, lga_id, source, updated_at)
      VALUES (${demoId(`location:${id}:${type}`)}::uuid, ${id}::uuid, ${type}::"LocationType",
        ST_SetSRID(ST_MakePoint(${point.lng}::float8,${point.lat}::float8),4326)::geography,
        ST_SetSRID(ST_MakePoint(${approx.lng}::float8,${approx.lat}::float8),4326)::geography,
        ${`Demo address, ${location.area}`}, 'Meet outside the shop entrance', ${location.area}, ${location.lga}, ${requester.region.name}, ${requester.region.stateId}, ${location.lgaId}, 'MAP_PIN'::"LocationSource", ${now})
      ON CONFLICT (id) DO UPDATE SET exact_point = EXCLUDED.exact_point, approx_point = EXCLUDED.approx_point,
        address_text = EXCLUDED.address_text, area = EXCLUDED.area, lga = EXCLUDED.lga, lga_id = EXCLUDED.lga_id, updated_at = EXCLUDED.updated_at
    `;
    if (type === 'ERRAND_PICKUP') await tx.$executeRaw`UPDATE errands SET feed_point = ST_SetSRID(ST_MakePoint(${approx.lng}::float8,${approx.lat}::float8),4326)::geography WHERE id = ${id}::uuid`;
  }
}

/** Explicit opt-in: relocate only unchanged legacy OPEN/DRAFT fixtures, never active/history jobs. */
export async function refreshDemoLocations(context: DemoContext): Promise<number> {
  let refreshed = 0;
  for (const requester of demoRequesters) {
    const region = requester.region;
    for (const scenario of ['open', 'open-scheduled', 'draft']) {
      const id = errandId(requester, scenario);
      const draft = scenario === 'draft';
      const originalDescription = `${requester.name.split(' ')[0]} needs help with a small local errand in ${region.area}. This is a synthetic demo job for testing.`;
      const rows = await context.tx.$queryRaw<Array<{ id: string }>>`
        SELECT e.id FROM errands e WHERE e.id = ${id}::uuid AND e.requester_id = ${requester.id}::uuid
          AND e.status::text = ${draft ? 'DRAFT' : 'OPEN'} AND e.version = ${draft ? 0 : 1} AND e.material_version = ${draft ? 0 : 1}
          AND e.title = ${`${titles[scenario]} in ${region.area}`} AND e.description = ${originalDescription}
          AND NOT EXISTS (SELECT 1 FROM assignments a WHERE a.errand_id = e.id)
          AND (SELECT count(*) FROM errand_locations l WHERE l.errand_id = e.id
            AND l.address_text = ${`Demo address, ${region.area}`} AND l.area = ${region.area}
            AND l.lga_id = ${region.lgaId} AND l.source = 'MAP_PIN'
            AND ((l.type = 'ERRAND_PICKUP' AND ST_Equals(l.exact_point::geometry, ST_SetSRID(ST_MakePoint(${region.pickup.lng}::float8, ${region.pickup.lat}::float8),4326)))
              OR (l.type = 'ERRAND_DESTINATION' AND ST_Equals(l.exact_point::geometry, ST_SetSRID(ST_MakePoint(${region.destination.lng}::float8, ${region.destination.lat}::float8),4326))))) = 2
        FOR UPDATE OF e
      `;
      if (!rows.length) continue;
      await writeDemoLocations(context, requester, scenario);
      const { pickup } = demoErrandRoute(requester, scenario);
      await context.tx.errand.update({ where: { id }, data: {
        title: `${titles[scenario]} in ${pickup.area}`,
        description: `${requester.name.split(' ')[0]} needs help with a small local errand in ${pickup.area}. This is a synthetic demo job for testing.`,
      } });
      refreshed++;
    }
  }
  return refreshed;
}

async function seedOffer(context: DemoContext, id: string, requester: DemoUser, runner: DemoUser, selected: boolean, createdAt: Date, amountMinor: bigint) {
  const offerId = demoId(`offer:${id}:${runner.id}`);
  await context.tx.offer.create({ data: {
    id: offerId, errandId: id, requesterId: requester.id, runnerId: runner.id, amountMinor,
    durationMinutes: 45, availabilityConfirmedAt: createdAt, message: 'I know this area and can collect your parcel shortly.',
    status: selected ? 'SELECTED' : 'ACTIVE', awaitingParty: selected ? 'NONE' : 'REQUESTER',
    selectedAt: selected ? minutes(createdAt, 1) : null, version: 1, createdAt,
    negotiationEvents: { create: { id: demoId(`negotiation:${offerId}`), errandId: id, actorUserId: runner.id, messageType: 'INITIAL_OFFER', proposedAmountMinor: amountMinor, proposedDurationMinutes: 45, resultingOfferVersion: 1, createdAt } },
  } });
  return offerId;
}

async function seedAssignment(context: DemoContext, id: string, status: ErrandStatus, requester: DemoUser, runner: DemoUser, publishedAt: Date, amount: bigint) {
  const { tx } = context;
  const offerId = await seedOffer(context, id, requester, runner, true, minutes(publishedAt, 3), amount);
  const selectedAt = minutes(publishedAt, 4);
  const acceptedAt = status === 'RUNNER_SELECTED' ? null : minutes(publishedAt, 6);
  const completedAt = status === 'COMPLETED' ? minutes(publishedAt, 90) : null;
  const assignmentId = demoId(`assignment:${id}`);
  await tx.assignment.create({ data: {
    id: assignmentId, errandId: id, requesterId: requester.id, runnerId: runner.id, selectedOfferId: offerId,
    status: completedAt ? 'COMPLETED' : acceptedAt ? 'ACCEPTED' : 'PENDING_ACCEPTANCE', agreedAmountMinor: amount,
    selectedAt, acceptanceDeadline: minutes(selectedAt, DEFAULTS.ASSIGNMENT_ACCEPTANCE_MINUTES),
    acceptedAt, completedAt, locationSharingStoppedAt: completedAt, version: completedAt ? 2 : acceptedAt ? 1 : 0, createdAt: selectedAt,
    paymentAgreement: acceptedAt ? { create: { agreedAmountMinor: amount, paymentMethod: 'CASH', paymentTiming: 'AT_DELIVERY', confirmedByRequesterAt: acceptedAt, confirmedByRunnerAt: acceptedAt, createdAt: acceptedAt } } : undefined,
  } });
  const path: Array<{ status: ErrandStatus; minute: number }> = [
    { status: 'RUNNER_SELECTED', minute: 4 }, { status: 'ACCEPTED', minute: 6 }, { status: 'IN_PROGRESS', minute: 10 },
    { status: 'PICKED_UP', minute: 25 }, { status: 'DELIVERED', minute: 65 }, { status: 'COMPLETED', minute: 90 },
  ];
  const reached = path.slice(0, path.findIndex((step) => step.status === status) + 1);
  let from: ErrandStatus = 'OPEN';
  for (const [index, step] of reached.entries()) {
    const actorId = step.status === 'RUNNER_SELECTED' || step.status === 'COMPLETED' ? requester.id : runner.id;
    await tx.errandStatusHistory.create({ data: { id: demoId(`history:${id}:${step.status}`), errandId: id, fromStatus: from, toStatus: step.status, actorType: 'USER', actorId, reason: 'Local demo lifecycle fixture', version: index + 2, createdAt: minutes(publishedAt, step.minute) } });
    if (['IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'COMPLETED'].includes(step.status)) {
      const type = step.status === 'IN_PROGRESS' ? 'STARTED' : step.status as 'PICKED_UP' | 'DELIVERED' | 'COMPLETED';
      await tx.executionEvent.create({ data: { id: demoId(`execution:${id}:${type}`), assignmentId, errandId: id, type, actorId, actorType: 'USER', note: 'Synthetic demo event', createdAt: minutes(publishedAt, step.minute) } });
      if (type === 'PICKED_UP' || type === 'DELIVERED') {
        await tx.checkpoint.create({ data: { id: demoId(`checkpoint:${id}:${type}`), assignmentId, type: type === 'PICKED_UP' ? 'PICKUP' : 'DELIVERY', capturedAt: minutes(publishedAt, step.minute), note: 'Demo checkpoint; no device location recorded.' } });
      }
    }
    from = step.status;
  }
}

async function seedErrand(context: DemoContext, requester: DemoUser, scenario: string, status: ErrandStatus, categoryId: string, offset: number) {
  const { tx, now } = context;
  const id = errandId(requester, scenario);
  if (await tx.errand.findUnique({ where: { id } })) return;
  const completed = status === 'COMPLETED';
  const draft = status === 'DRAFT';
  const version = ['DRAFT', 'OPEN', 'RUNNER_SELECTED', 'ACCEPTED', 'IN_PROGRESS', 'PICKED_UP', 'DELIVERED', 'COMPLETED'].indexOf(status);
  const publishedAt = minutes(now, completed ? -(offset + 1) * 24 * 60 - 120 : status === 'EXPIRED' ? -2 * 24 * 60 : status === 'RUNNER_SELECTED' ? -5 : -100);
  const scheduled = scenario === 'open-scheduled';
  const { pickup } = demoErrandRoute(requester, scenario);
  const amount = BigInt(250000 + requester.index * 15000 + offset * 10000);
  await tx.$executeRaw`
    INSERT INTO errands (id, requester_id, category_id, title, description, instructions, status, priority, time_mode, scheduled_at,
      suggested_budget_minor, item_size, prohibited_items_confirmed_at, prohibited_policy_version, published_at, expires_at,
      delivered_at, completed_at, auto_complete_at, cancelled_at, cancellation_reason, cancelled_by, cancelled_by_type,
      feed_point, offer_count, material_version, version, created_at, updated_at)
    VALUES (${id}::uuid, ${requester.id}::uuid, ${categoryId}::uuid, ${`${titles[scenario]} in ${pickup.area}`},
      ${`${requester.name.split(' ')[0]} needs help with a small local errand in ${pickup.area}. This is a synthetic demo job for testing.`},
      'Please keep the package sealed and message me when you arrive.', ${status}::"ErrandStatus",
      ${scheduled ? 'STANDARD' : 'URGENT'}::"ErrandPriority", ${scheduled ? 'SCHEDULED' : 'ASAP'}::"TimeMode", ${scheduled ? minutes(now, 180) : null}::timestamptz,
      ${amount}::bigint, 'SMALL'::"ItemSize", ${draft ? null : publishedAt}::timestamptz, ${draft ? null : '1.0'}, ${draft ? null : publishedAt}::timestamptz,
      ${draft ? null : scheduled ? minutes(now, 180 - DEFAULTS.SCHEDULED_EXPIRY_BUFFER_MINUTES) : minutes(publishedAt, DEFAULTS.ERRAND_EXPIRY_HOURS * 60)}::timestamptz,
      ${completed || status === 'DELIVERED' ? minutes(publishedAt, 65) : null}::timestamptz, ${completed ? minutes(publishedAt, 90) : null}::timestamptz,
      ${status === 'DELIVERED' ? minutes(publishedAt, 65 + DEFAULTS.DELIVERY_AUTO_COMPLETION_HOURS * 60) : null}::timestamptz, ${status === 'CANCELLED' ? minutes(publishedAt, 15) : null}::timestamptz,
      ${status === 'CANCELLED' ? 'REQUESTER_CANCELLED' : null}::"ErrandCancellationReason", ${status === 'CANCELLED' ? requester.id : null}::uuid,
      ${status === 'CANCELLED' ? 'USER' : null}::"AuditActorType",
      ST_SetSRID(ST_MakePoint(${pickup.point.lng}::float8, ${pickup.point.lat}::float8),4326)::geography,
      ${status === 'OPEN' ? 2 : 0}, ${draft ? 0 : 1}, ${version < 0 ? 2 : version}, ${minutes(publishedAt, -10)}, ${now})
  `;
  await writeDemoLocations(context, requester, scenario);
  const settings = configuration();
  const seal = (field: string, value: string) => encrypt(value, settings.security.dataEncryptionKey, { aad: `errand:${id}:${field}` });
  await tx.errandContact.create({ data: { errandId: id, encryptionKeyId: 'primary', pickupName: seal('pickup_name', 'Demo shop attendant'), pickupPhone: seal('pickup_phone', requester.phone), dropoffName: seal('dropoff_name', requester.name), dropoffPhone: seal('dropoff_phone', requester.phone) } });
  await tx.errandStatusHistory.create({ data: { id: demoId(`history:${id}:DRAFT`), errandId: id, toStatus: 'DRAFT', actorType: 'USER', actorId: requester.id, reason: 'Local demo draft', version: 0, createdAt: minutes(publishedAt, -10) } });
  if (draft) return;
  await tx.errandStatusHistory.create({ data: { id: demoId(`history:${id}:OPEN`), errandId: id, fromStatus: 'DRAFT', toStatus: 'OPEN', actorType: 'USER', actorId: requester.id, reason: 'Demo errand published', version: 1, createdAt: publishedAt } });
  if (status === 'OPEN') {
    for (let i = 0; i < 2; i++) await seedOffer(context, id, requester, runnerFor(requester, i), false, minutes(publishedAt, 5 + i), amount + BigInt(i * 20000));
  } else if (status === 'CANCELLED' || status === 'EXPIRED') {
    await tx.errandStatusHistory.create({ data: { id: demoId(`history:${id}:${status}`), errandId: id, fromStatus: 'OPEN', toStatus: status, actorType: status === 'EXPIRED' ? 'SYSTEM' : 'USER', actorId: status === 'EXPIRED' ? null : requester.id, reason: 'Synthetic closed-job example', version: 2, createdAt: minutes(publishedAt, status === 'EXPIRED' ? 24 * 60 : 15) } });
  } else await seedAssignment(context, id, status, requester, runnerFor(requester, completed ? offset : 0), publishedAt, amount);
}

export async function seedDemoErrands(context: DemoContext): Promise<void> {
  const categories = await context.tx.category.findMany();
  const category = (key: string) => {
    const found = categories.find((row) => row.key === key);
    if (!found) throw new Error(`Baseline category ${key} is missing.`);
    return found.id;
  };
  for (const requester of demoRequesters) {
    for (const [index, scenario] of completedScenarios.entries()) await seedErrand(context, requester, scenario, 'COMPLETED', category('delivery'), index);
    await seedErrand(context, requester, 'draft', 'DRAFT', category('shopping_purchase'), 0);
    await seedErrand(context, requester, 'open', 'OPEN', category('pickup'), 0);
    await seedErrand(context, requester, 'open-scheduled', 'OPEN', category('document'), 0);
    await seedErrand(context, requester, 'pending', 'RUNNER_SELECTED', category('delivery'), 0);
    await seedErrand(context, requester, 'active', activeScenario(requester.index), category('delivery'), 0);
    await seedErrand(context, requester, 'cancelled', 'CANCELLED', category('pickup'), 0);
    await seedErrand(context, requester, 'expired', 'EXPIRED', category('pickup'), 0);
  }
  // Never replenish a consumed daily allowance when the fixtures are rerun.
  await context.tx.$executeRaw`
    INSERT INTO offer_daily_counters (user_id, day_lagos, count, updated_at)
    SELECT runner_id, to_char(created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD'), count(*)::int, now()
    FROM offers WHERE runner_id = ANY(${demoRequesters.map((requester) => runnerFor(requester).id)}::uuid[])
    GROUP BY runner_id, to_char(created_at AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')
    ON CONFLICT (user_id, day_lagos) DO UPDATE SET count = GREATEST(offer_daily_counters.count, EXCLUDED.count), updated_at = now()
  `;
}
