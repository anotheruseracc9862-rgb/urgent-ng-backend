/**
 * True when a database error is the "one verified account per identity" unique index.
 * Prisma raw queries report the violated key (`Key (identity_ref_hmac)=...`) but not always the
 * index name, so both are accepted.
 */
export function isIdentityConflict(error: unknown): boolean {
  const text = String(error);
  return text.includes('verification_attempts_identity_verified_unique') || (text.includes('23505') && text.includes('identity_ref_hmac'));
}
