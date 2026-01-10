import { Router } from 'express';
import {
  doctorLogin,
  getDoctorProfile,
  getDoctorSlots,
  getDoctorAppointments,
  updateDoctorProfile,
  updateDoctorAppointmentStatus, getAppointmentDetails,getDoctorDashboardStats,getMyReviews,getAvailableSlots
} from '../controllers/doctorController.js';
import{updatePrescription} from '../controllers/doctorAppointmentController.js'
import { authMiddleware, requireDoctor } from '../middleware/auth.js';

const router = Router();

// Public
router.post('/login', doctorLogin);

// Protected Doctor routes
router.get('/profile', authMiddleware, requireDoctor, getDoctorProfile);
router.get('/slots', authMiddleware, requireDoctor, getDoctorSlots);
router.get('/appointments', authMiddleware, requireDoctor, getDoctorAppointments);
router.patch('/appointments/:id/status', authMiddleware, requireDoctor, updateDoctorAppointmentStatus);
router.patch('/profile', authMiddleware, requireDoctor, updateDoctorProfile); 
router.get('/appointments/:id', authMiddleware, requireDoctor, getAppointmentDetails)
router.get('/dashboard-stats', authMiddleware, requireDoctor, getDoctorDashboardStats);
router.get('/reviews', authMiddleware,requireDoctor, getMyReviews);
router.patch('/appointments/:id/prescription',authMiddleware,requireDoctor,updatePrescription);
router.get('/available-slots', authMiddleware, requireDoctor, getAvailableSlots);
router.get('/google-calendar/connect', async (req, res) => {
  const { doctorId } = req.query;
  
  if (!doctorId) return res.status(400).json({ error: "Doctor ID required" });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    // This MUST match exactly what is in your Google Cloud Console
    redirect_uri: `${process.env.BACKEND_URL}/api/doctor/google-calendar/callback`,
    scope: 'https://www.googleapis.com/auth/calendar.events',
    response_type: 'code',
    state: doctorId,
    access_type: 'offline',
    prompt: 'consent'
  });
  
  console.log('🔗 Redirecting Doctor to Google Auth...');
  res.redirect(authUrl);
});

router.get('/google-calendar/callback', async (req, res) => {
  const { code, state: doctorId } = req.query;
  
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${process.env.BACKEND_URL}/api/doctor/google-calendar/callback`,
        code,
        grant_type: 'authorization_code'
      })
    });
    
    const tokens = await tokenRes.json();
    
    await prisma.doctor.update({
      where: { id: doctorId },
      data: {
        googleCalendarId: 'primary',
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token,
      }
    });
    
    console.log('✅ Doctor tokens saved:', doctorId);
    // Redirect back to the Frontend (Vite) URL
    res.redirect(`${process.env.CLIENT_URL}/doctor/dashboard?gcal=success`);
  } catch (error) {
    console.error('❌ Doctor callback:', error);
    res.redirect(`${process.env.CLIENT_URL}/doctor/dashboard?gcal=error`);
  }
});
// src/routes/doctorRoutes.js

router.post('/google-calendar/disconnect', async (req, res) => {
  const { doctorId } = req.body;

  try {
    await prisma.doctor.update({
      where: { id: doctorId },
      data: {
        googleCalendarId: null,
        googleAccessToken: null,
        googleRefreshToken: null,
      }
    });

    res.json({ message: "Successfully disconnected Google Calendar" });
  } catch (error) {
    console.error('❌ Disconnect Error:', error);
    res.status(500).json({ error: "Failed to disconnect" });
  }
});
export default router;
