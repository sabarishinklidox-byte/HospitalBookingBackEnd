import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../utils/audit.js';

// ----------------------------------------------------------------
// 1. SIGNUP
// ----------------------------------------------------------------
export const userSignup = async (req, res) => {
  try {
    const { email, password, name, phone } = req.body;

    if (!email || !password || !name) {
      return res.status(400).json({ error: 'Email, password and name required' });
    }

    // Check if user exists (even if deleted) to maintain Unique Email Constraint
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Optional: You could allow reactivation here if existing.deletedAt is set.
      // For now, we block it to be safe.
      if (existing.deletedAt) {
        return res.status(403).json({ error: 'This account was deleted. Please contact support to reactivate.' });
      }
      return res.status(400).json({ error: 'Email already exists' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password should be minimum 6 characters' });
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

    await logAudit({
      userId: user.id,
      action: 'USER_SIGNUP',
      entity: 'User',
      entityId: user.id,
      details: { email: user.email, name: user.name },
      req
    });

    return res.status(201).json({ token, user });
  } catch (error) {
    console.error('User Signup Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 2. LOGIN (With Soft Delete Check)
// ----------------------------------------------------------------
export const userLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // ✅ CHECK: If user doesn't exist OR is not a USER OR is DELETED
    if (!user || user.role !== 'USER' || user.deletedAt) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { userId: user.id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    await logAudit({
      userId: user.id,
      action: 'USER_LOGIN',
      entity: 'User',
      entityId: user.id,
      details: { email: user.email },
      req
    });

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

// ----------------------------------------------------------------
// 3. BOOK APPOINTMENT
// ----------------------------------------------------------------
export const bookAppointment = async (req, res) => {
  try {
    const { userId } = req.user;
    const { slotId, doctorId, clinicId, bookingSection, notes } = req.body;

    if (!slotId || !doctorId || !clinicId) {
      return res.status(400).json({
        error: 'slotId, doctorId and clinicId are required',
      });
    }

    // Check Slot
    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
    });

    // ✅ Ensure Slot itself isn't deleted
    if (!slot || slot.deletedAt) {
      return res.status(404).json({ error: 'Slot not found or unavailable' });
    }

    // Check Existing Booking
    const existingBooking = await prisma.appointment.findFirst({
      where: {
        slotId,
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] },
        deletedAt: null // Ignore deleted bookings
      },
    });

    if (existingBooking) {
      return res.status(409).json({
        error: 'This slot is already booked. Please choose another slot.',
      });
    }

    const allowedSections = [
      'DENTAL', 'CARDIAC', 'NEUROLOGY', 'ORTHOPEDICS',
      'GYNECOLOGY', 'PEDIATRICS', 'DERMATOLOGY',
      'OPHTHALMOLOGY', 'GENERAL', 'OTHER',
    ];
    const sectionValue = allowedSections.includes(bookingSection) ? bookingSection : 'GENERAL';

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
        doctor: { select: { name: true } },
        clinic: true,
        slot: true,
      },
    });

    await logAudit({
      userId,
      clinicId,
      action: 'BOOK_APPOINTMENT',
      entity: 'Appointment',
      entityId: appointment.id,
      details: {
        doctorName: appointment.doctor?.name,
        date: new Date(slot.date).toLocaleDateString(),
        time: slot.time
      },
      req
    });

    return res.status(201).json(appointment);
  } catch (error) {
    console.error('Book Appointment Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 4. GET PROFILE
// ----------------------------------------------------------------
export const getUserProfile = async (req, res) => {
  try {
    const { userId } = req.user;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, phone: true },
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (error) {
    console.error('Get User Profile Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 5. UPDATE PROFILE
// ----------------------------------------------------------------
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

    await logAudit({
      userId,
      action: 'UPDATE_USER_PROFILE',
      entity: 'User',
      entityId: userId,
      details: data,
      req
    });

    res.json(updatedUser);
  } catch (error) {
    console.error('Update User Profile Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 6. GET HISTORY (With Soft Delete Filter)
// ----------------------------------------------------------------
export const getUserAppointmentHistory = async (req, res) => {
  try {
    const { userId } = req.user;
    const appointments = await prisma.appointment.findMany({
      where: { 
        userId,
        deletedAt: null // ✅ FILTER OUT DELETED
      },
      orderBy: { createdAt: 'desc' },
      include: {
        doctor: { select: { id: true, name: true, speciality: true } },
        clinic: { select: { id: true, name: true, address: true, city: true } },
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

// ----------------------------------------------------------------
// 7. CANCEL APPOINTMENT
// ----------------------------------------------------------------
export const cancelUserAppointment = async (req, res) => {
  try {
    const { userId } = req.user;
    const { id } = req.params;

    const appointment = await prisma.appointment.findFirst({
      where: { id, userId, deletedAt: null }, // ✅ Ignore if already deleted
      include: { clinic: true }
    });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    if (appointment.status !== 'PENDING') {
      return res.status(400).json({ error: 'Only pending appointments can be cancelled' });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'CANCELLED' }
    });

    await logAudit({
      userId,
      clinicId: appointment.clinicId,
      action: 'CANCEL_APPOINTMENT_USER',
      entity: 'Appointment',
      entityId: id,
      details: { reason: "User cancelled from dashboard" },
      req
    });

    res.json(updated);
  } catch (error) {
    console.error('Cancel Appointment Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 8. RESCHEDULE APPOINTMENT
// ----------------------------------------------------------------
export const rescheduleAppointment = async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const { id } = req.params;
    const { newSlotId } = req.body;

    if (!userId) {
      return res.status(401).json({ error: 'User authentication failed.' });
    }
    if (!newSlotId) {
      return res.status(400).json({ error: 'New Slot ID is required' });
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: { slot: true },
    });

    if (!appointment || appointment.deletedAt) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (['COMPLETED', 'CANCELLED'].includes(appointment.status)) {
      return res
        .status(400)
        .json({ error: 'Cannot reschedule completed/cancelled appointments.' });
    }

    const newSlot = await prisma.slot.findUnique({
      where: { id: newSlotId },
      include: { appointments: true },
    });

    if (!newSlot || newSlot.deletedAt) {
      return res.status(404).json({ error: 'Slot not found or unavailable.' });
    }

    const isTaken = newSlot.appointments.some(
      (app) =>
        ['CONFIRMED', 'PENDING'].includes(app.status) && !app.deletedAt
    );
    if (isTaken) {
      return res.status(409).json({ error: 'Slot already booked.' });
    }

    // Update appointment to new slot
    const updatedAppointment = await prisma.appointment.update({
      where: { id },
      data: {
        slotId: newSlotId,
        status: 'PENDING',
      },
      include: { slot: true },
    });

    // Write AppointmentLog row (this is what UI will use)
    await prisma.appointmentLog.create({
      data: {
        appointmentId: appointment.id,
        oldDate: appointment.slot.date,
        oldTime: appointment.slot.time,
        newDate: newSlot.date,
        newTime: newSlot.time,
        reason: 'User requested reschedule',
        changedBy: userId,
      },
    });

    // Optional: also write AuditLog
    await logAudit({
      userId,
      clinicId: appointment.clinicId,
      action: 'RESCHEDULE_APPOINTMENT',
      entity: 'Appointment',
      entityId: id,
      details: {
        oldDate: appointment.slot.date,
        oldTime: appointment.slot.time,
        newDate: newSlot.date,
        newTime: newSlot.time,
        reason: 'User requested reschedule',
      },
      req,
    });

    const oldDateStr = appointment.slot.date
      ? new Date(appointment.slot.date).toLocaleDateString()
      : 'N/A';
    const newDateStr = updatedAppointment.slot.date
      ? new Date(updatedAppointment.slot.date).toLocaleDateString()
      : 'N/A';

    res.json({
      message: 'Reschedule Successful',
      details: {
        from: `${oldDateStr} at ${appointment.slot.time}`,
        to: `${newDateStr} at ${updatedAppointment.slot.time}`,
      },
      appointment: updatedAppointment,
    });
  } catch (error) {
    console.error('Reschedule Error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 9. GET USER APPOINTMENTS (General List)
// ----------------------------------------------------------------
export const getUserAppointments = async (req, res) => {
  try {
    const { userId } = req.user;

    const appointments = await prisma.appointment.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: {
        doctor: { select: { id: true, name: true, speciality: true } },
        slot:   { select: { date: true, time: true } },
        review: true,
        logs:   { orderBy: { createdAt: 'desc' } }, // AppointmentLog[]
      },
    });

    const formatted = appointments.map((app) => ({
      id: app.id,
      status: app.status,
      doctor: app.doctor,
      slot: app.slot,
      review: app.review,
      prescription: app.prescription || null,

      // reschedule history (same shape as admin)
      history: app.logs.map((log) => ({
        id: log.id,
        action: 'RESCHEDULE_APPOINTMENT',
        changedBy: log.changedBy,
        timestamp: new Date(log.createdAt).toLocaleString(),
        oldDate: new Date(log.oldDate).toLocaleDateString(),
        newDate: new Date(log.newDate).toLocaleDateString(),
        oldTime: log.oldTime,
        newTime: log.newTime,
        reason: log.reason,
      })),
    }));

    res.json(formatted);
  } catch (err) {
    console.error('Get User Appointments Error:', err);
    res.status(500).json({ error: err.message });
  }
};