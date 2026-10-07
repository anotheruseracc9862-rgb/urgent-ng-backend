/**
 * Database seed. Run with: npm run prisma:seed
 *
 * Idempotent: safe to run again. It never overwrites a value an admin changed.
 * It loads, in order:
 *   1. every business config default (Backend PRD section 32)
 *   2. commercial products and their launch prices (Backend PRD 20)
 *   3. admin permissions and the default admin roles (Backend PRD 24.2)
 *   4. categories and their location rules (Backend PRD 11.2)
 *   5. prohibited-item rules (Backend PRD 11.9)
 *   6. version 1.0 of every policy (Backend PRD 9.6)
 * All times come from the database clock.
 */

import { PrismaClient } from '@prisma/client';
import { DEFAULTS } from '../src/config/business-config.defaults.js';
import { ADMIN_PERMISSIONS, DEFAULT_ADMIN_ROLES } from '../src/admin/admin.permissions.js';

const prisma = new PrismaClient();

async function seedConfig(): Promise<void> {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await prisma.$executeRaw`
      INSERT INTO config_values (key, value_json, version, effective_from)
      SELECT ${key}, ${JSON.stringify(value)}::jsonb, 1, now()
      WHERE NOT EXISTS (SELECT 1 FROM config_values WHERE key = ${key} AND deleted_at IS NULL)
    `;
  }
  console.log(`✓ ${Object.keys(DEFAULTS).length} config defaults`);
}

async function seedProducts(): Promise<void> {
  const products = [
    { code: 'VERIFICATION_FEE', name: 'Runner Verification', type: 'VERIFICATION_FEE', amountKobo: 0, note: 'Launch pricing: free verification (mechanism kept)' },
    { code: 'RUNNER_PRO', name: 'Runner Pro', type: 'RUNNER_PRO', amountKobo: 500000, note: 'Launch pricing: ₦5,000 per 30 days' },
    { code: 'PRIORITY_BOOST', name: 'Priority Boost', type: 'PRIORITY_BOOST', amountKobo: 100000, note: 'Launch pricing: ₦1,000 per boost' },
  ];

  for (const product of products) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO commercial_products (code, name, type)
      VALUES (${product.code}, ${product.name}, ${product.type})
      ON CONFLICT (code) WHERE deleted_at IS NULL DO UPDATE SET code = EXCLUDED.code
      RETURNING id
    `;
    await prisma.$executeRaw`
      INSERT INTO price_versions (product_id, amount_kobo, effective_from, notes)
      SELECT ${rows[0].id}::uuid, ${product.amountKobo}::bigint, now(), ${product.note}
      WHERE NOT EXISTS (SELECT 1 FROM price_versions WHERE product_id = ${rows[0].id}::uuid)
    `;
  }
  console.log(`✓ ${products.length} commercial products with launch prices`);
}

async function seedAdminRoles(): Promise<void> {
  for (const key of ADMIN_PERMISSIONS) {
    await prisma.$executeRaw`
      INSERT INTO admin_permissions (key) VALUES (${key}) ON CONFLICT (key) DO NOTHING
    `;
  }

  for (const [name, role] of Object.entries(DEFAULT_ADMIN_ROLES)) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO admin_roles (name, description, updated_at)
      VALUES (${name}, ${role.description}, now())
      ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
      RETURNING id
    `;
    for (const permission of role.permissions) {
      await prisma.$executeRaw`
        INSERT INTO admin_role_permissions (role_id, permission_key)
        VALUES (${rows[0].id}::uuid, ${permission})
        ON CONFLICT (role_id, permission_key) WHERE deleted_at IS NULL DO NOTHING
      `;
    }
  }
  console.log(`✓ ${ADMIN_PERMISSIONS.length} admin permissions, ${Object.keys(DEFAULT_ADMIN_ROLES).length} roles`);
}

async function seedCategories(): Promise<void> {
  const categories = [
    { key: 'delivery', name: 'Delivery', pickup: true, destination: true, popular: true },
    { key: 'pickup', name: 'Pickup', pickup: true, destination: false, popular: true },
    { key: 'shopping_purchase', name: 'Shopping & Purchase', pickup: false, destination: true, popular: true },
    { key: 'document', name: 'Document', pickup: true, destination: true, popular: false },
    { key: 'other', name: 'Other', pickup: true, destination: false, popular: false },
  ];

  for (const [index, category] of categories.entries()) {
    await prisma.$executeRaw`
      INSERT INTO categories (key, name, requires_pickup, requires_destination, sort_order, is_popular, updated_at)
      VALUES (${category.key}, ${category.name}, ${category.pickup}, ${category.destination}, ${index}, ${category.popular}, now())
      ON CONFLICT (key) DO NOTHING
    `;
  }
  console.log(`✓ ${categories.length} categories`);
}

async function seedProhibitedItems(): Promise<void> {
  const rules: Array<[string, string[]]> = [
    ['ILLEGAL_DRUGS', ['cocaine', 'heroin', 'marijuana', 'cannabis', 'methamphetamine', 'illegal drugs']],
    ['WEAPONS', ['gun', 'pistol', 'rifle', 'firearm', 'ammunition']],
    ['EXPLOSIVES', ['explosive', 'dynamite', 'grenade', 'detonator']],
    ['STOLEN_GOODS', ['stolen']],
    ['COUNTERFEIT_GOODS', ['counterfeit', 'fake currency', 'fake notes', 'pirated']],
    ['OTHER_ILLEGAL', ['illegal']],
  ];

  let count = 0;
  for (const [category, keywords] of rules) {
    for (const keyword of keywords) {
      await prisma.$executeRaw`
        INSERT INTO prohibited_item_rules (category, keyword, status, effective_from, policy_version, updated_at)
        SELECT ${category}, ${keyword}, 'ACTIVE', date_trunc('milliseconds', now()), '1.0', now()
        WHERE NOT EXISTS (
          SELECT 1 FROM prohibited_item_rules WHERE category = ${category} AND keyword = ${keyword} AND deleted_at IS NULL
        )
      `;
      count += 1;
    }
  }
  console.log(`✓ ${count} prohibited-item rules`);
}

async function seedPolicies(): Promise<void> {
  const types = [
    'TERMS_OF_SERVICE',
    'PRIVACY_POLICY',
    'SAFETY_POLICY',
    'PROHIBITED_ITEMS_POLICY',
    'OFFLINE_PAYMENT_TERMS',
    'LOCATION_SHARING',
    'MARKETING_COMMUNICATIONS',
  ];
  for (const type of types) {
    await prisma.$executeRaw`
      INSERT INTO policy_versions (type, version, document_ref, published_at)
      VALUES (${type}::"ConsentType", '1.0', ${`policies/${type.toLowerCase()}/1.0`}, date_trunc('milliseconds', now()))
      ON CONFLICT (type, version) DO NOTHING
    `;
  }
  console.log(`✓ ${types.length} policy versions (1.0)`);
}

async function main(): Promise<void> {
  console.log('Seeding...');
  await seedConfig();
  await seedProducts();
  await seedAdminRoles();
  await seedCategories();
  await seedProhibitedItems();
  await seedPolicies();
  console.log('✓ Seed complete');
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error('✗ Seed failed:', error);
    await prisma.$disconnect();
    process.exit(1);
  });
