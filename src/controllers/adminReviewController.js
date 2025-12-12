import prisma from '../prisma.js'; 

export const getClinicReviews = async (req, res) => {
  try {
    const { clinicId } = req.user;

    if (!clinicId) {
      return res.status(400).json({ error: "Clinic ID not found" });
    }

    const reviews = await prisma.review.findMany({
      where: {
        doctor: { clinicId }, // Filter by clinic
        deletedAt: null       // ✅ Show only active reviews
      },
      include: {
        user: { 
          select: { name: true, avatar: true, email: true } 
        },
        doctor: { 
          select: { name: true, speciality: true } 
        },
        appointment: {
          select: { id: true, createdAt: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    res.json(reviews);
  } catch (error) {
    console.error("Get Reviews Error:", error);
    res.status(500).json({ error: error.message });
  }
};
