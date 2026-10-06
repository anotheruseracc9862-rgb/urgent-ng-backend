/**
 * Global teardown. Each test worker closes its own Prisma and Redis clients in
 * `test/setup.db.ts`, so there is nothing to release here.
 */

export async function teardown(): Promise<void> {
  // intentionally empty
}
