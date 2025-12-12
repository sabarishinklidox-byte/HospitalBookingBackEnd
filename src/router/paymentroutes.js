    import express from 'express';
    import { authMiddleware } from '../middleware/auth.js';
    import { createCheckoutSession, verifyPaymentAndBook } from '../controllers/paymentController.js';

    const router = express.Router();

    // User-side payment routes
    router.post('/create-checkout-session', authMiddleware, createCheckoutSession);
    router.post('/verify-session', authMiddleware, verifyPaymentAndBook);

    export default router;
