import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../utils/audit.js';

// -------------------------
// AUDIT ACTION CONSTANTS
// -------------------------
const ACTIONS = {
  LOGIN: 'SUPER_ADMIN_LOGIN',
  CREATE_CLINIC: 'CREATE_CLINIC',
  UPDATE_CLINIC: 'UPDATE_CLINIC',
  DELETE_CLINIC: 'DELETE_CLINIC',
  ACTIVATE_CLINIC: 'ACTIVATE_CLINIC',
  DEACTIVATE_CLINIC: 'DEACTIVATE_CLINIC',
  CREATE_ADMIN: 'CREATE_CLINIC_ADMIN',
  UPDATE_ADMIN: 'UPDATE_CLINIC_ADMIN',
  DELETE_ADMIN: 'DELETE_CLINIC_ADMIN',
  GRANT_AUDIT: 'GRANT_AUDIT_ACCESS',
  REVOKE_AUDIT: 'REVOKE_AUDIT_ACCESS'
};

// -------------------------
// DEFAULT SUPER ADMIN
// -------------------------
const DEFAULT_SUPER_ADMIN = {
  email: 'sabarisabarish847@gmail.com',
  password: 'sabarish!12',
  name: 'Super Admin'
};

export const createDefaultSuperAdmin = async (req, res) => {
  try {
    const existingAdmin = await prisma.user.findUnique({
      where: { email: DEFAULT_SUPER_ADMIN.email }
    });

    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash(DEFAULT_SUPER_ADMIN.password, 12);
      await prisma.user.create({
        data: {
          id: uuidv4(),
          email: DEFAULT_SUPER_ADMIN.email,
          password: hashedPassword,
          name: DEFAULT_SUPER_ADMIN.name,
          role: 'SUPER_ADMIN'
        }
      });
      return res.json({ message: '✅ Default Super Admin created!' });
    }
    return res.json({ message: 'Super Admin already exists' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// SUPER ADMIN LOGIN
// -------------------------
export const superAdminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user.id, role: user.role, clinicId: user.clinicId || null },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Safe Audit Log
    try {
      await logAudit({
        userId: user.id,
        clinicId: null,
        action: ACTIONS.LOGIN,
        entity: "User",
        entityId: user.id,
        req: req
      });
    } catch (e) { console.error("Audit Error:", e.message); }

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        clinicId: user.clinicId || null,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// =====================================================================
// CLINIC MANAGEMENT
// =====================================================================

// -------------------------
// CREATE CLINIC
// -------------------------
// src/controllers/superAdminController.js

// src/controllers/superAdminController.js

export const createClinic = async (req, res) => {
  try {
    const {
      name,
      phone,
      address,
      city,
      pincode,
      accountNumber,
      ifscCode,
      bankName,
      timings,
      details,
      // logo, banner,  <-- REMOVED
      planId,
      isActive,
      allowAuditView,
    } = req.body;

    if (!name || !phone || !address || !city || !pincode) {
      return res.status(400).json({ error: "Name, Phone, Address, City, and Pincode are required" });
    }

    if (!planId) {
      return res.status(400).json({ error: "planId is required" });
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");

    const plan = await prisma.plan.findFirst({
      where: { id: planId },
    });

    if (!plan) return res.status(404).json({ error: "Plan not found" });

    const safeAllowAuditView = plan.enableAuditLogs ? !!allowAuditView : false;

    const result = await prisma.$transaction(async (tx) => {
      const clinic = await tx.clinic.create({
        data: {
          slug,
          name,
          phone,
          address,
          city,
          pincode,
          accountNumber: accountNumber || "N/A",
          ifscCode: ifscCode || "N/A",
          bankName: bankName || "N/A",
          timings: timings || {},
          details: details || "",
          logo: null,    // ✅ Always null initially
          banner: null,  // ✅ Always null initially
          isActive: isActive ?? true,
          allowAuditView: safeAllowAuditView,
        },
      });

      const subscription = await tx.subscription.create({
        data: {
          clinicId: clinic.id,
          planId: plan.id,
          status: "ACTIVE",
          startDate: new Date(),
        },
      });

      return { clinic, subscription };
    });

    // ... audit log code ...

    return res.status(201).json(result);
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(400).json({ error: "Clinic with this name/slug already exists" });
    }
    return res.status(500).json({ error: error.message });
  }
};



// -------------------------
// GET ALL CLINICS (Active Only)
// -------------------------
export const getClinics = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const search = req.query.search || ''; // ✅ Get search query

    // ✅ Build search condition
    const searchCondition = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { city: { contains: search, mode: 'insensitive' } },
            { address: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
            { slug: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {};

    const whereCondition = {
      deletedAt: null,
      ...searchCondition, // ✅ Add search condition
    };

    // ✅ Get total count with search filter
    const total = await prisma.clinic.count({ where: whereCondition });

    const clinics = await prisma.clinic.findMany({
      where: whereCondition,
      include: {
        admins: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        doctors: {
          where: { isActive: true, deletedAt: null },
          select: {
            id: true,
            name: true,
            speciality: true,
            avatar: true,
          },
        },
        gateways: {
          select: {
            id: true,
            name: true,
            isActive: true,
          },
        },
      },
      skip: skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      data: clinics,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
      search: search || null, // ✅ Return search term
    });
  } catch (error) {
    console.error('getClinics error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// GET CLINIC BY ID
// -------------------------
export const getClinicById = async (req, res) => {
  try {
    const { id } = req.params;
    const clinic = await prisma.clinic.findFirst({
      where: { 
        id,
        deletedAt: null // ✅ Ensure it's not deleted
      },
      include: { admins: true, doctors: true, gateways: true }
    });
    
    if (!clinic) return res.status(404).json({ error: 'Clinic not found' });
    return res.json(clinic);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// UPDATE CLINIC
// -------------------------
export const updateClinic = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const oldClinic = await prisma.clinic.findUnique({ where: { id } });
    if (!oldClinic || oldClinic.deletedAt) return res.status(404).json({ error: "Clinic not found" });

    const clinic = await prisma.clinic.update({
      where: { id },
      data: updates
    });

    try {
      const changes = {};
      Object.keys(updates).forEach(key => {
        if (oldClinic[key] !== updates[key]) {
          changes[key] = { from: oldClinic[key], to: updates[key] };
        }
      });

      await logAudit({
        userId: req.user.userId || req.user.id,
        clinicId: clinic.id,
        action: ACTIONS.UPDATE_CLINIC,
        entity: "Clinic",
        entityId: clinic.id,
        details: { changes },
        req: req
      });
    } catch (e) { console.error("Audit Error:", e.message); }

    return res.json(clinic);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// DELETE CLINIC (Soft Delete)
// -------------------------
export const deleteClinic = async (req, res) => {
  try {
    const { id } = req.params;
    const clinic = await prisma.clinic.findUnique({ where: { id }, select: { name: true } });

    // ✅ Soft Delete: Mark as deleted instead of removing
    await prisma.clinic.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    try {
      await logAudit({
        userId: req.user.userId || req.user.id,
        clinicId: null,
        action: ACTIONS.DELETE_CLINIC,
        entity: "Clinic",
        entityId: id,
        details: { deletedClinicName: clinic?.name || 'Unknown' },
        req: req
      });
    } catch (e) { console.error("Audit Error:", e.message); }

    return res.json({ message: 'Clinic deleted successfully (soft)' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// =====================================================================
// ADMIN MANAGEMENT
// =====================================================================

// -------------------------
// CREATE CLINIC ADMIN
// -------------------------
export const createClinicAdmin = async (req, res) => {
  try {
    const { email, name, phone, clinicId, password } = req.body;

    if (!email || !name || !password || !clinicId) {
      return res.status(400).json({ error: 'Email, Name, Password, and Clinic ID are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if email exists (even if deleted)
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      if (existingUser.deletedAt) return res.status(400).json({ error: 'Email belongs to a deleted account' });
      return res.status(400).json({ error: 'Email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const admin = await prisma.user.create({
      data: { 
        email, 
        password: hashedPassword, 
        name, 
        phone: phone || null, 
        role: 'ADMIN', 
        clinicId 
      }
    });

    try {
      await logAudit({
        userId: req.user?.userId || req.user?.id,
        clinicId: clinicId,
        action: ACTIONS.CREATE_ADMIN,
        entity: "User",
        entityId: admin.id,
        details: { email: admin.email, name: admin.name },
        req: req
      });
    } catch (logError) { console.warn("Audit Log Failed:", logError.message); }

    return res.status(201).json({ message: 'Clinic Admin created', admin });

  } catch (error) {
    if (error.code === 'P2002') return res.status(400).json({ error: 'Email already exists' });
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// GET ALL ADMINS (Filtered)
// -------------------------
export const getClinicAdmins = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    const search = req.query.search || ''; // ✅ Get search query

    // ✅ Build search condition
    const searchCondition = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { phone: { contains: search, mode: 'insensitive' } },
            { clinic: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
      : {};

    const whereCondition = {
      role: 'ADMIN',
      deletedAt: null,
      ...searchCondition, // ✅ Add search condition
    };

    // ✅ Get total count with search filter
    const total = await prisma.user.count({ where: whereCondition });

    const admins = await prisma.user.findMany({
      where: whereCondition,
      include: {
        clinic: {
          select: {
            id: true,
            name: true,
            phone: true,
            city: true,
            address: true,
          },
        },
      },
      skip: skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    return res.json({
      data: admins,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
        hasNextPage: page < Math.ceil(total / limit),
        hasPrevPage: page > 1,
      },
      search: search || null, // ✅ Return search term
    });
  } catch (error) {
    console.error('getClinicAdmins error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// UPDATE CLINIC ADMIN
// -------------------------
export const updateClinicAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, phone, clinicId, password } = req.body;

    // 1. Verify the Admin Exists
    const existingAdmin = await prisma.user.findUnique({ where: { id } });
    if (!existingAdmin) {
      return res.status(404).json({ error: 'Admin not found' });
    }

    // 2. Build Update Data
    const updateData = {};
    if (email !== undefined) updateData.email = email;
    if (name !== undefined) updateData.name = name;
    if (phone !== undefined) updateData.phone = phone;

    // 3. ✅ VALIDATE CLINIC ID (The Fix)
    if (clinicId) {
      const clinicExists = await prisma.clinic.findUnique({
        where: { id: clinicId }
      });

      if (!clinicExists) {
        return res.status(400).json({ error: "Invalid Clinic ID selected. Clinic does not exist." });
      }
      
      updateData.clinicId = clinicId;
    }

    // 4. Handle Password
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'Password too short' });
      updateData.password = await bcrypt.hash(password, 12);
    }

    // 5. Update
    const admin = await prisma.user.update({
      where: { id },
      data: updateData
    });

    // 6. Log Audit (Safe)
    try {
        await logAudit({
            userId: req.user.userId || req.user.id,
            clinicId: clinicId || existingAdmin.clinicId,
            action: 'UPDATE_CLINIC_ADMIN',
            entity: "User",
            entityId: admin.id,
            details: { updatedFields: Object.keys(updateData) },
            req: req
        });
    } catch(e) { console.error("Audit log failed", e); }

    return res.json({ message: 'Clinic Admin updated', admin });

  } catch (error) {
    console.error("Update Admin Error:", error);
    if (error.code === 'P2003') { // Prisma Foreign Key Error Code
        return res.status(400).json({ error: "Invalid Clinic ID provided." });
    }
    return res.status(500).json({ error: error.message });
  }
};
// DELETE CLINIC ADMIN (Soft Delete)
// -------------------------
export const deleteClinicAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const admin = await prisma.user.findUnique({ where: { id }, select: { email: true } });

    // ✅ Soft Delete
    await prisma.user.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    try {
      await logAudit({
        userId: req.user.userId || req.user.id,
        clinicId: null,
        action: ACTIONS.DELETE_ADMIN,
        entity: "User",
        entityId: id,
        details: { deletedEmail: admin?.email },
        req: req
      });
    } catch (e) { console.error("Audit Error:", e.message); }

    return res.json({ message: 'Clinic Admin deleted (soft)' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

// =====================================================================
// TOGGLES
// =====================================================================

export const toggleClinicStatus = async (req, res) => {
  try {
    const { clinicId } = req.params;
    const { isActive } = req.body;

    const updatedClinic = await prisma.clinic.update({
      where: { id: clinicId },
      data: { isActive }
    });

    try {
      await logAudit({
        userId: req.user.userId || req.user.id,
        clinicId: clinicId,
        action: isActive ? ACTIONS.ACTIVATE_CLINIC : ACTIONS.DEACTIVATE_CLINIC,
        entity: "Clinic",
        entityId: clinicId,
        req: req
      });
    } catch (e) { console.error("Audit Error:", e.message); }

    res.json({ message: `Clinic is now ${isActive ? 'Active' : 'Inactive'}`, clinic: updatedClinic });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

export const toggleAuditPermission = async (req, res) => {
  try {
    const { clinicId } = req.params;
    const { allowAuditView } = req.body;

    const updatedClinic = await prisma.clinic.update({
      where: { id: clinicId },
      data: { allowAuditView }
    });

    try {
      await logAudit({
        userId: req.user.userId || req.user.id,
        clinicId: clinicId,
        action: allowAuditView ? ACTIONS.GRANT_AUDIT : ACTIONS.REVOKE_AUDIT,
        entity: "Clinic",
        entityId: clinicId,
        req: req
      });
    } catch (e) { console.error("Audit Error:", e.message); }

    res.json({ message: `Audit Log Access ${allowAuditView ? 'Granted' : 'Revoked'}`, clinic: updatedClinic });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
export const getClinicAdminById = async (req, res) => {
  try {
    const { id } = req.params;

    const admin = await prisma.user.findUnique({
      where: { id },
      include: { clinic: true }, // Include clinic info if needed
    });

    // Check if user exists and is actually an ADMIN
    if (!admin || admin.role !== 'ADMIN') {
      return res.status(404).json({ error: 'Clinic Admin not found' });
    }

    // Check if soft deleted (optional, depending on your logic)
    if (admin.deletedAt) {
      return res.status(404).json({ error: 'This admin has been deleted.' });
    }

    // Return the admin data
    return res.json(admin);

  } catch (error) {
    console.error('Get Clinic Admin By ID Error:', error);
    return res.status(500).json({ error: 'Failed to fetch admin details' });
  }
};export async function getAnalytics(req, res) {
  try {
    // 1) Total users
    const totalUsers = await prisma.user.count(); // or where: { role: 'USER' }

    // 2) Total bookings (all appointments)
    const totalBookings = await prisma.appointment.count();

    // 3) Total bookings per clinic (optionally filter by clinicId)
    const { clinicId } = req.query;

    let clinicBookings;

    if (clinicId) {
      // total bookings for one clinic
      clinicBookings = await prisma.appointment.count({
        where: { clinicId: Number(clinicId) },
      });
    } else {
      // bookings grouped by clinic (array of { clinicId, count })
      const grouped = await prisma.appointment.groupBy({
        by: ['clinicId'],
        _count: { id: true },
      });

      clinicBookings = grouped.map((row) => ({
        clinicId: row.clinicId,
        total: row._count.id,
      }));
    }

    return res.json({
      totalUsers,
      totalBookings,
      clinicBookings,
    });
  } catch (err) {
    console.error('Analytics error', err);
    return res
      .status(500)
      .json({ error: 'Failed to fetch analytics' });
  }
}
export const incrementClinicLinkClicks = async (req, res) => {
  const { clinicId } = req.params;
  console.log('incrementClinicLinkClicks called for', clinicId);

  try {
    const clinic = await prisma.clinic.update({
      where: { id: clinicId },           // id is String (uuid)
      data: { linkClicks: { increment: 1 } },
      select: { id: true, linkClicks: true },
    });

    console.log('updated linkClicks =', clinic.linkClicks);
    return res.json(clinic);
  } catch (error) {
    console.error('incrementClinicLinkClicks error', error);
    return res.status(500).json({ error: 'Failed to track click' });
  }
};
export const listClinicsForAdmin = async (req, res) => {
  try {
    const clinics = await prisma.clinic.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true, city: true },
      orderBy: { name: 'asc' },
    });
    res.json(clinics);
  } catch (error) {
    console.error('listClinicsForAdmin error:', error);
    res.status(500).json({ error: error.message });
  }
};
 // or prisma.$queryRaw`...` style
export const getGlobalBookingsStats = async (req, res) => {
  try {
    const { role: userRole } = req.user;
    const { startDate, endDate } = req.query;

    if (userRole !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ error: 'startDate and endDate are required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // 1) Get all appointments in range
    const appts = await prisma.appointment.findMany({
      where: {
        createdAt: { gte: start, lte: end },
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] },
      },
      select: {
        createdAt: true,
        userId: true,
        clinicId: true, // make sure this exists in your model
      },
      orderBy: { createdAt: 'asc' },
    });

    // 2) Group by date in JS
    const perDayMap = new Map();
    // also collect for summary & per‑clinic
    const uniquePatientsSet = new Set();
    const clinicMap = new Map(); // clinicId -> { bookings, patients: Set }

    for (const a of appts) {
      const day = a.createdAt.toISOString().slice(0, 10);

      // per‑day
      if (!perDayMap.has(day)) {
        perDayMap.set(day, { totalBookings: 0, patients: new Set() });
      }
      const dayEntry = perDayMap.get(day);
      dayEntry.totalBookings += 1;
      if (a.userId) {
        dayEntry.patients.add(a.userId);
        uniquePatientsSet.add(a.userId);
      }

      // per‑clinic
      if (a.clinicId) {
        if (!clinicMap.has(a.clinicId)) {
          clinicMap.set(a.clinicId, {
            bookings: 0,
            patients: new Set(),
          });
        }
        const clinicEntry = clinicMap.get(a.clinicId);
        clinicEntry.bookings += 1;
        if (a.userId) clinicEntry.patients.add(a.userId);
      }
    }

    const data = Array.from(perDayMap.entries())
      .sort(([d1], [d2]) => (d1 < d2 ? -1 : 1))
      .map(([day, value]) => ({
        date: day,
        totalBookings: value.totalBookings,
        totalPatients: value.patients.size,
      }));

    // 3) Summary
    const totalBookings = appts.length;
    const totalPatients = uniquePatientsSet.size;

    const dayCount =
      1 +
      Math.floor(
        (new Date(end.toDateString()) - new Date(start.toDateString())) /
          (1000 * 60 * 60 * 24)
      );

    const summary = {
      totalBookings,
      totalPatients,
      avgBookingsPerDay: dayCount > 0 ? totalBookings / dayCount : 0,
      uniqueClinics: clinicMap.size,
    };

    // 4) Per‑clinic breakdown (join with Clinic names)
    const clinicIds = Array.from(clinicMap.keys());

    let clinicNameMap = new Map();
    if (clinicIds.length > 0) {
      const clinics = await prisma.clinic.findMany({
        where: { id: { in: clinicIds } },
        select: { id: true, name: true },
      });
      clinicNameMap = new Map(clinics.map((c) => [c.id, c.name]));
    }

    const clinics = Array.from(clinicMap.entries()).map(
      ([clinicId, value]) => ({
        clinicId,
        clinicName: clinicNameMap.get(clinicId) || 'Unknown clinic',
        bookings: value.bookings,
        patients: value.patients.size,
      })
    );

    return res.json({ data, summary, clinics });
  } catch (err) {
    console.error('getGlobalBookingsStats error', err);
    return res.status(500).json({ error: 'Failed to load stats' });
  }
};
