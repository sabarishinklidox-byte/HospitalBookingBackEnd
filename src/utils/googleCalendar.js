import { google } from "googleapis";
import prisma from "../prisma.js"; 

export const createGoogleCalendarEvent = async ({ calendarId = "primary", refreshToken, appointment }) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  return calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: {
      summary: `Appointment: ${appointment.patientName}`,
      description: `Doctor: ${appointment.doctorName}\nPhone: ${appointment.patientPhone}`,
      start: { dateTime: appointment.startTime, timeZone: "Asia/Kolkata" },
      end: { dateTime: appointment.endTime, timeZone: "Asia/Kolkata" },
      attendees: appointment.patientEmail ? [{ email: appointment.patientEmail }] : [],
    },
  });
};

export const deleteAppointmentFromGCal = async (appointmentId) => {
  try {
    const appt = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: { 
        googleCalendarEventId: true, 
        doctor: { 
          select: { 
            googleRefreshToken: true,
            googleCalendarId: true
          } 
        },
        clinic: { 
          select: { 
            googleRefreshToken: true,
            googleCalendarId: true
          } 
        }
      }
    });

    // 1. If there is no ID, we can't delete anything
    if (!appt?.googleCalendarEventId) {
      console.log("ℹ️ No GCal event ID found for this appointment.");
      return;
    }

    // 🔥 FIXED: Clinic-first loop (deletes from both if both connected)
    const targets = [
      { token: appt.clinic?.googleRefreshToken, calendarId: appt.clinic?.googleCalendarId || 'primary' },
      { token: appt.doctor?.googleRefreshToken, calendarId: appt.doctor?.googleCalendarId || 'primary' }
    ].filter(t => t.token);

    if (targets.length === 0) {
      console.log("ℹ️ No GCal tokens (clinic or doctor)");
      return;
    }

    for (const target of targets) {
      const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
      );
      
      oauth2Client.setCredentials({ refresh_token: target.token });
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

      await calendar.events.delete({
        calendarId: target.calendarId,
        eventId: appt.googleCalendarEventId
      });

      console.log(`🗑️ GCal deleted from ${target.calendarId}: ${appt.googleCalendarEventId}`);
    }

    // 4. Clean up the database
    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { googleCalendarEventId: null }
    });

    console.log(`✅ Appointment ${appointmentId} GCal cleanup complete`);

  } catch (error) {
    // If the event was already deleted manually in Google, it will throw a 410 error.
    // We should still clear it from our DB in that case.
    if (error.code === 410 || error.code === 404) {
      await prisma.appointment.update({
        where: { id: appointmentId },
        data: { googleCalendarEventId: null }
      });
      console.log(`ℹ️ GCal event ${appt?.googleCalendarEventId} already gone, DB cleared`);
    }
    console.error('❌ GCal Delete Error:', error.message);
  }
};
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
export const updateAppointmentOnGCal = async (appointmentId) => {
  const appt = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      clinic: true,
      slot: { include: { doctor: true } }, // ensure doctor token is available via slot.doctor
      user: true,
    },
  });

  if (!appt?.googleCalendarEventId || !appt?.slot) return;

  // Build proper datetime (date + time) in IST
  const dateStr = appt.slot.date instanceof Date
    ? appt.slot.date.toISOString().split("T")[0]
    : String(appt.slot.date).split("T")[0]; // fallback if string

const [hours, minutes] = appt.slot.time.split(':').map(Number);
const startDateTime = new Date(`${dateStr}T${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:00+05:30`);
const endDateTime = new Date(startDateTime.getTime() + 30 * 60 * 1000);

  const targets = [
    { token: appt.clinic?.googleRefreshToken, calendarId: appt.clinic?.googleCalendarId || "primary" },
    { token: appt.slot?.doctor?.googleRefreshToken, calendarId: appt.slot?.doctor?.googleCalendarId || "primary" },
  ].filter(t => t.token);

  for (const t of targets) {
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2Client.setCredentials({ refresh_token: t.token });

    const calendar = google.calendar({ version: "v3", auth: oauth2Client });

    await calendar.events.patch({
      calendarId: t.calendarId,
      eventId: appt.googleCalendarEventId,
      requestBody: {
        summary: `${appt.status} - ${appt.user?.name || "Patient"}`,
        description: `Appt ID: ${appt.id}\nDoctor: ${appt.slot?.doctor?.name || ""}`,
        start: { dateTime: startDateTime.toISOString(), timeZone: "Asia/Kolkata" },
        end: { dateTime: endDateTime.toISOString(), timeZone: "Asia/Kolkata" },
      },
    });
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

    // 1) Clinic subscribed? → BOTH calendars (priority: doctor first)
    const plan = await getClinicPlan(appt.clinicId);
    const doBoth = plan?.enableGoogleCalendarSync;

    const doctor = appt.slot.doctor;
    const clinic = appt.clinic;

    // 2) Doctor calendar (if connected)
    if (doctor?.googleRefreshToken) {
      await syncToCalendar({
        refreshToken: doctor.googleRefreshToken,
        calendarId: doctor.googleCalendarId || "primary",
        appt,
        source: "doctor"
      });
    }

    // 3) Clinic calendar (if connected AND clinic subscribed)
    if (clinic?.googleRefreshToken && doBoth) {
      await syncToCalendar({
        refreshToken: clinic.googleRefreshToken,
        calendarId: clinic.googleCalendarId || "primary",
        appt,
        source: "clinic"
      });
    }

  } catch (error) {
    console.error("🚨 GCal Sync Error:", error.response?.data || error.message);
  }
};
const syncToCalendar = async ({ refreshToken, calendarId, appt, source }) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  const startDateTime = new Date(`${appt.slot.date.toISOString().split("T")[0]}T${appt.slot.time}:00+05:30`);
  const endDateTime = new Date(startDateTime.getTime() + 30 * 60 * 1000);

  const eventBody = {
    summary: `🏥 ${appt.user?.name || "Patient"} - ${appt.slot.doctor?.name || "Doctor"}`,
    description: `Patient: ${appt.user?.name || "N/A"}\nPhone: ${appt.user?.phone || "N/A"}\nAppt ID: ${appt.id}`,
    start: { dateTime: startDateTime.toISOString(), timeZone: "Asia/Kolkata" },
    end: { dateTime: endDateTime.toISOString(), timeZone: "Asia/Kolkata" },
    attendees: appt.user?.email ? [{ email: appt.user.email }] : [],
  };

  const response = await calendar.events.insert({
    calendarId,
    sendUpdates: "all",
    requestBody: eventBody,
  });
await prisma.appointment.update({
  where: { id: appt.id },
  data: { 
    googleCalendarEventId: response.data.id  // For delete!
  }
});
  console.log(`✅ GCal ${source}: ${response.data.htmlLink}`);
};