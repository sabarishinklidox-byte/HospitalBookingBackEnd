// controllers/superAdminPlanPaymentController.js - 100% FIXED ✅
import prisma from '../prisma.js';
import crypto from 'crypto';
import { logAudit } from '../utils/audit.js';  // ✅ Add import

export const verifyClinicPlanPayment = async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const { clinicId, id: userId } = req.user;

    // 1. Validate input
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing Razorpay fields' });
    }

    // 2. Super admin gateway
    const superGateway = await prisma.paymentGateway.findFirst({
      where: { 
        clinicId: null,
        name: 'RAZORPAY', 
        isActive: true 
      },
    });

    if (!superGateway) {
      return res.status(400).json({ error: 'Platform payments not configured' });
    }

    // 3. Signature verification
    const shasum = crypto.createHmac('sha256', superGateway.config.secret);
    shasum.update(`${razorpay_order_id}|${razorpay_payment_id}`);
    const digest = shasum.digest('hex');

    if (digest !== razorpay_signature) {
      console.error('Invalid signature:', { 
        expected: digest, 
        received: razorpay_signature,
        order_id: razorpay_order_id 
      });
      return res.status(400).json({ error: 'Invalid Razorpay signature' });
    }

    // 4. Find pending subscription by order ID (matches upgradeClinicPlan)
    const subscription = await prisma.subscription.findFirst({
      where: {
        clinicId,
        razorpayOrderId: razorpay_order_id,  // ✅ Matches upgrade flow
        status: 'TRIAL'
      },
      include: { plan: true }
    });

    if (!subscription) {
      return res.status(404).json({ error: 'No pending subscription found' });
    }

    // 5. Complete transaction
    const activated = await prisma.$transaction(async (tx) => {
      // Create payment record
      const newPayment = await tx.payment.create({
        data: {
          clinicId,
          gatewayOrderId: razorpay_order_id,
          razorpayPaymentId: razorpay_payment_id,
          razorpaySignature: razorpay_signature,
          status: 'SUCCESS',
          amount: subscription.priceAtPurchase * 100,  // From plan
          metadata: {
            planId: subscription.planId,
            subscriptionId: subscription.id
          }
        }
      });

      // Activate subscription
      const updatedSubscription = await tx.subscription.update({
        where: { id: subscription.id },
        data: {
          status: 'ACTIVE',
          razorpayOrderId: null,  // Clear after success
          startDate: new Date(),
          priceAtPurchase: subscription.priceAtPurchase || subscription.plan.priceMonthly,
          maxDoctors: subscription.plan.maxDoctors,
          maxBookingsPerPeriod: subscription.plan.maxBookingsPerMonth,
        },
        include: { plan: true }
      });

      // Audit log ✅ Fixed relation
      await logAudit({
        user: { connect: { id: userId } },
        clinicId,
        action: 'PLAN_PAYMENT_SUCCESS',
        entity: 'Subscription',
        entityId: updatedSubscription.id,
        details: { 
          razorpay_payment_id, 
          razorpay_order_id,
          plan: updatedSubscription.plan.name,
          amount: newPayment.amount 
        },
        req,
      });

      return { subscription: updatedSubscription, payment: newPayment };
    });

    res.json({
      success: true,
      message: `Activated ${activated.subscription.plan.name}!`,
      subscription: activated.subscription,
      payment: activated.payment,
    });

  } catch (err) {
    console.error('Verify Plan Payment Error:', err);
    res.status(500).json({ error: 'Payment verification failed' });
  }
};
