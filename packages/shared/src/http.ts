import { z } from "zod";
import type { AppRole, JwtClaims } from "./types.js";
import { verifyAccessToken } from "./auth.js";

const strongPassword = z.string().min(8).refine(
  (p) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p) && /[#$&@!%*?^+=._-]/.test(p),
  "Use a strong password: 8+ chars, upper & lower case, number, and symbol (#$&@!)",
);

export const registerBodySchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  role: z.enum(["rider", "driver", "partner", "agent"]),
  fullName: z.string().optional(),
}).transform((data) => ({
  ...data,
  role: data.role === "agent" ? "partner" : data.role,
}));

export const sendOtpBodySchema = z.object({
  phone: z.string().min(10).max(20),
  portal: z.enum(["rider", "driver", "agent"]),
}).transform((data) => ({
  ...data,
  portal: data.portal === "agent" ? "partner" : data.portal,
}));

export const verifyOtpBodySchema = z.object({
  phone: z.string().min(10).max(20),
  code: z.string().length(6),
  portal: z.enum(["rider", "driver", "agent"]),
}).transform((data) => ({
  ...data,
  portal: data.portal === "agent" ? "partner" : data.portal,
}));

export const googleAuthBodySchema = z.object({
  code: z.string().min(1),
  redirectUri: z.string().url(),
  portal: z.enum(["rider", "driver", "agent"]),
}).transform((data) => ({
  ...data,
  portal: data.portal === "agent" ? "partner" : data.portal,
}));

export const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  portal: z.enum(["rider", "driver", "partner", "admin", "agent"]).optional(),
}).transform((data) => ({
  ...data,
  portal: data.portal === "agent" ? "partner" : data.portal,
}));

export const forgotPasswordBodySchema = z.object({
  email: z.string().email(),
  portal: z.enum(["rider", "driver", "partner", "admin"]).optional(),
});

export const resetPasswordBodySchema = z.object({
  token: z.string().min(1),
  password: strongPassword,
  portal: z.enum(["rider", "driver", "partner", "admin"]).optional(),
});

export const adminChangePasswordBodySchema = z.object({
  newPassword: strongPassword,
  sendEmail: z.boolean().optional().default(true),
});

export const createUserBodySchema = z.object({
  email: z.string().email(),
  password: strongPassword,
  role: z.enum(["rider", "driver", "partner", "partner_employee", "admin", "agent"]),
  fullName: z.string().optional(),
  phone: z.string().optional(),
  ndisId: z.string().optional(),
  orgName: z.string().optional(),
  vehicleRego: z.string().optional(),
}).transform((data) => ({
  ...data,
  role: data.role === "agent" ? "partner_employee" : data.role,
}));

export function getBearerToken(authHeader?: string) {
  if (!authHeader) return null;
  const [type, token] = authHeader.split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return null;
  return token;
}

export function requireAuth(authHeader?: string): JwtClaims {
  const token = getBearerToken(authHeader);
  if (!token) throw new Error("Unauthorized");
  return verifyAccessToken(token);
}

export function requireRole(claims: JwtClaims, roles: AppRole[]) {
  if (claims.roles.includes("admin")) return;
  const allowed = claims.roles.some((r: AppRole) => roles.includes(r));
  if (!allowed) throw new Error("Forbidden");
}

