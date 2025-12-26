import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js'; // ✅ Now we actually use this!

// 1. CREATE (Add new speciality)
export const createSpeciality = async (req, res) => {
  try {
    const { name, description } = req.body;
    const adminId = req.user.id; 

    const existing = await prisma.speciality.findUnique({
      where: { name: name },
    });

    if (existing) {
      return res.status(400).json({ message: "Speciality already exists" });
    }

    const newSpeciality = await prisma.speciality.create({
      data: {
        name,
        description,
        isActive: true,
      },
    });

    // ✅ Use the helper function
    await logAudit({
      action: "CREATE_SPECIALITY",
      entityId: newSpeciality.id,
      entityType: "Speciality",
      performedBy: adminId,
      details: `Created speciality: ${name}`,
    });

    res.status(201).json(newSpeciality);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error creating speciality" });
  }
};

// 2. READ ALL
export const getAllSpecialities = async (req, res) => {
  try {
    const { active } = req.query;
    // If active=true is passed, filter. Otherwise show all.
    const whereCondition = active === 'true' ? { isActive: true } : {};

    const specialities = await prisma.speciality.findMany({
      where: whereCondition,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { doctors: true } } // Shows usage count
      }
    });

    res.json(specialities);
  } catch (error) {
    res.status(500).json({ message: "Error fetching specialities" });
  }
};

// 3. READ ONE
export const getSpecialityById = async (req, res) => {
  try {
    const { id } = req.params;
    const speciality = await prisma.speciality.findUnique({ where: { id } });

    if (!speciality) return res.status(404).json({ message: "Speciality not found" });

    res.json(speciality);
  } catch (error) {
    res.status(500).json({ message: "Error fetching speciality" });
  }
};

// 4. UPDATE
export const updateSpeciality = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, isActive } = req.body;
    const adminId = req.user.id;

    // 1. Fetch old data FIRST
    const oldSpeciality = await prisma.speciality.findUnique({ where: { id } });

    // 🛑 CRITICAL FIX: Check if it exists before proceeding
    if (!oldSpeciality) {
      return res.status(404).json({ message: "Speciality not found" });
    }

    // 2. Update
    const updatedSpeciality = await prisma.speciality.update({
      where: { id },
      data: { name, description, isActive },
    });

    // 3. Prepare Audit Details
    const changes = {};
    if (name && name !== oldSpeciality.name) changes.name = `${oldSpeciality.name} -> ${name}`;
    if (isActive !== undefined && isActive !== oldSpeciality.isActive) changes.isActive = `${oldSpeciality.isActive} -> ${isActive}`;

    // ✅ Use the helper function
    await logAudit({
      action: "UPDATE_SPECIALITY",
      entityId: id,
      entityType: "Speciality",
      performedBy: adminId,
      details: Object.keys(changes).length > 0 ? JSON.stringify(changes) : "Updated description/metadata",
    });

    res.json(updatedSpeciality);
  } catch (error) {
    res.status(500).json({ message: "Error updating speciality" });
  }
};

// 5. DELETE
export const deleteSpeciality = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user.id; // Get Admin ID for audit log

    // 1. SAFETY CHECK: Is it being used?
    const usageCheck = await prisma.doctor.findFirst({ 
      where: { specialityId: id } 
    });

    if (usageCheck) {
      // BLOCK DELETION if linked to doctors
      return res.status(400).json({ 
        message: "Cannot delete: Doctors are linked to this speciality. Please deactivate it (Update -> Uncheck Active) instead." 
      });
    }

    // 2. Fetch details BEFORE delete (so we can log the name)
    const specToDelete = await prisma.speciality.findUnique({ 
      where: { id } 
    });

    if (!specToDelete) {
      return res.status(404).json({ message: "Speciality not found" });
    }

    // 3. HARD DELETE (Safe because we checked usage above)
    await prisma.speciality.delete({ 
      where: { id } 
    });

    // 4. AUDIT LOG
    await logAudit({
      action: "DELETE_SPECIALITY",
      entityId: id,
      entityType: "Speciality",
      performedBy: adminId,
      details: `Deleted speciality: ${specToDelete.name}`,
    });

    res.json({ message: "Speciality deleted successfully" });
  } catch (error) {
    console.error("Delete Speciality Error:", error);
    res.status(500).json({ message: "Error deleting speciality", error: error.message });
  }
};
