import { Router } from 'express';
import {
  getClinics,
  getDoctorsByClinic,
  getSlotsByDoctor,getDoctorById,getPublicClinicById
} from '../controllers/publicController.js';
import {forgotPassword,resetPassword} from '../controllers/authController.js'
const router = Router();

router.get('/clinics', getClinics);
router.get('/clinics/:clinicId/doctors', getDoctorsByClinic);
router.get('/doctors/:doctorId/slots', getSlotsByDoctor);
router.get('/doctors/:id', getDoctorById); 
router.get('/clinics/:id', getPublicClinicById);


     router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

export default router;
