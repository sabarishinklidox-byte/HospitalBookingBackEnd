// src/controllers/userController.js
import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

// POST /api/user/signup
export const userSignup = async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      return res
        .status(400)
        .json({ error: 'Email, password and name required' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    if (password.length < 6) {
      return res.status(400).json({
        error: 'Password should be minimum 6 characters',
      });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        id: uuidv4(),
        email,
        password: hashedPassword,
        name,
        phone: phone || '',
        role: 'USER',
      },
      select: { id: true, email: true, name: true, phone: true, role: true },
    });

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.status(201).json({ token, user });
  } catch (error) {
    console.error('User Signup Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// POST /api/user/login
export const userLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.role !== 'USER') {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    });
  } catch (error) {
    console.error('User Login Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// POST /api/user/appointments (Protected) - Book appointment
export const bookAppointment = async (req, res) => {
  try {
    const { userId } = req.user;
    const { slotId, doctorId, clinicId, bookingSection, notes } = req.body;

    if (!slotId || !doctorId || !clinicId) {
      return res.status(400).json({
        error: 'slotId, doctorId and clinicId are required',
      });
    }

    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
    });

    if (!slot) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // Check if slot is already booked
    const existingBooking = await prisma.appointment.findFirst({
      where: {
        slotId,
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] },
      },
    });

    if (existingBooking) {
      return res.status(409).json({
        error: 'This slot is already booked. Please choose another slot.',
      });
    }

    const allowedSections = [
      'DENTAL',
      'CARDIAC',
      'NEUROLOGY',
      'ORTHOPEDICS',
      'GYNECOLOGY',
      'PEDIATRICS',
      'DERMATOLOGY',
      'OPHTHALMOLOGY',
      'GENERAL',
      'OTHER',
    ];
    const sectionValue =
      allowedSections.includes(bookingSection) ? bookingSection : 'GENERAL';

    const appointment = await prisma.appointment.create({
      data: {
        userId,
        slotId,
        doctorId,
        clinicId,
        section: sectionValue,
        notes: notes || '',
        status: 'PENDING',
        slug: uuidv4(),
      },
      include: {
        doctor: true,
        clinic: true,
        slot: true,
      },
    });

    // Update the slot to indicate it is booked (if your schema has isBooked)
    // await prisma.slot.update({ where: { id: slotId }, data: { isBooked: true } });

    return res.status(201).json(appointment);
  } catch (error) {
    console.error('Book Appointment Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/user/appointments (Protected)
export const getUserAppointments = async (req, res) => {
  try {
    const { userId } = req.user;

    const appointments = await prisma.appointment.findMany({
      where: { userId },
      // Sort by most recent booking first
      // If your schema does NOT have 'createdAt', change this to { id: 'desc' }
      orderBy: { createdAt: 'desc' },
      include: {
        doctor: {
          select: { id: true, name: true, speciality: true }
        },
        clinic: {
          select: { id: true, name: true, city: true }
        },
        slot: true,
        payment: true,
      },
    });

    res.json(appointments);
  } catch (error) {
    console.error('Get User Appointments Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// GET /api/user/profile (Protected)
export const getUserProfile = async (req, res) => {
  try {
    const { userId } = req.user;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Get User Profile Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// PATCH /api/user/profile (Protected)
export const updateUserProfile = async (req, res) => {
  try {
    const { userId } = req.user;
    const { name, phone } = req.body;

    const data = {};
    if (name !== undefined) data.name = name;
    if (phone !== undefined) data.phone = phone;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true, phone: true },
    });

    res.json(updatedUser);
  } catch (error) {
    console.error('Update User Profile Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// GET /api/user/history (Protected)
// This is essentially a duplicate of getUserAppointments but explicitly named 'History'
export const getUserAppointmentHistory = async (req, res) => {
  try {
    const { userId } = req.user;

    const appointments = await prisma.appointment.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: {
        doctor: {
          select: { id: true, name: true, speciality: true },
        },
        clinic: {
          select: { id: true, name: true, address: true, city: true },
        },
        slot: true,
        payment: true,
      },
    });

    return res.json(appointments);
  } catch (error) {
    console.error('Get User Appointment History Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
export const cancelUserAppointment = async (req, res) => {
  try {
    const { userId } = req.user;
    const { id } = req.params;

    // 1. Find appointment and ensure it belongs to this user
    const appointment = await prisma.appointment.findFirst({
      where: { 
        id, 
        userId // Security check
      }
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // 2. Check status
    if (appointment.status !== 'PENDING') {
      return res.status(400).json({ error: 'Only pending appointments can be cancelled' });
    }

    // 3. Update status
    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'CANCELLED' }
    });

    // Optional: Free up the slot (if your logic requires unlinking the slot or setting isBooked=false)
    // But typically you just mark appointment as cancelled and keep the slot reference for history.

    res.json(updated);
  } catch (error) {
    console.error('Cancel Appointment Error:', error);
    res.status(500).json({ error: error.message });
  }
};