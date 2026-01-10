import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { logAudit } from '../utils/audit.js';
import { sendBookingEmails } from '../utils/email.js'
import Razorpay from 'razorpay';
import Stripe from 'stripe';
import { z } from 'zod';
import { deleteAppointmentFromGCal } from '../utils/googleCalendar.js'; 
import { updateAppointmentOnGCal} from "../utils/googleCalendar.js";  // 🔥 ADD


// ----------------------------------------------------------------
// 1. SIGNUP
// ----------------------------------------------------------------

const signupSchema = z.object({
  email: z
    .string({ required_error: "Email is required" })
    .email("Invalid email address")
    .trim(),
  password: z
    .string({ required_error: "Password is required" })
    .min(6, "Password must be at least 6 characters")
    .max(128, "Password too long"),
  name: z
    .string({ required_error: "Name is required" })
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name too long"),
  phone: z  // ✅ FIXED: Always validates
    .string()
    .regex(/^\d{10}$/, "Phone: exactly 10 digits")  // Required 10 digits
    .or(z.literal(''))  // OR empty (but shows error if invalid)
    .refine(
      (val) => val === '' || /^\d{10}$/.test(val), 
      "Phone: exactly 10 digits (or leave empty)"
    ),
});


// VALIDATION MIDDLEWARE
const validateSignup = async (req, res, next) => {
  try {
    await signupSchema.parseAsync(req.body);
    next();
  } catch (error) {
    const fieldErrors = error.errors.map(err => 
      `${err.path.join('.')}: ${err.message}`
    );
    return res.status(400).json({ 
      error: "Validation failed", 
      details: fieldErrors[0] || "Invalid input" 
    });
  }
};

export const userSignup = [
  validateSignup,  // ✅ ZOD FIRST
  async (req, res) => {
    try {
      const { email, password, name, phone } = req.body;

      // Duplicate check (your existing logic)
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        if (existing.deletedAt) {
          return res.status(403).json({
            error: 'This account was deleted. Please contact support to reactivate.',
          });
        }
        return res.status(400).json({ error: 'Email already exists' });
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
  }
];
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

    // ============================================================
    // ⏳ 1. TIME WINDOW CHECK (24 Hours)
    // ============================================================
    const now = new Date();
    const slotDate = new Date(appointment.slot.date);
    const diffHours = (slotDate.getTime() - now.getTime()) / (1000 * 60 * 60);
    const MIN_NOTICE_HOURS = 24;
    const withinWindow = diffHours >= MIN_NOTICE_HOURS;

    const isPayAtClinic = appointment.slot.paymentMode === "OFFLINE" || appointment.slot.paymentMode === "FREE";
    const isOnlinePay = appointment.slot.paymentMode === "ONLINE";

    const doctorName = appointment.doctor?.name || "Doctor";
    const dateStr = new Date(appointment.slot.date).toLocaleDateString();
    const timeStr = appointment.slot.time;

    // ============================================================
    // 🟢 2. BLOCK DUPLICATE REQUESTS (Unified Check)
    // ============================================================
    if (isOnlinePay && appointment.cancellationRequest) {
      const status = appointment.cancellationRequest.status;
      return res.status(400).json({
        error: `Cancellation already ${status.toLowerCase()}. Contact clinic.`,
      });
    }

    // ============================================================
    // 🟢 3. PAY-AT-CLINIC / FREE (Instant Cancel + Slot Free)
    // ============================================================
    if (isPayAtClinic) {
      if (!withinWindow) {
        return res.status(400).json({
          error: `Too late. Cancellations allowed ${MIN_NOTICE_HOURS} hours in advance. Call clinic.`,
        });
      }

      const updated = await prisma.$transaction(async (tx) => {
        // A. Cancel Appointment ✅ Schema-Aligned
        const u = await tx.appointment.update({
          where: { id: appointment.id },
          data: {
            status: "CANCELLED",           // ✅ Exact enum match
            cancelReason: reason || "Cancelled by patient",
            cancelledBy: "USER",            // ✅ CancellationActor enum
            logs: {
              create: {
            // 🔥 CANCEL LOG: NO newDate/newTime (reschedule-only)
            oldDate: appointment.slot.date,
            oldTime: appointment.slot.time,
            reason: reason || "Cancelled by patient",
            changedBy: userId,
            metadata: { 
              paymentMode: appointment.slot.paymentMode,
              action: "CANCEL"  // 🔥 Optional: distinguish from reschedule
            }}
            }
          },
        });

        // B. 🔥 FREE SLOT (Critical!)
        await tx.slot.update({
          where: { id: appointment.slotId },
          data: {
            status: 'PENDING_PAYMENT',    // ✅ Exact enum: Available
            isBlocked: false,
            blockedReason: null,
            blockedBy: null,
            blockedAt: null
          }
        });

        // C. Notify Clinic
        await tx.notification.create({
          data: {
            clinicId: appointment.clinicId,
            type: "CANCELLATION",         // ✅ NotificationType enum
            entityId: appointment.id,
            message: `Patient cancelled with ${doctorName} on ${dateStr} ${timeStr}.`,
          },
        });

        return u;
      });

      // Audit
      await logAudit({
        userId,
        clinicId: appointment.clinicId,
        action: "CANCEL_APPOINTMENT_USER",
        entity: "Appointment",
        entityId: id,
        details: { reason, paymentMode: "OFFLINE" },
        req,
      });
deleteAppointmentFromGCal(appointment.id).catch(console.error);
      return res.json(updated);
    }

    // ============================================================
    // 🔴 4. ONLINE PAYMENT (Refund Request Workflow)
    // ============================================================
    if (isOnlinePay) {
      // Optional: Block late requests (uncomment if needed)
      /*
      if (!withinWindow) {
        return res.status(400).json({
          error: `Refunds considered ${MIN_NOTICE_HOURS} hours in advance only.`,
        });
      }
      */
     
  await prisma.$transaction(async (tx) => {
    // 🔥 NEW: Set appointment status to CANCEL_REQUESTED (shows orange UI)
    await tx.appointment.update({
      where: { id: appointment.id },
      data: { 
        status: "CANCEL_REQUESTED"  // ← THIS LINE FIXES "CONFIRMED" BUG
      }
    });

      await prisma.$transaction(async (tx) => {
        // Create/Update Request (status is String, not enum ✅)
        await tx.cancellationRequest.upsert({
          where: { appointmentId: appointment.id },
          update: {
            status: "PENDING",
            reason: reason || null,
          },
          create: {
            appointmentId: appointment.id,
            status: "PENDING",
            reason: reason || null,
          },
        });

        // Notify Clinic (REFUND priority)
        await tx.notification.create({
          data: {
            clinicId: appointment.clinicId,
            type: "CANCEL_REQUEST",       // ✅ NotificationType enum
            entityId: appointment.id,
            message: `⚠️ REFUND REQUEST: ${doctorName} on ${dateStr} ${timeStr}. Reason: ${reason || "N/A"}`,
          },
        });
      });});

      await logAudit({
        userId,
        clinicId: appointment.clinicId,
        action: "REQUEST_CANCEL_APPOINTMENT_USER",
        entity: "Appointment",
        entityId: id,
        details: { reason, paymentMode: "ONLINE" },
        req,
      });
      deleteAppointmentFromGCal(appointment.id).catch(console.error);

      return res.json({
        message: "Cancellation request submitted. Clinic will review refund.",
        appointmentId: id,
      });
    }

    return res.status(400).json({
      error: "Cancellation not configured for this payment mode.",
    });

  } catch (error) {
    console.error("💥 Cancel Appointment Error:", {
      message: error.message,
      code: error.code,
      meta: error.meta,
      appointmentId: req.params.id,
    });
    return res.status(500).json({ error: "Cancellation failed" });
  }
};


// export const cancelUserAppointment= async (req, res) => {
//   try {
//     const { clinicId, userId } = req.user;
//     const { id } = req.params;
//     const { reason } = req.body || {};

//     // 1. Fetch appointment with relations
//     const existing = await prisma.appointment.findFirst({
//       where: { id, clinicId, deletedAt: null },
//       include: { 
//         cancellationRequest: true, 
//         slot: { include: { doctor: true, clinic: true } },
//         user: true,
//         payment: true 
//       },
//     });

//     if (!existing) return res.status(404).json({ error: "Appointment not found" });

//     // 2. Identify Policy Type
//     // Logic: If it was rescheduled, we do NOT process an online refund
//     const isRescheduled = existing.type === 'RESCHEDULE' || existing.adminNote?.includes('RESCHEDULED');
//     const POLICY_MESSAGE = "Online refund is not applicable for rescheduled appointments. For any queries, please contact the clinic directly.";
    
//     let refundSuccessful = false;

//     // 3. RAZORPAY REFUND LOGIC (Conditional)
//     if (existing.paymentStatus === 'PAID' && !isRescheduled) {
//       try {
//         const gatewayObj = await getPaymentInstance(clinicId, 'RAZORPAY');
//         const paymentId = existing.paymentId || existing.payment?.gatewayRefId;
//         const amountInPaise = Math.round(Number(existing.amount) * 100);

//         if (paymentId && amountInPaise > 0) {
//           await gatewayObj.instance.payments.refund(paymentId, {
//             amount: amountInPaise,
//             notes: { reason: "Standard Cancellation Refund", appointmentId: id }
//           });
//           refundSuccessful = true;
//         }
//       } catch (refundErr) {
//         console.error("🚨 Refund Failed:", refundErr.description);
//         // We continue with cancellation but notify admin refund failed
//       }
//     }

//     // 4. DATABASE UPDATES (Transaction)
//     const finalReason = reason || (isRescheduled ? "Rescheduled & Cancelled" : "Cancelled by admin");
//     const hasPendingRequest = !!existing.cancellationRequest && existing.cancellationRequest.status === "PENDING";

//     const [updatedAppt] = await prisma.$transaction([
//       // A. Update Appointment
//       prisma.appointment.update({
//         where: { id },
//         data: {
//           status: "CANCELLED",
//           // If rescheduled, paymentStatus stays PAID (Clinic keeps the money)
//           paymentStatus: refundSuccessful ? "REFUNDED" : "PAID",
//           cancelReason: finalReason,
//           adminNote: isRescheduled 
//             ? `${existing.adminNote || ''} | POLICY: ${POLICY_MESSAGE}`.trim()
//             : existing.adminNote,
//           updatedAt: new Date()
//         },
//       }),

//       // B. Update Cancellation Request
//       hasPendingRequest
//         ? prisma.cancellationRequest.update({
//             where: { appointmentId: existing.id },
//             data: {
//               status: "APPROVED",
//               processedAt: new Date(),
//               processedById: userId,
//               reason: finalReason,
//             },
//           })
//         : prisma.$queryRaw`SELECT 1`,

//       // C. Update Slot to make it available again
//       prisma.slot.update({
//         where: { id: existing.slotId },
//         data: { status: "AVAILABLE", isBlocked: false }
//       })
//     ]);

//     // 5. EMAIL & AUDIT
//     const emailData = {
//       ...existing,
//       policyNote: isRescheduled ? POLICY_MESSAGE : null
//     };
    
//     await sendCancellationEmail(emailData, finalReason, hasPendingRequest, req.user);

//     await logAudit({
//       userId,
//       clinicId,
//       action: "CANCEL_APPOINTMENT",
//       entity: "Appointment",
//       entityId: id,
//       details: { isRescheduled, refundProcessed: refundSuccessful },
//       req,
//     });

//     // 6. RESPONSE
//     return res.json({
//       success: true,
//       message: isRescheduled ? POLICY_MESSAGE : "Appointment cancelled successfully.",
//       data: updatedAppt
//     });

//   } catch (error) {
//     console.error("🚨 Cancel Error:", error);
//     return res.status(500).json({ error: error.message });
//   }
// };


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


export const rescheduleAppointment = async (req, res) => {
  // 🔥 SCOPE FIX: Move to top
  const userId = req.user?.id || req.user?.userId || req.user?._id;
  const { id } = req.params; 
  const appointmentId = id || req.body.appointmentId; 
  const { newSlotId, provider = 'RAZORPAY' } = req.body; 

  try {
    if (!userId || !appointmentId || !newSlotId) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const [oldAppt, newSlot, slotBookings] = await Promise.all([
        tx.appointment.findUnique({ 
          where: { id: appointmentId },
          include: { 
            slot: true, 
            clinic: { include: { gateways: { where: { name: provider, isActive: true } } } },
            doctor: true 
          }
        }),
        tx.slot.findUnique({ where: { id: newSlotId, deletedAt: null }, include: { clinic: true } }),
     tx.appointment.count({
  where: { 
    slotId: newSlotId, 
    status: { 
      in: ['PENDING', 'CONFIRMED', 'PENDING_PAYMENT', 'COMPLETED'] 
    }, 
    deletedAt: null 
  }
})
      ]);
      
      console.log('📅 Reschedule Debug:', {
        status: oldAppt?.status,
        paymentStatus: oldAppt?.paymentStatus,
        appointmentId,
        newSlotId
      });

      if (!oldAppt || !newSlot) {
        throw { statusCode: 404, message: "Appointment or slot not found" };
      }
      if (slotBookings > 0) {
        throw { statusCode: 409, message: "Slot already booked" };
      }

      // AUTH CHECKS
      if (String(oldAppt.userId) !== String(userId)) {
        throw { statusCode: 403, message: "Not authorized" };
      }
      console.log('📅 Appointment status:', oldAppt.status, 'paymentStatus:', oldAppt.paymentStatus);
      
      // 🔥 FIXED STATUS CHECK
      if (["COMPLETED", "CANCELLED"].includes(oldAppt.status) && oldAppt.status !== 'PENDING_PAYMENT') {
        throw { statusCode: 400, message: "Cannot reschedule completed/cancelled appointments" };
      }

      // 🔥 SAFE MULTIPLE RESCHEDULE BLOCK
      const currentRescheduleCount = Number(oldAppt.rescheduleCount || 0);
      if (currentRescheduleCount >= 1) {
        throw { statusCode: 400, message: "Cannot reschedule more than once per policy" };
      }

      // FINANCIAL LOGIC
      const oldPrice = Number(oldAppt.amount || 0);
      const newPrice = Number(newSlot.price || 0);
      const oldPaidAmount = oldAppt.paymentStatus === "PAID" ? oldPrice : 0;
      const isOfflineToOnline = oldAppt.slot.paymentMode === 'OFFLINE' && newSlot.paymentMode === 'ONLINE';
      
      let needsPayment = false, financialStatus = 'NO_CHANGE', diffAmount = 0, adminNote = '';
      console.log(`💳 Old: ${oldAppt.slot.paymentMode}(${oldAppt.paymentStatus}) ₹${oldPrice} → New: ${newSlot.paymentMode} ₹${newPrice}`);

      if (newPrice > oldPaidAmount) {
        needsPayment = true; financialStatus = 'PAY_DIFFERENCE'; diffAmount = newPrice - oldPaidAmount;
        adminNote = `Pay ₹${diffAmount} difference (₹${oldPaidAmount} already paid)`;
      } else if (newPrice < oldPaidAmount) {
        needsPayment = false; financialStatus = 'REFUND_AT_CLINIC'; diffAmount = oldPaidAmount - newPrice;
        adminNote = `Refund ₹${diffAmount} at clinic (Paid ₹${oldPaidAmount}, New ₹${newPrice})`;
      } else if (isOfflineToOnline) {
        needsPayment = true; financialStatus = 'OFFLINE_TO_ONLINE'; diffAmount = newPrice;
        adminNote = `Pay ₹${newPrice} for online slot`;
      } else {
        financialStatus = 'NO_CHANGE'; adminNote = `Rescheduled (no financial change)`;
      }

      const oldSlotId = oldAppt.slotId;
      if (oldSlotId && oldSlotId !== newSlotId) {
        await tx.slot.update({ where: { id: oldSlotId }, data: { status: 'PENDING', isBlocked: false } });
      }

      // 🔥 BASE UPDATE DATA
   const baseData = {
  slotId: newSlotId,  // 🔥 DIRECT FK - No connect validation
  adminNote: `RESCHEDULED: ${adminNote}`,
  status: needsPayment ? 'PENDING_PAYMENT' : 'CONFIRMED',
  paymentStatus: needsPayment ? 'PENDING' : 'PAID',
  financialStatus,
  amount: newPrice,
  diffAmount: diffAmount,
  updatedAt: new Date()
};


      // 🔥 SAFE TRACKING (schema compatible)
      const safeTracking = {
        ...(typeof oldAppt.rescheduleCount !== 'undefined' && 
          (!needsPayment ? { rescheduleCount: { increment: 1 } } : {})
        ),
        ...(typeof oldAppt.type !== 'undefined' && { type: 'RESCHEDULE' }),
        ...(Array.isArray(oldAppt.history) && {
          history: {
            push: {
              oldSlotId, 
              oldDate: oldAppt.slot.date.toISOString(),
              newDate: newSlot.date.toISOString(), 
              oldTime: oldAppt.slot.time,
              newTime: newSlot.time, 
              timestamp: new Date().toISOString()
            }
          }
        })
      };

      // 🔥 RACE CONDITION FIX - Verify slot still exists
await tx.slot.findUniqueOrThrow({ 
  where: { id: newSlotId, deletedAt: null } 
});
      // 🔥 UPDATE APPOINTMENT
      const updatedAppt = await tx.appointment.update({
        where: { id: appointmentId },
        data: { ...baseData, ...safeTracking },
        include: { 
          clinic: { include: { gateways: { where: { name: provider, isActive: true } } } }, 
          slot: true 
        }
      });

      // 🔥 LOCK NEW SLOT
      await tx.slot.update({
        where: { id: newSlotId },
        data: { status: needsPayment ? 'PENDING_PAYMENT' : 'CONFIRMED', isBlocked: needsPayment }
      });

      // 🔥 RESCHEDULE LOG
      await tx.appointmentLog.create({
        data: {
          appointmentId,
          oldDate: oldAppt.slot.date,
          oldTime: oldAppt.slot.time,
          newDate: newSlot.date,
          newTime: newSlot.time,
          changedBy: userId,
          reason: `Rescheduled: ${financialStatus}`,
          metadata: { 
            oldSlotId: oldAppt.slotId,
            newSlotId,
            oldPrice,
            newPrice,
            financialStatus 
          }
        }
      });

      // 🔥 NOTIFICATION
      await tx.notification.create({
        data: {
          clinicId: updatedAppt.clinicId,
          type: 'RESCHEDULE',
          entityId: appointmentId,
          message: `Patient rescheduled to ${newSlot.time} on ${new Date(newSlot.date).toLocaleDateString('en-IN')}`
        }
      });

      // 🔥 GCal UPDATE (if no payment needed)
if (!needsPayment) {
  // 🔥 SMART GCAL: Create if missing, update if exists
  try {
    if (updatedAppt.googleCalendarEventId) {
      await updateAppointmentOnGCal(appointmentId);
      console.log('📅 GCal UPDATED:', appointmentId);
    } else {
      await autoSyncAppointmentToGCal(appointmentId);
      console.log('📅 GCal CREATED:', appointmentId);
    }
  } catch (gcalErr) {
    console.error('❌ GCal Sync Failed:', gcalErr.message);
  }
  
  return {
    status: 'SUCCESS',
    message: financialStatus === 'REFUND_AT_CLINIC' 
      ? `Rescheduled! Get ₹${diffAmount} refund at clinic.` 
      : 'Rescheduled successfully!',
    data: { updatedAppt, financialStatus, refundAmount: financialStatus === 'REFUND_AT_CLINIC' ? diffAmount : 0 }
  };
}


      // 🔥 RAZORPAY PAYMENT (needsPayment = true)
      const gateways = updatedAppt.clinic.gateways || [];
      const gateway = gateways.find(g => g.name === provider && g.isActive);

      if (!gateway?.apiKey || !gateway?.secret) {
        return { 
          status: 'CLINIC_PAYMENT', 
          message: `Pay ₹${diffAmount} at clinic`, 
          data: { appointmentId, amount: diffAmount, clinic: updatedAppt.clinic } 
        };
      }

      const razorpay = new Razorpay({ key_id: gateway.apiKey, key_secret: gateway.secret });
      const receipt = `resch_${appointmentId.slice(-10)}`;
      const razorpayOrder = await razorpay.orders.create({
        amount: Math.round(diffAmount * 100), 
        currency: 'INR', 
        receipt,
        notes: { 
          type: financialStatus, 
          appointmentId, 
          slotId: newSlotId, 
          oldAmount: oldPaidAmount, 
          newAmount: newPrice, 
          difference: diffAmount 
        }
      });

      return {
        status: 'PAYMENT_REQUIRED',
        message: `Pay ₹${diffAmount} difference`,
        data: { 
          appointmentId, 
          key: gateway.apiKey, 
          amount: razorpayOrder.amount, 
          orderId: razorpayOrder.id, 
          diffAmount, 
          oldPaidAmount, 
          newPrice, 
          expiresIn: 600, 
          paymentExpiry: new Date(Date.now() + 10 * 60 * 1000).toISOString() 
        }
      };
    });

    res.json(result);

  } catch (error) {
    console.error('❌ RESCHEDULE ERROR:', { appointmentId, userId, newSlotId, error: error.message });
    
    if (error.code === 'P2002') return res.status(409).json({ error: 'Slot taken. Try again.' });
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    return res.status(500).json({ error: 'Reschedule failed - please try again' });
  }
};







// export const rescheduleAppointment = async (req, res) => {
//   try {
//     const userId = req.user?.id || req.user?.userId || req.user?._id;
//     const userRole = req.user?.role || 'USER'; 
//     const { id } = req.params; 
//     const appointmentId = id || req.body.appointmentId; 
//     const { newSlotId, provider = 'RAZORPAY' } = req.body; 

//     if (!appointmentId || !newSlotId) {
//       return res.status(400).json({ error: 'Missing required fields' });
//     }

//     const result = await prisma.$transaction(async (tx) => {
//       // 1. ATOMIC FETCH
//       const [oldAppt, newSlot, slotBookings] = await Promise.all([
//         tx.appointment.findUnique({ 
//           where: { id: appointmentId },
//           include: { 
//             slot: true, 
//             clinic: { include: { gateways: { where: { name: provider, isActive: true } } } },
//             doctor: true 
//           }
//         }),
//         tx.slot.findUnique({ where: { id: newSlotId }, include: { clinic: true } }),
//         tx.appointment.count({
//           where: { slotId: newSlotId, status: { notIn: ['CANCELLED'] }, deletedAt: null }
//         })
//       ]);

//       if (!oldAppt || !newSlot) throw { statusCode: 404, message: "Appointment/Slot not found" };
//       if (slotBookings > 0) throw { statusCode: 409, message: "Slot already booked" };

//       // AUTH CHECKS
//       const isOwner = String(oldAppt.userId) === String(userId);
//       const isAdmin = ['SUPER_ADMIN', 'ADMIN', 'DOCTOR'].includes(userRole);

//       if (!isOwner && !isAdmin) throw { statusCode: 403, message: "Not authorized" };
//       if (["COMPLETED", "CANCELLED"].includes(oldAppt.status)) throw { statusCode: 400, message: "Cannot reschedule completed/cancelled" };

//       if (!isAdmin && (oldAppt.rescheduleCount || 0) >= 1) {
//         throw { statusCode: 400, message: "You can only reschedule once. Please cancel and re-book." };
//       }

//       // 2. FINANCIAL LOGIC
//       const oldPrice = Number(oldAppt.amount || 0);
//       const newPrice = Number(newSlot.price || 0);
//       const oldPaidAmount = oldAppt.paymentStatus === "PAID" ? oldPrice : 0;
//       const isTargetOffline = newSlot.paymentMode === 'OFFLINE' || newSlot.paymentMode === 'CLINIC';
//       const wasOnlinePaid = oldAppt.paymentStatus === "PAID" && oldAppt.slot.paymentMode === 'ONLINE';
      
//       let needsPayment = false;
//       let financialStatus = 'NO_CHANGE';
//       let diffAmount = 0;
//       let adminNote = '';

//       if (isTargetOffline) {
//         needsPayment = false;
//         if (newPrice === 0) {
//           if (wasOnlinePaid && oldPaidAmount > 0) {
//             financialStatus = 'FULL_REFUND';
//             diffAmount = oldPaidAmount;
//             adminNote = `Refund FULL ₹${oldPaidAmount}`;
//           } else {
//             financialStatus = 'FREE_SLOT';
//             adminNote = `Free slot`;
//           }
//         } else if (wasOnlinePaid && oldPaidAmount > 0) {
//           if (newPrice > oldPaidAmount) {
//             financialStatus = 'PAY_DIFFERENCE_OFFLINE';
//             diffAmount = newPrice - oldPaidAmount;
//             adminNote = `Collect ₹${diffAmount} more at clinic`;
//           } else if (newPrice < oldPaidAmount) {
//             financialStatus = 'REFUND_AT_CLINIC';
//             diffAmount = oldPaidAmount - newPrice;
//             adminNote = `Refund ₹${diffAmount} at clinic`;
//           } else {
//             financialStatus = 'NO_CHANGE';
//             adminNote = `Rescheduled (no price change)`;
//           }
//         } else {
//           financialStatus = 'PAY_AT_CLINIC';
//           diffAmount = newPrice;
//           adminNote = `Collect FULL ₹${newPrice} at clinic`;
//         }
//       } else {
//         if (newPrice > oldPaidAmount) {
//           needsPayment = true;
//           financialStatus = 'PAY_DIFFERENCE';
//           diffAmount = newPrice - oldPaidAmount;
//           adminNote = `Pay ₹${diffAmount} online`;
//         } else if (newPrice < oldPaidAmount) {
//           needsPayment = false;
//           financialStatus = 'REFUND_AT_CLINIC';
//           diffAmount = oldPaidAmount - newPrice;
//           adminNote = `Refund ₹${diffAmount}`;
//         } else {
//           financialStatus = 'NO_CHANGE';
//           adminNote = `Rescheduled (same price)`;
//         }
//       }

//       // FREE OLD SLOT
//       const oldSlotId = oldAppt.slotId;
//       if (oldSlotId && oldSlotId !== newSlotId) {
//         await tx.slot.update({
//           where: { id: oldSlotId },
//           data: { status: 'PENDING', isBlocked: false }
//         });
//       }

//       // UPDATE APPOINTMENT
//       const newPaymentStatus = needsPayment ? 'PENDING' : (newPrice === 0 ? 'PAID' : (isTargetOffline ? 'PENDING' : 'PAID'));
//       const newStatus = needsPayment ? 'PENDING_PAYMENT' : 'CONFIRMED';

//       const updatedAppt = await tx.appointment.update({
//         where: { id: appointmentId },
//         data: {
//           slotId: newSlotId,
//           status: newStatus,
//           paymentStatus: newPaymentStatus, 
//           financialStatus,
//           amount: newPrice,
//           diffAmount: diffAmount,
//           adminNote: adminNote,
//           updatedAt: new Date(),
//           rescheduleCount: { increment: 1 } 
//         },
//         include: { 
//           clinic: { include: { gateways: { where: { name: provider, isActive: true } } } },
//           slot: true 
//         }
//       });

//       // 🔥 LOG RESCHEDULE HISTORY (FIXED!)
//       await tx.appointmentLog.create({
//         data: {
//           appointmentId: appointmentId,
//           oldDate: oldAppt.slot.date,
//           oldTime: oldAppt.slot.time,
//           newDate: newSlot.date,
//           newTime: newSlot.time,
//           reason: "User Rescheduled",
//           changedBy: userId,
//           metadata: { 
//             fromSlotId: oldAppt.slotId, 
//             toSlotId: newSlotId,
//             financialStatus,
//             diffAmount
//           }
//         }
//       });

//       // LOCK NEW SLOT
//       await tx.slot.update({
//         where: { id: newSlotId },
//         data: { 
//           status: needsPayment ? 'PENDING_PAYMENT' : 'CONFIRMED', 
//           isBlocked: needsPayment 
//         }
//       });

//       // SUCCESS RESPONSE
//       if (!needsPayment) {
//         return {
//           status: 'SUCCESS',
//           message: 'Rescheduled successfully!',
//           data: { updatedAppt }
//         };
//       }

//       // PAYMENT REQUIRED
//       const gateways = updatedAppt.clinic.gateways || [];
//       const gateway = gateways.find(g => g.name === provider && g.isActive);

//       if (!gateway?.apiKey || !gateway?.secret) {
//         return {
//           status: 'CLINIC_PAYMENT',
//           message: `Pay ₹${diffAmount} at clinic`,
//           data: { appointmentId, amount: diffAmount }
//         };
//       }

//       const razorpay = new Razorpay({
//         key_id: gateway.apiKey,
//         key_secret: gateway.secret
//       });

//       const receipt = `resch_${appointmentId.slice(-10)}`;
//       const razorpayOrder = await razorpay.orders.create({
//         amount: Math.round(diffAmount * 100),
//         currency: 'INR',
//         receipt: receipt,
//         notes: { 
//           type: financialStatus,
//           appointmentId, 
//           slotId: newSlotId,
//           userRole 
//         }
//       });

//       return {
//         status: 'PAYMENT_REQUIRED',
//         message: `Pay ₹${diffAmount}`,
//         data: {
//           appointmentId,
//           key: gateway.apiKey,
//           amount: razorpayOrder.amount,
//           orderId: razorpayOrder.id,
//           expiresIn: 600
//         }
//       };
//     });

//     return res.json(result);

//   } catch (error) {
//     console.error('❌ RESCHEDULE ERROR:', error);
//     if (error.code === 'P2002') return res.status(409).json({ error: 'Slot taken.' });
//     if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
//     return res.status(500).json({ error: 'Reschedule failed' });
//   }
// };

  







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

    const where = { 
      userId, 
      deletedAt: null
    };

    // 🔥 FIXED STATUS LOGIC - "All" shows EVERYTHING!
    if (status && status !== "") {
      where.status = { equals: status };
    } else {
      where.status = {
        in: [
          'PENDING',
          'PENDING_PAYMENT',
          'CONFIRMED',
          'COMPLETED',
          'CANCELLED',
          'CANCEL_REQUESTED',
          'NO_SHOW'
        ]
      };
    }

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
          // 🔥 NEW: For refund/reject messages
          cancellationRequest: {
            select: {
              id: true,
              status: true,
              reason: true,
            }
          },
          // 🔥 NEW: Payment details
          payment: {
            select: {
              id: true,
              status: true,
              gatewayRefId: true,
            }
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

      // 🔥 FIXED: Essential reschedule fields for frontend
      type: app.type,                    // ✅ isRescheduled check #1
      rescheduleCount: app.rescheduleCount, // ✅ isRescheduled check #2 + blocks multiples
      adminNote: app.adminNote,          // ✅ isRescheduled check #4 + messages

      cancelledBy: app.cancelledBy,
      paymentStatus: app.paymentStatus,
      financialStatus: app.financialStatus,
      cancelReason: app.cancelReason,

      doctor: app.doctor,
      slot: app.slot,
      clinic: app.clinic,
      review: app.review,
      cancellationRequest: app.cancellationRequest,
      payment: app.payment,

      prescription: app.prescription || null,

      // payment info for AppointmentCard
      amount: app.amount ?? app.slot?.price ?? 0,
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
      })),  // ✅ isRescheduled check #3
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


