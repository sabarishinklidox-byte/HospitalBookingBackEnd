// src/routes/admin.routes.js
import express from 'express';
import { adminLogin } from '../controllers/adminAuthController.js';
import { getAdminDashboard } from '../controllers/adminDashboardController.js';
import {
  authMiddleware,
  requireAdmin,
  requireAdminOrSuperAdmin,
} from '../middleware/auth.js';
import {
  getNotifications,
  getUnreadCount,
  markAllRead,
  markReadByIds,markReadByEntity
} from '../controllers/adminNotificationController.js';

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
  getDoctorSlotsForReschedule,
  getDoctorSlotsWindow,
} from '../controllers/adminSlotController.js';

import {
  getAppointments,
  cancelAppointment,
  updateAppointmentStatus,
  getAppointmentDetails,
  exportAppointmentsExcel,
  exportAppointmentsPdf,
  rescheduleAppointmentByAdmin,
} from '../controllers/adminAppointmentController.js';

import { refreshClinicGoogleRating } from '../controllers/clinicController.js';

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

import { upgradeClinicPlan } from '../controllers/adminSubscriptionController.js';

import {
  getGatewayConfig,
  updateGatewayConfig,
} from '../controllers/adminGatewayController.js';

import { upload } from '../middleware/upload.js';

const router = express.Router();

// ---------------- Auth ----------------
router.post('/login', adminLogin);

// ---------------- Dashboard ----------------
router.get('/dashboard', authMiddleware, requireAdmin, getAdminDashboard);

// ---------------- Doctors ----------------
router.post(
  '/doctors',
  authMiddleware,
  requireAdmin,
  upload.single('avatar'),
  createDoctor
);

router.get('/doctors', authMiddleware, requireAdmin, getDoctors);

router.put(
  '/doctors/:id',
  authMiddleware,
  requireAdmin,
  upload.single('avatar'),
  updateDoctor
);

router.patch(
  '/doctors/:id/toggle',
  authMiddleware,
  requireAdmin,
  toggleDoctorActive
);

// ---------------- Slots ----------------
router.post('/slots', authMiddleware, requireAdmin, createSlot);
router.post('/slots/bulk', authMiddleware, requireAdmin, createBulkSlots);
router.get('/slots', authMiddleware, requireAdmin, getSlots);
router.put('/slots/:id', authMiddleware, requireAdmin, updateSlot);
router.delete('/slots/:id', authMiddleware, requireAdmin, deleteSlot);

// doctor slots window for reschedule UI (Today/Tomorrow/next days)
router.get(
  '/doctors/:doctorId/slots',
  authMiddleware,
  requireAdmin,
  getDoctorSlotsWindow   // or getDoctorSlotsForReschedule if you prefer that logic
);

// ---------------- Appointments ----------------
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

// ✅ Reschedule (no extra /admin segment)
router.patch(
  '/appointments/:id/reschedule',
  authMiddleware,
  requireAdmin,
  rescheduleAppointmentByAdmin
);

// ---------------- Payments ----------------
router.get('/payments', authMiddleware, requireAdmin, getPayments);

router.get(
  '/payments/summary',
  authMiddleware,
  requireAdmin,
  getPaymentsSummary
);

// ---------------- Patients ----------------
router.get(
  '/patients/:userId/history',
  authMiddleware,
  requireAdmin,
  getPatientHistory
);

// ---------------- Profile & Settings ----------------
router.get('/profile', authMiddleware, requireAdmin, getAdminProfile);
router.patch('/profile', authMiddleware, requireAdmin, updateAdminProfile);

router.patch(
  '/clinic',
  authMiddleware,
  requireAdmin,
  upload.fields([
    { name: 'logo', maxCount: 1 },
    { name: 'banner', maxCount: 1 },
  ]),
  updateClinicSettings
);

router.patch(
  '/clinic/gateway',
  authMiddleware,
  requireAdmin,
  updateClinicGateway
);

// Stripe gateway config
router.get('/gateway/stripe', authMiddleware, requireAdmin, getGatewayConfig);
router.post('/gateway/stripe', authMiddleware, requireAdmin, updateGatewayConfig);

// ---------------- Reviews ----------------
router.get('/reviews', authMiddleware, requireAdmin, getClinicReviews);

// ---------------- Audit logs ----------------
  router.get(
    '/audit-logs',
    authMiddleware,
    requireAdminOrSuperAdmin,
    getAuditLogs
  );

// ---------------- Analytics ----------------
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

// ---------------- Exports ----------------
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

// ---------------- Subscription & misc ----------------
router.post(
  '/subscription/upgrade',
  authMiddleware,
  requireAdmin,
  upgradeClinicPlan
);

router.post(
  '/clinic/google-rating/refresh',
  authMiddleware,
  requireAdmin,
  refreshClinicGoogleRating
);
// ---------------- Notifications ----------------
router.get(
  '/notifications',
  authMiddleware,
  requireAdmin,
  getNotifications
);

router.get(
  '/notifications/unread-count',
  authMiddleware,
  requireAdmin,
  getUnreadCount
);

router.patch(
  '/notifications/mark-all-read',
  authMiddleware,
  requireAdmin,
  markAllRead
);

router.patch(
  '/notifications/mark-read',
  authMiddleware,
  requireAdmin,
  markReadByIds
);
router.patch('/notifications/mark-read-by-entity',  authMiddleware,
  requireAdmin, markReadByEntity);



export default router;
