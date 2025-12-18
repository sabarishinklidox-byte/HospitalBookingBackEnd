import prisma from '../prisma.js';

export default function errorHandler(err, req, res, next) {
  // Prisma Known errors (has .code like P2002)
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2002") {
      return res.status(400).json({ error: "Already exists (duplicate value)." });
    }
    return res.status(400).json({ error: "Database request failed." });
  }

  // Prisma Validation errors (the long “Invalid prisma.xxx invocation”)
  if (err instanceof Prisma.PrismaClientValidationError) {
    return res.status(400).json({ error: "Invalid input. Please check required fields." });
  }

  // fallback
  return res.status(500).json({ error: "Internal server error." });
}
