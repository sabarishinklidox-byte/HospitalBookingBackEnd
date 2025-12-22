-- AlterEnum
ALTER TYPE "public"."AppointmentStatus" ADD VALUE 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "public"."appointments" ADD COLUMN     "amount" DECIMAL(65,30),
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "paymentExpiry" TIMESTAMP(3),
ADD COLUMN     "paymentStatus" "public"."PaymentStatus" NOT NULL DEFAULT 'PENDING',
ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';

-- AlterTable
ALTER TABLE "public"."slots" ALTER COLUMN "status" SET DEFAULT 'PENDING_PAYMENT';
