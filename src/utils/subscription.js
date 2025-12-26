// src/utils/subscription.js
import prisma from '../prisma.js';

export const getClinicSubscription = async (clinicId) => {
  // Return the latest subscription for this clinic (any status)
  const sub = await prisma.subscription.findFirst({
    where: {
      clinicId,
      status: { in: ['ACTIVE', 'EXPIRED', 'INACTIVE', 'CANCELLED', 'PAST_DUE'] },
    },
    orderBy: { createdAt: 'desc' },
    include: {
      plan: true,
    },
  });

  return sub;
};
