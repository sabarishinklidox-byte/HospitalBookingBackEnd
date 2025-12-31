

// ----------------------------------------------------------------
// GET APPOINTMENTS (List)
// ----------------------------------------------------------------


// ----------------------------------------------------------------
// UPDATE STATUS (Admin quick actions)
// ----------------------------------------------------------------


// ----------------------------------------------------------------
// RESCHEDULE APPOINTMENT BY ADMIN
// ----------------------------------------------------------------


// ----------------------------------------------------------------
// GET SINGLE APPOINTMENT DETAILS
// ----------------------------------------------------------------


// ----------------------------------------------------------------
// GET APPOINTMENTS (List)
// ----------------------------------------------------------------
import prisma from "../prisma.js";
import { logAudit } from "../utils/audit.js";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";
import { sendBookingEmails,sendAppointmentStatusEmail, 
  sendCancellationEmail 
    } from '../utils/email.js';
// ----------------------------------------------------------------
// GET APPOINTMENTS (List)
// ----------------------------------------------------------------

export const getAppointments = async (req, res) => {
  try {
    const { clinicId } = req.user;
    if (!clinicId) {
      return res.status(400).json({ error: "Clinic ID missing from request" });
    }

    const {
      status,
      date,
      doctor,
      patient,
      dateFrom,
      dateTo,
      page = 1,
      limit = 10,
    } = req.query;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    const skip = (pageNum - 1) * limitNum;

    // helper: build UTC day range from YYYY-MM-DD
    const parseYmdToRange = (ymd) => {
      const [y, m, d] = String(ymd).split("-").map(Number);
      if (!y || !m || !d) return null;
      const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
      const end = new Date(Date.UTC(y, m - 1, d + 1, 0, 0, 0, 0)); // exclusive
      return { start, end };
    };

    const where = { clinicId, deletedAt: null };

    if (status) where.status = status;

    if (date) {
      const range = parseYmdToRange(date);
      if (range) {
        where.slot = { date: { gte: range.start, lt: range.end } };
      }
    } else if (dateFrom || dateTo) {
      where.slot = { date: {} };
      if (dateFrom) {
        const rangeFrom = parseYmdToRange(dateFrom);
        if (rangeFrom) where.slot.date.gte = rangeFrom.start;
      }
      if (dateTo) {
        const rangeTo = parseYmdToRange(dateTo);
        if (rangeTo) where.slot.date.lte = rangeTo.end;
      }
    }

    if (doctor) where.doctorId = doctor;

    if (patient) {
      where.user = {
        OR: [
          { name: { contains: patient, mode: "insensitive" } },
          { phone: { contains: patient } },
        ],
      };
    }

    const [totalAppointments, appointments] = await prisma.$transaction([
      prisma.appointment.count({ where }),
      prisma.appointment.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip,
        take: limitNum,
        include: {
          user: { select: { name: true, phone: true, email: true } },
          doctor: { select: { name: true, speciality: true } },
          slot: {
            select: {
              date: true,
              time: true,
              paymentMode: true,
              type: true,
              price: true,
              isBlocked: true,
              blockedReason: true,
            },
          },
          logs: { orderBy: { createdAt: "desc" } },
        },
      }),
    ]);

    const appointmentIds = appointments.map((a) => a.id);

    const unreadNotifs = appointmentIds.length
      ? await prisma.notification.findMany({
          where: {
            clinicId,
            type: { in: ["CANCELLATION", "RESCHEDULE"] },
            readAt: null,
            entityId: { in: appointmentIds },
          },
          select: { entityId: true, type: true },
        })
      : [];

    const unreadCancellationSet = new Set(
      unreadNotifs
        .filter((n) => n.type === "CANCELLATION")
        .map((n) => n.entityId)
    );

    const unreadRescheduleSet = new Set(
      unreadNotifs
        .filter((n) => n.type === "RESCHEDULE")
        .map((n) => n.entityId)
    );

    const formatted = appointments.map((app) => ({
      id: app.id,
      status: app.status,
      userId: app.userId,
      doctorId: app.doctorId,
      
      // 🔥 FIXED: ADDED createdAt FOR "Booked On" DISPLAY
      createdAt: app.createdAt,

      patientName: app.user?.name || "Unknown",
      patientPhone: app.user?.phone || "N/A",
      patientEmail: app.user?.email || "",

      doctorName: app.doctor?.name || "Unknown",
      doctorSpecialization: app.doctor?.speciality || "",

      date: app.slot?.date,
      time: app.slot?.time,
      dateFormatted: app.slot?.date
        ? new Date(app.slot.date).toLocaleDateString()
        : "N/A",
      timeFormatted: app.slot?.time || "N/A",

      // Slot payment info
      paymentMode: app.slot?.paymentMode || null,
      slotType: app.slot?.type || null,
      price: app.slot?.price ?? null,

      // Booking finance info
      amount: Number(app.amount ?? 0),
      paymentStatus: app.paymentStatus,
      financialStatus: app.financialStatus,
      diffAmount: Number(app.diffAmount ?? 0),
      adminNote: app.adminNote || null,
      cancelReason: app.cancelReason || null,
      cancelledBy: app.cancelledBy || null,

      isSlotBlocked: app.slot?.isBlocked || false,
      blockedReason: app.slot?.blockedReason || null,

      hasUnreadCancellation: unreadCancellationSet.has(app.id),
      hasUnreadReschedule: unreadRescheduleSet.has(app.id),

      history: (app.logs || []).map((log) => ({
        id: log.id,
        action: "RESCHEDULE_APPOINTMENT",
        changedBy: log.changedBy,
        timestamp: new Date(log.createdAt).toLocaleString(),
        oldDate: log.details?.oldDate
          ? new Date(log.details.oldDate).toLocaleDateString()
          : null,
        newDate: log.details?.newDate
          ? new Date(log.details.newDate).toLocaleDateString()
          : null,
        oldTime: log.details?.oldTime || null,
        newTime: log.details?.newTime || null,
        reason: log.details?.reason || null,
      })),
    }));

    return res.json({
      data: formatted,
      pagination: {
        total: totalAppointments,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalAppointments / limitNum),
      },
    });
  } catch (error) {
    console.error("Get Appointments Error:", error);
    return res.status(500).json({ error: error.message });
  }
};


// ----------------------------------------------------------------
// UPDATE STATUS (Admin quick actions)
// ----------------------------------------------------------------
// export const updateAppointmentStatus = async (req, res) => {
//   try {
//     const { clinicId, userId } = req.user;
//     const { id } = req.params;
//     const { status, reason } = req.body;

//     const validStatuses = ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED"];
//     if (!validStatuses.includes(status)) {
//       return res.status(400).json({ error: "Invalid status value" });
//     }

//     const existing = await prisma.appointment.findFirst({
//       where: { id, clinicId, deletedAt: null },
//       include: { slot: true, user: true },
//     });
//     if (!existing) {
//       return res.status(404).json({ error: "Appointment not found" });
//     }

//     const data = { status };
//     if (status === "CANCELLED") {
//       data.cancelReason = reason || "Cancelled by clinic";
//       // if you have cancelledBy in schema:
//       // data.cancelledBy = "ADMIN";
//     }

//     const updated = await prisma.$transaction(async (tx) => {
//       const appt = await tx.appointment.update({
//         where: { id },
//         data,
//       });

//       if (status === "CANCELLED") {
//         // ✅ admin action => create as READ (no blinking)
//         await tx.notification.create({
//           data: {
//             clinicId,
//             type: "CANCELLATION",
//             entityId: id,
//             message: `Cancelled by admin — ${reason || "Cancelled by clinic"}`,
//             readAt: new Date(),
//           },
//         });
//       }

//       return appt;
//     });

//     await logAudit({
//       userId: userId || req.user.userId,
//       clinicId,
//       action: "UPDATE_STATUS",
//       entity: "Appointment",
//       entityId: id,
//       details: {
//         previousStatus: existing.status,
//         newStatus: status,
//         reason: status === "CANCELLED" ? (reason || "Cancelled by clinic") : null,
//       },
//       req,
//     });

//     return res.json({
//       message: `Appointment status updated to ${status}`,
//       appointment: updated,
//     });
//   } catch (error) {
//     console.error("Update Status Error:", error);
//     return res.status(500).json({ error: error.message });
//   }
// };
export const updateAppointmentStatus = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { status, reason, adminNote } = req.body;

    const validStatuses = ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED", "REJECTED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const existing = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
      include: { 
        slot: { 
          include: { 
            doctor: true,
            clinic: true 
          } 
        }, 
        user: true 
      },
    });
    
    if (!existing) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    const data = { status };

    if (status === "CANCELLED") {
      data.cancelReason = reason || "Cancelled by clinic";
    }

    if (status === "REJECTED") {
      data.cancelReason = reason || "Rejected by clinic"; // ✅ REJECT reason
    }

    // ✅ When clinic marks COMPLETED, assume settlement is done
    if (status === "COMPLETED") {
      data.paymentStatus = "PAID";
      data.financialStatus = null;
      data.diffAmount = 0;
      if (adminNote) data.adminNote = adminNote;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const appt = await tx.appointment.update({
        where: { id },
        data,
      });

      if (status === "CANCELLED" || status === "REJECTED") {
        await tx.notification.create({
          data: {
            clinicId,
            type: status === "REJECTED" ? "REJECTION" : "CANCELLATION",
            entityId: id,
            message: `${status} by admin — ${reason || `${status.toLowerCase()} by clinic`}`,
            readAt: new Date(),
          },
        });
      }

      return appt;
    });

    // 🔥 SEND EMAIL FOR CONFIRMED/REJECTED/CANCELLED
    if (["CONFIRMED", "REJECTED", "CANCELLED"].includes(status)) {
      await sendAppointmentStatusEmail(existing, status, reason, req.user);
    }

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: "UPDATE_STATUS",
      entity: "Appointment",
      entityId: id,
      details: {
        previousStatus: existing.status,
        newStatus: status,
        reason: status === "CANCELLED" || status === "REJECTED" ? (reason || `${status.toLowerCase()} by clinic`) : null,
        financialBefore: {
          paymentStatus: existing.paymentStatus,
          financialStatus: existing.financialStatus,
          diffAmount: existing.diffAmount,
        },
        financialAfter: status === "COMPLETED"
          ? {
              paymentStatus: "PAID",
              financialStatus: null,
              diffAmount: 0,
              adminNote: adminNote || null,
            }
          : null,
      },
      req,
    });

    return res.json({
      message: `Appointment status updated to ${status}`,
      appointment: updated,
    });
  } catch (error) {
    console.error("Update Status Error:", error);
    return res.status(500).json({ error: error.message });
  }
};



// ----------------------------------------------------------------
// RESCHEDULE APPOINTMENT BY ADMIN
// ----------------------------------------------------------------
 // Ensure this handles the RESCHEDULE type logic we discussed

export const rescheduleAppointmentByAdmin = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { newDate, newTime, note } = req.body;

    console.log('🔍 Admin Reschedule Request:', { id, newDate, newTime });

    // 🔥 1. VALIDATE DATE FIRST (BLOCK INVALID!)
    const safeDate = (dateStr) => {
      if (!dateStr || typeof dateStr !== 'string') return null;
      const date = new Date(dateStr);
      if (isNaN(date.getTime()) || date.toString() === 'Invalid Date') return null;
      // Ensure it's a valid date (not 1970)
      if (date.getFullYear() < 2020) return null;
      return date;
    };

    const targetDate = safeDate(newDate);
    if (!targetDate || !newTime) {
      console.error('❌ INVALID DATE:', newDate);
      return res.status(400).json({ 
        error: 'Invalid date or time format. Use YYYY-MM-DD and HH:MM' 
      });
    }

    console.log('✅ Valid date:', targetDate);

    // 2. Fetch Appointment
    const appt = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
      include: { 
        slot: true, 
        doctor: true, 
        user: true, 
        payment: true, 
        clinic: true 
      },
    });

    if (!appt) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const oldSlot = appt.slot;
    console.log('📅 Old slot:', oldSlot.date, oldSlot.time);

    // 3. Find/Create New Slot
    let newSlot = await prisma.slot.findFirst({
      where: {
        clinicId,
        doctorId: appt.doctorId,
        date: targetDate,
        time: newTime,
        deletedAt: null,
      },
    });

    if (!newSlot) {
      newSlot = await prisma.slot.create({
        data: {
          clinicId,
          doctorId: appt.doctorId,
          date: targetDate,
          time: newTime,
          duration: oldSlot.duration || 30,
          type: oldSlot.type || 'REGULAR',
          price: oldSlot.price || 0,
          paymentMode: oldSlot.paymentMode || 'OFFLINE',
          status: 'PENDING',
          isBlocked: false,
        },
      });
      console.log('🆕 New slot created:', newSlot.id);
    }

    // 4. Collision Check
    const anyApptOnSlot = await prisma.appointment.findFirst({
      where: {
        slotId: newSlot.id,
        deletedAt: null,
        id: { not: appt.id },
      },
    });

    if (anyApptOnSlot) {
      return res.status(409).json({ error: 'Slot already booked by another patient' });
    }

    // 🔥 5. FINANCIAL LOGIC
    const oldPrice = Number(appt.amount || 0);
    const oldPaidAmount = appt.paymentStatus === "PAID" ? Number(appt.payment?.amount || 0) : 0;
    const newPrice = Number(newSlot.price || 0);
    const isTargetOffline = newSlot.paymentMode === 'OFFLINE' || newSlot.paymentMode === 'CLINIC';

    let financialStatus = 'NO_CHANGE';
    let diffAmount = 0;
    let adminNote = '';

    if (isTargetOffline) {
      if (newPrice === 0) {
        if (oldPaidAmount > 0) {
          financialStatus = 'FULL_REFUND';
          diffAmount = oldPaidAmount;
          adminNote = `Refund FULL ₹${(diffAmount/100).toFixed(0)} (online payment)`;
        } else {
          financialStatus = 'FREE_SLOT';
          adminNote = 'Free consultation';
        }
      } else if (oldPaidAmount > 0) {
        if (newPrice > oldPaidAmount) {
          financialStatus = 'PAY_DIFFERENCE_OFFLINE';
          diffAmount = newPrice - oldPaidAmount;
          adminNote = `Collect ₹${(diffAmount/100).toFixed(0)} more (already paid ₹${(oldPaidAmount/100).toFixed(0)})`;
        } else if (newPrice < oldPaidAmount) {
          financialStatus = 'REFUND_AT_CLINIC';
          diffAmount = oldPaidAmount - newPrice;
          adminNote = `Refund ₹${(diffAmount/100).toFixed(0)} (paid ₹${(oldPaidAmount/100).toFixed(0)})`;
        } else {
          adminNote = `Same price ₹${(newPrice/100).toFixed(0)}`;
        }
      } else {
        financialStatus = 'PAY_AT_CLINIC';
        diffAmount = newPrice;
        adminNote = `Collect FULL ₹${(newPrice/100).toFixed(0)} cash`;
      }
    } else {
      // Online target (rare for admin)
      if (newPrice !== oldPaidAmount) {
        financialStatus = newPrice > oldPaidAmount ? 'PAY_DIFFERENCE' : 'REFUND_AT_CLINIC';
        diffAmount = Math.abs(newPrice - oldPaidAmount);
        adminNote = newPrice > oldPaidAmount 
          ? `Pay ₹${(diffAmount/100).toFixed(0)} more online`
          : `Refund ₹${(diffAmount/100).toFixed(0)}`;
      }
    }

    console.log(`💰 Financial: ${financialStatus} | ${adminNote}`);

    // 6. TRANSACTION - Atomic Update
    const updated = await prisma.$transaction(async (tx) => {
      // Free old slot
      await tx.slot.update({
        where: { id: oldSlot.id },
        data: { 
          status: 'PENDING', 
          isBlocked: false 
        },
      });

      // Update appointment
      const updatedAppt = await tx.appointment.update({
        where: { id: appt.id },
        data: {
          slotId: newSlot.id,
          status: 'CONFIRMED',           // ✅ Admin = INSTANT CONFIRM
          paymentStatus: appt.paymentStatus, // ✅ Keep original status
          financialStatus,
          amount: newPrice,
          diffAmount,
          adminNote,
          updatedAt: new Date(),
          rescheduleCount: { increment: 1 }
        },
        include: { 
          slot: true, 
          doctor: true, 
          user: true, 
          clinic: true,
          payment: true 
        },
      });

      // Confirm new slot
      await tx.slot.update({
        where: { id: newSlot.id },
        data: { 
          status: 'CONFIRMED',
          isBlocked: false 
        }
      });

      // Audit log
      await tx.appointmentLog.create({
        data: {
          appointmentId: appt.id,
          oldDate: oldSlot.date,
          oldTime: oldSlot.time,
          newDate: targetDate,
          newTime,
          reason: note || adminNote,
          changedBy: userId,
        },
      });

      return updatedAppt;
    });

    console.log('✅ Reschedule COMPLETE');
    res.json({
      success: true,
      message: `Rescheduled successfully! ${adminNote}`,
      appointment: updated,
      financialAction: adminNote,
    });
  } catch (error) {
    console.error('❌ Admin Reschedule FAILED:', error);
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    return res.status(500).json({ error: 'Reschedule failed - check date format' });
  }
};

// ----------------------------------------------------------------
// CANCEL APPOINTMENT (Admin) – direct admin cancel OR approve pending request
// ----------------------------------------------------------------
export const cancelAppointment = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { reason } = req.body || {};

    const existing = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
      include: { 
        cancellationRequest: true, 
        slot: { 
          include: { 
            doctor: true,
            clinic: true  // 🔥 ADD clinic details for email
          } 
        },
        user: true  // 🔥 ADD user for email
      },
    });

    if (!existing) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    if (["COMPLETED", "NO_SHOW"].includes(existing.status)) {
      return res
        .status(400)
        .json({ error: "Cannot cancel completed/no-show appointment" });
    }

    const finalReason = reason || existing.cancelReason || "Cancelled by clinic";
    const hasPendingRequest =
      !!existing.cancellationRequest &&
      existing.cancellationRequest.status === "PENDING";

    const readAtForNotification = hasPendingRequest ? null : new Date();

    const [updatedAppt, updatedReq] = await prisma.$transaction([
      prisma.appointment.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelReason: finalReason,
        },
      }),

      hasPendingRequest
        ? prisma.cancellationRequest.update({
            where: { appointmentId: existing.id },
            data: {
              status: "APPROVED",
              processedAt: new Date(),
              processedById: userId || req.user.userId,
              reason: finalReason,
            },
          })
        : Promise.resolve(null),

      prisma.notification.create({
        data: {
          clinicId,
          type: "CANCELLATION",
          entityId: id,
          message: hasPendingRequest
            ? `Cancelled by patient — ${finalReason}`
            : `Cancelled by admin — ${finalReason}`,
          readAt: readAtForNotification,
        },
      }),
    ]);

    // 🔥 SEND CANCELLATION EMAIL TO PATIENT
    await sendCancellationEmail(existing, finalReason, hasPendingRequest, req.user);

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: "CANCEL_APPOINTMENT",
      entity: "Appointment",
      entityId: id,
      details: {
        previousStatus: existing.status,
        newStatus: "CANCELLED",
        reason: finalReason,
        paymentMode: existing.slot?.paymentMode || null,
        hadCancellationRequest: hasPendingRequest,
      },
      req,
    });

    return res.json({
      message: "Appointment cancelled successfully",
      appointment: updatedAppt,
      cancellationRequest: updatedReq,
    });
  } catch (error) {
    console.error("Cancel Error:", error);
    return res.status(500).json({ error: error.message });
  }
};






// ----------------------------------------------------------------
// UPDATE STATUS (Admin quick actions: CONFIRMED / COMPLETED / NO_SHOW / CANCELLED)
// ----------------------------------------------------------------


// ----------------------------------------------------------------
// RESCHEDULE APPOINTMENT BY ADMIN
// ----------------------------------------------------------------


// ----------------------------------------------------------------
// CANCEL APPOINTMENT (Admin) – direct admin cancel OR approve pending request


export const getAppointmentDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { clinicId } = req.user;

    const appointment = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
      include: {
        user:   { select: { id: true, name: true, email: true, phone: true } },
        doctor: { select: { id: true, name: true, speciality: true } },
        slot:   { select: { id: true, date: true, time: true, paymentMode: true, price: true } },
        clinic: true,
        logs:   { orderBy: { createdAt: "desc" } },
      },
    });
 console.log("ADMIN APPOINTMENT DETAILS RAW:", {
      id: appointment?.id,
      amount: appointment?.amount,
      paymentStatus: appointment?.paymentStatus,
      financialStatus: appointment?.financialStatus,
      diffAmount: appointment?.diffAmount,
      slot: appointment?.slot && {
        id: appointment.slot.id,
        paymentMode: appointment.slot.paymentMode,
        price: appointment.slot.price,
        date: appointment.slot.date,
        time: appointment.slot.time,
      },
    });
    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    const history = appointment.logs.map((log) => {
      const details = log.details || {};
      return {
        id: log.id,
        action: log.action,
        changedBy: log.userId,
        timestamp: new Date(log.createdAt).toLocaleString(),
        oldStatus: details.previousStatus || null,
        newStatus: details.newStatus || null,
        oldDate: details.oldDate ? new Date(details.oldDate).toLocaleDateString() : null,
        newDate: details.newDate ? new Date(details.newDate).toLocaleDateString() : null,
        oldTime: details.oldTime || null,
        newTime: details.newTime || null,
        reason: details.reason || null,
      };
    });

    const amount = Number(appointment.amount ?? 0); // ensure number
    const diffAmount = Number(appointment.diffAmount ?? 0);

    return res.json({
      id: appointment.id,
      status: appointment.status,
      paymentStatus: appointment.paymentStatus,
      financialStatus: appointment.financialStatus,
      amount,
      diffAmount,
      cancelReason: appointment.cancelReason,
      cancelledBy: appointment.cancelledBy,
      adminNote: appointment.adminNote,
      hasUnreadCancellation: appointment.hasUnreadCancellation,
      hasUnreadReschedule: appointment.hasUnreadReschedule,

      patient: appointment.user,
      doctor: appointment.doctor,
      clinic: appointment.clinic,

      slot: appointment.slot
        ? {
            id: appointment.slot.id,
            date: appointment.slot.date,
            time: appointment.slot.time,
            paymentMode: appointment.slot.paymentMode, // "CLINIC"/"ONLINE"/"FREE"
            price: Number(appointment.slot.price ?? 0),
          }
        : null,

      dateFormatted: appointment.slot
        ? new Date(appointment.slot.date).toLocaleDateString()
        : null,
      timeFormatted: appointment.slot?.time ?? null,

      history,
    });
  } catch (error) {
    console.error("Get Details Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// DELETE APPOINTMENT (Soft Delete)
// ----------------------------------------------------------------
export const deleteAppointment = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;

    const existing = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
    });

    if (!existing) return res.status(404).json({ error: 'Appointment not found' });

    await prisma.appointment.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        status: 'CANCELLED',
        cancelReason: 'Admin soft deleted appointment',
        cancelledBy: 'ADMIN',
      },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'DELETE_APPOINTMENT',
      entity: 'Appointment',
      entityId: id,
      details: { reason: 'Admin soft deleted appointment', cancelledBy: 'ADMIN' },
      req,
    });

    return res.json({ message: 'Appointment deleted successfully' });
  } catch (error) {
    console.error('Delete Appointment Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// EXPORT APPOINTMENTS TO PDF (respects filters)
// ----------------------------------------------------------------
export const exportAppointmentsPdf = async (req, res) => {
  try {
    const { clinicId } = req.user;
    if (!clinicId) return res.status(400).json({ error: 'Clinic ID missing from request' });

    const { status, doctor, patient, dateFrom, dateTo } = req.query;
    const where = { clinicId, deletedAt: null };

    if (status) where.status = status;

    if (dateFrom || dateTo) {
      where.slot = { date: {} };
      if (dateFrom) where.slot.date.gte = new Date(dateFrom);
      if (dateTo) where.slot.date.lte = new Date(dateTo);
    }

    if (doctor) where.doctorId = doctor;

    if (patient) {
      where.user = {
        OR: [
          { name: { contains: patient, mode: 'insensitive' } },
          { phone: { contains: patient } },
        ],
      };
    }

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, phone: true, email: true } },
        doctor: { select: { name: true, speciality: true } },
        slot: { select: { date: true, time: true } },
      },
    });

    const doc = new PDFDocument({ margin: 40, size: 'A4' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="bookings_${new Date().toISOString().slice(0, 10)}.pdf"`
    );

    doc.pipe(res);

    doc.fontSize(18).text('Bookings Report', { align: 'center' });
    doc.fontSize(10).text(`Clinic: ${clinicId}`, { align: 'center' }).moveDown(0.3);
    doc.fontSize(9).text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    appointments.forEach((app, idx) => {
      const dateStr = app.slot?.date ? new Date(app.slot.date).toLocaleDateString() : 'N/A';
      const timeStr = app.slot?.time || 'N/A';

      doc
        .fontSize(11)
        .text(`${idx + 1}. ${app.user?.name || 'Unknown'} (${app.user?.phone || 'N/A'})`);
      doc
        .fontSize(9)
        .fillColor('#555555')
        .text(`Doctor: ${app.doctor?.name || 'Unknown'} (${app.doctor?.speciality || ''})`);

      doc.text(`Schedule: ${dateStr} ${timeStr} | Status: ${app.status}`).moveDown(0.6);
      doc.fillColor('black');

      if (doc.y > 750) doc.addPage();
    });

    doc.end();
  } catch (error) {
    console.error('Export PDF Error:', error);
    res.status(500).json({ error: 'Failed to export PDF' });
  }
};

// ----------------------------------------------------------------
// EXPORT APPOINTMENTS TO EXCEL (respects filters)
// ----------------------------------------------------------------
export const exportAppointmentsExcel = async (req, res) => {
  try {
    const { clinicId } = req.user;
    if (!clinicId) return res.status(400).json({ error: 'Clinic ID missing from request' });

    const { status, doctor, patient, dateFrom, dateTo } = req.query;
    const where = { clinicId, deletedAt: null };

    if (status) where.status = status;

    if (dateFrom || dateTo) {
      where.slot = { date: {} };
      if (dateFrom) where.slot.date.gte = new Date(dateFrom);
      if (dateTo) where.slot.date.lte = new Date(dateTo);
    }

    if (doctor) where.doctorId = doctor;

    if (patient) {
      where.user = {
        OR: [
          { name: { contains: patient, mode: 'insensitive' } },
          { phone: { contains: patient } },
        ],
      };
    }

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { name: true, phone: true, email: true } },
        doctor: { select: { name: true, speciality: true } },
        slot: { select: { date: true, time: true } },
      },
    });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Bookings');

    sheet.columns = [
      { header: 'Patient Name', key: 'patientName', width: 22 },
      { header: 'Phone', key: 'patientPhone', width: 16 },
      { header: 'Email', key: 'patientEmail', width: 24 },
      { header: 'Doctor', key: 'doctorName', width: 22 },
      { header: 'Speciality', key: 'doctorSpecialization', width: 18 },
      { header: 'Date', key: 'dateFormatted', width: 14 },
      { header: 'Time', key: 'timeFormatted', width: 10 },
      { header: 'Status', key: 'status', width: 14 },
    ];

    appointments.forEach((app) => {
      sheet.addRow({
        patientName: app.user?.name || 'Unknown',
        patientPhone: app.user?.phone || 'N/A',
        patientEmail: app.user?.email || '',
        doctorName: app.doctor?.name || 'Unknown',
        doctorSpecialization: app.doctor?.speciality || '',
        dateFormatted: app.slot?.date ? new Date(app.slot.date).toLocaleDateString() : 'N/A',
        timeFormatted: app.slot?.time || 'N/A',
        status: app.status,
      });
    });

    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF0B3B5E' },
    };

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="bookings_${new Date().toISOString().slice(0, 10)}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export Excel Error:', error);
    res.status(500).json({ error: 'Failed to export Excel' });
  }
};

// ----------------------------------------------------------------
// CANCEL APPOINTMENT (Admin)  – direct admin cancel OR approve pending request
// ----------------------------------------------------------------

