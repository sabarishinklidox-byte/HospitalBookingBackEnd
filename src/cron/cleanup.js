// src/cron/cleanup.js - PRODUCTION READY!
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const cleanupExpiredBookings = async () => {
  try {
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 🔥 SLOTS
    const expiredSlots = await prisma.slot.updateMany({
      where: {
        isBlocked: true,
        createdAt: { lt: tenMinutesAgo }
      },
      data: { isBlocked: false, status: 'PENDING_PAYMENT' }
    });

    // 🔥 PENDING_PAYMENT Appointments
    const expiredAppts = await prisma.appointment.updateMany({
      where: {
        status: 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
        OR: [{ createdAt: { lt: tenMinutesAgo } }, { updatedAt: { lt: tenMinutesAgo } }]
      },
      data: { status: 'CANCELLED', paymentStatus: 'FAILED', financialStatus: null }
    });

    // 🔥 STALE PENDING
    const stalePending = await prisma.appointment.updateMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: oneDayAgo }
      },
      data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
    });

    const blockedLeft = await prisma.slot.count({ where: { isBlocked: true } });

    console.log(`🧹 Cleanup @ ${now.toLocaleTimeString()}:`);
    console.log(`  → Slots: ${expiredSlots.count} | Appts: ${expiredAppts.count} | Stale: ${stalePending.count}`);
    console.log(`  → Blocked left: ${blockedLeft}`);

  } catch (error) {
    console.error('❌ Cleanup Error:', error);
  }
};

cleanupExpiredBookings();
setInterval(cleanupExpiredBookings, 5 * 60 * 1000);
