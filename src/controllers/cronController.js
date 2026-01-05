// src/controllers/cronController.js
import prisma from '../prisma.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function computeEndsAt(sub) {
  // Priority: subscription snapshot first, then plan fallback
  const plan = sub.plan || {};

  // TRIAL: use trialDays
  if (sub.isTrial) {
    const trialDays = sub.trialDays ?? plan.trialDays ?? 14;
    const endsAt = new Date(new Date(sub.startDate).getTime() + trialDays * MS_PER_DAY);
    return { type: 'TRIAL', days: trialDays, endsAt };
  }

  // FIXED DURATION plan: use durationDays
  const durationDays = sub.durationDays ?? plan.durationDays;
  if (durationDays && durationDays > 0) {
    const endsAt = new Date(new Date(sub.startDate).getTime() + durationDays * MS_PER_DAY);
    return { type: 'FIXED', days: durationDays, endsAt };
  }

  // RECURRING (monthly/yearly): recommended to use nextBillingDate to decide expiry
  // If you don't want to expire recurring in cron, return null here.
  if (sub.nextBillingDate) {
    return { type: 'RECURRING', days: null, endsAt: new Date(sub.nextBillingDate) };
  }

  // Fallback: treat as monthly 30 days from start
  const endsAt = new Date(new Date(sub.startDate).getTime() + 30 * MS_PER_DAY);
  return { type: 'FALLBACK_30D', days: 30, endsAt };
}

export const runExpirationCheck = async (req, res) => {
  try {
    console.log('⏰ Starting subscription expiration check...');
    const now = new Date();

    // Only ACTIVE subs should be used for access;
    // TRIAL can be represented by isTrial=true while status remains ACTIVE.
    const subs = await prisma.subscription.findMany({
      where: { status: 'ACTIVE', deletedAt: null },
      select: {
        id: true,
        clinicId: true,
        status: true,
        startDate: true,
        isTrial: true,
        trialDays: true,
        durationDays: true,
        nextBillingDate: true,
        plan: {
          select: { name: true, trialDays: true, durationDays: true },
        },
      },
    });

    let expiredCount = 0;
    const expiredIds = [];

    for (const sub of subs) {
      const meta = computeEndsAt(sub);

      const expired = now > meta.endsAt;
      const planName = sub.plan?.name || 'N/A';

      // ✅ Logs exactly what you asked
      console.log(
        `CRON sub=${sub.id} clinicId=${sub.clinicId} plan="${planName}" type=${meta.type}` +
          (meta.days != null ? ` days=${meta.days}` : '') +
          ` start=${new Date(sub.startDate).toISOString()} endsAt=${meta.endsAt.toISOString()} now=${now.toISOString()} expired?=${expired}`
      );

      if (expired) {
        expiredIds.push(sub.id);
        expiredCount++;
      }
    }

    if (expiredIds.length) {
      await prisma.subscription.updateMany({
        where: { id: { in: expiredIds } },
        data: { status: 'EXPIRED' },
      });
      console.log(`✅ Expired ${expiredCount} subscriptions.`);
    } else {
      console.log('✅ No subscriptions expired.');
    }

    if (res) {
      return res.json({
        success: true,
        checked: subs.length,
        expired: expiredCount,
        expiredIds,
      });
    }
  } catch (error) {
    console.error('❌ Expiration Check Failed:', error);
    if (res) return res.status(500).json({ error: 'Cron job failed' });
  }
};
