import type { KycRegistryIdentity } from './kyc.provider.js';

/**
 * Read the identity record out of a Dojah answer. Dojah documents two shapes for the NIN answer
 * (`first_name`/`last_name`/`date_of_birth` and `firstname`/`surname`/`birthdate`) and the BVN
 * answer uses the first. Both are read. Date formats differ too: `15-Apr-1985`, `10-06-1983`,
 * `1983-06-10`.
 *
 * Returns undefined when the names or the date of birth are missing or unreadable. The caller must
 * treat that as "cannot confirm", never as a match.
 */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

function iso(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return undefined;
  }
  return date.toISOString().slice(0, 10);
}

/** To YYYY-MM-DD. Day first for numeric dates: the registries are Nigerian. */
export function parseRegistryDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) {
    return undefined;
  }
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(raw);
  if (match) {
    return iso(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  match = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]*(\d{4})$/.exec(raw);
  if (match) {
    const month = MONTHS[match[2].toLowerCase()];
    return month ? iso(Number(match[3]), month, Number(match[1])) : undefined;
  }
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(raw);
  if (match) {
    return iso(Number(match[3]), Number(match[2]), Number(match[1]));
  }
  return undefined;
}

export function readRegistryIdentity(entity: Record<string, unknown> | undefined): KycRegistryIdentity | undefined {
  if (!entity) {
    return undefined;
  }
  const firstName = text(entity.first_name) ?? text(entity.firstname);
  const lastName = text(entity.last_name) ?? text(entity.surname) ?? text(entity.lastname);
  const middleName = text(entity.middle_name) ?? text(entity.middlename);
  const dateOfBirth = parseRegistryDate(entity.date_of_birth ?? entity.birthdate);
  if (!firstName || !lastName || !dateOfBirth) {
    return undefined;
  }
  return { firstName, lastName, ...(middleName ? { middleName } : {}), dateOfBirth };
}
