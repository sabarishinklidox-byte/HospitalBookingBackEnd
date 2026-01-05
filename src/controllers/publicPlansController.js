// controllers/publicPlanController.js
import prisma from '../prisma.js';

// ✅ PUBLIC: list plans for pricing + billing page
export const listPublicPlans = async (req, res) => {
  try {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

    // 1) Fetch RAW plans (this is what BillingPage should use)
    const plans = await prisma.plan.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        // Hide internal/enterprise plans from public
        OR: [
          { slug: { in: ['basic', 'pro', 'premium'] } },
          { priceMonthly: { lte: 5000 } },
        ],
      },
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
        enableBulkSlots: true,
        enableExports: true,
        enableAuditLogs: true,
        enableGoogleReviews: true,
        isTrial: true,
        durationDays: true,
        trialDays: true,
        isActive: true,
        createdAt: true,

        // ✅ Prisma relation count (with filter) is valid
        _count: {
          select: {
            subscriptions: {
              where: {
                status: 'ACTIVE',
                updatedAt: { gte: ninetyDaysAgo },
              },
            },
          },
        },
      },
    });

    // 2) Build "pricingTiers" for marketing/pricing page (optional)
    const pricingTiers = plans.map((plan) => {
      const usersCount = plan._count?.subscriptions ?? 0;

      // ✅ derive trial days safely
      const derivedTrialDays =
        (typeof plan.trialDays === 'number' && plan.trialDays > 0)
          ? plan.trialDays
          : (plan.isTrial && typeof plan.durationDays === 'number' && plan.durationDays > 0)
            ? plan.durationDays
            : 0;

      const tier =
        plan.slug === 'basic'
          ? 'Starter'
          : plan.slug === 'pro'
            ? 'Professional'
            : plan.slug === 'premium'
              ? 'Enterprise'
              : 'Custom';

      return {
        ...plan,
        tier,
        hasTrial: plan.isTrial || derivedTrialDays > 0,
        trialDaysResolved: derivedTrialDays, // ✅ useful for frontend badge
        trialLabel: derivedTrialDays > 0 ? `+${derivedTrialDays} days free` : null,
        priceDisplay: plan.isTrial ? 'Free' : `${plan.currency} ${plan.priceMonthly}/month`,
        features: {
          payments: plan.allowOnlinePayments,
          branding: plan.allowCustomBranding,
          bulkSlots: plan.enableBulkSlots,
          exports: plan.enableExports,
          auditLogs: plan.enableAuditLogs,
          googleReviews: plan.enableGoogleReviews,
          doctors: `${plan.maxDoctors}+ doctors`,
          bookings: `${plan.maxBookingsPerMonth}+ bookings/mo`,
        },
        isPopular: plan.slug === 'pro',
        usersCount,
      };
    });

    // ✅ sort WITHOUT mutating original array (avoid .sort on same ref)
    const sortedTiers = [...pricingTiers].sort((a, b) => {
      if (a.isPopular && !b.isPopular) return -1;
      if (!a.isPopular && b.isPopular) return 1;
      return (a.priceMonthly ?? 0) - (b.priceMonthly ?? 0);
    }); // .sort mutates the array it runs on, so we clone first [web:25]

    // 3) Return BOTH raw plans + pricing tiers
    // ✅ IMPORTANT: BillingPage should use `plans` (raw) so trialDays=1 comes through
    return res.json({
      success: true,
      plans, // ✅ RAW plans (trialDays, durationDays intact)
      pricingTiers: sortedTiers,
      featuresMatrix: [
        { name: 'Online Payments', key: 'payments' },
        { name: 'Custom Branding', key: 'branding' },
        { name: 'Bulk Slot Creation', key: 'bulkSlots' },
        { name: 'Data Exports', key: 'exports' },
        { name: 'Audit Logs', key: 'auditLogs' },
        { name: 'Google Reviews', key: 'googleReviews' },
      ],
      cta: {
        trialAvailable: pricingTiers.some((p) => p.hasTrial),
        startingPrice: pricingTiers.find((p) => !p.isTrial)?.priceDisplay || 'Contact Sales',
      },
    });
  } catch (err) {
    console.error('Public Plans Error:', err);
    return res.status(500).json({ error: 'Failed to load plans' });
  }
};

// ✅ PUBLIC: get a single plan by slug
export const getPlanDetails = async (req, res) => {
  try {
    const { slug } = req.params;

    const plan = await prisma.plan.findFirst({
      where: {
        slug,
        isActive: true,
        deletedAt: null,
      },
      include: {
        _count: {
          select: {
            subscriptions: { where: { status: 'ACTIVE' } },
          },
        },
      },
    });

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    const trialDaysResolved =
      (typeof plan.trialDays === 'number' && plan.trialDays > 0)
        ? plan.trialDays
        : (plan.isTrial && typeof plan.durationDays === 'number' && plan.durationDays > 0)
          ? plan.durationDays
          : 0;

    return res.json({
      success: true,
      plan: {
        ...plan,
        priceDisplay: plan.isTrial ? 'Free Trial' : `${plan.currency} ${plan.priceMonthly}/mo`,
        trialDaysResolved,
        trialInfo: trialDaysResolved > 0 ? `+${trialDaysResolved} days free` : null,
        popular: (plan._count?.subscriptions ?? 0) > 50,
      },
    });
  } catch (err) {
    console.error('Get Plan Details Error:', err);
    return res.status(500).json({ error: 'Failed to load plan details' });
  }
};
