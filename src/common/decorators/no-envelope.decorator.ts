import { SetMetadata } from '@nestjs/common';

export const NO_ENVELOPE_KEY = 'no-envelope';

/**
 * Decorator to opt out of response envelope wrapping.
 * Use for SSE endpoints, webhooks, and raw responses.
 */
export const NoEnvelope = () => SetMetadata(NO_ENVELOPE_KEY, true);
