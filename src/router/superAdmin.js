import { Router } from 'express';
import {
  createDefaultSuperAdmin,
  superAdminLogin,
  createClinic,
  getClinics,
  getClinicAdmins,
  updateClinic,
  deleteClinic,
  createClinicAdmin,
  updateClinicAdmin,
  deleteClinicAdmin,
  getClinicById,
  getGlobalBookingsStats,
  getAnalytics,
  listClinicsForAdmin,
  incrementClinicLinkClicks,
  toggleClinicStatus,
  toggleAuditPermission,
  getClinicAdminById,
} from '../controllers/superAdminController.js';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/setup', createDefaultSuperAdmin);
router.post('/login', superAdminLogin);

// Protected – clinics
router.post('/clinics', authMiddleware, requireSuperAdmin, createClinic);
router.get('/clinics', authMiddleware, requireSuperAdmin, getClinics);
router.get('/clinics/:id', authMiddleware, requireSuperAdmin, getClinicById);
router.patch('/clinics/:id', authMiddleware, requireSuperAdmin, updateClinic);
router.delete('/clinics/:id', authMiddleware, requireSuperAdmin, deleteClinic);

router.patch(
  '/clinics/:clinicId/status',
  authMiddleware,
  requireSuperAdmin,
  toggleClinicStatus
);

router.patch(
  '/clinics/:clinicId/audit-permission',
  authMiddleware,
  requireSuperAdmin,
  toggleAuditPermission
);

router.post(
  '/clinics/:clinicId/link-click',
  authMiddleware,
  requireSuperAdmin,
  incrementClinicLinkClicks
);

// Lightweight options list for dropdowns (different path to avoid conflict)
router.get(
  '/clinics/options',
  authMiddleware,
  requireSuperAdmin,
  listClinicsForAdmin
);

// Protected – clinic admins
router.post('/admins', authMiddleware, requireSuperAdmin, createClinicAdmin);
router.get('/admins', authMiddleware, requireSuperAdmin, getClinicAdmins);
router.get('/admins/:id', authMiddleware, requireSuperAdmin, getClinicAdminById);
router.patch('/admins/:id', authMiddleware, requireSuperAdmin, updateClinicAdmin);
router.delete('/admins/:id', authMiddleware, requireSuperAdmin, deleteClinicAdmin);

// Analytics
router.get('/analytics', authMiddleware, requireSuperAdmin, getAnalytics);
router.get(
  '/analytics/global-bookings',
  authMiddleware,
  requireSuperAdmin,
  getGlobalBookingsStats
);

export default router;
