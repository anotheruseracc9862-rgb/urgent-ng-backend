import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { OfferService } from '../offers/offer.service.js';

/**
 * Called inside the transaction of a material edit (Backend PRD 11.5): every live offer on the
 * errand is flagged `needsReconfirmation` and cannot be selected until its runner reconfirms
 * or withdraws. A failure here fails the edit: an edit never commits with offers left unflagged.
 */
export interface OfferReconfirmationHook {
  /** Returns how many offers were flagged. */
  flagOffers(tx: Prisma.TransactionClient, errandId: string): Promise<number>;
}

export const OFFER_RECONFIRMATION_HOOK = Symbol('OFFER_RECONFIRMATION_HOOK');

@Injectable()
export class OfferReconfirmationHookImpl implements OfferReconfirmationHook {
  constructor(private readonly offers: OfferService) {}

  flagOffers(tx: Prisma.TransactionClient, errandId: string): Promise<number> {
    return this.offers.flagForReconfirmation(tx, errandId);
  }
}
