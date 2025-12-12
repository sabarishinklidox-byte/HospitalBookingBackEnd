// src/routes/superAdminClinicMediaRoutes.js
import express from 'express';
import fs from 'fs';
import path from 'path';
import {upload} from '../middleware/upload.js';              // <- Multer here
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();
const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'clinics');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

router.post(
  '/super-admin/clinics/upload',
  authMiddleware,
  requireSuperAdmin,
  upload.single('file'),                                   // <- Multer used here
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const ext = path.extname(req.file.originalname) || '.png';
      const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
      const filepath = path.join(UPLOAD_DIR, filename);

      fs.writeFileSync(filepath, req.file.buffer);

      const url = `/uploads/clinics/${filename}`;
      return res.json({ url });
    } catch (err) {
      console.error('Clinic media upload error', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  }
);

export default router;
