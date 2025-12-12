import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
// ✅ Import Logger
import { logAudit } from '../utils/audit.js';

// ----------------------------------------------------------------
// GET /api/admin/profile (admin + clinic info)
// ----------------------------------------------------------------
export const getAdminProfile = async (req, res) => {
  try {
    const { userId, clinicId } = req.user;

    const admin = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        clinicId: true,
        deletedAt: true
      }
    });

    if (!admin || admin.deletedAt) {
      return res.status(404).json({ error: 'Admin account not found or inactive.' });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        pincode: true,
        timings: true,
        details: true,
        logo: true,
        banner: true,
        deletedAt: true
      }
    });

    if (!clinic || clinic.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found or inactive.' });
    }

    // Clean up response
    delete admin.deletedAt;
    delete clinic.deletedAt;

    return res.json({ admin, clinic });
  } catch (error) {
    console.error('Get Admin Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// PATCH /api/admin/profile
// ----------------------------------------------------------------
export const updateAdminProfile = async (req, res) => {
  try {
    const { userId, clinicId } = req.user;
    const { name, phone, password } = req.body;

    // 1. Fetch current data (Check deleted)
    const currentAdmin = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!currentAdmin || currentAdmin.deletedAt) {
        return res.status(404).json({ error: "User not found." });
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      const hashed = await bcrypt.hash(password, 12);
      data.password = hashed;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        clinicId: true
      }
    });

    // ✅ LOG AUDIT
    const changes = {};
    if (name && name !== currentAdmin.name) changes.name = name;
    if (phone && phone !== currentAdmin.phone) changes.phone = phone;
    if (password) changes.password = 'Password Changed'; 

    await logAudit({
      userId,
      clinicId,
      action: 'UPDATE_ADMIN_PROFILE',
      entity: 'User',
      entityId: userId,
      details: changes,
      req
    });

    return res.json({ admin: updated });
  } catch (error) {
    console.error('Update Admin Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// PATCH /api/admin/clinic
// ----------------------------------------------------------------
export const updateClinicSettings = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { address, city, pincode, timings, details, logo, banner } = req.body;

    // Check if clinic exists & active
    const existingClinic = await prisma.clinic.findUnique({
        where: { id: clinicId }
    });
    if (!existingClinic || existingClinic.deletedAt) {
        return res.status(404).json({ error: "Clinic not found." });
    }

    const data = {};
    if (address !== undefined) data.address = address;
    if (city !== undefined) data.city = city;
    if (pincode !== undefined) data.pincode = pincode;
    if (timings !== undefined) data.timings = timings;
    if (details !== undefined) data.details = details;
    if (logo !== undefined) data.logo = logo;
    if (banner !== undefined) data.banner = banner;

    const clinic = await prisma.clinic.update({
      where: { id: clinicId },
      data,
      select: {
        id: true,
        name: true,
        address: true,
        city: true,
        pincode: true,
        timings: true,
        details: true,
        logo: true,
        banner: true
      }
    });

    // ✅ LOG AUDIT
    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'UPDATE_CLINIC_SETTINGS',
      entity: 'Clinic',
      entityId: clinicId,
      details: data, 
      req
    });

    return res.json({ clinic });
  } catch (error) {
    console.error('Update Clinic Settings Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// PATCH /api/admin/clinic/gateway
// ----------------------------------------------------------------
export const updateClinicGateway = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { provider, apiKey, secretKey, isActive } = req.body;

    // Check clinic validity first
    const clinicCheck = await prisma.clinic.findUnique({ where: { id: clinicId }});
    if(!clinicCheck || clinicCheck.deletedAt) return res.status(404).json({error: "Clinic not found"});

    if (!provider) {
      return res.status(400).json({ error: 'provider is required' });
    }

    const gateway = await prisma.paymentGateway.upsert({
      where: {
        clinicId_provider: {
          clinicId,
          provider
        }
      },
      update: {
        apiKey: apiKey ?? undefined,
        secretKey: secretKey ?? undefined,
        isActive: typeof isActive === 'boolean' ? isActive : undefined
      },
      create: {
        clinicId,
        provider,
        apiKey: apiKey || '',
        secretKey: secretKey || '',
        isActive: isActive ?? true
      }
    });

    // ✅ LOG AUDIT
    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'UPDATE_PAYMENT_GATEWAY',
      entity: 'PaymentGateway',
      entityId: gateway.id,
      details: {
        provider,
        isActive,
        apiKey: apiKey ? '***UPDATED***' : 'Unchanged',
        secretKey: secretKey ? '***UPDATED***' : 'Unchanged'
      },
      req
    });

    return res.json({ gateway });
  } catch (error) {
    console.error('Update Clinic Gateway Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
