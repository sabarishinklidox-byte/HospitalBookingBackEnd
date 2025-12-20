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
      select: {
        id: true,
        name: true,
        slug: true,
        priceMonthly: true,
        currency: true,
        maxDoctors: true,
        maxBookingsPerMonth: true,
        allowOnlinePayments: true,
        allowCustomBranding: true,
        enableReviews: true,
        enableBulkSlots: true,
        enableExports: true,
        enableAuditLogs: true,
        enableGoogleReviews: true,
        isTrial: true,
        durationDays: true,
        trialDays: true,
        isActive: true,
        createdAt: true,
        updatedAt: true,
        // Count active subscriptions
        _count: {
          select: {
            subscriptions: {
              where: { status: 'ACTIVE' }
            }
          }
        }
      }
    });

    return res.json({
      success: true,
      plans,
      planTiers: [
        { name: 'Basic', allowOnlinePayments: false, maxDoctors: 1 },
        { name: 'Pro', allowOnlinePayments: true, maxDoctors: 5 },
        { name: 'Enterprise', allowOnlinePayments: true, maxDoctors: 50 }
      ]
    });
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
      maxDoctors = 1,
      maxBookingsPerMonth = 100,
      allowOnlinePayments = false,        // 🔒 PLAN FEATURE
      allowCustomBranding = false,       // 🔒 PLAN FEATURE
      enableReviews = true,
      enableBulkSlots = true,
      enableExports = true,
      enableAuditLogs = true,
      enableGoogleReviews = false,
      isActive = true,
      isTrial = false,
      durationDays,
      trialDays,
    } = req.body;

    // Validation
    if (!name || !slug || priceMonthly == null) {
      return res.status(400).json({ error: 'name, slug, priceMonthly required' });
    }

    if (durationDays != null && durationDays <= 0) {
      return res.status(400).json({ error: 'durationDays must be > 0' });
    }

    if (isTrial && !durationDays) {
      return res.status(400).json({ error: 'Trial plans must have durationDays' });
    }

    // Check slug uniqueness
    const slugExists = await prisma.plan.findFirst({
      where: { slug, deletedAt: null }
    });
    if (slugExists) {
      return res.status(400).json({ error: 'Slug already exists' });
    }

    const plan = await prisma.plan.create({
      data: {
        name,
        slug,
        priceMonthly,
        currency,
        maxDoctors,
        maxBookingsPerMonth,
        allowOnlinePayments,           // ✅ Controls payment gateways
        allowCustomBranding,
        enableReviews,
        enableBulkSlots,
        enableExports,
        enableAuditLogs,
        enableGoogleReviews,
        isActive,
        isTrial,
        durationDays: durationDays ?? null,
        trialDays: trialDays ?? null,
      },
    });

    await logPlanAudit(userId, 'PLAN_CREATED', plan.id, { new: plan });

    return res.status(201).json({
      success: true,
      plan,
      message: `Plan "${name}" created successfully`
    });
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

    const activeSubCount = await prisma.subscription.count({
      where: { planId: id, status: 'ACTIVE' },
    });

    const {
      name,
      slug,
      allowOnlinePayments,
      allowCustomBranding,
      enableReviews,
      enableBulkSlots,
      enableExports,
      enableAuditLogs,
      enableGoogleReviews,
      isActive,
      // Dangerous fields (pricing/limits)
      priceMonthly,
      maxDoctors,
      maxBookingsPerMonth,
      durationDays,
      isTrial,
      trialDays,
    } = req.body;

    // Safe updates (always allowed)
    const safeData = {
      name: name ?? existing.name,
      slug: slug ?? existing.slug,
      allowOnlinePayments: allowOnlinePayments !== undefined ? allowOnlinePayments : existing.allowOnlinePayments,
      allowCustomBranding: allowCustomBranding !== undefined ? allowCustomBranding : existing.allowCustomBranding,
      enableReviews: enableReviews !== undefined ? enableReviews : existing.enableReviews,
      enableBulkSlots: enableBulkSlots !== undefined ? enableBulkSlots : existing.enableBulkSlots,
      enableExports: enableExports !== undefined ? enableExports : existing.enableExports,
      enableAuditLogs: enableAuditLogs !== undefined ? enableAuditLogs : existing.enableAuditLogs,
      enableGoogleReviews: enableGoogleReviews !== undefined ? enableGoogleReviews : existing.enableGoogleReviews,
      isActive: isActive !== undefined ? isActive : existing.isActive,
    };

    // Pricing/limits - only if NO active subscriptions
    if (activeSubCount === 0) {
      if (priceMonthly !== undefined) safeData.priceMonthly = priceMonthly;
      if (maxDoctors !== undefined) safeData.maxDoctors = maxDoctors;
      if (maxBookingsPerMonth !== undefined) safeData.maxBookingsPerMonth = maxBookingsPerMonth;
      if (durationDays !== undefined) safeData.durationDays = durationDays ?? null;
      if (isTrial !== undefined) safeData.isTrial = isTrial;
      if (trialDays !== undefined) safeData.trialDays = trialDays ?? null;
    } else {
      // Block pricing changes
      if (priceMonthly !== undefined || maxDoctors !== undefined || 
          maxBookingsPerMonth !== undefined || durationDays !== undefined ||
          isTrial !== undefined || trialDays !== undefined) {
        return res.status(400).json({
          error: 'Cannot change pricing/limits while plan has active subscriptions. Create new plan.',
          activeSubs: activeSubCount
        });
      }
    }

    // Check slug uniqueness (if changed)
    if (slug && slug !== existing.slug) {
      const slugExists = await prisma.plan.findFirst({
        where: { slug, deletedAt: null, id: { not: id } }
      });
      if (slugExists) {
        return res.status(400).json({ error: 'Slug already exists' });
      }
      safeData.slug = slug;
    }

    const updated = await prisma.plan.update({
      where: { id },
      data: safeData,
    });

    await logAudit({
      userId,
      clinicId: null,
      action: 'PLAN_UPDATED',
      entity: 'Plan',
      entityId: id,
      details: { before: existing, after: updated },
      req,
    });

    return res.json({
      success: true,
      plan: updated,
      message: `Plan "${updated.name}" updated successfully`
    });
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

    const activeSubCount = await prisma.subscription.count({
      where: { planId: id, status: 'ACTIVE' },
    });

    if (activeSubCount > 0) {
      return res.status(400).json({
        error: `Cannot delete plan with ${activeSubCount} active subscriptions. Deactivate instead.`,
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
      details: { plan: existing },
      req,
    });

    return res.json({ 
      success: true,
      message: `Plan "${existing.name}" soft deleted successfully` 
    });
  } catch (err) {
    console.error('Delete Plan Error:', err);
    return res.status(500).json({ error: err.message });
  }
};

// NEW: Get Plan Stats for Dashboard
export const getPlanStats = async (req, res) => {
  try {
    const stats = await prisma.plan.groupBy({
      by: ['allowOnlinePayments', 'isTrial'],
      _count: {
        id: true,
        subscriptions: {
          where: { status: 'ACTIVE' }
        }
      },
      where: { deletedAt: null, isActive: true }
    });

    return res.json({
      success: true,
      stats,
      summary: {
        totalPlans: await prisma.plan.count({ where: { deletedAt: null } }),
        activePlans: await prisma.plan.count({ where: { deletedAt: null, isActive: true } }),
        paymentEnabledPlans: await prisma.plan.count({ 
          where: { deletedAt: null, isActive: true, allowOnlinePayments: true } 
        })
      }
    });
  } catch (err) {
    console.error('Plan Stats Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
