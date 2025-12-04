import { Router } from 'express';
import {
  userSignup,
  userLogin,
  bookAppointment,
  getUserAppointments,
  getUserProfile,
  updateUserProfile,
  getUserAppointmentHistory,cancelUserAppointment
} from '../controllers/userController.js';

import { authMiddleware, requireUser } from '../middleware/auth.js';

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

export default router;
