// src/controllers/cronController.js
import prisma from '../prisma.js';

export const runExpirationCheck = async (req, res) => {
  try {
    console.log("⏰ Starting subscription expiration check...");
    const now = new Date();

    // 1. Fetch all ACTIVE subscriptions
    // We fetch related plan details to know the duration
    const activeSubscriptions = await prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        startDate: true,
        durationDays: true, // This is usually saved on the subscription itself
        clinicId: true,
        plan: {
          select: { durationDays: true } // Fallback if subscription doesn't have it
        }
      }
    });

    let expiredCount = 0;
    const expiredIds = [];

    // 2. Iterate and check dates
    for (const sub of activeSubscriptions) {
      // Determine duration (prefer subscription-specific duration, fallback to plan duration, default 30)
      const duration = sub.durationDays || sub.plan?.durationDays || 30;
      
      const startDate = new Date(sub.startDate);
      const expirationDate = new Date(startDate);
      expirationDate.setDate(startDate.getDate() + duration);

      // Check if NOW is past the Expiration Date
      if (now > expirationDate) {
        expiredIds.push(sub.id);
        expiredCount++;
      }
    }

    // 3. Bulk Update all expired subscriptions
    if (expiredIds.length > 0) {
      await prisma.subscription.updateMany({
        where: {
          id: { in: expiredIds }
        },
        data: {
          status: 'EXPIRED'
        }
      });
      console.log(`✅ Successfully expired ${expiredCount} subscriptions.`);
    } else {
      console.log("✅ No subscriptions expired today.");
    }

    // 4. Return success response (if called via API)
    if (res) {
      return res.json({
        success: true,
        checked: activeSubscriptions.length,
        expired: expiredCount,
        expiredIds: expiredIds
      });
    }

  } catch (error) {
    console.error("❌ Expiration Check Failed:", error);
    if (res) return res.status(500).json({ error: "Cron job failed" });
  }
};
