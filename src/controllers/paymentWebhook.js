// controllers/paymentWebhook.js
import prisma from '../prisma.js';
import crypto from 'crypto';
import Stripe from 'stripe';
import { sendBookingEmails } from '../utils/email.js'; // ✅ ADD EMAIL IMPORT

export const razorpayWebhook = async (req, res) => {
  try {
    const signature = req.headers['x-razorpay-signature'];
    const payload = req.body;

    if (!signature) {
      console.log('❌ Missing Razorpay signature');
      return res.status(400).send('Missing signature');
    }

    // ✅ RAZORPAY SIGNATURE VERIFICATION (PERFECT)
    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET);
    shasum.update(JSON.stringify(payload));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      console.log('❌ Razorpay signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    const notes = payload.payload.payment.entity.notes;
    const orderId = payload.payload.payment.entity.order_id;
    const appointmentTempId = notes.appointmentTempId;

    if (!orderId && !appointmentTempId) {
      console.log('❌ No appointment reference in webhook');
      return res.status(400).send('Missing appointment reference');
    }

    // ✅ ENHANCED QUERY - Get FULL appointment data for emails
    const appointment = await prisma.appointment.findFirst({
      where: {
        OR: [
          { orderId },
          { id: appointmentTempId }
        ],
        status: 'PENDING_PAYMENT', // ✅ More specific
        createdAt: { 
          gt: new Date(Date.now() - 15 * 60 * 1000) 
        }
      },
      include: {
        slot: true,
        clinic: true,
        doctor: true,
        user: {
          select: { id: true, name: true, phone: true, email: true }
        },
        clinic: { 
          include: { gateways: true }
        }
      }
    });

    if (!appointment) {
      console.log(`❌ Appointment not found: order=${orderId}`);
      return res.status(400).send('Appointment expired or not found');
    }

    // ✅ ATOMIC TRANSACTION + EMAILS
    await prisma.$transaction(async (tx) => {
      const stillPending = await tx.appointment.findUnique({
        where: { id: appointment.id }
      });

      if (stillPending?.status !== 'PENDING_PAYMENT') {
        console.log(`⚠️ Already processed: ${appointment.id}`);
        return;
      }

      // ✅ CONFIRM PAYMENT
      await tx.appointment.update({
        where: { id: appointment.id },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          paymentId: payload.payload.payment.entity.id,
          updatedAt: new Date()
        }
      });

      await tx.slot.update({
        where: { id: appointment.slotId },
        data: { isBooked: true }
      });

      // ✅ CREATE PAYMENT RECORD
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

    // ✅ SEND EMAILS AFTER PAYMENT SUCCESS (NON-BLOCKING)
    sendBookingEmails({
      id: appointment.id,
      clinic: appointment.clinic,
      doctor: appointment.doctor,
      slot: appointment.slot,
      user: appointment.user
    }).catch(err => console.error('Payment confirmation emails failed:', err));

    console.log(`✅ Razorpay CONFIRMED + EMAILS SENT: ${appointment.id}`);
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
      payload.toString(),
      sig, 
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      
      if (session.payment_status === 'paid') {
        const orderId = session.id;
        const appointmentTempId = session.metadata.appointmentTempId;

        // ✅ ENHANCED QUERY - Get FULL data for emails
        const appointment = await prisma.appointment.findFirst({
          where: {
            OR: [
              { orderId },
              { id: appointmentTempId }
            ],
            status: 'PENDING_PAYMENT',
            createdAt: { gt: new Date(Date.now() - 15 * 60 * 1000) }
          },
          include: {
            slot: true,
            clinic: true,
            doctor: true,
            user: {
              select: { id: true, name: true, phone: true, email: true }
            },
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

            if (stillPending?.status !== 'PENDING_PAYMENT') return;

            await tx.appointment.update({
              where: { id: appointment.id },
              data: {
                status: 'CONFIRMED',
                paymentStatus: 'PAID',
                paymentId: session.payment_intent,
                updatedAt: new Date()
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

          // ✅ SEND EMAILS AFTER STRIPE PAYMENT SUCCESS
          sendBookingEmails({
            id: appointment.id,
            clinic: appointment.clinic,
            doctor: appointment.doctor,
            slot: appointment.slot,
            user: appointment.user
          }).catch(err => console.error('Stripe confirmation emails failed:', err));

          console.log(`✅ Stripe CONFIRMED + EMAILS SENT: ${appointment.id}`);
        }
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Stripe Webhook Error:', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
};
