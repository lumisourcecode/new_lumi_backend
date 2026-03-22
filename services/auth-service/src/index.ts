import "dotenv/config";
import express from "express";
import cors from "cors";

import crypto from "node:crypto";
import {
  buildResetLink,
  googleAuthBodySchema,
  hashPassword,
  forgotPasswordBodySchema,
  loginBodySchema,
  pool,
  registerBodySchema,
  resetPasswordBodySchema,
  requireAuth,
  sendPasswordResetEmail,
  sendOtpBodySchema,
  sendSms,
  signAccessToken,
  verifyOtpBodySchema,
  verifyPassword,
} from "@lumi/shared";

const app = express();
const port = Number(process.env.AUTH_SERVICE_PORT ?? 4100);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

function normalizeRoles(rawRoles: string[]) {
  // Keep backward compatibility with legacy "agent" users.
  return Array.from(new Set(rawRoles.map((role) => (role === "agent" ? "partner" : role))));
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "auth-service" });
});

app.post("/auth/register", async (req, res) => {
  try {
    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.errors[0];
      const msg = first?.message ?? "Invalid input";
      return res.status(400).json({ error: msg, details: parsed.error.flatten() });
    }

    const { email, password, fullName } = parsed.data;
    const role = parsed.data.role === "agent" ? "partner" : parsed.data.role;
    if (role === "admin") {
      return res.status(403).json({ error: "Admin accounts cannot be created via registration. Contact super admin." });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existing = await pool.query("select id from users where email = $1", [normalizedEmail]);
    let userId: string;
    let roles: string[];

    if (existing.rowCount && existing.rows[0]?.id) {
      userId = existing.rows[0].id as string;
      const roleCheck = await pool.query(
        "select role from user_roles where user_id = $1 and role = $2",
        [userId, role],
      );
      if (roleCheck.rowCount) {
        return res.status(409).json({ error: `Already registered as ${role}. Sign in instead.` });
      }
      await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, role]);
      const allRoles = await pool.query(
        "select role from user_roles where user_id = $1 order by role",
        [userId],
      );
      roles = allRoles.rows.map((r: { role: string }) => r.role);
    } else {
      const passwordHash = await hashPassword(password);
      const inserted = await pool.query(
        "insert into users (email, password_hash) values ($1, $2) returning id, email",
        [normalizedEmail, passwordHash],
      );
      userId = inserted.rows[0].id as string;
      await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, role]);
      roles = [role];
    }

    if (role === "rider") {
      await pool.query(
        "insert into rider_profiles (user_id, full_name) values ($1, $2) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, rider_profiles.full_name)",
        [userId, fullName ?? null],
      );
    } else if (role === "driver") {
      await pool.query(
        "insert into driver_profiles (user_id, full_name) values ($1, $2) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, driver_profiles.full_name)",
        [userId, fullName ?? null],
      );
    } else if (role === "partner") {
      await pool.query(
        "insert into partner_profiles (user_id, contact_name) values ($1, $2) on conflict (user_id) do update set contact_name = coalesce(excluded.contact_name, partner_profiles.contact_name)",
        [userId, fullName ?? null],
      );
    }

    const token = signAccessToken({ sub: userId, roles, tenantId: null });
    return res.status(201).json({
      accessToken: token,
      user: { id: userId, email: normalizedEmail, roles },
    });
  } catch (error) {
    console.error("[auth-service] Register error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post("/auth/login", async (req, res) => {
  try {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    }

    const { email, password } = parsed.data;
    const portal = parsed.data.portal === "agent" ? "partner" : parsed.data.portal;
    const normalizedEmail = email.toLowerCase().trim();

    const userRes = await pool.query(
      "select id, email, password_hash, is_active from users where email = $1",
      [normalizedEmail],
    );

    if (!userRes.rowCount) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const user = userRes.rows[0] as {
      id: string;
      email: string;
      password_hash: string;
      is_active: boolean;
    };

    if (!user.is_active) {
      return res.status(403).json({ error: "Account is disabled" });
    }

    const ok = await verifyPassword(user.password_hash, password);
    if (!ok) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    // Backfill legacy role rows at login so old partner accounts still work.
    await pool.query(
      `delete from user_roles
       where user_id = $1 and role = 'agent'
       and exists (select 1 from user_roles ur2 where ur2.user_id = $1 and ur2.role = 'partner')`,
      [user.id],
    );
    await pool.query("update user_roles set role = 'partner' where user_id = $1 and role = 'agent'", [user.id]);
    const roleRes = await pool.query("select role from user_roles where user_id = $1 order by role asc", [user.id]);
    const roles = normalizeRoles(roleRes.rows.map((r: { role: string }) => r.role)) as Array<"rider" | "driver" | "partner" | "admin">;

    if (portal && !roles.includes(portal)) {
      return res.status(403).json({
        error: `Not registered for ${portal}. Register from the ${portal} portal first.`,
      });
    }

    const token = signAccessToken({ sub: user.id, roles, tenantId: null });
    return res.json({
      accessToken: token,
      user: { id: user.id, email: user.email, roles },
    });
  } catch (error) {
    console.error("[auth-service] Login error:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

app.get("/auth/me", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    const userRes = await pool.query("select id, email from users where id = $1", [claims.sub]);
    if (!userRes.rowCount) return res.status(404).json({ error: "User not found" });
    return res.json({
      user: { id: userRes.rows[0].id as string, email: userRes.rows[0].email as string, roles: claims.roles },
    });
  } catch (error) {
    console.error("[auth-service] /me error:", error);
    return res.status(401).json({ error: "Unauthorized" });
  }
});

app.post("/auth/refresh", (_req, res) => {
  // Placeholder for refresh token rotation (can be added next).
  return res.status(501).json({ error: "Not implemented yet" });
});

app.post("/auth/logout", (_req, res) => {
  return res.status(204).send();
});

app.post("/auth/google", async (req, res) => {
  const parsed = googleAuthBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { code, redirectUri } = parsed.data;
  const portal = parsed.data.portal === "agent" ? "partner" : parsed.data.portal;
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({ error: "Google sign-in is not configured. Use email." });
  }

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    return res.status(400).json({ error: "Google auth failed", details: err });
  }
  const tokens = (await tokenRes.json()) as { access_token?: string };
  const accessToken = tokens.access_token;
  if (!accessToken) {
    return res.status(400).json({ error: "No access token from Google" });
  }

  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!userRes.ok) {
    return res.status(400).json({ error: "Failed to get Google user info" });
  }
  const googleUser = (await userRes.json()) as { id: string; email: string; name?: string };

  const normalizedEmail = googleUser.email?.toLowerCase()?.trim();
  if (!normalizedEmail) {
    return res.status(400).json({ error: "Google account has no email" });
  }

  let userId: string;
  let roles: string[];

  const existingByGoogle = await pool.query(
    "select id from users where google_id = $1",
    [googleUser.id],
  );
  if (existingByGoogle.rowCount && existingByGoogle.rows[0]?.id) {
    userId = existingByGoogle.rows[0].id as string;
  } else {
    const existingByEmail = await pool.query("select id from users where email = $1", [normalizedEmail]);
    if (existingByEmail.rowCount && existingByEmail.rows[0]?.id) {
      userId = existingByEmail.rows[0].id as string;
      await pool.query("update users set google_id = $2 where id = $1", [userId, googleUser.id]);
    } else {
      const placeholderHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
      const inserted = await pool.query(
        "insert into users (email, password_hash, google_id) values ($1, $2, $3) returning id",
        [normalizedEmail, placeholderHash, googleUser.id],
      );
      userId = inserted.rows[0].id as string;
      await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, portal]);
      if (portal === "rider") {
        await pool.query(
          "insert into rider_profiles (user_id, full_name) values ($1, $2) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, rider_profiles.full_name)",
          [userId, googleUser.name ?? null],
        );
      } else if (portal === "driver") {
        await pool.query(
          "insert into driver_profiles (user_id, full_name) values ($1, $2) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, driver_profiles.full_name)",
          [userId, googleUser.name ?? null],
        );
      }
    }
  }

  const roleRes = await pool.query(
    "select role from user_roles where user_id = $1 order by role asc",
    [userId],
  );
  roles = normalizeRoles(roleRes.rows.map((r: { role: string }) => r.role));

  if (!roles.includes(portal)) {
    await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, portal]);
    roles = [...roles, portal];
    if (portal === "rider") {
      await pool.query(
        "insert into rider_profiles (user_id, full_name) values ($1, $2) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, rider_profiles.full_name)",
        [userId, googleUser.name ?? null],
      );
    } else if (portal === "driver") {
      await pool.query(
        "insert into driver_profiles (user_id, full_name) values ($1, $2) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, driver_profiles.full_name)",
        [userId, googleUser.name ?? null],
      );
    }
  }

  const token = signAccessToken({ sub: userId, roles, tenantId: null });
  return res.json({
    accessToken: token,
    user: { id: userId, email: normalizedEmail, roles },
  });
});

app.post("/auth/send-otp", async (req, res) => {
  const parsed = sendOtpBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid phone", details: parsed.error.flatten() });
  }
  const { phone } = parsed.data;
  const portal = parsed.data.portal === "agent" ? "partner" : parsed.data.portal;
  const code = crypto.randomInt(100000, 999999).toString();
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  await pool.query(
    "insert into phone_otps (phone, code_hash, portal, expires_at) values ($1, $2, $3, $4)",
    [phone, codeHash, portal, expiresAt],
  );

  await sendSms(phone, `Your Lumi Ride verification code is ${code}. Valid for 10 minutes.`);
  // With Twilio test credentials no real SMS is sent; log code in dev so you can complete sign-in
  if (process.env.NODE_ENV !== "production" || process.env.LOG_OTP === "true") {
    console.log(`[OTP] ${phone} → code: ${code} (valid 10 min)`);
  }
  return res.json({ message: "Verification code sent" });
});

app.post("/auth/verify-otp", async (req, res) => {
  const parsed = verifyOtpBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
  }
  const { phone, code } = parsed.data;
  const portal = parsed.data.portal === "agent" ? "partner" : parsed.data.portal;
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");

  const row = await pool.query(
    "select id from phone_otps where phone = $1 and code_hash = $2 and portal = $3 and expires_at > now() order by created_at desc limit 1",
    [phone, codeHash, portal],
  );
  if (!row.rowCount) {
    return res.status(400).json({ error: "Invalid or expired code" });
  }

  const existingUser = await pool.query(
    "select id from users where phone = $1",
    [phone],
  );
  let userId: string;
  let roles: string[];

  if (existingUser.rowCount && existingUser.rows[0]?.id) {
    userId = existingUser.rows[0].id as string;
    const roleRes = await pool.query(
      "select role from user_roles where user_id = $1 order by role asc",
      [userId],
    );
    roles = normalizeRoles(roleRes.rows.map((r: { role: string }) => r.role));
    if (!roles.includes(portal)) {
      await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, portal]);
      roles = [...roles, portal];
      if (portal === "rider") {
        await pool.query(
          "insert into rider_profiles (user_id) values ($1) on conflict (user_id) do nothing",
          [userId],
        );
      } else if (portal === "driver") {
        await pool.query(
          "insert into driver_profiles (user_id) values ($1) on conflict (user_id) do nothing",
          [userId],
        );
      }
    }
  } else {
    const placeholderHash = await hashPassword(crypto.randomBytes(32).toString("hex"));
    const inserted = await pool.query(
      "insert into users (email, password_hash, phone) values ($1, $2, $3) returning id",
      [`phone_${phone}@lumiride.phone`, placeholderHash, phone],
    );
    userId = inserted.rows[0].id as string;
    await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, portal]);
    roles = [portal];
    if (portal === "rider") {
      await pool.query("insert into rider_profiles (user_id) values ($1)", [userId]);
    } else if (portal === "driver") {
      await pool.query("insert into driver_profiles (user_id) values ($1)", [userId]);
    }
  }

  await pool.query("delete from phone_otps where phone = $1 and portal = $2", [phone, portal]);

  const emailRes = await pool.query("select email from users where id = $1", [userId]);
  const email = emailRes.rows[0]?.email as string;

  const token = signAccessToken({ sub: userId, roles, tenantId: null });
  return res.json({
    accessToken: token,
    user: { id: userId, email, roles },
  });
});

app.post("/auth/forgot-password", async (req, res) => {
  const parsed = forgotPasswordBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid email", details: parsed.error.flatten() });
  }
  const { email } = parsed.data;
  const portal = parsed.data.portal === "agent" ? "partner" : parsed.data.portal;
  const normalizedEmail = email.toLowerCase().trim();

  const userRes = await pool.query(
    "select id, email from users where email = $1",
    [normalizedEmail],
  );
  if (!userRes.rowCount) {
    return res.json({ message: "If that email exists, we sent a reset link." });
  }

  const userId = userRes.rows[0].id as string;
  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

  await pool.query(
    "insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, $3)",
    [userId, tokenHash, expiresAt],
  );

  const resetLink = buildResetLink(rawToken, portal);
  await sendPasswordResetEmail(normalizedEmail, resetLink);

  return res.json({ message: "If that email exists, we sent a reset link." });
});

app.post("/auth/reset-password", async (req, res) => {
  const parsed = resetPasswordBodySchema.safeParse(req.body);
  if (!parsed.success) {
    const first = parsed.error.errors[0];
    return res.status(400).json({ error: first?.message ?? "Invalid input", details: parsed.error.flatten() });
  }
  const { token, password } = parsed.data;
  const portal = parsed.data.portal === "agent" ? "partner" : parsed.data.portal;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const row = await pool.query(
    `select prt.user_id, u.email from password_reset_tokens prt
     join users u on u.id = prt.user_id
     where prt.token_hash = $1 and prt.expires_at > now() and prt.used_at is null`,
    [tokenHash],
  );
  if (!row.rowCount) {
    return res.status(400).json({ error: "Invalid or expired reset link. Request a new one." });
  }

  
  const userId = row.rows[0].user_id as string;
  const passwordHash = await hashPassword(password);

  await pool.query("update users set password_hash = $2 where id = $1", [userId, passwordHash]);
  await pool.query(
    "update password_reset_tokens set used_at = now() where token_hash = $1",
    [tokenHash],
  );

  const roleRes = await pool.query(
    "select role from user_roles where user_id = $1 order by role asc",
    [userId],
  );
  const roles = normalizeRoles(roleRes.rows.map((r: { role: string }) => r.role));
  const email = row.rows[0].email as string;

  if (portal && !roles.includes(portal)) {
    return res.status(403).json({
      error: `Not registered for ${portal}. Use the correct portal.`,
    });
  }

  const accessToken = signAccessToken({ sub: userId, roles, tenantId: null });
  return res.json({
    accessToken,
    user: { id: userId, email, roles },
  });
});

app.listen(port, () => {
  console.log(`auth-service listening on ${port}`);
});

