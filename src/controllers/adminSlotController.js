import prisma from '../prisma.js';

// CREATE Slot POST /api/admin/slots
export const createSlot = async (req, res) => {
  try {
    const { clinicId } = req.user;
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    const { doctorId, date, time, duration, type, price } = req.body;

    if (!doctorId || !date || !time || !duration || !type) {
      return res.status(400).json({
        error: 'doctorId, date, time, duration, type are required'
      });
    }

    // ensure doctor belongs to this clinic
    const doctor = await prisma.doctor.findFirst({
      where: { id: doctorId, clinicId }
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
        type,
        price: type === 'PAID' ? Number(price || 0) : 0
      }
    });

    return res.status(201).json(slot);
  } catch (error) {
    console.error('Create Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// LIST slots for a doctor
export const getSlots = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { doctorId, date } = req.query;

    if (!doctorId) {
      return res.status(400).json({ error: 'doctorId is required' });
    }

    const where = { clinicId, doctorId };

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

// UPDATE Slot
export const updateSlot = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { id } = req.params;
    const { date, time, duration, type, price } = req.body;

    const existing = await prisma.slot.findFirst({
      where: { id, clinicId }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Slot not found in this clinic' });
    }

    const updated = await prisma.slot.update({
      where: { id },
      data: {
        date: date ? new Date(date) : existing.date,
        time: time ?? existing.time,
        duration:
          duration !== undefined ? Number(duration) : existing.duration,
        type: type ?? existing.type,
        price:
          type === 'PAID'
            ? Number(price || existing.price)
            : type === 'FREE'
            ? 0
            : existing.price
      }
    });

    return res.json(updated);
  } catch (error) {
    console.error('Update Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// DELETE Slot
export const deleteSlot = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { id } = req.params;

    const existing = await prisma.slot.findFirst({
      where: { id, clinicId }
    });

    if (!existing) {
      return res.status(404).json({ error: 'Slot not found in this clinic' });
    }

    await prisma.slot.delete({
      where: { id }
    });

    return res.json({ message: 'Slot deleted' });
  } catch (error) {
    console.error('Delete Slot Error:', error);
    return res.status(500).json({ error: error.message });
  }
};


// POST /api/admin/slots/bulk



export const createBulkSlots = async (req, res) => {
  try {
    const { 
      doctorId,
      startDate,
      endDate,
      startTime,  // e.g., "09:00"
      duration,   // e.g., 30
      days
    } = req.body;

    if (!doctorId || !startDate || !endDate || !startTime || !duration) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const doctor = await prisma.doctor.findUnique({
      where: { id: doctorId },
      select: { clinicId: true }
    });

    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const slotsToCreate = [];
    let currentDate = new Date(startDate);
    const finalDate = new Date(endDate);

    // Loop through dates
    while (currentDate <= finalDate) {
      
      // Check if this day matches selected days (Mon, Tue, etc.)
      if (days.includes(currentDate.getDay())) {
        
        // CREATE ONLY ONE SLOT AT startTime (not a range)
        slotsToCreate.push({
          doctorId: doctorId,
          clinicId: doctor.clinicId,
          date: new Date(currentDate),
          time: startTime, // Just this one time
          duration: parseInt(duration),
          type: "PAID",
          price: 500
        });
      }
      
      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }

    if (slotsToCreate.length === 0) {
      return res.status(400).json({ error: "No slots generated." });
    }

    // Save one by one (handles duplicates)
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

    res.json({ 
      message: `Created: ${successCount}, Skipped: ${duplicateCount}`, 
      count: successCount 
    });

  } catch (error) {
    console.error("Bulk Create Error:", error);
    res.status(500).json({ error: error.message });
  }
};