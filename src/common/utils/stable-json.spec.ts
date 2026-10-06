import { describe, expect, it } from 'vitest';
import { stableStringify } from './stable-json.js';

describe('stableStringify', () => {
  it('sorts keys at every depth', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it('produces the same output regardless of key order', () => {
    expect(stableStringify({ a: 1, b: { x: 1, y: 2 } })).toBe(
      stableStringify({ b: { y: 2, x: 1 }, a: 1 }),
    );
  });

  it('keeps nested values, so different nested payloads differ (the old replacer-array bug)', () => {
    expect(stableStringify({ amount: { value: 100 } })).not.toBe(
      stableStringify({ amount: { value: 999999 } }),
    );
  });

  it('keeps array order and sorts objects inside arrays', () => {
    expect(stableStringify({ list: [{ b: 1, a: 2 }, 3] })).toBe(
      '{"list":[{"a":2,"b":1},3]}',
    );
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('handles Date, bigint, null and omits undefined', () => {
    expect(
      stableStringify({
        at: new Date('2026-10-06T00:00:00.000Z'),
        big: 12n,
        none: null,
        skip: undefined,
      }),
    ).toBe('{"at":"2026-10-06T00:00:00.000Z","big":"12","none":null}');
  });

  it('serialises primitives and null/undefined roots', () => {
    expect(stableStringify('x')).toBe('"x"');
    expect(stableStringify(5)).toBe('5');
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
  });

  it('rejects circular structures', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;

    expect(() => stableStringify(loop)).toThrow('circular');
  });

  it('allows the same object to appear twice without being circular', () => {
    const shared = { a: 1 };

    expect(stableStringify({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });
});
