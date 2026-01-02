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
// controllers/slotController.js

export const getSlots = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { doctorId, date, page = 1, limit = 20 } = req.query;

    if (!doctorId) {
      return res.status(400).json({ error: "doctorId is required" });
    }

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 20;
    const skip = (pageNum - 1) * limitNum;

    if (!date) {
      return res.status(400).json({ error: "date is required" });
    }

    // SAME range as user API
    const start = new Date(`${date}T00:00:00+05:30`);
    const end   = new Date(`${date}T23:59:59+05:30`);

    const where = {
      clinicId,
      doctorId,
      deletedAt: null,
      date: { gte: start, lte: end },
    };

    const [total, slots] = await prisma.$transaction([
      prisma.slot.count({ where }),
      prisma.slot.findMany({
        where,
        orderBy: [{ date: "asc" }, { time: "asc" }],
        skip,
        take: limitNum,
        include: {
          appointments: {
            where: {
              deletedAt: null,
              status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] },
            },
            select: { id: true },
          },
        },
      }),
    ]); 

    const data = slots.map((s) => ({
      ...s,
      isBooked: !!s.appointments,
    }));

    return res.json({
      data,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  } catch (error) {
    console.error("Get Slots Error:", error);
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



export const getDoctorSlotsWindow = async (req, res) => {
  try {
    const clinicId = req.user?.clinicId;
    const { doctorId } = req.params;
    const { from, days = 30, excludeAppointmentId } = req.query;

    if (!clinicId) return res.status(401).json({ error: "Unauthorized" });
    if (!doctorId) return res.status(400).json({ error: "Doctor ID is required" });

    const daysNum = Number(days);
    if (!Number.isFinite(daysNum) || daysNum <= 0 || daysNum > 365) {
      return res.status(400).json({ error: "days must be 1-365" });
    }

    // 🔥 Base date: construct from YYYY-MM-DD at UTC midnight
    const baseDateStr = from || new Date().toISOString().slice(0, 10);
    const [y, m, d] = baseDateStr.split("-").map(Number);
    if (!y || !m || !d) {
      return res.status(400).json({ error: "Invalid from date" });
    }

    const start = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    const endExclusive = new Date(start);
    endExclusive.setDate(endExclusive.getDate() + daysNum);

    // "Today" and "Tomorrow" relative to window start
    const todayStr = start.toISOString().slice(0, 10);
    const tomorrowDate = new Date(start);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = tomorrowDate.toISOString().slice(0, 10);

    const slots = await prisma.slot.findMany({
      where: {
        clinicId,
        doctorId,
        deletedAt: null,
        isBlocked: false,
        kind: "APPOINTMENT",
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
        },
      },
    });

    const isSlotPassedIst = (slotDateStr, slotTimeStr) => {
      if (!slotDateStr || !slotTimeStr) return false;

      const now = new Date();
      const nowStr = now.toISOString().split("T")[0];

      if (slotDateStr < nowStr) return true;
      if (slotDateStr > nowStr) return false;

      const [hours, minutes] = slotTimeStr.split(":").map(Number);
      const currentHours = now.getHours();
      const currentMinutes = now.getMinutes();

      if (hours < currentHours) return true;
      if (hours === currentHours && minutes <= currentMinutes) return true;
      return false;
    };

    const byDate = {};

    for (const s of slots) {
      const slotDateStr = s.date.toISOString().split("T")[0];

      if (isSlotPassedIst(slotDateStr, s.time)) continue;

      if (!byDate[slotDateStr]) {
        let label;
        if (slotDateStr === todayStr) label = "Today";
        else if (slotDateStr === tomorrowStr) label = "Tomorrow";
        else {
          label = s.date.toLocaleDateString("en-GB", {
            weekday: "short",
            day: "2-digit",
            month: "short",
          });
        }
        byDate[slotDateStr] = { date: slotDateStr, label, slots: [] };
      }

      const hour = parseInt(String(s.time).split(":")[0], 10);
      const period = hour < 12 ? "Morning" : hour < 17 ? "Afternoon" : "Evening";

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

      // 🔥 NEW: Slot Type & Price Display
      const slotType = s.paymentMode === "FREE" 
        ? "FREE" 
        : s.paymentMode === "ONLINE" 
        ? "Online Pay" 
        : "Pay at Clinic";
      
      const priceDisplay = s.paymentMode === "FREE" 
        ? "FREE" 
        : `₹${Number(s.price || 0).toLocaleString()}`;

      byDate[slotDateStr].slots.push({
        slotId: s.id,
        isBlocked: false,
        isPassed: false,
        period,
        timeLabel,
        startTime: s.time,
        endTime,
        isBooked: (s.appointments?.length || 0) > 0,
        // 🔥 ADDED: Slot Type & Price
        slotType,
        price: Number(s.price || 0),
        priceDisplay,
      });
    }

    const daysArray = [];
    for (let i = 0; i < daysNum; i++) {
      const dDate = new Date(start);
      dDate.setDate(dDate.getDate() + i);
      const dateStr = dDate.toISOString().slice(0, 10);

      if (byDate[dateStr]) {
        const entry = byDate[dateStr];
        if (dateStr === todayStr) entry.label = "Today";
        else if (dateStr === tomorrowStr) entry.label = "Tomorrow";
        daysArray.push(entry);
      } else {
        let label;
        if (dateStr === todayStr) label = "Today";
        else if (dateStr === tomorrowStr) label = "Tomorrow";
        else {
          label = dDate.toLocaleDateString("en-GB", {
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





// ✅ FULLY FIXED getManageableSlots - Bulletproof + Debug Logs!
// ✅ FULLY FIXED getManageableSlots - Prisma include/select conflict RESOLVED!
// ✅ FULLY FIXED getManageableSlots - Date/Time Parsing + Prisma FIXED!
export const getManageableSlots = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { doctorId, date } = req.query;

    console.log('🔍 Slot Manager START:', { clinicId, doctorId, date, user: req.user?.id });
    
    if (!clinicId) {
      console.error('🚨 NO CLINIC ID IN USER:', req.user);
      return res.status(401).json({ error: 'Clinic not authorized' });
    }

    const where = {
      clinicId,
      deletedAt: null,
    };

    // Date Parsing (unchanged)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    if (date) {
      try {
        console.log('🔍 Parsing date:', date);
        const [year, month, day] = date.split('-').map(Number);
        if (!year || !month || !day || month < 1 || month > 12) {
          throw new Error(`Invalid date parts: ${year}-${month}-${day}`);
        }
        const start = new Date(year, month - 1, day, 0, 0, 0);
        const end = new Date(year, month - 1, day, 23, 59, 59);
        
        where.date = { 
          gte: start.toISOString(), 
          lte: end.toISOString() 
        };
        console.log('✅ Date range:', where.date);
      } catch (err) {
        console.error('🚨 Date parse error:', err.message);
        return res.status(400).json({ error: `Invalid date format: ${date}. Use YYYY-MM-DD` });
      }
    } else {
      const tomorrow = new Date(today.getTime() + 24*60*60*1000 - 1);
      where.date = { 
        gte: today.toISOString(), 
        lte: tomorrow.toISOString() 
      };
      console.log('✅ Using today range:', where.date);
    }

    if (doctorId) {
      where.doctorId = doctorId;
      console.log('✅ Added doctor filter:', doctorId);
    }

    console.log('🔍 FINAL WHERE:', JSON.stringify(where, null, 2));

    const now = new Date();

    // Slots query
    console.log('🔍 Fetching slots...');
    const slots = await prisma.slot.findMany({
      where,
      include: {
        doctor: { 
          select: { id: true, name: true } 
        }
      },
      orderBy: [{ date: 'asc' }, { time: 'asc' }]
    });

    console.log(`✅ Found ${slots.length} slots`);

    // Fixed appointments query (include only)
    const slotIds = slots.map(slot => slot.id);
    console.log('🔍 Fetching appointments for slots:', slotIds.slice(0, 5));

    const allAppointments = await prisma.appointment.findMany({
      where: {
        slotId: { in: slotIds },
        deletedAt: null
      },
      include: {
        user: { 
          select: { 
            name: true, 
            phone: true 
          } 
        }
      }
    });

    console.log(`✅ Found ${allAppointments.length} appointments`);

    // Group appointments
    const apptBySlot = new Map();
    allAppointments.forEach(appt => {
      if (!apptBySlot.has(appt.slotId)) {
        apptBySlot.set(appt.slotId, []);
      }
      apptBySlot.get(appt.slotId).push(appt);
    });

    // 🔥 FIXED: Bulletproof date/time parsing!
    const formattedSlots = slots.map(slot => {
      // ✅ SAFE DATE/TIME PARSING - No more "Invalid time value"!
      let slotDateTime;
      try {
        // Parse date safely
        slotDateTime = new Date(slot.date);
        if (isNaN(slotDateTime.getTime())) {
          throw new Error('Invalid date');
        }
        
        // Parse time safely (e.g., "10:30" → 10, 30)
        const timeParts = (slot.time || '00:00').split(':');
        const hours = parseInt(timeParts[0] || '0');
        const minutes = parseInt(timeParts[1] || '0');
        
        if (isNaN(hours) || isNaN(minutes) || hours > 23 || minutes > 59) {
          throw new Error(`Invalid time: ${slot.time}`);
        }
        
        slotDateTime.setHours(hours, minutes, 0, 0);
      } catch (err) {
        console.warn('⚠️ Invalid slot date/time - using fallback:', { 
          slotId: slot.id, 
          date: slot.date, 
          time: slot.time,
          error: err.message 
        });
        slotDateTime = now;  // Safe fallback
      }
      
      const isPassed = slotDateTime < now;
      const appointments = apptBySlot.get(slot.id) || [];
      
      const activeAppointments = appointments.filter(
        appt => !['CANCELLED', 'REJECTED'].includes(appt.status)
      );
      
      const cancelledAppointments = appointments.filter(
        appt => ['CANCELLED', 'REJECTED'].includes(appt.status)
      );
      
      const hasActiveAppointment = activeAppointments.length > 0;
      const firstActiveAppt = activeAppointments[0];
      const firstCancelledAppt = cancelledAppointments[0];

      return {
        id: slot.id,
        time: slot.time || '00:00',
        date: slot.date ? slot.date.toISOString().split('T')[0] : '1970-01-01',
        doctorName: slot.doctor?.name || 'Unknown Doctor',
        doctorId: slot.doctor?.id || null,
        price: Number(slot.price) || 0,
        
        isBlocked: Boolean(slot.isBlocked),
        blockedReason: slot.blockedReason || null,
        blockedBy: slot.blockedBy || null,
        blockedAt: slot.blockedAt ? slot.blockedAt.toISOString() : null,
        
        hasActiveAppointment,
        appointmentCount: activeAppointments.length,
        patientName: firstActiveAppt?.user?.name || null,
        appointmentStatus: firstActiveAppt?.status || null,
        cancelledAppointment: firstCancelledAppt,
        
        isPassed,
        slotDateTime: slotDateTime.toISOString(),  // ✅ SAFE!
        
        status: slot.isBlocked 
          ? 'BLOCKED' 
          : hasActiveAppointment 
          ? 'BOOKED' 
          : isPassed 
          ? 'PASSED' 
          : 'AVAILABLE'
      };
    });

    const manageableSlots = formattedSlots.filter(slot => 
      slot.status === 'AVAILABLE' || 
      slot.status === 'BLOCKED' || 
      slot.cancelledAppointment
    );

    console.log(`✅ SUCCESS: ${slots.length} slots → ${manageableSlots.length} manageable`);

    res.json({
      success: true,
      slots: manageableSlots,
      filters: { doctorId, date },
      stats: {
        totalSlots: slots.length,
        manageableSlots: manageableSlots.length,
        now: now.toISOString()
      }
    });

  } catch (error) {
    console.error('🚨 Slot Manager FULL ERROR:', {
      message: error.message,
      code: error.code,
      meta: error.meta,
      stack: error.stack?.split('\n').slice(0, 5)
    });
    res.status(500).json({ 
      error: 'Failed to fetch slots', 
      debug: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};




// ✅ FULL FIXED blockSlot - Payment Hold Protection + All Safety!
export const blockSlot = async (req, res) => {
  try {
    const { slotId } = req.params;
    const { reason = 'Manual block by admin' } = req.body;
    const { clinicId, userId } = req.user;

    console.log('🔴 BLOCKING SLOT:', { slotId, reason, clinicId, userId: userId?.slice(-6) });

    // 🔥 SAFETY #1: Validate slot ownership
    const slot = await prisma.slot.findFirst({
      where: { 
        id: slotId, 
        clinicId 
      }
    });

    if (!slot) {
      return res.status(404).json({ 
        error: 'Slot not found or not authorized for this clinic' 
      });
    }

    // 🔥 NEW: Check active payment holds FIRST!
    const paymentHolds = await prisma.appointment.findFirst({
      where: {
        slotId,
        status: 'PENDING_PAYMENT',
        paymentExpiry: { gte: new Date() }  // Still active
      },
      include: {
        user: { 
          select: { 
            name: true, 
            phone: true 
          } 
        }
      }
    });

    if (paymentHolds) {
      console.log('⏳ PAYMENT HOLD DETECTED:', {
        user: paymentHolds.user.name,
        expires: paymentHolds.paymentExpiry
      });
      
      return res.status(409).json({
        success: false,
        error: 'Payment in progress',
        message: `User "${paymentHolds.user.name}" (${paymentHolds.user.phone?.slice(-4) || 'xxxx'}) is paying now. Hold expires: ${paymentHolds.paymentExpiry.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}. Block after?`,
        holdDetails: {
          userName: paymentHolds.user.name,
          phone: paymentHolds.user.phone,
          expires: paymentHolds.paymentExpiry.toISOString()
        },
        canRetry: true,
        slotTime: `${slot.date.toISOString().split('T')[0]} ${slot.time}`
      });
    }

    // 🔥 Normal block (no holds) - Atomic update
    const updatedSlot = await prisma.slot.update({
      where: { 
        id: slotId,
        clinicId  // Double-check ownership
      },
      data: {
        isBlocked: true,
        blockedReason: reason,
        blockedBy: userId,
        blockedAt: new Date(),
      },
      include: {
        doctor: { 
          select: { 
            name: true 
          } 
        },
      },
    });

    console.log('✅ SLOT BLOCKED:', {
      slotId,
      doctor: updatedSlot.doctor?.name,
      time: updatedSlot.time,
      reason
    });

    // 🔥 AUDIT LOG (full details)
    await logAudit({
      userId,
      clinicId,
      action: 'BLOCK_SLOT',
      entity: 'Slot',
      entityId: updatedSlot.id,
      details: {
        doctorId: updatedSlot.doctorId,
        doctorName: updatedSlot.doctor?.name,
        date: updatedSlot.date.toISOString().split('T')[0],
        time: updatedSlot.time,
        newStatus: 'BLOCKED',
        reason,
        wasPaymentHold: false  // For audit
      },
      req,
    });

    res.json({
      success: true,
      message: `Slot blocked: ${updatedSlot.doctor?.name || 'Doctor'} - ${updatedSlot.time}`,
      slot: {
        id: updatedSlot.id,
        time: updatedSlot.time,
        doctorName: updatedSlot.doctor?.name,
        date: updatedSlot.date.toISOString().split('T')[0],
        isBlocked: true,
        blockedReason: reason,
        blockedAt: updatedSlot.blockedAt.toISOString()
      },
    });

  } catch (error) {
    console.error('🚨 Block Slot FULL ERROR:', {
      message: error.message,
      code: error.code,
      meta: error.meta,
      slotId: req.params.slotId
    });

    if (error.code === 'P2025') {
      return res.status(404).json({ 
        error: 'Slot not found or access denied' 
      });
    }
    
    if (error.code === 'P2003') {
      return res.status(400).json({ 
        error: 'Invalid slot ownership' 
      });
    }

    res.status(500).json({ 
      error: 'Failed to block slot',
      debug: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};



export const unblockSlot = async (req, res) => {
  try {
    const { slotId } = req.params;
    const { clinicId, userId } = req.user;

    console.log('🟢 UNBLOCKING SLOT:', { slotId, clinicId });

    const slot = await prisma.slot.update({
      where: {
        id: slotId,
        clinicId,
      },
      data: {
        isBlocked: false,
        blockedReason: null,
        blockedBy: null,
        blockedAt: null,
      },
      include: {
        doctor: { select: { name: true } },
      },
    });

    // 🔥 AUDIT LOG
    await logAudit({
      userId,
      clinicId,
      action: 'UNBLOCK_SLOT',
      entity: 'Slot',
      entityId: slot.id,
      details: {
        doctorId: slot.doctorId,
        doctorName: slot.doctor?.name,
        date: slot.date,
        time: slot.time,
        newStatus: 'UNBLOCKED',
      },
      req,
    });

    res.json({
      success: true,
      message: `Slot unblocked for ${slot.doctor.name} - ${slot.time}`,
      slot: {
        id: slot.id,
        time: slot.time,
        doctorName: slot.doctor.name,
        isBlocked: false,
      },
    });
  } catch (error) {
    console.error('Unblock Slot Error:', error);
    if (error.code === 'P2025') {
      return res.status(404).json({ error: 'Slot not found or not authorized' });
    }
    res.status(500).json({ error: 'Failed to unblock slot' });
  }
};
