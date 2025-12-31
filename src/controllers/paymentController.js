// src/controllers/paymentController.js
import Stripe from 'stripe';
import Razorpay from 'razorpay';
import prisma from '../prisma.js';
import crypto from 'crypto'; // Standard import

// ----------------------------------------------------------------
// HELPER: Get active gateway for a clinic
// ----------------------------------------------------------------
const getActiveGateway = async (clinicId) => {
  return prisma.paymentGateway.findFirst({
    where: {
      clinicId,
      isActive: true,
      deletedAt: null,
    },
  });
};

// ----------------------------------------------------------------
// CREATE CHECKOUT SESSION (Used for Stripe Redirects)
// ----------------------------------------------------------------
export const createCheckoutSession = async (req, res) => {
  try {
    const { slotId, doctorId, userId } = req.body;

    // 1) Slot + doctor
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { doctor: true },
    });
    if (!slot) return res.status(404).json({ error: 'Slot not found' });

    // 2) Active gateway
    const gateway = await getActiveGateway(slot.clinicId);
    if (!gateway || !gateway.secret || !gateway.name) {
      return res.status(400).json({ error: 'Online payments not set up.' });
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const amountInPaise = Math.round(Number(slot.price) * 100);

    // 3A) STRIPE
    if (gateway.name === 'STRIPE') {
      const stripe = new Stripe(gateway.secret);
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [{
          price_data: {
            currency: 'inr',
            product_data: {
              name: `Appointment: Dr. ${slot.doctor.name}`,
              description: `${new Date(slot.date).toLocaleDateString()} | ${slot.time}`,
            },
            unit_amount: amountInPaise,
          },
          quantity: 1,
        }],
        mode: 'payment',
        metadata: {
          slotId,
          doctorId,
          userId,
          clinicId: slot.clinicId,
        },
        success_url: `${clientUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}&clinic_id=${slot.clinicId}`,
        cancel_url: `${clientUrl}/doctors/${doctorId}/book`,
      });

      return res.json({ provider: 'STRIPE', url: session.url });
    }

    // 3B) RAZORPAY
    if (gateway.name === 'RAZORPAY') {
      const razorpay = new Razorpay({ key_id: gateway.apiKey, key_secret: gateway.secret });
      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `slot_${slotId}_${Date.now()}`,
        notes: { slotId, doctorId, userId, clinicId: slot.clinicId },
      });

      return res.json({
        provider: 'RAZORPAY',
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId: gateway.apiKey,
        clinicName: slot.doctor?.clinicName || 'Clinic',
      });
    }

    return res.status(400).json({ error: `Unsupported gateway: ${gateway.name}` });
  } catch (err) {
    console.error('Checkout Error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};

// ---------------------------------------------------------------------
// VERIFY PAYMENT + BOOK/RESCHEDULE (Unified Logic)
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// MAIN VERIFICATION ENDPOINT
// ---------------------------------------------------------------------
// Ensure correct import

export const verifyPaymentAndBook = async (req, res) => {
  try {
    const { 
      razorpay_order_id, 
      razorpay_payment_id, 
      razorpay_signature, 
      appointmentId,
      notes 
    } = req.body;

    if (!appointmentId) return res.status(400).json({ error: 'Appointment ID required' });

    console.log('🔍 VERIFYING PAYMENT:', { 
      appointmentId, 
      type: notes?.type || 'NEW_BOOKING',
      amount: notes?.amount 
    });

    // 1. Fetch Appointment + Gateway
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { 
        slot: true,
        clinic: { include: { gateways: true } },
        doctor: true,
        user: true
      }
    });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    // 2. Gateway Lookup & Signature Verification
    const gateway = appointment.clinic.gateways.find(g => g.name === 'RAZORPAY' && g.isActive);
    if (!gateway?.secret) return res.status(400).json({ error: 'Gateway config missing' });

    const generated_signature = crypto
      .createHmac('sha256', gateway.secret)
      .update(razorpay_order_id + '|' + razorpay_payment_id)
      .digest('hex');

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ error: 'Invalid payment signature' });
    }

    // 3. DETERMINE IF RESCHEDULE OR NEW
    const isReschedule = notes?.type === 'RESCHEDULE' || notes?.type === 'OFFLINE_TO_ONLINE';

    // 🔥 4. UNIFIED TRANSACTION (Handles both cases safely)
    const result = await prisma.$transaction(async (tx) => {
      
      // A. Update Appointment Status
      const updatedAppt = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          status: "CONFIRMED",
          paymentStatus: "PAID",
          financialStatus: "PAID",
          paymentId: razorpay_payment_id,
          orderId: razorpay_order_id,
          adminNote: isReschedule 
            ? `Reschedule Paid: ${razorpay_payment_id}` 
            : `Booking Paid: ${razorpay_payment_id}`,
          updatedAt: new Date()
        },
        include: { slot: true, clinic: true, doctor: true, user: true }
      });

      // B. Update Slot Status
      // (For reschedule, the slotId is already updated in the reschedule step before this)
      if (updatedAppt.slotId) {
        await tx.slot.update({
          where: { id: updatedAppt.slotId },
          data: { 
            status: "CONFIRMED", 
            isBlocked: false, 
            isBooked: true 
          }
        });
      }

      // 🔥 C. SAFELY HANDLE PAYMENT RECORD (UPSERT)
      // This is the specific fix for your P2002 error.
      // It works for both new bookings (creates) and reschedules (updates).
      
      const paymentAmount = notes?.amount ? Number(notes.amount) : Number(appointment.amount);

      await tx.payment.upsert({
        where: { appointmentId: appointmentId }, 
        update: {
          // If payment row exists (Reschedule), update it
          amount: paymentAmount,
          gatewayRefId: razorpay_payment_id,
          status: "PAID",
          gatewayId: gateway.id,
          createdAt: new Date() // Refresh timestamp
        },
        create: {
          // If payment row missing (New Booking), create it
          appointmentId: appointmentId,
          clinicId: appointment.clinicId,
          doctorId: appointment.doctorId,
          gatewayId: gateway.id,
          amount: paymentAmount,
          status: "PAID",
          gatewayRefId: razorpay_payment_id
        }
      });

      return updatedAppt;
    });

    // 5. Send Email Notification
    sendBookingEmails({
      type: isReschedule ? "RESCHEDULE_CONFIRMED" : "CONFIRMED",
      id: result.id,
      clinic: result.clinic,
      doctor: result.doctor,
      slot: result.slot,
      user: result.user
    }).catch(err => console.error("Email failed:", err));

    return res.json({ 
      success: true, 
      message: isReschedule ? "Reschedule confirmed!" : "Booking confirmed!", 
      data: result 
    });

  } catch (error) {
    console.error('🚨 VERIFY ERROR:', error);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
};

// ---------------------------------------------------------------------
// SHARED RESCHEDULE HANDLER (Used by both verifyPayment & webhooks)
// ---------------------------------------------------------------------
async function handleRescheduleSuccess(res, metadata, paymentId, amountTotal, gatewayId) {
  const appointmentId = metadata.appointmentId;
  const newSlotId = metadata.slotId || metadata.rescheduleToSlot;

  if (!appointmentId || !newSlotId) {
    return res.status(400).json({ error: 'Missing appointmentId or newSlotId' });
  }

  console.log(`🔄 RESCHEDULE: ${appointmentId} → ${newSlotId}`);

  try {
    await prisma.$transaction(async (tx) => {
      const currentAppt = await tx.appointment.findUnique({ 
        where: { id: appointmentId },
        include: { clinic: { include: { gateways: true } }, doctor: true, user: true, slot: true }
      });
      
      if (!currentAppt) throw new Error(`Appointment not found: ${appointmentId}`);

      // Idempotency
      if (currentAppt.paymentId === paymentId || currentAppt.status === 'CONFIRMED') {
        return res.status(200).json({ success: true, message: 'Already processed' });
      }

      // Free OLD slot
      if (currentAppt.slotId && currentAppt.slotId !== newSlotId) {
        await tx.slot.update({
          where: { id: currentAppt.slotId },
          data: { isBooked: false, status: 'AVAILABLE', isBlocked: false }
        });
      }

      // Book NEW slot
      await tx.slot.update({
        where: { id: newSlotId },
        data: { isBooked: true, status: 'CONFIRMED', isBlocked: false }
      });

      // Update appointment
      const updatedAppt = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          slotId: newSlotId,
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          financialStatus: 'PAID',
          paymentId: paymentId,
          amount: Number(amountTotal) / 100,
          adminNote: `Rescheduled via payment (${paymentId})`,
          updatedAt: new Date()
        },
        include: { clinic: true, doctor: true, user: true, slot: true }
      });

      // Payment record (idempotent)
      const existingPayment = await tx.payment.findFirst({ where: { gatewayRefId: paymentId } });
      if (!existingPayment) {
        await tx.payment.create({
          data: {
            appointmentId: updatedAppt.id,
            clinicId: updatedAppt.clinicId,
            doctorId: updatedAppt.doctorId,
            gatewayId: gatewayId,
            amount: Number(amountTotal) / 100,
            status: 'PAID',
            gatewayRefId: paymentId,
          }
        });
      }

      // Email
      sendBookingEmails({
        type: "RESCHEDULE",
        id: updatedAppt.id,
        clinic: updatedAppt.clinic,
        doctor: updatedAppt.doctor,
        slot: updatedAppt.slot,
        oldSlot: { id: currentAppt.slotId },
        user: updatedAppt.user
      }).catch(console.error);
    });

    return res.status(200).json({ 
      success: true, 
      type: 'RESCHEDULE_PROCESSED',
      appointmentId 
    });

  } catch (error) {
    console.error('❌ RESCHEDULE FAILED:', error);
    return res.status(500).json({ error: 'Reschedule processing failed' });
  }
}
