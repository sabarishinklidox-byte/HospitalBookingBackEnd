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
      return res
        .status(400)
        .json({ error: 'Email, password and name required' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      if (existing.deletedAt) {
        return res.status(403).json({
          error:
            'This account was deleted. Please contact support to reactivate.',
        });
      }
      return res.status(400).json({ error: 'Email already exists' });
    }

    if (password.length < 6) {
      return res
        .status(400)
        .json({ error: 'Password should be minimum 6 characters' });
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
      req,
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
      req,
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

    const slot = await prisma.slot.findUnique({
      where: { id: slotId },
    });

    if (!slot || slot.deletedAt) {
      return res.status(404).json({ error: 'Slot not found or unavailable' });
    }

    const existingBooking = await prisma.appointment.findFirst({
      where: {
        slotId,
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] },
        deletedAt: null,
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
    const sectionValue = allowedSections.includes(bookingSection)
      ? bookingSection
      : 'GENERAL';

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
        time: slot.time,
      },
      req,
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
      req,
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
        deletedAt: null,
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
// 7. CANCEL / REQUEST CANCEL APPOINTMENT
// ----------------------------------------------------------------
export const cancelUserAppointment = async (req, res) => {
  try {
    const { userId } = req.user;
    const { id } = req.params;
    const { reason } = req.body || {};

    const appointment = await prisma.appointment.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        clinic: true,
        slot: true,
        doctor: { select: { name: true } },
        cancellationRequest: true,
      },
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (['COMPLETED', 'CANCELLED', 'NO_SHOW'].includes(appointment.status)) {
      return res.status(400).json({ error: 'Appointment cannot be cancelled' });
    }

    const now = new Date();
    const slotDate = new Date(appointment.slot.date);
    const diffMs = slotDate.getTime() - now.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    const withinWindow = diffHours >= 2;

    const isPayAtClinic =
      appointment.slot.paymentMode === 'OFFLINE' ||
      appointment.slot.paymentMode === 'FREE';
    const isOnlinePay = appointment.slot.paymentMode === 'ONLINE';

    const doctorName = appointment.doctor?.name || 'Doctor';
    const dateStr = appointment.slot?.date
      ? new Date(appointment.slot.date).toLocaleDateString()
      : 'N/A';
    const timeStr = appointment.slot?.time || 'N/A';

    // PAY-AT-CLINIC / FREE → direct cancel (if within window)
    if (isPayAtClinic) {
      if (!withinWindow) {
        return res.status(400).json({
          error:
            'Too late to cancel this appointment online. Please contact clinic.',
        });
      }

      const updated = await prisma.appointment.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelReason: reason || 'Cancelled by patient',
        },
      });

      await prisma.notification.create({
        data: {
          clinicId: appointment.clinicId,
          type: 'CANCELLATION',
          entityId: appointment.id,
          message: `Patient cancelled appointment with ${doctorName} on ${dateStr} at ${timeStr}. Reason: ${
            reason || 'Cancelled by patient'
          }`,
        },
      });

      await logAudit({
        userId,
        clinicId: appointment.clinicId,
        action: 'CANCEL_APPOINTMENT_USER',
        entity: 'Appointment',
        entityId: id,
        details: {
          reason: reason || 'Cancelled by patient (pay at clinic)',
          paymentMode: appointment.slot.paymentMode,
        },
        req,
      });

      return res.json(updated);
    }

    // ONLINE payment → create/reuse CancellationRequest + mark as CANCEL_REQUESTED + notify clinic
    if (isOnlinePay) {
      if (
        appointment.cancellationRequest &&
        appointment.cancellationRequest.status === 'PENDING'
      ) {
        return res.status(400).json({
          error: 'Cancellation already requested and pending clinic approval.',
        });
      }

      await prisma.$transaction([
        prisma.cancellationRequest.upsert({
          where: { appointmentId: appointment.id },
          update: {
            status: 'PENDING',
            reason: reason || null,
            processedAt: null,
            processedById: null,
          },
          create: {
            appointmentId: appointment.id,
            status: 'PENDING',
            reason: reason || null,
          },
        }),
        prisma.appointment.update({
          where: { id: appointment.id },
          data: { status: 'CANCEL_REQUESTED' },
        }),
        prisma.notification.create({
          data: {
            clinicId: appointment.clinicId,
            type: 'CANCEL_REQUEST',
            entityId: appointment.id,
            message: `Patient requested cancellation with ${doctorName} on ${dateStr} at ${timeStr}. Reason: ${
              reason || 'N/A'
            }`,
          },
        }),
      ]);

      await logAudit({
        userId,
        clinicId: appointment.clinicId,
        action: 'REQUEST_CANCEL_APPOINTMENT_USER',
        entity: 'Appointment',
        entityId: id,
        details: {
          reason: reason || null,
          paymentMode: appointment.slot.paymentMode,
        },
        req,
      });

      return res.json({
        message:
          'Cancellation request submitted. Clinic will review and process refund if applicable.',
      });
    }

    return res.status(400).json({
      error: 'Cancellation flow not configured for this appointment.',
    });
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
      include: {
        slot: true,
        doctor: { select: { name: true } },
      },
    });

    if (!appointment || appointment.deletedAt) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (['COMPLETED', 'CANCELLED'].includes(appointment.status)) {
      return res.status(400).json({
        error: 'Cannot reschedule completed/cancelled appointments.',
      });
    }

    const newSlot = await prisma.slot.findUnique({
      where: { id: newSlotId },
      include: { appointments: true },
    });

    if (!newSlot || newSlot.deletedAt) {
      return res.status(404).json({ error: 'Slot not found or unavailable.' });
    }

    const isTaken = newSlot.appointments.some(
      (app) => ['CONFIRMED', 'PENDING'].includes(app.status) && !app.deletedAt
    );
    if (isTaken) {
      return res.status(409).json({ error: 'Slot already booked.' });
    }

    const updatedAppointment = await prisma.appointment.update({
      where: { id },
      data: {
        slotId: newSlotId,
        status: 'PENDING',
      },
      include: { slot: true },
    });

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

    const doctorName = appointment.doctor?.name || 'Doctor';
    const oldDateStr = appointment.slot?.date
      ? new Date(appointment.slot.date).toLocaleDateString()
      : 'N/A';
    const oldTimeStr = appointment.slot?.time || 'N/A';
    const newDateStr = newSlot?.date ? new Date(newSlot.date).toLocaleDateString() : 'N/A';
    const newTimeStr = newSlot?.time || 'N/A';

    await prisma.notification.create({
      data: {
        clinicId: appointment.clinicId,
        type: 'RESCHEDULE',
        entityId: appointment.id,
        message: `Patient rescheduled appointment with ${doctorName}: ${oldDateStr} ${oldTimeStr} → ${newDateStr} ${newTimeStr}.`,
      },
    });

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

    res.json({
      message: 'Reschedule Successful',
      details: {
        from: `${oldDateStr} at ${oldTimeStr}`,
        to: `${newDateStr} at ${newTimeStr}`,
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
    const {
      status,
      doctor,
      dateFrom,
      dateTo,
      page = 1,
      limit = 10,
    } = req.query;

    const pageNumber = Number(page) || 1;
    const pageSize = Number(limit) || 10;

    const where = {
      userId,
      deletedAt: null,
    };

    if (status) {
      where.status = status;
    }

    if (doctor) {
      where.doctorId = doctor;
    }

    if (dateFrom || dateTo) {
      where.slot = { date: {} };
      if (dateFrom) {
        where.slot.date.gte = new Date(dateFrom);
      }
      if (dateTo) {
        const end = new Date(dateTo);
        end.setHours(23, 59, 59, 999);
        where.slot.date.lte = end;
      }
    }

   const [total, appointments] = await Promise.all([
  prisma.appointment.count({ where }),
  prisma.appointment.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    skip: (pageNumber - 1) * pageSize,
    take: pageSize,
    include: {
      doctor: { select: { id: true, name: true, speciality: true } },
      slot:   { select: { date: true, time: true, paymentMode: true } },
      review: true,
      logs:   { orderBy: { createdAt: 'desc' } },
    },
  }),
]);


    const formatted = appointments.map((app) => ({
      id: app.id,
      status: app.status,
      doctor: app.doctor,
      slot: app.slot,
      review: app.review,
      prescription: app.prescription || null,
      cancelReason: app.cancelReason || null,
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

    return res.json({
      data: formatted,
      pagination: {
        page: pageNumber,
        limit: pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
      },
    });
  } catch (err) {
    console.error('Get User Appointments Error:', err);
    res.status(500).json({ error: err.message });
  }
};
