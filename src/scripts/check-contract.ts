/**
 * Compares the committed openapi.json with the API as it is built now. Run with:
 *
 *   npm run contract:check
 *
 * Exits 1 and lists the differing routes when they are not the same. Regenerate on purpose with
 * `npm run build && npm run openapi` and commit the file with the change that caused it.
 */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { paths: Record<string, Record<string, unknown>>; components: unknown };
const committed = read('openapi.json');
const built = read(process.env.OPENAPI_OUT ?? 'openapi.check.json');

const ops = (doc: typeof committed) =>
  new Map(Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]) => [`${method.toUpperCase()} ${path}`, op] as const)));
const a = ops(committed);
const b = ops(built);
const problems: string[] = [];
for (const key of new Set([...a.keys(), ...b.keys()])) {
  if (!a.has(key)) problems.push(`+ ${key} (not in the committed contract)`);
  else if (!b.has(key)) problems.push(`- ${key} (removed from the API)`);
  else if (!isDeepStrictEqual(a.get(key), b.get(key))) problems.push(`~ ${key} (changed)`);
}
if (!isDeepStrictEqual(committed.components, built.components)) problems.push('~ components (schemas changed)');

if (problems.length > 0) {
  console.error(`openapi.json is out of date:\n${problems.join('\n')}`);
  process.exit(1);
}
console.log(`openapi.json is current (${a.size} operations).`);
