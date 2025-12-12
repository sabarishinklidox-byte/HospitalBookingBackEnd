import prisma from '../prisma.js';

export const getAuditLogs = async (req, res) => {
  try {
    const { role: userRole, clinicId: userClinicId } = req.user;
    const {
      clinicId: filterClinicId,
      page = 1,
      limit = 20,
      startDate,
      endDate,
      role: filterRole,
    } = req.query;

    // Convert pagination params
    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    let where = {};

    // --- 1. Permission Logic ---
    if (userRole === 'SUPER_ADMIN') {
      // Super Admin can filter by any clinic
      if (filterClinicId) {
        where.clinicId = filterClinicId;
      }
    } else if (userRole === 'ADMIN') {
      // Clinic Admin restricted to their own clinic
      // (no allowAuditView check — always allowed for that clinic)
      if (!userClinicId) {
        return res
          .status(403)
          .json({ error: 'Access Denied: Clinic context missing.' });
      }
      where.clinicId = userClinicId;
    } else {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // --- 2. Apply Filters ---

    // Filter by User Role
    if (filterRole) {
      where.user = {
        role: filterRole,
      };
    }

    // Filter by Date Range
    if (startDate || endDate) {
      where.createdAt = {};

      if (startDate) {
        where.createdAt.gte = new Date(startDate);
      }

      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    // --- 3. Pagination Queries ---

    const totalLogs = await prisma.auditLog.count({ where });

    const logs = await prisma.auditLog.findMany({
      where,
      include: {
        user: { select: { name: true, role: true, deletedAt: true } },
        clinic: { select: { name: true, deletedAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
    });

    res.json({
      data: logs,
      pagination: {
        total: totalLogs,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalLogs / limitNum),
      },
    });
  } catch (error) {
    console.error('Get Audit Logs Error:', error);
    res.status(500).json({ error: error.message });
  }
};
