-- AlterTable
ALTER TABLE "public"."clinics" ADD COLUMN     "googleReviewsCache" JSONB,
ADD COLUMN     "googleTotalReviews" INTEGER,
ADD COLUMN     "lastGoogleSync" TIMESTAMP(3);
