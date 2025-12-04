import express from 'express';
import { adminLogin } from '../controllers/adminAuthController.js';
import{getAdminDashboard} from '../controllers/adminDashboardController.js'
import { authMiddleware, requireAdmin } from '../middleware/auth.js';
import {
createDoctor,
getDoctors,
updateDoctor,
toggleDoctorActive
} from '../controllers/adminDoctorController.js';
import {
createSlot,
getSlots,
updateSlot,
deleteSlot,createBulkSlots
} from '../controllers/adminSlotController.js';
import {
getAppointments,
cancelAppointment,
updateAppointmentStatus,getAppointmentDetails
} from '../controllers/adminAppointmentController.js';
import {
getPayments,
getPaymentsSummary
} from '../controllers/adminPaymentController.js';
import { getPatientHistory } from '../controllers/adminPatientController.js';
import {
getAdminProfile,
updateAdminProfile,
updateClinicSettings,
updateClinicGateway,
} from '../controllers/adminProfileController.js';


const router = express.Router();

// Admin Login Route
router.post('/login', adminLogin);


// Admin dashboard overview
router.get('/dashboard', authMiddleware, requireAdmin, getAdminDashboard);
router.post('/doctors', authMiddleware, requireAdmin, createDoctor);
router.get('/doctors', authMiddleware, requireAdmin, getDoctors);
router.put('/doctors/:id', authMiddleware, requireAdmin, updateDoctor);
router.patch('/doctors/:id/toggle', authMiddleware, requireAdmin, toggleDoctorActive);
router.post('/slots', authMiddleware, requireAdmin, createSlot);
router.get('/slots', authMiddleware, requireAdmin, getSlots);
router.put('/slots/:id', authMiddleware, requireAdmin, updateSlot);
router.delete('/slots/:id', authMiddleware, requireAdmin, deleteSlot);
// Appointment monitoring
router.get('/appointments', authMiddleware, requireAdmin, getAppointments);
router.patch('/appointments/:id/cancel', authMiddleware, requireAdmin, cancelAppointment);
router.patch('/appointments/:id/status', authMiddleware, requireAdmin, updateAppointmentStatus);
router.get('/appointments/:id', authMiddleware, requireAdmin, getAppointmentDetails);
router.get('/payments', authMiddleware, requireAdmin, getPayments);

// Revenue summary (clinic total + per doctor)
router.get('/payments/summary', authMiddleware, requireAdmin, getPaymentsSummary);
router.get(
'/patients/:userId/history',
authMiddleware,
requireAdmin,
getPatientHistory
);
router.get('/profile', authMiddleware, requireAdmin, getAdminProfile);
router.patch('/profile', authMiddleware, requireAdmin, updateAdminProfile);
router.patch('/clinic', authMiddleware, requireAdmin, updateClinicSettings);
router.patch(
'/clinic/gateway',
authMiddleware,
requireAdmin,
updateClinicGateway
);
router.post('/slots/bulk', authMiddleware, requireAdmin,createBulkSlots);

export default router;