import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

// CREATE doctor with unique slug and linked user credentials
export const createDoctor = async (req, res) => {
  try {
    const { clinicId } = req.user;

    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    const { name, email, phone, speciality, experience, avatar, password } =
      req.body;

    if (!name || !email || !speciality || !experience || !password) {
      return res.status(400).json({
        error:
          'name, email, speciality, experience and password are required'
      });
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already in use' });
    }

    // Generate base slug
    const baseSlug = name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    // Check existing slugs starting with baseSlug
    const existingSlugs = await prisma.doctor.findMany({
      where: { slug: { startsWith: baseSlug } },
      select: { slug: true }
    });

    // Make slug unique if needed
    let slug = baseSlug;
    if (existingSlugs.length > 0) {
      slug = `${baseSlug}-${existingSlugs.length + 1}`;
    }

    // Create doctor profile
    const doctor = await prisma.doctor.create({
      data: {
        slug,
        name,
        avatar: avatar || null,
        speciality,
        phone: phone || '',
        experience: Number(experience),
        clinicId,
        isActive: true
      }
    });

    // Hash password for doctor user login
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user login linked to doctor
    const user = await prisma.user.create({
      data: {
        id: uuidv4(),
        email,
        password: hashedPassword,
        name,
        phone: phone || '',
        role: 'DOCTOR',
        doctorId: doctor.id
      }
    });

    return res.status(201).json({ doctor, user });
  } catch (error) {
    console.error('Create Doctor Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// GET doctors of clinic
// GET doctors of clinic (only active)
// GET doctors of clinic (all, active + inactive)
export const getDoctors = async (req, res) => {
  try {
    const { clinicId } = req.user;

    const doctors = await prisma.doctor.findMany({
      where: { clinicId },
      orderBy: { name: 'asc' }
    });

    return res.json(doctors);
  } catch (error) {
    console.error('Get Doctors Error:', error);
    return res.status(500).json({ error: error.message });
  }
};


// UPDATE doctor and linked user info
export const updateDoctor = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { id } = req.params;
    const { name, email, phone, speciality, experience, avatar, password } =
      req.body;

    // Ensure doctor belongs to this clinic
    const existingDoctor = await prisma.doctor.findFirst({
      where: { id, clinicId }
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
        experience:
          experience !== undefined ? Number(experience) : existingDoctor.experience
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
        return res
          .status(400)
          .json({ error: 'Password must be at least 6 characters' });
      }
      userData.password = await bcrypt.hash(password, 12);
    }

    const userUpdated = await prisma.user.update({
      where: { id: user.id },
      data: userData
    });

    return res.json({ doctor: doctorUpdated, user: userUpdated });
  } catch (error) {
    console.error('Update Doctor Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// TOGGLE doctor active/inactive
export const toggleDoctorActive = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { id } = req.params;

    const existing = await prisma.doctor.findFirst({ where: { id, clinicId } });

    if (!existing) {
      return res.status(404).json({ error: 'Doctor not found in this clinic' });
    }

    const updated = await prisma.doctor.update({
      where: { id },
      data: { isActive: !existing.isActive }
    });

    return res.json({ message: 'Doctor status updated', doctor: updated });
  } catch (error) {
    console.error('Toggle Doctor Active Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
