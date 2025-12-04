// src/controllers/doctorController.js
import prisma from '../prisma.js'; // Adjust path if needed
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

// DOCTOR LOGIN

export const doctorLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    // 1. Find User
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.role !== 'DOCTOR')
      return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // 2. Find Associated Doctor Profile
    // We search for a Doctor where the related 'user' has the ID we just found.
    const doctor = await prisma.doctor.findFirst({
      where: {
        user: {
          id: user.id // <--- CORRECT SYNTAX for relation filtering
        }
      }
    });

    if (!doctor) {
      return res.status(400).json({ error: 'No doctor profile linked to this user account.' });
    }

    // 3. Sign Token with valid doctorId
    const token = jwt.sign(
      { 
        userId: user.id, 
        role: user.role, 
        doctorId: doctor.id 
      },
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
        doctorId: doctor.id
      }
    });
  } catch (error) {
    console.error('Doctor Login Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
// GET /api/doctor/profile
export const getDoctorProfile = async (req, res) => {
  try {
    const { doctorId } = req.user;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { clinic: true }
    });

    if (!doctor)
      return res.status(404).json({ error: 'Doctor not found' });

    return res.json(doctor);
  } catch (error) {
    console.error('Get Doctor Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/doctor/slots?date=YYYY-MM-DD
export const getDoctorSlots = async (req, res) => {
  try {
    const { doctorId } = req.user;
    const { date } = req.query;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    let where = { doctorId };
    if (date) {
      const d = new Date(date);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      where.date = { gte: start, lt: end };
    }

    const slots = await prisma.slot.findMany({
      where,
      orderBy: [{ date: 'asc' }, { time: 'asc' }]
    });

    return res.json(slots);
  } catch (error) {
    console.error('Get Doctor Slots Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/doctor/appointments?date=YYYY-MM-DD&status=...
export const getDoctorAppointments = async (req, res) => {
  try {
    const { doctorId } = req.user;
    const { date, status } = req.query;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    // Build where clause: filter appointments WHERE slot.doctorId matches
    const where = {
      slot: {
        doctorId // filter by slot.doctorId === req.user.doctorId
      }
    };

    // Add status filter if provided
    if (status) {
      where.status = status;
    }

    // Add date filter if provided
    if (date) {
      const d = new Date(date + 'T00:00:00');
      const start = new Date(d);
      const end = new Date(d);
      end.setDate(end.getDate() + 1);
      
      where.slot.date = { gte: start, lt: end };
    }

    const appointments = await prisma.appointment.findMany({
      where,
      orderBy: [
        { slot: { date: 'asc' } },
        { slot: { time: 'asc' } }
      ],
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        slot: true,
        payment: true
      }
    });

    // Format data for frontend (e.g. map user -> patientName)
    const formatted = appointments.map(app => ({
      ...app,
      patientName: app.user?.name || 'Unknown',
      patientPhone: app.user?.phone || '',
      // Format dates for display
      dateFormatted: app.slot?.date ? new Date(app.slot.date).toLocaleDateString() : 'N/A',
      timeFormatted: app.slot?.time || 'N/A'
    }));

    return res.json(formatted);
  } catch (error) {
    console.error('Get Doctor Appointments Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// PATCH /api/doctor/appointments/:id/status
export const updateDoctorAppointmentStatus = async (req, res) => {
  try {
    const { doctorId } = req.user;
    const { id } = req.params;
    const { status } = req.body;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    if (!['COMPLETED', 'NO_SHOW', 'CONFIRMED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    // Verify appointment belongs to this doctor (via slot.doctorId)
    const appointment = await prisma.appointment.findFirst({
      where: { 
        id,
        slot: { doctorId }
      },
      include: { slot: true }
    });

    if (!appointment)
      return res.status(404).json({ error: 'Appointment not found or access denied' });

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

// PATCH /api/doctor/profile
export const updateDoctorProfile = async (req, res) => {
  try {
    const { userId, doctorId } = req.user; 
    const { phone, password } = req.body;

    const data = {};
    if (phone !== undefined) data.phone = phone;

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      const hashed = await bcrypt.hash(password, 12);
      data.password = hashed;
    }

    // Update User record
    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data,
      select: { id: true, name: true, email: true, phone: true }
    });

    // Update Doctor record
    if (phone !== undefined) {
      await prisma.doctor.update({
        where: { id: doctorId },
        data: { phone }
      });
    }

    return res.json({ user: updatedUser });
  } catch (error) {
    console.error('Update Doctor Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/doctor/appointments/:id (DETAILS)
export const getAppointmentDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const { doctorId } = req.user;

    if (!doctorId) {
      return res.status(400).json({ error: 'Doctor ID missing in token' });
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        user: { 
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
          },
        },
        slot: true,
        clinic: true,
        doctor: true,
      },
    });

    if (!appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Security check: ensure appointment belongs to doctor
    if (appointment.doctorId && appointment.doctorId !== doctorId) {
       return res.status(403).json({ error: 'Access denied to this appointment' });
    }

    // Format response: map user -> patient, add formatted dates
    const formattedAppointment = {
      ...appointment,
      patient: appointment.user, 
      dateFormatted: new Date(appointment.slot.date).toLocaleDateString(),
      timeFormatted: appointment.slot.time,
    };

    res.json(formattedAppointment);
  } catch (error) {
    console.error('Get Doctor Appointment Details Error:', error);
    res.status(500).json({ error: error.message });
  }
};
export const getDoctorDashboardStats = async (req, res) => {
  try {
    const { doctorId } = req.user;

    if (!doctorId) return res.status(400).json({ error: 'Doctor ID missing' });

    // Get Today's Date Range (00:00 to 23:59)
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    // Get "Upcoming" Date Range (Next 7 days)
    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);

    // Run queries in parallel for speed
    const [todayCount, upcomingCount, completedToday] = await Promise.all([
      // 1. Total Appointments Today
      prisma.appointment.count({
        where: {
          doctorId, // Filter by logged-in doctor
          slot: {
            date: { gte: startOfDay, lt: endOfDay }
          }
        }
      }),

      // 2. Upcoming Appointments (Next 7 days)
      prisma.appointment.count({
        where: {
          doctorId,
          slot: {
            date: { gt: endOfDay, lt: nextWeek }
          },
          status: { in: ['PENDING', 'CONFIRMED'] }
        }
      }),

      // 3. Completed Today
      prisma.appointment.count({
        where: {
          doctorId,
          status: 'COMPLETED',
          slot: {
            date: { gte: startOfDay, lt: endOfDay }
          }
        }
      })
    ]);

    res.json({
      todayCount,
      upcomingCount,
      completedToday
    });

  } catch (error) {
    console.error('Doctor Dashboard Stats Error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
};