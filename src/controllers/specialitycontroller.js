import prisma from '../prisma.js';
import { logAudit } from '../utils/audit.js';

// 1. CREATE (Add new speciality)
export const createSpeciality = async (req, res) => {
  try {
    const { name, description } = req.body;
    const adminId = req.user.id;
    // Assuming auth middleware provides clinicId. 
    // If SuperAdmin, clinicId might be null.
    const clinicId = req.user.clinicId || null; 

    // Check if exists FOR THIS CLINIC (or Global if clinicId is null)
    const existing = await prisma.speciality.findFirst({
      where: { 
        name: name,
        clinicId: clinicId // Check for dupes in same scope
      },
    });

    if (existing) {
      return res.status(400).json({ message: "Speciality already exists in your list" });
    }

    const newSpeciality = await prisma.speciality.create({
      data: {
        name,
        description,
        isActive: true,
        clinicId: clinicId // Tag with clinic ID
      },
    });

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
    // P2002 is Prisma unique constraint error
    if (error.code === 'P2002') {
       return res.status(400).json({ message: "Speciality name already exists." });
    }
    res.status(500).json({ message: "Error creating speciality" });
  }
};

// 2. READ ALL (Global + My Clinic)
export const getAllSpecialities = async (req, res) => {
  try {
    const { active } = req.query;
    const clinicId = req.user?.clinicId || null;

    const whereCondition = {
      AND: [
        active === 'true' ? { isActive: true } : {},
        {
          OR: [
            { clinicId: null },          // Global System Specialities
            clinicId ? { clinicId } : {} // My Private Specialities
          ]
        }
      ]
    };

    const specialities = await prisma.speciality.findMany({
      where: whereCondition,
      orderBy: { name: 'asc' },
      include: {
        _count: { select: { doctors: true } } 
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
    const clinicId = req.user?.clinicId || null;

    const speciality = await prisma.speciality.findUnique({ where: { id } });

    if (!speciality) return res.status(404).json({ message: "Speciality not found" });

    // Security Check: Don't show if it belongs to another clinic
    if (speciality.clinicId && speciality.clinicId !== clinicId) {
        return res.status(403).json({ message: "Access denied" });
    }

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
    const clinicId = req.user.clinicId || null;

    const oldSpeciality = await prisma.speciality.findUnique({ where: { id } });

    if (!oldSpeciality) {
      return res.status(404).json({ message: "Speciality not found" });
    }

    // 🔒 Security: Only allow update if:
    // 1. It belongs to my clinic (oldSpeciality.clinicId === myClinicId)
    // 2. OR I am a SuperAdmin (no clinicId) and it's a Global speciality (clinicId is null)
    const isOwner = oldSpeciality.clinicId === clinicId;
    // (If you have a role based system, checking 'role === SUPER_ADMIN' is better for globals)
    
    if (!isOwner && oldSpeciality.clinicId !== null) { 
       return res.status(403).json({ message: "You cannot edit another clinic's speciality" });
    }
    // Optional: Prevent Clinic Admin from editing Global Specialities
    if (clinicId && oldSpeciality.clinicId === null) {
       return res.status(403).json({ message: "You cannot edit System Default specialities" });
    }

    const updatedSpeciality = await prisma.speciality.update({
      where: { id },
      data: { name, description, isActive },
    });

    const changes = {};
    if (name && name !== oldSpeciality.name) changes.name = `${oldSpeciality.name} -> ${name}`;
    if (isActive !== undefined && isActive !== oldSpeciality.isActive) changes.isActive = `${oldSpeciality.isActive} -> ${isActive}`;

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
    const adminId = req.user.id;
    const clinicId = req.user.clinicId || null;

    // 1. Fetch details first
    const specToDelete = await prisma.speciality.findUnique({ where: { id } });

    if (!specToDelete) {
      return res.status(404).json({ message: "Speciality not found" });
    }

    // 🔒 Security: Prevent deleting Global or Other Clinic items
    if (clinicId && specToDelete.clinicId === null) {
        return res.status(403).json({ message: "Cannot delete System Default speciality" });
    }
    if (specToDelete.clinicId && specToDelete.clinicId !== clinicId) {
        return res.status(403).json({ message: "Access denied" });
    }

    // 2. Usage Check
    const usageCheck = await prisma.doctor.findFirst({ 
      where: { specialityId: id } 
    });

    if (usageCheck) {
      return res.status(400).json({ 
        message: "Cannot delete: Doctors are linked. Deactivate it instead." 
      });
    }

    // 3. HARD DELETE
    await prisma.speciality.delete({ 
      where: { id } 
    });

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
