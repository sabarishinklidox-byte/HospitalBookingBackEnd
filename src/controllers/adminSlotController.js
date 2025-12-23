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
    // Overlap Logic: (StartA < EndB) && (EndA > StartB)
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
            status: { in: ['PENDING', 'CONFIRMED'] },
          },
          select: { id: true },
        },
      },
    });

    if (!existing) {
      return res.status(404).json({ error: 'Slot not found' });
    }

    // ✅ FIXED: Safe null check
    const activeAppointments = existing.appointments || [];
    if (activeAppointments.length > 0) {
      return res.status(400).json({
        error:
          'Cannot delete this slot because it has active bookings. Cancel or move those appointments first.',
        count: activeAppointments.length, // Bonus: show count
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
  


export const createBulkSlots = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { doctorId, startDate, endDate, startTime, endTime, duration, days, paymentMode, kind, lunchStart, lunchEnd } = req.body;

    // ... Validation (Same as before) ...
    if (!doctorId || !startDate || !endDate || !startTime || !endTime || !duration) return res.status(400).json({ error: "Missing fields" });
    if (!Array.isArray(days)) return res.status(400).json({ error: "Days array required" });
    
    const doctor = await prisma.doctor.findUnique({ where: { id: doctorId }, select: { clinicId: true, name: true } });
    if (!doctor || doctor.clinicId !== clinicId) return res.status(403).json({ error: "Invalid doctor" });

    // HELPER: Convert "HH:MM" or "HH:MM:SS" to minutes
    const timeToMinutes = (timeStr) => {
        if (!timeStr) return 0;
        const [h, m] = String(timeStr).split(':').map(Number);
        return h * 60 + m;
    };

    const startMins = timeToMinutes(startTime);
    const endMins = timeToMinutes(endTime);
    const lunchStartMins = lunchStart ? timeToMinutes(lunchStart) : -1;
    const lunchEndMins = lunchEnd ? timeToMinutes(lunchEnd) : -1;
    const durationMins = parseInt(duration, 10);
    const selectedDays = days.map(d => parseInt(d, 10));
    
    // 1. Generate Slots
    const slotsToCreate = [];
    let currentDate = new Date(startDate);
    currentDate.setHours(0,0,0,0); 
    const finalDateObj = new Date(endDate);
    finalDateObj.setHours(0,0,0,0);

    while (currentDate <= finalDateObj) {
      if (selectedDays.includes(currentDate.getDay())) {
        for (let time = startMins; time < endMins; time += durationMins) {
            const slotStart = time;
            const slotEnd = time + durationMins;
            if (slotEnd > endMins) continue; 
            if (lunchStartMins !== -1 && lunchEndMins !== -1) {
                if (slotStart < lunchEndMins && slotEnd > lunchStartMins) continue;
            }

            const h = Math.floor(time / 60).toString().padStart(2, '0');
            const m = (time % 60).toString().padStart(2, '0');
            
            slotsToCreate.push({
                doctorId,
                clinicId: doctor.clinicId,
                date: new Date(currentDate), 
                time: `${h}:${m}`,
                duration: durationMins,
                paymentMode: paymentMode || "ONLINE", 
                price: paymentMode === "FREE" ? 0 : 500,
                type: kind === "BREAK" ? "BREAK" : "PAID",
                kind: kind || "APPOINTMENT"
            });
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (slotsToCreate.length === 0) return res.status(400).json({ error: "No slots generated." });

    // 2. FETCH EXISTING SLOTS
    const existingSlots = await prisma.slot.findMany({
      where: {
        clinicId,
        doctorId,
        deletedAt: null,
        date: {
          gte: new Date(startDate), 
          lte: new Date(endDate)
        }
      },
      select: { date: true, time: true, duration: true }
    });

    const validSlots = [];
    let duplicateCount = 0;

    // 3. OVERLAP CHECK
    for (const newSlot of slotsToCreate) {
      // Use simple ISO string YYYY-MM-DD (first 10 chars) for reliable comparison
      // But we must correct for timezone offset if using toISOString on local dates.
      // Safest is to constructing a string manually from the Date object:
      const d = newSlot.date;
      const newDateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      
      const newStartMin = timeToMinutes(newSlot.time);
      const newEndMin = newStartMin + newSlot.duration;

      const hasConflict = existingSlots.some(existing => {
        // Construct existing date string same way
        const ed = new Date(existing.date);
        const existingDateStr = `${ed.getFullYear()}-${String(ed.getMonth()+1).padStart(2,'0')}-${String(ed.getDate()).padStart(2,'0')}`;
        
        if (existingDateStr !== newDateStr) {
            return false; 
        }

        // Fix Time Format (handle potential "09:00:00")
        const exStartMin = timeToMinutes(existing.time);
        const exEndMin = exStartMin + existing.duration;

        // Check intersection
        return (newStartMin < exEndMin && newEndMin > exStartMin);
      });

      if (hasConflict) {
        duplicateCount++;
      } else {
        validSlots.push(newSlot);
      }
    }

    // 4. Insert
    let successCount = 0;
    for (const slot of validSlots) {
       try {
         await prisma.slot.create({ data: slot });
         successCount++;
       } catch(e) { if(e.code === 'P2002') duplicateCount++; }
    }

    await logAudit({
        userId: userId || req.user.userId,
        clinicId,
        action: "BULK_CREATE_SLOTS",
        entity: "Slot",
        entityId: "BULK",
        details: { count: successCount, skipped: duplicateCount },
        req
    });

    return res.json({
      message: `Created: ${successCount}, Skipped: ${duplicateCount}`,
      count: successCount,
      skipped: duplicateCount
    });

  } catch (error) {
    console.error("Bulk Error:", error);
    return res.status(500).json({ error: error.message });
  }
};





  // controllers/slotController.js
  // controllers/slotController.js
  // controllers/slotController.js
// controllers/slotController.js
export const getDoctorSlotsForReschedule = async (req, res, next) => {
  try {
    const clinicId = req.user?.clinicId;
    const { doctorId } = req.params;
    const { from, days = 7, excludeAppointmentId } = req.query;

    if (!clinicId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    if (!doctorId) {
      return res.status(400).json({ error: "doctorId is required" });
    }

    const daysNum = Number(days);
    if (!Number.isFinite(daysNum) || daysNum <= 0 || daysNum > 60) {
      return res.status(400).json({ error: "days must be a valid number (1-60)" });
    }

    const startDate = from ? new Date(from) : new Date();
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ error: "Invalid from date" });
    }
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + daysNum);
    endDate.setHours(0, 0, 0, 0);

    const slots = await prisma.slot.findMany({
      where: {
        clinicId,
        doctorId,
        deletedAt: null,
        kind: "APPOINTMENT",              // ✅ hide lunch/break
        status: "PENDING",                // ✅ only available slots (keep if you use it)
        date: { gte: startDate, lt: endDate },
      },
      orderBy: [{ date: "asc" }, { time: "asc" }],
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

    // Group response to match RescheduleAppointmentModal expectations
    const byDate = {};
    for (const s of slots) {
      const dateKey = s.date.toISOString().slice(0, 10);

      if (!byDate[dateKey]) {
        byDate[dateKey] = { date: dateKey, label: dateKey, slots: [] };
      }

      const hour = parseInt(String(s.time).split(":")[0], 10);
      const period = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";

      byDate[dateKey].slots.push({
        slotId: s.id,
        timeLabel: s.time,
        startTime: s.time,
        endTime: s.endTime || null,
        period,
        isBooked: (s.appointments?.length || 0) > 0,
      });
    }

    return res.json(Object.values(byDate));
  } catch (error) {
    console.error("getDoctorSlotsForReschedule error:", error);
    // keep your pattern
    return next ? next(error) : res.status(500).json({ error: "Failed to load slots" });
  }
};



// GET /api/admin/doctors/:doctorId/slots?from=YYYY-MM-DD&days=7&excludeAppointmentId=...
export const getDoctorSlotsWindow = async (req, res) => {
  try {
    const clinicId = req.user?.clinicId;
    const { doctorId } = req.params;
    const { from, days = 7, excludeAppointmentId } = req.query;

    if (!clinicId) return res.status(401).json({ error: "Unauthorized" });
    if (!doctorId) return res.status(400).json({ error: "Doctor ID is required" });

    const daysNum = Number(days);
    if (!Number.isFinite(daysNum) || daysNum <= 0 || daysNum > 60) {
      return res.status(400).json({ error: "days must be a valid number (1-60)" });
    }

    const baseDateStr = from || new Date().toISOString().slice(0, 10);
    const fromDate = new Date(baseDateStr);
    if (Number.isNaN(fromDate.getTime())) {
      return res.status(400).json({ error: "Invalid from date" });
    }

    const start = new Date(fromDate);
    start.setHours(0, 0, 0, 0);

    const endExclusive = new Date(start);
    endExclusive.setDate(endExclusive.getDate() + daysNum);
    endExclusive.setHours(0, 0, 0, 0);

    // ✅ fetch only appointment slots (hide BREAK/LUNCH) and compute isBooked like your getSlotsForUser
    const slots = await prisma.slot.findMany({
      where: {
        clinicId,
        doctorId,
        deletedAt: null,
        status: "PENDING",       // if PENDING = available
        kind: "APPOINTMENT",     // ✅ FIX: this hides lunch/break
        date: { gte: start, lt: endExclusive },
      },
      orderBy: [{ date: "asc" }, { time: "asc" }],
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

    // Labels: Today / Tomorrow / else formatted
    const todayStr = new Date().toISOString().slice(0, 10);
    const tomorrowDate = new Date();
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

    const byDate = {};

    for (const s of slots) {
      const d = s.date.toISOString().slice(0, 10);

      if (!byDate[d]) {
        let label;
        if (d === todayStr) label = "Today";
        else if (d === tomorrowStr) label = "Tomorrow";
        else {
          label = s.date.toLocaleDateString("en-GB", {
            weekday: "short",
            day: "2-digit",
            month: "short",
          });
        }
        byDate[d] = { date: d, label, slots: [] };
      }

      const hour = parseInt(String(s.time).split(":")[0], 10);
      const period = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";

      // "09:30 AM"
      const [, mm] = String(s.time).split(":");
      const hour12 = ((hour + 11) % 12) + 1;
      const ampm = hour < 12 ? "AM" : "PM";
      const timeLabel = `${String(hour12).padStart(2, "0")}:${mm} ${ampm}`;

      let endTime = s.endTime || null;
      if (!endTime && s.duration) {
        const t = new Date(`2000-01-01T${String(s.time)}:00`);
        t.setMinutes(t.getMinutes() + Number(s.duration));
        const eh = String(t.getHours()).padStart(2, "0");
        const em = String(t.getMinutes()).padStart(2, "0");
        endTime = `${eh}:${em}`;
      }

      byDate[d].slots.push({
        slotId: s.id,
        period,
        timeLabel,
        startTime: s.time,
        endTime,
        isBooked: (s.appointments?.length || 0) > 0, // ✅ modal expects this
      });
    }

    // ensure days without slots appear
    const daysArray = [];
    for (let i = 0; i < daysNum; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      const dateStr = d.toISOString().slice(0, 10);

      if (byDate[dateStr]) {
        daysArray.push(byDate[dateStr]);
      } else {
        let label;
        if (dateStr === todayStr) label = "Today";
        else if (dateStr === tomorrowStr) label = "Tomorrow";
        else {
          label = d.toLocaleDateString("en-GB", {
            weekday: "short",
            day: "2-digit",
            month: "short",
          });
        }
        daysArray.push({ date: dateStr, label, slots: [] });
      }
    }

    return res.json(daysArray);
  } catch (err) {
    console.error("getDoctorSlotsWindow error", err);
    return res.status(500).json({ error: "Failed to load slots" });
  }
};

