import prisma from '../prisma.js';

// helper unchanged
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: { include: { plan: true } },
    },
  });
  return clinic?.subscription?.plan || null;
}

export const getClinicReviews = async (req, res) => {
  try {
    const { clinicId } = req.user;
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID not found' });
    }

    const plan = await getClinicPlan(clinicId);
    if (!plan || !plan.enableAuditLogs) {
      return res.status(403).json({
        error: 'Reviews module is not available on your current plan.',
      });
    }

    const { page = 1, limit = 10 } = req.query;
    const pageNumber = Number(page) || 1;
    const pageSize = Number(limit) || 10;

    const where = {
      doctor: { clinicId },
      deletedAt: null,
    };

    const [total, reviews] = await Promise.all([
      prisma.review.count({ where }),
      prisma.review.findMany({
        where,
        include: {
          user: { select: { name: true, avatar: true, email: true } },
          doctor: { select: { name: true, speciality: true } },
          appointment: { select: { id: true, createdAt: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return res.json({
      data: reviews,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (error) {
    console.error('Get Reviews Error:', error);
    res.status(500).json({ error: error.message });
  }
};
