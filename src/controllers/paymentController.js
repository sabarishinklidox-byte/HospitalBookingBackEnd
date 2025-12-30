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
export const verifyPaymentAndBook = async (req, res) => {
  try {
    const { provider, clinic_id } = req.body;

    if (!provider) return res.status(400).json({ error: 'provider is required' });
    if (!clinic_id) return res.status(400).json({ error: 'clinic_id is required' });

    const gateway = await getActiveGateway(clinic_id);
    if (!gateway || !gateway.secret) {
      return res.status(400).json({ error: 'Gateway config missing.' });
    }

    // ============================================================
    // 1. STRIPE FLOW
    // ============================================================
    if (provider === 'STRIPE') {
      const { session_id } = req.body;
      if (!session_id) return res.status(400).json({ error: 'session_id is required' });

      const stripe = new Stripe(gateway.secret);
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (session.payment_status !== 'paid') {
        return res.status(400).json({ error: 'Payment not completed.' });
      }

      const metadata = session.metadata || {};

      // ✅ DETECT RESCHEDULE
      if (metadata.type === 'RESCHEDULE') {
        return await handleRescheduleSuccess(res, metadata, session.payment_intent, session.amount_total, gateway.id);
      }

      // NORMAL BOOKING LOGIC
      const { slotId, doctorId, userId, clinicId } = metadata;
      if (!slotId) return res.status(400).json({ error: 'Missing metadata.' });

      // Idempotent check
      const existing = await prisma.appointment.findUnique({ where: { slotId } });
      if (existing) return res.json({ success: true, appointment: existing });

      // Create Booking
      const appointment = await prisma.$transaction(async (tx) => {
        await tx.slot.update({ where: { id: slotId }, data: { status: 'CONFIRMED', isBooked: true } });
        
        const appt = await tx.appointment.create({
          data: {
            userId, doctorId, clinicId, slotId, section: 'GENERAL', status: 'CONFIRMED', paymentId: session.payment_intent,
          },
        });

        await tx.payment.create({
          data: {
            appointmentId: appt.id, clinicId, doctorId, gatewayId: gateway.id, amount: Number(session.amount_total) / 100, status: 'PAID', gatewayRefId: session.payment_intent,
          },
        });
        return appt;
      });

      return res.json({ success: true, appointment });
    }

    // ============================================================
    // 2. RAZORPAY FLOW
    // ============================================================
    if (provider === 'RAZORPAY') {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature, notes } = req.body;

      // Verify Signature
      const hmac = crypto.createHmac('sha256', gateway.secret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

      if (hmac !== razorpay_signature) {
        return res.status(400).json({ error: 'Invalid payment signature.' });
      }

      // Fetch order details to get notes (metadata) if not provided in body
      let paymentMetadata = notes || {};
      if (!paymentMetadata.type && !paymentMetadata.slotId) {
         const razorpay = new Razorpay({ key_id: gateway.apiKey, key_secret: gateway.secret });
         const order = await razorpay.orders.fetch(razorpay_order_id);
         paymentMetadata = order.notes || {};
      }

      // ✅ DETECT RESCHEDULE
      if (paymentMetadata.type === 'RESCHEDULE') {
        // Amount is in paise, convert to rupees for storage
        const amountPaise = req.body.amount || 0; 
        return await handleRescheduleSuccess(res, paymentMetadata, razorpay_payment_id, amountPaise, gateway.id);
      }

      // NORMAL BOOKING LOGIC
      const { slotId, doctorId, userId } = paymentMetadata;
      if (!slotId) return res.status(400).json({ error: 'Missing metadata notes.' });

      // Ensure slot matches clinic
      const slot = await prisma.slot.findUnique({ where: { id: slotId } });
      if (!slot || slot.clinicId !== clinic_id) return res.status(404).json({ error: 'Slot/Clinic mismatch.' });

      // Idempotent check
      const existing = await prisma.appointment.findUnique({ where: { slotId } });
      if (existing) return res.json({ success: true, appointment: existing });

      // Create Booking
      const appointment = await prisma.$transaction(async (tx) => {
        await tx.slot.update({ where: { id: slotId }, data: { status: 'CONFIRMED', isBooked: true } });

        const appt = await tx.appointment.create({
          data: {
            userId, doctorId, clinicId: clinic_id, slotId, section: 'GENERAL', status: 'CONFIRMED', paymentId: razorpay_payment_id,
          },
        });

        await tx.payment.create({
          data: {
            appointmentId: appt.id, clinicId: clinic_id, doctorId, gatewayId: gateway.id, amount: Number(slot.price), status: 'PAID', gatewayRefId: razorpay_payment_id,
          },
        });
        return appt;
      });

      return res.json({ success: true, appointment });
    }

    return res.status(400).json({ error: `Unsupported provider: ${provider}` });

  } catch (err) {
    console.error('Verify Payment Error:', err);
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
};

// ----------------------------------------------------------------
// PRIVATE HELPER: Handle Reschedule Logic (Shared)
// ----------------------------------------------------------------
async function handleRescheduleSuccess(res, metadata, paymentId, amountTotal, gatewayId) {
    const appointmentId = metadata.appointmentId;
    const newSlotId = metadata.slotId || metadata.rescheduleToSlot;

    console.log(`🔄 Verifying Reschedule: Appt ${appointmentId} -> New Slot ${newSlotId}`);

    try {
        await prisma.$transaction(async (tx) => {
            // 1. Fetch current appointment to identify OLD slot
            const currentAppt = await tx.appointment.findUnique({ where: { id: appointmentId } });
            if (!currentAppt) throw new Error("Appointment not found");

            // 2. Free up OLD Slot
            if (currentAppt.slotId) {
                await tx.slot.update({
                    where: { id: currentAppt.slotId },
                    data: { isBooked: false, status: 'AVAILABLE' }
                });
            }

            // 3. Occupy NEW Slot
            await tx.slot.update({
                where: { id: newSlotId },
                data: { isBooked: true, status: 'CONFIRMED' }
            });

            // 4. Update Appointment
            const updated = await tx.appointment.update({
                where: { id: appointmentId },
                data: {
                    slotId: newSlotId,
                    status: 'CONFIRMED',
                    paymentStatus: 'PAID',
                    paymentId: paymentId,
                    amount: Number(amountTotal) / 100, // Convert paise to rupees
                    adminNote: 'Rescheduled via Online Payment',
                    updatedAt: new Date()
                }
            });

            // 5. Create Payment Record
            await tx.payment.create({
                data: {
                    appointmentId: updated.id,
                    clinicId: updated.clinicId,
                    doctorId: updated.doctorId,
                    gatewayId: gatewayId,
                    amount: Number(amountTotal) / 100,
                    status: 'PAID',
                    gatewayRefId: paymentId,
                }
            });
        });

        return res.json({ success: true, message: "Reschedule Confirmed" });

    } catch (error) {
        console.error("Reschedule Verification Failed:", error);
        return res.status(500).json({ error: "Database update failed during reschedule" });
    }
}
