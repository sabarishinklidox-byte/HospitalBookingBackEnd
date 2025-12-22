// controllers/paymentWebhook.js
import prisma from '../prisma.js';
import crypto from 'crypto';
import Stripe from 'stripe';

export const razorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const payload = req.body;

    if (!signature) {
      console.log('❌ Missing Razorpay signature');
      return res.status(400).send('Missing signature');
    }

    // ✅ RAZORPAY SIGNATURE (YOUR CODE PERFECT!)
    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(JSON.stringify(payload));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      console.log('❌ Razorpay signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    // ✅ FIX 1: Use order_id (correct field name)
    const notes = payload.payload.payment.entity.notes;
    const orderId = payload.payload.payment.entity.order_id; // ← CORRECT field
    const appointmentTempId = notes.appointmentTempId;

    if (!orderId && !appointmentTempId) {
      console.log('❌ No appointment reference in webhook');
      return res.status(400).send('Missing appointment reference');
    }

    // ✅ Find appointment (YOUR LOGIC PERFECT!)
    const appointment = await prisma.appointment.findFirst({
      where: {
        OR: [
          { orderId },                    // Razorpay order_id
          { id: appointmentTempId }       // Temp UUID backup
        ],
        status: 'PENDING',
        createdAt: { 
          gt: new Date(Date.now() - 15 * 60 * 1000) 
        }
      },
      include: {
        slot: true,
        clinic: { 
          include: { gateways: true }     // ✅ FIX 2: Get gateway ID
        }
      }
    });

    if (!appointment) {
      console.log(`❌ Appointment not found: order=${orderId}`);
      return res.status(400).send('Appointment expired or not found');
    }

    // ✅ ATOMIC TRANSACTION (YOUR CODE PERFECT!)
    await prisma.$transaction(async (tx) => {
      const stillPending = await tx.appointment.findUnique({
        where: { id: appointment.id }
      });

      if (stillPending?.status !== 'PENDING') {
        console.log(`⚠️ Already processed: ${appointment.id}`);
        return;
      }

      await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          paymentId: payload.payload.payment.entity.id,
        }
      });

      await tx.slot.update({
        where: { id: appointment.slotId },
        data: { isBooked: true }
      });

      // ✅ FIX 3: Proper gatewayId
      const razorpayGateway = appointment.clinic.gateways.find(g => g.name === 'RAZORPAY');
      await tx.payment.create({
        data: {
          appointmentId: appointment.id,
          clinicId: appointment.clinicId,
          doctorId: appointment.doctorId,
          gatewayId: razorpayGateway?.id,
          amount: appointment.amount || payload.payload.payment.entity.amount / 100,
          status: 'PAID',
          gatewayRefId: payload.payload.payment.entity.id,
        }
      });
    });

    console.log(`✅ Razorpay CONFIRMED: ${appointment.id}`);
    return res.status(200).json({ success: true });

  } catch (error) {
    console.error('Razorpay Webhook Error:', error);
    return res.status(500).send('Webhook failed');
  }
};

export const stripeWebhook = async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const payload = req.body;

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const event = stripe.webhooks.constructEvent(
      payload.toString(),  // ✅ FIX: raw string
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      if (session.payment_status === 'paid') {
        const orderId = session.id;
        const appointmentTempId = session.metadata.appointmentTempId;

        const appointment = await prisma.appointment.findFirst({
          where: {
            OR: [
              { orderId },
              { id: appointmentTempId }
            ],
            status: 'PENDING',
            createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) }
          },
          include: {
            slot: true,
            clinic: { 
              include: { gateways: true } 
            }
          }
        });

        if (appointment) {
          await prisma.$transaction(async (tx) => {
            const stillPending = await tx.appointment.findUnique({
              where: { id: appointment.id }
            });

            if (stillPending?.status !== 'PENDING') return;

            await tx.appointment.update({
              where: { id: appointment.id },
              data: {
                status: 'CONFIRMED',
                paymentStatus: 'PAID',
                paymentId: session.payment_intent,
              }
            });

            await tx.slot.update({
              where: { id: appointment.slotId },
              data: { isBooked: true }
            });

            const stripeGateway = appointment.clinic.gateways.find(g => g.name === 'STRIPE');
            await tx.payment.create({
              data: {
                appointmentId: appointment.id,
                clinicId: appointment.clinicId,
                doctorId: appointment.doctorId,
                gatewayId: stripeGateway?.id,
                amount: Number(session.amount_total) / 100,
                status: 'PAID',
                gatewayRefId: session.payment_intent,
              }
            });
          });

          console.log(`✅ Stripe CONFIRMED: ${appointment.id}`);
        }
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Stripe Webhook Error:', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
};
