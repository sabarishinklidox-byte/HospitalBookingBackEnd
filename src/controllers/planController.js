import prisma from '../prisma.js';

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
      enableGoogleReviews = false,   // ✅ new flag from body
      isActive = true,
    } = req.body;

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
        enableGoogleReviews,        // ✅ persist flag
        isActive,
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
    const data = req.body; // can include enableGoogleReviews

    const existing = await prisma.plan.findFirst({
      where: { id, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const updated = await prisma.plan.update({
      where: { id },
      data,
    });

    if (updated.enableAuditLogs) {
      await logPlanAudit(userId, 'PLAN_UPDATED', id, {
        before: existing,
        after: updated,
      });
    }

    return res.json(updated);
  } catch (err) {
    console.error('Update Plan Error:', err);
    return res.status(500).json({ error: err.message });
  }
};


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

    const updated = await prisma.plan.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });

    if (existing.enableAuditLogs) {
      await logPlanAudit(userId, 'PLAN_DELETED', id, { before: existing });
    }

    return res.json({ message: 'Plan deleted (soft)' });
  } catch (err) {
    console.error('Delete Plan Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
