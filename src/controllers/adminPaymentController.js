import prisma from '../prisma.js';

// ----------------------------------------------------------------
// GET /api/admin/payments
// ----------------------------------------------------------------
export const getPayments = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { start, end, doctorId, status } = req.query;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // Verify Clinic is Active (Optional but good practice)
    const clinic = await prisma.clinic.findUnique({
        where: { id: clinicId },
        select: { deletedAt: true }
    });
    if(!clinic || clinic.deletedAt) return res.status(404).json({error: "Clinic inactive"});

    const where = { clinicId };

    if (doctorId) where.doctorId = doctorId;
    if (status) where.status = status;

    if (start || end) {
      const startDate = start ? new Date(start) : new Date('1970-01-01');
      const endDate = end ? new Date(end) : new Date('2999-12-31');
      
      // Ensure end date covers the full day
      endDate.setHours(23, 59, 59, 999);

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
          select: { id: true, name: true, speciality: true, deletedAt: true } // Include deletedAt to flag deleted docs
        },
        appointment: {
          select: { id: true, status: true, deletedAt: true } 
        }
      }
    });

    return res.json(payments);
  } catch (error) {
    console.error('Get Payments Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET /api/admin/payments/summary
// ----------------------------------------------------------------
export const getPaymentsSummary = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { start, end } = req.query;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // Fix Dates
    const startDate = start ? new Date(start) : new Date('1970-01-01');
    const endDate = end ? new Date(end) : new Date('2999-12-31');
    endDate.setHours(23, 59, 59, 999);

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

    // Fetch doctors (including deleted ones, so we know who earned the money)
    const doctors = await prisma.doctor.findMany({
      where: { id: { in: doctorIds } },
      select: { id: true, name: true, speciality: true, deletedAt: true }
    });

    const revenuePerDoctor = perDoctor.map(p => {
      const doc = doctors.find(d => d.id === p.doctorId);
      return {
        doctorId: p.doctorId,
        doctorName: doc ? doc.name : 'Unknown/Deleted',
        speciality: doc ? doc.speciality : null,
        isDeleted: !!(doc && doc.deletedAt), // Flag deleted doctors
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
