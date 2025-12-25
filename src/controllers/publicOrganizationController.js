import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { logAudit } from '../utils/audit.js';
import { z } from 'zod'; 
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



// 2. Define Strict Validation Schema
const registerSchema = z.object({
  clinicName: z.string().min(3, "Clinic name must be at least 3 chars").max(100).trim(),
  clinicPhone: z.string().regex(/^[6-9]\d{9}$/, "Invalid India mobile number"),
  
  ownerName: z.string().min(2, "Owner name too short").max(50).trim(),
  ownerEmail: z.string().email("Invalid email address").toLowerCase().trim(),
  ownerPhone: z.string().regex(/^[6-9]\d{9}$/, "Invalid owner mobile number"),
  ownerPassword: z.string().min(6, "Password must be at least 6 characters"),

  addressLine1: z.string().min(5, "Address too short").max(200),
  city: z.string().min(2, "Invalid city"),
  state: z.string().min(2, "Invalid state"),
  pincode: z.string().regex(/^\d{6}$/, "Invalid 6-digit Pincode"),

  planId: z.string().min(1, "Plan ID is required"),

  // ✅ UPDATED: Bank Details are Strictly Optional
  // This pattern allows: Valid Data OR Empty String ("") OR Undefined/Null
  bankName: z.union([
    z.string().min(2, "Bank Name too short").max(50), 
    z.literal(""), 
    z.null()
  ]).optional(),

  accountNumber: z.union([
    z.string().regex(/^\d{9,18}$/, "Account number must be 9-18 digits"), 
    z.literal(""), 
    z.null()
  ]).optional(),

  ifscCode: z.union([
    z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Invalid IFSC Code format"), 
    z.literal(""), 
    z.null()
  ]).optional(),
});

export const registerOrganization = async (req, res) => {
  try {
    // 3. 🛡️ RUN VALIDATION
    const validatedData = registerSchema.parse(req.body);

    const {
      clinicName, clinicPhone,
      ownerName, ownerEmail, ownerPhone, ownerPassword,
      addressLine1, city, state, pincode,
      planId,
      bankName, accountNumber, ifscCode
    } = validatedData; 

    // 4. Check Plan Availability
    const plan = await prisma.plan.findFirst({ where: { id: planId, isActive: true } });
    if (!plan) return res.status(400).json({ error: 'Selected plan is not available' });

    // 5. Check Duplicate Email
    const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (existingUser) return res.status(400).json({ error: 'Email already in use' });

    const result = await prisma.$transaction(async (tx) => {
      // Ensure generateUniqueClinicSlug is imported or defined
      const slug = await generateUniqueClinicSlug(tx, clinicName);
      const fullAddress = addressLine1;


      // 1. Create Clinic
      const clinic = await tx.clinic.create({
        data: {
          slug,
          name: clinicName,
          phone: clinicPhone,
          address: fullAddress,
          city,
          pincode,
          // ✅ Save null if the string is empty
          bankName: bankName || null,
          accountNumber: accountNumber || null,
          ifscCode: ifscCode || null,
          timings: {},
          details: '',
        },
      });

      // 2. Create User
      const hashedPassword = await bcrypt.hash(ownerPassword, 10);
      const ownerUser = await tx.user.create({
        data: {
          name: ownerName,
          email: ownerEmail,
          password: hashedPassword,
          role: 'ADMIN', // This saves it to DB correctly
          phone: ownerPhone,
          clinicId: clinic.id,
        },
      });

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
      { expiresIn: '6h' }
    );

    return res.status(201).json({
      message: 'Registered successfully',
      token,
      // ✅ FIX: Include 'role' here so frontend knows where to redirect!
      user: { 
        id: result.ownerUser.id, 
        name: result.ownerUser.name, 
        email: result.ownerUser.email,
        role: result.ownerUser.role 
      },
      clinic: result.clinic
    });

  } catch (err) {
    // 6. Handle Validation Errors specifically
    if (err instanceof z.ZodError) {
      return res.status(400).json({ 
        error: "Validation failed", 
        details: err.errors.map(e => e.message) 
      });
    }

    console.error('Register Error:', err);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
