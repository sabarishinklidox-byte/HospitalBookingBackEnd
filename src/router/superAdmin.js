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
  getClinicAdminById,toggleClinicVisibility 
} from '../controllers/superAdminController.js';
import {
  listPlans,
  createPlan,
  updatePlan,
  deletePlan,
} from '../controllers/planController.js';
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
router.patch(
  '/clinics/:id/toggle-public', // :id refers to the Clinic ID
  authMiddleware,               // 1. Verify Token (sets req.user)
  requireSuperAdmin,            // 2. Verify Role (checks SUPER_ADMIN)
  toggleClinicVisibility        // 3. Execute Controller
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
router.get('/plans', authMiddleware, requireSuperAdmin, listPlans);
router.post('/plans', authMiddleware, requireSuperAdmin, createPlan);
router.put('/plans/:id', authMiddleware, requireSuperAdmin, updatePlan);
router.delete('/plans/:id', authMiddleware, requireSuperAdmin, deletePlan);

router.get('/plans', authMiddleware, requireSuperAdmin, listPlans);
router.post('/plans', authMiddleware, requireSuperAdmin, createPlan);
router.put('/plans/:id', authMiddleware, requireSuperAdmin, updatePlan);
router.delete('/plans/:id', authMiddleware, requireSuperAdmin, deletePlan);

export default router;
