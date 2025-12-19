import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import { logAudit } from '../utils/audit.js';

// ----------------------------------------------------------------
// Helper: Get current plan for a clinic
// ----------------------------------------------------------------
async function getClinicPlan(clinicId) {
  if (!clinicId) return null;
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  return clinic?.subscription?.plan || null; 
}

// ----------------------------------------------------------------
// GET /api/admin/profile (User + Clinic Info)
// ----------------------------------------------------------------
export const getAdminProfile = async (req, res) => {
  try {
    // 1. Get ID from token (Handle both 'id' and 'userId' formats)
    const userId = req.user.id || req.user.userId;

    if (!userId) {
        return res.status(401).json({ error: "Invalid token payload" });
    }

    // 2. Fetch User directly
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        role: true,
        clinicId: true, // ✅ We get clinicId directly from User
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    // 3. Resolve Clinic ID
    // ❌ REMOVED: The fallback to prisma.admin because that table doesn't exist
    const resolvedClinicId = user.clinicId;

    if (!resolvedClinicId) {
       // Valid user, but no clinic linked
       return res.json({ admin: user, clinic: null, plan: null });
    }

    // 4. Fetch Clinic
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
        // Bank Details
        bankName: true,
        accountNumber: true,
        ifscCode: true,
        deletedAt: true,
      },
    });

    if (!clinic || clinic.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found or inactive.' });
    }

    // 5. Fetch Plan
    const plan = await getClinicPlan(resolvedClinicId);

    delete user.deletedAt;
    delete clinic.deletedAt;

    // Return merged data
    return res.json({ admin: user, clinic, plan });

  } catch (error) {
    console.error('Get Admin Profile Error:', error);
    // Return actual error message for debugging instead of generic 500
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

    if (logoFile) data.logo = `${baseUrl}/uploads/${logoFile.filename}`;
    if (bannerFile) data.banner = `${baseUrl}/uploads/${bannerFile.filename}`;

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
export const updateClinicGateway = async (req, res) => {
  try {
    // 1. Safe ID Extraction
    const userId = req.user.id || req.user.userId;

    if (!userId) {
        return res.status(401).json({ error: 'Unauthorized: Invalid token payload' });
    }
    
    // 2. Resolve Clinic ID securely (Only check User table)
    const user = await prisma.user.findUnique({ 
        where: { id: userId },
        select: { clinicId: true }
    });
    
    // ✅ FIXED: Removed fallback to prisma.admin
    const clinicId = user?.clinicId;

    if (!clinicId) {
        return res.status(404).json({ error: "Clinic not found for this user" });
    }

    const { provider, apiKey, secretKey, isActive } = req.body;

    const clinicCheck = await prisma.clinic.findUnique({
      where: { id: clinicId },
    });
    
    if (!clinicCheck || clinicCheck.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

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
          name: provider,
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
      userId,
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
