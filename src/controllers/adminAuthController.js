import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { logAudit } from '../utils/audit.js'; // Optional: Add audit log

// CLINIC ADMIN LOGIN
export const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      include: { clinic: true } // Check clinic status too
    });

    // 1. Check User Existence & Role
    if (!user || user.role !== 'ADMIN') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 2. ✅ Check Soft Delete (User)
    if (user.deletedAt) {
      return res.status(403).json({ error: 'Account has been deactivated/deleted.' });
    }

    // 3. ✅ Check Clinic Status (Is it deleted?)
    if (user.clinic && user.clinic.deletedAt) {
      return res.status(403).json({ error: 'Your clinic account is inactive.' });
    }

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { userId: user.id, role: user.role, clinicId: user.clinicId },
      process.env.JWT_SECRET,
      { expiresIn: '6h' }
    );

    // Optional: Log Audit
    try {
        await logAudit({
            userId: user.id,
            clinicId: user.clinicId,
            action: 'ADMIN_LOGIN',
            entity: 'User',
            entityId: user.id,
            req
        });
    } catch(e) { console.error("Audit log failed", e); }

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        clinicId: user.clinicId
      }
    });
  } catch (error) {
    console.error('Admin Login Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
