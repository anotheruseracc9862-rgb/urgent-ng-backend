/**
 * Database seed script
 * Run with: npm run prisma:seed
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting database seed...');

  // TODO: Add seed data when models are created
  // Example:
  // await prisma.user.createMany({
  //   data: [
  //     { email: 'admin@urgent.ng', ... },
  //   ],
  // });

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
