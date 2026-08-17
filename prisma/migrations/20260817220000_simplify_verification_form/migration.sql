ALTER TABLE "verifications"
ADD COLUMN "oocName" TEXT;

ALTER TABLE "verifications"
ALTER COLUMN "rpSurname" DROP NOT NULL;

ALTER TABLE "verifications"
ALTER COLUMN "citizenId" DROP NOT NULL;

ALTER TABLE "verifications"
ALTER COLUMN "phone" DROP NOT NULL;

ALTER TABLE "verifications"
ALTER COLUMN "referral" DROP NOT NULL;