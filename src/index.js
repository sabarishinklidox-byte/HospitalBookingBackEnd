  import express from 'express';
  import cors from 'cors';
  import dotenv from 'dotenv';
  import path from 'path';

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

  dotenv.config();

  const app = express();

  // ✅ MIDDLEWARE - CRITICAL ORDER!
app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:3000',
    'http://localhost:5173',     // ✅ Vite dev server
    'http://127.0.0.1:5173'      // ✅ Vite IP binding
  ],
  credentials: true
}));
  // ✅ RAW JSON for webhooks FIRST (before express.json!)
  app.use('/api/webhooks', webhookRoutes);  // ✅ Webhooks (raw body!)

  app.use(express.json({ limit: '10mb' }));
  app.use(express.raw({ type: 'application/json' }));  // ✅ Fallback raw parser

  // ✅ ALL API ROUTES
  app.use('/api/super-admin', superAdminRoutes);
  app.use('/api/doctor', doctorRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/public', publicRoutes);
  app.use('/api/user', userRoutes);
  app.use('/api/payment', paymentRoutes);
  app.use('/api', superAdminClinicMediaRoutes);  // ✅ Fixed path

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

  // ✅ 404 handler
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

  const PORT = process.env.PORT || 5000;
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
