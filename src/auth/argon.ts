import * as argon2 from 'argon2';

/** Argon2id parameters for every password hash (Backend PRD 9.3). Shared with the admin CLI. */
export const ARGON_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 65536, // 64 MB
  timeCost: 3,
  parallelism: 4,
} as const;
