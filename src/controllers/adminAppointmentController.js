

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

      paymentMode: app.slot?.paymentMode || null,
      slotType: app.slot?.type || null,
      price: app.slot?.price ?? null,

      isSlotBlocked: app.slot?.isBlocked || false,
      blockedReason: app.slot?.blockedReason || null,

      hasUnreadCancellation: unreadCancellationSet.has(app.id),
      hasUnreadReschedule: unreadRescheduleSet.has(app.id),

      history: (app.logs || []).map((log) => ({
        id: log.id,
        action: "RESCHEDULE_APPOINTMENT",
        changedBy: log.changedBy,
        timestamp: new Date(log.createdAt).toLocaleString(),
        oldDate: log.oldDate
          ? new Date(log.oldDate).toLocaleDateString()
          : null,
        newDate: log.newDate
          ? new Date(log.newDate).toLocaleDateString()
          : null,
        oldTime: log.oldTime || null,
        newTime: log.newTime || null,
        reason: log.reason || null,
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
export const updateAppointmentStatus = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { status, reason } = req.body;

    const validStatuses = ["CONFIRMED", "COMPLETED", "NO_SHOW", "CANCELLED"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    const existing = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
      include: { slot: true, user: true },
    });
    if (!existing) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    const data = { status };
    if (status === "CANCELLED") {
      data.cancelReason = reason || "Cancelled by clinic";
      // if you have cancelledBy in schema:
      // data.cancelledBy = "ADMIN";
    }

    const updated = await prisma.$transaction(async (tx) => {
      const appt = await tx.appointment.update({
        where: { id },
        data,
      });

      if (status === "CANCELLED") {
        // ✅ admin action => create as READ (no blinking)
        await tx.notification.create({
          data: {
            clinicId,
            type: "CANCELLATION",
            entityId: id,
            message: `Cancelled by admin — ${reason || "Cancelled by clinic"}`,
            readAt: new Date(),
          },
        });
      }

      return appt;
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: "UPDATE_STATUS",
      entity: "Appointment",
      entityId: id,
      details: {
        previousStatus: existing.status,
        newStatus: status,
        reason: status === "CANCELLED" ? (reason || "Cancelled by clinic") : null,
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
export const rescheduleAppointmentByAdmin = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { newDate, newTime, note, deleteOldSlot } = req.body;

    if (!newDate || !newTime) {
      return res.status(400).json({ error: "New date and time are required." });
    }

    const appt = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
      include: { slot: true, doctor: true, user: true },
    });

    if (!appt) return res.status(404).json({ error: "Appointment not found" });

    const oldSlot = appt.slot;
    const oldDate = oldSlot.date;
    const oldTime = oldSlot.time;
    const targetDate = new Date(newDate);

    // 1) find/create target slot
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
          duration: oldSlot.duration,
          type: oldSlot.type,
          price: oldSlot.price,
          paymentMode: oldSlot.paymentMode,
          status: "PENDING",
        },
      });
    }

    // ✅ IMPORTANT: because slotId is @unique, block if ANY other appt uses it
    const anyApptOnSlot = await prisma.appointment.findFirst({
      where: {
        slotId: newSlot.id,
        deletedAt: null,
        id: { not: appt.id },
      },
      select: { id: true, status: true },
    });

    if (anyApptOnSlot) {
      return res.status(409).json({
        error: `Slot already booked (existing appointment status: ${anyApptOnSlot.status}).`,
      });
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (deleteOldSlot) {
        await tx.slot.update({
          where: { id: oldSlot.id },
          data: { deletedAt: new Date() },
        });
      } else {
        await tx.slot.update({
          where: { id: oldSlot.id },
          data: { status: "PENDING" },
        });
      }

      const updatedAppt = await tx.appointment.update({
        where: { id: appt.id },
        data: {
          slotId: newSlot.id,
          status: "CONFIRMED",
          updatedAt: new Date(),
        },
        include: { slot: true, doctor: true, user: true },
      });

      await tx.appointmentLog.create({
        data: {
          appointmentId: appt.id,
          oldDate,
          oldTime,
          newDate: targetDate,
          newTime,
          reason: note || "Rescheduled by clinic admin",
          changedBy: userId,
        },
      });

      await tx.notification.create({
        data: {
          clinicId,
          type: "RESCHEDULE",
          entityId: appt.id,
          message: `Rescheduled — ${new Date(oldDate).toLocaleDateString()} ${oldTime} → ${targetDate.toLocaleDateString()} ${newTime}`,
          readAt: new Date(),
        },
      });

      return updatedAppt;
    });

    await logAudit({
      userId,
      clinicId,
      action: "RESCHEDULE_APPOINTMENT",
      entity: "Appointment",
      entityId: id,
      details: {
        previousStatus: appt.status,
        newStatus: updated.status,
        oldDate,
        newDate: targetDate,
        oldTime,
        newTime,
        deleteOldSlot: !!deleteOldSlot,
        reason: note || "Rescheduled by clinic admin",
      },
      req,
    });

    return res.json({ message: "Appointment rescheduled successfully", appointment: updated });
  } catch (error) {
    // ✅ Friendly P2002 (race condition safe)
    if (error?.code === "P2002" && error?.meta?.target?.includes("slotId")) {
      return res.status(409).json({ error: "Slot already booked. Please choose another slot." });
    }

    console.error("Reschedule Error:", error);
    return res.status(500).json({ error: "Failed to reschedule appointment" });
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
      include: { cancellationRequest: true, slot: true },
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

    // ✅ patient requested cancel => unread
    // ✅ admin cancelled directly => read (no blink)
    const readAtForNotification = hasPendingRequest ? null : new Date();

    const [updatedAppt, updatedReq] = await prisma.$transaction([
      prisma.appointment.update({
        where: { id },
        data: {
          status: "CANCELLED",
          cancelReason: finalReason,
          // if you have cancelledBy in schema:
          // cancelledBy: hasPendingRequest ? "USER" : "ADMIN",
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
        user: { select: { id: true, name: true, email: true, phone: true } },
        doctor: { select: { id: true, name: true, speciality: true } },
        slot: true,
        clinic: true,
        logs: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

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

    res.json({
      ...appointment,
      patient: appointment.user,
      dateFormatted: new Date(appointment.slot.date).toLocaleDateString(),
      timeFormatted: appointment.slot.time,
      history,
    });
  } catch (error) {
    console.error('Get Details Error:', error);
    res.status(500).json({ error: error.message });
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

