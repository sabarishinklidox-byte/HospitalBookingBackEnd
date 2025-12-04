import { Router } from 'express';
import {
  getClinics,
  getDoctorsByClinic,
  getSlotsByDoctor,getDoctorById,getPublicClinicById
} from '../controllers/publicController.js';

const router = Router();

router.get('/clinics', getClinics);
router.get('/clinics/:clinicId/doctors', getDoctorsByClinic);
router.get('/doctors/:doctorId/slots', getSlotsByDoctor);
router.get('/doctors/:id', getDoctorById); 
router.get('/clinics/:id', getPublicClinicById);




export default router;
