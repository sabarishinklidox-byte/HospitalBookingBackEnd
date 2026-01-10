import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { logAudit } from '../utils/audit.js';

// ----------------------------------------------------------------
// DOCTOR LOGIN
// ----------------------------------------------------------------
export const doctorLogin = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password required' });

    // 1. Find User (Must NOT be deleted)
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.role !== 'DOCTOR' || user.deletedAt)
      return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    // 2. Find Associated Doctor Profile (Must NOT be deleted)
    const doctor = await prisma.doctor.findFirst({
      where: {
        user: { id: user.id },
        deletedAt: null 
      }
    });

    if (!doctor) {
      return res.status(400).json({ error: 'No active doctor profile linked to this user account.' });
    }

    // 3. Sign Token
    const token = jwt.sign(
      { 
        userId: user.id, 
        role: user.role, 
        doctorId: doctor.id 
      },
      process.env.JWT_SECRET,
      { expiresIn: '6h' }
    );

    // ✅ LOG AUDIT
    await logAudit({
      userId: user.id,
      clinicId: doctor.clinicId,
      action: 'LOGIN',
      entity: 'Doctor',
      entityId: doctor.id,
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
        doctorId: doctor.id
      }
    });
  } catch (error) {
    console.error('Doctor Login Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET DOCTOR PROFILE
// ----------------------------------------------------------------
export const getDoctorProfile = async (req, res) => {
  try {
    const { doctorId } = req.user;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { clinic: true }
    });

    if (!doctor || doctor.deletedAt)
      return res.status(404).json({ error: 'Doctor not found' });

    // Optional: Remove deletedAt from response
    delete doctor.deletedAt; 

    return res.json(doctor);
  } catch (error) {
    console.error('Get Doctor Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
export const getDoctorSlots = async (req, res) => {
  try {
    const { doctorId } = req.user;
    const dateParam = req.params.date;
    const dateQuery = req.query.date;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    let where = { 
      doctorId, 
      deletedAt: null 
    };
    
    const date = dateParam || dateQuery;
    
    if (date) {
      const d = new Date(date);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      where.date = { gte: start, lt: end };
    }

    const slots = await prisma.slot.findMany({
      where,
      include: { 
        appointments: { 
          where: { 
            deletedAt: null, 
            status: { notIn: ['CANCELLED', 'COMPLETED'] }  
          } 
        } 
      },
      orderBy: [{ date: 'asc' }, { time: 'asc' }]
    });

    // 🔥 BULLETPROOF FIXED: Handles Prisma null appointments + correct count
    const formatted = (slots || []).map(slot => ({
      ...slot,
      status: Array.isArray(slot.appointments) && slot.appointments.length > 0 
        ? 'BOOKED' 
        : 'AVAILABLE',
      available: !Array.isArray(slot.appointments) || slot.appointments.length === 0,
      appointmentCount: Array.isArray(slot.appointments) ? slot.appointments.length : 0
    }));

    return res.json(formatted);  // Flat array for frontend ✅
  } catch (error) {
    console.error('Get Doctor Slots Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
// 🔥 FIXED getAvailableSlots - Works with your 1-to-1 relation
export const getAvailableSlots = async (req, res) => {
  try {
    const { doctorId } = req.user;
    const { date } = req.query;

    if (!doctorId || !date) {
      return res.status(400).json({ error: 'Missing doctorId or date' });
    }

    const d = new Date(date + 'T00:00:00.000Z');
    const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

    // 🔥 ONLY TRULY FREE SLOTS (no appointment at all)
    const availableSlots = await prisma.slot.findMany({
      where: {
        doctorId,
        deletedAt: null,
        date: {
          gte: startOfDay,
          lt: endOfDay
        },
        // 🔥 NO APPOINTMENT = TRULY AVAILABLE
        appointments: {
          is: null  // ✅ Only this!
        }
      },
      select: {
        id: true,
        time: true,
        date: true,
        duration: true,
        price: true,
        type: true,
        paymentMode: true
      },
      orderBy: [{ time: 'asc' }]
    });

    // 🔥 Format
    const formatted = availableSlots.map(slot => ({
      id: slot.id,
      time: slot.time,
      date: slot.date.toISOString().slice(0, 10),
      status: 'AVAILABLE',
      available: true,
      appointmentCount: 0
    }));

    res.json({
      slots: formatted,
      totalAvailable: formatted.length,
      date: date
    });

  } catch (error) {
    console.error('Available Slots Error:', error);
    res.status(500).json({ error: error.message });
  }
};
    



// ----------------------------------------------------------------
// GET DOCTOR APPOINTMENTS (UNCHANGED - ALREADY WORKING)
// ----------------------------------------------------------------
export const getDoctorAppointments = async (req, res) => {
  try {
    const { doctorId } = req.user;
    const dateParam = req.params.date;     // 🔥 NEW: path param support
    const dateQuery = req.query.date;      // ✅ OLD: query param
    const { status } = req.query;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    const where = {
      slot: { doctorId },
      deletedAt: null
    };

    if (status) where.status = status;

    const date = dateParam || dateQuery;  // ✅ Supports BOTH
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

    const formatted = appointments.map(app => ({
      ...app,
      patientName: app.user?.name || 'Unknown',
      patientPhone: app.user?.phone || '',
      dateFormatted: app.slot?.date ? new Date(app.slot.date).toLocaleDateString() : 'N/A',
      timeFormatted: app.slot?.time || 'N/A'
    }));

    return res.json({ appointments: formatted });
  } catch (error) {
    console.error('Get Doctor Appointments Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
// ----------------------------------------------------------------
// UPDATE APPOINTMENT STATUS
// ----------------------------------------------------------------
export const updateDoctorAppointmentStatus = async (req, res) => {
  try {
    const { doctorId, userId } = req.user;
    const { id } = req.params;
    const { status } = req.body;

    if (!doctorId)
      return res.status(400).json({ error: 'Doctor ID missing in token' });

    if (!['COMPLETED', 'NO_SHOW', 'CONFIRMED'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const appointment = await prisma.appointment.findFirst({
      where: { 
        id,
        slot: { doctorId },
        deletedAt: null
      },
      include: { 
        slot: true, 
        user: { select: { name: true } }
      }
    });

    if (!appointment)
      return res.status(404).json({ error: 'Appointment not found or access denied' });

    const updated = await prisma.appointment.update({
      where: { id },
      data: { status }
    });

    // ✅ LOG AUDIT
    await logAudit({
      userId: userId || req.user.userId,
      clinicId: appointment.clinicId,
      action: 'UPDATE_STATUS_DOCTOR',
      entity: 'Appointment',
      entityId: id,
      details: {
        patientName: appointment.user?.name,
        previousStatus: appointment.status,
        newStatus: status
      },
      req
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

// ----------------------------------------------------------------
// UPDATE DOCTOR PROFILE
// ----------------------------------------------------------------
export const updateDoctorProfile = async (req, res) => {
  try {
    const { userId, doctorId } = req.user; 
    const { phone, password } = req.body;

    const doctor = await prisma.doctor.findUnique({ 
        where: { id: doctorId },
        select: { clinicId: true, phone: true, deletedAt: true } 
    });

    if (!doctor || doctor.deletedAt) return res.status(404).json({ error: "Doctor profile not active." });

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

    // ✅ LOG AUDIT
    await logAudit({
        userId: userId || req.user.userId,
        clinicId: doctor.clinicId,
        action: 'UPDATE_DOCTOR_PROFILE',
        entity: 'Doctor',
        entityId: doctorId,
        details: {
            phoneChanged: phone && phone !== doctor.phone,
            passwordChanged: !!password
        },
        req
    });

    return res.json({ user: updatedUser });
  } catch (error) {
    console.error('Update Doctor Profile Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET APPOINTMENT DETAILS
// ----------------------------------------------------------------
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
          select: { id: true, name: true, email: true, phone: true },
        },
        slot: true,
        clinic: true,
        doctor: true,
      },
    });

    if (!appointment || appointment.deletedAt) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    if (appointment.doctorId && appointment.doctorId !== doctorId) {
       return res.status(403).json({ error: 'Access denied to this appointment' });
    }

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

// ----------------------------------------------------------------
// GET STATS
// ----------------------------------------------------------------
export const getDoctorDashboardStats = async (req, res) => {
  try {
    const { doctorId } = req.user;

    if (!doctorId) return res.status(400).json({ error: 'Doctor ID missing' });

    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    const nextWeek = new Date(today);
    nextWeek.setDate(today.getDate() + 7);

    const [todayCount, upcomingCount, completedToday] = await Promise.all([
      prisma.appointment.count({
        where: {
          doctorId, 
          deletedAt: null,
          slot: {
            date: { gte: startOfDay, lt: endOfDay }
          }
        }
      }),

      prisma.appointment.count({
        where: {
          doctorId,
          deletedAt: null,
          slot: {
            date: { gt: endOfDay, lt: nextWeek }
          },
          status: { in: ['PENDING', 'CONFIRMED'] }
        }
      }),

      prisma.appointment.count({
        where: {
          doctorId,
          deletedAt: null,
          status: 'COMPLETED',
          slot: {
            date: { gte: startOfDay, lt: endOfDay }
          }
        }
      })
    ]);

    res.json({ todayCount, upcomingCount, completedToday });

  } catch (error) {
    console.error('Doctor Dashboard Stats Error:', error);
    res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
};

// ----------------------------------------------------------------
// GET REVIEWS
// ----------------------------------------------------------------
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: { subscription: { include: { plan: true } } },
  });
  return clinic?.subscription?.plan || null;
}

export const getMyReviews = async (req, res) => {
  try {
    const doctorId = req.user.doctorId;
    if (!doctorId) {
      return res.status(400).json({ error: "Doctor ID not found in session" });
    }

    // NEW: Resolve clinicId and check plan
    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinicId: true }
    });
    const clinicId = doctor?.clinicId;
    if (!clinicId) {
      return res.status(400).json({ error: "Clinic not found for doctor" });
    }

    const plan = await getClinicPlan(clinicId);
    if (!plan || !plan.enableAuditLogs) {  // Or enableReviews?
      return res.status(403).json({ error: "Reviews not available on your plan" });
    }

    // Original query unchanged
    const reviews = await prisma.review.findMany({
      where: { 
        doctorId,
        deletedAt: null 
      },
      include: {
        user: { select: { name: true, avatar: true } },
        appointment: { select: { createdAt: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    const total = reviews.reduce((sum, r) => sum + r.rating, 0);
    const average = reviews.length > 0 ? (total / reviews.length).toFixed(1) : 0;

    res.json({ average, total: reviews.length, reviews });

  } catch (error) {
    console.error("Get Doctor Reviews Error:", error);
    res.status(500).json({ error: error.message });
  }
};