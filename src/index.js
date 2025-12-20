import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import paymentRoutes from './router/paymentroutes.js';
import superAdminRoutes from './router/superAdmin.js';
import doctorRoutes from './router/doctor.js';
import adminRoutes from './router/admin.js';
import publicRoutes from './router/public.js';
import userRoutes from './router/user.js';
import superAdminClinicMediaRoutes from './router/superAdminClinicMediaRoutes.js';
import { startReminderJob } from './services/reminderService.js'; 
dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// API routes
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/user', userRoutes);
app.use('/api', superAdminClinicMediaRoutes); // <- add this
startReminderJob();

// ...
app.use('/api/payment', paymentRoutes);
// Static files for uploaded images
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

console.log('EMAIL_USER =', process.env.EMAIL_USER);
console.log('EMAIL_PASS =', process.env.EMAIL_PASS);
