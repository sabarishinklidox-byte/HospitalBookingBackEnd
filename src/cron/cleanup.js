// src/cron/cleanup.js - ✅ FIXED FOR RESCHEDULE RETRY!
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

const cleanupExpiredBookings = async () => {
  try {
    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // 🔥 SLOTS (unchanged)
    const expiredSlots = await prisma.slot.updateMany({
      where: {
        isBlocked: true,
        createdAt: { lt: tenMinutesAgo }
      },
      data: { isBlocked: false, status: 'PENDING_PAYMENT' }
    });

    // 🔥 PENDING_PAYMENT Appointments (FIXED - retry safe!)
    const expiredApptsResult = await prisma.$transaction(async (tx) => {
      const expiredRecords = await tx.appointment.findMany({
        where: {
          status: 'PENDING_PAYMENT',
          paymentStatus: 'PENDING',
          OR: [{ createdAt: { lt: tenMinutesAgo } }, { updatedAt: { lt: tenMinutesAgo } }]
        },
        select: { id: true, slotId: true }
      });

      // Keep reschedulable (status unchanged)
      await tx.appointment.updateMany({
        where: { id: { in: expiredRecords.map(r => r.id) } },
        data: { 
          paymentStatus: 'FAILED',
          paymentExpiry: now
        }
      });

      // Free held slots
      const slotIds = expiredRecords.map(r => r.slotId).filter(Boolean);
      if (slotIds.length) {
        await tx.slot.updateMany({
          where: { id: { in: slotIds } },
          data: { status: 'PENDING_PAYMENT', isBlocked: false, blockedReason: null }
        });
      }

      return { count: expiredRecords.length };
    });

    // 🔥 STALE PENDING (unchanged - true stale = cancel)
    const stalePending = await prisma.appointment.updateMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: oneDayAgo }
      },
      data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
    });

    const blockedLeft = await prisma.slot.count({ where: { isBlocked: true } });

    console.log(`🧹 Cleanup @ ${now.toLocaleTimeString()}:`);
    console.log(`  → Slots: ${expiredSlots.count} | Hold Appts: ${expiredApptsResult.count} | Stale: ${stalePending.count}`);
    console.log(`  → Blocked left: ${blockedLeft}`);

  } catch (error) {
    console.error('❌ Cleanup Error:', error);
  }
};

cleanupExpiredBookings();
setInterval(cleanupExpiredBookings, 5 * 60 * 1000);
