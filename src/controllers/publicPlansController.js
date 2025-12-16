// src/controllers/publicPlansController.js
import prisma from '../prisma.js';

export const listPublicPlans = async (req, res) => {
  try {
    const plans = await prisma.plan.findMany({
      where: { isActive: true, deletedAt: null },
      orderBy: { priceMonthly: 'asc' },
    });
    return res.json(plans);
  } catch (err) {
    console.error('Public Plans Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
