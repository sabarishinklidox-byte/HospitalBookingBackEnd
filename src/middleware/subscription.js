// // src/middleware/subscription.js
// import prisma from '../prisma.js'; 

// export const requireActiveSubscription = async (req, res, next) => {
//   const user = req.user;
  
//   // Find clinic subscription
//   const clinic = await prisma.clinic.findUnique({
//     where: { id: user.clinicId },
//     include: { subscription: true }
//   });

//   if (!clinic?.subscription || clinic.subscription.status !== 'ACTIVE') {
//     return res.status(403).json({ 
//       error: 'Your subscription has expired. Please renew to continue.' 
//     });
//   }

//   next();
// };
// src/middleware/subscription.js - FIXED ✅ NO Analytics for EXPIRED
import prisma from '../prisma.js'; 

export const requireActiveSubscription = async (req, res, next) => {
  const user = req.user;
  
  const clinic = await prisma.clinic.findUnique({
    where: { id: user.clinicId },
    include: { subscription: true }
  });

  const sub = clinic?.subscription;

  // ✅ FIXED: TRIAL + ACTIVE ONLY (NO EXPIRED analytics)
  if (!sub || !['ACTIVE', 'TRIAL'].includes(sub.status)) {
    return res.status(403).json({ 
      error: 'Your subscription has expired. Please renew to continue.',
      currentStatus: sub?.status || 'NO_SUBSCRIPTION'
    });
  }

  req.subscription = sub;
  next();
};

// ✅ Analytics = Same as requireActiveSubscription (blocks EXPIRED)
export const requireActiveSubscriptionForAnalytics = requireActiveSubscription;
