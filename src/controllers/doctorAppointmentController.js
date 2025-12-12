import prisma from '../prisma.js';
// ✅ Import Logger
import { logAudit } from '../utils/audit.js';

// ----------------------------------------------------------------
// PATCH /api/doctor/appointments/:id/prescription
// ----------------------------------------------------------------
export const updatePrescription = async (req, res) => {
  try {
    // 1. Get Inputs
    const { userId, doctorId, clinicId } = req.user; 
    const { id } = req.params;          // Appointment ID
    const { prescription } = req.body;  // Text from Frontend

    // 2. Validation
    if (!prescription || !prescription.trim()) {
      return res.status(400).json({ error: "Prescription text cannot be empty" });
    }

    // 3. Find Appointment & Verify Ownership
    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: { 
        doctor: true,
        user: { select: { name: true } } 
      }
    });

    if (!appointment) {
      return res.status(404).json({ error: "Appointment not found" });
    }

    // ✅ SOFT DELETE CHECK
    if (appointment.deletedAt) {
      return res.status(404).json({ error: "Appointment has been deleted. Cannot update prescription." });
    }

    // Security Check
    if (appointment.doctorId !== doctorId) {
      return res.status(403).json({ error: "Unauthorized: This is not your appointment" });
    }

    // 4. Status Check
    const allowedStatuses = ['CONFIRMED', 'COMPLETED'];
    if (!allowedStatuses.includes(appointment.status)) {
      return res.status(400).json({ 
        error: "Prescriptions can only be added to Confirmed or Completed appointments." 
      });
    }

    // 5. Update Database
    const updatedAppointment = await prisma.appointment.update({
      where: { id },
      data: { 
        prescription: prescription.trim(),
      }
    });

    // ✅ LOG AUDIT
    await logAudit({
      userId: userId || req.user.userId,
      clinicId: clinicId || appointment.clinicId,
      action: 'UPDATE_PRESCRIPTION',
      entity: 'Appointment',
      entityId: id,
      details: {
        patientName: appointment.user?.name || 'Unknown',
        isNew: !appointment.prescription,
        length: prescription.length
      },
      req
    });

    // 6. Response
    return res.json({
      message: "Prescription saved successfully",
      prescription: updatedAppointment.prescription,
      appointmentId: updatedAppointment.id
    });

  } catch (error) {
    console.error("Update Prescription Error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
};
