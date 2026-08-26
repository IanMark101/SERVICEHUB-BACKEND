/**
 * Email utility — logs links to console during development.
 * Swap the `sendEmail` function for a real Nodemailer transport
 * (Gmail / Resend / SendGrid) when deploying.
 */

import nodemailer from "nodemailer";
import { env } from "../config/env";

interface EmailPayload {
  to: string;
  subject: string;
  html: string;
}

// ── Transport ─────────────────────────────────────────────────────────────────

const smtpHost = env.SMTP_HOST;
const smtpPort = Number(env.SMTP_PORT || 587);
const smtpUser = env.SMTP_USER;
const smtpPass = env.SMTP_PASS ? env.SMTP_PASS.replace(/\s+/g, "") : "";
const emailFrom = smtpUser ? `ServiceHub Cordova <${smtpUser}>` : (env.EMAIL_FROM || "no-reply@servicehub.com");

let transporter: nodemailer.Transporter | null = null;
if (smtpHost && smtpUser && smtpPass) {
  if (smtpHost.toLowerCase().includes("gmail")) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
  } else {
    transporter = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass,
      },
    });
  }
}

async function sendEmail(payload: EmailPayload): Promise<void> {
  if (transporter) {
    try {
      await transporter.sendMail({
        from: emailFrom,
        to: payload.to,
        subject: payload.subject,
        html: payload.html,
      });
      console.log(`[Email Engine] Sent email successfully to ${payload.to}`);
      return;
    } catch (error: any) {
      console.error(`[Email Engine] Failed to send email to ${payload.to}:`, error?.message || error);
    }
  }

  // DEVELOPMENT Fallback: log to console
  console.log("\n📧 ─── Email (DEV MODE — not sent) ──────────────────");
  console.log(`   TO:      ${payload.to}`);
  console.log(`   SUBJECT: ${payload.subject}`);
  console.log(`   BODY:    (HTML omitted — see link below if applicable)`);

  // Extract any URL from the HTML for easy copy-paste in dev
  const urlMatch = payload.html.match(/href="([^"]+)"/);
  if (urlMatch) {
    console.log(`   🔗 LINK: ${urlMatch[1]}`);
  }
  console.log("─────────────────────────────────────────────────────\n");
}

// ── Template Builder ──────────────────────────────────────────────────────────

function buildEmailTemplate(contentHtml: string, title: string): string {
  const currentYear = new Date().getFullYear();
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8">
        <title>${title}</title>
        <style>
          body {
            font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;
            background-color: #faf8f5;
            margin: 0;
            padding: 0;
            -webkit-font-smoothing: antialiased;
          }
          .email-container {
            max-width: 560px;
            margin: 40px auto;
            background-color: #ffffff;
            border-radius: 24px;
            overflow: hidden;
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.06);
            border: 1px solid rgba(217, 119, 87, 0.12);
          }
          .header {
            background: linear-gradient(135deg, #d97757, #c86544);
            padding: 38px 30px;
            text-align: center;
          }
          .logo {
            color: #ffffff;
            font-size: 26px;
            font-weight: 850;
            letter-spacing: -0.5px;
            margin: 0;
          }
          .logo-sub {
            color: #fcece7;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 2px;
            text-transform: uppercase;
            margin: 6px 0 0;
          }
          .content {
            padding: 40px;
            color: #334155;
            line-height: 1.6;
          }
          .content h1 {
            color: #1e293b;
            font-size: 22px;
            font-weight: 800;
            margin-top: 0;
            margin-bottom: 16px;
            letter-spacing: -0.02em;
          }
          .content p {
            font-size: 14px;
            margin-top: 0;
            margin-bottom: 20px;
            color: #475569;
          }
          .btn-container {
            text-align: center;
            margin: 32px 0;
          }
          .btn {
            display: inline-block;
            background: linear-gradient(135deg, #d97757, #c86544);
            color: #ffffff !important;
            text-decoration: none;
            font-size: 14px;
            font-weight: 700;
            padding: 14px 32px;
            border-radius: 12px;
            box-shadow: 0 6px 20px rgba(200, 101, 68, 0.35);
          }
          .footer {
            background-color: #fbfaf7;
            padding: 24px 40px;
            text-align: center;
            border-top: 1px solid #f1ebd9;
          }
          .footer p {
            color: #8b877f;
            font-size: 11px;
            margin: 0;
            line-height: 1.6;
          }
          .link-fallback {
            background-color: #faf8f5;
            padding: 12px;
            border-radius: 10px;
            font-size: 11px;
            word-break: break-all;
            color: #c86544;
            margin-top: 24px;
            border: 1px solid #ecd9d0;
          }
        </style>
      </head>
      <body>
        <div class="email-container">
          <div class="header">
            <div class="logo">ServiceHub</div>
            <div class="logo-sub">Cordova, Cebu</div>
          </div>
          <div class="content">
            ${contentHtml}
          </div>
          <div class="footer">
            <p>© ${currentYear} ServiceHub Cordova. All rights reserved.</p>
            <p style="margin-top: 4px;">Connecting Seekers and Verified Providers in Cordova, Cebu.</p>
          </div>
        </div>
      </body>
    </html>
  `;
}

// ── Templates ─────────────────────────────────────────────────────────────────

export async function sendVerificationEmail(email: string, name: string, token: string): Promise<void> {
  const link = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
  const htmlContent = `
    <h1>Verify Your Account</h1>
    <p>Hi <strong>${name}</strong>,</p>
    <p>Welcome to ServiceHub Cordova! Before you can post services or hire local providers, we need to verify your email address to ensure your account security.</p>
    <div class="btn-container">
      <a href="${link}" class="btn">Confirm Email Address</a>
    </div>
    <p>If the button doesn't work, copy and paste this URL into your browser:</p>
    <div class="link-fallback">${link}</div>
    <p style="color: #6b7280; font-size: 12px; margin-top: 20px;">This link will expire in 24 hours. If you did not create a ServiceHub account, please disregard this email.</p>
  `;
  await sendEmail({
    to: email,
    subject: "Verify your ServiceHub Cordova account",
    html: buildEmailTemplate(htmlContent, "Verify Email")
  });
}

export async function sendPasswordResetEmail(email: string, name: string, token: string): Promise<void> {
  const link = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
  const htmlContent = `
    <h1>Password Reset Request</h1>
    <p>Hi <strong>${name}</strong>,</p>
    <p>We received a request to reset the password for your ServiceHub account. Click the button below to choose a new password:</p>
    <div class="btn-container">
      <a href="${link}" class="btn">Reset Password</a>
    </div>
    <p>If the button doesn't work, copy and paste this URL into your browser:</p>
    <div class="link-fallback">${link}</div>
    <p style="color: #6b7280; font-size: 12px; margin-top: 20px;">This link will expire in 30 minutes. If you did not request a password reset, please ignore this email.</p>
  `;
  await sendEmail({
    to: email,
    subject: "Reset your ServiceHub Cordova password",
    html: buildEmailTemplate(htmlContent, "Reset Password")
  });
}

export async function sendNotificationEmail(
  email: string,
  name: string,
  title: string,
  body: string
): Promise<void> {
  const htmlContent = `
    <h1>${title}</h1>
    <p>Hi <strong>${name}</strong>,</p>
    <p>${body}</p>
    <p style="margin-top: 24px;">Best regards,<br><strong>The ServiceHub Team</strong></p>
  `;
  await sendEmail({
    to: email,
    subject: `ServiceHub: ${title}`,
    html: buildEmailTemplate(htmlContent, title)
  });
}
