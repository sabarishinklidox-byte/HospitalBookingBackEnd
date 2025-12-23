// utils/email.js
import nodemailer from 'nodemailer';
import prisma from '../prisma.js';

// ✅ robust enum import (works in ESM even if @prisma/client is CommonJS)
import prismaPkg from '@prisma/client';
const { Role } = prismaPkg;

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export const sendBookingEmails = async (appointmentData) => {
  try {
    const { clinic, doctor, slot, user, type = 'BOOKING', oldSlot } = appointmentData;

    // ✅ Clinic admin (Role enum)
    const clinicAdmin = await prisma.user.findFirst({
      where: {
        clinicId: clinic.id,
        role: Role.CLINIC_ADMIN, // ✅ FIX: enum, not "CLINIC_ADMIN"
        deletedAt: null,
      },
      select: { email: true, name: true },
    });

    // ✅ Doctor user (use findFirst so we can filter deletedAt)
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

    // --- BOOKING DETAILS ---
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

    // --- RESCHEDULE DETAILS ---
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

        <div style="margin-top:12px;font-weight:bold;color:#d97706;">Status: PENDING</div>
      </div>
    `;

    const htmlContent = commonCard(isReschedule ? rescheduleRows : bookingRows);

    // --- SEND EMAILS ---
    if (clinicAdmin?.email) {
      emails.push(
        transporter.sendMail({
          to: clinicAdmin.email,
          subject: subjectAdmin,
          html: htmlContent,
        })
      );
    }

    if (doctorUser?.email) {
      emails.push(
        transporter.sendMail({
          to: doctorUser.email,
          subject: subjectDoctor,
          html: htmlContent,
        })
      );
    }

    await Promise.all(emails);
    console.log('✅ Emails sent successfully');
  } catch (err) {
    console.error('❌ Email send failed:', err);
  }
};
