// Clinic admin: bookings per day with completed vs cancelled
import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';
export const getClinicBookingsStats = async (req, res) => {
  try {
    const { role, clinicId } = req.user;
    const { startDate, endDate } = req.query;

    if (role !== 'ADMIN') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing for admin' });
    }
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ error: 'startDate and endDate are required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // 1) Get all appointments for this clinic in date range
    const appts = await prisma.appointment.findMany({
      where: {
        clinicId,
        createdAt: { gte: start, lte: end },
        status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED'] },
      },
      select: { createdAt: true, status: true },
      orderBy: { createdAt: 'asc' },
    });

    // 2) Group in JS by day
    const map = new Map();
    for (const a of appts) {
      const day = a.createdAt.toISOString().slice(0, 10);
      if (!map.has(day)) {
        map.set(day, {
          totalBookings: 0,
          completed: 0,
          cancelled: 0,
        });
      }
      const entry = map.get(day);
      entry.totalBookings += 1;
      if (a.status === 'COMPLETED') entry.completed += 1;
      if (a.status === 'CANCELLED') entry.cancelled += 1;
    }

    const data = Array.from(map.entries())
      .sort(([d1], [d2]) => (d1 < d2 ? -1 : 1))
      .map(([date, value]) => ({
        date,
        totalBookings: value.totalBookings,
        completed: value.completed,
        cancelled: value.cancelled,
      }));

    res.json({ data });
  } catch (err) {
    console.error('getClinicBookingsStats error', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
};
export const getClinicSlotsUsageStats = async (req, res) => {
  try {
    const { role, clinicId } = req.user;
    const { startDate, endDate } = req.query;

    if (role !== 'ADMIN') {
      return res.status(403).json({ error: 'Unauthorized' });
    }
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing for admin' });
    }
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ error: 'startDate and endDate are required' });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    // 1) Get all slots in range for this clinic
    const slots = await prisma.slot.findMany({
      where: {
        clinicId,
        deletedAt: null,
        date: { gte: start, lte: end },
      },
      select: { id: true, date: true },
      orderBy: { date: 'asc' },
    });

    const slotIds = slots.map((s) => s.id);

    // 2) Get all appointments on those slots (booked = PENDING/CONFIRMED/COMPLETED)
    const appts = slotIds.length
      ? await prisma.appointment.findMany({
          where: {
            slotId: { in: slotIds },
            deletedAt: null,
            status: { in: ['PENDING', 'CONFIRMED', 'COMPLETED'] },
          },
          select: { slotId: true },
        })
      : [];

    // 3) Group by day
    const dayMap = new Map();

    // init day totals from slots
    for (const s of slots) {
      const day = s.date.toISOString().slice(0, 10);
      if (!dayMap.has(day)) {
        dayMap.set(day, { totalSlots: 0, bookedSlots: 0 });
      }
      const entry = dayMap.get(day);
      entry.totalSlots += 1;
    }

    // increment bookedSlots by each appointment’s slot
    // need a mapping slotId -> day
    const slotIdToDay = new Map(
      slots.map((s) => [s.id, s.date.toISOString().slice(0, 10)])
    );

    for (const a of appts) {
      const day = slotIdToDay.get(a.slotId);
      if (!day) continue;
      const entry = dayMap.get(day);
      if (!entry) continue;
      entry.bookedSlots += 1;
    }

    const data = Array.from(dayMap.entries())
      .sort(([d1], [d2]) => (d1 < d2 ? -1 : 1))
      .map(([date, value]) => ({
        date,
        totalSlots: value.totalSlots,
        bookedSlots: value.bookedSlots,
        freeSlots: Math.max(value.totalSlots - value.bookedSlots, 0),
      }));

    res.json({ data });
  } catch (err) {
    console.error('getClinicSlotsUsageStats error', err);
    res.status(500).json({ error: 'Failed to load slots usage stats' });
  }
};