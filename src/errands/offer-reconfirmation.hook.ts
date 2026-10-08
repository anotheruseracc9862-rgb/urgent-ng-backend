import type { Prisma } from '@prisma/client';

/**
 * Called inside the transaction of a material edit (Backend PRD 11.5): every live offer on the
 * errand must be flagged `needsReconfirmation` and cannot be selected until its runner reconfirms
 * or withdraws. Offers arrive in Phase 6, which replaces the no-op below.
 */
export interface OfferReconfirmationHook {
  /** Returns how many offers were flagged. */
  flagOffers(tx: Prisma.TransactionClient, errandId: string): Promise<number>;
}

export const OFFER_RECONFIRMATION_HOOK = Symbol('OFFER_RECONFIRMATION_HOOK');

export class NoopOfferReconfirmationHook implements OfferReconfirmationHook {
  async flagOffers(): Promise<number> {
    return 0;
  }
}
