import express from 'express';
import fs from 'fs';
import path from 'path';
import { upload } from '../middleware/upload.js'; // Uses Disk Storage
import { authMiddleware, requireSuperAdmin } from '../middleware/auth.js';

const router = express.Router();

// Ensure the specific clinics folder exists
const CLINIC_UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'clinics');
if (!fs.existsSync(CLINIC_UPLOAD_DIR)) {
  fs.mkdirSync(CLINIC_UPLOAD_DIR, { recursive: true });
}

router.post(
  '/super-admin/clinics/upload-image', // Ensure this matches your frontend API call
  // authMiddleware,     // Uncomment these when ready
  // requireSuperAdmin, 
  upload.single('file'), 
  async (req, res) => {
    try {
      // 1. Check if Multer processed the file
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      // 2. The file is currently saved in 'uploads/' (from middleware)
      // We want to move it to 'uploads/clinics/'
      const tempPath = req.file.path;
      const targetPath = path.join(CLINIC_UPLOAD_DIR, req.file.filename);

      // Move the file
      fs.renameSync(tempPath, targetPath);

      // 3. Return the URL
      // Ensure your app.js has: app.use('/uploads', express.static('uploads'));
      const url = `/uploads/clinics/${req.file.filename}`;
      
      return res.json({ url });

    } catch (err) {
      console.error('Clinic media upload error', err);
      return res.status(500).json({ error: 'Upload failed' });
    }
  }
);

export default router;
