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
    // 1. Extract context from request
    const { clinicId } = req.user;
    const { userId } = req.params;

    // 2. Validation: Ensure Admin belongs to a Clinic
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // 3. Plan Validation: Ensure plan supports this feature (Audit Logs / History)
    const plan = await getClinicPlan(clinicId);
    if (!plan || !plan.enableAuditLogs) {
      return res.status(403).json({
        error: 'Patient history is a premium feature. Please upgrade your plan.',
      });
    }

    // 4. Clinic Active Check
    const clinicCheck = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { deletedAt: true },
    });

    if (!clinicCheck || clinicCheck.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found or inactive' });
    }

    // 5. Fetch User (Patient) Profile
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,   // ✅ Confirmed: Fetching phone number
        avatar: true,
        createdAt: true, // Useful to show "Patient since..."
        deletedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 6. Fetch Appointments for this User at THIS Clinic only
    const appointments = await prisma.appointment.findMany({
      where: {
        clinicId: clinicId, // Strict scope: Only appointments at admin's clinic
        userId: userId,
        deletedAt: null,    // Exclude soft-deleted appointments
      },
      orderBy: {
        // Order by slot date/time if available, otherwise createdAt
        createdAt: 'desc', 
      },
      include: {
        doctor: {
          select: {
            id: true,
            name: true,
            speciality: true,
            avatar: true,
            deletedAt: true,
          },
        },
        clinic: {
          select: { id: true, name: true },
        },
        slot: true,    // Includes date/time info
        payment: true, // Includes payment status/amount
      },
    });

    // 7. Return Data
    return res.status(200).json({
      user,
      appointments,
    });

  } catch (error) {
    console.error('Get Patient History Error:', error);
    return res.status(500).json({ error: 'Internal server error while fetching patient history' });
  }
  
};