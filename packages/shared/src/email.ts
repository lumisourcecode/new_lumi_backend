import "dotenv/config";
import nodemailer from "nodemailer";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM ?? "Lumi Ride <noreply@lumiride.com.au>";

function getTransporter() {
  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    return nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return null;
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const transporter = getTransporter();
  const html = `
    <p>You requested a password reset for your Lumi Ride account.</p>
    <p><a href="${resetLink}">Reset your password</a></p>
    <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
  `;
  if (transporter) {
    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject: "Reset your Lumi Ride password",
      html,
    });
  } else {
    console.log("[DEV] Password reset email (no SMTP):", { to, resetLink });
  }
}

export async function sendNewPasswordEmail(to: string, newPassword: string): Promise<void> {
  const transporter = getTransporter();
  const html = `
    <p>Your Lumi Ride account password has been updated by an administrator.</p>
    <p><strong>New password:</strong> ${newPassword}</p>
    <p>Please sign in and change your password in profile settings.</p>
  `;
  if (transporter) {
    await transporter.sendMail({
      from: SMTP_FROM,
      to,
      subject: "Your Lumi Ride password has been updated",
      html,
    });
  } else {
    console.log("[DEV] New password email (no SMTP):", { to, newPassword });
  }
}

export function buildResetLink(token: string, portal?: string): string {
  const base = FRONTEND_URL.replace(/\/$/, "");
  const path = portal ? `/reset-password?token=${token}&portal=${portal}` : `/reset-password?token=${token}`;
  return `${base}${path}`;
}
