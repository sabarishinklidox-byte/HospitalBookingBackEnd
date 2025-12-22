import prisma from '../prisma.js';


// ----------------------------------------------------------------
// GET /api/public/clinics
// ----------------------------------------------------------------
export const getClinics = async (req, res) => {
  try {
    const { q, city } = req.query; // q = search text

    const clinics = await prisma.clinic.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        ...(city
          ? { city: { equals: city, mode: 'insensitive' } }
          : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { address: { contains: q, mode: 'insensitive' } },
                { city: { contains: q, mode: 'insensitive' } },
                { pincode: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true, // ✅ ADDED
        city: true,
        timings: true,
        address: true,
        pincode: true,
        details: true,
        logo: true,
        banner: true,
        googlePlaceId: true,
        googleMapsUrl: true,
        googleReviewsEmbedCode: true,
        googleRating: true,
        googleTotalReviews: true,
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
        avatar: true,
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
      kind: 'APPOINTMENT', // hide BREAK / lunch slots
    };

    if (date) {
      const d = new Date(date);
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      where.date = { gte: start, lt: end };
    }

    // ✅ STEP 1: Get ALL slots for the day
    const slots = await prisma.slot.findMany({
      where,
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
    });

    // ✅ STEP 2: Get BLOCKED slots (Race Condition Safe!)
    const blockedAppointments = await prisma.appointment.findMany({
      where: {
        slotId: { 
          in: slots.map(slot => slot.id) 
        },
        OR: [
          { status: 'CONFIRMED' },                                    // ✅ Permanently booked
          { 
            status: 'PENDING',                                        // ✅ Active payment hold
            createdAt: { 
              gt: new Date(Date.now() - 10 * 60 * 1000)              // Within last 10 mins only
            }
          }
        ],
        deletedAt: null
      },
      select: { 
        slotId: true 
      }
    });

    // ✅ STEP 3: Create blocked slot set (fast lookup)
    const blockedSlotIds = new Set(blockedAppointments.map(a => a.slotId));

    // ✅ STEP 4: Current time filtering (YOUR CODE PERFECT!)
    const now = new Date();
    const currentDateString = now.toISOString().split('T')[0]; 
    const currentHours = now.getHours();
    const currentMinutes = now.getMinutes();

    // ✅ FINAL RESULT - Race Condition PROOF!
    const availableSlots = slots
      .map((slot) => {
        const slotDateString = new Date(slot.date).toISOString().split('T')[0];
        
        // Past time filtering (YOUR LOGIC ✅)
        if (slotDateString === currentDateString) {
          const [slotHour, slotMinute] = slot.time.split(':').map(Number);
          if (slotHour < currentHours) return null;
          if (slotHour === currentHours && slotMinute <= currentMinutes) return null;
        }

        // Race condition safe booking status
        const isBooked = blockedSlotIds.has(slot.id);
        
        return { 
          ...slot, 
          isBooked,                    // ✅ TRUE = Unavailable, FALSE = Bookable
          paymentMode: slot.paymentMode || 'FREE',
          price: Number(slot.price || 0)
        };
      })
      .filter(Boolean)  // Remove past slots
      .sort((a, b) => a.time.localeCompare(b.time));

    return res.json({
      success: true,
      doctorId,
      date,
      slots: availableSlots,
      totalAvailable: availableSlots.filter(s => !s.isBooked).length,
      totalBlocked: availableSlots.filter(s => s.isBooked).length,
      stats: {
        free: availableSlots.filter(s => s.paymentMode === 'FREE' && !s.isBooked).length,
        paid: availableSlots.filter(s => s.paymentMode !== 'FREE' && !s.isBooked).length
      }
    });

  } catch (error) {
    console.error('Slot Fetch Error:', error);
    return res.status(500).json({ error: 'Failed to load slots.' });
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
    const clinic = await prisma.clinic.findFirst({
      where: { id, deletedAt: null, isActive: true },
      select: {
        id: true,
        name: true,
        phone: true, // ✅ ADDED
        city: true,
        address: true,
        details: true,
        logo: true,
        banner: true,
        linkClicks: true,
        // Google reviews fields
        googlePlaceId: true,
        googleMapsUrl: true,
        googleReviewsEmbedCode: true,
        googleRating: true,
        googleTotalReviews: true,
      },
    });

    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }

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
        kind: "APPOINTMENT",           // ✅ hide BREAK
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
          select: { id: true },
          take: 1,
        },
      },
    });

    return res.json({
      data: slots.map((s) => ({
        id: s.id,
        date: s.date,
        time: s.time,
        paymentMode: s.paymentMode,
        kind: s.kind,                  // ✅ return kind (not type)
        price: s.price,
        isBooked: (s.appointments?.length || 0) > 0,
      })),
    });
  } catch (error) {
    console.error("Get Slots For User Error:", error);
    return next ? next(error) : res.status(500).json({ error: "Failed to load slots" });
  }
};