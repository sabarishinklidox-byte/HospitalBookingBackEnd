import nodemailer from 'nodemailer';
import prisma from '../prisma.js';

// ✅ Robust enum import
import prismaPkg from '@prisma/client';
const { Role } = prismaPkg;

// 🔥 EMAIL TRANSPORTER SETUP (EXPORTED)
export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// 🔥 1. CANCELLATION EMAIL (Your existing function - PERFECT!)
export const sendCancellationEmail = async (appointment, reason, patientRequested, adminUser) => {
  const { user, slot } = appointment;
  const clinicName = slot.clinic.name;
  const doctorName = slot.doctor.name;
  const slotTime = new Date(`${slot.date}T${slot.time}:00+05:30`).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata'
  });
  const adminName = adminUser.name || 'Clinic Admin';

  const subject = `⚠️ Appointment CANCELLED - ${doctorName}`;
  const actionBy = patientRequested ? 'You requested' : `Cancelled by ${clinicName}`;
  
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
      <h2 style="color: #f59e0b;">📅 Appointment Cancelled</h2>
      <p>Hi <strong>${user.name}</strong>,</p>
      <p>Your appointment with <strong>${doctorName}</strong> has been <strong>CANCELLED</strong>.</p>
      
      <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0;">
        <h3>📋 Cancellation Details:</h3>
        <p><strong>Doctor:</strong> ${doctorName}</p>
        <p><strong>Clinic:</strong> ${clinicName}</p>
        <p><strong>Date & Time:</strong> ${slotTime}</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p><strong>Action:</strong> ${actionBy}</p>
        ${!patientRequested && `<p><strong>By:</strong> ${adminName}</p>`}
      </div>
      
      <p>Book a new appointment from <a href="https://yourapp.com">your dashboard</a>.</p>
      <p>Best regards,<br><strong>${clinicName} Team</strong></p>
    </div>
  `;

  await transporter.sendMail({
    from: `"${clinicName}" <no-reply@yourapp.com>`,
    to: user.email,
    subject,
    html
  });

  console.log(`✅ Cancellation Email sent to ${user.email} for appt ${appointment.id}`);
};

// 🔥 2. STATUS UPDATE EMAIL (CONFIRMED/REJECTED/CANCELLED)
export const sendAppointmentStatusEmail = async (appointment, status, reason, adminUser) => {
  const { user, slot } = appointment;
  const clinicName = slot.clinic.name;
  const doctorName = slot.doctor.name;
  const slotTime = new Date(`${slot.date}T${slot.time}:00+05:30`).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata'
  });
  const adminName = adminUser?.name || 'Clinic Admin';
  const appUrl = process.env.APP_URL || 'https://yourapp.com';

  let subject, html;

  if (status === 'CONFIRMED') {
    subject = `✅ Appointment CONFIRMED - ${doctorName}`;
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #10b981;">🎉 Appointment CONFIRMED!</h2>
        <p>Hi <strong>${user.name}</strong>,</p>
        <p>Your appointment with <strong>${doctorName}</strong> has been <strong>CONFIRMED</strong> by ${clinicName}!</p>
        
        <div style="background: #d1fae5; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3>📅 Appointment Details:</h3>
          <p><strong>Doctor:</strong> ${doctorName}</p>
          <p><strong>Clinic:</strong> ${clinicName}</p>
          <p><strong>Date & Time:</strong> ${slotTime}</p>
        </div>
        
        <p>We'll send you a reminder 1 hour before your appointment.</p>
        <p>Best regards,<br><strong>${adminName}</strong><br>${clinicName} Team</p>
      </div>
    `;
  } 
  else if (status === 'REJECTED') {
    subject = `❌ Appointment REJECTED - ${doctorName}`;
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #ef4444;">😔 Appointment Rejected</h2>
        <p>Hi <strong>${user.name}</strong>,</p>
        <p>Your appointment request with <strong>${doctorName}</strong> has been <strong>REJECTED</strong> by ${clinicName}.</p>
        
        <div style="background: #fee2e2; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3>📅 Requested Slot:</h3>
          <p><strong>Doctor:</strong> ${doctorName}</p>
          <p><strong>Date & Time:</strong> ${slotTime}</p>
          <p><strong>Reason:</strong> ${reason || 'Slot not available'}</p>
        </div>
        
        <p><strong>Action by:</strong> ${adminName}</p>
        <p>Please select another available slot from <a href="${appUrl}">your dashboard</a>.</p>
        <p>Best regards,<br><strong>${clinicName} Team</strong></p>
      </div>
    `;
  }
  else if (status === 'CANCELLED') {
    subject = `⚠️ Appointment CANCELLED - ${doctorName}`;
    html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #f59e0b;">📅 Appointment Cancelled</h2>
        <p>Hi <strong>${user.name}</strong>,</p>
        <p>Your appointment with <strong>${doctorName}</strong> has been <strong>CANCELLED</strong>.</p>
        
        <div style="background: #fef3c7; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3>📋 Cancellation Details:</h3>
          <p><strong>Doctor:</strong> ${doctorName}</p>
          <p><strong>Date & Time:</strong> ${slotTime}</p>
          <p><strong>Reason:</strong> ${reason || 'Cancelled by clinic'}</p>
        </div>
        
        <p><strong>Action by:</strong> ${adminName}</p>
        <p>Book a new appointment from <a href="${appUrl}">your dashboard</a>.</p>
        <p>Best regards,<br><strong>${clinicName} Team</strong></p>
      </div>
    `;
  }

  await transporter.sendMail({
    from: `"${clinicName}" <no-reply@yourapp.com>`,
    to: user.email,
    subject,
    html
  });

  console.log(`✅ ${status} Email sent to ${user.email} for appt ${appointment.id}`);
};

// 🔥 3. YOUR BOOKING EMAILS FUNCTION (Your existing - PERFECT!)
export const sendBookingEmails = async (appointmentData) => {
  try {
    const { 
      clinic, 
      doctor, 
      slot, 
      user, 
      type = 'BOOKING', 
      oldSlot,
      customMessage,
      clinicPhone
    } = appointmentData;

    // 1. Fetch Clinic Admin
    const clinicAdmin = await prisma.user.findFirst({
      where: {
        clinicId: clinic.id,
        role: Role.CLINIC_ADMIN,
        deletedAt: null,
      },
      select: { email: true, name: true },
    });

    // 2. Fetch Doctor User
    const doctorUser = await prisma.user.findFirst({
      where: {
        doctorId: doctor.id,
        deletedAt: null,
      },
      select: { email: true, name: true },
    });

    const emails = [];

    // --- TEMPLATE LOGIC ---
    const isReschedule = type === 'RESCHEDULE';
    const apptIdShort = String(appointmentData.id).slice(-6).toUpperCase();

    const subjectAdmin = isReschedule
      ? `🔄 Appointment Rescheduled #${apptIdShort}`
      : `🆕 New Appointment Request #${apptIdShort}`;

    const subjectDoctor = isReschedule
      ? `🔄 Rescheduled Appointment - ${user?.name || 'Patient'}`
      : `📅 Appointment Request - ${user?.name || 'Patient'}`;

    const subjectPatient = isReschedule
      ? `📅 Appointment Rescheduled - Dr. ${doctor?.name}`
      : `📅 Appointment Confirmation - Dr. ${doctor?.name}`;

    const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN') : 'N/A');

    const badgeText = isReschedule ? 'RESCHEDULE REQUEST' : 'NEW APPOINTMENT REQUEST';
    const badgeBg = isReschedule ? '#FFF3E0' : '#E3F2FD';
    const badgeColor = isReschedule ? '#E65100' : '#0D47A1';

    // --- HTML CARD LAYOUT ---
    const commonCard = (innerHtml) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fb;padding:24px;">
        <tr>
          <td align="center">
            <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e7eaf0;box-shadow:0 4px 12px rgba(0,0,0,0.08);">
              <tr>
                <td style="padding:18px 20px;background:#003366;color:#ffffff;font-family:Arial,sans-serif;">
                  <div style="font-size:16px;font-weight:700;letter-spacing:0.2px;">${clinic?.name || 'Clinic'}</div>
                  <div style="font-size:12px;opacity:0.9;margin-top:2px;">Appointment Notification</div>
                </td>
              </tr>
              <tr>
                <td style="padding:18px 20px;font-family:Arial,sans-serif;">
                  <span style="display:inline-block;padding:6px 12px;border-radius:999px;background:${badgeBg};color:${badgeColor};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">
                    ${badgeText}
                  </span>
                  <div style="margin-top:18px;padding:20px;border-radius:12px;background:#f8fafc;border:1px solid #eef2f7;box-shadow:0 2px 8px rgba(0,0,0,0.05);">
                    ${innerHtml}
                  </div>
                  <div style="margin-top:16px;padding:12px 0;font-size:12px;color:#667085;line-height:1.5;border-top:1px solid #eef2f7;">
                    Appointment ID: <span style="font-family:Consolas,monospace;color:#111827;font-weight:600;">${appointmentData.id}</span>
                  </div>
                </td>
              </tr>
              <tr>
                <td style="padding:16px 20px;background:#fafbfc;border-top:1px solid #eef2f7;font-family:Arial,sans-serif;font-size:12px;color:#667085;text-align:center;">
                  This is an automated notification.
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    `;

    // --- 1. BOOKING DETAILS HTML ---
    const bookingRows = `
      <div style="font-size:14px;color:#111827;line-height:1.6;">
        <div><strong>Patient:</strong> ${user?.name || 'Patient'} <span style="color:#667085;">(${user?.phone || 'N/A'})</span></div>
        <div><strong>Doctor:</strong> ${doctor?.name || 'Doctor'}</div>
        <div><strong>Date:</strong> ${fmtDate(slot?.date)}</div>
        <div><strong>Time:</strong> ${slot?.time || 'N/A'}</div>
        <div><strong>Amount:</strong> ₹${slot?.price ?? 0}</div>
        <div style="margin-top:10px;font-weight:bold;color:#d97706;">Status: PENDING</div>
      </div>
    `;

    // --- 2. RESCHEDULE DETAILS HTML ---
    const rescheduleRows = `
      <div style="font-size:14px;color:#111827;line-height:1.6;">
        <div><strong>Patient:</strong> ${user?.name || 'Patient'} <span style="color:#667085;">(${user?.phone || 'N/A'})</span></div>
        <div><strong>Doctor:</strong> ${doctor?.name || 'Doctor'}</div>

        <div style="margin-top:12px;padding:12px;border-radius:8px;background:#fff3cd;border:1px dashed #f59e0b;">
          <div style="font-weight:700;color:#92400e;font-size:12px;margin-bottom:4px;">📅 OLD SLOT</div>
          <div>${fmtDate(oldSlot?.date)} at ${oldSlot?.time || 'N/A'}</div>
        </div>

        <div style="margin-top:8px;padding:12px;border-radius:8px;background:#ecfdf5;border:1px dashed #10b981;">
          <div style="font-weight:700;color:#065f46;font-size:12px;margin-bottom:4px;">➡️ NEW SLOT</div>
          <div>${fmtDate(slot?.date)} at ${slot?.time || 'N/A'}</div>
        </div>

        ${customMessage ? `
          <div style="margin-top:12px;padding:12px;border-radius:8px;background:#f0f9ff;border-left:4px solid #0284c7;color:#0c4a6e;">
            <strong>💰 Payment Update:</strong><br/>
            ${customMessage}
          </div>
        ` : ''}

        ${clinicPhone ? `
          <div style="margin-top:12px;font-size:12px;color:#64748b;">
            Questions? Contact Clinic: <strong>${clinicPhone}</strong>
          </div>
        ` : ''}

        <div style="margin-top:12px;font-weight:bold;color:#d97706;">Status: RESCHEDULED</div>
      </div>
    `;

    const htmlContent = commonCard(isReschedule ? rescheduleRows : bookingRows);

    // --- SEND EMAILS ---
    // 1. To Admin
    if (clinicAdmin?.email) {
      emails.push(
        transporter.sendMail({
          from: `"${clinic.name}" <no-reply@yourapp.com>`,
          to: clinicAdmin.email,
          subject: subjectAdmin,
          html: htmlContent,
        })
      );
    }

    // 2. To Doctor
    if (doctorUser?.email) {
      emails.push(
        transporter.sendMail({
          from: `"${clinic.name}" <no-reply@yourapp.com>`,
          to: doctorUser.email,
          subject: subjectDoctor,
          html: htmlContent,
        })
      );
    }

    // 3. To Patient
    if (user?.email) {
      emails.push(
        transporter.sendMail({
          from: `"${clinic.name}" <no-reply@yourapp.com>`,
          to: user.email,
          subject: subjectPatient,
          html: htmlContent,
        })
      );
    }

    await Promise.all(emails);
    console.log('✅ Booking emails sent successfully');
  } catch (err) {
    console.error('❌ Email send failed:', err);
  }
};

// 🔥 DEFAULT EXPORT
export default {
  transporter,
  sendBookingEmails,
  sendAppointmentStatusEmail,
  sendCancellationEmail
};
