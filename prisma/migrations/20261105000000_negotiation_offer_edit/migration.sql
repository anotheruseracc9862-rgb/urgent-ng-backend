-- A runner changing their own offer is not a counter-offer. It gets its own history type, so the price path can say so.
ALTER TYPE "NegotiationMessageType" ADD VALUE 'OFFER_EDIT';
