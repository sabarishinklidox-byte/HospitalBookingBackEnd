// src/controllers/publicOrganizationController.js
import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken'; // ✅ ADDED
import { logAudit } from '../utils/audit.js';

// Helper to generate clinic slug from name
const toSlug = (str) =>
  str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

// Helper to ensure slug is unique
async function generateUniqueClinicSlug(tx, clinicName) {
  const baseSlug = toSlug(clinicName);
  let slug = baseSlug;
  let counter = 1;

  while (true) {
    const count = await tx.clinic.count({ where: { slug } });
    if (count === 0) return slug;
    counter += 1;
    slug = `${baseSlug}-${counter}`;
  }
}

export const registerOrganization = async (req, res) => {
  try {
    const {
      clinicName,
      clinicPhone,
      ownerName,
      ownerEmail,
      ownerPhone,
      addressLine1,
      city,
      state,
      pincode,
      planId,
      ownerPassword,
    } = req.body;

    // Validation
    if (!clinicName || !clinicPhone) {
      return res.status(400).json({ error: 'Clinic name and phone are required' });
    }

    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }

    if (!ownerPassword || ownerPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // 1) Validate plan
    const plan = await prisma.plan.findFirst({
      where: { id: planId, isActive: true, deletedAt: null },
    });
    if (!plan) {
      return res.status(400).json({ error: 'Selected plan is not available' });
    }

    // 2) Ensure email not already used
    const existingUser = await prisma.user.findUnique({
      where: { email: ownerEmail },
    });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    // 3) Create everything in a transaction
    const result = await prisma.$transaction(async (tx) => {
      const slug = await generateUniqueClinicSlug(tx, clinicName);
      const fullAddress = [addressLine1, city, state, pincode]
        .filter(Boolean)
        .join(', ');

      // Create clinic WITH phone number
      const clinic = await tx.clinic.create({
        data: {
          slug,
          name: clinicName,
          phone: clinicPhone,
          address: fullAddress || clinicName,
          city: city || '',
          pincode: pincode || '',
          accountNumber: 'N/A',
          ifscCode: 'N/A',
          bankName: 'N/A',
          timings: {},
          details: '',
          logo: null,
          banner: null,
        },
      });

      // Hash password
      const hashedPassword = await bcrypt.hash(ownerPassword, 10);

      // Create owner user as clinic admin
      const ownerUser = await tx.user.create({
        data: {
          name: ownerName,
          email: ownerEmail,
          password: hashedPassword,
          role: 'ADMIN',
          phone: ownerPhone || null,
          clinicId: clinic.id,
        },
      });

      // Create subscription
      const subscription = await tx.subscription.create({
        data: {
          clinicId: clinic.id,
          planId: plan.id,
          status: 'ACTIVE',
          startDate: new Date(),
          priceAtPurchase: plan.priceMonthly,
          maxDoctors: plan.maxDoctors,
          maxBookingsPerPeriod: plan.maxBookingsPerMonth,
          durationDays: plan.durationDays,
          isTrial: plan.isTrial,
          trialDays: plan.trialDays,
        },
      });

      return { clinic, ownerUser, subscription };
    });

    // 4) Audit log
    try {
      await logAudit({
        userId: result.ownerUser.id,
        clinicId: result.clinic.id,
        action: 'CLINIC_REGISTER',
        entity: 'Clinic',
        entityId: result.clinic.id,
        details: {
          planId,
          clinicName,
          clinicPhone,
          ownerEmail,
        },
        req,
      });
    } catch (e) {
      console.error('Audit log failed for clinic register', e);
    }

    // 5) Generate JWT token
    const token = jwt.sign(
      {
        id: result.ownerUser.id,
        email: result.ownerUser.email,
        role: result.ownerUser.role,
        clinicId: result.clinic.id,
      },
      process.env.JWT_SECRET || 'your-secret-key',
      { expiresIn: '7d' }
    );

    // 6) Return response
    return res.status(201).json({
      message: 'Organization registered successfully',
      token,
      user: {
        id: result.ownerUser.id,
        name: result.ownerUser.name,
        email: result.ownerUser.email,
        role: result.ownerUser.role,
      },
      clinic: {
        id: result.clinic.id,
        name: result.clinic.name,
        phone: result.clinic.phone,
        slug: result.clinic.slug,
      },
      subscription: {
        id: result.subscription.id,
        status: result.subscription.status,
      },
    });
  } catch (err) {
    console.error('Register Organization Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
