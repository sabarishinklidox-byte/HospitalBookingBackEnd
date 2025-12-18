import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';

// ---------------- Helper: current plan for clinic ----------------
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  return clinic?.subscription?.plan || null;
}

// ---------------- Helper: overlap checks ----------------
function buildSlotWindow(dateStr, timeStr, durationMinutes) {
  const start = new Date(`${dateStr}T${timeStr}:00`);
  const end = new Date(start);
  end.setMinutes(end.getMinutes() + Number(durationMinutes || 0));
  return { start, end };
}

async function hasOverlap({ clinicId, doctorId, dateStr, timeStr, duration, excludeSlotId }) {
  const { start, end } = buildSlotWindow(dateStr, timeStr, duration);

  const existing = await prisma.slot.findMany({
    where: {
      clinicId,
      doctorId,
      deletedAt: null,
      date: {
        gte: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
        lt:  new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1),
      },
      ...(excludeSlotId ? { id: { not: excludeSlotId } } : {}),
    },
  });

  const newStart = start.getTime();
  const newEnd   = end.getTime();

  return existing.some((s) => {
    const baseDate = s.date.toISOString().slice(0, 10);
    const sStart = new Date(`${baseDate}T${s.time}:00`).getTime();
    const sEnd   = sStart + s.duration * 60 * 1000;
    return newStart < sEnd && sStart < newEnd;
  });
}

// ----------------------------------------------------------------
// CREATE SINGLE SLOT
// ----------------------------------------------------------------
export const createSlot = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    const { doctorId, date, time, duration, price, paymentMode, kind = 'APPOINTMENT' } = req.body;

    if (!doctorId || !date || !time || !duration) {
      return res.status(400).json({
        error: 'doctorId, date, time, duration are required',
      });
    }

    const plan = await getClinicPlan(clinicId);
    if (!plan) {
      return res
        .status(400)
        .json({ error: 'No active subscription plan for this clinic.' });
    }

    const mode = paymentMode || 'ONLINE';
    const isPaidMode = mode === 'ONLINE' || mode === 'OFFLINE';

    if (isPaidMode && !plan.allowOnlinePayments) {
      return res.status(403).json({
        error:
          'Paid/online slots are disabled on your current plan. Use FREE mode instead.',
      });
    }

    const doctor = await prisma.doctor.findFirst({
      where: {
        id: doctorId,
        clinicId,
        deletedAt: null,
      },
    });

    if (!doctor) {
      return res
        .status(404)
        .json({ error: 'Doctor not found in this clinic' });
    }

    const dateStr = new Date(date).toISOString().slice(0, 10);

    if (await hasOverlap({ clinicId, doctorId, dateStr, timeStr: time, duration })) {
      return res.status(400).json({
        error: 'This time overlaps an existing slot for this doctor.',
      });
    }

    const slot = await prisma.slot.create({
      data: {
        doctorId,
        clinicId,
        date: new Date(date),
        time,
        duration: Number(duration),
        paymentMode: mode,
        price: mode === 'FREE' ? 0 : Number(price || 0),
        type: mode === 'FREE' ? 'FREE' : 'PAID',
        kind, // "APPOINTMENT" or "BREAK"
      },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'CREATE_SLOT',
      entity: 'Slot',
      entityId: slot.id,
      details: {
        doctorName: doctor.name,
        date: new Date(date).toLocaleDateString(),
        time,
        paymentMode: mode,
        kind,
      },
      req,
    });

    return res.status(201).json(slot);
  } catch (error) {
    console.error('Create Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// LIST SLOTS (unchanged logic)
// ----------------------------------------------------------------
export const getSlots = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { doctorId, date } = req.query;

    if (!doctorId) {
      return res.status(400).json({ error: 'doctorId is required' });
    }

    const where = {
      clinicId,
      doctorId,
      deletedAt: null,
    };

    if (date) {
      const d = new Date(date);
      const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const endOfDay = new Date(
        d.getFullYear(),
        d.getMonth(),
        d.getDate() + 1
      );
      where.date = { gte: startOfDay, lt: endOfDay };
    }

    const slots = await prisma.slot.findMany({
      where,
      orderBy: [{ date: 'asc' }, { time: 'asc' }],
    });

    return res.json(slots);
  } catch (error) {
    console.error('Get Slots Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// UPDATE SLOT
// ----------------------------------------------------------------
export const updateSlot = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { date, time, duration, price, paymentMode, kind } = req.body;

    const existing = await prisma.slot.findFirst({
      where: { id, clinicId, deletedAt: null },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    const plan = await getClinicPlan(clinicId);
    if (!plan) {
      return res
        .status(400)
        .json({ error: 'No active subscription plan for this clinic.' });
    }

    const nextMode = paymentMode ?? existing.paymentMode;
    const isPaidMode = nextMode === 'ONLINE' || nextMode === 'OFFLINE';

    if (isPaidMode && !plan.allowOnlinePayments) {
      return res.status(403).json({
        error:
          'Paid/online slots are disabled on your current plan. Use FREE mode instead.',
      });
    }

    const nextDateObj = date ? new Date(date) : existing.date;
    const nextDateStr = nextDateObj.toISOString().slice(0, 10);
    const nextDuration = duration !== undefined ? duration : existing.duration;
    const nextTime = time ?? existing.time;

    if (
      await hasOverlap({
        clinicId,
        doctorId: existing.doctorId,
        dateStr: nextDateStr,
        timeStr: nextTime,
        duration: nextDuration,
        excludeSlotId: existing.id,
      })
    ) {
      return res.status(400).json({
        error: 'Updated time overlaps an existing slot for this doctor.',
      });
    }

    const updated = await prisma.slot.update({
      where: { id },
      data: {
        date: nextDateObj,
        time: nextTime,
        duration:
          duration !== undefined ? Number(duration) : existing.duration,
        paymentMode: nextMode,
        price:
          nextMode === 'FREE'
            ? 0
            : price !== undefined
            ? Number(price)
            : existing.price,
        type: nextMode === 'FREE' ? 'FREE' : 'PAID',
        kind: kind ?? existing.kind,
      },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'UPDATE_SLOT',
      entity: 'Slot',
      entityId: id,
      details: {
        oldTime: existing.time,
        newTime: updated.time,
        oldMode: existing.paymentMode,
        newMode: updated.paymentMode,
      },
      req,
    });

    return res.json(updated);
  } catch (error) {
    console.error('Update Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// DELETE SLOT
// ----------------------------------------------------------------
export const deleteSlot = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;

    const existing = await prisma.slot.findFirst({
      where: { id, clinicId, deletedAt: null },
      include: {
        doctor: { select: { name: true } },
        appointments: {
          where: {
            deletedAt: null,
            status: { in: ['PENDING', 'CONFIRMED'] }, // treat these as active
          },
          select: { id: true },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // ❌ block delete if there are active bookings
    if (existing.appointments.length > 0) {
      return res.status(400).json({
        error:
          'Cannot delete this slot because it has active bookings. Cancel or move those appointments first.',
      });
    }

    // ✅ safe to soft-delete
    await prisma.slot.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'DELETE_SLOT',
      entity: 'Slot',
      entityId: id,
      details: {
        doctorName: existing.doctor?.name,
        date: new Date(existing.date).toLocaleDateString(),
        time: existing.time,
      },
      req,
    });

    return res.json({ message: 'Slot deleted (soft)' });
  } catch (error) {
    console.error('Delete Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};



  // ----------------------------------------------------------------
  // BULK CREATE (gated by enableAuditLogs)
  // ----------------------------------------------------------------
  export const createBulkSlots = async (req, res) => {
    try {
      const { clinicId, userId } = req.user;
      const {
        doctorId,
        startDate,
        endDate,
        startTime,
        duration,
        days,
        paymentMode,
      } = req.body;

      if (!doctorId || !startDate || !endDate || !startTime || !duration) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const plan = await getClinicPlan(clinicId);
      if (!plan) {
        return res
          .status(400)
          .json({ error: 'No active subscription plan for this clinic.' });
      }

      // ✅ gate bulk slots on enableAuditLogs (advanced tools)
      if (!plan.enableAuditLogs) {
        return res.status(403).json({
          error:
            'Bulk slot creation is not available on your current plan. Please upgrade to enable this feature.',
        });
      }

      const mode = paymentMode || 'ONLINE';
      const isPaidMode = mode === 'ONLINE' || mode === 'OFFLINE';

      if (isPaidMode && !plan.allowOnlinePayments) {
        return res.status(403).json({
          error:
            'Paid/online slots are disabled on your current plan. Use FREE mode instead.',
        });
      }

      const doctor = await prisma.doctor.findUnique({
        where: { id: doctorId },
        select: { clinicId: true, name: true, deletedAt: true },
      });

      if (!doctor || doctor.deletedAt) {
        return res.status(404).json({ error: 'Doctor not found' });
      }

      const selectedDays = days.map((d) => parseInt(d, 10));

      const slotsToCreate = [];

      let currentDate = new Date(startDate);
      currentDate.setHours(12, 0, 0, 0);

      const finalDate = new Date(endDate);
      finalDate.setHours(12, 0, 0, 0);

      const slotPrice = mode === 'FREE' ? 0 : 500;

      while (currentDate <= finalDate) {
        const dayIndex = currentDate.getDay();

        if (selectedDays.includes(dayIndex)) {
          slotsToCreate.push({
            doctorId,
            clinicId: doctor.clinicId,
            date: new Date(currentDate),
            time: startTime,
            duration: parseInt(duration, 10),
            paymentMode: mode,
            price: slotPrice,
            type: mode === 'FREE' ? 'FREE' : 'PAID',
          });
        }

        currentDate.setDate(currentDate.getDate() + 1);
      }

      if (slotsToCreate.length === 0) {
        return res.status(400).json({ error: 'No slots generated.' });
      }

      let successCount = 0;
      let duplicateCount = 0;

      for (const slot of slotsToCreate) {
        try {
          await prisma.slot.create({ data: slot });
          successCount++;
        } catch (error) {
          if (error.code === 'P2002') {
            duplicateCount++;
          } else {
            console.error('Failed to create slot:', error.message);
          }
        }
      }

      if (successCount > 0) {
        await logAudit({
          userId: userId || req.user.userId,
          clinicId,
          action: 'BULK_CREATE_SLOTS',
          entity: 'Slot',
          entityId: 'BULK',
          details: {
            doctorName: doctor.name,
            count: successCount,
            skipped: duplicateCount,
            startDate,
            endDate,
            paymentMode: mode,
          },
          req,
        });
      }

      return res.json({
        message: `Created: ${successCount}, Skipped: ${duplicateCount}`,
        count: successCount,
      });
    } catch (error) {
      console.error('Bulk Create Error:', error);
      return res.status(500).json({ error: error.message });
    }
  };
  // controllers/slotController.js
  // controllers/slotController.js
  // controllers/slotController.js
// controllers/slotController.js
export const getDoctorSlotsForReschedule = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { doctorId } = req.params;
    const { from, days = 7, excludeAppointmentId } = req.query;

    if (!clinicId) return res.status(400).json({ error: "Clinic ID missing from request" });
    if (!doctorId) return res.status(400).json({ error: "doctorId is required" });

    const startDate = from ? new Date(from) : new Date();
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + Number(days));
    endDate.setHours(0, 0, 0, 0);

    // 1) all slots
    const slots = await prisma.slot.findMany({
      where: {
        clinicId,
        doctorId,
        deletedAt: null,
        date: { gte: startDate, lt: endDate },
      },
      orderBy: [{ date: "asc" }, { time: "asc" }],
      select: { id: true, date: true, time: true, duration: true, endTime: true },
    });

    // 2) all appointments occupying slots (because slotId is UNIQUE)
    const appts = await prisma.appointment.findMany({
      where: {
        clinicId,
        doctorId,
        deletedAt: null,
        slotId: { not: null },
        ...(excludeAppointmentId ? { id: { not: excludeAppointmentId } } : {}),
      },
      select: { slotId: true },
    });

    const takenSlotIds = new Set(appts.map((a) => a.slotId));

    // 3) group by date and add isBooked
    const byDate = {};
    for (const s of slots) {
      const dateKey = s.date.toISOString().slice(0, 10);
      if (!byDate[dateKey]) byDate[dateKey] = { date: dateKey, label: dateKey, slots: [] };

      const hour = parseInt(s.time.split(":")[0], 10);
      const period = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";

      byDate[dateKey].slots.push({
        slotId: s.id,
        timeLabel: s.time,
        startTime: s.time,
        endTime: s.endTime || null,
        period,
        isBooked: takenSlotIds.has(s.id),
      });
    }

    return res.json(Object.values(byDate));
  } catch (err) {
    console.error("getDoctorSlotsForReschedule error", err);
    return res.status(500).json({ error: "Failed to load slots" });
  }
};



  export const getDoctorSlotsWindow = async (req, res) => {
    try {
      const { clinicId } = req.user; // or from req.query if needed
      const { doctorId } = req.params;
      const { from, days = 7 } = req.query;

      if (!clinicId) {
        return res.status(400).json({ error: 'Clinic ID missing from request' });
      }
      if (!doctorId) {
        return res.status(400).json({ error: 'Doctor ID is required' });
      }

      const baseDateStr = from || new Date().toISOString().slice(0, 10);
      const fromDate = new Date(baseDateStr);
      const daysNum = parseInt(days, 10) || 7;

      const toDate = new Date(fromDate);
      toDate.setDate(toDate.getDate() + daysNum - 1);

      const slots = await prisma.slot.findMany({
        where: {
          clinicId,
          doctorId,
          deletedAt: null,
          date: { gte: fromDate, lte: toDate },
          // adjust if you use a different status for available slots
          status: 'PENDING',
        },
        orderBy: [{ date: 'asc' }, { time: 'asc' }],
      });

      const todayStr = new Date().toISOString().slice(0, 10);
      const tomorrowDate = new Date();
      tomorrowDate.setDate(tomorrowDate.getDate() + 1);
      const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

      const byDate = {};

      for (const s of slots) {
        const d = s.date.toISOString().slice(0, 10); // "2025-12-17"

        if (!byDate[d]) {
          let label;
          if (d === todayStr) label = 'Today';
          else if (d === tomorrowStr) label = 'Tomorrow';
          else {
            label = s.date.toLocaleDateString('en-GB', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
            }); // e.g. "Wed, 17 Dec"
          }

          byDate[d] = {
            date: d,
            label,
            slots: [],
          };
        }

        // derive Morning / Afternoon / Evening from hour
        // assuming s.time is "HH:MM"
        const [hh] = s.time.split(':');
        const hour = parseInt(hh, 10);
        const period =
          hour < 12 ? 'Morning' : hour < 17 ? 'Afternoon' : 'Evening';

        // create a user‑friendly label like "09:30 AM"
        const [hStr, mStr] = s.time.split(':');
        let hour12 = ((hour + 11) % 12) + 1;
        const ampm = hour < 12 ? 'AM' : 'PM';
        const timeLabel = `${String(hour12).padStart(2, '0')}:${mStr} ${ampm}`;

        // if you store endTime, use it; else compute from duration minutes
        let endTime = s.endTime;
        if (!endTime && s.duration) {
          const start = new Date(`2000-01-01T${s.time}:00`);
          start.setMinutes(start.getMinutes() + s.duration);
          const eh = String(start.getHours()).padStart(2, '0');
          const em = String(start.getMinutes()).padStart(2, '0');
          endTime = `${eh}:${em}`;
        }

        byDate[d].slots.push({
          period,
          timeLabel,          // "09:30 AM"
          startTime: s.time,  // "09:30"
          endTime,            // "09:45"
        });
      }

      // ensure days without slots still appear (optional)
      const daysArray = [];
      for (let i = 0; i < daysNum; i++) {
        const d = new Date(fromDate);
        d.setDate(d.getDate() + i);
        const dateStr = d.toISOString().slice(0, 10);

        if (byDate[dateStr]) {
          daysArray.push(byDate[dateStr]);
        } else {
          let label;
          if (dateStr === todayStr) label = 'Today';
          else if (dateStr === tomorrowStr) label = 'Tomorrow';
          else {
            label = d.toLocaleDateString('en-GB', {
              weekday: 'short',
              day: '2-digit',
              month: 'short',
            });
          }
          daysArray.push({
            date: dateStr,
            label,
            slots: [],
          });
        }
      }

      return res.json(daysArray);
    } catch (err) {
      console.error('getDoctorSlotsWindow error', err);
      return res.status(500).json({ error: 'Failed to load slots' });
    }
  };