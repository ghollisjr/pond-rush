// A tiny expect() shim so the suite runs on node:test with no dependencies.
// Swap for vitest's if you'd rather; the assertions used here are identical.
import assert from "node:assert/strict";

export interface Expectation<T> {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toHaveLength(n: number): void;
  toBeGreaterThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toThrow(): void;
  readonly not: Expectation<T>;
}

export function expect<T>(actual: T, negated = false): Expectation<T> {
  const check = (ok: boolean, message: string) => {
    assert.ok(negated ? !ok : ok, negated ? `not: ${message}` : message);
  };
  return {
    toBe: (expected) => check(Object.is(actual, expected), `expected ${String(actual)} to be ${String(expected)}`),
    toEqual: (expected) => {
      try {
        assert.deepStrictEqual(actual, expected);
        check(true, "");
      } catch (e) {
        if (!negated) throw e;
      }
    },
    toHaveLength: (n) => check((actual as { length?: number })?.length === n, `expected length ${n}, got ${(actual as { length?: number })?.length}`),
    toBeGreaterThan: (n) => check(Number(actual) > n, `expected ${String(actual)} > ${n}`),
    toBeLessThanOrEqual: (n) => check(Number(actual) <= n, `expected ${String(actual)} <= ${n}`),
    toThrow: () => {
      let threw = false;
      try {
        (actual as () => unknown)();
      } catch {
        threw = true;
      }
      check(threw, "expected function to throw");
    },
    get not() {
      return expect(actual, !negated);
    },
  };
}
