import * as argon2 from 'argon2';

/**
 * Argon2id parameters for every password hash (Backend PRD 9.3). Shared with the admin CLI.
 *
 * Tests (NODE_ENV=test only) use the cheapest legal setting. Hashing at full cost takes a
 * noticeable part of a second per user, and the integration suite creates hundreds of users;
 * the algorithm and the code path are the same, only the work factor differs. No other
 * environment can reach the cheap setting.
 */
const FULL = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
} as const;

const TEST = {
  type: argon2.argon2id,
  memoryCost: 1024, // 1 MB
  timeCost: 1,
  parallelism: 1,
} as const;

export const ARGON_OPTIONS = process.env.NODE_ENV === 'test' ? TEST : FULL;
