/** Local, additive demo fixtures. No API server, worker, vendor call or database reset required. */
import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import { DEMO_PASSWORD, demoUsers } from './demo-data.js';
import { assertDemoAccountOwnership, seedDemoAccounts } from './demo-accounts.js';
import { seedDemoErrands } from './demo-errands.js';
import { seedDemoActivity } from './demo-activity.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm run seed:demo [-- --stage accounts|errands|activity|all]\nStages include prerequisites. Local development/test databases only. Existing fixtures and tester changes are preserved; no reset is provided.');
    return;
  }
  const stage = args.length === 0 ? 'all' : args.length === 2 && args[0] === '--stage' ? args[1] : '';
  if (!['all', 'accounts', 'errands', 'activity'].includes(stage)) throw new Error('Unknown arguments. Use --help.');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    (process.env.NODE_ENV && !['development', 'test'].includes(process.env.NODE_ENV)) || /prod/i.test(url.pathname)) {
    throw new Error('Refusing demo seed: use a local, non-production database.');
  }
  const password = process.env.DEMO_SEED_PASSWORD ?? DEMO_PASSWORD;
  if (password.length < 12) throw new Error('DEMO_SEED_PASSWORD must have at least 12 characters.');
  const prisma = new PrismaClient();
  try {
    // Reuse the baseline seed: it preserves existing admin configuration and prices.
    const baseline = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../seed.ts', import.meta.url))], { stdio: 'inherit', env: process.env });
    if (baseline.error || baseline.status !== 0) throw new Error('Baseline seed failed. Check the database connection and migrations.');
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(20261018, 1001)`;
      const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
      const context = { tx, now, passwordHash };
      await assertDemoAccountOwnership(context);
      await seedDemoAccounts(context);
      if (stage !== 'accounts') await seedDemoErrands(context);
      if (stage === 'all' || stage === 'activity') await seedDemoActivity(context);
    }, { timeout: 120_000, maxWait: 10_000 });
    console.log(`\nDemo seed (${stage}) complete on ${url.hostname}${url.pathname}. Existing records were not reset.`);
    console.table(demoUsers.map((user) => ({ mode: user.mode, name: user.name, email: user.email, phone: `0${user.phone.slice(4)}`, area: user.region.area })));
    console.log(process.env.DEMO_SEED_PASSWORD ? 'New accounts use DEMO_SEED_PASSWORD (not printed).' : `New demo accounts use password: ${DEMO_PASSWORD}`);
    console.log('Existing passwords are unchanged. These demo credentials must never be used outside local development.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Demo seed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
