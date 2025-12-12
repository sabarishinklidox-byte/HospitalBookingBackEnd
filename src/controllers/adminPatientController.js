import prisma from '../prisma.js'; 

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

    // 2. Verify Clinic is Active (Optional safety check)
    const clinicCheck = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { deletedAt: true }
    });
    if (!clinicCheck || clinicCheck.deletedAt) {
      return res.status(404).json({ error: "Clinic not found or inactive" });
    }

    // 3. Fetch User (Patient) Info
    // We allow fetching even if user.deletedAt is set (to see history of deleted users)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true,
        deletedAt: true // Include this so frontend knows if patient is inactive
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 4. Fetch Appointments (Active Only)
    const appointments = await prisma.appointment.findMany({
      where: {
        clinicId: clinicId, 
        userId: userId,
        deletedAt: null // ✅ Filter out soft-deleted appointments
      },
      orderBy: { createdAt: 'desc' }, 
      include: {
        doctor: {
          // Include deletedAt so we know if the doctor is gone
          select: { id: true, name: true, speciality: true, deletedAt: true }
        },
        clinic: {
          select: { id: true, name: true }
        },
        slot: true,
        payment: true // If you have payments, include them
      }
    });

    return res.json({
      user,
      appointments
    });

  } catch (error) {
    console.error('Get Patient History Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
