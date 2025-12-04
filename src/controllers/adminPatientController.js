import prisma from '../prisma.js'; // Adjust path if needed (e.g. '../lib/prisma.js')

// GET /api/admin/patients/:userId/history
export const getPatientHistory = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { userId } = req.params;

    // 1. Validation
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // 2. Fetch User (Patient) Info
    // NOTE: Using 'userId' directly as string (UUID). 
    // If your DB strictly uses Integers, wrap with Number(userId).
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        avatar: true // Remove if not in schema
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 3. Fetch Appointments
    const appointments = await prisma.appointment.findMany({
      where: {
        clinicId: clinicId, // Matching string UUID
        userId: userId      // Matching string UUID
      },
      // Safe sorting: tries createdAt if it exists, otherwise you might need to change to 'id'
      // If this crashes saying "Unknown field createdAt", change to: orderBy: { id: 'desc' }
      orderBy: { createdAt: 'desc' }, 
      include: {
        doctor: {
          select: { id: true, name: true, speciality: true }
        },
        clinic: {
          select: { id: true, name: true }
        },
        slot: true,
        // payment: true // Uncomment ONLY if 'Payment' model and relation exist
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
