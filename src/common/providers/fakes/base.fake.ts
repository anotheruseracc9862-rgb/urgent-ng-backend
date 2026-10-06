/**
 * Base class for fake providers
 * Records calls and supports scripted outcomes
 */

export interface FakeCall {
  method: string;
  args: unknown[];
  timestamp: Date;
}

export abstract class BaseFake {
  private calls: FakeCall[] = [];
  protected scriptedOutcomes: Map<string, unknown[]> = new Map();

  /**
   * Record a method call
   */
  protected recordCall(method: string, ...args: unknown[]): void {
    this.calls.push({
      method,
      args,
      timestamp: new Date(),
    });
  }

  /**
   * Get all recorded calls
   */
  getCalls(method?: string): FakeCall[] {
    if (method) {
      return this.calls.filter((call) => call.method === method);
    }
    return [...this.calls];
  }

  /**
   * Clear recorded calls
   */
  clearCalls(): void {
    this.calls = [];
  }

  /**
   * Script a sequence of outcomes for a method
   * Each call to the method will return the next outcome in the sequence
   */
  scriptOutcomes(method: string, outcomes: unknown[]): void {
    this.scriptedOutcomes.set(method, [...outcomes]);
  }

  /**
   * Get the next scripted outcome for a method
   * Returns undefined if no outcomes are scripted
   */
  protected getNextOutcome<T>(method: string): T | undefined {
    const outcomes = this.scriptedOutcomes.get(method);
    if (!outcomes || outcomes.length === 0) {
      return undefined;
    }
    return outcomes.shift() as T;
  }

  /**
   * Check if method has scripted outcomes
   */
  protected hasScriptedOutcome(method: string): boolean {
    const outcomes = this.scriptedOutcomes.get(method);
    return outcomes !== undefined && outcomes.length > 0;
  }

  /**
   * Clear all scripted outcomes
   */
  clearScriptedOutcomes(): void {
    this.scriptedOutcomes.clear();
  }

  /**
   * Reset the fake (clear calls and scripted outcomes)
   */
  reset(): void {
    this.clearCalls();
    this.clearScriptedOutcomes();
  }
}
