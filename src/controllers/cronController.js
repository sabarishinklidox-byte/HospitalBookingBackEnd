// src/controllers/cronController.js
import prisma from '../prisma.js';

export const runExpirationCheck = async (req, res) => {
  try {
    console.log("⏰ Starting subscription expiration check...");
    const now = new Date();

    const activeSubscriptions = await prisma.subscription.findMany({
      where: { status: 'ACTIVE' },
      select: {
        id: true,
        startDate: true,
        durationDays: true,
        clinicId: true,
        plan: {
          select: { durationDays: true }
        }
      }
    });

    let expiredCount = 0;
    const expiredIds = [];

    // 🔽 replace your old loop with THIS:
    for (const sub of activeSubscriptions) {
      const duration = sub.durationDays || sub.plan?.durationDays || 30;

      const startDate = new Date(sub.startDate);
      const expirationDate = new Date(startDate);
      expirationDate.setDate(startDate.getDate() + duration);

      console.log('CRON sub:', sub.id, 'clinicId:', sub.clinicId);
      console.log('  startDate:', startDate.toISOString());
      console.log('  duration:', duration);
      console.log('  expirationDate:', expirationDate.toISOString());
      console.log('  now:', now.toISOString());
      console.log('  expired?', now > expirationDate);

      if (now > expirationDate) {
        expiredIds.push(sub.id);
        expiredCount++;
      }
    }
    // 🔼 loop ends here

    if (expiredIds.length > 0) {
      await prisma.subscription.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: 'EXPIRED' }
      });
      console.log(`✅ Successfully expired ${expiredCount} subscriptions.`);
    } else {
      console.log("✅ No subscriptions expired today.");
    }

    if (res) {
      return res.json({
        success: true,
        checked: activeSubscriptions.length,
        expired: expiredCount,
        expiredIds,
      });
    }
  } catch (error) {
    console.error("❌ Expiration Check Failed:", error);
    if (res) return res.status(500).json({ error: "Cron job failed" });
  }
};

