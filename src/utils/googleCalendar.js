import { google } from "googleapis";
import prisma from "../prisma.js"; 

export const createGoogleCalendarEvent = async ({
  calendarId = "primary",
  refreshToken,
  appointment,
}) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const response = await calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: `Appointment: ${appointment.patientName}`,
      description: `Doctor: ${appointment.doctorName}\nPhone: ${appointment.patientPhone}`,
      start: {
        dateTime: appointment.startTime,
        timeZone: "Asia/Kolkata",
      },
      end: {
        dateTime: appointment.endTime,
        timeZone: "Asia/Kolkata",
      },
      attendees: appointment.patientEmail
        ? [{ email: appointment.patientEmail }]
        : [],
    },
  });

  // 🔥 THIS IS THE IMPORTANT PART
  return {
    eventId: response.data.id,
    htmlLink: response.data.htmlLink,
  };
};


// export const deleteAppointmentFromGCal = async (appointmentId) => {
//   try {
//     const appt = await prisma.appointment.findUnique({
//       where: { id: appointmentId },
//       select: { 
//         googleCalendarEventId: true, 
//         doctor: { 
//           select: { 
//             googleRefreshToken: true,
//             googleCalendarId: true
//           } 
//         },
//         clinic: { 
//           select: { 
//             googleRefreshToken: true,
//             googleCalendarId: true
//           } 
//         }
//       }
//     });

//     // 1. If there is no ID, we can't delete anything
//     if (!appt?.googleCalendarEventId) {
//       console.log("ℹ️ No GCal event ID found for this appointment.");
//       return;
//     }

//     // 🔥 FIXED: Clinic-first loop (deletes from both if both connected)
//     const targets = [
//       { token: appt.clinic?.googleRefreshToken, calendarId: appt.clinic?.googleCalendarId || 'primary' },
//       { token: appt.doctor?.googleRefreshToken, calendarId: appt.doctor?.googleCalendarId || 'primary' }
//     ].filter(t => t.token);

//     if (targets.length === 0) {
//       console.log("ℹ️ No GCal tokens (clinic or doctor)");
//       return;
//     }

//     for (const target of targets) {
//       const oauth2Client = new google.auth.OAuth2(
//         process.env.GOOGLE_CLIENT_ID,
//         process.env.GOOGLE_CLIENT_SECRET
//       );
      
//       oauth2Client.setCredentials({ refresh_token: target.token });
//       const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

//       await calendar.events.delete({
//         calendarId: target.calendarId,
//         eventId: appt.googleCalendarEventId
//       });

//       console.log(`🗑️ GCal deleted from ${target.calendarId}: ${appt.googleCalendarEventId}`);
//     }

//     // 4. Clean up the database
//     await prisma.appointment.update({
//       where: { id: appointmentId },
//       data: { googleCalendarEventId: null }
//     });

//     console.log(`✅ Appointment ${appointmentId} GCal cleanup complete`);

//   } catch (error) {
//   console.log('🆔 GCal Delete failed:', appointmentId, error.code || error.message);
  
//   if (!appt) {
//     console.log("ℹ️ Appointment missing:", appointmentId);
//     return;
//   }
  
//   if (error.code === 410 || error.code === 404) {
//     await prisma.appointment.update({
//       where: { id: appointmentId },
//       data: { googleCalendarEventId: null }
//     });
//     console.log(`✅ Cleared GCal ${appt.googleCalendarEventId}`);
//   }
  
//   console.error('❌ GCal Error:', error.message);
// }
// };
// export const updateAppointmentOnGCal = async (appointmentId) => {
//   const appt = await prisma.appointment.findUnique({
//     where: { id: appointmentId },
//     include: { clinic: true, doctor: true, slot: true, user: true }
//   });

//   if (!appt?.googleCalendarEventId) return;

//   const targets = [
//     { token: appt.clinic?.googleRefreshToken, calendarId: appt.clinic?.googleCalendarId || "primary" },
//     { token: appt.doctor?.googleRefreshToken, calendarId: appt.doctor?.googleCalendarId || "primary" }
//   ].filter(t => t.token);

//   for (const t of targets) {
//     const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
//     oauth2Client.setCredentials({ refresh_token: t.token });
//     const calendar = google.calendar({ version: "v3", auth: oauth2Client });

//     await calendar.events.patch({
//       calendarId: t.calendarId,
//       eventId: appt.googleCalendarEventId,
//       requestBody: {
//         summary: `Appointment - ${appt.user?.name || "Patient"}`,
//         start: { dateTime: appt.slot.date, timeZone: "Asia/Kolkata" },
//         end: { dateTime: appt.slot.endTime, timeZone: "Asia/Kolkata" }
//       }
//     });
//   }
// };
export const deleteAppointmentFromGCal = async (appointmentId) => {
  try {
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        doctor: true,
        clinic: true,
      },
    });

    if (!appt) return;

    // 👨‍⚕️ Doctor calendar delete
    if (
      appt.googleCalendarDoctorEventId &&
      appt.doctor?.googleRefreshToken
    ) {
      await deleteFromCalendar({
        refreshToken: appt.doctor.googleRefreshToken,
        calendarId: appt.doctor.googleCalendarId || "primary",
        eventId: appt.googleCalendarDoctorEventId,
        source: "doctor",
      });
    }

    // 🏥 Clinic calendar delete
    if (
      appt.googleCalendarClinicEventId &&
      appt.clinic?.googleRefreshToken
    ) {
      await deleteFromCalendar({
        refreshToken: appt.clinic.googleRefreshToken,
        calendarId: appt.clinic.googleCalendarId || "primary",
        eventId: appt.googleCalendarClinicEventId,
        source: "clinic",
      });
    }

    // 🧹 Clean DB
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: {
        googleCalendarDoctorEventId: null,
        googleCalendarClinicEventId: null,
      },
    });

    console.log(`✅ GCal cleanup complete: ${appointmentId}`);
  } catch (err) {
    console.error("❌ GCal delete failed:", err.message);
  }
};
const deleteFromCalendar = async ({
  refreshToken,
  calendarId,
  eventId,
  source,
}) => {
  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    auth.setCredentials({ refresh_token: refreshToken });

    const calendar = google.calendar({ version: "v3", auth });

    await calendar.events.delete({ calendarId, eventId });

    console.log(`🗑️ GCal deleted from ${source}:`, eventId);
  } catch (e) {
    console.error(`⚠️ ${source} delete failed:`, e.code || e.message);
  }
};



export const updateAppointmentOnGCal = async (appointmentId) => {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      clinic: true,
      slot: { include: { doctor: true } },
      user: true,
    },
  });

  if (!appt || !appt.slot) return;

  const dateStr = appt.slot.date.toISOString().split("T")[0];
  const [hours, minutes] = appt.slot.time.split(":").map(Number);

  const startDateTime = new Date(
    `${dateStr}T${hours.toString().padStart(2, "0")}:${minutes
      .toString()
      .padStart(2, "0")}:00+05:30`
  );
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60000);

  // 👨‍⚕️ Doctor calendar update
  if (
    appt.googleCalendarDoctorEventId &&
    appt.slot.doctor?.googleRefreshToken
  ) {
    await patchCalendarEvent({
      refreshToken: appt.slot.doctor.googleRefreshToken,
      calendarId: appt.slot.doctor.googleCalendarId || "primary",
      eventId: appt.googleCalendarDoctorEventId,
      appt,
      startDateTime,
      endDateTime,
      source: "doctor",
    });
  }

  // 🏥 Clinic calendar update
  if (
    appt.googleCalendarClinicEventId &&
    appt.clinic?.googleRefreshToken
  ) {
    await patchCalendarEvent({
      refreshToken: appt.clinic.googleRefreshToken,
      calendarId: appt.clinic.googleCalendarId || "primary",
      eventId: appt.googleCalendarClinicEventId,
      appt,
      startDateTime,
      endDateTime,
      source: "clinic",
    });
  }
};

const patchCalendarEvent = async ({
  refreshToken,
  calendarId,
  eventId,
  appt,
  startDateTime,
  endDateTime,
  source,
}) => {
  try {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );

    oauth2Client.setCredentials({ refresh_token: refreshToken });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        summary: `${appt.status} - ${appt.user?.name || "Patient"}`,
        description: `Appt ID: ${appt.id}\nDoctor: ${appt.slot?.doctor?.name || ""}`,
        start: {
          dateTime: startDateTime.toISOString(),
          timeZone: "Asia/Kolkata",
        },
        end: {
          dateTime: endDateTime.toISOString(),
          timeZone: "Asia/Kolkata",
        },
      },
    });

    console.log(`✅ GCal updated (${source}):`, eventId);
  } catch (err) {
    console.error(`⚠️ GCal update failed (${source}):`, err.code || err.message);
  }
};


async function getClinicPlan(clinicId) {
  const clinic = await prisma.clinic.findUnique({
    where: { id: clinicId },
    include: {
      subscription: {
        include: { plan: true },
      },
    },
  });
  return clinic?.subscription?.plan || null;
  
}
export const autoSyncAppointmentToGCal = async (appointmentId) => {
  try {
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        clinic: true,
        slot: { include: { doctor: true } },
        user: true
      }
    });

    if (!appt || appt.status !== "CONFIRMED") return;

    const plan = await getClinicPlan(appt.clinicId);
    const doctor = appt.slot.doctor;
    const clinic = appt.clinic;

    // 👨‍⚕️ Doctor calendar
    if (doctor?.googleRefreshToken) {
      const doctorEventId = await syncToCalendar({
        refreshToken: doctor.googleRefreshToken,
        calendarId: doctor.googleCalendarId || "primary",
        appt
      });

      await prisma.appointment.update({
        where: { id: appt.id },
        data: { googleCalendarDoctorEventId: doctorEventId }
      });
    }

    // 🏥 Clinic calendar (only if plan allows)
    if (clinic?.googleRefreshToken && plan?.enableGoogleCalendarSync) {
      const clinicEventId = await syncToCalendar({
        refreshToken: clinic.googleRefreshToken,
        calendarId: clinic.googleCalendarId || "primary",
        appt
      });

      await prisma.appointment.update({
        where: { id: appt.id },
        data: { googleCalendarClinicEventId: clinicEventId }
      });
    }

  } catch (err) {
    console.error("🚨 GCal Sync Error:", err.message);
  }
};

const syncToCalendar = async ({ refreshToken, calendarId, appt }) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const date = appt.slot.date.toISOString().split("T")[0];
  const start = new Date(`${date}T${appt.slot.time}:00+05:30`);
  const end = new Date(start.getTime() + 30 * 60000);

  const res = await calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: `🏥 ${appt.user.name} - ${appt.slot.doctor.name}`,
      description: `Appt ID: ${appt.id}`,
      start: { dateTime: start.toISOString(), timeZone: "Asia/Kolkata" },
      end: { dateTime: end.toISOString(), timeZone: "Asia/Kolkata" },
    },
  });

  return res.data.id; // 🔥 CRITICAL
};
