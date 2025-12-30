import prisma from '../prisma.js';

// helper to get current plan for a clinic
async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  return clinic?.subscription?.plan || null; // Plan has enableAuditLogs, etc. [web:1186]
}

// ----------------------------------------------------------------
// GET /api/admin/patients/:userId/history
// ----------------------------------------------------------------
export const getPatientHistory = async (req, res) => {
  try {
    // 1. Extract context from request
    const { clinicId } = req.user;
    const { userId } = req.params;

    // 2. Validation: Ensure Admin belongs to a Clinic
    if (!clinicId) {
      return res.status(400).json({ error: 'Clinic ID missing in token' });
    }

    // 3. Plan Validation: Ensure plan supports this feature (Audit Logs / History)
    const plan = await getClinicPlan(clinicId);
    if (!plan || !plan.enableAuditLogs) {
      return res.status(403).json({
        error: 'Patient history is a premium feature. Please upgrade your plan.',
      });
    }

    // 4. Clinic Active Check
    const clinicCheck = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { deletedAt: true },
    });

    if (!clinicCheck || clinicCheck.deletedAt) {
      return res.status(404).json({ error: 'Clinic not found or inactive' });
    }

    // 5. Fetch User (Patient) Profile
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,   // ✅ Confirmed: Fetching phone number
        avatar: true,
        createdAt: true, // Useful to show "Patient since..."
        deletedAt: true,
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // 6. Fetch Appointments for this User at THIS Clinic only
    const appointments = await prisma.appointment.findMany({
      where: {
        clinicId: clinicId, // Strict scope: Only appointments at admin's clinic
        userId: userId,
        deletedAt: null,    // Exclude soft-deleted appointments
      },
      orderBy: {
        // Order by slot date/time if available, otherwise createdAt
        createdAt: 'desc', 
      },
      include: {
        doctor: {
          select: {
            id: true,
            name: true,
            speciality: true,
            avatar: true,
            deletedAt: true,
          },
        },
        clinic: {
          select: { id: true, name: true },
        },
        slot: true,    // Includes date/time info
        payment: true, // Includes payment status/amount
      },
    });

    // 7. Return Data
    return res.status(200).json({
      user,
      appointments,
    });

  } catch (error) {
    console.error('Get Patient History Error:', error);
    return res.status(500).json({ error: 'Internal server error while fetching patient history' });
  }
  
};
// src/controllers/adminPatientController.js


/**
 * GET /admin/patients/:userId/history
 * Detailed, inch‑by‑inch appointment + payment data for one patient in a clinic
 */
// controllers/adminPatientController.js


// controllers/adminPatientController.js


// controllers/adminPatientController.js




export const getPatientHistoryDetailed = async (req, res) => {
  try {
    const { clinicId } = req.user;
    const { userId } = req.params;

    // Pagination params
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    if (!clinicId) {
      return res.status(400).json({ error: "Clinic ID missing from request" });
    }

    // Get total count + paginated records
    const [totalCount, appointments] = await Promise.all([
      prisma.appointment.count({
        where: { clinicId, userId, deletedAt: null },
      }),
      prisma.appointment.findMany({
        where: { clinicId, userId, deletedAt: null },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
        include: {
          doctor: { select: { id: true, name: true, speciality: true } },
          clinic: { select: { id: true, name: true } },
          slot: {
            select: {
              id: true,
              date: true,
              time: true,
              paymentMode: true,
              price: true,
            },
          },
          logs: { orderBy: { createdAt: "asc" } },
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              avatar: true,
            },
          },
          payment: true,
          cancellationRequest: true,
          review: true,
        },
      }),
    ]);

    if (!appointments.length) {
      return res.json({
        user: null,
        appointments: [],
        pagination: {
          page,
          limit,
          totalCount: 0,
          totalPages: 0,
        },
      });
    }

    const patient = appointments[0].user;

    const formattedAppointments = appointments.map((a) => {
      const slot = a.slot || {};
      const bookedAmount = Number(a.amount ?? slot.price ?? 0);

      let currentAmount = bookedAmount;
      let paidAmount = 0;
      let refundedAmount = 0;

      const timeline = [];

      // 1. History: Booking
      timeline.push({
        type: "BOOKED",
        amount: bookedAmount,
        at: a.createdAt.toISOString(),
        mode: slot.paymentMode || "SYSTEM",
        note: `Booked slot for ₹${bookedAmount}`,
      });

      // 2. History: Reschedules / Admin Changes
      for (const log of a.logs || []) {
        const action = log.action || "";
        const diff = Number(log.details?.diffAmount ?? 0);

        if (
          (action === "RESCHEDULE" || action === "RESCHEDULE_APPOINTMENT") &&
          diff !== 0
        ) {
          currentAmount += diff;
          timeline.push({
            type: "AMOUNT_UPDATE",
            amount: diff,
            at: log.createdAt.toISOString(),
            mode: "SYSTEM",
            note:
              diff > 0
                ? `Amount increased by ₹${diff} (now ₹${currentAmount})`
                : `Amount decreased by ₹${Math.abs(diff)} (now ₹${currentAmount})`,
          });
        }
      }

      // 3. History: Payments
      if (a.payment) {
        const p = a.payment;
        const pAmount = Number(p.amount ?? 0);

        if (p.status === "PAID") {
          paidAmount += pAmount;
          timeline.push({
            type: slot.paymentMode === "ONLINE" ? "ONLINE_PAYMENT" : "CLINIC_PAYMENT",
            amount: pAmount,
            at: p.createdAt.toISOString(),
            mode: slot.paymentMode || "UNKNOWN",
            note: `Paid ₹${pAmount}`,
          });
        } else if (p.status === "REFUNDED") {
          refundedAmount += pAmount;
          timeline.push({
            type: "REFUND",
            amount: pAmount,
            at: p.createdAt.toISOString(),
            mode: slot.paymentMode || "UNKNOWN",
            note: `Refunded ₹${pAmount}`,
          });
        }
      }

      // 4. Calculate Pending & Status
      let pendingAmount = Math.max(currentAmount - paidAmount + refundedAmount, 0);
let paymentStatus = a.paymentStatus || "PENDING";

if (currentAmount === 0) {
  paymentStatus = "PAID";
  pendingAmount = 0;
} else if (paidAmount >= currentAmount && currentAmount > 0) {
  paymentStatus = "PAID";
  pendingAmount = 0;
} else if (paidAmount > 0 && paidAmount < currentAmount) {
  paymentStatus = "PARTIAL";
} else {
  paymentStatus = "PENDING";
}

// AUTO‑TREAT COMPLETED OFFLINE AS PAID
if (
  a.status === "COMPLETED" &&
  (!a.payment || a.payment.status !== "PAID") &&
  (slot.paymentMode === "OFFLINE" || !slot.paymentMode)
) {
  paidAmount = currentAmount;     // assume full amount taken in clinic
  pendingAmount = 0;
  paymentStatus = "PAID";
}

// If appointment is cancelled and not paid, show CANCELLED
if (a.status === "CANCELLED" && paidAmount === 0) {
  paymentStatus = "CANCELLED";
}
      const lastPaymentEvent =
        timeline
          .filter((t) =>
            ["ONLINE_PAYMENT", "CLINIC_PAYMENT", "REFUND"].includes(t.type)
          )
          .slice(-1)[0] || null;
           console.log('Patient history row >>>', {
    id: a.id,
    status: a.status,
    slotPaymentMode: slot.paymentMode,
    bookedAmount,
    currentAmount,
    paidAmount,
    refundedAmount,
    pendingAmount,
    paymentStatus,
    rawPayment: a.payment && {
      amount: a.payment.amount,
      status: a.payment.status,
    },
  });

      return {
        id: a.id,
        status: a.status,

        // Financial Summary
        bookedAmount,
        amount: currentAmount,
        paidAmount,
        refundedAmount,
        pendingAmount,
        paymentStatus,
        paymentMode: slot.paymentMode || "UNKNOWN",
        paymentUpdatedAt: lastPaymentEvent ? lastPaymentEvent.at : null,

        // Raw payment object
        payment: a.payment
          ? {
              id: a.payment.id,
              amount: Number(a.payment.amount ?? 0),
              status: a.payment.status,
              createdAt: a.payment.createdAt,
            }
          : null,

        // Relations
        doctor: a.doctor
          ? {
              id: a.doctor.id,
              name: a.doctor.name,
              speciality: a.doctor.speciality ?? null,
            }
          : null,
        clinic: a.clinic
          ? {
              id: a.clinic.id,
              name: a.clinic.name ?? null,
            }
          : null,
        slot: a.slot
          ? {
              id: a.slot.id,
              date: a.slot.date,
              time: a.slot.time,
              paymentMode: a.slot.paymentMode,
              price: Number(a.slot.price ?? 0),
            }
          : null,

        dateFormatted: a.slot
          ? new Date(a.slot.date).toLocaleDateString()
          : null,
        timeFormatted: a.slot?.time ?? null,

        paymentTimeline: timeline,
      };
    });

    return res.json({
      user: patient,
      appointments: formattedAppointments,
      pagination: {
        page,
        limit,
        totalCount,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (error) {
    console.error("getPatientHistoryDetailed Error:", error);
    return res.status(500).json({ error: error.message });
  }
};

