import jwt from 'jsonwebtoken';

export const authMiddleware = (req, res, next) => {
const header = req.headers.authorization;
if (!header || !header.startsWith('Bearer ')) {
return res.status(401).json({ error: 'No token provided' });
}

const parts = header.split(' ');
const token = parts[1]; // ✅ JWT string


try {
const decoded = jwt.verify(token, process.env.JWT_SECRET);
// decoded: { userId, role, clinicId? }
req.user = decoded;
next();
} catch (err) {
return res.status(401).json({ error: 'Invalid or expired token' });
}
};
export const requireAdmin = (req, res, next) => {
if (!req.user || req.user.role !== 'ADMIN') {
return res.status(403).json({ error: 'Clinic Admin only' });
}
next();
};

// ONLY Super Admin
export const requireSuperAdmin = (req, res, next) => {
if (!req.user || req.user.role !== 'SUPER_ADMIN') {
return res.status(403).json({ error: 'Super Admin only' });
}
next();
};
export const requireDoctor = (req, res, next) => {
  if (!req.user || req.user.role !== 'DOCTOR') {
    return res.status(403).json({ error: 'Doctor only' });
  }
  next();
};
export const requireUser = (req, res, next) => {
  if (!req.user || req.user.role !== 'USER') {
    return res.status(403).json({ error: 'User only' });
  }
  next();
};
