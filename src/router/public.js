import { Router } from 'express';
import {
  getClinics,
  getDoctorsByClinic,
  getSlotsByDoctor,getDoctorById,getPublicClinicById,getSlotsForUser,
} from '../controllers/publicController.js';
import { registerOrganization } from '../controllers/publicOrganizationController.js';
import {forgotPassword,resetPassword} from '../controllers/authController.js'
import { listPublicPlans } from '../controllers/publicPlansController.js';
import { getPlaceIdFromText } from '../controllers/publicGoogleController.js';
const router = Router();

router.get('/clinics', getClinics);
router.get('/clinics/:clinicId/doctors', getDoctorsByClinic);
router.get('/doctors/:doctorId/slots', getSlotsByDoctor);
router.get('/doctors/:id', getDoctorById); 
router.get('/clinics/:id', getPublicClinicById);


     router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/organizations/register', registerOrganization);
router.get('/plans', listPublicPlans);  
router.get('/google/place-id', getPlaceIdFromText);
router.get("/slots", getSlotsForUser);
export default router;
