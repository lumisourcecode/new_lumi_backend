import "dotenv/config";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import type { JwtClaims } from "./types.js";

const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL ?? "15m";

export async function hashPassword(password: string) {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}

export function signAccessToken(claims: JwtClaims) {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: ACCESS_TOKEN_TTL as any });
}

export function verifyAccessToken(token: string): JwtClaims {
  return jwt.verify(token, JWT_SECRET) as JwtClaims;
}

