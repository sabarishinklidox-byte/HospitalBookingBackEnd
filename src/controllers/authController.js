// src/controllers/authController.js
import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { sendResetEmail } from '../utils/emailService.js';

const RESET_SECRET = process.env.JWT_RESET_SECRET || 'super-reset-secret';
const RESET_EXPIRES_IN = '15m';

// POST /api/user/forgot-password
export const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.json({
        message: 'If an account exists, a reset link has been sent',
      });
    }

    const token = jwt.sign(
      {
        userId: user.id,
        passwordHash: user.password,
      },
      RESET_SECRET,
      { expiresIn: RESET_EXPIRES_IN }
    );

    const resetLink = `${
      process.env.CLIENT_URL || 'http://localhost:5173'
    }/reset-password?token=${token}`;

    await sendResetEmail(user.email, resetLink);

    return res.json({
      message: 'If an account exists, a reset link has been sent',
    });
  } catch (err) {
    console.error('Forgot password error:', err);
    return res.status(500).json({ error: 'Failed to process request' });
  }
};

// POST /api/user/reset-password
export const resetPassword = async (req, res) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res
        .status(400)
        .json({ error: 'Token and new password are required' });
    }

    let decoded;
    try {
      decoded = jwt.verify(token, RESET_SECRET);
    } catch (err) {
      return res.status(400).json({
        error: 'Invalid or expired reset token',
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
    });

    if (!user) {
      return res.status(400).json({ error: 'User not found' });
    }

    if (decoded.passwordHash !== user.password) {
      return res
        .status(400)
        .json({ error: 'Reset link is no longer valid' });
    }

    const hashed = await bcrypt.hash(password, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: { password: hashed },
    });

    return res.json({
      message: 'Password reset successful. You can now log in.',
    });
  } catch (err) {
    console.error('Reset password error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
};
