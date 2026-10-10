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

export class OfferReconfirmationHookImpl implements OfferReconfirmationHook {
  async flagOffers(tx: Prisma.TransactionClient, errandId: string): Promise<number> {
    const offerModel = (tx as any).offer ?? (tx as any).offers;
    if (!offerModel?.updateMany) {
      return 0;
    }

    try {
      const result = await offerModel.updateMany({
        where: { errandId, status: 'ACTIVE' },
        data: {
          needsReconfirmation: true,
          awaitingParty: 'RUNNER',
          version: { increment: 1 },
          updatedAt: new Date(),
        },
      });
      return Number(result?.count ?? 0);
    } catch {
      return 0;
    }
  }
}

export class NoopOfferReconfirmationHook extends OfferReconfirmationHookImpl {}
