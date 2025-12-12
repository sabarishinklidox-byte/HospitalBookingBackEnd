import prisma from '../prisma.js';
import Razorpay from 'razorpay';
import Stripe from 'stripe';
import crypto from 'crypto';

// ----------------------------------------------------------------
// HELPER: Get Gateway Instance
// ----------------------------------------------------------------
const getPaymentInstance = async (clinicId, provider = 'RAZORPAY') => {
  const gateway = await prisma.paymentGateway.findFirst({
    where: {
      clinicId,
      isActive: true,
      provider: provider, // 'RAZORPAY' or 'STRIPE'
    },
  });

  if (!gateway || !gateway.apiKey || !gateway.secretKey) {
    throw new Error(`${provider} payments are not configured for this clinic.`);
  }

  if (provider === 'STRIPE') {
    return {
      instance: new Stripe(gateway.secretKey),
      publicKey: gateway.apiKey,
      gatewayId: gateway.id,
      provider: 'STRIPE',
    };
  }

  // Default to Razorpay
  return {
    instance: new Razorpay({
      key_id: gateway.apiKey,
      key_secret: gateway.secretKey,
    }),
    key_id: gateway.apiKey,
    gatewayId: gateway.id,
    provider: 'RAZORPAY',
  };
};

// ----------------------------------------------------------------
// CREATE BOOKING (Online/Offline)
// ----------------------------------------------------------------
export const createBooking = async (req, res) => {
  try {
    const { slotId, userId, paymentMethod, provider } = req.body;
    // paymentMethod: 'ONLINE' | 'OFFLINE'
    // provider: 'RAZORPAY' | 'STRIPE' (Optional, defaults to RAZORPAY if ONLINE)

    // 1. Fetch Slot
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
      include: { clinic: true },
    });

    if (!slot) return res.status(404).json({ error: 'Slot not found' });
    if (slot.isBooked) return res.status(400).json({ error: 'Slot already booked' });

    // ---------------------------------------------------------
    // ✅ 2. ENFORCE ADMIN RULES
    // ---------------------------------------------------------

    // A. If Slot is FREE
    if (slot.paymentMode === 'FREE') {
      const appointment = await prisma.appointment.create({
        data: {
          userId,
          slotId,
          clinicId: slot.clinicId,
          doctorId: slot.doctorId,
          status: 'CONFIRMED',
          paymentStatus: 'NOT_REQUIRED',
          paymentMethod: 'NONE',
          amount: 0,
        },
      });
      await prisma.slot.update({
        where: { id: slotId },
        data: { isBooked: true },
      });
      return res.json({ success: true, message: 'Free booking confirmed!' });
    }

    // B. If Slot is ONLINE ONLY but user wants OFFLINE
    if (slot.paymentMode === 'ONLINE' && paymentMethod === 'OFFLINE') {
      return res.status(400).json({ error: 'This slot requires Online Payment.' });
    }

    // C. If Slot is OFFLINE ONLY but user wants ONLINE
    if (slot.paymentMode === 'OFFLINE' && paymentMethod === 'ONLINE') {
      return res.status(400).json({ error: 'This slot requires Payment at Clinic.' });
    }

    // ---------------------------------------------------------
    // 3. HANDLE ONLINE PAYMENT SETUP
    // ---------------------------------------------------------
    let orderData = {};
    let gatewayId = null;

    if (paymentMethod === 'ONLINE') {
      const selectedProvider = provider || 'RAZORPAY';
      const gateway = await getPaymentInstance(slot.clinicId, selectedProvider);
      gatewayId = gateway.gatewayId;

      if (gateway.provider === 'RAZORPAY') {
        const options = {
          amount: Math.round(Number(slot.price) * 100), // paisa
          currency: 'INR',
          receipt: `rcpt_${slotId}_${Date.now()}`,
        };
        const order = await gateway.instance.orders.create(options);

        orderData = {
          provider: 'RAZORPAY',
          orderId: order.id,
          amount: order.amount,
          key: gateway.key_id,
        };
      } else if (gateway.provider === 'STRIPE') {
        const session = await gateway.instance.checkout.sessions.create({
          payment_method_types: ['card'],
          line_items: [
            {
              price_data: {
                currency: 'inr',
                product_data: {
                  name: `Appointment with Dr. at ${slot.clinic.name}`,
                },
                unit_amount: Math.round(Number(slot.price) * 100),
              },
              quantity: 1,
            },
          ],
          mode: 'payment',
          success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}&booking_id=TEMP_ID`,
          cancel_url: `${process.env.FRONTEND_URL}/payment/cancel`,
        });

        orderData = {
          provider: 'STRIPE',
          sessionId: session.id,
          url: session.url,
          publishableKey: gateway.publicKey,
        };
      }
    }

    // ---------------------------------------------------------
    // 4. CREATE APPOINTMENT RECORD
    // ---------------------------------------------------------
    const appointment = await prisma.appointment.create({
      data: {
        userId,
        slotId,
        clinicId: slot.clinicId,
        doctorId: slot.doctorId,
        status: paymentMethod === 'OFFLINE' ? 'CONFIRMED' : 'PENDING_PAYMENT',
        paymentStatus: 'PENDING',
        paymentMethod,
        amount: slot.price,
      },
    });

    // ---------------------------------------------------------
    // 5. FINALIZE OFFLINE BOOKING
    // ---------------------------------------------------------
    if (paymentMethod === 'OFFLINE') {
      await prisma.slot.update({
        where: { id: slotId },
        data: { isBooked: true },
      });
      return res.json({
        success: true,
        isOnline: false,
        message: 'Booking confirmed. Pay at clinic.',
        appointmentId: appointment.id,
      });
    }

    // ---------------------------------------------------------
    // 6. FINALIZE ONLINE RESPONSE
    // ---------------------------------------------------------
    if (orderData.provider === 'STRIPE' && orderData.url) {
      orderData.url = orderData.url.replace('TEMP_ID', appointment.id);
    }

    return res.json({
      success: true,
      isOnline: true,
      appointmentId: appointment.id,
      ...orderData,
    });
  } catch (error) {
    console.error('Booking Error:', error);
    return res.status(500).json({ error: error.message || 'Booking failed' });
  }
};

// ----------------------------------------------------------------
// VERIFY RAZORPAY PAYMENT
// ----------------------------------------------------------------
export const verifyPayment = async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      appointmentId,
    } = req.body;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    // Fetch gateway credentials again to verify signature
    const gateway = await prisma.paymentGateway.findFirst({
      where: { clinicId: appointment.clinicId, provider: 'RAZORPAY', isActive: true },
    });

    if (!gateway) return res.status(400).json({ error: 'Payment configuration missing' });

    // Verify Signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', gateway.secretKey)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      // 1. Update Appointment
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          transactionId: razorpay_payment_id,
        },
      });

      // 2. Lock Slot
      await prisma.slot.update({
        where: { id: appointment.slotId },
        data: { isBooked: true },
      });

      // 3. Create Payment Record
      await prisma.payment.create({
        data: {
          appointmentId: appointment.id,
          clinicId: appointment.clinicId,
          doctorId: appointment.doctorId,
          gatewayId: gateway.id,
          amount: appointment.amount,
          status: 'COMPLETED',
          gatewayRefId: razorpay_payment_id,
        },
      });

      return res.json({ success: true, message: 'Payment verified & Booking Confirmed' });
    } else {
      return res.status(400).json({ success: false, error: 'Invalid signature' });
    }
  } catch (error) {
    console.error('Razorpay Verification Error:', error);
    return res.status(500).json({ error: 'Payment verification failed' });
  }
};

// ----------------------------------------------------------------
// VERIFY STRIPE PAYMENT
// ----------------------------------------------------------------
export const verifyStripePayment = async (req, res) => {
  try {
    const { session_id, appointmentId } = req.body;

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
    });
    if (!appointment)
      return res.status(404).json({ error: 'Appointment not found' });

    const gateway = await getPaymentInstance(appointment.clinicId, 'STRIPE');
    const session = await gateway.instance.checkout.sessions.retrieve(
      session_id
    );

    if (session.payment_status === 'paid') {
      // Success
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: {
          status: 'CONFIRMED',
          paymentStatus: 'PAID',
          transactionId: session.payment_intent,
        },
      });
      await prisma.slot.update({
        where: { id: appointment.slotId },
        data: { isBooked: true },
      });
      await prisma.payment.create({
        data: {
          appointmentId: appointment.id,
          clinicId: appointment.clinicId,
          doctorId: appointment.doctorId,
          gatewayId: gateway.gatewayId,
          amount: appointment.amount,
          status: 'COMPLETED',
          gatewayRefId: session.payment_intent,
        },
      });
      return res.json({ success: true, message: 'Payment Verified' });
    } else {
      return res.status(400).json({ error: 'Payment not completed' });
    }
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Verification failed' });
  }
};
