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
  getDoctorSlotsWindow,getManageableSlots, blockSlot, unblockSlot
} from '../controllers/adminSlotController.js';

import {
  getAppointments,
  cancelAppointment,
  updateAppointmentStatus,
  getAppointmentDetails,
  exportAppointmentsExcel,
  exportAppointmentsPdf,
  rescheduleAppointmentByAdmin,
  processCancellationRequest,
   googleCalendarSync,
  // deleteGoogleCalendarEvent,
  // googleCalendarResync
} from '../controllers/adminAppointmentController.js';

import { refreshClinicGoogleRating } from '../controllers/clinicController.js';
 import {verifyClinicPlanPayment} from '../controllers/superAdminPlanPaymentController.js'
import {
  getPayments,
  getPaymentsSummary
} from '../controllers/adminPaymentController.js';

import { getPatientHistory ,getPatientHistoryDetailed} from '../controllers/adminPatientController.js';

import {
  getAdminProfile,
  updateAdminProfile,
  updateClinicSettings,
 
} from '../controllers/adminProfileController.js';
import { 
  createSpeciality, 
  getAllSpecialities, 
  getSpecialityById, 
  updateSpeciality, 
  deleteSpeciality 
} from '../controllers/specialitycontroller.js';

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
  getActiveGatewayForClinic,
} from '../controllers/adminGatewayController.js';


import { upload } from '../middleware/upload.js';
import { requireActiveSubscription } from '../middleware/subscription.js';
const router = express.Router();

// ---------------- Auth ----------------
router.post('/login', adminLogin);


// ---------------- Dashboard (OPEN - View Only) ----------------
router.get('/dashboard', authMiddleware, requireAdmin, getAdminDashboard);

// ---------------- Doctors (RESTRICTED WRITE) ----------------
router.post(
  '/doctors',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  upload.single('avatar'),
  createDoctor
);
router.post('/webhook/verify-plan-payment', 
  express.raw({type: 'application/json'}),  // Raw body for signature
  verifyClinicPlanPayment
);
router.get('/doctors', authMiddleware, requireAdmin, getDoctors); // ✅ Open (View only)

router.put(
  '/doctors/:id',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  upload.single('avatar'),
  updateDoctor
);

router.patch(
  '/doctors/:id/toggle',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  toggleDoctorActive
);
router.get('/specialities', authMiddleware, requireAdmin, getAllSpecialities);
router.get('/specialities/:id', authMiddleware, requireAdmin, getSpecialityById);

// WRITE is restricted to active subscriptions
router.post(
  '/specialities', 
  authMiddleware, 
  requireAdmin, 
  requireActiveSubscription, 
  createSpeciality
);

router.put(
  '/specialities/:id', 
  authMiddleware, 
  requireAdmin, 
  requireActiveSubscription, 
  updateSpeciality
);

router.delete(
  '/specialities/:id', 
  authMiddleware, 
  requireAdmin, 
  requireActiveSubscription, 
  deleteSpeciality
);
// ---------------- Slots (RESTRICTED WRITE) ----------------
router.post('/slots', authMiddleware, requireAdmin, requireActiveSubscription, createSlot); // 🔒
router.post('/slots/bulk', authMiddleware, requireAdmin, requireActiveSubscription, createBulkSlots); // 🔒
router.get('/slots', authMiddleware, requireAdmin, getSlots); // ✅ Open
router.put('/slots/:id', authMiddleware, requireAdmin, requireActiveSubscription, updateSlot); // 🔒
router.delete('/slots/:id', authMiddleware, requireAdmin, requireActiveSubscription, deleteSlot); // 🔒

// Slot Management
router.get('/slots/manage', authMiddleware, requireAdmin, getManageableSlots); // ✅ Open
router.post('/slots/:slotId/block', authMiddleware, requireAdmin, requireActiveSubscription, blockSlot); // 🔒
router.post('/slots/:slotId/unblock', authMiddleware, requireAdmin, requireActiveSubscription, unblockSlot); // 🔒

router.get(
  '/doctors/:doctorId/slots',
  authMiddleware,
  requireAdmin,
  getDoctorSlotsWindow
);

// ---------------- Appointments (PARTIALLY RESTRICTED) ----------------
router.get('/appointments', authMiddleware, requireAdmin, getAppointments); // ✅ Open

router.patch(
  '/appointments/:id/cancel',
  authMiddleware,
  requireAdmin,
  cancelAppointment // ✅ Open (Allow cleanup)
);

router.patch(
  '/appointments/:id/status',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED (Cannot complete visits)
  updateAppointmentStatus
);

router.get(
  '/appointments/:id',
  authMiddleware,
  requireAdmin,
  getAppointmentDetails
);

router.patch(
  '/appointments/:id/reschedule',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED (Cannot rebook)
  rescheduleAppointmentByAdmin
);

// ---------------- Payments (History - OPEN) ----------------
router.get('/payments', authMiddleware, requireAdmin, getPayments);
router.get('/payments/summary', authMiddleware, requireAdmin, getPaymentsSummary);
router.get(
  "/patients/:userId/history",
  authMiddleware,
  requireAdmin,
  getPatientHistoryDetailed
);

// ---------------- Patients (History - OPEN) ----------------
router.get(
  '/patients/:userId/history',
  authMiddleware,
  requireAdmin,
  getPatientHistory
);

// ---------------- Profile & Settings (OPEN) ----------------
// Keep these open so they can update contact info or fix payment gateways
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

router.get('/payment-settings', authMiddleware, requireAdmin, getGatewayConfig);
router.get('/payment-settings/active', authMiddleware, requireAdmin, getActiveGatewayForClinic);
router.post('/payment-settings', authMiddleware, requireAdmin, updateGatewayConfig);

// ---------------- Reviews (OPEN) ----------------
router.get('/reviews', authMiddleware, requireAdmin, getClinicReviews);

// ---------------- Audit logs (OPEN) ----------------
router.get(
  '/audit-logs',
  authMiddleware,
  requireAdminOrSuperAdmin,
  getAuditLogs
);

// ---------------- Analytics (RESTRICTED - Premium) ----------------
router.get(
  '/analytics/bookings',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  getClinicBookingsStats
);

router.get(
  '/analytics/slots-usage',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  getClinicSlotsUsageStats
);

// ---------------- Exports (RESTRICTED - Premium) ----------------
router.get(
  '/appointments/export/excel',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  exportAppointmentsExcel
);

router.get(
  '/appointments/export/pdf',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  exportAppointmentsPdf
);

// ---------------- Subscription (OPEN - Critical) ----------------
// Must be open so they can pay to unlock account
router.post(
  '/subscription/upgrade',
  authMiddleware,
  requireAdmin,
  upgradeClinicPlan
);

// Google Rating Refresh (Restrict to prevent spam if expired)
router.post(
  '/clinic/google-rating/refresh',
  authMiddleware,
  requireAdmin,
  requireActiveSubscription, // 🔒 BLOCKED
  refreshClinicGoogleRating
);
router.post(
  '/appointments/:id/google-calendar-sync', 
  authMiddleware, 
  requireAdmin, 
  requireActiveSubscription,  // 🔒 Pro only
  googleCalendarSync
);

// router.delete(
//   '/appointments/:id/google-calendar-event', 
//   authMiddleware, 
//   requireAdmin, 
//   requireActiveSubscription,  // 🔒 Pro only
//   deleteGoogleCalendarEvent
// );

// router.patch(
//   '/appointments/:id/google-calendar-resync', 
//   authMiddleware, 
//   requireAdmin, 
//   requireActiveSubscription,  // 🔒 Pro only
//   googleCalendarResync
// );
// ---------------- Notifications (OPEN) ----------------
router.get('/notifications', authMiddleware, requireAdmin, getNotifications);
router.get('/notifications/unread-count', authMiddleware, requireAdmin, getUnreadCount);
router.patch('/notifications/mark-all-read', authMiddleware, requireAdmin, markAllRead);
router.patch('/notifications/mark-read', authMiddleware, requireAdmin, markReadByIds);
router.patch('/notifications/mark-read-by-entity', authMiddleware, requireAdmin, markReadByEntity);

router.post(
  '/cancellation-process', 
  authMiddleware, 
  requireAdmin, // 🔒 CRITICAL: Only Admins can approve refunds
  processCancellationRequest
);

export default router;


