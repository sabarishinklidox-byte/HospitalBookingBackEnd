import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Routes (correct paths)
import superAdminRoutes from './router/superAdmin.js';
import doctorRoutes from './router/doctor.js';
import adminRoutes from './router/admin.js';
import publicRoutes from './router/public.js';
import userRoutes from './router/user.js';

dotenv.config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/super-admin', superAdminRoutes);
app.use('/api/doctor', doctorRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/user', userRoutes);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
