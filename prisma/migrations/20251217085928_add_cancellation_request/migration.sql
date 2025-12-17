-- CreateEnum
CREATE TYPE "public"."CancellationActor" AS ENUM ('USER', 'ADMIN');

-- AlterTable
ALTER TABLE "public"."appointments" ADD COLUMN     "cancelledBy" "public"."CancellationActor";
