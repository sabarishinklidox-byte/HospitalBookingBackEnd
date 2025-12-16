-- AlterTable
ALTER TABLE "public"."clinics" ADD COLUMN     "googleMapsUrl" TEXT,
ADD COLUMN     "googlePlaceId" TEXT,
ADD COLUMN     "googleReviewsEmbedCode" TEXT;

-- AlterTable
ALTER TABLE "public"."plans" ADD COLUMN     "enableGoogleReviews" BOOLEAN NOT NULL DEFAULT false;
