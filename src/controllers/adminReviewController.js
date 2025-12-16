import prisma from '../prisma.js'; 

// helper to get current plan for a clinic
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  return clinic?.subscription?.plan || null; // Plan has feature flags [web:1186]
}

export const getClinicReviews = async (req, res) => {
  try {
    const { clinicId } = req.user;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID not found' });
    }

    // gate reviews by plan if needed (you can change the flag name later)
    const plan = await getClinicPlan(clinicId);
    if (!plan || !plan.enableAuditLogs) {
      return res.status(403).json({
        error: 'Reviews module is not available on your current plan.',
      });
    }

    const reviews = await prisma.review.findMany({
      where: {
        doctor: { clinicId }, // Filter by clinic via doctor relation
        deletedAt: null,
      },
      include: {
        user: {
          select: { name: true, avatar: true, email: true },
        },
        doctor: {
          select: { name: true, speciality: true },
        },
        appointment: {
          select: { id: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(reviews);
  } catch (error) {
    console.error('Get Reviews Error:', error);
    res.status(500).json({ error: error.message });
  }
};
