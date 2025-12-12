import prisma from '../prisma.js';

// ----------------------------------------------------------------
// GET /api/public/clinics
// ----------------------------------------------------------------
export const getClinics = async (req, res) => {
  try {
    const clinics = await prisma.clinic.findMany({
      where: {
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        city: true,
        timings: true,
        address: true,
        pincode: true,
        details: true,
        logo: true,
        banner: true,
      },
      orderBy: { name: 'asc' },
    });

    return res.json(clinics);
  } catch (error) {
    console.error('Public getClinics error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET /api/public/clinics/:clinicId/doctors
// ----------------------------------------------------------------
export const getDoctorsByClinic = async (req, res) => {
  try {
    const { clinicId } = req.params;

    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
    });

    if (!clinic || !clinic.isActive || clinic.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found or inactive' });
    }

    const doctors = await prisma.doctor.findMany({
      where: {
        clinicId,
        isActive: true,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        speciality: true,
        phone: true,
        experience: true,
        avatar: true,          // 👈 add this
        reviews: {
          where: { deletedAt: null },
          select: { rating: true },
        },
      },
    });

    const result = doctors.map((doc) => {
      const totalStars = doc.reviews.reduce((sum, r) => sum + r.rating, 0);
      const reviewCount = doc.reviews.length;
      const avg =
        reviewCount > 0 ? (totalStars / reviewCount).toFixed(1) : 0;

      return {
        ...doc,
        reviews: undefined,
        rating: avg,
        reviewCount,
      };
    });

    res.json(result);
  } catch (error) {
    console.error('Error loading clinic doctors:', error);
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET /api/public/doctors/:doctorId/slots
// ----------------------------------------------------------------
export const getSlotsByDoctor = async (req, res) => {
  try {
    const { doctorId } = req.params;
    const { date } = req.query;

    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      include: { clinic: true },
    });

    if (
      !doctor ||
      !doctor.isActive ||
      doctor.deletedAt ||
      doctor.clinic.deletedAt
    ) {
      return res.status(404).json({ error: 'Doctor unavailable.' });
    }

    const where = {
      doctorId,
      deletedAt: null,
    };

    if (date) {
      const d = new Date(date);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

      where.date = { gte: start, lt: end };
    }

    const slots = await prisma.slot.findMany({
      where,
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
      include: {
        appointments: {
          where: { deletedAt: null },
        },
      },
    });

    const data = slots.map((slot) => {
      const isBooked = slot.appointments.some((a) =>
        ['PENDING', 'CONFIRMED', 'COMPLETED'].includes(a.status)
      );
      const { appointments, ...rest } = slot;
      return { ...rest, isBooked };
    });

    res.json(data);
  } catch (error) {
    console.error('Slot Fetch Error:', error);
    res.status(500).json({ error: 'Failed to load slots.' });
  }
};

// ----------------------------------------------------------------
// GET /api/public/doctors/:id
// ----------------------------------------------------------------
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
        isActive: true,
        deletedAt: true,
        clinicId: true,
        clinic: {
          select: { name: true, city: true, isActive: true, deletedAt: true },
        },
      },
    });

    if (!doctor ||
        doctor.deletedAt ||
        doctor.clinic.deletedAt ||
        !doctor.isActive ||
        !doctor.clinic.isActive
    ) {
      return res.status(404).json({ error: 'Doctor not found or unavailable' });
    }

    delete doctor.deletedAt;
    delete doctor.clinic.deletedAt;

    res.json(doctor);
  } catch (error) {
    console.error('Public getDoctorById error:', error);
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// GET /api/public/clinics/:id (increments linkClicks)
// ----------------------------------------------------------------
export const getPublicClinicById = async (req, res) => {
  const { id } = req.params;

  try {
    // 1) Find clinic that is public
    const clinic = await prisma.clinic.findFirst({
      where: { id, deletedAt: null, isActive: true },
      select: {
        id: true,
        name: true,
        city: true,
        address: true,
        details: true,
        logo: true,
        banner: true,
        linkClicks: true,
      },
    });

    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

    // 2) Increment counter (best-effort)
    await prisma.clinic
      .update({
        where: { id },
        data: { linkClicks: { increment: 1 } },
      })
      .catch(() => {});

    return res.json(clinic);
  } catch (error) {
    console.error('getPublicClinicById error', error);
    return res.status(500).json({ error: 'Failed to load clinic' });
  }
};


// ----------------------------------------------------------------
// GET /api/public/doctors (Global List)
// ----------------------------------------------------------------
export const getDoctors = async (req, res) => {
  try {
    const doctors = await prisma.doctor.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        clinic: {
          isActive: true,
          deletedAt: null,
        },
      },
      include: {
        reviews: {
          where: { deletedAt: null },
          select: { rating: true },
        },
      },
    });

    const data = doctors.map((doc) => {
      const total = doc.reviews.reduce((sum, r) => sum + r.rating, 0);
      const avg =
        doc.reviews.length > 0
          ? (total / doc.reviews.length).toFixed(1)
          : 0;

      return {
        ...doc,
        rating: avg,
        reviewCount: doc.reviews.length,
      };
    });

    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
