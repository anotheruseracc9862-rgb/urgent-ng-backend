export class OfferDailyCounter {
  public readonly userId: string;
  public readonly dayLagos: string;
  public count: number;

  constructor(userId: string, dayLagos: string, count: number = 0) {
    this.userId = userId;
    this.dayLagos = dayLagos;
    this.count = Math.max(0, count);
  }

  static key(userId: string, dayLagos: string): string {
    return `${userId}:${dayLagos}`;
  }

  increment(delta: number = 1): number {
    this.count = Math.max(0, this.count + delta);
    return this.count;
  }

  clone(): OfferDailyCounter {
    return new OfferDailyCounter(this.userId, this.dayLagos, this.count);
  }
}
