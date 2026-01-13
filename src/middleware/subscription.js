import prisma from '../prisma.js'; 

export const requireActiveSubscription = async (req, res, next) => {
   console.log('🔒 MIDDLEWARE FIRED:', req.user);
  const user = req.user;
  
  const clinic = await prisma.clinic.findUnique({
    where: { id: user.clinicId },
    include: { subscription: true }
  });
  if (!user?.clinicId) {
    console.log('❌ NO USER/CLINICID:', req.user);
    return res.status(403).json({ error: 'No clinic access' });
  }
  const sub = clinic?.subscription;
  if (!sub || !['ACTIVE', 'TRIAL'].includes(sub.status)) {
    return res.status(403).json({ 
      error: 'Subscription expired. Upgrade required.',
      currentStatus: sub?.status || 'NO_SUBSCRIPTION'
    });
  }

  const now = new Date();
  
  // 🔥 BLOCK 1: Check MAIN PLAN expiry (durationDays)
  const planEndsAt = new Date(sub.startDate);
  planEndsAt.setDate(planEndsAt.getDate() + sub.durationDays);
  
  if (now > planEndsAt) {
    console.log('🚫 Plan expired:', { planEndsAt: planEndsAt.toISOString() });
    return res.status(403).json({ 
      error: 'Plan expired. Please upgrade to continue.',
      expiredAt: planEndsAt.toISOString()
    });
  }

  // 🔥 BLOCK 2: Check TRIAL expiry (if trialDays exist)
  if (sub.trialDays > 0) {
    const trialEndsAt = new Date(sub.startDate);
    trialEndsAt.setDate(trialEndsAt.getDate() + sub.trialDays);
    
    if (now > trialEndsAt) {
      console.log('🚫 Trial expired:', { trialEndsAt: trialEndsAt.toISOString() });
      return res.status(403).json({ 
        error: 'Trial expired. Payment required to continue.',
        upgradeRequired: true
      });
    }
  }

  req.subscription = sub;
  next();
};


export const requireActiveSubscriptionForAnalytics = requireActiveSubscription;
