import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import { logAudit } from '../utils/audit.js';

// helper to get current plan for a clinic
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });

  return clinic?.subscription?.plan || null; // Plan has allowOnlinePayments, allowCustomBranding, enableAuditLogs, etc. [web:1186]
}

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
        deletedAt: true,
      },
    });

    if (!admin || admin.deletedAt) {
      return res
        .status(404)
        .json({ error: 'Admin account not found or inactive.' });
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
        deletedAt: true,
      },
    });

    if (!clinic || clinic.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found or inactive.' });
    }

    // get current plan for this clinic
    const plan = await getClinicPlan(clinicId);

    delete admin.deletedAt;
    delete clinic.deletedAt;

    return res.json({ admin, clinic, plan }); // ✅ send plan
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

    const currentAdmin = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!currentAdmin || currentAdmin.deletedAt) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;

    if (password) {
      if (password.length < 6) {
        return res
          .status(400)
          .json({ error: 'Password must be at least 6 characters' });
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
        clinicId: true,
      },
    });

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
      req,
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
    const {
      address,
      city,
      pincode,
      timings,
      details,
      googlePlaceId,
      googleMapsUrl,
      googleReviewsEmbedCode,
      googleRating,           // ✅ new field from body
    } = req.body;

    const existingClinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
    });
    if (!existingClinic || existingClinic.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found.' });
    }

    const data = {};
    if (address !== undefined) data.address = address;
    if (city !== undefined) data.city = city;
    if (pincode !== undefined) data.pincode = pincode;
    if (timings !== undefined) data.timings = timings;
    if (details !== undefined) data.details = details;

    // ✅ Google config fields
    if (googlePlaceId !== undefined) data.googlePlaceId = googlePlaceId;
    if (googleMapsUrl !== undefined) data.googleMapsUrl = googleMapsUrl;
    if (googleReviewsEmbedCode !== undefined) {
      data.googleReviewsEmbedCode = googleReviewsEmbedCode;
    }

    // ✅ numeric rating only (0–5, manual or synced)
    if (googleRating !== undefined && googleRating !== '') {
      data.googleRating = Number(googleRating);
    }

    const logoFile = req.files?.logo?.[0];
    const bannerFile = req.files?.banner?.[0];

    if (logoFile) {
      const baseUrl =
        process.env.APP_BASE_URL ||
        `http://localhost:${process.env.PORT || 5000}`;
      data.logo = `${baseUrl}/uploads/${logoFile.filename}`;
    }

    if (bannerFile) {
      const baseUrl =
        process.env.APP_BASE_URL ||
        `http://localhost:${process.env.PORT || 5000}`;
      data.banner = `${baseUrl}/uploads/${bannerFile.filename}`;
    }

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
        banner: true,
        googlePlaceId: true,
        googleMapsUrl: true,
        googleReviewsEmbedCode: true,
        googleRating: true,      // ✅ include in response
      },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'UPDATE_CLINIC_SETTINGS',
      entity: 'Clinic',
      entityId: clinicId,
      details: data,
      req,
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

    // 1) Check clinic validity
    const clinicCheck = await prisma.clinic.findUnique({
      where: { id: clinicId },
    });
    if (!clinicCheck || clinicCheck.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    // 2) Gate by plan: only plans with allowOnlinePayments can configure gateways
    const plan = await getClinicPlan(clinicId);
    if (!plan || !plan.allowOnlinePayments) {
      return res.status(403).json({
        error: 'Online payments are disabled on your current plan.',
      });
    }

    if (!provider) {
      return res.status(400).json({ error: 'provider is required' });
    }

    const gateway = await prisma.paymentGateway.upsert({
      where: {
        clinicId_name: {
          clinicId,
          name: provider, // matches your PaymentGateway.name field
        },
      },
      update: {
        apiKey: apiKey ?? undefined,
        secret: secretKey ?? undefined,
        isActive: typeof isActive === 'boolean' ? isActive : undefined,
      },
      create: {
        clinicId,
        name: provider,
        apiKey: apiKey || '',
        secret: secretKey || '',
        isActive: isActive ?? true,
      },
    });

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
        secretKey: secretKey ? '***UPDATED***' : 'Unchanged',
      },
      req,
    });

    return res.json({ gateway });
  } catch (error) {
    console.error('Update Clinic Gateway Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
