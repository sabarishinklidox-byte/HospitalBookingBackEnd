-- CreateEnum
CREATE TYPE "public"."NotificationType" AS ENUM ('CANCELLATION', 'RESCHEDULE');

-- CreateTable
CREATE TABLE "public"."Notification" (
    "id" TEXT NOT NULL,
    "clinicId" TEXT NOT NULL,
    "type" "public"."NotificationType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Notification_clinicId_type_readAt_idx" ON "public"."Notification"("clinicId", "type", "readAt");

-- CreateIndex
CREATE INDEX "Notification_clinicId_readAt_idx" ON "public"."Notification"("clinicId", "readAt");
