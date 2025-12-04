import prisma from '../prisma.js';

// GET /api/admin/dashboard
export const getAdminDashboard = async (req, res) => {
  try {
    const { clinicId } = req.user; // comes from token

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // Clinic details
    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        pincode: true,
        timings: true,
        details: true
      }
    });

    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    // Stats
    const totalDoctors = await prisma.doctor.count({
      where: { clinicId, isActive: true }
    });

    const today = new Date();
    const startOfDay = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate()
    );
    const endOfDay = new Date(
      today.getFullYear(),
      today.getMonth(),
      today.getDate() + 1
    );

    const totalSlotsToday = await prisma.slot.count({
      where: {
        clinicId,
        date: {
          gte: startOfDay,
          lt: endOfDay
        }
      }
    });

    const totalAppointmentsToday = await prisma.appointment.count({
      where: {
        clinicId,
        createdAt: {
          gte: startOfDay,
          lt: endOfDay
        }
      }
    });

    const totalRevenueTodayAgg = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        clinicId,
        createdAt: {
          gte: startOfDay,
          lt: endOfDay
        },
        status: 'PAID'
      }
    });

    const totalRevenueToday = totalRevenueTodayAgg._sum.amount || 0;

    return res.json({
      clinic,
      stats: {
        totalDoctors,
        totalSlotsToday,
        totalAppointmentsToday,
        totalRevenueToday
      }
    });
  } catch (error) {
    console.error('Admin Dashboard Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
