"use strict";
/**
 * Email utility — logs links to console during development.
 * Swap the `sendEmail` function for a real Nodemailer transport
 * (Gmail / Resend / SendGrid) when deploying.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendVerificationEmail = sendVerificationEmail;
exports.sendPasswordResetEmail = sendPasswordResetEmail;
exports.sendNotificationEmail = sendNotificationEmail;
// ── Transport ─────────────────────────────────────────────────────────────────
async function sendEmail(payload) {
    // DEVELOPMENT: log to console instead of sending real email.
    // Replace this block with a real Nodemailer transporter when ready.
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
// ── Templates ─────────────────────────────────────────────────────────────────
async function sendVerificationEmail(email, name, token) {
    const link = `${process.env.FRONTEND_URL}/verify-email?token=${token}`;
    await sendEmail({
        to: email,
        subject: "Verify your ServiceHub Cordova account",
        html: `
      <div style="font-family: sans-serif; max-width: 480px;">
        <h2>Welcome to ServiceHub Cordova, ${name}!</h2>
        <p>Click the button below to verify your email address.</p>
        <a href="${link}" style="
          display: inline-block;
          background: #059669;
          color: white;
          padding: 12px 24px;
          border-radius: 8px;
          text-decoration: none;
          font-weight: bold;
          margin: 16px 0;
        ">Verify Email</a>
        <p style="color: #6b7280; font-size: 12px;">
          This link expires in 24 hours. If you did not create this account, ignore this email.
        </p>
        <p style="color: #6b7280; font-size: 12px;">Or copy: ${link}</p>
      </div>
    `,
    });
}
async function sendPasswordResetEmail(email, name, token) {
    const link = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;
    await sendEmail({
        to: email,
        subject: "Reset your ServiceHub Cordova password",
        html: `
      <div style="font-family: sans-serif; max-width: 480px;">
        <h2>Password Reset Request</h2>
        <p>Hi ${name}, click the button below to reset your password.</p>
        <a href="${link}" style="
          display: inline-block;
          background: #dc2626;
          color: white;
          padding: 12px 24px;
          border-radius: 8px;
          text-decoration: none;
          font-weight: bold;
          margin: 16px 0;
        ">Reset Password</a>
        <p style="color: #6b7280; font-size: 12px;">
          This link expires in 30 minutes. If you did not request this, ignore this email.
        </p>
        <p style="color: #6b7280; font-size: 12px;">Or copy: ${link}</p>
      </div>
    `,
    });
}
async function sendNotificationEmail(email, name, title, body) {
    await sendEmail({
        to: email,
        subject: `ServiceHub: ${title}`,
        html: `
      <div style="font-family: sans-serif; max-width: 480px;">
        <h2>${title}</h2>
        <p>Hi ${name},</p>
        <p>${body}</p>
        <p style="color: #6b7280; font-size: 12px;">
          — ServiceHub Cordova
        </p>
      </div>
    `,
    });
}
//# sourceMappingURL=email.js.map