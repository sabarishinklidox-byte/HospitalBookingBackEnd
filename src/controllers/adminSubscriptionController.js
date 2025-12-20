// controllers/adminSubscriptionController.js
import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';

export const upgradeClinicPlan = async (req, res) => {
  try {
    const { clinicId, id: userId } = req.user;
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }

    // 1. Fetch Target Plan
    const targetPlan = await prisma.plan.findFirst({
      where: { id: planId, isActive: true, deletedAt: null },
    });

    if (!targetPlan) {
      return res.status(400).json({ error: 'Invalid or inactive plan' });
    }

    // 2. Fetch Current Subscription
    const currentSub = await prisma.subscription.findUnique({
      where: { clinicId },
    });

    // 3. Determine New Dates
    const now = new Date();
    let startDate = now;
    let nextBillingDate = null;
    let endDate = null;

    // CASE A: Switching to a Fixed Duration Plan (e.g. Trial Plan / 1 Year Plan)
    if (targetPlan.durationDays) {
      endDate = new Date(now);
      endDate.setDate(endDate.getDate() + targetPlan.durationDays);
      nextBillingDate = null; // No recurring billing for fixed plans
    }
    // CASE B: Switching to Recurring Plan (Monthly/Yearly)
    else {
      // If previous plan was Trial, start fresh from today
      // If previous plan was Paid, you might want to align billing cycles (simplified here: restart cycle)
      nextBillingDate = new Date(now);
      nextBillingDate.setMonth(nextBillingDate.getMonth() + 1); // Assuming monthly billing
      
      // If target plan has trial days (e.g. Pro Plan with 7 days free)
      if (targetPlan.trialDays && (!currentSub || currentSub.isTrial)) {
        nextBillingDate.setDate(nextBillingDate.getDate() + targetPlan.trialDays);
      }
    }

    // 4. Update Subscription
    const subscription = await prisma.subscription.update({
      where: { clinicId },
      data: {
        plan: { connect: { id: planId } },
        status: 'ACTIVE',
        
        // Snapshot Pricing & Limits
        priceAtPurchase: targetPlan.priceMonthly,
        maxDoctors: targetPlan.maxDoctors,
        maxBookingsPerPeriod: targetPlan.maxBookingsPerMonth,
        
        // Trial / Duration Logic
        isTrial: targetPlan.isTrial,
        durationDays: targetPlan.durationDays,
        trialDays: targetPlan.trialDays,

        // Dates
        startDate: startDate,
        nextBillingDate: nextBillingDate,
        endDate: endDate,
      },
      include: { plan: true },
    });

    // 5. Audit Log
    await logAudit({
      userId,
      clinicId,
      action: 'UPDATE_SUBSCRIPTION_PLAN',
      entity: 'Subscription',
      entityId: subscription.id,
      details: {
        oldPlanId: currentSub?.planId,
        newPlanId: planId,
        newPlanName: targetPlan.name,
        type: targetPlan.isTrial ? 'DOWNGRADE_TO_TRIAL' : 'UPGRADE_TO_PAID'
      },
      req,
    });

    return res.json({ 
      success: true, 
      message: `Plan upgraded to ${targetPlan.name}`,
      subscription 
    });

  } catch (err) {
    console.error('Upgrade Clinic Plan Error:', err);
    res.status(500).json({ error: err.message });
  }
};
