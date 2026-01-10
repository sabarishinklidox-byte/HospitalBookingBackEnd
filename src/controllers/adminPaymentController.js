import prisma from '../prisma.js';

// ----------------------------------------------------------------
// GET /api/admin/payments - FULL REVENUE HISTORY WITH PAGINATION
// Tracks: Online, Offline Cash, Reschedules, Refunds, Failed
// ----------------------------------------------------------------
export const getPayments = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { 
      start, end, doctorId, status, paymentMode, type, 
      page = 1, limit = 20  // Default 20 payments per page
    } = req.query;

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

    // 🔥 Payment Mode filter (ONLINE, CASH, RAZORPAY)
    if (paymentMode) where.provider = paymentMode;

    // 🔥 Payment Type filter (APPOINTMENT, RESCHEDULE)
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

    // 🔥 PAGINATION
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    // Get paginated payments + total count (optimized with Promise.all)
    const [payments, totalCount] = await Promise.all([
      prisma.payment.findMany({
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
        },
        skip,
        take
      }),
      prisma.payment.count({ where })
    ]);

    // 🆕 PERFECT PAGINATION RESPONSE
    const pagination = {
      currentPage: Number(page),
      totalPages: Math.ceil(totalCount / take),
      totalCount,
      limit: take,
      hasNext: Number(page) < Math.ceil(totalCount / take),
      hasPrev: Number(page) > 1,
      perPage: take,
      from: skip + 1,
      to: Math.min(skip + take, totalCount)
    };

    return res.json({
      data: payments,
      pagination
    });

  } catch (error) {
    console.error('Get Payments Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET /api/admin/payments/summary - TRUE NET REVENUE WITH PAGINATION
// Total Paid - Total Refunded = ACTUAL clinic revenue
// ----------------------------------------------------------------
export const getPaymentsSummary = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { start, end, page = 1, limit = 10 } = req.query;

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

    const startDate = start ? new Date(start) : new Date('1970-01-01');
    const endDate = end ? new Date(end) : new Date('2999-12-31');
    endDate.setHours(23, 59, 59, 999);

    // 1. Total calculations (optimized with Promise.all)
    const [totalPaidResult, totalRefundedResult, totalDoctorCountResult] = await Promise.all([
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          clinicId,
          status: 'PAID',
          createdAt: { gte: startDate, lte: endDate }
        }
      }),
      prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          clinicId,
          status: 'REFUNDED',
          createdAt: { gte: startDate, lte: endDate }
        }
      }),
      // ✅ FIXED: Get total unique doctor count
      prisma.payment.groupBy({
        by: ['doctorId'],
        _count: { doctorId: true },
        where: {
          clinicId,
          status: 'PAID',
          createdAt: { gte: startDate, lte: endDate }
        }
      })
    ]);

    const totalPaid = totalPaidResult._sum.amount || 0;
    const totalRefunded = totalRefundedResult._sum.amount || 0;
    const netRevenue = totalPaid - totalRefunded;
    const totalDoctors = totalDoctorCountResult.length;

    // 🔥 2. Revenue per doctor WITH PROPER PAGINATION
    const skip = (Number(page) - 1) * Number(limit);
    const take = Number(limit);

    const perDoctor = await prisma.payment.groupBy({
      by: ['doctorId'],
      _sum: { amount: true },
      where: {
        clinicId,
        status: 'PAID',
        createdAt: { gte: startDate, lte: endDate }
      },
      take,
      skip,
      orderBy: { 
        _sum: { 
          amount: 'desc' 
        } 
      }
    });

    // Get doctor details for current page only (N+1 fix)
    const doctorIds = perDoctor.map(p => p.doctorId);
    const doctors = await prisma.doctor.findMany({
      where: { 
        id: { 
          in: doctorIds 
        } 
      },
      select: { 
        id: true, 
        name: true, 
        speciality: { select: { name: true } }, 
        deletedAt: true 
      }
    });

    // Map revenue data with doctor info
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

    // 🆕 COMPLETE PAGINATION INFO
    const pagination = {
      currentPage: Number(page),
      totalPages: Math.ceil(totalDoctors / take),
      totalDoctors,
      limit: take,
      hasNext: Number(page) < Math.ceil(totalDoctors / take),
      hasPrev: Number(page) > 1,
      perPage: take,
      from: skip + 1,
      to: Math.min(skip + take, totalDoctors)
    };

    return res.json({
      totalPaid,
      totalRefunded,
      netRevenue,
      revenuePerDoctor,
      pagination
    });

  } catch (error) {
    console.error('Payments Summary Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
