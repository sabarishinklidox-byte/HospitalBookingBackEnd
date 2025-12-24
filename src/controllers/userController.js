import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../utils/audit.js';
import { sendBookingEmails } from '../utils/email.js'

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
// ----------------------------------------------------------------
// 3. BOOK APPOINTMENT (FIXED)
// ----------------------------------------------------------------
export const bookAppointment = async (req, res) => {
  try {
    const { userId } = req.user;
    const { slotId, doctorId, clinicId, bookingSection, notes } = req.body;

    if (!slotId || !doctorId || !clinicId) {
      return res.status(400).json({ error: "slotId, doctorId and clinicId are required" });
    }

    const allowedSections = [
      "DENTAL","CARDIAC","NEUROLOGY","ORTHOPEDICS","GYNECOLOGY","PEDIATRICS",
      "DERMATOLOGY","OPHTHALMOLOGY","GENERAL","OTHER",
    ];
    const sectionValue = allowedSections.includes(bookingSection) ? bookingSection : "GENERAL";

    const appointment = await prisma.$transaction(async (tx) => {
      const slot = await tx.slot.findFirst({
        where: { id: slotId, clinicId, doctorId, deletedAt: null },
      });

      if (!slot) {
        const err = new Error("Slot not found or unavailable");
        err.statusCode = 404;
        throw err;
      }

      // quick check (DB unique constraint is final guard)
      const existingBooking = await tx.appointment.findFirst({
        where: {
          slotId,
          status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] },
          deletedAt: null,
        },
        select: { id: true },
      });

      if (existingBooking) {
        const err = new Error("This slot is already booked. Please choose another slot.");
        err.statusCode = 409;
        throw err;
      }

      return tx.appointment.create({
        data: {
          userId,
          slotId,
          doctorId,
          clinicId,
          section: sectionValue,
          notes: notes || "",
          status: "PENDING",
          slug: uuidv4(),
        },
        include: {
          doctor: { select: { name: true } },
          clinic: true,
          slot: true,
        },
      });
    });

    await logAudit({
      userId,
      clinicId,
      action: "BOOK_APPOINTMENT",
      entity: "Appointment",
      entityId: appointment.id,
      details: {
        doctorName: appointment.doctor?.name,
        date: appointment.slot?.date ? new Date(appointment.slot.date).toLocaleDateString() : null,
        time: appointment.slot?.time || null,
      },
      req,
    });

    return res.status(201).json(appointment);
  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });

    // ✅ Prisma unique constraint (slot already taken)
    if (error?.code === "P2002") {
      return res.status(409).json({
        error: "This slot is already booked. Please choose another slot.",
      });
    }

    console.error("Book Appointment Error:", error);
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
      return res.status(404).json({ error: "Appointment not found" });
    }

    if (["COMPLETED", "CANCELLED", "NO_SHOW"].includes(appointment.status)) {
      return res.status(400).json({ error: "Appointment cannot be cancelled" });
    }

    const now = new Date();
    const slotDate = new Date(appointment.slot.date);
    const diffHours = (slotDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    const withinWindow = diffHours >= 2;

    const isPayAtClinic =
      appointment.slot.paymentMode === "OFFLINE" || appointment.slot.paymentMode === "FREE";
    const isOnlinePay = appointment.slot.paymentMode === "ONLINE";

    const doctorName = appointment.doctor?.name || "Doctor";
    const dateStr = appointment.slot?.date
      ? new Date(appointment.slot.date).toLocaleDateString()
      : "N/A";
    const timeStr = appointment.slot?.time || "N/A";

    // PAY-AT-CLINIC / FREE → direct cancel (if within window)
    if (isPayAtClinic) {
      if (!withinWindow) {
        return res.status(400).json({
          error: "Too late to cancel this appointment online. Please contact clinic.",
        });
      }

      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: "CANCELLED",
            cancelReason: reason || "Cancelled by patient",
            cancelledBy: "USER",
          },
        });

        await tx.notification.create({
          data: {
            clinicId: appointment.clinicId,
            type: "CANCELLATION",
            entityId: appointment.id,
            message: `Patient cancelled appointment with ${doctorName} on ${dateStr} at ${timeStr}. Reason: ${
              reason || "Cancelled by patient"
            }`,
            // readAt omitted => unread
          },
        });

        return u;
      });

      await logAudit({
        userId,
        clinicId: appointment.clinicId,
        action: "CANCEL_APPOINTMENT_USER",
        entity: "Appointment",
        entityId: id,
        details: {
          reason: reason || "Cancelled by patient (pay at clinic)",
          paymentMode: appointment.slot.paymentMode,
        },
        req,
      });

      return res.json(updated);
    }

    // ONLINE payment → create/reuse CancellationRequest + notify clinic
    // ✅ No CANCEL_REQUESTED status (not in enum)
    // ✅ No CANCEL_REQUEST notification type (not in enum)
    if (isOnlinePay) {
      if (appointment.cancellationRequest?.status === "PENDING") {
        return res.status(400).json({
          error: "Cancellation already requested and pending clinic approval.",
        });
      }

      await prisma.$transaction(async (tx) => {
        await tx.cancellationRequest.upsert({
          where: { appointmentId: appointment.id },
          update: {
            status: "PENDING",
            reason: reason || null,
            processedAt: null,
            processedById: null,
          },
          create: {
            appointmentId: appointment.id,
            status: "PENDING",
            reason: reason || null,
          },
        });

        // Optional: keep appointment status as-is, OR set to PENDING.
        // Since CANCEL_REQUESTED doesn't exist, do nothing here:
        // await tx.appointment.update({ where: { id: appointment.id }, data: { status: "PENDING" } });

        await tx.notification.create({
          data: {
            clinicId: appointment.clinicId,
            type: "CANCELLATION",
            entityId: appointment.id,
            message: `Patient requested cancellation with ${doctorName} on ${dateStr} at ${timeStr}. Reason: ${
              reason || "N/A"
            }`,
            // readAt omitted => unread
          },
        });
      });

      await logAudit({
        userId,
        clinicId: appointment.clinicId,
        action: "REQUEST_CANCEL_APPOINTMENT_USER",
        entity: "Appointment",
        entityId: id,
        details: {
          reason: reason || null,
          paymentMode: appointment.slot.paymentMode,
        },
        req,
      });

      return res.json({
        message:
          "Cancellation request submitted. Clinic will review and process refund if applicable.",
      });
    }

    return res.status(400).json({
      error: "Cancellation flow not configured for this appointment.",
    });
  } catch (error) {
    console.error("Cancel Appointment Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 8. RESCHEDULE APPOINTMENT
// ----------------------------------------------------------------
// ----------------------------------------------------------------
// 8. RESCHEDULE APPOINTMENT (FIXED)
// ----------------------------------------------------------------
export const rescheduleAppointment = async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const { id } = req.params;
    const { newSlotId } = req.body;

    if (!userId) return res.status(401).json({ error: "User authentication failed." });
    if (!newSlotId) return res.status(400).json({ error: "New Slot ID is required" });

    const result = await prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id, userId, deletedAt: null },
        include: { 
          slot: true, 
          doctor: true, 
          clinic: true,
          user: {
            select: { id: true, name: true, phone: true, email: true }
          }
        },
      });

      if (!appointment) {
        const err = new Error("Appointment not found");
        err.statusCode = 404;
        throw err;
      }

      if (["COMPLETED", "CANCELLED"].includes(appointment.status)) {
        const err = new Error("Cannot reschedule completed/cancelled appointments.");
        err.statusCode = 400;
        throw err;
      }

      // 🔥 BLOCKED FILTER
      const newSlot = await tx.slot.findFirst({
        where: {
          id: newSlotId,
          clinicId: appointment.clinicId,
          doctorId: appointment.doctorId,
          deletedAt: null,
          isBlocked: false,  // 🔥 CANNOT RESCHEDULE TO BLOCKED
          kind: "APPOINTMENT"  // 🔥 SAFETY
        },
        include: { 
          appointments: {
            where: {
              deletedAt: null,
              status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] }
            },
            select: { id: true }
          }
        },
      });

      if (!newSlot) {
        const err = new Error("Slot not found or unavailable.");
        err.statusCode = 404;
        throw err;
      }

      if (newSlot.appointments && newSlot.appointments.length > 0) {
        const err = new Error("Slot already booked.");
        err.statusCode = 409;
        throw err;
      }

      const updatedAppointment = await tx.appointment.update({
        where: { id: appointment.id },
        data: { 
          slotId: newSlotId, 
          status: "PENDING",
          updatedAt: new Date()
        },
        include: { 
          slot: true,
          doctor: true,
          clinic: true,
          user: {
            select: { id: true, name: true, phone: true }
          }
        },
      });

      await tx.appointmentLog.create({
        data: {
          appointmentId: appointment.id,
          oldDate: appointment.slot.date,
          oldTime: appointment.slot.time,
          newDate: newSlot.date,
          newTime: newSlot.time,
          reason: "User requested reschedule",
          changedBy: userId,
        },
      });

      const doctorName = appointment.doctor?.name || "Doctor";
      const oldDateStr = appointment.slot?.date 
        ? new Date(appointment.slot.date).toLocaleDateString('en-IN') 
        : "N/A";
      const oldTimeStr = appointment.slot?.time || "N/A";
      const newDateStr = newSlot?.date 
        ? new Date(newSlot.date).toLocaleDateString('en-IN') 
        : "N/A";
      const newTimeStr = newSlot?.time || "N/A";

      await tx.notification.create({
        data: {
          clinicId: appointment.clinicId,
          type: "RESCHEDULE",
          entityId: appointment.id,
          message: `Patient rescheduled appointment with ${doctorName}: ${oldDateStr} ${oldTimeStr} → ${newDateStr} ${newTimeStr}.`,
        },
      });

      return { 
        updatedAppointment, 
        oldDateStr, 
        oldTimeStr, 
        newDateStr, 
        newTimeStr,
        oldSlot: appointment.slot,
        newSlot,
        clinic: appointment.clinic,
        doctor: appointment.doctor,
        user: appointment.user
      };
    });

    sendBookingEmails({
      type: 'RESCHEDULE',
      id: result.updatedAppointment.id,
      clinic: result.clinic,
      doctor: result.doctor,
      slot: result.newSlot,
      oldSlot: result.oldSlot,
      user: result.user
    }).catch(err => {
      console.error('Reschedule emails failed:', err);
    });

    await logAudit({
      userId,
      clinicId: result.updatedAppointment.clinicId,
      action: "RESCHEDULE_APPOINTMENT",
      entity: "Appointment",
      entityId: id,
      details: {
        from: `${result.oldDateStr} at ${result.oldTimeStr}`,
        to: `${result.newDateStr} at ${result.newTimeStr}`,
        reason: "User requested reschedule",
      },
      req,
    });

    return res.json({
      message: "Reschedule successful",
      details: {
        from: `${result.oldDateStr} at ${result.oldTimeStr}`,
        to: `${result.newDateStr} at ${result.newTimeStr}`,
      },
      appointment: result.updatedAppointment,
    });
  } catch (error) {
    if (error?.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    if (error?.code === "P2002") {
      return res.status(409).json({ error: "Slot already booked. Please choose another slot." });
    }
    console.error("Reschedule Error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
};



// ✅ BONUS: Reschedule-specific notification email




// ----------------------------------------------------------------
// 9. GET USER APPOINTMENTS (General List)
// ----------------------------------------------------------------

export const getUserAppointments = async (req, res) => {
  try {
    const { userId } = req.user;
    const { status, doctor, dateFrom, dateTo, page = 1, limit = 10 } = req.query;

    const pageNumber = Number(page) || 1;
    const pageSize = Number(limit) || 10;

    const where = { userId, deletedAt: null };

    if (status) where.status = status;
    if (doctor) where.doctorId = doctor;

    if (dateFrom || dateTo) {
      where.slot = { date: {} };

      if (dateFrom) where.slot.date.gte = new Date(dateFrom);

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
        orderBy: { createdAt: "desc" },
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
        include: {
          doctor: { select: { id: true, name: true, speciality: true } },
          slot: { select: { id: true, date: true, time: true, paymentMode: true } },
          review: true,
          logs: { orderBy: { createdAt: "desc" } },
          clinic: { select: { id: true, name: true, city: true } }, // ← add clinic
        },
      }),
    ]);

    const formatted = appointments.map((app) => ({
      id: app.id,
      clinicId: app.clinicId,
      doctorId: app.doctorId,
      slotId: app.slotId,
      status: app.status,
      doctor: app.doctor,
      slot: app.slot,
      clinic: app.clinic,                    // ← expose clinic object
      review: app.review,
      prescription: app.prescription || null,
      cancelReason: app.cancelReason || null,
      history: app.logs.map((log) => ({
        id: log.id,
        action: "RESCHEDULE_APPOINTMENT",
        changedBy: log.changedBy,
        timestamp: log.createdAt,           // raw ISO/timestamp
        oldDate: log.oldDate,
        newDate: log.newDate,
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
    console.error("Get User Appointments Error:", err);
    return res.status(500).json({ error: err.message });
  }
};

export const getSlotsForUser = async (req, res, next) => {
  try {
    const { clinicId, doctorId, date, excludeAppointmentId } = req.query;

    if (!clinicId || !doctorId || !date) {
      return res.status(400).json({ error: "clinicId, doctorId, date are required" });
    }

    const start = new Date(date);
    start.setHours(0, 0, 0, 0);

    const end = new Date(date);
    end.setHours(23, 59, 59, 999);

    const slots = await prisma.slot.findMany({
      where: {
        clinicId,
        doctorId,
        deletedAt: null,
        kind: "APPOINTMENT",
        isBlocked: false, // 🔥 FIXED: Hide blocked slots
        date: { gte: start, lte: end },
      },
      orderBy: { time: "asc" },
      include: {
        appointments: {
          where: {
            deletedAt: null,
            status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] },
            ...(excludeAppointmentId ? { NOT: { id: excludeAppointmentId } } : {}),
          },
          select: { id: true },
        },
      },
    });

    return res.json({
      data: slots.map((s) => ({
        id: s.id,
        date: s.date,
        time: s.time,
        paymentMode: s.paymentMode,
        kind: s.kind,
        price: s.price,
        isBlocked: false,  // 🔥 Always false
        isBooked: (s.appointments?.length || 0) > 0,
      })),
    });
  } catch (error) {
    console.error("Get Slots For User Error:", error);
    return next ? next(error) : res.status(500).json({ error: "Failed to load slots" });
  }
};



// GET /user/slots?clinicId=...&doctorId=...&date=YYYY-MM-DD
// GET /user/slots?clinicId=...&doctorId=...&date=YYYY-MM-DD&excludeAppointmentId=...


