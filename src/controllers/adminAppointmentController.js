import prisma from '../prisma.js';

// GET /api/admin/appointments
// ?date=YYYY-MM-DD&doctorId=...&status=PENDING
export const getAppointments = async (req, res) => {
  try {
    const { clinicId } = req.user;
    // ... extract filters if needed ...

    const appointments = await prisma.appointment.findMany({
      where: { clinicId: clinicId }, // apply other filters here
      orderBy: { createdAt: 'desc' }, // or { slot: { date: 'desc' } }
      include: {
        user: { select: { name: true, phone: true } },
        doctor: { select: { name: true, speciality: true } },
        slot: { select: { date: true, time: true } }, // Ensure Slot is included
      },
    });

    // TRANSFORM for frontend
    const formatted = appointments.map((app) => ({
      id: app.id,
      status: app.status,
      userId: app.userId,
      
      // Flatten patient info
      patientName: app.user?.name || 'Unknown',
      patientPhone: app.user?.phone || '',

      // Flatten doctor info
      doctorName: app.doctor?.name || 'Unknown',
      doctorSpecialization: app.doctor?.speciality || '',

      // Flatten date/time from SLOT
      date: app.slot?.date, 
      time: app.slot?.time,
      dateFormatted: app.slot?.date 
        ? new Date(app.slot.date).toLocaleDateString() 
        : 'N/A',
      timeFormatted: app.slot?.time || 'N/A',
    }));

    res.json(formatted);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
};

export const cancelAppointment = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { id } = req.params;

    const existing = await prisma.appointment.findFirst({
      where: { id, clinicId }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found in this clinic' });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status: 'CANCELLED' }
    });

    return res.json({
      message: 'Appointment cancelled',
      appointment: updated
    });
  } catch (error) {
    console.error('Cancel Appointment Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
export const updateAppointmentStatus = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { id } = req.params;
    const { status } = req.body;

    if (!['COMPLETED', 'NO_SHOW', 'CONFIRMED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }

    const existing = await prisma.appointment.findFirst({
      where: { id, clinicId }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found in this clinic' });
    }

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status }
    });

    return res.json({
      message: 'Appointment status updated',
      appointment: updated
    });
  } catch (error) {
    console.error('Update Appointment Status Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

export const getAppointmentDetails = async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch from DB using 'user' (NOT 'patient')
    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        user: { // <--- This MUST match your schema.prisma (likely 'user')
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        doctor: {
          select: {
            id: true,
            name: true,
            speciality: true, // Verify spelling: 'speciality' or 'specialization'
          },
        },
        slot: true,
        clinic: true,
      },
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // 2. Map 'user' to 'patient' for the frontend
    const formattedAppointment = {
      ...appointment,
      patient: appointment.user, // <--- Frontend expects 'patient', so we assign it here
      dateFormatted: new Date(appointment.slot.date).toLocaleDateString(),
      timeFormatted: appointment.slot.time, 
    };

    res.json(formattedAppointment);
  } catch (error) {
    console.error('Get Appointment Details Error:', error);
    res.status(500).json({ error: error.message });
  }
};
