// controllers/publicOrganizationController.js
import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import Razorpay from 'razorpay';
import { logAudit } from '../utils/audit.js';
import { z } from 'zod';
import crypto from 'crypto';

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
  bankName: z.string().optional().or(z.literal('')),
  accountNumber: z.string().optional().or(z.literal('')),
  ifscCode: z.string().optional().or(z.literal('')),
});

export const registerOrganization = async (req, res) => {
  try {
    const validatedData = registerSchema.parse(req.body);
    const {
      clinicName, clinicPhone, ownerName, ownerEmail, ownerPhone, ownerPassword,
      addressLine1, city, state, pincode, planId, bankName, accountNumber, ifscCode
    } = validatedData;

    // 1. Validate Plan
    const plan = await prisma.plan.findFirst({ 
      where: { id: planId, isActive: true, deletedAt: null } 
    });
    if (!plan) return res.status(400).json({ error: 'Selected plan unavailable' });

    // 2. Duplicate Check
    const existingUser = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (existingUser) return res.status(400).json({ error: 'Email already registered' });

    // 3. Free vs Paid Logic
    const isFreePlan = plan.isTrial || plan.priceMonthly === 0 || plan.trialDays > 0;
    let razorpayCustomerId = null;
    let razorpayPaymentData = null;

    // 🔥 PAID PLAN: Create CUSTOMER FIRST (Fixes UPI name validation)
    if (!isFreePlan) {
      const razorpayConfig = await prisma.superAdminPaymentGateway.findFirst({
        where: { name: "RAZORPAY", isActive: true }
      });
      if (!razorpayConfig) return res.status(400).json({ error: 'Payments not configured' });

      const razorpay = new Razorpay({
        key_id: razorpayConfig.apiKey,
        key_secret: razorpayConfig.secret,
      });

      // 🛡️ ULTRA-STRICT NAME SANITIZER for UPI TPV
      const cleanName = ownerName
        .trim()
        .replace(/\s+/g, ' ')
        .replace(/[^\p{L}\s.'@()\/]/gu, '')  // Unicode letters + safe chars
        .replace(/^[.\s]+|[.\s]+$/g, '')
        .slice(3, 50);
      
      if (cleanName.length < 3) {
        return res.status(400).json({ error: 'Name too short after sanitization' });
      }

      console.log('🧼 Name sanitized:', ownerName, '→', cleanName);

      // 1️⃣ CREATE CUSTOMER (Bypasses UPI name validation)
      const customer = await razorpay.customers.create({
        name: cleanName,
        email: ownerEmail,
        contact: ownerPhone,
        notes: { 
          planId, 
          clinicName: clinicName.slice(0, 100),
          type: 'REGISTRATION'
        }
      });
      razorpayCustomerId = customer.id;

      // 2️⃣ CREATE ORDER linked to customer
      const planPrice = parseFloat(plan.priceMonthly) || 0;
      const amountInPaise = Math.round(planPrice * 100);
      console.log('🪙 Amount:', planPrice, '→', amountInPaise, 'Customer:', customer.id);

      const receipt = `reg_${ownerEmail.replace(/[^\w]/g, '').slice(0, 15)}_${Date.now().toString(36)}`;
      
      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt,
        customer_id: customer.id,  // ✅ UPI TPV safe
        notes: { ownerEmail, planId, type: 'REGISTRATION' }
      });

      razorpayPaymentData = {
        razorpayOrderId: order.id,
        razorpayCustomerId: customer.id,  // ✅ Frontend gets this
        amount: order.amount,
        currency: order.currency,
        key: razorpayConfig.apiKey
      };
    }

    // 4. Atomic Transaction (unchanged)
    const result = await prisma.$transaction(async (tx) => {
      const slug = await generateUniqueClinicSlug(tx, clinicName);
      const fullAddress = `${addressLine1}, ${city}, ${state} - ${pincode}`;

      const clinic = await tx.clinic.create({
        data: {
          slug, name: clinicName, phone: clinicPhone,
          address: fullAddress,
          city, pincode,
          bankName: bankName || null,
          accountNumber: accountNumber || null,
          ifscCode: ifscCode || null,
          isActive: true,
          timings: {},
          details: ''
        }
      });

      const hashedPassword = await bcrypt.hash(ownerPassword, 10);
      const ownerUser = await tx.user.create({
        data: {
          name: ownerName, email: ownerEmail, password: hashedPassword,
          role: 'ADMIN', phone: ownerPhone, clinicId: clinic.id
        }
      });

      const subscription = await tx.subscription.create({
        data: {
          clinicId: clinic.id,
          planId: plan.id,
          status: isFreePlan ? 'ACTIVE' : 'TRIAL',
          razorpayOrderId: razorpayPaymentData?.razorpayOrderId || null,
          razorpayCustomerId: razorpayCustomerId || null,  // ✅ Store for tracking
          startDate: new Date(),
          priceAtPurchase: plan.priceMonthly,
          maxDoctors: plan.maxDoctors,
          maxBookingsPerPeriod: plan.maxBookingsPerMonth,
          isTrial: plan.isTrial,
          durationDays: plan.durationDays,
          trialDays: plan.trialDays,
        },
        include: { plan: true }
      });

      return { clinic, ownerUser, subscription };
    });

    // 5. Audit (unchanged)
    try {
      await logAudit({
        userId: result.ownerUser.id,
        clinicId: result.clinic.id,
        action: 'CLINIC_REGISTRATION',
        entity: 'Clinic',
        entityId: result.clinic.id,
        details: {
          planName: result.subscription.plan.name,
          isFreePlan,
          razorpayOrderId: razorpayPaymentData?.razorpayOrderId,
          razorpayCustomerId,
          ownerEmail
        },
        req
      });
    } catch (auditErr) {
      console.error('⚠️ Audit failed:', auditErr.message);
    }

    // 6. JWT + Response
    const token = jwt.sign({
      id: result.ownerUser.id,
      email: result.ownerUser.email,
      role: result.ownerUser.role,
      clinicId: result.clinic.id
    }, process.env.JWT_SECRET, { expiresIn: '6h' });

    const response = {
      success: true,
      message: 'Clinic registered successfully!',
      token,
      user: {
        id: result.ownerUser.id,
        name: result.ownerUser.name,
        email: result.ownerUser.email,
        role: result.ownerUser.role
      },
      clinic: result.clinic,
      subscription: result.subscription
    };

    // 🔥 Attach payment data with CUSTOMER_ID
    if (razorpayPaymentData) {
      response.requiresPayment = true;
      response.payment = razorpayPaymentData;  // Now includes customerId
      response.plan = plan;
    } else {
      response.requiresPayment = false;
      response.message += ' Plan activated!';
    }

    res.status(201).json(response);

  } catch (err) {
    if (err.name === 'ZodError') {
      const errorList = err.errors || err.issues || [];
      return res.status(400).json({
        error: "Validation failed",
        details: errorList.map(e => {
          const path = Array.isArray(e.path) ? e.path.join('.') : (e.path || 'field');
          return `${path}: ${e.message}`;
        })
      });
    }
    console.error('Registration Error:', err);
    res.status(500).json({ error: 'Server error during registration' });
  }
};

// controllers/publicOrganizationController.js


export const verifyRegistrationPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    
    console.log('🔍 Verify called:', { razorpay_order_id, razorpay_payment_id }); 
    
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing payment details' });
    }

    const subscription = await prisma.subscription.findUnique({
      where: { razorpayOrderId: razorpay_order_id },
      include: { 
        plan: true,
        clinic: true 
      }
    });

    if (!subscription) {
      console.log('❌ Subscription not found for order:', razorpay_order_id);
      return res.status(404).json({ error: 'Subscription order not found' });
    }

    // Idempotency check
    if (subscription.status === 'ACTIVE') {
      return res.json({ 
        success: true, 
        message: 'Already activated',
        endDate: subscription.endDate?.toISOString()
      });
    }

    const razorpayConfig = await prisma.superAdminPaymentGateway.findFirst({
      where: { name: 'RAZORPAY', isActive: true }
    });

    if (!razorpayConfig?.secret) {
      return res.status(500).json({ error: 'Razorpay not configured' });
    }

    // Signature Verification
    const secret = razorpayConfig.secret;
    const shasum = crypto.createHmac('sha256', secret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (shasum !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid signature' });
    }

    // --- CALCULATIONS FOR TIMER ---
    const now = new Date();
    // Get duration from plan (This is what was missing in the DB save)
    const durationDays = subscription.plan.durationDays || subscription.plan.trialDays || 30;
    const endDate = new Date(now.getTime() + durationDays * 86400000);

    // Update everything in a single transaction
    await prisma.$transaction(async (tx) => {
      const updatedSub = await tx.subscription.update({
        where: { id: subscription.id },
        data: { 
          status: 'ACTIVE', 
          razorpayOrderId: null, // Clear order ID as it's completed
          razorpayPaymentId: razorpay_payment_id,
          startDate: now,
          endDate: endDate,
          
          // 🔥 CRITICAL: Save durationDays so frontend BillingPage.jsx "if" condition passes
          durationDays: durationDays, 
          
          // Sync Plan Limits to Subscription
          maxDoctors: subscription.plan.maxDoctors,
          maxBookingsPerPeriod: subscription.plan.maxBookingsPerMonth,
          priceAtPurchase: subscription.plan.priceMonthly,
          isTrial: subscription.plan.isTrial
        }
      });

      // Log the payment in your new registrationPayments table
      await tx.registrationPayment.create({
        data: {
          clinicId: subscription.clinicId,
          subscriptionId: updatedSub.id,
          amount: subscription.plan.priceMonthly,
          currency: 'INR',
          status: 'SUCCESS',
          razorpayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id
        }
      });
    });

    console.log('🎉 Subscription activated and Timer synced:', subscription.id);

    res.json({ 
      success: true, 
      message: 'Clinic activated!',
      subscription: {
        id: subscription.id,
        status: 'ACTIVE',
        startDate: now.toISOString(),
        endDate: endDate.toISOString(),
        durationDays: durationDays // Return this so frontend state updates immediately
      }
    });

  } catch (error) {
    console.error('💥 VerifyRegistrationPayment ERROR:', error);
    res.status(500).json({ error: 'Verification failed', details: error.message });
  }
};
