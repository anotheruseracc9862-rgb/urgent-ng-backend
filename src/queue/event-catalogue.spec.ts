import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EVENT_TO_QUEUE_MAP } from './queue.registry.js';

/**
 * An outbox event type that is not in the queue registry makes the publisher throw, and the row
 * dead-letters after ten attempts (this broke `offer.submitted` in Phase 6). So every event type
 * written anywhere in the source must be registered.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'test') continue;
      out.push(...sourceFiles(path));
    } else if (path.endsWith('.ts') && !path.endsWith('.spec.ts') && !path.endsWith('.int-spec.ts') && !path.endsWith('.d.ts')) {
      out.push(path);
    }
  }
  return out;
}

const PATTERNS = [
  /eventType:\s*'([a-z_]+\.[a-z_]+)'/g,
  /publish\(\s*[A-Za-z_.]+,\s*'([a-z_]+\.[a-z_]+)'/g,
  /outbox:\s*'([a-z_]+\.[a-z_]+)'/g,
];

describe('outbox event catalogue', () => {
  const found = new Map<string, string>();
  for (const file of sourceFiles('src')) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        found.set(match[1], file);
      }
    }
  }

  it('finds the event types the code writes', () => {
    expect(found.size).toBeGreaterThan(20);
    expect(found.has('assignment.selected')).toBe(true);
    expect(found.has('offer.created')).toBe(true);
  });

  it('registers every one of them in the queue map', () => {
    const missing = [...found.entries()].filter(([type]) => !(type in EVENT_TO_QUEUE_MAP)).map(([type, file]) => `${type} (${file})`);
    expect(missing).toEqual([]);
  });
});
