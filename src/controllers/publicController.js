import prisma from '../prisma.js';


// ----------------------------------------------------------------
// GET /api/public/clinics
// ----------------------------------------------------------------
export const getClinics = async (req, res) => {
  try {
    const { q, city } = req.query;

    const clinics = await prisma.clinic.findMany({
      where: {
        isActive: true, 
        isPublic: true,
        deletedAt: null,
        ...(city ? { city: { equals: city, mode: 'insensitive' } } : {}),
        ...(q ? {
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { address: { contains: q, mode: 'insensitive' } },
            { city: { contains: q, mode: 'insensitive' } },
            { pincode: { contains: q, mode: 'insensitive' } },
          ],
        } : {}),
      },
    select: {
  id: true,
  name: true,
  phone: true,
  city: true,
  timings: true,
  address: true,
  pincode: true,
  details: true,
  logo: true,
  banner: true,
  googlePlaceId: true,
  googleMapsUrl: true,           // ✅ EXISTS
  googleReviewsEmbedCode: true,
  googleRating: true,
  googleTotalReviews: true,
  // ✅ REMOVE THESE:
  // googleRatingUrl: true,     ❌ DOESN'T EXIST
  // googleRatingLink: true,    ❌ DOESN'T EXIST
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
function isSlotPassedIst(dateStr, timeStr) {
  // Treat date+time as IST wall-clock and compare with current IST time
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  // Current time in IST (as timestamp)
  const nowUtc = Date.now();
  const nowIst = nowUtc + IST_OFFSET_MS;

  // Slot time in IST (as timestamp)
  // 1) Build ISO without offset -> JS treats as local, so strip local offset:
  const slotLocal = new Date(`${dateStr}T${timeStr}:00`).getTime();
  // 2) Convert that local timestamp to IST-equivalent by *adding* or *subtracting*
  //    your server offset. If your server is running in UTC, do NOT adjust it.
  //    Assuming server is UTC:
  const slotIst = slotLocal + IST_OFFSET_MS;

  return slotIst < nowIst;
}

export const getSlotsForUser = async (req, res, next) => {
  try {
    const { clinicId, doctorId, date, excludeAppointmentId } = req.query;

    if (!clinicId || !doctorId || !date) {
      return res
        .status(400)
        .json({ error: "clinicId, doctorId, date are required" });
    }

    const start = new Date(`${date}T00:00:00+05:30`);
    const end = new Date(`${date}T23:59:59+05:30`);

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
            ...(excludeAppointmentId
              ? { NOT: { id: excludeAppointmentId } }
              : {}),
          },
          select: { id: true },
          take: 1,
        },
      },
    });

    return res.json({
      data: slots.map((s) => {
        const isPassed = isSlotPassedIst(date, s.time);

        return {
          id: s.id,
          date: s.date,
          time: s.time,
          paymentMode: s.paymentMode,
          kind: s.kind,
          price: s.price,
          isBooked: (s.appointments?.length || 0) > 0,
          isPassed,
        };
      }),
    });
  } catch (error) {
    console.error("Get Slots For User Error:", error);
    return next
      ? next(error)
      : res.status(500).json({ error: "Failed to load slots" });
  }
};

/* ---------------- getSlotsByDoctor ---------------- */

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
      return res.status(404).json({ error: "Doctor unavailable." });
    }

    const where = {
      doctorId,
      deletedAt: null,
      kind: "APPOINTMENT", // hide BREAK / lunch slots
    };

    let dateStrForPassed = null;

    if (date) {
      // date is already 'YYYY-MM-DD' from query
      dateStrForPassed = date;

      const start = new Date(`${date}T00:00:00+05:30`);
      const end = new Date(`${date}T23:59:59+05:30`);
      where.date = { gte: start, lte: end };
    }

    // 🔥 1) All slots WITH isBlocked filter
    const slots = await prisma.slot.findMany({
      where: {
        ...where,
        isBlocked: false  // 🔥 ONLY return NON-BLOCKED slots
      },
      select: { // 🔥 Add select for performance
        id: true,
        date: true,
        time: true,
        paymentMode: true,
        kind: true,
        price: true
      },
      orderBy: [{ date: "asc" }, { time: "asc" }],
    });

    // 2) Booked slots (confirmed + recent pending)
    const blockedAppointments = await prisma.appointment.findMany({
      where: {
        slotId: { in: slots.map((slot) => slot.id) },
        OR: [
          { status: "CONFIRMED" }, // permanently booked
          {
            status: "PENDING", // active payment hold within last 10 minutes
            createdAt: {
              gt: new Date(Date.now() - 10 * 60 * 1000),
            },
          },
        ],
        deletedAt: null,
      },
      select: { slotId: true },
    });

    const blockedSlotIds = new Set(blockedAppointments.map((a) => a.slotId));

    // Build result slots
    const resultSlots = slots
      .map((slot) => {
        const slotDateStr =
          dateStrForPassed ||
          new Date(slot.date).toISOString().split("T")[0];

        const isPassed = isSlotPassedIst(slotDateStr, slot.time);
        const isBooked = blockedSlotIds.has(slot.id);

        return {
          id: slot.id,
          date: slot.date,
          time: slot.time,
          paymentMode: slot.paymentMode || "FREE",
          kind: slot.kind,
          price: Number(slot.price || 0),
          isBlocked: false,  // 🔥 Always false (already filtered)
          isBooked,
          isPassed,
        };
      })
      .sort((a, b) => a.time.localeCompare(b.time));

    return res.json({
      success: true,
      doctorId,
      date,
      slots: resultSlots,
      totalAvailable: resultSlots.filter((s) => !s.isBooked && !s.isPassed).length,
      totalBlocked: resultSlots.filter((s) => s.isBooked).length,
      stats: {
        free: resultSlots.filter(
          (s) => s.paymentMode === "FREE" && !s.isBooked && !s.isPassed
        ).length,
        paid: resultSlots.filter(
          (s) => s.paymentMode !== "FREE" && !s.isBooked && !s.isPassed
        ).length,
      },
    });
  } catch (error) {
    console.error("Slot Fetch Error:", error);
    return res.status(500).json({ error: "Failed to load slots." });
  }
};


