import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

// ----------------------------------------------------------------
// GET APPOINTMENTS (List)
// ----------------------------------------------------------------
export const getAppointments = async (req, res) => {
  try {
    const { clinicId } = req.user;
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing from request' });
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

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const where = { clinicId, deletedAt: null };

    if (status) where.status = status;

    if (date) {
      where.slot = { date: new Date(date) };
    } else if (dateFrom || dateTo) {
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

    const totalAppointments = await prisma.appointment.count({ where });

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limitNum,
      include: {
        user: { select: { name: true, phone: true, email: true } },
        doctor: { select: { name: true, speciality: true } },
        slot: { select: { date: true, time: true } },
        logs: { orderBy: { createdAt: 'desc' } }, // AppointmentLog[]
      },
    });

    const formatted = appointments.map((app) => ({
      id: app.id,
      status: app.status,
      userId: app.userId,

      patientName: app.user?.name || 'Unknown',
      patientPhone: app.user?.phone || 'N/A',
      patientEmail: app.user?.email || '',

      doctorName: app.doctor?.name || 'Unknown',
      doctorSpecialization: app.doctor?.speciality || '',

      date: app.slot?.date,
      time: app.slot?.time,
      dateFormatted: app.slot?.date
        ? new Date(app.slot.date).toLocaleDateString()
        : 'N/A',
      timeFormatted: app.slot?.time || 'N/A',

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

    res.json({
      data: formatted,
      pagination: {
        total: totalAppointments,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalAppointments / limitNum),
      },
    });
  } catch (error) {
    console.error('Get Appointments Error:', error);
    res.status(500).json({ error: error.message });
  }
};
// ----------------------------------------------------------------
// CANCEL APPOINTMENT
// ----------------------------------------------------------------
export const cancelAppointment = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;

    const existing = await prisma.appointment.findFirst({
      where: {
        id,
        clinicId,
        deletedAt: null,
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'CANCEL_APPOINTMENT',
      entity: 'Appointment',
      entityId: id,
      details: {
        previousStatus: existing.status,
        newStatus: 'CANCELLED',
        reason: 'Admin requested cancellation',
      },
      req,
    });

    return res.json({
      message: 'Appointment cancelled successfully',
      appointment: updated,
    });
  } catch (error) {
    console.error('Cancel Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// UPDATE STATUS
// ----------------------------------------------------------------
export const updateAppointmentStatus = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { status, reason } = req.body;   // ← reason from admin

    const validStatuses = ['CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const existing = await prisma.appointment.findFirst({
      where: { id, clinicId, deletedAt: null },
    });
    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'UPDATE_STATUS',
      entity: 'Appointment',
      entityId: id,
      details: {
        previousStatus: existing.status,
        newStatus: status,
        // this is what getUserAppointments reads as cancelReason
        reason: status === 'CANCELLED' ? (reason || 'Cancelled by clinic') : null,
      },
      req,
    });

    return res.json({
      message: `Appointment status updated to ${status}`,
      appointment: updated,
    });
  } catch (error) {
    console.error('Update Status Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET SINGLE APPOINTMENT DETAILS
// ----------------------------------------------------------------
export const getAppointmentDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { clinicId } = req.user;

    const appointment = await prisma.appointment.findFirst({
      where: {
        id,
        clinicId,
        deletedAt: null,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, phone: true },
        },
        doctor: {
          select: { id: true, name: true, speciality: true },
        },
        slot: true,
        clinic: true,
        logs: { orderBy: { createdAt: 'desc' } }, // 🔴 include audit logs
      },
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
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
        oldDate: details.oldDate
          ? new Date(details.oldDate).toLocaleDateString()
          : null,
        newDate: details.newDate
          ? new Date(details.newDate).toLocaleDateString()
          : null,
        oldTime: details.oldTime || null,
        newTime: details.newTime || null,
        reason: details.reason || null,
      };
    });

    const formattedAppointment = {
      ...appointment,
      patient: appointment.user,
      dateFormatted: new Date(appointment.slot.date).toLocaleDateString(),
      timeFormatted: appointment.slot.time,
      history, // 🔴 now details popup/modal also sees reschedule history
    };

    res.json(formattedAppointment);
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

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    await prisma.appointment.update({
      where: { id },
      data: { deletedAt: new Date(), status: 'CANCELLED' },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'DELETE_APPOINTMENT',
      entity: 'Appointment',
      entityId: id,
      details: { reason: 'Admin soft deleted appointment' },
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
    if (!clinicId) {
      return res.status(400).json({ error: "Clinic ID missing from request" });
    }

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
      `attachment; filename="bookings_${new Date()
        .toISOString()
        .slice(0, 10)}.pdf"`
    );

    doc.pipe(res);

    doc.fontSize(18).text('Bookings Report', { align: 'center' });
    doc
      .fontSize(10)
      .text(`Clinic: ${clinicId}`, { align: 'center' })
      .moveDown(0.3);
    doc
      .fontSize(9)
      .text(`Generated: ${new Date().toLocaleString()}`, { align: 'center' });
    doc.moveDown(1);

    appointments.forEach((app, idx) => {
      const dateStr = app.slot?.date
        ? new Date(app.slot.date).toLocaleDateString()
        : 'N/A';
      const timeStr = app.slot?.time || 'N/A';

      doc
        .fontSize(11)
        .text(
          `${idx + 1}. ${app.user?.name || 'Unknown'}  (${app.user?.phone || 'N/A'})`
        );
      doc
        .fontSize(9)
        .fillColor('#555555')
        .text(
          `Doctor: ${app.doctor?.name || 'Unknown'} (${app.doctor?.speciality || ''})`
        );
      doc
        .text(`Schedule: ${dateStr} ${timeStr}  |  Status: ${app.status}`)
        .moveDown(0.6);
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
    if (!clinicId) {
      return res.status(400).json({ error: "Clinic ID missing from request" });
    }

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
        dateFormatted: app.slot?.date
          ? new Date(app.slot.date).toLocaleDateString()
          : 'N/A',
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
      `attachment; filename="bookings_${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx"`
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    console.error('Export Excel Error:', error);
    res.status(500).json({ error: 'Failed to export Excel' });
  }
};
