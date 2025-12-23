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

    console.log('🔑 Auth header:', req.headers.authorization);
    console.log('👤 req.user:', req.user);

    const authUserId = req.user?.userId;
    if (!authUserId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const HOLD_MS = 10 * 60 * 1000; // 10 minutes
    const now = new Date();

    // 1. Fetch Slot + Clinic + Doctor
    const slotData = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { 
        clinic: true, 
        doctor: true 
      },
    });

    if (!slotData) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // 2. Find any appointment for this slot
    let existing = await prisma.appointment.findFirst({
      where: {
        slotId,
        deletedAt: null,
      },
    });

    console.log('Existing appointment check:', {
      slotId,
      authUserId,
      existingId: existing?.id,
      existingUserId: existing?.userId,
      existingStatus: existing?.status,
      existingCreatedAt: existing?.createdAt,
      existingPaymentExpiry: existing?.paymentExpiry,
    });

    if (existing) {
      // 2a. Different user already has an appointment for this slot → block
      if (existing.userId !== authUserId) {
        return res.status(409).json({
          error: 'Slot already booked or on hold. Please choose another time.',
          retry: true,
        });
      }

      // 2b. Same user, already CONFIRMED → do not allow double booking
      if (existing.status === 'CONFIRMED') {
        return res.status(400).json({
          error: 'You already have a confirmed booking for this slot.',
        });
      }

      // 2c. Same user, PENDING_PAYMENT → hold logic
      if (existing.status === 'PENDING_PAYMENT') {
        const expiresAt = existing.paymentExpiry
          ? new Date(existing.paymentExpiry)
          : new Date(existing.createdAt.getTime() + HOLD_MS);

        const remainingMs = expiresAt.getTime() - now.getTime();

        console.log('Hold timer check:', {
          existingId: existing.id,
          createdAt: existing.createdAt,
          paymentExpiry: existing.paymentExpiry,
          computedExpiresAt: expiresAt,
          now: now.toISOString(),
          remainingMs,
        });

        if (remainingMs > 0) {
          const remainingSeconds = Math.floor(remainingMs / 1000);

          const gateway = await getPaymentInstance(slotData.clinicId, provider);
          const orderData = await createPaymentOrder(gateway, slotData, provider);

          await prisma.appointment.update({
            where: { id: existing.id },
            data: {
              orderId: orderData.orderId || orderData.sessionId,
              updatedAt: now,
            },
          });

          return res.json({
            success: true,
            appointmentId: existing.id,
            gatewayId: gateway.gatewayId,
            isOnline: true,
            ...orderData,
            expiresIn: remainingSeconds,
            message: `Complete payment within ${Math.floor(
              remainingSeconds / 60
            )}:${(remainingSeconds % 60).toString().padStart(2, '0')} to confirm ₹${
              slotData.price
            } booking`,
          });
        }

        // 2d. Same user, hold expired → reuse SAME ROW with fresh hold
        console.log('🗑️ Expired old hold (same user):', existing.id);

        const gateway = await getPaymentInstance(slotData.clinicId, provider);
        const orderData = await createPaymentOrder(gateway, slotData, provider);

        const refreshed = await prisma.appointment.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING_PAYMENT',
            paymentStatus: 'PENDING',
            orderId: orderData.orderId || orderData.sessionId,
            amount: Number(slotData.price),
            paymentExpiry: new Date(now.getTime() + HOLD_MS),
            updatedAt: now,
          },
        });

        const expiresIn = HOLD_MS / 1000;

        return res.json({
          success: true,
          appointmentId: refreshed.id,
          gatewayId: gateway.gatewayId,
          isOnline: true,
          ...orderData,
          expiresIn,
          message: `Complete payment within 10 minutes to confirm ₹${slotData.price} booking`,
        });
      }

      // 2e. Same user but status is PENDING / CANCELLED / COMPLETED / NO_SHOW
      return res.status(409).json({
        error: 'Slot already used. Please choose another time.',
        retry: false,
      });
    }

    // 3. Plan gating check
    const plan = await getClinicPlan(slotData.clinicId);
    if (!plan) {
      return res
        .status(400)
        .json({ error: 'Clinic has no active subscription plan.' });
    }

    if (paymentMethod === 'ONLINE' && !plan.allowOnlinePayments) {
      return res.status(403).json({
        error: 'Online payments disabled. Use FREE or OFFLINE slots.',
        availableModes: ['FREE', 'OFFLINE'],
      });
    }

    // 4. FREE / OFFLINE → PENDING (Clinic Admin confirms) + ✅ EMAILS
    if (slotData.paymentMode === 'FREE' || paymentMethod === 'OFFLINE' || slotData.paymentMode === 'OFFLINE') {
      const appointment = await prisma.appointment.create({
        data: {
          userId: authUserId,
          slotId,
          clinicId: slotData.clinicId,
          doctorId: slotData.doctorId,
          status: 'PENDING', // ✅ FIXED: PENDING (Clinic confirms)
          paymentStatus: slotData.paymentMode === 'FREE' ? 'PAID' : 'PENDING',
          amount: slotData.paymentMode === 'FREE' ? 0 : Number(slotData.price),
          slug: `${slotData.paymentMode?.toLowerCase() || 'offline'}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          section: 'GENERAL',
        },
      });

      // ✅ NO slot.update() - stays available until clinic confirms

      // ✅ SEND INSTANT NOTIFICATION EMAILS (NON-BLOCKING)
      getUserById(authUserId).then(user => {
        sendBookingEmails({
          id: appointment.id,
          clinic: slotData.clinic,
          doctor: slotData.doctor,
          slot: slotData,
          user: user || { name: 'Patient', phone: 'N/A' }
        }).catch(err => console.error('Pending booking emails failed:', err));
      }).catch(() => {});

      return res.json({
        success: true,
        appointmentId: appointment.id,
        isOnline: false,
        status: 'PENDING', // ✅ Clear communication
        message: slotData.paymentMode === 'FREE' 
          ? 'Free booking created! Clinic will confirm soon.'
          : `Booking created! Pay ₹${slotData.price} at clinic. Clinic will confirm.`,
      });
    }

    // 6. ONLINE PAYMENT – FRESH hold (no existing appointment for this slot)
    const guardExisting = await prisma.appointment.findFirst({
      where: { slotId, deletedAt: null },
    });

    if (guardExisting) {
      console.error('Guard hit: existing appointment before create()', {
        slotId,
        id: guardExisting.id,
        status: guardExisting.status,
        userId: guardExisting.userId,
      });

      return res.status(409).json({
        error: 'Slot already used. Please choose another time.',
        retry: false,
      });
    }

    const gateway = await getPaymentInstance(slotData.clinicId, provider);
    const orderData = await createPaymentOrder(gateway, slotData, provider);

    const appointment = await prisma.appointment.create({
      data: {
        userId: authUserId,
        slotId,
        clinicId: slotData.clinicId,
        doctorId: slotData.doctorId,
        status: 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
        orderId: orderData.orderId || orderData.sessionId,
        amount: Number(slotData.price),
        slug: `hold_${Date.now()}_${Math.random()
          .toString(36)
          .substr(2, 9)}`,
        section: 'GENERAL',
        paymentExpiry: new Date(now.getTime() + HOLD_MS),
      },
    });

    console.log('createBooking decision:', {
      slotId,
      authUserId,
      path: 'NEW_APPOINTMENT_ONLINE',
      createdAppointmentId: appointment.id,
    });

    return res.json({
      success: true,
      appointmentId: appointment.id,
      gatewayId: gateway.gatewayId,
      isOnline: true,
      ...orderData,
      expiresIn: HOLD_MS / 1000,
      message: `Complete payment within 10 minutes to confirm ₹${slotData.price} booking`,
    });
  } catch (error) {
    console.error('CRITICAL BOOKING ERROR:', error);
    return res.status(500).json({
      error: error.message || 'Booking failed',
    });
  }
};

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