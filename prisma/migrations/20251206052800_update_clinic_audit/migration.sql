-- AlterTable
ALTER TABLE "public"."audit_logs" ADD COLUMN     "clinicId" TEXT;

-- AlterTable
ALTER TABLE "public"."clinics" ADD COLUMN     "allowAuditView" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isActive" BOOLEAN NOT NULL DEFAULT true;

-- AddForeignKey
ALTER TABLE "public"."audit_logs" ADD CONSTRAINT "audit_logs_clinicId_fkey" FOREIGN KEY ("clinicId") REFERENCES "public"."clinics"("id") ON DELETE SET NULL ON UPDATE CASCADE;
