-- AlterTable
ALTER TABLE "public"."plans" ADD COLUMN     "durationDays" INTEGER,
ADD COLUMN     "isTrial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trialDays" INTEGER;
