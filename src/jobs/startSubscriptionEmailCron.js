import cron from "node-cron";
import prisma from "../prisma.js";
import { sendEmail1 } from "../services/reminderService.js";

// -------- date helpers (day-based comparisons) ----------
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysBetween = (a, b) =>
  Math.round((startOfDay(a) - startOfDay(b)) / 86400000); // a - b

// -------- dedupe using AuditLog (no schema change) ----------
async function alreadySentEmail(clinicId, key) {
  const found = await prisma.auditLog.findFirst({
    where: {
      clinicId,
      action: "SUBSCRIPTION_EMAIL_SENT",
      entity: "SUBSCRIPTION",
      entityId: key,
    },
    select: { id: true },
  });
  return !!found;
}

async function markEmailSent({ clinicId, userId, key, details }) {
  await prisma.auditLog.create({
    data: {
      clinicId,
      userId: userId || "SYSTEM",
      action: "SUBSCRIPTION_EMAIL_SENT",
      entity: "SUBSCRIPTION",
      entityId: key,
      details,
    },
  });
}

// -------- template builder ----------
function buildTemplate(type, { sub, admin, clinic, plan, endISO }) {
  // Login page CTA (super-admin as per your code)
  const redirectTo = "/admin/subscription/upgrade";
  const loginLink = `${process.env.FRONTEND_URL}/super-admin/login?redirect=${encodeURIComponent(
    redirectTo
  )}`;

  const subjectMap = {
    TRIAL_D7: "Your trial ends in 7 days",
    TRIAL_D1: "Trial ends tomorrow",
    TRIAL_D0: "Trial ends today",
    TRIAL_ENDED: "Your trial has ended",

    PLAN_D7: "Subscription renews in 7 days",
    PLAN_D1: "Plan expires tomorrow",
    PLAN_D0: "Plan expires today",
    PLAN_EXPIRED: "Subscription expired — action required",

    PLAN_EXPIRED_D3: "Reminder: subscription still expired",
    PLAN_EXPIRED_D7: "7 days since expiry — restore access",
    PLAN_EXPIRED_D14: "Final reminder to reactivate",
  };

  const title = subjectMap[type];
  if (!title) return null;

  const msgByType = {
    TRIAL_D7: `Your trial ends on <b>${endISO}</b>.`,
    TRIAL_D1: `Reminder: your trial ends tomorrow (<b>${endISO}</b>).`,
    TRIAL_D0: `Your trial ends today (<b>${endISO}</b>).`,
    TRIAL_ENDED: `Your trial ended on <b>${endISO}</b>.`,

    PLAN_D7: `Your <b>${plan?.name || "plan"}</b> renews/expires on <b>${endISO}</b>.`,
    PLAN_D1: `Your <b>${plan?.name || "plan"}</b> expires tomorrow (<b>${endISO}</b>).`,
    PLAN_D0: `Your <b>${plan?.name || "plan"}</b> expires today (<b>${endISO}</b>).`,
    PLAN_EXPIRED: `Your subscription expired on <b>${endISO}</b>.`,

    PLAN_EXPIRED_D3: `Your subscription is still inactive.`,
    PLAN_EXPIRED_D7: `It’s been <b>7 days</b> since your plan expired.`,
    PLAN_EXPIRED_D14: `Final reminder: renew to continue using all admin features.`,
  };

  const ctaTextByType = {
    TRIAL_D7: "Login to upgrade",
    TRIAL_D1: "Login to choose a plan",
    TRIAL_D0: "Login to upgrade",
    TRIAL_ENDED: "Login to restore access",

    PLAN_D7: "Login to manage billing",
    PLAN_D1: "Login to renew",
    PLAN_D0: "Login to renew",
    PLAN_EXPIRED: "Login to renew",

    PLAN_EXPIRED_D3: "Login to reactivate",
    PLAN_EXPIRED_D7: "Login to renew",
    PLAN_EXPIRED_D14: "Login to renew",
  };

  const message = msgByType[type];
  const ctaText = ctaTextByType[type];
  const preheader = title;

  const html = `
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">
  ${preheader}
</div>

<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0;padding:0;background:#f6f8fb;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #e6e8ef;border-radius:12px;">
        <tr>
          <td style="padding:20px 24px;border-bottom:1px solid #eef1f6;">
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:18px;line-height:24px;color:#111827;font-weight:700;">
              ${title}
            </div>
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;color:#6b7280;margin-top:6px;">
              ${clinic?.name || "Clinic"} • Admin notifications
            </div>
          </td>
        </tr>

        <tr>
          <td style="padding:20px 24px;">
            <p style="margin:0 0 12px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#111827;">
              Hi ${clinic?.name || "there"},
            </p>

            <p style="margin:0 0 16px 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:22px;color:#374151;">
              ${message}
            </p>

            <table role="presentation" cellspacing="0" cellpadding="0" border="0">
              <tr>
                <td bgcolor="#2563eb" style="border-radius:10px;">
                  <a href="${loginLink}"
                     target="_blank"
                     style="display:inline-block;padding:12px 18px;font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px;border:1px solid #2563eb;">
                    ${ctaText}
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:16px 0 0 0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;">
              If the button doesn’t work, copy and paste this link:<br/>
              <a href="${loginLink}" target="_blank" style="color:#2563eb;text-decoration:underline;word-break:break-all;">
                ${loginLink}
              </a>
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:14px 24px;background:#f9fafb;border-top:1px solid #eef1f6;border-bottom-left-radius:12px;border-bottom-right-radius:12px;">
            <p style="margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;line-height:18px;color:#6b7280;">
              © ${new Date().getFullYear()} ${process.env.PRODUCT_NAME || "Your Product"}.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
`;
  return { subject: title, html };
}

export function startSubscriptionEmailCron() {
  console.log("🚀 subscription email cron scheduled");

  // Run once per day at 09:00 IST (recommended for this use-case)
  // node-cron supports timezone option for evaluating the schedule in that timezone. [web:33][web:44]
  cron.schedule(
    "0 9 * * *",
    async () => {
      const runAt = new Date();
      console.log("🕘 running subscription email job", runAt);

      try {
        const today = startOfDay(new Date());

        const subs = await prisma.subscription.findMany({
          where: {
            deletedAt: null,
            endDate: { not: null },
          },
          include: {
            clinic: { select: { id: true, name: true } },
            plan: { select: { id: true, name: true } },
          },
        });

        for (const s of subs) {
          // recipient: clinic ADMIN email
          const admin = await prisma.user.findFirst({
            where: { clinicId: s.clinicId, role: "ADMIN", deletedAt: null },
            select: { id: true, email: true, name: true },
          });
          if (!admin?.email) continue;

          const end = startOfDay(new Date(s.endDate));
          const diffDays = daysBetween(end, today); // end - today
          const endISO = end.toISOString().slice(0, 10);

          const sendEvent = async (type) => {
            const key = `${type}:${s.id}:${endISO}`;
            if (await alreadySentEmail(s.clinicId, key)) return;

            const tpl = buildTemplate(type, {
              sub: s,
              admin,
              clinic: s.clinic,
              plan: s.plan,
              endISO,
            });
            if (!tpl) return;

            // Nodemailer-style sending: pass HTML via "html" field. [web:40]
            await sendEmail1({ to: admin.email, subject: tpl.subject, html: tpl.html });

            await markEmailSent({
              clinicId: s.clinicId,
              userId: admin.id,
              key,
              details: { subId: s.id, type, endISO },
            });
          };

          // ---------- TRIAL conditions ----------
          if (s.isTrial) {
            if (diffDays === 7) await sendEvent("TRIAL_D7");
            if (diffDays === 1) await sendEvent("TRIAL_D1");
            if (diffDays === 0) await sendEvent("TRIAL_D0");

            // send "ended" only once: first day after endDate
            if (diffDays === -1) await sendEvent("TRIAL_ENDED");
            continue;
          }

          // ---------- PAID plan conditions ----------
          if (diffDays === 7) await sendEvent("PLAN_D7");
          if (diffDays === 1) await sendEvent("PLAN_D1");
          if (diffDays === 0) await sendEvent("PLAN_D0");

          // send "expired" only once: first day after endDate
          if (diffDays === -1) await sendEvent("PLAN_EXPIRED");

          // Win-back reminders after expiry
          if (diffDays === -3) await sendEvent("PLAN_EXPIRED_D3");
          if (diffDays === -7) await sendEvent("PLAN_EXPIRED_D7");
          if (diffDays === -14) await sendEvent("PLAN_EXPIRED_D14");
        }
      } catch (err) {
        console.error("❌ subscription email cron failed:", err);
      }
    },
    { timezone: "Asia/Kolkata" }
  );
}
