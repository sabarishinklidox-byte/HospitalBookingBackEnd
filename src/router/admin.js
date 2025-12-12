// src/routes/admin.routes.js
import express from 'express';
import { adminLogin } from '../controllers/adminAuthController.js';
import { getAdminDashboard } from '../controllers/adminDashboardController.js';
import { authMiddleware, requireAdmin, requireAdminOrSuperAdmin } from '../middleware/auth.js';

import {
  createDoctor,
  getDoctors,
  updateDoctor,
  toggleDoctorActive,
} from '../controllers/adminDoctorController.js';
import {
  createSlot,
  getSlots,
  updateSlot,
  deleteSlot,
  createBulkSlots,
} from '../controllers/adminSlotController.js';
import {
  getAppointments,
  cancelAppointment,
  updateAppointmentStatus,
  getAppointmentDetails,
  exportAppointmentsExcel,
  exportAppointmentsPdf,
} from '../controllers/adminAppointmentController.js';
import {
  getPayments,
  getPaymentsSummary,
} from '../controllers/adminPaymentController.js';
import { getPatientHistory } from '../controllers/adminPatientController.js';
import {
  getAdminProfile,
  updateAdminProfile,
  updateClinicSettings,
  updateClinicGateway,
} from '../controllers/adminProfileController.js';
import { getClinicReviews } from '../controllers/adminReviewController.js';
import { getAuditLogs } from '../controllers/auditController.js';
import {
  getClinicBookingsStats,
  getClinicSlotsUsageStats,
} from '../controllers/clinicAdminAnalyticsController.js';

// ✅ IMPORT GATEWAY CONTROLLER
import { 
  getGatewayConfig, 
  updateGatewayConfig 
} from '../controllers/adminGatewayController.js';

// ✅ Multer upload middleware
import { upload } from '../middleware/upload.js';

const router = express.Router();

// Admin Login Route
router.post('/login', adminLogin);

// Admin dashboard overview
router.get('/dashboard', authMiddleware, requireAdmin, getAdminDashboard);

// Doctors
router.post(
  '/doctors',
  authMiddleware,
  requireAdmin,
  upload.single('avatar'), // 👈 doctor avatar file (optional)
  createDoctor
);

router.get('/doctors', authMiddleware, requireAdmin, getDoctors);

router.put(
  '/doctors/:id',
  authMiddleware,
  requireAdmin,
  upload.single('avatar'), // 👈 allow avatar update
  updateDoctor
);

router.patch(
  '/doctors/:id/toggle',
  authMiddleware,
  requireAdmin,
  toggleDoctorActive
);

// Slots
router.post('/slots', authMiddleware, requireAdmin, createSlot);
router.post('/slots/bulk', authMiddleware, requireAdmin, createBulkSlots);
router.get('/slots', authMiddleware, requireAdmin, getSlots);
router.put('/slots/:id', authMiddleware, requireAdmin, updateSlot);
router.delete('/slots/:id', authMiddleware, requireAdmin, deleteSlot);

// Appointments
router.get('/appointments', authMiddleware, requireAdmin, getAppointments);
router.patch(
  '/appointments/:id/cancel',
  authMiddleware,
  requireAdmin,
  cancelAppointment
);
router.patch(
  '/appointments/:id/status',
  authMiddleware,
  requireAdmin,
  updateAppointmentStatus
);
router.get(
  '/appointments/:id',
  authMiddleware,
  requireAdmin,
  getAppointmentDetails
);

// Payments (Transaction History)
router.get('/payments', authMiddleware, requireAdmin, getPayments);
router.get(
  '/payments/summary',
  authMiddleware,
  requireAdmin,
  getPaymentsSummary
);

// Patients
router.get(
  '/patients/:userId/history',
  authMiddleware,
  requireAdmin,
  getPatientHistory
);

// Profile & Settings
router.get('/profile', authMiddleware, requireAdmin, getAdminProfile);
router.patch('/profile', authMiddleware, requireAdmin, updateAdminProfile);
router.patch('/clinic', authMiddleware, requireAdmin, updateClinicSettings);
// Note: 'updateClinicGateway' (singular) might be deprecated if it was for the old method. 
// We are using the new routes below for Stripe specifically.

// ✅ NEW PAYMENT GATEWAY CONFIG ROUTES
router.get('/gateway/stripe', authMiddleware, requireAdmin, getGatewayConfig);
router.post('/gateway/stripe', authMiddleware, requireAdmin, updateGatewayConfig);

// Reviews
router.get('/reviews', authMiddleware, requireAdmin, getClinicReviews);

// Audit logs
router.get('/audit-logs', authMiddleware, requireAdminOrSuperAdmin, getAuditLogs);

// Analytics
router.get(
  '/analytics/bookings',
  authMiddleware,
  requireAdmin,
  getClinicBookingsStats
);
router.get(
  '/analytics/slots-usage',
  authMiddleware,
  requireAdmin,
  getClinicSlotsUsageStats
);

// Appointments export
router.get(
  '/appointments/export/excel',
  authMiddleware,
  requireAdmin,
  exportAppointmentsExcel
);

router.get(
  '/appointments/export/pdf',
  authMiddleware,
  requireAdmin,
  exportAppointmentsPdf
);

export default router;
