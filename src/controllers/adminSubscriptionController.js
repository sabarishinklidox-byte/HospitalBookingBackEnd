// controllers/adminSubscriptionController.js
import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';

export const upgradeClinicPlan = async (req, res) => {
  try {
    // Ensure you are actually storing id on req.user in your auth middleware
    const { clinicId, id: userId } = req.user;
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }

    // Only active, non-deleted plans can be chosen
    const targetPlan = await prisma.plan.findFirst({
      where: { id: planId, isActive: true, deletedAt: null },
    });
    if (!targetPlan) {
      return res.status(400).json({ error: 'Invalid or inactive plan' });
    }

    // Update the clinic's subscription to point to new plan
    // and snapshot its current limits/pricing
    const subscription = await prisma.subscription.update({
      where: { clinicId },
      data: {
        // Use relation, not scalar planId
        plan: { connect: { id: planId } },
        priceAtPurchase: targetPlan.priceMonthly,
        maxDoctors: targetPlan.maxDoctors,
        maxBookingsPerPeriod: targetPlan.maxBookingsPerMonth,
        durationDays: targetPlan.durationDays,
        isTrial: targetPlan.isTrial,
        trialDays: targetPlan.trialDays,
      },
      include: { plan: true },
    });

    // Audit log (uses AuditLog { userId, clinicId, ... } model)
    await logAudit({
      userId,
      clinicId,
      action: 'UPDATE_SUBSCRIPTION_PLAN',
      entity: 'Subscription',
      entityId: subscription.id,
      details: {
        newPlanId: planId,
        newPlanName: targetPlan.name,
      },
      req,
    });

    return res.json({ subscription, plan: subscription.plan });
  } catch (err) {
    console.error('Upgrade Clinic Plan Error:', err);
    res.status(500).json({ error: err.message });
  }
};
