/**
 * Database seed script
 * Run with: npm run prisma:seed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting database seed...');

  // Seed commercial products
  console.log('Seeding commercial products...');
  
  const verificationProduct = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO commercial_products (code, name, description, type, active)
    VALUES (
      'VERIFICATION_FEE',
      'Runner Verification',
      'One-time verification fee for runner identity confirmation',
      'VERIFICATION_FEE',
      true
    )
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;

  const proProduct = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO commercial_products (code, name, description, type, active)
    VALUES (
      'RUNNER_PRO',
      'Runner Pro Subscription',
      '30-day Runner Pro subscription with priority placement and higher offer limits',
      'RUNNER_PRO',
      true
    )
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;

  const boostProduct = await prisma.$queryRaw<Array<{ id: string }>>`
    INSERT INTO commercial_products (code, name, description, type, active)
    VALUES (
      'PRIORITY_BOOST',
      'Priority Boost',
      'Boost your errand to the top of the feed for increased visibility',
      'PRIORITY_BOOST',
      true
    )
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `;

  console.log('✓ Commercial products seeded');

  // Seed initial prices
  console.log('Seeding initial prices...');

  const now = new Date();

  // Verification fee: ₦0 (mechanism kept but free at launch)
  await prisma.$executeRaw`
    INSERT INTO price_versions (product_id, amount_kobo, effective_from, notes)
    VALUES (
      ${verificationProduct[0].id}::uuid,
      0,
      ${now},
      'Launch pricing: free verification'
    )
    ON CONFLICT (product_id, effective_from) DO NOTHING
  `;

  // Runner Pro: ₦5,000 per 30 days
  await prisma.$executeRaw`
    INSERT INTO price_versions (product_id, amount_kobo, effective_from, notes)
    VALUES (
      ${proProduct[0].id}::uuid,
      500000,
      ${now},
      'Launch pricing: ₦5,000/month'
    )
    ON CONFLICT (product_id, effective_from) DO NOTHING
  `;

  // Priority Boost: ₦1,000 per 24 hours
  await prisma.$executeRaw`
    INSERT INTO price_versions (product_id, amount_kobo, effective_from, notes)
    VALUES (
      ${boostProduct[0].id}::uuid,
      100000,
      ${now},
      'Launch pricing: ₦1,000/24h'
    )
    ON CONFLICT (product_id, effective_from) DO NOTHING
  `;

  console.log('✓ Initial prices seeded');

  console.log('✓ Database seeded successfully');
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('✗ Seed failed:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
