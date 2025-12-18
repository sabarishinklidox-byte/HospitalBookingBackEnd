import { Router } from "express";
import {
  userSignup,
  userLogin,
  bookAppointment,
  getUserAppointments,
  getUserProfile,
  updateUserProfile,
  getUserAppointmentHistory,
  cancelUserAppointment,
  rescheduleAppointment,
  getSlotsForUser, // ✅ add this export from userController.js
} from "../controllers/userController.js";

import { createReview, getDoctorReviews } from "../controllers/reviewController.js";
import { authMiddleware, requireUser } from "../middleware/auth.js";

import {
  createBooking,
  verifyPayment,
  verifyStripePayment,
} from "../controllers/bookingController.js";

const router = Router();

// Public
router.post("/signup", userSignup);
router.post("/login", userLogin);

// Protected (User)
router.get("/profile", authMiddleware, requireUser, getUserProfile);
router.patch("/profile", authMiddleware, requireUser, updateUserProfile);

// Slots for booking UI (so booked slots can be disabled)
router.get("/slots", authMiddleware, requireUser, getSlotsForUser);

// Appointments
router.post("/appointments", authMiddleware, requireUser, bookAppointment);
router.get("/appointments", authMiddleware, requireUser, getUserAppointments);
router.get("/history", authMiddleware, requireUser, getUserAppointmentHistory);
router.patch("/appointments/:id/cancel", authMiddleware, requireUser, cancelUserAppointment);
router.patch("/appointments/:id/reschedule", authMiddleware, requireUser, rescheduleAppointment);

// Reviews
router.post("/reviews", authMiddleware, requireUser, createReview);
router.get("/doctors/:doctorId/reviews", getDoctorReviews);

// Payments
router.post("/book-appointment", authMiddleware, requireUser, createBooking);
router.post("/verify-payment", authMiddleware, requireUser, verifyPayment);
router.post("/verify-stripe-payment", authMiddleware, requireUser, verifyStripePayment);

export default router;
