import prisma from '../prisma.js';

// GET /api/admin/payments?start=YYYY-MM-DD&end=YYYY-MM-DD&doctorId=...
export const getPayments = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { start, end, doctorId, status } = req.query;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    const where = { clinicId };

    if (doctorId) where.doctorId = doctorId;
    if (status) where.status = status;

    if (start || end) {
      const startDate = start ? new Date(start) : new Date('1970-01-01');
      const endDate = end ? new Date(end) : new Date('2999-12-31');

      where.createdAt = {
        gte: startDate,
        lte: endDate
      };
    }

    const payments = await prisma.payment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        doctor: {
          select: { id: true, name: true, speciality: true }
        },
        appointment: {
          select: { id: true, status: true } // ❌ removed date (not in schema)
        }
      }
    });

    return res.json(payments);
  } catch (error) {
    console.error('Get Payments Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/admin/payments/summary?start=YYYY-MM-DD&end=YYYY-MM-DD
export const getPaymentsSummary = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { start, end } = req.query;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    const startDate = start ? new Date(start) : new Date('1970-01-01');
    const endDate = end ? new Date(end) : new Date('2999-12-31');

    // Total revenue
    const totalAgg = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        clinicId,
        status: 'PAID',
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      }
    });

    const totalRevenue = totalAgg._sum.amount || 0;

    // Revenue per doctor
    const perDoctor = await prisma.payment.groupBy({
      by: ['doctorId'],
      _sum: { amount: true },
      where: {
        clinicId,
        status: 'PAID',
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      }
    });

    const doctorIds = perDoctor.map(p => p.doctorId);

    const doctors = await prisma.doctor.findMany({
      where: { id: { in: doctorIds } },
      select: { id: true, name: true, speciality: true }
    });

    const revenuePerDoctor = perDoctor.map(p => {
      const doc = doctors.find(d => d.id === p.doctorId);
      return {
        doctorId: p.doctorId,
        doctorName: doc?.name || null,
        speciality: doc?.speciality || null,
        amount: p._sum.amount || 0
      };
    });

    return res.json({
      totalRevenue,
      revenuePerDoctor
    });
  } catch (error) {
    console.error('Payments Summary Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
