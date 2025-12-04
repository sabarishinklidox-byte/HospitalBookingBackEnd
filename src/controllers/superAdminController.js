import prisma from '../prisma.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

// -------------------------
// DEFAULT SUPER ADMIN
// -------------------------
const DEFAULT_SUPER_ADMIN = {
  email: 'sabarisabarish847@gmail.com',
  password: 'sabarish!12',
  name: 'Super Admin'
};

// -------------------------
// CREATE DEFAULT SUPER ADMIN
// -------------------------
export const createDefaultSuperAdmin = async (req, res) => {
  try {
    const existingAdmin = await prisma.user.findUnique({
      where: { email: DEFAULT_SUPER_ADMIN.email }
    });

    if (!existingAdmin) {
      const hashedPassword = await bcrypt.hash(DEFAULT_SUPER_ADMIN.password, 12);

      await prisma.user.create({
        data: {
          id: uuidv4(),
          email: DEFAULT_SUPER_ADMIN.email,
          password: hashedPassword,
          name: DEFAULT_SUPER_ADMIN.name,
          role: 'SUPER_ADMIN'
        }
      });

      return res.json({
        message: '✅ Default Super Admin created!',
        credentials: {
          email: DEFAULT_SUPER_ADMIN.email,
          password: DEFAULT_SUPER_ADMIN.password
        }
      });
    }

    return res.json({ message: 'Super Admin already exists' });
  } catch (error) {
    console.error('Super Admin Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// SUPER ADMIN LOGIN
export const superAdminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const validPassword = await bcrypt.compare(password, user.password);
    if (!validPassword) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      {
        userId: user.id,
        role: user.role,
        clinicId: user.clinicId || null, // ← add this
      },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        clinicId: user.clinicId || null, // ← and this
      },
    });
  } catch (error) {
    console.error('Login Error:', error);
    return res.status(500).json({ error: error.message });
  }
};



// -------------------------
// CREATE CLINIC
// -------------------------
export const createClinic = async (req, res) => {
  try {
    const {
      name,
      address,
      city,
      pincode,
      accountNumber,
      ifscCode,
      bankName,
      timings,
      details
    } = req.body;

    if (!name || !address || !city || !pincode) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const slug = name.toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    const clinic = await prisma.clinic.create({
      data: {
        slug,
        name,
        address,
        city,
        pincode,
        accountNumber,
        ifscCode,
        bankName,
        timings,
        details: details || ''
      }
    });

    return res.status(201).json(clinic);
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Clinic slug already exists' });
    }
    console.error('Clinic Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// GET ALL CLINICS
// -------------------------
export const getClinics = async (req, res) => {
  try {
    const clinics = await prisma.clinic.findMany({
      include: {
        admins: true,
        doctors: { where: { isActive: true } },
        gateways: true
      }
    });

    return res.json(clinics);
  } catch (error) {
    console.error('Get Clinics Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// UPDATE CLINIC
// -------------------------
export const updateClinic = async (req, res) => {
  try {
    const { id } = req.params;

    const clinic = await prisma.clinic.update({
      where: { id },
      data: req.body
    });

    return res.json(clinic);
  } catch (error) {
    console.error('Update Clinic Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// DELETE CLINIC
// -------------------------
export const deleteClinic = async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.clinic.delete({
      where: { id }
    });

    return res.json({ message: 'Clinic deleted' });
  } catch (error) {
    console.error('Delete Clinic Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// CREATE CLINIC ADMIN
// -------------------------
export const createClinicAdmin = async (req, res) => {
  try {
    const { email, name, phone, clinicId, password } = req.body;

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    const admin = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        name,
        phone,
        role: 'ADMIN',
        clinicId
      }
    });

    return res.status(201).json({
      message: 'Clinic Admin created',
      credentials: {
        email: admin.email,
        password
      },
      admin
    });
  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Create Admin Error:', error);
    return res.status(500).json({ error: error.message });
  }
};

// -------------------------
// GET ALL ADMINS
// -------------------------
export const getClinicAdmins = async (req, res) => {
  try {
    const admins = await prisma.user.findMany({
      where: { role: 'ADMIN' },
      include: { clinic: true }
    });

    return res.json(admins);
  } catch (error) {
    console.error('Get Admins Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
// -------------------------
// UPDATE CLINIC ADMIN
// -------------------------
export const updateClinicAdmin = async (req, res) => {
  try {
    const { id } = req.params;
    const { email, name, phone, clinicId, password } = req.body;

    const updateData = { email, name, phone, clinicId };

    // If password provided → hash and update
    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      updateData.password = await bcrypt.hash(password, 12);
    }

    const admin = await prisma.user.update({
      where: { id },
      data: updateData
    });

    return res.json({
      message: 'Clinic Admin updated successfully',
      admin
    });

  } catch (error) {
    if (error.code === 'P2002') {
      return res.status(400).json({ error: 'Email already exists' });
    }
    console.error('Update Admin Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
// -------------------------
// DELETE CLINIC ADMIN
// -------------------------
export const deleteClinicAdmin = async (req, res) => {
  try {
    const { id } = req.params;

    await prisma.user.delete({
      where: { id }
    });

    return res.json({ message: 'Clinic Admin deleted successfully' });

  } catch (error) {
    console.error('Delete Admin Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
export const getClinicById = async (req, res) => {
  try {
    const { id } = req.params;
    const clinic = await prisma.clinic.findUnique({
      where: { id },
      include: { admins: true, doctors: true, gateways: true }
    });
    if (!clinic) {
      return res.status(404).json({ error: 'Clinic not found' });
    }
    return res.json(clinic);
  } catch (error) {
    console.error('Get Clinic Error:', error);
    return res.status(500).json({ error: error.message });
  }
};
