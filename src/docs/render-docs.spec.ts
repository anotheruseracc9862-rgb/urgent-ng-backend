/**
 * P12-06: the reference documents match the code. Run `npm run docs` when this fails.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { renderErrorCatalogue, renderEventCatalogue } from './render-docs.js';

const read = (path: string) => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

describe('Generated documents (P12-06)', () => {
  it('docs/error-codes.md is current', () => {
    expect(read('docs/error-codes.md')).toBe(renderErrorCatalogue());
  });

  it('docs/events.md is current', () => {
    expect(read('docs/events.md')).toBe(renderEventCatalogue());
  });

  it('the runbook names every sweeper', () => {
    const runbook = read('docs/runbook.md');
    const classes = readdirSync('src/scheduler')
      .filter((file) => file.endsWith('.ts') && !file.endsWith('spec.ts') && file !== 'base-sweeper.ts' && file !== 'sweeper.registry.ts' && file !== 'main.ts' && file !== 'scheduler.module.ts')
      .flatMap((file) => [...read(`src/scheduler/${file}`).matchAll(/export class (\w+Sweeper) extends BaseSweeper/g)].map((m) => m[1]));
    expect(classes.length).toBeGreaterThan(15);
    const missing = classes.filter((name) => !runbook.includes(`\`${name}\``));
    expect(missing).toEqual([]);
  });
});
