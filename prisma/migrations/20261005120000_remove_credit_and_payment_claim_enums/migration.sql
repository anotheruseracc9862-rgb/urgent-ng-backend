-- AlterEnum
BEGIN;
CREATE TYPE "DisputeType_new" AS ENUM ('ITEM_NOT_DELIVERED', 'ITEM_DAMAGED', 'ITEM_MISSING', 'WRONG_ITEM', 'UNAUTHORIZED_CHANGE', 'SAFETY_INCIDENT', 'OTHER');
ALTER TYPE "DisputeType" RENAME TO "DisputeType_old";
ALTER TYPE "DisputeType_new" RENAME TO "DisputeType";
DROP TYPE "public"."DisputeType_old";
COMMIT;

-- AlterEnum
BEGIN;
CREATE TYPE "EnforcementActionType_new" AS ENUM ('WARNING', 'FEATURE_RESTRICTION', 'TEMPORARY_SUSPENSION', 'PERMANENT_SUSPENSION', 'BADGE_REMOVAL', 'VERIFICATION_REVOCATION', 'CONTENT_REMOVAL');
ALTER TYPE "EnforcementActionType" RENAME TO "EnforcementActionType_old";
ALTER TYPE "EnforcementActionType_new" RENAME TO "EnforcementActionType";
DROP TYPE "public"."EnforcementActionType_old";
COMMIT;

-- DropEnum
DROP TYPE "CreditTransactionType";

-- DropEnum
DROP TYPE "PaymentDisputeStatus";

-- DropEnum
DROP TYPE "PaymentReportStatus";

