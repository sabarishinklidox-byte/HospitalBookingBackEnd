import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';

// ----------------------------------------------------------------
// CREATE SINGLE SLOT
// ----------------------------------------------------------------
export const createSlot = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    if (!clinicId) return res.status(400).json({ error: 'Clinic ID missing in token' });

    // ✅ Get paymentMode instead of type
    const { doctorId, date, time, duration, price, paymentMode } = req.body; 

    if (!doctorId || !date || !time || !duration) {
      return res.status(400).json({
        error: 'doctorId, date, time, duration are required'
      });
    }

    // Ensure doctor belongs to this clinic AND is not deleted
    const doctor = await prisma.doctor.findFirst({
      where: { 
        id: doctorId, 
        clinicId,
        deletedAt: null 
      }
    });

    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found in this clinic' });
    }

    const slot = await prisma.slot.create({
      data: {
        doctorId,
        clinicId,
        date: new Date(date),
        time,
        duration: Number(duration),
        // ✅ Handle paymentMode and Price
        paymentMode: paymentMode || 'ONLINE', // Default if missing
        price: paymentMode === 'FREE' ? 0 : Number(price || 0),
        // Deprecated 'type' field handling if still in schema
        type: paymentMode === 'FREE' ? 'FREE' : 'PAID', 
      }
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
        paymentMode // Log this
      },
      req
    });

    return res.status(201).json(slot);
  } catch (error) {
    console.error('Create Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// LIST SLOTS
// ----------------------------------------------------------------
export const getSlots = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { doctorId, date } = req.query;

    if (!doctorId) return res.status(400).json({ error: 'doctorId is required' });

    const where = { 
      clinicId, 
      doctorId,
      deletedAt: null
    };

    if (date) {
      const d = new Date(date);
      const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
      where.date = { gte: startOfDay, lt: endOfDay };
    }

    const slots = await prisma.slot.findMany({
      where,
      orderBy: [{ date: 'asc' }, { time: 'asc' }]
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
    // ✅ Get paymentMode
    const { date, time, duration, price, paymentMode } = req.body;

    const existing = await prisma.slot.findFirst({
      where: { id, clinicId, deletedAt: null }
    });

    if (!existing) return res.status(404).json({ error: 'Slot not found' });

    const updated = await prisma.slot.update({
      where: { id },
      data: {
        date: date ? new Date(date) : existing.date,
        time: time ?? existing.time,
        duration: duration !== undefined ? Number(duration) : existing.duration,
        paymentMode: paymentMode ?? existing.paymentMode,
        price: paymentMode === 'FREE' ? 0 : (price !== undefined ? Number(price) : existing.price),
        // Sync deprecated type field
        type: (paymentMode === 'FREE' || existing.paymentMode === 'FREE') ? 'FREE' : 'PAID'
      }
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
        newMode: updated.paymentMode
      },
      req
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
      where: { id, clinicId },
      include: { doctor: { select: { name: true } } }
    });

    if (!existing) return res.status(404).json({ error: 'Slot not found' });

    await prisma.slot.update({
      where: { id },
      data: { deletedAt: new Date() }
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
        time: existing.time
      },
      req
    });

    return res.json({ message: 'Slot deleted (soft)' });
  } catch (error) {
    console.error('Delete Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// BULK CREATE
// ----------------------------------------------------------------
export const createBulkSlots = async (req, res) => {
  try {
    const { clinicId, userId } = req.user; 
    // ✅ Get paymentMode
    const { 
      doctorId,
      startDate,
      endDate,
      startTime,  
      duration, 
      days,
      paymentMode 
    } = req.body;

    if (!doctorId || !startDate || !endDate || !startTime || !duration) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinicId: true, name: true, deletedAt: true }
    });

    if (!doctor || doctor.deletedAt) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const selectedDays = days.map(d => parseInt(d));

    const slotsToCreate = [];
    
    let currentDate = new Date(startDate);
    currentDate.setHours(12, 0, 0, 0); 

    const finalDate = new Date(endDate);
    finalDate.setHours(12, 0, 0, 0);

    // ✅ Determine Price Logic
    // If ONLINE or OFFLINE, price is 500 (or whatever logic you want). If FREE, 0.
    // Ideally, frontend should send 'price' if it's customizable. 
    // Here we assume 500 default for paid slots.
    const slotPrice = paymentMode === 'FREE' ? 0 : 500; 

    while (currentDate <= finalDate) {
      const dayIndex = currentDate.getDay(); 

      if (selectedDays.includes(dayIndex)) {
        slotsToCreate.push({
          doctorId: doctorId,
          clinicId: doctor.clinicId,
          date: new Date(currentDate), 
          time: startTime, 
          duration: parseInt(duration),
          // ✅ Use paymentMode
          paymentMode: paymentMode || 'ONLINE',
          price: slotPrice,
          type: paymentMode === 'FREE' ? 'FREE' : 'PAID' // Deprecated fallback
        });
      }
      
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (slotsToCreate.length === 0) {
      return res.status(400).json({ error: "No slots generated." });
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
          console.error(`Failed to create slot:`, error.message);
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
          paymentMode // Log this
        },
        req
      });
    }

    res.json({ 
      message: `Created: ${successCount}, Skipped: ${duplicateCount}`, 
      count: successCount 
    });

  } catch (error) {
    console.error("Bulk Create Error:", error);
    res.status(500).json({ error: error.message });
  }
};
