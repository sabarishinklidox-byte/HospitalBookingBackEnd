-- AlterTable
ALTER TABLE "public"."plans" ADD COLUMN     "enableBulkSlots" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enableExports" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "enableReviews" BOOLEAN NOT NULL DEFAULT true;
