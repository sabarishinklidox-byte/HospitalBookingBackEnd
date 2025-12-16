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
  return clinic?.subscription?.plan || null; // Plan has enableAuditLogs, etc. [web:1186]
}

// ----------------------------------------------------------------
// GET /api/admin/patients/:userId/history
// ----------------------------------------------------------------
export const getPatientHistory = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { userId } = req.params;

    // 1. Validation
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // 2. Gate by plan (if you want this as a premium feature)
    const plan = await getClinicPlan(clinicId);
    if (!plan || !plan.enableAuditLogs) {
      return res.status(403).json({
        error: 'Patient history is not available on your current plan.',
      });
    }

    // 3. Verify Clinic is Active
    const clinicCheck = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { deletedAt: true },
    });
    if (!clinicCheck || clinicCheck.deletedAt) {
      return res
        .status(404)
        .json({ error: 'Clinic not found or inactive' });
    }

    // 4. Fetch User (Patient) Info
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        deletedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 5. Fetch Appointments (Active Only)
    const appointments = await prisma.appointment.findMany({
      where: {
        clinicId,
        userId,
        deletedAt: null,
      },
      orderBy: { createdAt: 'desc' },
      include: {
        doctor: {
          select: {
            id: true,
            name: true,
            speciality: true,
            deletedAt: true,
          },
        },
        clinic: {
          select: { id: true, name: true },
        },
        slot: true,
        payment: true,
      },
    });

    return res.json({
      user,
      appointments,
    });
  } catch (error) {
    console.error('Get Patient History Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
