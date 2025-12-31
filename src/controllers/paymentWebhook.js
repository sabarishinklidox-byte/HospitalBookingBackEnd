// controllers/paymentWebhook.js
import prisma from '../prisma.js';
import crypto from 'crypto';
import Stripe from 'stripe';
import { sendBookingEmails } from '../utils/email.js'; // ✅ ADD EMAIL IMPORT

// Adjust path if needed

// ----------------------------------------------------------------
// 1. RAZORPAY WEBHOOK
// ----------------------------------------------------------------
// src/controllers/webhookController.js
 // Ensure this path is correct

// ----------------------------------------------------------------
// 1. RAZORPAY WEBHOOK
// ----------------------------------------------------------------
export const razorpayWebhook = async (req, res) => {
    console.log('🔥 RAZORPAY RAW WEBHOOK HIT:', {
    event: req.body.event,
    orderId: req.body.payload?.payment?.entity?.order_id,
    paymentId: req.body.payload?.payment?.entity?.id,
    headers: {
      signature: req.headers['x-razorpay-signature']?.slice(0, 20) + '...',
      'user-agent': req.headers['user-agent']
    }
  });
  try {
  
    const signature = req.headers['x-razorpay-signature'];
    const payload = req.body;

    if (!signature) return res.status(400).send('Missing signature');

    // Verify Signature
    const shasum = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET);
    shasum.update(JSON.stringify(payload));
    const digest = shasum.digest('hex');

    if (digest !== signature) {
      console.error('❌ Razorpay signature mismatch');
      return res.status(400).send('Invalid signature');
    }

    // Only process payment.captured
    if (payload.event === 'payment.captured') {
      const paymentEntity = payload.payload.payment.entity;
      const notes = paymentEntity.notes || {};
      const orderId = paymentEntity.order_id;
      const paymentId = paymentEntity.id;
      const amountPaid = paymentEntity.amount / 100;

      console.log(`🪝 Razorpay Webhook: Order ${orderId}, Payment ${paymentId}`);

      // ---------------------------------------------------------
      // SCENARIO A: RESCHEDULE PAYMENT
      // ---------------------------------------------------------
      if (notes.type === 'RESCHEDULE') {
        const appointmentId = notes.appointmentId;
        const newSlotId = notes.rescheduleToSlot || notes.slotId;

        console.log(`🔄 Processing Reschedule Webhook: Appt ${appointmentId} -> Slot ${newSlotId}`);

        await prisma.$transaction(async (tx) => {
          // 1. Fetch Current Appointment
          const currentAppt = await tx.appointment.findUnique({ 
            where: { id: appointmentId },
            include: { clinic: { include: { gateways: true } } } // Pre-fetch gateways
          });
          
          if (!currentAppt) throw new Error("Appointment not found");

          // 2. Free up OLD Slot
          if (currentAppt.slotId) {
            await tx.slot.update({
              where: { id: currentAppt.slotId },
              data: { isBooked: false, status: 'AVAILABLE', isBlocked: false } 
            });
          }

          // 3. Occupy NEW Slot
          await tx.slot.update({
            where: { id: newSlotId },
            data: { isBooked: true, status: 'CONFIRMED', isBlocked: false }
          });

          // 4. Update Appointment
          const updatedAppt = await tx.appointment.update({
            where: { id: appointmentId },
            data: {
              slotId: newSlotId,
              status: 'CONFIRMED',
              paymentStatus: 'PAID',
              financialStatus: 'PAID',
              paymentId: paymentId,
              amount: amountPaid, // Update to paid amount
              adminNote: `Rescheduled via Online Payment (${paymentId})`,
              updatedAt: new Date()
            },
            include: { clinic: true, doctor: true, user: true, slot: true }
          });

          // 5. Create Payment Record (Idempotency Check)
          const existingPayment = await tx.payment.findFirst({ where: { gatewayRefId: paymentId } });
          
          if (!existingPayment) {
            const gateway = currentAppt.clinic.gateways.find(g => g.name === 'RAZORPAY');
            await tx.payment.create({
              data: {
                appointmentId: updatedAppt.id,
                clinicId: updatedAppt.clinicId,
                doctorId: updatedAppt.doctorId,
                gatewayId: gateway?.id,
                amount: amountPaid,
                status: 'PAID',
                gatewayRefId: paymentId,
              }
            });
          }

          // 6. Send Email (Fire & Forget)
          sendBookingEmails({
            type: "RESCHEDULE",
            id: updatedAppt.id,
            clinic: updatedAppt.clinic,
            doctor: updatedAppt.doctor,
            slot: updatedAppt.slot,
            oldSlot: { id: currentAppt.slotId }, // basic info
            user: updatedAppt.user
          }).catch(err => console.error("Reschedule email failed", err));
        });

        return res.json({ success: true, type: 'RESCHEDULE_PROCESSED' });
      }

      // ---------------------------------------------------------
      // SCENARIO B: NEW BOOKING (Standard Flow)
      // ---------------------------------------------------------
      
      const appointmentTempId = notes.appointmentTempId;
      
      const appointment = await prisma.appointment.findFirst({
        where: {
          OR: [{ orderId }, { id: appointmentTempId }],
          // Allow PENDING or PENDING_PAYMENT
          status: { in: ['PENDING', 'PENDING_PAYMENT'] }
        },
        include: {
          slot: true,
          clinic: { include: { gateways: true } },
          doctor: true,
          user: true
        }
      });

      if (!appointment) {
        // Idempotency: Check if already confirmed
        const alreadyConfirmed = await prisma.appointment.findFirst({
          where: { orderId, status: 'CONFIRMED' }
        });
        if (alreadyConfirmed) {
          console.log(`ℹ️ Booking already confirmed for Order ${orderId}`);
          return res.status(200).json({ message: "Already processed" });
        }
        
        console.log(`❌ Booking not found/expired for order: ${orderId}`);
        // Return 200 to stop retry loop if truly not found
        return res.status(200).send('Appointment not found');
      }

      // Confirm Booking
      await prisma.$transaction(async (tx) => {
        const updatedAppt = await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: 'CONFIRMED',
            paymentStatus: 'PAID',
            financialStatus: 'PAID',
            paymentId: paymentId,
            updatedAt: new Date()
          }
        });

        if (appointment.slotId) {
          await tx.slot.update({
            where: { id: appointment.slotId },
            data: { isBooked: true, status: 'CONFIRMED', isBlocked: false }
          });
        }

        const gateway = appointment.clinic.gateways.find(g => g.name === 'RAZORPAY');
        
        // Prevent duplicate payment records
        const existingPayment = await tx.payment.findFirst({ where: { gatewayRefId: paymentId } });
        
        if (!existingPayment) {
          await tx.payment.create({
            data: {
              appointmentId: appointment.id,
              clinicId: appointment.clinicId,
              doctorId: appointment.doctorId,
              gatewayId: gateway?.id,
              amount: amountPaid,
              status: 'PAID',
              gatewayRefId: paymentId,
            }
          });
        }
        
        return updatedAppt;
      });

      // Send Confirmation Email
      sendBookingEmails({
        id: appointment.id,
        clinic: appointment.clinic,
        doctor: appointment.doctor,
        slot: appointment.slot,
        user: appointment.user
      }).catch(err => console.error('Booking email failed:', err));

      console.log(`✅ Webhook Confirmed Booking: ${appointment.id}`);
      return res.status(200).json({ success: true });
    }

    // Return OK for other events to prevent retries
    return res.status(200).json({ status: 'ignored' });

  } catch (error) {
    console.error('❌ Razorpay Webhook Error:', error);
    // Return 500 to trigger Razorpay retry logic for actual errors
    return res.status(500).send('Webhook failed');
  }
};


// ----------------------------------------------------------------
// 2. STRIPE WEBHOOK
// ----------------------------------------------------------------
export const stripeWebhook = async (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    const payload = req.body;
    // Note: Stripe requires raw body for verification. Ensure your express app preserves it.
    // Usually handled by express.raw({ type: 'application/json' }) middleware on this route.
    
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.rawBody || payload, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`⚠️ Stripe Signature verification failed: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const amountPaid = session.amount_total / 100;

      console.log(`🪝 Stripe Webhook: Session ${session.id}`);

      // ---------------------------------------------------------
      // SCENARIO A: RESCHEDULE PAYMENT
      // ---------------------------------------------------------
      if (metadata.type === 'RESCHEDULE') {
         const appointmentId = metadata.appointmentId;
         const newSlotId = metadata.slotId; 

         console.log(`🔄 Processing Stripe Reschedule: Appt ${appointmentId} -> Slot ${newSlotId}`);

         await prisma.$transaction(async (tx) => {
            const currentAppt = await tx.appointment.findUnique({ 
                where: { id: appointmentId },
                include: { clinic: { include: { gateways: true } } }
            });
            
            // Free Old Slot
            if (currentAppt?.slotId) {
                await tx.slot.update({
                    where: { id: currentAppt.slotId },
                    data: { isBooked: false, status: 'AVAILABLE', isBlocked: false }
                });
            }

            // Book New Slot
            await tx.slot.update({
                where: { id: newSlotId },
                data: { isBooked: true, status: 'CONFIRMED', isBlocked: false }
            });

            // Update Appointment
            const updatedAppt = await tx.appointment.update({
                where: { id: appointmentId },
                data: {
                    slotId: newSlotId,
                    status: 'CONFIRMED',
                    paymentStatus: 'PAID',
                    financialStatus: 'PAID',
                    paymentId: session.payment_intent,
                    amount: amountPaid,
                    adminNote: 'Rescheduled via Stripe',
                },
                include: { clinic: true, doctor: true, user: true, slot: true }
            });

            const existingPayment = await tx.payment.findFirst({ where: { gatewayRefId: session.payment_intent } });
            
            if (!existingPayment) {
                const gateway = currentAppt.clinic.gateways.find(g => g.name === 'STRIPE');
                await tx.payment.create({
                    data: {
                        appointmentId: updatedAppt.id,
                        clinicId: updatedAppt.clinicId,
                        doctorId: updatedAppt.doctorId,
                        gatewayId: gateway?.id,
                        amount: amountPaid,
                        status: 'PAID',
                        gatewayRefId: session.payment_intent,
                    }
                });
            }

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
         return res.json({ received: true });
      }

      // ---------------------------------------------------------
      // SCENARIO B: NEW BOOKING
      // ---------------------------------------------------------
      if (session.payment_status === 'paid') {
        const orderId = session.id; // Checkout Session ID
        const appointmentTempId = metadata.appointmentTempId;

        const appointment = await prisma.appointment.findFirst({
          where: {
            OR: [{ orderId }, { id: appointmentTempId }],
            status: { in: ['PENDING', 'PENDING_PAYMENT'] }
          },
          include: {
            slot: true,
            clinic: { include: { gateways: true } },
            doctor: true,
            user: true
          }
        });

        if (appointment) {
          await prisma.$transaction(async (tx) => {
            const updatedAppt = await tx.appointment.update({
              where: { id: appointment.id },
              data: {
                status: 'CONFIRMED',
                paymentStatus: 'PAID',
                financialStatus: 'PAID',
                paymentId: session.payment_intent,
                updatedAt: new Date()
              }
            });

            if (appointment.slotId) {
              await tx.slot.update({
                where: { id: appointment.slotId },
                data: { isBooked: true, status: 'CONFIRMED', isBlocked: false }
              });
            }

            const existingPayment = await tx.payment.findFirst({ where: { gatewayRefId: session.payment_intent } });

            if (!existingPayment) {
                const gateway = appointment.clinic.gateways.find(g => g.name === 'STRIPE');
                await tx.payment.create({
                  data: {
                    appointmentId: appointment.id,
                    clinicId: appointment.clinicId,
                    doctorId: appointment.doctorId,
                    gatewayId: gateway?.id,
                    amount: amountPaid,
                    status: 'PAID',
                    gatewayRefId: session.payment_intent,
                  }
                });
            }
          });

          sendBookingEmails({
             id: appointment.id,
             clinic: appointment.clinic,
             doctor: appointment.doctor,
             slot: appointment.slot,
             user: appointment.user
          }).catch(console.error);
          
          console.log(`✅ Stripe Webhook Confirmed: ${appointment.id}`);
        } else {
            console.log(`⚠️ Stripe Webhook: Appt not found for Session ${session.id}`);
        }
      }
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('❌ Stripe Webhook Error:', error);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }
};
