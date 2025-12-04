import { Router } from 'express';
import {
  doctorLogin,
  getDoctorProfile,
  getDoctorSlots,
  getDoctorAppointments,
  updateDoctorProfile,
  updateDoctorAppointmentStatus, getAppointmentDetails,getDoctorDashboardStats
} from '../controllers/doctorController.js';
import { authMiddleware, requireDoctor } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/login', doctorLogin);

// Protected Doctor routes
router.get('/profile', authMiddleware, requireDoctor, getDoctorProfile);
router.get('/slots', authMiddleware, requireDoctor, getDoctorSlots);
router.get('/appointments', authMiddleware, requireDoctor, getDoctorAppointments);
router.patch('/appointments/:id/status', authMiddleware, requireDoctor, updateDoctorAppointmentStatus);
router.patch('/profile', authMiddleware, requireDoctor, updateDoctorProfile); 
router.get('/appointments/:id', authMiddleware, requireDoctor, getAppointmentDetails)
router.get('/dashboard-stats', authMiddleware, requireDoctor, getDoctorDashboardStats);
export default router;
