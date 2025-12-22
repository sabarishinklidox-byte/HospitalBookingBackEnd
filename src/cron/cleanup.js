// src/cron/cleanup.js
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const cleanupExpiredBookings = async () => {
  try {
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // 1. Clean expired online payment holds
    //    - status = PENDING_PAYMENT
    //    - either paymentExpiry < now, or (no paymentExpiry and createdAt < 10min ago)
    const expiredPayments = await prisma.appointment.updateMany({
      where: {
        status: 'PENDING_PAYMENT',
        OR: [
          { paymentExpiry: { lt: now } },
          {
            AND: [
              { paymentExpiry: null },
              { createdAt: { lt: tenMinutesAgo } },
            ],
          },
        ],
      },
      data: {
        status: 'CANCELLED',
        paymentStatus: 'FAILED',
      },
    });

    // 2. Clean old unread notifications (30+ days)
    const oldNotifications = await prisma.notification.deleteMany({
      where: {
        createdAt: { lt: thirtyDaysAgo },
        readAt: null,
      },
    });

    console.log(`🧹 Cleanup @ ${now.toISOString()}:`);
    console.log(`   → Expired bookings: ${expiredPayments.count}`);
    console.log(`   → Old notifications: ${oldNotifications.count}`);
  } catch (error) {
    console.error('❌ Cleanup Error:', error);
  }
};

cleanupExpiredBookings();
setInterval(cleanupExpiredBookings, 5 * 60 * 1000);

process.on('SIGTERM', async () => {
  console.log('🛑 Shutting down cleanup...');
  await prisma.$disconnect();
  process.exit(0);
});
