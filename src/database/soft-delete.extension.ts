/**
 * Soft deletion infrastructure (P1-10)
 * 
 * Per PRD §26.8, this module provides:
 * 1. Database triggers that prevent hard deletes on soft-deletable tables
 * 2. Documentation of soft-deletable vs never-deleted tables
 * 3. Helper functions to be used in future migrations
 * 
 * ## Soft-deletable tables (DELETE → UPDATE deleted_at)
 * These tables will have `deleted_at` columns and triggers installed when created:
 * - users
 * - profiles
 * - errands
 * - offers
 * - assignments
 * - messages
 * - conversations
 * - notifications
 * - disputes
 * - reports
 * - enforcement_actions
 * 
 * ## Never-deleted tables (append-only, no DELETE allowed)
 * These tables have triggers that always reject DELETE:
 * - audit_logs
 * - outbox_events
 * - idempotency_keys
 * - config_values
 * - commercial_products
 * - price_versions
 * 
 * ## Usage in migrations
 * 
 * When creating a soft-deletable table:
 * ```sql
 * CREATE TABLE users (
 *   id UUID PRIMARY KEY,
 *   email TEXT NOT NULL,
 *   deleted_at TIMESTAMPTZ,
 *   ...
 * );
 * 
 * -- Install soft delete trigger
 * SELECT create_soft_delete_trigger('users');
 * 
 * -- Unique constraints must include WHERE deleted_at IS NULL
 * CREATE UNIQUE INDEX users_email_unique 
 *   ON users(email) 
 *   WHERE deleted_at IS NULL;
 * ```
 * 
 * ## Application-level soft deletion
 * 
 * Until Prisma extensions support this pattern fully, implement soft deletion
 * in service layer:
 * 
 * ```typescript
 * // Instead of:
 * await prisma.user.delete({ where: { id } });
 * 
 * // Use:
 * await prisma.user.update({
 *   where: { id },
 *   data: { deletedAt: new Date() }
 * });
 * ```
 * 
 * And filter reads:
 * ```typescript
 * // Find non-deleted users
 * await prisma.user.findMany({
 *   where: { deletedAt: null }
 * });
 * 
 * // Find including deleted
 * await prisma.user.findMany({
 *   where: {} // no deletedAt filter
 * });
 * ```
 * 
 * ## Re-using unique values after soft delete
 * 
 * Because unique indexes include `WHERE deleted_at IS NULL`, a soft-deleted
 * row's unique values can be reused:
 * 
 * ```typescript
 * // Soft delete user
 * await prisma.user.update({
 *   where: { email: 'user@example.com' },
 *   data: { deletedAt: new Date() }
 * });
 * 
 * // Create new user with same email - succeeds!
 * await prisma.user.create({
 *   data: { email: 'user@example.com', ... }
 * });
 * ```
 */

export const SOFT_DELETE_README = `
Soft deletion infrastructure is installed.
See src/database/soft-delete.extension.ts for usage documentation.
`;
