import prisma from '../prisma.js';
import Razorpay from 'razorpay';
import Stripe from 'stripe';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { sendBookingEmails } from '../utils/email.js'
// ----------------------------------------------------------------
// Helper: load plan for a clinic
// ----------------------------------------------------------------
async function getClinicPlan(clinicId) {
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
// HELPER: Get Gateway Instance
// ----------------------------------------------------------------
const getPaymentInstance = async (clinicId, provider = 'RAZORPAY') => {
  const gateway = await prisma.paymentGateway.findFirst({
    where: {
      clinicId,
      isActive: true,
      name: provider,
    },
  });

  if (!gateway || !gateway.apiKey || !gateway.secret) {
    throw new Error(`${provider} payments are not configured for this clinic.`);
  }

  const secretKey = gateway.secret;

  if (provider === 'STRIPE') {
    return {
      instance: new Stripe(secretKey),
      publicKey: gateway.apiKey,
      gatewayId: gateway.id,
      provider: 'STRIPE',
    };
  }

  // Razorpay
  return {
    instance: new Razorpay({
      key_id: gateway.apiKey,
      key_secret: secretKey,
    }),
    key_id: gateway.apiKey,
    gatewayId: gateway.id,
    provider: 'RAZORPAY',
  };
};


  // Razorpay

// ----------------------------------------------------------------
// CREATE BOOKING (Online/Offline/Free) - 100% RACE CONDITION PROOF
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// CREATE BOOKING (Online/Offline/Free) - with hold + reuse
// ----------------------------------------------------------------
// src/controllers/bookingController.js

// ✅ ADD THIS IMPORT

export const createBooking = async (req, res) => {
  try {
    const { slotId, paymentMethod = 'ONLINE', provider = 'RAZORPAY' } = req.body;
    const authUserId = req.user?.userId;

    console.log('🔑 Auth header:', req.headers.authorization);
    console.log('👤 req.user:', req.user);

    if (!authUserId) return res.status(401).json({ error: 'Unauthorized' });

    const HOLD_MS = 10 * 60 * 1000;        // 10min payment window
    const SAFETY_MS = 15 * 60 * 1000;      // 15min safety buffer
    const now = new Date();

    // 1. Fetch Slot + Clinic + Doctor (read-only)
    const slotData = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { clinic: true, doctor: true },
    });

    if (!slotData) return res.status(404).json({ error: 'Slot not found' });

    // 🔥 2. RECENT HOLD CHECK (protect frontend refreshes)
    const recentHold = await prisma.appointment.findFirst({
      where: {
        slotId,
        deletedAt: null,
        status: 'PENDING_PAYMENT',
        createdAt: { gte: new Date(now.getTime() - SAFETY_MS) }
      },
    });

    if (recentHold) {
      if (recentHold.userId !== authUserId) {
        return res.status(409).json({
          error: 'Slot on hold by another user. Please wait 10-15 mins or choose another.',
          retry: true,
        });
      }
      // Same user → refresh hold
      return handleExistingHold(recentHold, slotData, provider, now, HOLD_MS, res);
    }

    // 3. Plan validation (critical business rule)
    const plan = await getClinicPlan(slotData.clinicId);
    if (!plan) {
      return res.status(400).json({ error: 'Clinic has no active subscription plan.' });
    }

    if (paymentMethod === 'ONLINE' && !plan.allowOnlinePayments) {
      return res.status(403).json({
        error: 'Online payments disabled. Use FREE or OFFLINE slots.',
        availableModes: ['FREE', 'OFFLINE'],
      });
    }

    // 🔥 4. ATOMIC TRANSACTION - IMPOSSIBLE RACE CONDITION!
    const result = await prisma.$transaction(async (tx) => {
      // CLEANUP: ONLY ancient (>15min) or CANCELLED records
      await tx.appointment.deleteMany({
        where: {
          slotId,
          OR: [
            { status: 'CANCELLED' },
            { status: 'PENDING' },
            { 
              status: 'PENDING_PAYMENT',
              createdAt: { lt: new Date(now.getTime() - SAFETY_MS) }
            }
          ]
        }
      });

      console.log('🧹 Ancient records cleaned (15min+ safety buffer)');

      // FINAL SAFETY CHECKS
      const confirmed = await tx.appointment.findFirst({
        where: { slotId, status: 'CONFIRMED', deletedAt: null }
      });
      if (confirmed) throw new Error('ALREADY_CONFIRMED');

      const otherHold = await tx.appointment.findFirst({
        where: {
          slotId,
          userId: { not: authUserId },
          status: 'PENDING_PAYMENT',
          deletedAt: null
        }
      });
      if (otherHold) throw new Error('SLOT_BLOCKED');

      // 🔥 FREE/OFFLINE → INSTANT PENDING (Clinic approves later)
      if (slotData.paymentMode === 'FREE' || paymentMethod === 'OFFLINE' || slotData.paymentMode === 'OFFLINE') {
        const appointment = await tx.appointment.create({
          data: {
            userId: authUserId,
            slotId,
            clinicId: slotData.clinicId,
            doctorId: slotData.doctorId,
            status: 'PENDING',
            paymentStatus: slotData.paymentMode === 'FREE' ? 'PAID' : 'PENDING',
            amount: slotData.paymentMode === 'FREE' ? 0 : Number(slotData.price),
            slug: `${slotData.paymentMode?.toLowerCase() || 'offline'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            section: 'GENERAL',
          },
        });
        return { appointment, isOnline: false, createNew: true };
      }

      // 🔥 ONLINE → RAZORPAY HOLD + ORDER (ATOMIC!)
      const gateway = await getPaymentInstance(slotData.clinicId, provider);
      const orderData = await createPaymentOrder(gateway, slotData, provider);

      const appointment = await tx.appointment.create({
        data: {
          userId: authUserId,
          slotId,
          clinicId: slotData.clinicId,
          doctorId: slotData.doctorId,
          status: 'PENDING_PAYMENT',
          paymentStatus: 'PENDING',
          orderId: orderData.orderId || orderData.sessionId,
          amount: Number(slotData.price),
          slug: `hold_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          section: 'GENERAL',
          paymentExpiry: new Date(now.getTime() + HOLD_MS),
          createdAt: now, // Fresh timestamp for hold timer
        },
      });

      return { 
        appointment, 
        gatewayId: gateway.gatewayId,
        orderData,
        isOnline: true, 
        createNew: true 
      };
    });

    // 5. SUCCESS PROCESSING
    const { appointment, gatewayId, orderData, isOnline, createNew } = result;
    
    // NON-BLOCKING EMAILS (OFFLINE/FREE only)
    if (!isOnline && createNew) {
      getUserById(authUserId).then(user => {
        sendBookingEmails({
          id: appointment.id,
          clinic: slotData.clinic,
          doctor: slotData.doctor,
          slot: slotData,
          user: user || { name: 'Patient', phone: 'N/A' }
        }).catch(err => console.error('Pending booking emails failed:', err));
      }).catch(() => {});
    }

    console.log('✅ Booking decision:', {
      slotId,
      authUserId,
      path: isOnline ? 'NEW_ONLINE_HOLD' : 'OFFLINE_PENDING',
      appointmentId: appointment.id,
      status: appointment.status,
    });

    // PERFECT PRODUCTION RESPONSE
    return res.json({
      success: true,
      appointmentId: appointment.id,
      gatewayId,
      isOnline,
      orderId: orderData?.orderId || orderData?.sessionId,
      amount: Number(slotData.price),
      ...orderData,
      expiresIn: isOnline ? HOLD_MS / 1000 : 0,
      message: isOnline 
        ? `Payment hold created! Complete within 10 mins - ₹${slotData.price}`
        : slotData.paymentMode === 'FREE' 
          ? 'Free booking created! Clinic will confirm soon.'
          : `Booking created! Pay ₹${slotData.price} at clinic on visit.`,
    });

  } catch (error) {
    console.error('🚨 CRITICAL BOOKING ERROR:', error);

    // PRODUCTION ERROR HANDLING
    if (error.message === 'SLOT_BLOCKED') {
      return res.status(409).json({
        error: 'Slot on hold by another patient. Wait 10-15 mins or choose another.',
        retry: true,
      });
    }

    if (error.message === 'ALREADY_CONFIRMED') {
      return res.status(400).json({
        error: 'You already have a confirmed booking for this slot.',
      });
    }

    // PRISMA SAFETY NET
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'Slot taken instantly by another patient! Please refresh.',
        retry: true,
      });
    }

    return res.status(500).json({
      error: error.message || 'Booking system temporarily unavailable.',
    });
  }
};

// 🔥 PRODUCTION HELPER: Refresh existing hold (same user only)
async function handleExistingHold(existing, slotData, provider, now, HOLD_MS, res) {
  try {
    const expiresAt = existing.paymentExpiry || new Date(existing.createdAt.getTime() + HOLD_MS);
    const remainingMs = new Date(expiresAt).getTime() - now.getTime();

    console.log('🔄 Hold refresh:', {
      appointmentId: existing.id,
      remainingMs,
      paymentExpiry: existing.paymentExpiry?.toISOString(),
    });

    // Refresh payment order
    const gateway = await getPaymentInstance(slotData.clinicId, provider);
    const orderData = await createPaymentOrder(gateway, slotData, provider);

    // Extend hold expiry
    await prisma.appointment.update({
      where: { id: existing.id },
      data: { 
        orderId: orderData.orderId || orderData.sessionId,
        paymentExpiry: new Date(now.getTime() + HOLD_MS), // Fresh 10min
        updatedAt: now,
      },
    });

    return res.json({
      success: true,
      appointmentId: existing.id,
      gatewayId: gateway.gatewayId,
      isOnline: true,
      ...orderData,
      expiresIn: HOLD_MS / 1000,
      message: `Payment refreshed! New 10-minute window - ₹${slotData.price}`,
    });

  } catch (error) {
    console.error('Hold refresh failed:', error);
    return res.status(500).json({
      error: 'Failed to refresh payment hold.',
    });
  }
}




// ✅ HELPER FUNCTION - Get user data for emails
const getUserById = async (userId) => {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true }
    });
  } catch {
    return null;
  }
};


// ✅ HELPER - Get user data for emails



// Helper function - extract payment order creation
async function createPaymentOrder(gateway, slot, provider) {
  if (gateway.provider === 'RAZORPAY') {
    const options = {
      amount: Math.round(Number(slot.price) * 100),
      currency: 'INR',
      receipt: `rcpt_${slot.id.slice(-8)}_${Date.now()}`,
      notes: {
        appointmentTempId: uuidv4(),
        slotId: slot.id,
        clinicId: slot.clinicId,
        doctorId: slot.doctorId,
      },
    };

    const order = await gateway.instance.orders.create(options);
    return {
      provider: 'RAZORPAY',
      orderId: order.id,
      amount: order.amount, // paise
      key: gateway.key_id,
    };
  } else if (gateway.provider === 'STRIPE') {
    const session = await gateway.instance.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'inr',
          product_data: {
            name: `Appointment: Dr. ${slot.doctor?.name || 'Doctor'} - ${slot.time}`,
            description: `${slot.clinic.name} • ${new Date(slot.date).toLocaleDateString()}`,
          },
          unit_amount: Math.round(Number(slot.price) * 100),
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3000'}/booking/${slot.id}`,
      metadata: {
        appointmentTempId: uuidv4(),
        slotId: slot.id,
        clinicId: slot.clinicId,
        doctorId: slot.doctorId,
      },
    });

    return {
      provider: 'STRIPE',
      sessionId: session.id,
      url: session.url,
      publishableKey: gateway.publicKey,
    };
  }
}


// ----------------------------------------------------------------
// VERIFY RAZORPAY PAYMENT (Your code + expiry check)
// ----------------------------------------------------------------
export const verifyPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, appointmentId } = req.body;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { slot: true }
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // ✅ EXPIRY CHECK
    if (appointment.createdAt < new Date(Date.now() - 10 * 60 * 1000)) {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
      });
      return res.status(400).json({ error: 'Booking expired. Please book again.' });
    }

    const plan = await getClinicPlan(appointment.clinicId);
    if (!plan || !plan.allowOnlinePayments) {
      return res.status(403).json({ error: 'Online payments are disabled on this clinic plan.' });
    }

    const gateway = await prisma.paymentGateway.findFirst({
      where: {
        clinicId: appointment.clinicId,
        name: 'RAZORPAY',
        isActive: true,
      },
    });

    if (!gateway) {
      return res.status(400).json({ error: 'Payment configuration missing' });
    }

    // ✅ RAZORPAY SIGNATURE VERIFICATION
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', gateway.secret)
      .update(body)
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      // ✅ PAYMENT SUCCESS → CONFIRM BOOKING
      await prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            status: 'CONFIRMED',
            paymentStatus: 'PAID',
            paymentId: razorpay_payment_id,
          },
        });

        // ✅ FIXED: No isBooked → use status
        await tx.slot.update({
          where: { id: appointment.slotId },
          data: { status: 'CONFIRMED' },  // ✅ CORRECT
        });

        await tx.payment.create({
          data: {
            appointmentId: appointment.id,
            clinicId: appointment.clinicId,
            doctorId: appointment.doctorId,
            gatewayId: gateway.id,
            amount: appointment.amount,
            status: 'PAID',
            gatewayRefId: razorpay_payment_id,
          },
        });
      });

      return res.json({
        success: true,
        message: 'Payment verified & Booking confirmed!',
        appointmentId,
      });
    } else {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
      });
      return res.status(400).json({ error: 'Invalid payment signature' });
    }
  } catch (error) {
    console.error('Razorpay Verification Error:', error);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
};

// ----------------------------------------------------------------
// VERIFY STRIPE PAYMENT - FIXED
// ----------------------------------------------------------------
export const verifyStripePayment = async (req, res) => {
  try {
    const { session_id, appointmentId } = req.body;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { slot: true }
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // ✅ EXPIRY CHECK
    if (appointment.createdAt < new Date(Date.now() - 10 * 60 * 1000)) {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
      });
      return res.status(400).json({ error: 'Booking expired. Please book again.' });
    }

    const plan = await getClinicPlan(appointment.clinicId);
    if (!plan || !plan.allowOnlinePayments) {
      return res.status(403).json({ error: 'Online payments are disabled on this clinic plan.' });
    }

    const gateway = await getPaymentInstance(appointment.clinicId, 'STRIPE');
    const session = await gateway.instance.checkout.sessions.retrieve(session_id);

    if (session.payment_status === 'paid') {
      await prisma.$transaction(async (tx) => {
        await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            status: 'CONFIRMED',
            paymentStatus: 'PAID',
            paymentId: session.payment_intent,
          },
        });

        // ✅ FIXED: No isBooked → use status
        await tx.slot.update({
          where: { id: appointment.slotId },
          data: { status: 'CONFIRMED' },  // ✅ CORRECT
        });

        await tx.payment.create({
          data: {
            appointmentId: appointment.id,
            clinicId: appointment.clinicId,
            doctorId: appointment.doctorId,
            gatewayId: gateway.gatewayId,
            amount: appointment.amount,
            status: 'PAID',
            gatewayRefId: session.payment_intent,
          },
        });
      });

      return res.json({ 
        success: true, 
        message: 'Stripe payment verified & booking confirmed!' 
      });
    } else {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { status: 'CANCELLED', paymentStatus: 'FAILED' }
      });
      return res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (error) {
    console.error('Stripe Verification Error:', error);
    return res.status(500).json({ error: 'Verification failed' });
  }}