-- CreateEnum
CREATE TYPE "public"."SlotPaymentMode" AS ENUM ('ONLINE', 'OFFLINE', 'FREE');

-- AlterTable
ALTER TABLE "public"."slots" ADD COLUMN     "paymentMode" "public"."SlotPaymentMode" NOT NULL DEFAULT 'ONLINE';
