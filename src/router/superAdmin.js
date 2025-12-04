import { Router } from 'express';
import {
createDefaultSuperAdmin,
superAdminLogin,
createClinic,
getClinics,
getClinicAdmins,
updateClinic,
deleteClinic,
createClinicAdmin
, updateClinicAdmin ,deleteClinicAdmin,getClinicById

} from '../controllers/superAdminController.js';
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/setup', createDefaultSuperAdmin);
router.post('/login', superAdminLogin);

// Protected
router.post('/clinics', authMiddleware, requireSuperAdmin, createClinic);
router.get('/clinics', authMiddleware, requireSuperAdmin, getClinics);
router.get('/clinics/:id', authMiddleware, requireSuperAdmin, getClinicById);
router.patch('/clinics/:id', authMiddleware, requireSuperAdmin, updateClinic);
router.delete('/clinics/:id', authMiddleware, requireSuperAdmin, deleteClinic);

router.post('/admins', authMiddleware, requireSuperAdmin, createClinicAdmin);
router.get('/admins', authMiddleware, requireSuperAdmin, getClinicAdmins);
router.patch('/admins/:id', authMiddleware, requireSuperAdmin, updateClinicAdmin);
router.delete('/admins/:id', authMiddleware, requireSuperAdmin, deleteClinicAdmin);

export default router;
