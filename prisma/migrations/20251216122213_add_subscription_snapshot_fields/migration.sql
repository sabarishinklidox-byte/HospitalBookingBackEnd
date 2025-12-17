-- AlterTable
ALTER TABLE "public"."subscriptions" ADD COLUMN     "durationDays" INTEGER,
ADD COLUMN     "isTrial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "maxBookingsPerPeriod" INTEGER,
ADD COLUMN     "maxDoctors" INTEGER,
ADD COLUMN     "priceAtPurchase" DECIMAL(65,30),
ADD COLUMN     "trialDays" INTEGER;
