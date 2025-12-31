import prisma from '../prisma.js';

// ----------------------------------------------------------------
// GET /api/admin/payments - FULL REVENUE HISTORY
// Tracks: Online, Offline Cash, Reschedules, Refunds, Failed
// ----------------------------------------------------------------
export const getPayments = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { start, end, doctorId, status, paymentMode, type } = req.query;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // Verify Clinic is Active
    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { deletedAt: true }
    });
    if (!clinic || clinic.deletedAt) {
      return res.status(404).json({ error: "Clinic inactive" });
    }

    // 🔥 FULL WHERE CLAUSE - All payment types
    const where = { clinicId };

    // Doctor filter
    if (doctorId) where.doctorId = doctorId;

    // Status filter (PAID, FAILED, REFUNDED, PENDING)
    if (status) where.status = status;

    // 🔥 NEW: Payment Mode filter (ONLINE, CASH, RAZORPAY)
    if (paymentMode) where.provider = paymentMode;

    // 🔥 NEW: Payment Type filter (APPOINTMENT, RESCHEDULE)
    if (type) where.type = type;

    // Date range
    if (start || end) {
      const startDate = start ? new Date(start) : new Date('1970-01-01');
      const endDate = end ? new Date(end) : new Date('2999-12-31');
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
          select: { 
            id: true, 
            name: true, 
            speciality: { select: { name: true } },
            deletedAt: true 
          }
        },
        appointment: {
          select: { 
            id: true, 
            status: true, 
            amount: true,
            financialStatus: true,
            deletedAt: true 
          }
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
// GET /api/admin/payments/summary - TRUE NET REVENUE
// Total Paid - Total Refunded = ACTUAL clinic revenue
// ----------------------------------------------------------------
export const getPaymentsSummary = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { start, end } = req.query;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    const startDate = start ? new Date(start) : new Date('1970-01-01');
    const endDate = end ? new Date(end) : new Date('2999-12-31');
    endDate.setHours(23, 59, 59, 999);

    // 🔥 1. TOTAL PAID (Online + Cash)
    const totalPaidAgg = await prisma.payment.aggregate({
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

    // 🔥 2. TOTAL REFUNDED (Online refunds only)
    const totalRefundedAgg = await prisma.payment.aggregate({
      _sum: { amount: true },
      where: {
        clinicId,
        status: 'REFUNDED',
        createdAt: {
          gte: startDate,
          lte: endDate
        }
      }
    });

    const totalPaid = totalPaidAgg._sum.amount || 0;
    const totalRefunded = totalRefundedAgg._sum.amount || 0;
    const netRevenue = totalPaid - totalRefunded;

    // 🔥 3. Revenue per doctor (PAID only, no refunds)
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
      select: { 
        id: true, 
        name: true, 
        speciality: { select: { name: true } },
        deletedAt: true 
      }
    });

    const revenuePerDoctor = perDoctor.map(p => {
      const doc = doctors.find(d => d.id === p.doctorId);
      return {
        doctorId: p.doctorId,
        doctorName: doc ? doc.name : 'Unknown/Deleted',
        speciality: doc?.speciality?.name || null,
        isDeleted: !!(doc && doc.deletedAt),
        amount: p._sum.amount || 0
      };
    });

    return res.json({
      totalPaid,           // 💰 Total collected (Online + Cash)
      totalRefunded,       // 💸 Total refunded
      netRevenue,          // ✅ ACTUAL clinic revenue
      revenuePerDoctor     // 👨‍⚕️ Per doctor earnings
    });
  } catch (error) {
    console.error('Payments Summary Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
