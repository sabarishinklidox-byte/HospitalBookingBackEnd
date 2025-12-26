import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import { logAudit } from '../utils/audit.js';


// ----------------------------------------------------------------
// Helper: Get current plan for a clinic
// ----------------------------------------------------------------
const getClinicSubscription = async (clinicId) => {
  // Always return the latest subscription for this clinic (any status)
  const sub = await prisma.subscription.findFirst({
    where: { clinicId },
    orderBy: { createdAt: 'desc' },   // newest record (EXPIRED will win)
    include: {
      plan: true,
    },
  });

  return sub;
};


// ----------------------------------------------------------------
// GET /api/admin/profile (User + Clinic Info)
// src/controllers/adminController.js (or wherever)
;

export const getAdminProfile = async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;

    if (!userId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    const user = await prisma.user.findUnique({
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

    if (!user || user.deletedAt) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    const resolvedClinicId = user.clinicId;

    if (!resolvedClinicId) {
      return res.json({ admin: user, clinic: null, plan: null });
    }

    const clinic = await prisma.clinic.findUnique({
      where: { id: resolvedClinicId },
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
        googleRating: true,
        bankName: true,
        accountNumber: true,
        ifscCode: true,
        deletedAt: true,
      },
    });

    if (!clinic || clinic.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found or inactive.' });
    }

    const subscription = await getClinicSubscription(resolvedClinicId);

    delete user.deletedAt;
    delete clinic.deletedAt;

    if (subscription) {
      clinic.subscription = subscription; // single latest subscription object
    }

    return res.json({
      admin: user,
      clinic,
      plan: subscription?.plan || null,
    });
  } catch (error) {
    console.error('Get Admin Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};


// ----------------------------------------------------------------
// PATCH /api/admin/profile
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// PATCH /api/admin/profile
// ----------------------------------------------------------------
export const updateAdminProfile = async (req, res) => {
  try {
    // 1. Safe ID Extraction
    const userId = req.user.id || req.user.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token payload' });
    }

    const { name, phone, password } = req.body;

    // 2. Fetch Current User
    const currentAdmin = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!currentAdmin || currentAdmin.deletedAt) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // 3. Prepare Update Data
    const data = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      data.password = await bcrypt.hash(password, 12);
    }

    // 4. Update User
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

    // 5. Audit Log
    const changes = {};
    if (name && name !== currentAdmin.name) changes.name = name;
    if (phone && phone !== currentAdmin.phone) changes.phone = phone;
    if (password) changes.password = 'Password Changed';

    // ✅ FIXED: Only check user.clinicId (Removed prisma.admin lookup)
    const auditClinicId = currentAdmin.clinicId; 

    if (auditClinicId) {
        await logAudit({
            userId,
            clinicId: auditClinicId,
            action: 'UPDATE_ADMIN_PROFILE',
            entity: 'User',
            entityId: userId,
            details: changes,
            req,
        });
    }

    return res.json({ admin: updated });
  } catch (error) {
    console.error('Update Admin Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};


// ----------------------------------------------------------------
// PATCH /api/admin/clinic
// ----------------------------------------------------------------
// src/controllers/adminController.js

// ... (keep getAdminProfile as is)

// ----------------------------------------------------------------
// PATCH /api/admin/clinic
// ----------------------------------------------------------------
export const updateClinicSettings = async (req, res) => {
  try {
    // 1. Get User ID from Token
    const userId = req.user.id || req.user.userId;

    // 2. Fetch User to get the secure Clinic ID
    const user = await prisma.user.findUnique({ 
        where: { id: userId },
        select: { clinicId: true }
    });
    
    // 3. Validate Clinic ID
    const clinicId = user?.clinicId;

    if (!clinicId) {
        return res.status(404).json({ error: "No clinic linked to this user." });
    }

    const {
      address, city, pincode, timings, details,
      googlePlaceId, googleMapsUrl, googleReviewsEmbedCode, googleRating,
      // Bank details might be updated here too if your form allows
      bankName, accountNumber, ifscCode
    } = req.body;

    const data = {};
    if (address !== undefined) data.address = address;
    if (city !== undefined) data.city = city;
    if (pincode !== undefined) data.pincode = pincode;
    if (timings !== undefined) data.timings = timings;
    if (details !== undefined) data.details = details;
    
    // Google Integration
    if (googlePlaceId !== undefined) data.googlePlaceId = googlePlaceId;
    if (googleMapsUrl !== undefined) data.googleMapsUrl = googleMapsUrl;
    if (googleReviewsEmbedCode !== undefined) data.googleReviewsEmbedCode = googleReviewsEmbedCode;
    if (googleRating !== undefined && googleRating !== '') data.googleRating = Number(googleRating);

    // Bank Details
    if (bankName !== undefined) data.bankName = bankName;
    if (accountNumber !== undefined) data.accountNumber = accountNumber;
    if (ifscCode !== undefined) data.ifscCode = ifscCode;

    // File Uploads (Multer)
    const logoFile = req.files?.logo?.[0];
    const bannerFile = req.files?.banner?.[0];

    const baseUrl = process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 5000}`;
if (logoFile) data.logo = `/uploads/${logoFile.filename}`;
if (bannerFile) data.banner = `/uploads/${bannerFile.filename}`;

    // 4. Update Clinic
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
        googleRating: true,
        bankName: true,
        accountNumber: true,
        ifscCode: true,
      },
    });

    // 5. Audit Log
    await logAudit({
      userId,
      clinicId,
      action: 'UPDATE_CLINIC_SETTINGS',
      entity: 'Clinic',
      entityId: clinicId,
      details: data, // Logs what changed
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
// ----------------------------------------------------------------
// PATCH /api/admin/clinic/gateway
// ----------------------------------------------------------------
export const updateGatewayConfig = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { gatewayName, publishableKey, secretKey, isActive } = req.body;

    const name = (gatewayName || 'STRIPE').toUpperCase();
    if (!['STRIPE', 'RAZORPAY'].includes(name)) {
      return res
        .status(400)
        .json({ error: 'Invalid gateway name. Use STRIPE or RAZORPAY.' });
    }

    if (!publishableKey) {
      return res.status(400).json({
        error:
          name === 'RAZORPAY'
            ? 'Key ID is required'
            : 'Publishable Key is required',
      });
    }

    const updateData = {
      apiKey: publishableKey,
      deletedAt: null,
    };

    if (typeof isActive === 'boolean') {
      updateData.isActive = isActive;
    }

    if (secretKey && secretKey.trim() !== '') {
      updateData.secret = secretKey;
    }

    const gateway = await prisma.paymentGateway.upsert({
      where: {
        clinicId_name: {
          clinicId,
          name,
        },
      },
      update: updateData,
      create: {
        clinicId,
        name,
        apiKey: publishableKey,
        secret: secretKey || '',
        isActive: typeof isActive === 'boolean' ? isActive : true,
      },
    });

    // ensure only this gateway is active for the clinic
    if (gateway.isActive) {
      await prisma.paymentGateway.updateMany({
        where: {
          clinicId,
          NOT: { id: gateway.id },
        },
        data: { isActive: false },
      });
    }

    res.json({
      message: `${name} settings updated successfully`,
      gateway,
    });
  } catch (error) {
    console.error('Update Gateway Error:', error);
    res.status(500).json({ error: error.message });
  }
};

export const getGatewayConfig = async (req, res) => {
  try {
    const { clinicId } = req.user;

    const gatewayName = (req.query.gateway || 'STRIPE').toUpperCase();

    if (!['STRIPE', 'RAZORPAY'].includes(gatewayName)) {
      return res.json({ apiKey: '', isActive: false });
    }

    const gateway = await prisma.paymentGateway.findFirst({
      where: {
        clinicId,
        name: gatewayName,
        deletedAt: null,
      },
      select: {
        apiKey: true,
        isActive: true,
      },
    });

    res.json(gateway || { apiKey: '', isActive: false });
  } catch (error) {
    console.error('Get Gateway Error:', error);
    res.status(500).json({ error: error.message });
  }
};