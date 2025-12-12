import prisma from '../prisma.js';

/**
 * Logs an action to the audit_logs table.
 * 
 * @param {Object} params
 * @param {string} params.userId - ID of the user performing the action
 * @param {string} params.clinicId - (Optional) ID of the clinic involved
 * @param {string} params.action - Name of action (e.g. "LOGIN", "RESCHEDULE")
 * @param {string} params.entity - Target entity (e.g. "Appointment", "Doctor")
 * @param {string} params.entityId - (Optional) ID of the target entity
 * @param {Object} params.details - (Optional) JSON object with extra info
 * @param {Object} params.req - (Optional) Express request object to get IP
 */
export const logAudit = async ({ userId, clinicId, action, entity, entityId, details, req }) => {
  try {
    // 1. Get IP Address safely
    const ipAddress = req 
      ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) 
      : null;

    // 2. Create Log Entry
    await prisma.auditLog.create({
      data: {
        userId,
        clinicId: clinicId || null, 
        action,
        entity,
        entityId: entityId || null,
        details: details || {}, // Store JSON details
        ipAddress
      }
    });

    // Optional: Print to console for debugging
    // console.log(`✅ Audit Logged: ${action} by ${userId}`);

  } catch (error) {
    // We catch errors so the main app doesn't crash if logging fails
    console.error("⚠️ Audit Log Failed:", error.message);
  }
};
