/**
 * Money utility for handling Nigerian Naira in kobo (minor units)
 * All monetary values are stored as integer kobo (1 Naira = 100 kobo)
 */
export class Money {
  private readonly kobo: number;

  // BigInt max safe value for kobo: 922,337,203,685,477 (approx 9.2 trillion Naira)
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

  static fromNaira(naira: number): Money {
    const kobo = Math.round(naira * 100);
    return new Money(kobo);
  }

  toKobo(): number {
    return this.kobo;
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
