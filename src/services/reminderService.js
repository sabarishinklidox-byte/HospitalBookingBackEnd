/* import cron from 'node-cron';
import nodemailer from 'nodemailer';
import prisma from '../prisma.js';

// --- 1. Setup ---


// --- 1. Setup ---
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendEmail = async (to, subject, text) => {
  try {
    // LOGGING THE EMAIL TARGET HERE
    console.log(`📨 Sending email to: [ ${to} ] ...`);
    
    await transporter.sendMail({
      from: `"DocBook Clinic" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
    });
    console.log(`✅ Email successfully sent to: ${to}`);
  } catch (err) {
    console.error(`❌ Failed to send to ${to}:`, err.message);
  }
};

// --- 2. Main Logic ---
const checkAndSendReminders = async () => {
  // IST Time Calculation
  const nowUtc = new Date();
  const nowIST = new Date(nowUtc.getTime() + (5.5 * 60 * 60 * 1000));
  
  console.log(`[${nowIST.toLocaleTimeString()}] ⏳ Checking for appointments...`);

  // Targets
  const next24h = new Date(nowIST.getTime() + 24 * 60 * 60 * 1000);
  const targetDate24h = new Date(next24h); targetDate24h.setHours(0,0,0,0);
  const targetHour24h = next24h.getHours();

  const next1h = new Date(nowIST.getTime() + 1 * 60 * 60 * 1000);
  const targetDate1h = new Date(next1h); targetDate1h.setHours(0,0,0,0);
  const targetHour1h = next1h.getHours();

  try {
    const appointments = await prisma.appointment.findMany({
      where: { status: 'CONFIRMED' },
      include: { user: true, doctor: true, slot: true },
    });

    if (appointments.length === 0) {
      console.log("   (No confirmed appointments in DB)");
      return;
    }

    for (const app of appointments) {
      if (!app.user?.email) {
        console.log(`   ⚠️ Skipping Appt ID ${app.id}: User has no email.`);
        continue;
      }

      const appDate = new Date(app.slot.date);
      const appDateIST = new Date(appDate.getTime() + (5.5 * 60 * 60 * 1000)); 
      appDateIST.setHours(0,0,0,0);
      const [slotHour] = app.slot.time.split(':').map(Number);

      // Log candidate
      // console.log(`   Checking: ${app.user.email} | Date: ${appDateIST.toDateString()} | Time: ${app.slot.time}`);

      // 24 Hour Match
      if (appDateIST.getTime() === targetDate24h.getTime() && slotHour === targetHour24h) {
        console.log(`🔔 MATCH FOUND (24h): Sending to User -> ${app.user.email}`);
        const msg = `Hello ${app.user.name},\n\nReminder: Appointment with Dr. ${app.doctor.name} tomorrow at ${app.slot.time}.`;
        await sendEmail(app.user.email, "Appointment Reminder (24h)", msg);
      }

      // 1 Hour Match
      if (appDateIST.getTime() === targetDate1h.getTime() && slotHour === targetHour1h) {
        console.log(`🔔 MATCH FOUND (1h): Sending to User -> ${app.user.email}`);
        const msg = `Hello ${app.user.name},\n\nReminder: Appointment with Dr. ${app.doctor.name} in 1 hour (${app.slot.time}).`;
        await sendEmail(app.user.email, "Appointment Reminder (1h)", msg);
      }
    }

  } catch (error) {
    console.error("Error in reminder service:", error);
  }
};

// --- 3. Start ---
export const startReminderJob = () => {
  console.log("✅ Reminder Service Started.");
  // Run every 10 seconds so you can see the logs immediately
  cron.schedule('*cronJobs.js0 * * * * *', checkAndSendReminders); 
};
 */