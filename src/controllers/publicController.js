// src/controllers/publicController.js
import prisma from '../prisma.js';

// GET /api/public/clinics
export const getClinics = async (req, res) => {
  try {
    const clinics = await prisma.clinic.findMany({
      select: {
        id: true,
        name: true,
        city: true,
        timings: true,
        address: true,
        pincode: true,
        details: true,
        logo: true,    // include if you store logo
        banner: true,  // include if you store banner
      },
      orderBy: { name: 'asc' },
    });

    return res.json(clinics);
  } catch (error) {
    console.error('Public getClinics error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/public/clinics/:clinicId/doctors
export const getDoctorsByClinic = async (req, res) => {
  try {
    const { clinicId } = req.params;

    const doctors = await prisma.doctor.findMany({
      where: { clinicId, isActive: true },
      select: {
        id: true,
        name: true,
        speciality: true,
        phone: true,
        experience: true,
        avatar: true,
        clinicId: true, // Make sure to select clinicId so the frontend has it
      },
      orderBy: { name: 'asc' },
    });

    return res.json(doctors);
  } catch (error) {
    console.error('Public getDoctorsByClinic error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET /api/public/doctors/:doctorId/slots?date=YYYY-MM-DD
// src/controllers/publicController.js

// src/controllers/publicController.js

export const getSlotsByDoctor = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { date } = req.query;

    // 1. Basic Date Filter
    const where = { doctorId };
    if (date) {
      const d = new Date(date);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      where.date = { gte: start, lt: end };
    }

    // 2. Fetch Slots AND their Appointments
    const slots = await prisma.slot.findMany({
      where,
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      include: {
        appointments: true // Fetch all appointments for this slot
      }
    });

    // 3. Filter/Mark Booked Slots in Javascript (Safer than complex Prisma query)
    const slotsWithStatus = slots.map(slot => {
      // Check if there is any active appointment
      const isBooked = slot.appointments.some(appt => 
        ['PENDING', 'CONFIRMED', 'COMPLETED'].includes(appt.status)
      );
      
      // Return slot without the heavy appointments array, just the flag
      const { appointments, ...slotData } = slot;
      return { ...slotData, isBooked };
    });

    res.json(slotsWithStatus);

  } catch (error) {
    console.error("Slot Fetch Error:", error); // Log error to see what's wrong
    res.status(500).json({ error: "Failed to load slots." });
  }
};


// ✅ NEW FUNCTION: GET /api/public/doctors/:id
export const getDoctorById = async (req, res) => {
  try {
    const { id } = req.params;
    const doctor = await prisma.doctor.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        speciality: true,
        phone: true,
        experience: true,
        avatar: true,
        clinicId: true, // Critical for booking
        clinic: {
          select: { name: true, city: true } // Optional: if you want to display clinic info
        }
      }
    });

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    res.json(doctor);
  } catch (error) {
    console.error('Public getDoctorById error:', error);
    res.status(500).json({ error: error.message });
  }
};
export const getPublicClinicById = async (req, res) => {
  try {
    const { id } = req.params;
    const clinic = await prisma.clinic.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        city: true,
        address: true,
        timings: true,
        logo: true,
        // phone: true, // REMOVED because it does not exist in schema
        details: true   // Added 'details' which likely exists
      }
    });

    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    res.json(clinic);
  } catch (error) {
    console.error('Get Public Clinic Error:', error);
    res.status(500).json({ error: error.message });
  }
};