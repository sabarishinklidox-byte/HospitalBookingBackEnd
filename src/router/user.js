import { Router } from 'express';
import {
  userSignup,
  userLogin,
  bookAppointment,
  getUserAppointments,
  getUserProfile,
  updateUserProfile,
  getUserAppointmentHistory,cancelUserAppointment,rescheduleAppointment
} from '../controllers/userController.js';
import { createReview, getDoctorReviews } from '../controllers/reviewController.js';

import { authMiddleware, requireUser } from '../middleware/auth.js';
import { 
  createBooking, 
  verifyPayment,        // Ensure this is exported from bookingController.js
  verifyStripePayment   // Ensure this is exported from bookingController.js
} from '../controllers/bookingController.js'; // Adjust path if needed

const router = Router();

// Public
router.post('/signup', userSignup);
router.post('/login', userLogin);

// Protected
router.post('/appointments', authMiddleware, requireUser, bookAppointment);
router.get('/appointments', authMiddleware, requireUser, getUserAppointments);
router.get('/profile', authMiddleware, requireUser, getUserProfile);
router.patch('/profile', authMiddleware, requireUser, updateUserProfile);

// User appointment history
router.get('/history', authMiddleware, requireUser, getUserAppointmentHistory);
router.patch('/appointments/:id/cancel', authMiddleware, requireUser, cancelUserAppointment);
router.patch('/appointments/:id/reschedule',authMiddleware, requireUser, rescheduleAppointment);
router.post('/reviews', authMiddleware, createReview);
router.get('/doctors/:doctorId/reviews', getDoctorReviews);
router.post('/book-appointment', authMiddleware, requireUser, createBooking);
router.post('/verify-payment', authMiddleware, requireUser, verifyPayment); // Razorpay
router.post('/verify-stripe-payment', authMiddleware, requireUser, verifyStripePayment);

// ✅ VERIFICATION ROUTES

export default router;
