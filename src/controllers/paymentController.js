// src/controllers/paymentController.js
import Stripe from 'stripe';
import Razorpay from 'razorpay';
import prisma from '../prisma.js';

// Helpers to get active gateway

// Helper to get active gateway for a clinic
const getActiveGateway = async (clinicId) => {
  return prisma.paymentGateway.findFirst({
    where: {
      clinicId,
      isActive: true,
      deletedAt: null,
    },
  });
};

export const createCheckoutSession = async (req, res) => {
  try {
    const { slotId, doctorId, userId } = req.body;

    // 1) Slot + doctor
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { doctor: true },
    });
    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // 2) Active gateway from DB (uses secret stored in PaymentGateway)
    const gateway = await getActiveGateway(slot.clinicId);
    if (!gateway || !gateway.secret || !gateway.name) {
      return res
        .status(400)
        .json({ error: 'Online payments not set up for this clinic.' });
    }

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    const amountInPaise = Math.round(Number(slot.price) * 100);

    // 3A) STRIPE
    if (gateway.name === 'STRIPE') {
      const stripe = new Stripe(gateway.secret); // secret from DB

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items: [
          {
            price_data: {
              currency: 'inr',
              product_data: {
                name: `Appointment: Dr. ${slot.doctor.name}`,
                description: `Date: ${slot.date
                  .toISOString()
                  .slice(0, 10)} | Time: ${slot.time}`,
              },
              unit_amount: amountInPaise,
            },
            quantity: 1,
          },
        ],
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

      return res.json({
        provider: 'STRIPE',
        url: session.url,
      });
    }

    // 3B) RAZORPAY
    if (gateway.name === 'RAZORPAY') {
      // apiKey = keyId, secret = keySecret (both from DB)
      const keyId = gateway.apiKey;
      const keySecret = gateway.secret;

      if (!keyId || !keySecret) {
        return res
          .status(400)
          .json({ error: 'Invalid Razorpay configuration.' });
      }

      const razorpay = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });

      const order = await razorpay.orders.create({
        amount: amountInPaise,
        currency: 'INR',
        receipt: `slot_${slotId}_${Date.now()}`,
        notes: {
          slotId,
          doctorId,
          userId,
          clinicId: slot.clinicId,
        },
      });

      return res.json({
        provider: 'RAZORPAY',
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        keyId,
        clinicName: slot.doctor?.clinicName || 'Clinic',
      });
    }

    return res
      .status(400)
      .json({ error: `Unsupported gateway: ${gateway.name}` });
  } catch (err) {
    console.error('Checkout Error:', err);
    return res
      .status(500)
      .json({ error: 'Failed to create checkout session' });
  }
};


// ---------------------------------------------------------------------
// VERIFY PAYMENT + CREATE APPOINTMENT (Stripe OR Razorpay)
export const verifyPaymentAndBook = async (req, res) => {
  try {
    const { provider, clinic_id } = req.body;

    if (!provider) {
      return res.status(400).json({ error: 'provider is required' });
    }
    if (!clinic_id) {
      return res.status(400).json({ error: 'clinic_id is required' });
    }

    const gateway = await getActiveGateway(clinic_id);
    if (!gateway || !gateway.secret || !gateway.name) {
      return res.status(400).json({ error: 'Gateway config missing.' });
    }

    // ------------------------------------------------------------
    // 1. STRIPE FLOW
    // ------------------------------------------------------------
    if (provider === 'STRIPE') {
      const { session_id } = req.body;
      if (!session_id) {
        return res.status(400).json({ error: 'session_id is required' });
      }

      const stripe = new Stripe(gateway.secret);

      // a) retrieve session from Stripe
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (session.payment_status !== 'paid') {
        return res.status(400).json({ error: 'Payment not completed.' });
      }

      const { slotId, doctorId, userId, clinicId } = session.metadata || {};
      if (!slotId || !doctorId || !userId || !clinicId) {
        return res
          .status(400)
          .json({ error: 'Missing metadata in Stripe session.' });
      }

      // b) idempotent: if appointment already exists, return it
      const existing = await prisma.appointment.findUnique({
        where: { slotId },
      });
      if (existing) {
        return res.json({ success: true, appointment: existing });
      }

      // c) transaction: mark slot booked, create appointment + payment
      const appointment = await prisma.$transaction(async (tx) => {
        // mark slot as booked
        await tx.slot.update({
          where: { id: slotId },
          data: { status: 'CONFIRMED', isBooked: true },
        });

        const appt = await tx.appointment.create({
          data: {
            userId,
            doctorId,
            clinicId,
            slotId,
            section: 'GENERAL',
            status: 'CONFIRMED',
            paymentId: session.payment_intent,
          },
        });

        await tx.payment.create({
          data: {
            appointmentId: appt.id,
            clinicId,
            doctorId,
            gatewayId: gateway.id,
            amount: Number(session.amount_total) / 100,
            status: 'PAID',
            gatewayRefId: session.payment_intent,
          },
        });

        return appt;
      });

      return res.json({ success: true, appointment });
    }

    // ------------------------------------------------------------
    // 2. RAZORPAY FLOW
    // ------------------------------------------------------------
    if (provider === 'RAZORPAY') {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
        slotId,
        doctorId,
        userId,
      } = req.body;

      if (
        !razorpay_order_id ||
        !razorpay_payment_id ||
        !razorpay_signature
      ) {
        return res.status(400).json({
          error:
            'razorpay_order_id, razorpay_payment_id and razorpay_signature are required',
        });
      }
      if (!slotId || !doctorId || !userId) {
        return res
          .status(400)
          .json({ error: 'slotId, doctorId and userId are required' });
      }

      // a) verify signature using Razorpay secret from DB
      const keyId = gateway.apiKey; // not used in verify, but kept for clarity
      const keySecret = gateway.secret;
      if (!keySecret) {
        return res
          .status(400)
          .json({ error: 'Invalid Razorpay gateway configuration.' });
      }

      const crypto = await import('crypto');
      const hmac = crypto
        .createHmac('sha256', keySecret)
        .update(razorpay_order_id + '|' + razorpay_payment_id)
        .digest('hex');

      if (hmac !== razorpay_signature) {
        return res.status(400).json({ error: 'Invalid payment signature.' });
      }

      // b) ensure slot exists and belongs to this clinic
      const slot = await prisma.slot.findUnique({
        where: { id: slotId },
        select: { id: true, clinicId: true, price: true },
      });
      if (!slot || slot.clinicId !== clinic_id) {
        return res.status(404).json({ error: 'Slot not found for clinic.' });
      }

      // c) idempotent: if appointment already exists, return it
      const existing = await prisma.appointment.findUnique({
        where: { slotId },
      });
      if (existing) {
        return res.json({ success: true, appointment: existing });
      }

      // d) transaction: mark slot booked, create appointment + payment
      const appointment = await prisma.$transaction(async (tx) => {
        await tx.slot.update({
          where: { id: slotId },
          data: { status: 'CONFIRMED', isBooked: true },
        });

        const appt = await tx.appointment.create({
          data: {
            userId,
            doctorId,
            clinicId: clinic_id,
            slotId,
            section: 'GENERAL',
            status: 'CONFIRMED',
            paymentId: razorpay_payment_id,
          },
        });

        await tx.payment.create({
          data: {
            appointmentId: appt.id,
            clinicId: clinic_id,
            doctorId,
            gatewayId: gateway.id,
            amount: Number(slot.price),
            status: 'PAID',
            gatewayRefId: razorpay_payment_id,
          },
        });

        return appt;
      });

      return res.json({ success: true, appointment });
    }

    // ------------------------------------------------------------
    // 3. Unsupported provider
    // ------------------------------------------------------------
    return res
      .status(400)
      .json({ error: `Unsupported provider: ${provider}` });
  } catch (err) {
    console.error('Verify Payment Error:', err);
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
};
