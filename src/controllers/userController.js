import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../utils/audit.js';
import { sendBookingEmails } from '../utils/email.js'
import Razorpay from 'razorpay';
import Stripe from 'stripe';


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
      { expiresIn: '6h' }
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
      { expiresIn: '6h' }
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
 // Optional if you have it

// ----------------------------------------------------------------
// HELPER 1: Get Gateway Instance
// ----------------------------------------------------------------
const getPaymentInstance = async (clinicId, provider = 'RAZORPAY') => {
  const gateway = await prisma.paymentGateway.findFirst({
    where: { clinicId, isActive: true, name: provider },
  });

  if (!gateway || !gateway.apiKey || !gateway.secret) {
    throw new Error(`${provider} payments are not configured for this clinic.`);
  }

  if (provider === 'STRIPE') {
    return {
      instance: new Stripe(gateway.secret),
      publicKey: gateway.apiKey,
      gatewayId: gateway.id,
      provider: 'STRIPE',
    };
  }

  // Razorpay
  return {
    instance: new Razorpay({ key_id: gateway.apiKey, key_secret: gateway.secret }),
    key_id: gateway.apiKey,
    gatewayId: gateway.id,
    provider: 'RAZORPAY',
  };
};

// ----------------------------------------------------------------
// HELPER 2: Create Payment Order
// ----------------------------------------------------------------
async function createPaymentOrder(gateway, slot, provider, notes = {}) {
  const amountInPaise = Math.round(Number(slot.price) * 100);

  if (gateway.provider === 'RAZORPAY') {
    const options = {
      amount: amountInPaise,
      currency: 'INR',
      receipt: `resched_${slot.id.slice(-8)}_${Date.now()}`,
      notes: { ...notes, slotId: slot.id, type: "RESCHEDULE" },
    };
    const order = await gateway.instance.orders.create(options);
    return {
      provider: 'RAZORPAY',
      orderId: order.id,
      amount: order.amount,
      key: gateway.key_id,
    };
  } else if (gateway.provider === 'STRIPE') {
    const session = await gateway.instance.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'inr',
          product_data: {
            name: `Reschedule: Dr. ${slot.doctor?.name || 'Doctor'}`,
            description: `New Date: ${new Date(slot.date).toLocaleDateString()}`,
          },
          unit_amount: amountInPaise,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/appointments`,
      metadata: { ...notes, slotId: slot.id, type: "RESCHEDULE" },
    });
    return {
      provider: 'STRIPE',
      sessionId: session.id,
      url: session.url,
      publishableKey: gateway.publicKey,
    };
  }
}

// ----------------------------------------------------------------
// 3. MAIN CONTROLLER: Reschedule Appointment
// ----------------------------------------------------------------
export const rescheduleAppointment = async (req, res) => {
  try {
    // 1. Robust User ID Extraction
    const userId = req.user?.id || req.user?.userId || req.user?._id;
    const { id } = req.params; 
    const appointmentId = id || req.body.appointmentId; 
    const { newSlotId, provider = 'RAZORPAY' } = req.body; 

    if (!userId) return res.status(401).json({ error: "Auth failed. User not found." });
    if (!appointmentId) return res.status(400).json({ error: "Appointment ID required" });
    if (!newSlotId) return res.status(400).json({ error: "New Slot ID is required" });

    // 2. Fetch Data (EARLY AUTH CHECK)
    const [oldApptCheck, newSlotCheck] = await Promise.all([
      prisma.appointment.findUnique({ 
        where: { id: appointmentId },
        include: { slot: true } 
      }),
      prisma.slot.findUnique({ 
        where: { id: newSlotId },
        include: { clinic: true, doctor: true } 
      })
    ]);
    
    if (!oldApptCheck || !newSlotCheck) {
      return res.status(404).json({ error: "Appointment or Slot not found" });
    }

    // 🔥 EARLY AUTH + STATUS CHECK (Prevents race condition)
    if (String(oldApptCheck.userId) !== String(userId)) {
      return res.status(403).json({ error: "Not authorized" });
    }
    if (["COMPLETED", "CANCELLED"].includes(oldApptCheck.status)) {
      return res.status(400).json({ error: "Cannot reschedule completed/cancelled" });
    }

    // 3. 🚨 ULTIMATE FIXED PAYMENT CHECK 🚨 (YOUR ORIGINAL LOGIC)
    const oldPrice = Number(oldApptCheck.amount || 0);
    const newPrice = Number(newSlotCheck.price || 0);
    const oldPaidAmount = oldApptCheck.paymentStatus === "PAID" ? oldPrice : 0;
    const isNewOnline = newSlotCheck.paymentMode === "ONLINE" && newPrice > 0;

    const needsPayment = isNewOnline || (newPrice > oldPaidAmount);

    console.log(`💰 FIXED: Old ${oldApptCheck.paymentStatus} ₹${oldPrice} → New ${newSlotCheck.paymentMode} ₹${newPrice} = ${needsPayment ? 'PAYMENT_REQUIRED' : 'NORMAL'}`);

    if (needsPayment) {
      console.log(`💰 Payment Required for Reschedule: Appt ${appointmentId} -> Slot ${newSlotId}`);

      // 🔥 RACE CONDITION FIXED: ATOMIC PAYMENT + LOCK
      const result = await prisma.$transaction(async (tx) => {
        // 1. CHECK SLOT STILL AVAILABLE (Race condition killer)
        const availableSlot = await tx.slot.findFirst({
          where: { 
            id: newSlotId, 
            isBlocked: false,
            clinicId: oldApptCheck.clinicId
          }
        });
        if (!availableSlot) throw { statusCode: 409, message: "Slot unavailable" };

        // 2. CHECK NO OTHER BOOKINGS (Double-check)
        const bookingCount = await tx.appointment.count({
          where: { 
            slotId: newSlotId, 
            status: { notIn: ['CANCELLED'] }, 
            deletedAt: null 
          }
        });
        if (bookingCount > 0) throw { statusCode: 409, message: "Slot already booked" };

        // 3. CREATE PAYMENT ORDER
        const gateway = await getPaymentInstance(newSlotCheck.clinicId, provider);
        const orderData = await createPaymentOrder(gateway, newSlotCheck, provider, {
          appointmentId: appointmentId,
          rescheduleToSlot: newSlotId
        });

        // 4. ATOMIC LOCK (Your original logic)
        await tx.appointment.update({
          where: { id: appointmentId },
          data: {
            paymentStatus: "PENDING",
            financialStatus: "PAY_DIFFERENCE",
            diffAmount: newPrice,
            adminNote: `Reschedule payment hold: Slot ${newSlotId}. Expires in 10min.`,
          }
        });

        await tx.slot.update({
          where: { id: newSlotId },
          data: { 
            isBlocked: true,
            status: "PENDING_PAYMENT"
          }
        });

        return { gateway, orderData };
      });

      console.log(`🔒 Slot ${newSlotId} BLOCKED + Appt ${appointmentId} marked PENDING`);

      return res.json({
        status: "PAYMENT_REQUIRED",
        message: "Payment required. Slot locked for 10 minutes.",
        data: {
          isOnline: true,
          gatewayId: result.gateway.gatewayId,
          expiresIn: 600,
          ...result.orderData,
          appointmentId,
          newSlotId,
          clinicId: newSlotCheck.clinicId,
          diffAmount: newPrice
        }
      });
    }

    // -------------------------------------------------------
    // 4. NORMAL RESCHEDULE FLOW (YOUR ORIGINAL + RACE FIX)
    // -------------------------------------------------------
    const result = await prisma.$transaction(async (tx) => {
      // A. Fetch Full Appointment
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId },
        include: { slot: true, doctor: true, clinic: true, user: true },
      });

      // Security Checks (Your original)
      if (String(appointment.userId) !== String(userId)) throw { statusCode: 403, message: "Unauthorized" };
      if (["COMPLETED", "CANCELLED"].includes(appointment.status)) throw { statusCode: 400, message: "Cannot reschedule completed/cancelled" };

      // 🔥 RACE CONDITION CHECKS (NEW)
      const newSlot = await tx.slot.findFirst({
        where: { id: newSlotId, clinicId: appointment.clinicId, isBlocked: false },
      });
      if (!newSlot) throw { statusCode: 404, message: "New slot invalid" };

      const bookingCount = await tx.appointment.count({
        where: { slotId: newSlotId, status: { notIn: ['CANCELLED'] }, deletedAt: null }
      });
      if (bookingCount > 0) throw { statusCode: 409, message: "Slot already booked." };

      // Financial Logic (YOUR ORIGINAL)
      let adminAlert = null;
      let financialStatus = "NO_CHANGE";
      const oldPriceFinal = Number(appointment.amount || 0);
      const newPriceFinal = Number(newSlot.price || 0);
      const amountPaidFinal = appointment.paymentStatus === "PAID" ? oldPriceFinal : 0;

      if (newPriceFinal > amountPaidFinal) {
        financialStatus = "PAY_DIFFERENCE"; 
        adminAlert = `Collect difference of ₹${newPriceFinal - amountPaidFinal} at clinic.`;
      } else if (newPriceFinal < amountPaidFinal) {
        financialStatus = "REFUND_AT_CLINIC";
        adminAlert = `Refund ₹${amountPaidFinal - newPriceFinal} manually.`;
      }

      // Update Appointment (YOUR ORIGINAL - FIXED slotId)
      const updatedAppointment = await tx.appointment.update({
        where: { id: appointmentId },
        data: {
          slotId: newSlotId,  // 🔥 FIXED: Use slotId not connect
          status: "PENDING",
          amount: newSlot.price,
          adminNote: adminAlert,
          financialStatus,
        },
        include: { slot: true, doctor: true, clinic: true, user: true },
      });

      // Create Log (YOUR ORIGINAL)
      await tx.appointmentLog.create({
        data: {
          appointmentId: appointment.id,
          reason: "Reschedule",
          changedBy: userId,
          oldDate: appointment.slot.date,
          oldTime: appointment.slot.time,
          newDate: newSlot.date,
          newTime: newSlot.time,
          metadata: { action: "RESCHEDULE", financialStatus, adminAlert }
        },
      });

      // Create Notification (YOUR ORIGINAL)
      await tx.notification.create({
        data: {
          clinicId: appointment.clinicId,
          type: "RESCHEDULE",
          entityId: appointment.id,
          message: `Rescheduled to ${new Date(newSlot.date).toLocaleDateString()}`,
        },
      });

      return { 
        updatedAppointment, 
        oldSlot: appointment.slot, 
        newSlot, 
        clinic: appointment.clinic, 
        doctor: appointment.doctor, 
        user: appointment.user, 
        adminAlert, 
        financialStatus 
      };
    });

    // 5. Post-Transaction (YOUR ORIGINAL)
    if (typeof sendBookingEmails === 'function') {
      sendBookingEmails({
        type: "RESCHEDULE",
        id: result.updatedAppointment.id,
        clinic: result.clinic,
        doctor: result.doctor,
        slot: result.newSlot,
        oldSlot: result.oldSlot,
        user: result.user,
      }).catch(err => console.error("Email failed:", err));
    }

    if (typeof logAudit === 'function') {
      logAudit({
        userId,
        clinicId: result.clinic.id,
        action: "RESCHEDULE",
        entity: "Appointment",
        entityId: appointmentId,
        details: { newSlotId },
        req
      }).catch(err => console.error("Audit failed:", err));
    }

    // 6. Final Response (YOUR ORIGINAL)
    return res.json({
      success: true,
      message: "Reschedule successful",
      data: {
        appointment: result.updatedAppointment,
        financialStatus: result.financialStatus,
        adminAlert: result.adminAlert
      }
    });

  } catch (error) {
    if (error?.statusCode) return res.status(error.statusCode).json({ error: error.message });
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

    // 🔥 FIXED: Hide CANCELLED appointments by default!
    const where = { 
      userId, 
      deletedAt: null,
      status: { not: 'CANCELLED' }  // ✅ Cards DISAPPEAR after 10min cron!
    };

    // 🔄 Override filters if provided (admin can see cancelled)
    if (status) where.status = status;
    if (doctor) where.doctorId = doctor;

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
        orderBy: { createdAt: "desc" },
        skip: (pageNumber - 1) * pageSize,
        take: pageSize,
        include: {
          doctor: {
            select: { id: true, name: true, speciality: true },
          },
          slot: {
            select: {
              id: true,
              date: true,
              time: true,
              paymentMode: true,
              price: true,
            },
          },
          review: true,
          logs: { orderBy: { createdAt: "desc" } },
          clinic: {
            select: { id: true, name: true, city: true },
          },
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
      clinic: app.clinic,
      review: app.review,

      prescription: app.prescription || null,
      cancelReason: app.cancelReason || null,

      // payment info for AppointmentCard
      amount: app.amount ?? app.slot?.price ?? 0,
      paymentStatus: app.paymentStatus || "PENDING",
      financialStatus: app.financialStatus || null,
      diffAmount: app.diffAmount ?? 0,

      history: app.logs.map((log) => ({
        id: log.id,
        action: "RESCHEDULE_APPOINTMENT",
        changedBy: log.changedBy,
        timestamp: log.createdAt,
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
          select: { 
            id: true,
            userId: true,
            paymentStatus: true
          },
        },
      },
    });

    const now = new Date();
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const currentUserId = req.user?.id;

    const processedSlots = slots
      .map((s) => {
        const appointments = Array.isArray(s.appointments) ? s.appointments : [];
        
        let isBooked = false;
        let isMyPaymentHold = false;

        // 1. ✅ Check appointments first (existing bookings)
        appointments.forEach(apt => {
          if (apt.userId === currentUserId) {
            if (apt.paymentStatus === "PENDING") {
              isMyPaymentHold = true;
            } else {
              // MY PAID/CONFIRMED → Booked (exclude if rescheduling this one)
              if (!excludeAppointmentId || apt.id !== excludeAppointmentId) {
                isBooked = true;
              }
            }
          } else {
            // OTHER USER'S APPOINTMENT → Always Booked
            isBooked = true;
          }
        });

        // 🔥 2. FIXED: Held slots logic - ONLY for CURRENT user!
        if (s.isBlocked && s.status === 'PENDING_PAYMENT') {
          if (new Date(s.updatedAt) < tenMinutesAgo) {
            // ✅ Expired hold = Available to everyone
          } else {
            // 🔥 CRITICAL FIX: Check if THIS is MY hold
            if (s.blockedBy === currentUserId || appointments.some(apt => apt.userId === currentUserId)) {
              // ✅ YOUR HOLD - show available
              isMyPaymentHold = true;
              isBooked = false;
            } else {
              // ✅ OTHER USER'S HOLD - show BOOKED!
              isBooked = true;
            }
          }
        }

        // 3. Skip permanent admin blocks only
        if (s.isBlocked && s.status !== 'PENDING_PAYMENT') {
          return null;
        }

        return {
          id: s.id,
          date: s.date,
          time: s.time,
          paymentMode: s.paymentMode,
          kind: s.kind,
          price: s.price,
          isBlocked: s.isBlocked,
          isBooked: isBooked,           // ✅ false for YOU, true for others!
          isMyHold: isMyPaymentHold     // ✅ true only for holding user
        };
      })
      .filter(Boolean);

    return res.json({ data: processedSlots });

  } catch (error) {
    console.error("Get Slots For User Error:", error);
    return next ? next(error) : res.status(500).json({ error: "Failed to load slots" });
  }
};




// GET /user/slots?clinicId=...&doctorId=...&date=YYYY-MM-DD
// GET /user/slots?clinicId=...&doctorId=...&date=YYYY-MM-DD&excludeAppointmentId=...


