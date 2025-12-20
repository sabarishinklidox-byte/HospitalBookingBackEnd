import cron from 'node-cron';
import nodemailer from 'nodemailer';
import prisma from '../prisma.js';

// --- HELPER: Format Time to AM/PM ---
const formatTime12h = (time24) => {
    const [h, m] = time24.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12; // Convert 0 to 12
    return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`;
};

// --- HELPER: HTML Email Template ---
const getHtmlTemplate = (userName, doctorName, dateStr, timeStr, type) => {
    const color = type === '1 Hour' ? '#e74c3c' : '#3498db'; // Red for urgent, Blue for tomorrow
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
        <div style="background-color: ${color}; padding: 20px; text-align: center; color: white;">
            <h2 style="margin: 0;">📅 Appointment Reminder</h2>
            <p style="margin: 5px 0 0;">${type}</p>
        </div>
        <div style="padding: 30px; background-color: #f9f9f9;">
            <p style="font-size: 16px; color: #333;">Hello <strong>${userName}</strong>,</p>
            <p style="font-size: 16px; color: #555;">This is a friendly reminder about your upcoming appointment with <strong>Dr. ${doctorName}</strong>.</p>
            
            <div style="background-color: white; padding: 15px; border-left: 4px solid ${color}; margin: 20px 0;">
                <p style="margin: 5px 0;"><strong>🕒 Time:</strong> ${timeStr}</p>
                <p style="margin: 5px 0;"><strong>📅 Date:</strong> ${dateStr}</p>
            </div>

            <p style="font-size: 14px; color: #777;">Please arrive 10 minutes early to complete any necessary check-in procedures.</p>
            
            <div style="text-align: center; margin-top: 30px;">
                <a href="https://appointment.inklidox.com/login" style="background-color: #333; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold;">View Details</a>
            </div>
        </div>
        <div style="background-color: #eee; padding: 15px; text-align: center; font-size: 12px; color: #999;">
            <p>DocBook Clinic System &copy; ${new Date().getFullYear()}</p>
        </div>
    </div>
    `;
};

// 1. Email Transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

const sendEmail = async (to, subject, htmlContent) => {
  try {
    console.log(`📨 Sending email to: ${to}`);
    await transporter.sendMail({
      from: `"DocBook Clinic" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      html: htmlContent, // <--- Using HTML now
    });
    console.log(`✅ Email sent successfully to: ${to}`);
  } catch (err) {
    console.error(`❌ Failed to send email to ${to}:`, err.message);
  }
};

// 2. Main Logic
export const checkAndSendReminders = async () => {
  try {
    const now = new Date();
    const IST_OFFSET = 5.5 * 60 * 60 * 1000;
    const nowIST = new Date(now.getTime() + IST_OFFSET);
    
    console.log(`[${nowIST.toISOString().slice(11,19)} IST] ⏳ Hourly Reminder Job Running...`);

    const currentHourIST = nowIST.getUTCHours();
    const currentDayISTStr = nowIST.toISOString().slice(0, 10); 

    const appointments = await prisma.appointment.findMany({
      where: { status: 'CONFIRMED' },
      include: { user: true, doctor: true, slot: true },
    });

    if (appointments.length === 0) return;

    let sentCount = 0;

    for (const app of appointments) {
      if (!app.user?.email) continue;

      // IST Conversion
      const appDate = new Date(app.slot.date);
      const appDateIST = new Date(appDate.getTime() + IST_OFFSET);
      const appDayISTStr = appDateIST.toISOString().slice(0, 10);
      
      const [appHour] = app.slot.time.split(':').map(Number);
      
      // PREPARE DATA
      const formattedTime = formatTime12h(app.slot.time); // e.g., "02:15 PM"
      const formattedDate = appDateIST.toDateString();    // e.g., "Sat Dec 20 2025"

      // ------------------------------------------------------------------
      // LOGIC: 1 HOUR REMINDER
      // ------------------------------------------------------------------
      if (appDayISTStr === currentDayISTStr && appHour === (currentHourIST + 1)) {
         console.log(`🔔 MATCH! 1h Reminder for ${app.user.email} at ${formattedTime}`);
         
         const html = getHtmlTemplate(
            app.user.name, 
            app.doctor.name, 
            formattedDate, 
            formattedTime, 
            "Urgent: Appointment in 1 Hour"
         );
         
         await sendEmail(app.user.email, "⏰ Appointment Reminder (1 Hour)", html);
         sentCount++;
      }
      
      // ------------------------------------------------------------------
      // LOGIC: 24 HOUR REMINDER
      // ------------------------------------------------------------------
      const tomorrowIST = new Date(nowIST);
      tomorrowIST.setDate(tomorrowIST.getDate() + 1);
      const tomorrowISTStr = tomorrowIST.toISOString().slice(0, 10);

      if (appDayISTStr === tomorrowISTStr && appHour === currentHourIST) {
          console.log(`🔔 MATCH! 24h Reminder for ${app.user.email} at ${formattedTime}`);
          
          const html = getHtmlTemplate(
             app.user.name, 
             app.doctor.name, 
             formattedDate, 
             formattedTime, 
             "Appointment Tomorrow"
          );
          
          await sendEmail(app.user.email, "📅 Appointment Reminder (Tomorrow)", html);
          sentCount++;
      }
    }
    
    if (sentCount === 0) console.log("   (No matching appointments for this hour)");

  } catch (error) {
    console.error("❌ Error in reminder service:", error);
  }
};

// 3. Scheduler
export const startReminderJob = () => {
  console.log("✅ Reminder Service Started.");
  // Production: Run Hourly
  cron.schedule('0 * * * *', checkAndSendReminders); 
};
