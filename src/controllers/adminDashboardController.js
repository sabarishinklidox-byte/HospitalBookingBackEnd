import prisma from '../prisma.js';

export const getAdminDashboard = async (req, res) => {
  try {
    const { clinicId } = req.user;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // 1. Clinic + plan
    const clinicWithSub = await prisma.clinic.findUnique({
      where: { id: clinicId },
      include: {
        subscription: {
          include: { plan: true },
        },
      },
    });

    if (!clinicWithSub || clinicWithSub.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    const clinic = {
      id: clinicWithSub.id,
      name: clinicWithSub.name,
      city: clinicWithSub.city,
    };

    const plan = clinicWithSub.subscription?.plan || null;

    // 2. Date ranges
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayEnd = new Date();
    todayEnd.setHours(23, 59, 59, 999);

    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);

    const yesterdayEnd = new Date(todayEnd);
    yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);

    // 3. Active Doctors
    const activeDoctors = await prisma.doctor.count({
      where: {
        clinicId,
        isActive: true,
        deletedAt: null,
      },
    });

    // 4. Today's Appointments (non-cancelled)
    const todayAppointments = await prisma.appointment.count({
      where: {
        clinicId,
        deletedAt: null,
        slot: {
          date: {
            gte: todayStart,
            lte: todayEnd,
          },
        },
        status: { not: 'CANCELLED' },
      },
    });

    // 5. Yesterday's Appointments (non-cancelled)
    const yesterdayAppointments = await prisma.appointment.count({
      where: {
        clinicId,
        deletedAt: null,
        slot: {
          date: {
            gte: yesterdayStart,
            lte: yesterdayEnd,
          },
        },
        status: { not: 'CANCELLED' },
      },
    });

    // 6. Today's Revenue
    const todayPaidAppointments = await prisma.appointment.findMany({
      where: {
        clinicId,
        deletedAt: null,
        slot: {
          date: { gte: todayStart, lte: todayEnd },
        },
        status: 'COMPLETED',
      },
      include: { slot: true },
    });
    const todayRevenue = todayPaidAppointments.reduce(
      (sum, app) => sum + (Number(app.slot.price) || 0),
      0
    );

    // 7. Yesterday's Revenue
    const yesterdayPaidAppointments = await prisma.appointment.findMany({
      where: {
        clinicId,
        deletedAt: null,
        slot: {
          date: { gte: yesterdayStart, lte: yesterdayEnd },
        },
        status: 'COMPLETED',
      },
      include: { slot: true },
    });
    const yesterdayRevenue = yesterdayPaidAppointments.reduce(
      (sum, app) => sum + (Number(app.slot.price) || 0),
      0
    );

    // 8. Total Lifetime Revenue
    const allPaidAppointments = await prisma.appointment.findMany({
      where: {
        clinicId,
        status: 'COMPLETED',
        deletedAt: null,
      },
      include: { slot: true },
    });
    const totalRevenue = allPaidAppointments.reduce(
      (sum, app) => sum + (Number(app.slot.price) || 0),
      0
    );

    // 9. Upcoming Appointments
    const upcomingAppointments = await prisma.appointment.count({
      where: {
        clinicId,
        deletedAt: null,
        slot: {
          date: { gt: todayEnd },
        },
        status: { in: ['CONFIRMED', 'PENDING'] },
      },
    });

    // 9.1 Status-wise totals
    const [
      totalBookings,
      totalPending,
      totalConfirmed,
      totalCompleted,
      totalNoShow,
      totalCancelled,
    ] = await Promise.all([
      prisma.appointment.count({
        where: { clinicId, deletedAt: null },
      }),
      prisma.appointment.count({
        where: { clinicId, deletedAt: null, status: 'PENDING' },
      }),
      prisma.appointment.count({
        where: { clinicId, deletedAt: null, status: 'CONFIRMED' },
      }),
      prisma.appointment.count({
        where: { clinicId, deletedAt: null, status: 'COMPLETED' },
      }),
      prisma.appointment.count({
        where: { clinicId, deletedAt: null, status: 'NO_SHOW' },
      }),
      prisma.appointment.count({
        where: { clinicId, deletedAt: null, status: 'CANCELLED' },
      }),
    ]);

    // 10. Response with plan and totals
    return res.json({
      clinic,
      plan,
      todayAppointments,
      yesterdayAppointments,
      upcomingAppointments,
      activeDoctors,
      todayRevenue,
      yesterdayRevenue,
      totalRevenue,

      // new aggregates
      totalBookings,
      totalPending,
      totalConfirmed,
      totalCompleted,
      totalNoShow,
      totalCancelled,
    });
  } catch (error) {
    console.error('Dashboard Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
