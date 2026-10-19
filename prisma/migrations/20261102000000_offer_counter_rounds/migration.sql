-- Counter-offers made so far in this negotiation. The cap is the MAX_NEGOTIATION_ROUNDS business config.
-- Edits by the runner and agreed amount changes after selection do not count. Existing offers start at 0.
ALTER TABLE "offers" ADD COLUMN "counter_rounds" INTEGER NOT NULL DEFAULT 0;
