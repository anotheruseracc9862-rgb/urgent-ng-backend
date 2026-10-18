import { ConsentType, NotificationCategory, NotificationChannel } from '@prisma/client';
import { demoId, demoUsers, minutes, type DemoContext } from './demo-data.js';

export async function assertDemoAccountOwnership({ tx }: DemoContext): Promise<void> {
  const existing = await tx.user.findMany({ where: { OR: [
    { id: { in: demoUsers.map((user) => user.id) } },
    { email: { in: demoUsers.map((user) => user.email), mode: 'insensitive' } },
    { phoneE164: { in: demoUsers.map((user) => user.phone) } },
  ] } });
  for (const row of existing) {
    const expected = demoUsers.find((user) => user.id === row.id);
    if (!expected || row.email !== expected.email || row.phoneE164 !== expected.phone) {
      throw new Error('A demo identifier belongs to a different or edited account. No demo data was changed.');
    }
  }
}

export async function seedDemoAccounts({ tx, now, passwordHash }: DemoContext): Promise<void> {
  const policies = await tx.policyVersion.findMany({ where: { publishedAt: { lte: now } }, orderBy: { publishedAt: 'desc' } });
  const required: ConsentType[] = ['TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'SAFETY_POLICY', 'PROHIBITED_ITEMS_POLICY', 'OFFLINE_PAYMENT_TERMS', 'LOCATION_SHARING'];
  for (const user of demoUsers) {
    // An existing account is never reset, unlocked, re-verified or given a new password.
    if (await tx.user.findUnique({ where: { id: user.id } })) continue;
    const [firstName, ...lastName] = user.name.split(' ');
    const createdAt = minutes(now, -30 * 24 * 60);
    await tx.user.create({ data: {
      id: user.id, name: user.name, firstName, lastName: lastName.join(' '),
      email: user.email, phoneE164: user.phone, passwordHash, status: 'ACTIVE', startMode: user.mode,
      emailVerifiedAt: createdAt, phoneVerifiedAt: createdAt, createdAt,
      profile: { create: { homeArea: `${user.region.area}, ${user.region.name}`, bio: user.mode === 'RUNNER' ? 'Local demo runner. Careful with parcels and happy to help with everyday errands.' : 'Local demo requester testing everyday deliveries and shopping.', createdAt } },
      consentRecords: { create: required.map((consentType) => {
        const policy = policies.find((version) => version.type === consentType);
        if (!policy) throw new Error(`Run the baseline seed first: missing ${consentType}.`);
        return { id: demoId(`consent:${user.id}:${consentType}`), consentType, documentVersion: policy.version, acceptedAt: now, userAgent: 'local-demo-seed' };
      }) },
      verificationAttempts: { create: {
        id: demoId(`verification:${user.id}`), provider: 'LOCAL_DEMO', providerRequestId: `demo:${user.id}`,
        status: 'VERIFIED', attemptNumber: 1, providerStatus: 'synthetic-local-fixture', confidence: 99,
        maskedAttributes: { synthetic: true, ninLast4: 'DEMO' }, countsAgainstAllowance: false,
        startedAt: createdAt, completedAt: minutes(createdAt, 1), expiresAt: minutes(now, 365 * 24 * 60), createdAt,
      } },
      notificationPrefs: { create: Object.values(NotificationCategory).flatMap((category) => Object.values(NotificationChannel).map((channel) => ({ channel, category, enabled: channel === 'IN_APP' }))) },
    } });
    if (user.mode === 'RUNNER') {
      const mode = user.index === 4 ? 'LGAS' : user.index === 5 ? 'RADIUS' : 'STATE';
      const center = user.region.pickup;
      await tx.$executeRaw`
        INSERT INTO runner_profiles (user_id, transport, area_mode, area_state_ids, area_lga_ids, area_center, area_radius_km, availability, created_at, updated_at)
        VALUES (${user.id}::uuid, ${user.index % 2 ? 'BICYCLE' : 'MOTORCYCLE'}::"TransportMethod", ${mode},
          ${[user.region.stateId]}::text[], ${mode === 'LGAS' ? [user.region.lgaId] : []}::text[],
          CASE WHEN ${mode} = 'RADIUS' THEN ST_SetSRID(ST_MakePoint(${center.lng}::float8, ${center.lat}::float8),4326)::geography ELSE NULL END,
          10, 'AVAILABLE'::"RunnerAvailability", ${createdAt}, ${now})
      `;
    }
  }
}
