import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';

const logPlanAudit = async (userId, action, planId, details = null) => {
  try {
    await prisma.auditLog.create({
      data: {
        userId,
        clinicId: null,
        action,
        entity: 'PLAN',
        entityId: planId,
        details,
        ipAddress: null,
      },
    });
  } catch (e) {
    console.error('Plan AuditLog Error:', e.message);
  }
};


// GET /api/super-admin/plans
export const listPlans = async (req, res) => {
  try {
    const plans = await prisma.plan.findMany({
      where: { deletedAt: null },
      orderBy: { priceMonthly: 'asc' },
    });
    return res.json(plans);
  } catch (err) {
    console.error('List Plans Error:', err);
    return res.status(500).json({ error: err.message });
  }
};


// POST /api/super-admin/plans
export const createPlan = async (req, res) => {
  try {
    const userId = req.user.id;

    const {
      name,
      slug,
      priceMonthly,
      currency = 'INR',
      maxDoctors,
      maxBookingsPerMonth,
      allowOnlinePayments,
      allowCustomBranding,
      enableAuditLogs = true,
      enableGoogleReviews = false,
      isActive = true,

      // NEW
      isTrial = false,
      durationDays,          // e.g. 15
      trialDays,             // optional separate trial
    } = req.body;

    // Basic validation example
    if (!name || !slug || priceMonthly == null) {
      return res.status(400).json({ error: 'name, slug, priceMonthly are required' });
    }

    if (durationDays != null && durationDays <= 0) {
      return res.status(400).json({ error: 'durationDays must be > 0' });
    }

    if (isTrial && !durationDays) {
      // you can enforce that trial plans must have a duration
      return res.status(400).json({ error: 'Trial plans must have durationDays' });
    }

    const plan = await prisma.plan.create({
      data: {
        name,
        slug,
        priceMonthly,
        currency,
        maxDoctors,
        maxBookingsPerMonth,
        allowOnlinePayments,
        allowCustomBranding,
        enableAuditLogs,
        enableGoogleReviews,
        isActive,

        isTrial,
        durationDays: durationDays ?? null,
        trialDays: trialDays ?? null,
      },
    });

    if (plan.enableAuditLogs) {
      await logPlanAudit(userId, 'PLAN_CREATED', plan.id, { new: plan });
    }

    return res.status(201).json(plan);
  } catch (err) {
    console.error('Create Plan Error:', err);
    return res.status(500).json({ error: err.message });
  }
};



// PUT /api/super-admin/plans/:id
export const updatePlan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const existing = await prisma.plan.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Count active subscriptions for this plan
    const activeSubCount = await prisma.subscription.count({
      where: { planId: id, status: 'ACTIVE' },
    });

    const {
      // allowed always
      name,
      allowOnlinePayments,
      allowCustomBranding,
      enableBulkSlots,
      enableExports,
      enableAuditLogs,
      enableGoogleReviews,
      isActive,

      // dangerous if there are active subs
      priceMonthly,
      maxDoctors,
      maxBookingsPerMonth,
      durationDays,
      isTrial,
      trialDays,

      ...rest
    } = req.body;

    const data = {
      ...rest,
      name: name ?? existing.name,
      allowOnlinePayments:
        allowOnlinePayments ?? existing.allowOnlinePayments,
      allowCustomBranding:
        allowCustomBranding ?? existing.allowCustomBranding,
      enableBulkSlots: enableBulkSlots ?? existing.enableBulkSlots,
      enableExports: enableExports ?? existing.enableExports,
      enableAuditLogs: enableAuditLogs ?? existing.enableAuditLogs,
      enableGoogleReviews:
        enableGoogleReviews ?? existing.enableGoogleReviews,
      isActive:
        typeof isActive === 'boolean' ? isActive : existing.isActive,
    };

    if (activeSubCount === 0) {
      if (priceMonthly != null) data.priceMonthly = priceMonthly;
      if (maxDoctors != null) data.maxDoctors = maxDoctors;
      if (maxBookingsPerMonth != null)
        data.maxBookingsPerMonth = maxBookingsPerMonth;
      if (durationDays !== undefined) data.durationDays = durationDays;
      if (isTrial !== undefined) data.isTrial = isTrial;
      if (trialDays !== undefined) data.trialDays = trialDays;
    } else {
      if (
        priceMonthly != null ||
        maxDoctors != null ||
        maxBookingsPerMonth != null ||
        durationDays !== undefined ||
        isTrial !== undefined ||
        trialDays !== undefined
      ) {
        return res.status(400).json({
          error:
            'Cannot change price, limits or duration while plan has active subscriptions. Create a new plan instead.',
        });
      }
    }

    const updated = await prisma.plan.update({
      where: { id },
      data,
    });

    // Audit as generic log
    await logAudit({
      userId,
      clinicId: null,
      action: 'PLAN_UPDATED',
      entity: 'Plan',
      entityId: id,
      details: { before: existing, after: updated },
      req,
    });

    return res.json(updated);
  } catch (err) {
    console.error('Update Plan Error:', err);
    return res.status(500).json({ error: err.message });
  }
};


// DELETE (soft) /api/super-admin/plans/:id
// DELETE (soft) /api/super-admin/plans/:id
export const deletePlan = async (req, res) => {
  try {
    const userId = req.user.id;
    const { id } = req.params;

    const existing = await prisma.plan.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const activeSubCount = await prisma.subscription.count({
      where: { planId: id, status: 'ACTIVE' },
    });

    if (activeSubCount > 0) {
      return res.status(400).json({
        error:
          'Cannot delete a plan that has active subscriptions. Deactivate it instead.',
      });
    }

    await prisma.plan.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    await logAudit({
      userId,
      clinicId: null,
      action: 'PLAN_DELETED',
      entity: 'Plan',
      entityId: id,
      details: { before: existing },
      req,
    });

    return res.json({ message: 'Plan deleted (soft)' });
  } catch (err) {
    console.error('Delete Plan Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
