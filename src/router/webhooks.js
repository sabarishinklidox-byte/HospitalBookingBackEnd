import express from 'express';
import { razorpayWebhook, stripeWebhook } from '../controllers/paymentWebhook.js';

const router = express.Router();

// 1. STRIPE: Needs RAW Buffer
// We apply express.raw() ONLY to this route
router.post(
  '/stripe', 
  express.raw({ type: 'application/json' }), 
  stripeWebhook
);

// 2. RAZORPAY: Needs JSON Object
// We apply express.json() ONLY to this route
router.post(
  '/razorpay', 
  express.json(), 
  razorpayWebhook
);

export default router;
