// controllers/adminSubscriptionController.js
import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';

export const upgradeClinicPlan = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { planId } = req.body;

    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }

    const targetPlan = await prisma.plan.findUnique({
      where: { id: planId, deletedAt: null },
    });
    if (!targetPlan || !targetPlan.isActive) {
      return res.status(400).json({ error: 'Invalid or inactive plan' });
    }

    // assuming Clinic has subscription with planId, adjust to your schema
    const subscription = await prisma.subscription.update({
      where: { clinicId },
      data: { planId },
      include: { plan: true },
    });

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
