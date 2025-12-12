import prisma from '../prisma.js';
// ✅ Import Logger
import { logAudit } from '../utils/audit.js';

// ----------------------------------------------------------------
// 1. CREATE REVIEW
// ----------------------------------------------------------------
export const createReview = async (req, res) => {
  try {
    const userId = req.user.id || req.user.userId;
    const { appointmentId, rating, comment } = req.body;

    // Validate Input
    if (!appointmentId || !rating) {
      return res.status(400).json({ error: "Appointment ID and Rating are required" });
    }
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Rating must be between 1 and 5" });
    }

    // Find Appointment (Must be COMPLETED and NOT DELETED)
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: { 
        review: true,
        doctor: { select: { name: true } } 
      } 
    });

    if (!appointment || appointment.deletedAt) return res.status(404).json({ error: "Appointment not found" });
    
    if (appointment.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    if (appointment.status !== 'COMPLETED') {
      return res.status(400).json({ error: "You can only review completed appointments." });
    }

    if (appointment.review) {
      // Check if previous review was soft-deleted? Usually strictly 1 review per appointment.
      // If deleted, maybe allow re-review or restore? For now, blocking duplicates.
      if (!appointment.review.deletedAt) {
          return res.status(409).json({ error: "You have already reviewed this appointment." });
      }
    }

    // Create Review
    const review = await prisma.review.create({
      data: {
        userId,
        doctorId: appointment.doctorId,
        appointmentId,
        rating,
        comment
      }
    });

    // ✅ LOG AUDIT
    await logAudit({
      userId,
      clinicId: appointment.clinicId,
      action: 'CREATE_REVIEW',
      entity: 'Review',
      entityId: review.id,
      details: {
        doctorName: appointment.doctor?.name,
        rating,
        hasComment: !!comment
      },
      req
    });

    res.status(201).json({ message: "Review submitted successfully", review });

  } catch (error) {
    console.error("Create Review Error:", error);
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 2. GET REVIEWS (Filtered)
// ----------------------------------------------------------------
export const getDoctorReviews = async (req, res) => {
  try {
    const { doctorId } = req.params;

    const reviews = await prisma.review.findMany({
      where: { 
        doctorId,
        deletedAt: null // ✅ HIDE DELETED REVIEWS
      },
      include: {
        user: { select: { name: true, avatar: true } }
      },
      orderBy: { createdAt: 'desc' }
    });

    // Calculate Average
    const total = reviews.reduce((sum, r) => sum + r.rating, 0);
    const average = reviews.length > 0 ? (total / reviews.length).toFixed(1) : 0;

    res.json({ average, count: reviews.length, reviews });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ----------------------------------------------------------------
// 3. DELETE REVIEW (Soft Delete - Admin Only)
// ----------------------------------------------------------------
export const deleteReview = async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id || req.user.userId; // Admin ID

    // Check review existence
    const review = await prisma.review.findUnique({
      where: { id },
      include: { appointment: true }
    });

    if (!review) return res.status(404).json({ error: "Review not found" });

    // ✅ Soft Delete
    await prisma.review.update({
      where: { id },
      data: { deletedAt: new Date() }
    });

    // Log it
    await logAudit({
        userId,
        clinicId: review.appointment?.clinicId,
        action: 'DELETE_REVIEW',
        entity: 'Review',
        entityId: id,
        details: { reason: "Admin removed review" },
        req
    });

    res.json({ message: "Review removed successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
