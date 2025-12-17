// src/controllers/publicOrganizationController.js
import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import { logAudit } from '../utils/audit.js';

// Helper to generate clinic slug from name
const toSlug = (str) =>
  str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]/g, '-')   // non-alnum → dash
    .replace(/-+/g, '-')          // collapse ---
    .replace(/^-|-$/g, '');       // trim

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

// POST /api/public/organizations/register
export const registerOrganization = async (req, res) => {
  try {
    const {
      clinicName,
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

    if (!planId) {
      return res.status(400).json({ error: 'planId is required' });
    }
    if (!ownerPassword || ownerPassword.length < 6) {
      return res
        .status(400)
        .json({ error: 'Password must be at least 6 characters' });
    }

    // 1) Validate plan
    const plan = await prisma.plan.findFirst({
      where: { id: planId, isActive: true, deletedAt: null },
    });
    if (!plan) {
      return res
        .status(400)
        .json({ error: 'Selected plan is not available' });
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

      // Create clinic
      const clinic = await tx.clinic.create({
        data: {
          slug,
          name: clinicName,
          address: fullAddress || clinicName,
          city: city || '',
          pincode: pincode || '',
          accountNumber: 'N/A',
          ifscCode: 'N/A',
          bankName: 'N/A',
          timings: {}, // required Json field
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
          clinic: {
            connect: { id: clinic.id },
          },
        },
      });

      // Create subscription with snapshot of plan terms
      const subscription = await tx.subscription.create({
        data: {
          clinicId: clinic.id,
          planId: plan.id,
          status: 'ACTIVE',
          startDate: new Date(),

          // snapshot fields – make sure these exist on Subscription model
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

    // 4) Audit log (outside transaction; failures should not break response)
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
          ownerEmail,
        },
        req,
      });
    } catch (e) {
      console.error('Audit log failed for clinic register', e);
    }

    return res.status(201).json({
      message: 'Organization registered successfully',
      clinicId: result.clinic.id,
      ownerId: result.ownerUser.id,
      subscriptionId: result.subscription.id,
    });
  } catch (err) {
    console.error('Register Organization Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
