import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { logAudit } from '../utils/audit.js';

const toSlug = (str) =>
  str.toLowerCase().trim().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

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
      clinicName, clinicPhone,
      ownerName, ownerEmail, ownerPhone, ownerPassword,
      addressLine1, city, state, pincode,
      planId,
      // ✅ Added Bank Details
      bankName, accountNumber, ifscCode
    } = req.body;

    if (!clinicName || !clinicPhone || !planId || !ownerPassword) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const plan = await prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) return res.status(400).json({ error: 'Selected plan is not available' });

    const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (existingUser) return res.status(400).json({ error: 'Email already in use' });

    const result = await prisma.$transaction(async (tx) => {
      const slug = await generateUniqueClinicSlug(tx, clinicName);
      const fullAddress = [addressLine1, city, state, pincode].filter(Boolean).join(', ');

      // 1. Create Clinic (Now includes Bank Details)
      const clinic = await tx.clinic.create({
        data: {
          slug,
          name: clinicName,
          phone: clinicPhone,
          address: fullAddress || clinicName,
          city: city || '',
          pincode: pincode || '',
          // ✅ Save Bank Info
          bankName: bankName || 'N/A',
          accountNumber: accountNumber || 'N/A',
          ifscCode: ifscCode || 'N/A',
          timings: {},
          details: '',
          logo: null,
          banner: null,
        },
      });

      // 2. Create User (Linked to Clinic)
      const hashedPassword = await bcrypt.hash(ownerPassword, 10);
      const ownerUser = await tx.user.create({
        data: {
          name: ownerName,
          email: ownerEmail,
          password: hashedPassword,
          role: 'ADMIN', // Ensure this matches your Schema Enum
          phone: ownerPhone || null,
          clinicId: clinic.id, // ✅ User is directly linked to Clinic
        },
      });

      // ❌ REMOVED: tx.admin.create (This was causing your error)

      // 3. Create Subscription
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

    // 4. Audit Log
    try {
      await logAudit({
        userId: result.ownerUser.id,
        clinicId: result.clinic.id,
        action: 'CLINIC_REGISTER',
        entity: 'Clinic',
        entityId: result.clinic.id,
        details: { planId, clinicName, ownerEmail },
        req,
      });
    } catch (e) { console.error("Audit failed", e); }

    // 5. Generate Token
    const token = jwt.sign(
      {
        id: result.ownerUser.id,
        email: result.ownerUser.email,
        role: result.ownerUser.role,
        clinicId: result.clinic.id,
      },
      process.env.JWT_SECRET || 'secret',
      { expiresIn: '7d' }
    );

    return res.status(201).json({
      message: 'Registered successfully',
      token,
      user: result.ownerUser,
      clinic: result.clinic
    });

  } catch (err) {
    console.error('Register Error:', err);
    return res.status(500).json({ error: err.message });
  }
};
