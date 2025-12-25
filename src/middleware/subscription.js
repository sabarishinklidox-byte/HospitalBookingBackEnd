// src/middleware/subscription.js
import prisma from '../prisma.js'; 

export const requireActiveSubscription = async (req, res, next) => {
  const user = req.user;
  
  // Find clinic subscription
  const clinic = await prisma.clinic.findUnique({
    where: { id: user.clinicId },
    include: { subscription: true }
  });

  if (!clinic?.subscription || clinic.subscription.status !== 'ACTIVE') {
    return res.status(403).json({ 
      error: 'Your subscription has expired. Please renew to continue.' 
    });
  }

  next();
};
