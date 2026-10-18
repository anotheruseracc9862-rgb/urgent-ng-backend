import type { KycRegistryIdentity } from '../common/providers/kyc.provider.js';

/**
 * Compare what the runner typed with the registry record the provider returned. A selfie match
 * proves the face belongs to the NIN or BVN record: it does not prove the typed name and date of
 * birth belong to that record. This does.
 */

export interface TypedIdentity {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
}

/** Lower case, no accents, letters only. "O'Brien-Ade" gives ["obrien", "ade"]. */
export function nameTokens(...parts: Array<string | undefined>): string[] {
  return parts
    .filter((part): part is string => Boolean(part))
    .flatMap((part) =>
      part
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/['’]/g, '')
        .replace(/[^a-z]+/g, ' ')
        .split(' '),
    )
    .filter((token) => token.length > 0);
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) {
    return false;
  }
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) {
      return false;
    }
    if (a.length > b.length) {
      i += 1;
    } else if (a.length < b.length) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** Equal, or one typo apart when both words are long enough for a typo to be the likelier reason. */
function sameToken(a: string, b: string): boolean {
  return a === b || (a.length >= 5 && b.length >= 5 && withinOneEdit(a, b));
}

const hasMatch = (token: string, pool: string[]) => pool.some((other) => sameToken(token, other));

/**
 * True when the typed names and the registry names are the same person's names. Word order and
 * a middle name on only one side do not matter.
 *   - Every typed word must be a word of the registry record (first, middle or last).
 *   - The registry first name and the registry last name must each be seen in what was typed.
 */
export function namesMatch(typed: Pick<TypedIdentity, 'firstName' | 'lastName'>, registry: KycRegistryIdentity): boolean {
  const typedTokens = nameTokens(typed.firstName, typed.lastName);
  const registryFirst = nameTokens(registry.firstName);
  const registryLast = nameTokens(registry.lastName);
  const registryAll = [...registryFirst, ...nameTokens(registry.middleName), ...registryLast];
  if (typedTokens.length === 0 || registryFirst.length === 0 || registryLast.length === 0) {
    return false;
  }
  return (
    typedTokens.every((token) => hasMatch(token, registryAll)) &&
    registryFirst.some((token) => hasMatch(token, typedTokens)) &&
    registryLast.some((token) => hasMatch(token, typedTokens))
  );
}

export function identityMatches(typed: TypedIdentity, registry: KycRegistryIdentity): boolean {
  return typed.dateOfBirth === registry.dateOfBirth && namesMatch(typed, registry);
}

/**
 * A stable text for the same person across different id types: date of birth plus the first and
 * last name words, sorted so "Ada Okafor" and "Okafor Ada" give the same text. Middle names are
 * left out because registries disagree about them.
 */
export function personKey(registry: KycRegistryIdentity): string {
  const words = [...new Set(nameTokens(registry.firstName, registry.lastName))].sort();
  return `person:${registry.dateOfBirth}:${words.join(' ')}`;
}
