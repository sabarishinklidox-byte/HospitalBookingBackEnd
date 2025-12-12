import nodemailer from 'nodemailer';

// Destructure environment variables
const {
  SMTP_HOST,
  SMTP_PORT,
  EMAIL_USER,
  EMAIL_PASS,
  MAIL_FROM,
} = process.env;

// Create reusable transporter
const transporter = nodemailer.createTransport({
  host: SMTP_HOST || 'smtp.gmail.com',
  port: Number(SMTP_PORT) || 587,
  secure: false, // true for 465, false for 587
  auth: {
    user: EMAIL_USER,
    pass: EMAIL_PASS,
  },
});

/**
 * Send password reset email
 * @param {string} toEmail
 * @param {string} resetLink
 */
export async function sendResetEmail(toEmail, resetLink) {
  try {
    const fromAddress = MAIL_FROM || EMAIL_USER;

    const mailOptions = {
      from: fromAddress,
      to: toEmail,
      subject: 'Reset your MediCare password',
      text: `You requested a password reset.

Click the link below to set a new password (valid for a limited time):

${resetLink}

If you did not request this, you can ignore this email.`,
      html: `
        <p>You requested a password reset.</p>
        <p>Click the link below to set a new password (valid for a limited time):</p>
        <p><a href="${resetLink}" target="_blank" rel="noopener noreferrer">${resetLink}</a></p>
        <p>If you did not request this, you can ignore this email.</p>
      `,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('Password reset email sent:', info.messageId);
  } catch (error) {
    console.error('Failed to send password reset email:', error);
    throw new Error('Could not send reset email. Try again later.');
  }
}

/**
 * Example usage:
 * import { sendResetEmail } from './utils/emailService';
 * await sendResetEmail('patient@example.com', 'https://your-app.com/reset/abc123');
 */
