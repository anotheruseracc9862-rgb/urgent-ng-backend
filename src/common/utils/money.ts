/**
 * Money utility for handling Nigerian Naira in kobo (minor units)
 * All monetary values are stored as integer kobo (1 Naira = 100 kobo)
 *
 * The database stores kobo as BigInt and the API exposes a plain JSON number.
 * Inside the application kobo is a JavaScript number that is always an integer
 * within the safe range, which is far above any realistic amount.
 */
export class Money {
  private readonly kobo: number;

  // 9.2 trillion Naira in kobo; well inside Number.MAX_SAFE_INTEGER
  private static readonly MIN_KOBO = 0;
  private static readonly MAX_KOBO = 922_337_203_685_477;

  private constructor(kobo: number) {
    if (!Number.isInteger(kobo)) {
      throw new Error('Money amount must be an integer (kobo)');
    }
    if (kobo < Money.MIN_KOBO || kobo > Money.MAX_KOBO) {
      throw new Error(
        `Money amount must be between ${Money.MIN_KOBO} and ${Money.MAX_KOBO} kobo`,
      );
    }
    this.kobo = kobo;
  }

  static fromKobo(kobo: number): Money {
    return new Money(kobo);
  }

  /** Convert a Prisma `BigInt` column value. */
  static fromBigInt(kobo: bigint): Money {
    if (
      kobo < BigInt(Money.MIN_KOBO) ||
      kobo > BigInt(Money.MAX_KOBO)
    ) {
      throw new Error(
        `Money amount must be between ${Money.MIN_KOBO} and ${Money.MAX_KOBO} kobo`,
      );
    }
    return new Money(Number(kobo));
  }

  /**
   * Exact parser for a decimal naira string such as "8500", "8500.5" or
   * "8,500.50". Preferred over `fromNaira` for user input because it never
   * goes through floating point.
   */
  static fromNairaString(value: string): Money {
    const cleaned = value.trim().replace(/[₦,\s]/g, '');
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
    if (!match) {
      throw new Error('Invalid naira amount');
    }
    const naira = Number(match[1]);
    const kobo = Number((match[2] ?? '').padEnd(2, '0') || '0');
    return new Money(naira * 100 + kobo);
  }

  /** Convenience for trusted numeric input; use `fromNairaString` for user input. */
  static fromNaira(naira: number): Money {
    const kobo = Math.round(naira * 100);
    return new Money(kobo);
  }

  toKobo(): number {
    return this.kobo;
  }

  /** Value for a Prisma `BigInt` column. */
  toBigInt(): bigint {
    return BigInt(this.kobo);
  }

  toNaira(): number {
    return this.kobo / 100;
  }

  add(other: Money): Money {
    return Money.fromKobo(this.kobo + other.kobo);
  }

  subtract(other: Money): Money {
    return Money.fromKobo(this.kobo - other.kobo);
  }

  multiply(factor: number): Money {
    return Money.fromKobo(Math.round(this.kobo * factor));
  }

  divide(divisor: number): Money {
    if (divisor === 0) {
      throw new Error('Cannot divide by zero');
    }
    return Money.fromKobo(Math.round(this.kobo / divisor));
  }

  equals(other: Money): boolean {
    return this.kobo === other.kobo;
  }

  greaterThan(other: Money): boolean {
    return this.kobo > other.kobo;
  }

  lessThan(other: Money): boolean {
    return this.kobo < other.kobo;
  }

  toString(): string {
    return `₦${this.toNaira().toFixed(2)}`;
  }
}
