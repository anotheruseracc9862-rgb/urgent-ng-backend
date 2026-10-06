/**
 * Deterministic JSON serialisation for hashing and comparison.
 *
 * Object keys are sorted at EVERY level. (Do not use
 * `JSON.stringify(value, Object.keys(value).sort())`: that array is a
 * property allow-list applied at all depths, so it silently drops nested keys
 * and makes different payloads hash the same.)
 *
 * - `undefined` properties and functions are omitted, like JSON.stringify
 * - `Date` becomes its ISO string, `bigint` becomes a string
 * - arrays keep their order
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalise(value, new WeakSet())) ?? 'null';
}

function normalise(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value === undefined ? undefined : null;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (seen.has(value)) {
    throw new TypeError('Cannot serialise a circular structure');
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.map((item) => normalise(item, seen) ?? null);
    seen.delete(value);
    return items;
  }

  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const normalised = normalise((value as Record<string, unknown>)[key], seen);
    if (normalised !== undefined) {
      sorted[key] = normalised;
    }
  }
  seen.delete(value);
  return sorted;
}
