import 'dotenv/config';
import { ConsentType, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();
const requiredConsents: ConsentType[] = [
  ConsentType.TERMS_OF_SERVICE,
  ConsentType.PRIVACY_POLICY,
  ConsentType.SAFETY_POLICY,
  ConsentType.PROHIBITED_ITEMS_POLICY,
  ConsentType.OFFLINE_PAYMENT_TERMS,
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL must be set.');

  const database = new URL(databaseUrl);
  if (
    !['localhost', '127.0.0.1', '::1'].includes(database.hostname) ||
    process.env.NODE_ENV === 'production'
  ) {
    throw new Error('Refusing to seed an API contract user outside a local, non-production database.');
  }

  const phone = process.env.API_CONTRACT_PHONE;
  const password = process.env.API_CONTRACT_PASSWORD;
  if (!phone || !password) {
    throw new Error('Set temporary API_CONTRACT_PHONE and API_CONTRACT_PASSWORD values for this process.');
  }

  if (await prisma.user.findUnique({ where: { phoneE164: phone }, select: { id: true } })) {
    throw new Error('That phone already exists; no existing account was changed.');
  }

  const user = await prisma.user.create({
    data: {
      name: 'API Contract Test',
      firstName: 'API',
      lastName: 'Contract Test',
      phoneE164: phone,
      phoneVerifiedAt: new Date(),
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      status: 'ACTIVE',
      profile: { create: {} },
      consentRecords: {
        create: requiredConsents.map((consentType) => ({
          consentType,
          documentVersion: '1.0',
          acceptedAt: new Date(),
        })),
      },
    },
    select: { id: true },
  });

  console.log(`Seeded API contract user ${user.id}; phone ends ${phone.slice(-4)}.`);
}

main()
  .catch((error: unknown) => {
    console.error('Failed to seed API contract user:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
