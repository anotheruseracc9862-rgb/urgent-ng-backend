/**
 * Thrown by a real provider adapter when the call itself failed (network
 * error, timeout, 5xx). Business outcomes (a failed verification, a declined
 * charge) are returned as results, not thrown.
 */
export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
    public readonly options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}
