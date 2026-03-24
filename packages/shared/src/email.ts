import nodemailer from "nodemailer";
import { pool } from "./db/client.js";

const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";
const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT ?? 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;
const SMTP_FROM = process.env.SMTP_FROM ?? "Lumi Ride <noreply@lumiride.com.au>";

type EmailContext = {
  partnerId?: string;
};

type ResolvedSmtp = {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
  secure: boolean;
} | null;

async function resolveSmtpConfig(context?: EmailContext): Promise<ResolvedSmtp> {
  if (context?.partnerId) {
    const tenant = await pool.query(
      `select smtp_enabled, smtp_host, smtp_port, smtp_username, smtp_password, smtp_from_email, smtp_from_name, smtp_secure_mode
       from partner_tenant_settings where partner_id = $1`,
      [context.partnerId],
    );
    if (tenant.rowCount) {
      const row = tenant.rows[0] as Record<string, unknown>;
      if (row.smtp_enabled && row.smtp_host && row.smtp_username && row.smtp_password) {
        const mode = String(row.smtp_secure_mode ?? "tls");
        const fromEmail = String(row.smtp_from_email ?? "").trim();
        const fromName = String(row.smtp_from_name ?? "").trim();
        return {
          host: String(row.smtp_host),
          port: Number(row.smtp_port ?? 587),
          user: String(row.smtp_username),
          pass: String(row.smtp_password),
          from: fromEmail ? (fromName ? `${fromName} <${fromEmail}>` : fromEmail) : SMTP_FROM,
          secure: mode === "ssl" || Number(row.smtp_port ?? 587) === 465,
        };
      }
    }
  }

  const admin = await pool.query(
    `select host, port, username, password, from_name, from_email, secure_mode, is_active
     from admin_smtp_settings where id = 1`,
  );
  if (admin.rowCount) {
    const row = admin.rows[0] as Record<string, unknown>;
    if (row.is_active && row.host && row.username && row.password) {
      const fromEmail = String(row.from_email ?? "").trim();
      const fromName = String(row.from_name ?? "").trim();
      return {
        host: String(row.host),
        port: Number(row.port ?? 587),
        user: String(row.username),
        pass: String(row.password),
        from: fromEmail ? (fromName ? `${fromName} <${fromEmail}>` : fromEmail) : SMTP_FROM,
        secure: String(row.secure_mode ?? "tls") === "ssl" || Number(row.port ?? 587) === 465,
      };
    }
  }

  if (SMTP_HOST && SMTP_USER && SMTP_PASS) {
    return {
      host: SMTP_HOST,
      port: SMTP_PORT,
      user: SMTP_USER,
      pass: SMTP_PASS,
      from: SMTP_FROM,
      secure: SMTP_PORT === 465,
    };
  }
  return null;
}

async function getTransporter(context?: EmailContext) {
  const cfg = await resolveSmtpConfig(context);
  if (cfg) {
    return nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      // Avoid hanging the admin SMTP test (and nginx 504) on bad host/firewall
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return null;
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const transporter = await getTransporter();
  const html = `
    <p>You requested a password reset for your Lumi Ride account.</p>
    <p><a href="${resetLink}">Reset your password</a></p>
    <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>
  `;
  if (transporter) {
    await transporter.sendMail({
      from: (await resolveSmtpConfig())?.from ?? SMTP_FROM,
      to,
      subject: "Reset your Lumi Ride password",
      html,
    });
  } else {
    console.log("[DEV] Password reset email (no SMTP):", { to, resetLink });
  }
}

export async function sendNewPasswordEmail(to: string, newPassword: string): Promise<void> {
  const transporter = await getTransporter();
  const html = `
    <p>Your Lumi Ride account password has been updated by an administrator.</p>
    <p><strong>New password:</strong> ${newPassword}</p>
    <p>Please sign in and change your password in profile settings.</p>
  `;
  if (transporter) {
    await transporter.sendMail({
      from: (await resolveSmtpConfig())?.from ?? SMTP_FROM,
      to,
      subject: "Your Lumi Ride password has been updated",
      html,
    });
  } else {
    console.log("[DEV] New password email (no SMTP):", { to, newPassword });
  }
}

export async function sendGenericEmail(input: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  partnerId?: string;
}) {
  const context = input.partnerId ? { partnerId: input.partnerId } : undefined;
  const transporter = await getTransporter(context);
  const cfg = await resolveSmtpConfig(context);
  if (!transporter || !cfg) {
    console.log("[DEV] Generic email (no SMTP):", { to: input.to, subject: input.subject });
    return { delivered: false, mode: "fallback_log" as const };
  }
  await transporter.sendMail({
    from: cfg.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
  return { delivered: true, mode: "smtp" as const };
}

export function buildResetLink(token: string, portal?: string): string {
  const base = FRONTEND_URL.replace(/\/$/, "");
  const path = portal ? `/reset-password?token=${token}&portal=${portal}` : `/reset-password?token=${token}`;
  return `${base}${path}`;
}
