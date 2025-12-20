// src/controllers/publicPlansController.js
import prisma from '../prisma.js';

export const listPublicPlans = async (req, res) => {
  try {
    const now = new Date();
    
    const plans = await prisma.plan.findMany({
      where: { 
        isActive: true, 
        deletedAt: null,
        // Hide internal/enterprise plans from public
        OR: [
          { slug: { in: ['basic', 'pro', 'premium'] } },
          { priceMonthly: { lte: 5000 } } // Cap at reasonable public price
        ]
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
        
        // Count active users (anonymized)
        _count: {
          select: {
            subscriptions: {
              where: { 
                status: 'ACTIVE',
                // Only count recent/active clinics
                updatedAt: { gte: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
              }
            }
          }
        }
      }
    });

    // Transform for frontend pricing table
    const pricingTiers = plans.map(plan => ({
      ...plan,
      // Frontend-friendly labels
      tier: plan.slug === 'basic' ? 'Starter' : 
            plan.slug === 'pro' ? 'Professional' : 
            plan.slug === 'premium' ? 'Enterprise' : 'Custom',
      
      // Trial badges
      hasTrial: plan.isTrial || plan.trialDays > 0,
      trialLabel: plan.isTrial ? `${plan.durationDays} days free` : 
                  plan.trialDays ? `${plan.trialDays} days trial` : null,
      
      // Price display
      priceDisplay: plan.isTrial ? 'Free' : 
                    `${plan.currency} ${plan.priceMonthly}/month`,
      
      // Feature matrix (boolean flags → labels)
      features: {
        payments: plan.allowOnlinePayments,
        branding: plan.allowCustomBranding,
        bulkSlots: plan.enableBulkSlots,
        exports: plan.enableExports,
        auditLogs: plan.enableAuditLogs,
        googleReviews: plan.enableGoogleReviews,
        doctors: `${plan.maxDoctors}+ doctors`,
        bookings: `${plan.maxBookingsPerMonth}+ bookings/mo`
      },
      
      // Popularity indicator (fake for demo, replace with real analytics)
      isPopular: plan.slug === 'pro',
      usersCount: plan._count.subscriptions || 0
    }));

    // Suggested order: Popular first, then price order
    const sortedTiers = pricingTiers.sort((a, b) => {
      if (a.isPopular && !b.isPopular) return -1;
      if (!a.isPopular && b.isPopular) return 1;
      return a.priceMonthly - b.priceMonthly;
    });

    return res.json({
      success: true,
      plans: pricingTiers,
      pricingTiers: sortedTiers,
      featuresMatrix: [
        { name: 'Online Payments', key: 'payments' },
        { name: 'Custom Branding', key: 'branding' },
        { name: 'Bulk Slot Creation', key: 'bulkSlots' },
        { name: 'Data Exports', key: 'exports' },
        { name: 'Audit Logs', key: 'auditLogs' },
        { name: 'Google Reviews', key: 'googleReviews' }
      ],
      cta: {
        trialAvailable: pricingTiers.some(p => p.hasTrial),
        startingPrice: pricingTiers.find(p => !p.isTrial)?.priceDisplay || 'Contact Sales'
      }
    });

  } catch (err) {
    console.error('Public Plans Error:', err);
    return res.status(500).json({ error: 'Failed to load plans' });
  }
};

// NEW: Get single plan details for checkout
export const getPlanDetails = async (req, res) => {
  try {
    const { slug } = req.params;
    
    const plan = await prisma.plan.findFirst({
      where: { 
        slug, 
        isActive: true, 
        deletedAt: null 
      },
      include: {
        _count: {
          select: {
            subscriptions: { where: { status: 'ACTIVE' } }
          }
        }
      }
    });

    if (!plan) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    return res.json({
      success: true,
      plan: {
        ...plan,
        priceDisplay: plan.isTrial ? 'Free Trial' : `${plan.currency} ${plan.priceMonthly}/mo`,
        trialInfo: plan.isTrial ? `${plan.durationDays} days` : 
                   plan.trialDays ? `${plan.trialDays} days free` : null,
        popular: plan._count.subscriptions > 50 // Demo threshold
      }
    });

  } catch (err) {
    console.error('Get Plan Details Error:', err);
    return res.status(500).json({ error: 'Failed to load plan details' });
  }
};
