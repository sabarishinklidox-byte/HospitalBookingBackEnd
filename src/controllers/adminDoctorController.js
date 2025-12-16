import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
// ✅ Import Logger
import { logAudit } from '../utils/audit.js'; 

// ----------------------------------------------------------------
// CREATE DOCTOR
// src/controllers/doctorController.js


// helper to get plan
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  return clinic?.subscription?.plan || null; // Plan has maxDoctors etc. [web:1186]
}

// ----------------------------------------------------------------
// CREATE DOCTOR
// ----------------------------------------------------------------
export const createDoctor = async (req, res) => {
  try {
    console.log('CREATE_DOCTOR file:', req.file);
    console.log('CREATE_DOCTOR body:', req.body);

    const { clinicId, userId } = req.user;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // ✅ Enforce plan doctor limit
    const plan = await getClinicPlan(clinicId);
    if (!plan) {
      return res
        .status(400)
        .json({ error: 'No active subscription plan for this clinic.' });
    }

    const doctorCount = await prisma.doctor.count({
      where: { clinicId, deletedAt: null },
    });

    if (doctorCount >= plan.maxDoctors) {
      return res.status(403).json({
        error: `Doctor limit reached for your current plan (max ${plan.maxDoctors}).`,
      });
    }

    const { name, email, phone, speciality, experience, password } = req.body;

    if (!name || !email || !speciality || !experience || !password) {
      return res.status(400).json({
        error: 'name, email, speciality, experience and password are required',
      });
    }

    let avatar = null;
    if (req.file) {
      avatar = `/uploads/${req.file.filename}`;
    } else if (req.body.avatar) {
      avatar = req.body.avatar;
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      if (existingUser.deletedAt) {
        return res
          .status(400)
          .json({ error: 'Email belongs to a deleted account.' });
      }
      return res.status(400).json({ error: 'Email already in use' });
    }

    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const existingSlugs = await prisma.doctor.findMany({
      where: { slug: { startsWith: baseSlug } },
      select: { slug: true },
    });

    let slug = baseSlug;
    if (existingSlugs.length > 0) {
      slug = `${baseSlug}-${existingSlugs.length + 1}`;
    }

    const doctor = await prisma.doctor.create({
      data: {
        slug,
        name,
        avatar,
        speciality,
        phone: phone || '',
        experience: Number(experience),
        clinicId,
        isActive: true,
      },
    });

    const hashedPassword = await bcrypt.hash(password, 12);

    const user = await prisma.user.create({
      data: {
        id: uuidv4(),
        email,
        password: hashedPassword,
        name,
        phone: phone || '',
        role: 'DOCTOR',
        doctorId: doctor.id,
      },
    });

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'CREATE_DOCTOR',
      entity: 'Doctor',
      entityId: doctor.id,
      details: {
        name: doctor.name,
        speciality: doctor.speciality,
        email: user.email,
      },
      req,
    });

    return res.status(201).json({ doctor, user });
  } catch (error) {
    console.error('Create Doctor Error:', error);
    return res.status(500).json({ error: error.message });
  }
};


// ----------------------------------------------------------------
// GET DOCTORS (Active Only)
// ----------------------------------------------------------------
export const getDoctors = async (req, res) => {
  try {
    const { clinicId } = req.user;

    const doctors = await prisma.doctor.findMany({
      where: { 
        clinicId,
        deletedAt: null // ✅ Filter deleted doctors
      },
      orderBy: { name: 'asc' }
    });

    return res.json(doctors);
  } catch (error) {
    console.error('Get Doctors Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// UPDATE DOCTOR
// ----------------------------------------------------------------
export const updateDoctor = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;
    const { name, email, phone, speciality, experience, avatar, password } = req.body;

    // Ensure doctor belongs to this clinic AND NOT DELETED
    const existingDoctor = await prisma.doctor.findFirst({
      where: { 
        id, 
        clinicId,
        deletedAt: null 
      }
    });

    if (!existingDoctor) {
      return res.status(404).json({ error: 'Doctor not found in this clinic' });
    }

    // Update doctor profile
    const doctorUpdated = await prisma.doctor.update({
      where: { id },
      data: {
        name: name ?? existingDoctor.name,
        avatar: avatar !== undefined ? avatar : existingDoctor.avatar,
        speciality: speciality ?? existingDoctor.speciality,
        phone: phone ?? existingDoctor.phone,
        experience: experience !== undefined ? Number(experience) : existingDoctor.experience
      }
    });

    // Update linked user login
    const user = await prisma.user.findFirst({ where: { doctorId: id } });
    if (!user) {
      return res.status(404).json({ error: 'User login for doctor not found' });
    }

    const userData = {};
    if (email !== undefined && email !== user.email) {
      const emailExists = await prisma.user.findUnique({ where: { email } });
      if (emailExists) {
        return res.status(400).json({ error: 'Email already in use' });
      }
      userData.email = email;
    }
    if (phone !== undefined) {
      userData.phone = phone;
    }
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      userData.password = await bcrypt.hash(password, 12);
    }

    const userUpdated = await prisma.user.update({
      where: { id: user.id },
      data: userData
    });

    // ✅ LOG AUDIT
    const changes = {};
    if (name !== existingDoctor.name) changes.name = name;
    if (speciality !== existingDoctor.speciality) changes.speciality = speciality;
    if (email !== user.email) changes.email = email;
    if (password) changes.password = "Password Changed";

    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'UPDATE_DOCTOR',
      entity: 'Doctor',
      entityId: id,
      details: changes,
      req
    });

    return res.json({ doctor: doctorUpdated, user: userUpdated });
  } catch (error) {
    console.error('Update Doctor Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// TOGGLE DOCTOR ACTIVE
// ----------------------------------------------------------------
export const toggleDoctorActive = async (req, res) => {
  try {
    const { clinicId, userId } = req.user;
    const { id } = req.params;

    const existing = await prisma.doctor.findFirst({ 
        where: { id, clinicId, deletedAt: null } // ✅ Check deleted
    });

    if (!existing) {
      return res.status(404).json({ error: 'Doctor not found in this clinic' });
    }

    const updated = await prisma.doctor.update({
      where: { id },
      data: { isActive: !existing.isActive }
    });

    // ✅ LOG AUDIT
    await logAudit({
      userId: userId || req.user.userId,
      clinicId,
      action: 'TOGGLE_DOCTOR_STATUS',
      entity: 'Doctor',
      entityId: id,
      details: { 
        name: existing.name,
        previousStatus: existing.isActive ? 'Active' : 'Inactive',
        newStatus: updated.isActive ? 'Active' : 'Inactive'
      },
      req
    });

    return res.json({ message: 'Doctor status updated', doctor: updated });
  } catch (error) {
    console.error('Toggle Doctor Active Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// DELETE DOCTOR (Soft Delete)
// ----------------------------------------------------------------
export const deleteDoctor = async (req, res) => {
    try {
      const { clinicId, userId } = req.user;
      const { id } = req.params;
  
      const existing = await prisma.doctor.findFirst({ 
          where: { id, clinicId, deletedAt: null } 
      });
  
      if (!existing) {
        return res.status(404).json({ error: 'Doctor not found in this clinic' });
      }

      // 1. Soft Delete Doctor Profile
      await prisma.doctor.update({
        where: { id },
        data: { deletedAt: new Date(), isActive: false }
      });
  
      // 2. Soft Delete User Account (so they can't login)
      await prisma.user.updateMany({
        where: { doctorId: id },
        data: { deletedAt: new Date() }
      });
  
      // ✅ LOG AUDIT
      await logAudit({
        userId: userId || req.user.userId,
        clinicId,
        action: 'DELETE_DOCTOR',
        entity: 'Doctor',
        entityId: id,
        details: { name: existing.name },
        req
      });
  
      return res.json({ message: 'Doctor deleted successfully (soft)' });
    } catch (error) {
      console.error('Delete Doctor Error:', error);
      return res.status(500).json({ error: error.message });
    }
  };
