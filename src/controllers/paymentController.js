// src/controllers/paymentController.js
import Stripe from 'stripe';
import prisma from '../prisma.js';

// ---------------------------------------------------------------------
// CREATE CHECKOUT SESSION (called from UserBookingPage)
// ---------------------------------------------------------------------
export const createCheckoutSession = async (req, res) => {
  try {
    const { slotId, doctorId, userId } = req.body;

    // 1) Fetch slot & doctor
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { doctor: true },
    });
    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // 2) Fetch clinic gateway config
    const gateway = await prisma.paymentGateway.findFirst({
      where: {
        clinicId: slot.clinicId,
        name: 'STRIPE',
        isActive: true,
        deletedAt: null,
      },
    });
    if (!gateway || !gateway.secret) {
      return res.status(400).json({ error: 'Online payments not set up for this clinic.' });
    }

    const stripe = new Stripe(gateway.secret);

    const clientUrl = process.env.CLIENT_URL || 'http://localhost:5173';
    console.log('CLIENT_URL in paymentController:', clientUrl);

    // 3) Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'inr',
            product_data: {
              name: `Appointment: Dr. ${slot.doctor.name}`,
              description: `Date: ${slot.date.toISOString().slice(0, 10)} | Time: ${slot.time}`,
            },
            unit_amount: Math.round(Number(slot.price) * 100),
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

    return res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe Error:', err);
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
};

// ---------------------------------------------------------------------
// VERIFY PAYMENT + CREATE APPOINTMENT (called from PaymentSuccessPage)
// ---------------------------------------------------------------------
export const verifyPaymentAndBook = async (req, res) => {
  try {
    const { session_id, clinic_id } = req.body;

    // 1) Fetch clinic gateway again
    const gateway = await prisma.paymentGateway.findFirst({
      where: {
        clinicId: clinic_id,
        name: 'STRIPE',
        isActive: true,
        deletedAt: null,
      },
    });
    if (!gateway || !gateway.secret) {
      return res.status(400).json({ error: 'Gateway config missing.' });
    }

    const stripe = new Stripe(gateway.secret);

    // 2) Retrieve session from Stripe
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== 'paid') {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    const { slotId, doctorId, userId, clinicId } = session.metadata;

    // 3) Idempotent: if appointment already exists for this slot, just return it
    const existing = await prisma.appointment.findUnique({ where: { slotId } });
    if (existing) {
      return res.json({ success: true, appointment: existing });
    }

    // 4) Create appointment + payment + mark slot booked in a transaction
    const appointment = await prisma.$transaction(async (tx) => {
      // Mark slot as booked
      await tx.slot.update({
        where: { id: slotId },
        data: { status: 'CONFIRMED', isBooked: true },
      });

      // Create appointment
      const appt = await tx.appointment.create({
        data: {
          userId,
          doctorId,
          clinicId,
          slotId,
          section: 'GENERAL',
          status: 'CONFIRMED',
          paymentId: session.payment_intent, // store Stripe paymentIntent id
        },
      });

      // Create payment record
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
  } catch (err) {
    console.error('Verify Payment Error:', err);
    return res.status(500).json({ error: 'Failed to verify payment' });
  }
};
