  import express from 'express';
  import cors from 'cors';
  import dotenv from 'dotenv';
  import path from 'path';
import cron from 'node-cron';
import './cron/cleanup.js'; 
import fetch from 'node-fetch'

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient()
  // ✅ ROUTES
  import paymentRoutes from './router/paymentroutes.js';
  import superAdminRoutes from './router/superAdmin.js';
  import doctorRoutes from './router/doctor.js';
  import adminRoutes from './router/admin.js';
  import publicRoutes from './router/public.js';
  import userRoutes from './router/user.js';
  import webhookRoutes from './router/webhooks.js';           // ✅ NEW: Webhooks!
  import superAdminClinicMediaRoutes from './router/superAdminClinicMediaRoutes.js';
  import { startReminderJob } from './services/reminderService.js'; 
import { runExpirationCheck } from './controllers/cronController.js';
import { startSubscriptionEmailCron } from "./jobs/startSubscriptionEmailCron.js"

  dotenv.config();

  const app = express();

  // ✅ MIDDLEWARE - CRITICAL ORDER!
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:5173',     // ✅ Vite dev server
    'http://127.0.0.1:5173' ,"http://192.168.29.118:5173"     // ✅ Vite IP binding
  ],
  credentials: true
}));
// Ensure there is a leading / before api
app.get('/api/clinic/google-calendar/connect', async (req, res) => {
  const { clinicId } = req.query;
  
  if (!clinicId) return res.status(400).json({ error: "Clinic ID is required" });

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` + new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    // Note: redirect_uri must match your Google Console exactly
    redirect_uri: `${process.env.BACKEND_URL}/api/clinic/google-calendar/callback`, 
    scope: 'https://www.googleapis.com/auth/calendar.events',
    response_type: 'code',
    state: clinicId,
    access_type: 'offline',
    prompt: 'consent'
  });
  
  res.redirect(authUrl);
});

  // ✅ RAW JSON for webhooks FIRST (before express.json!)
  app.use('/api/webhooks', webhookRoutes);  // ✅ Webhooks (raw body!)

  app.use(express.json({ limit: '10mb' }));
  app.use(express.raw({ type: 'application/json' }));  // ✅ Fallback raw parser

 
app.get('/api/clinic/google-calendar/callback', async (req, res) => {
  const { code, state: clinicId, error } = req.query;
  
  console.log('🎯 Backend callback HIT:', { code: !!code, clinicId, error });
  
  if (error || !code) {
    console.error('GCal auth failed:', error);
    return res.redirect(`${process.env.CLIENT_URL}/admin/settings?error=gcal_failed`);
  }
  
  try {
    // 🔥 FIXED: Use SAME backend URI as connect route
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        // ✅ SAME AS CONNECT ROUTE
        redirect_uri: `${process.env.BACKEND_URL}/api/clinic/google-calendar/callback`,
        code,
        grant_type: 'authorization_code'
      })
    });
    
    const tokens = await tokenRes.json();
    console.log('✅ Tokens received:', { access: !!tokens.access_token, refresh: !!tokens.refresh_token });
    
    await prisma.clinic.update({
      where: { id: clinicId },
      data: {
        googleCalendarId: 'primary',
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token,
        googleTokenExpiry: new Date(Date.now() + (tokens.expires_in || 3600) * 1000)
      }
    });
    
    console.log('💾 Tokens SAVED to clinic:', clinicId);
    res.redirect(`${process.env.CLIENT_URL}/admin/settings?gcal=success`);
    
  } catch (err) {
    console.error('❌ GCal callback error:', err);
    res.redirect(`${process.env.CLIENT_URL}/admin/settings?error=gcal_error`);
  }
}); 
  // ✅ ALL API ROUTES
  app.use('/api/super-admin', superAdminRoutes);
  app.use('/api/doctor', doctorRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/user', userRoutes);
  app.use('/api/payment', paymentRoutes);
  app.use('/api', superAdminClinicMediaRoutes); 
// ✅ Fixed path

  // ✅ Static files
  app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));
 
  // ✅ Health check
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'OK', 
      timestamp: new Date().toISOString(),
      env: process.env.NODE_ENV || 'development'
    });
  });
// cron.schedule(
//   // '0 * * * *',    
//   '0 * * * *',            // at minute 0 of every hour
//   () => {
//     console.log('Running hourly subscription check...');
//     runExpirationCheck();
//   },
//   { timezone: 'Asia/Kolkata' } // your production timezone
// );
  // ✅ 404 handler
let isRunning = false;

cron.schedule(
  '*/30 * * * * *',
  async () => {
    if (isRunning) {
      console.log('Previous job still running, skipping...');
      return;
    }

    isRunning = true;
    try {
      console.log('Running subscription check...');
      await runExpirationCheck();
    } catch (err) {
      console.error(err);
    } finally {
      isRunning = false;
    }
  },
  { timezone: 'Asia/Kolkata' }
);

  app.use('*', (req, res) => {
    res.status(404).json({ error: 'Route not found' });
  });

  // ✅ Global error handler
  app.use((error, req, res, next) => {
    console.error('Global Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ✅ Start services
  startReminderJob();
  startSubscriptionEmailCron();

  const PORT = process.env.PORT || 5003;
  app.listen(PORT,'0.0.0.0', () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    console.log(`📱 Frontend: ${process.env.FRONTEND_URL || 'http://localhost:3000'}`);
    console.log(`🔗 Webhooks: http://localhost:${PORT}/api/webhooks/razorpay`);
    console.log(`📊 Health: http://localhost:${PORT}/health`);
  });

  // ✅ Hide sensitive logs in production
  if (process.env.NODE_ENV !== 'production') {
    console.log('📧 EMAIL_USER:', process.env.EMAIL_USER ? 'SET' : 'MISSING');
    console.log('🔑 RAZORPAY_KEY_ID:', process.env.RAZORPAY_KEY_ID ? 'SET' : 'MISSING');
    console.log('💳 STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? 'SET' : 'MISSING');
  }



