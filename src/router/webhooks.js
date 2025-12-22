// src/router/webhooks.js
import express from 'express';
import { razorpayWebhook, stripeWebhook } from '../controllers/paymentWebhook.js';

const router = express.Router();

// ✅ Webhooks - RAW BODY for signature verification
router.post('/razorpay', razorpayWebhook);
router.post('/stripe', stripeWebhook);

export default router;
