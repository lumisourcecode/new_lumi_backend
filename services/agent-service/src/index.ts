import {
  AppRole,
  hashPassword,
  inferAuStateFromLocationText,
  pool,
  requireAuth,
  requireRole,
  runMigrations,
  sendGenericEmail,
} from "@lumi/shared";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.PARTNER_SERVICE_PORT ?? process.env.AGENT_SERVICE_PORT ?? 4400);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "partner-service" });
});

function parseClientInput(body: unknown) {
  const data = body as Record<string, unknown>;
  return {
    riderId: String(data?.riderId ?? "").trim(),
    email: String(data?.email ?? "").trim().toLowerCase(),
    fullName: String(data?.fullName ?? "").trim() || null,
    phone: String(data?.phone ?? "").trim() || null,
    ndisId: String(data?.ndisId ?? "").trim() || null,
    notes: String(data?.notes ?? "").trim() || null,
  };
}

async function resolvePartnerScope(claims: { sub: string; roles: AppRole[] }) {
  if (claims.roles.includes("partner")) return claims.sub;
  if (claims.roles.includes("partner_employee")) {
    const row = await pool.query(
      `select partner_id
       from partner_employees
       where employee_user_id = $1 and status = 'active'
       limit 1`,
      [claims.sub],
    );
    if (!row.rowCount) throw new Error("Forbidden");
    return row.rows[0].partner_id as string;
  }
  throw new Error("Forbidden");
}

function registerRoutes(prefix: "/partner" | "/agent") {
  app.get(`${prefix}/settings`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const profile = await pool.query(
        `select u.email, pp.org_name, pp.contact_name
         from users u
         left join partner_profiles pp on pp.user_id = u.id
         where u.id = $1`,
        [partnerId],
      );
      const tenant = await pool.query(
        `select tenant_slug, brand_name, logo_url, support_email, support_phone, smtp_host, smtp_port, smtp_username,
                smtp_from_email, smtp_from_name, smtp_secure_mode, smtp_enabled, mail_template
         from partner_tenant_settings where partner_id = $1`,
        [partnerId],
      );
      return res.json({
        ...(profile.rows[0] ?? {}),
        ...(tenant.rows[0] ?? {}),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.patch(`${prefix}/settings`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const orgName = String(req.body?.orgName ?? "").trim() || null;
      const contactName = String(req.body?.contactName ?? "").trim() || null;
      await pool.query(
        `insert into partner_profiles (user_id, org_name, contact_name)
         values ($1, $2, $3)
         on conflict (user_id) do update set
           org_name = coalesce($2, partner_profiles.org_name),
           contact_name = coalesce($3, partner_profiles.contact_name)`,
        [partnerId, orgName, contactName],
      );
      await pool.query(
        `insert into partner_tenant_settings
          (partner_id, tenant_slug, brand_name, logo_url, support_email, support_phone, smtp_host, smtp_port, smtp_username, smtp_password, smtp_from_email, smtp_from_name, smtp_secure_mode, smtp_enabled, mail_template, updated_by, updated_at)
         values
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())
         on conflict (partner_id) do update set
          tenant_slug = coalesce(excluded.tenant_slug, partner_tenant_settings.tenant_slug),
          brand_name = coalesce(excluded.brand_name, partner_tenant_settings.brand_name),
          logo_url = coalesce(excluded.logo_url, partner_tenant_settings.logo_url),
          support_email = coalesce(excluded.support_email, partner_tenant_settings.support_email),
          support_phone = coalesce(excluded.support_phone, partner_tenant_settings.support_phone),
          smtp_host = coalesce(excluded.smtp_host, partner_tenant_settings.smtp_host),
          smtp_port = coalesce(excluded.smtp_port, partner_tenant_settings.smtp_port),
          smtp_username = coalesce(excluded.smtp_username, partner_tenant_settings.smtp_username),
          smtp_password = coalesce(excluded.smtp_password, partner_tenant_settings.smtp_password),
          smtp_from_email = coalesce(excluded.smtp_from_email, partner_tenant_settings.smtp_from_email),
          smtp_from_name = coalesce(excluded.smtp_from_name, partner_tenant_settings.smtp_from_name),
          smtp_secure_mode = coalesce(excluded.smtp_secure_mode, partner_tenant_settings.smtp_secure_mode),
          smtp_enabled = coalesce(excluded.smtp_enabled, partner_tenant_settings.smtp_enabled),
          mail_template = coalesce(excluded.mail_template, partner_tenant_settings.mail_template),
          updated_by = excluded.updated_by,
          updated_at = now()`,
        [
          partnerId,
          String(req.body?.tenantSlug ?? "").trim() || null,
          String(req.body?.brandName ?? "").trim() || null,
          String(req.body?.logoUrl ?? "").trim() || null,
          String(req.body?.supportEmail ?? "").trim() || null,
          String(req.body?.supportPhone ?? "").trim() || null,
          String(req.body?.smtpHost ?? "").trim() || null,
          Number(req.body?.smtpPort ?? 587),
          String(req.body?.smtpUsername ?? "").trim() || null,
          String(req.body?.smtpPassword ?? "").trim() || null,
          String(req.body?.smtpFromEmail ?? "").trim() || null,
          String(req.body?.smtpFromName ?? "").trim() || null,
          String(req.body?.smtpSecureMode ?? "tls").trim() || "tls",
          typeof req.body?.smtpEnabled === "boolean" ? req.body.smtpEnabled : false,
          String(req.body?.mailTemplate ?? "").trim() || null,
          claims.sub,
        ],
      );
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/employees`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const rows = await pool.query(
        `select pe.id, pe.partner_id, pe.employee_user_id, pe.title, pe.status, pe.permissions, pe.invited_at, pe.created_at,
                u.email
         from partner_employees pe
         join users u on u.id = pe.employee_user_id
         where pe.partner_id = $1
         order by pe.created_at desc`,
        [partnerId],
      );
      return res.json({ items: rows.rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.post(`${prefix}/employees`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const partnerId = await resolvePartnerScope(claims);
      const email = String(req.body?.email ?? "").trim().toLowerCase();
      if (!email) return res.status(400).json({ error: "email is required" });
      const title = String(req.body?.title ?? "").trim() || null;
      const fullName = String(req.body?.fullName ?? "").trim() || null;
      let userId: string;
      const existing = await pool.query("select id from users where email = $1", [email]);
      if (existing.rowCount) {
        userId = existing.rows[0].id as string;
      } else {
        const temp = crypto.randomBytes(18).toString("hex");
        const passwordHash = await hashPassword(temp);
        const inserted = await pool.query(
          "insert into users (email, password_hash, created_by) values ($1, $2, $3) returning id",
          [email, passwordHash, claims.sub],
        );
        userId = inserted.rows[0].id as string;
      }
      await pool.query("insert into user_roles (user_id, role) values ($1, 'partner_employee') on conflict do nothing", [userId]);
      if (fullName) {
        await pool.query(
          "insert into partner_profiles (user_id, contact_name) values ($1, $2) on conflict (user_id) do update set contact_name = coalesce(excluded.contact_name, partner_profiles.contact_name)",
          [userId, fullName],
        );
      }
      const insertedEmp = await pool.query(
        `insert into partner_employees (partner_id, employee_user_id, title, permissions, status, invited_at, invited_by)
         values ($1, $2, $3, $4, 'invited', now(), $5)
         on conflict (partner_id, employee_user_id) do update set
           title = coalesce(excluded.title, partner_employees.title),
           permissions = excluded.permissions,
           status = 'invited',
           invited_at = now(),
           invited_by = excluded.invited_by,
           updated_at = now()
         returning id`,
        [partnerId, userId, title, req.body?.permissions ?? {}, claims.sub],
      );
      return res.status(201).json({ id: insertedEmp.rows[0]?.id, userId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.patch(`${prefix}/employees/:id`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      await pool.query(
        `update partner_employees set
           title = coalesce($3, title),
           permissions = coalesce($4, permissions),
           status = coalesce($5, status),
           updated_at = now()
         where id = $1 and partner_id = $2`,
        [
          req.params.id,
          partnerId,
          req.body?.title ?? null,
          req.body?.permissions ?? null,
          req.body?.status ?? null,
        ],
      );
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.delete(`${prefix}/employees/:id`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const partnerId = await resolvePartnerScope(claims);
      await pool.query("delete from partner_employees where id = $1 and partner_id = $2", [req.params.id, partnerId]);
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.post(`${prefix}/employees/:id/invite`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const partnerId = await resolvePartnerScope(claims);
      const employee = await pool.query(
        `select pe.id, pe.employee_user_id, u.email
         from partner_employees pe
         join users u on u.id = pe.employee_user_id
         where pe.id = $1 and pe.partner_id = $2`,
        [req.params.id, partnerId],
      );
      if (!employee.rowCount) return res.status(404).json({ error: "Employee not found" });
      const row = employee.rows[0] as { email: string };
      const mail = await sendGenericEmail({
        to: row.email,
        subject: "You are invited to Lumi Ride Partner Workspace",
        html: "<p>You were invited to collaborate in your partner workspace. Please login to continue.</p>",
        text: "You were invited to collaborate in your partner workspace. Please login to continue.",
        partnerId,
      });
      await pool.query(
        "update partner_employees set status = 'invited', invited_at = now(), invited_by = $2, updated_at = now() where id = $1",
        [req.params.id, claims.sub],
      );
      return res.json({ ok: true, mail });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.post(`${prefix}/mail/send`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const to = String(req.body?.to ?? "").trim();
      const subject = String(req.body?.subject ?? "").trim();
      const message = String(req.body?.message ?? "").trim();
      if (!to || !subject || !message) return res.status(400).json({ error: "to, subject, message are required" });
      const result = await sendGenericEmail({
        to,
        subject,
        html: `<p>${message.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`,
        text: message,
        partnerId,
      });
      return res.json({ ok: true, result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/profile`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const result = await pool.query(
        `select u.email, pp.org_name, pp.contact_name
         from users u
         left join partner_profiles pp on pp.user_id = u.id
         where u.id = $1`,
        [claims.sub],
      );
      if (!result.rowCount) return res.status(404).json({ error: "Profile not found" });
      const row = result.rows[0] as { email: string; org_name: string | null; contact_name: string | null };
      return res.json({ email: row.email, orgName: row.org_name ?? "", contactName: row.contact_name ?? "" });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.patch(`${prefix}/profile`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const orgName = String(req.body?.orgName ?? "").trim() || null;
      const contactName = String(req.body?.contactName ?? "").trim() || null;
      await pool.query(
        `insert into partner_profiles (user_id, org_name, contact_name)
         values ($1, $2, $3)
         on conflict (user_id) do update set
           org_name = coalesce($2, partner_profiles.org_name),
           contact_name = coalesce($3, partner_profiles.contact_name)`,
        [claims.sub, orgName, contactName],
      );
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/stats`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const today = new Date().toISOString().slice(0, 10);
      const clientsCount = await pool.query("select count(*) from partner_clients where partner_id = $1", [partnerId]);
      const ridesToday = await pool.query(
        `select count(*) from bookings b where b.created_by = $1 and b.scheduled_at::date = $2`,
        [partnerId, today],
      );
      const inTransit = await pool.query(
        `select count(*) from trips t
         join bookings b on b.id = t.booking_id and b.created_by = $1
         where t.state not in ('Completed', 'Cancelled') and t.driver_id is not null`,
        [partnerId],
      );
      const pending = await pool.query(
        `select count(*) from trips t
         join bookings b on b.id = t.booking_id and b.created_by = $1
         where t.state = 'pending_assignment' and t.driver_id is null`,
        [partnerId],
      );
      return res.json({
        clientsEnrolled: Number(clientsCount.rows[0]?.count ?? 0),
        ridesToday: Number(ridesToday.rows[0]?.count ?? 0),
        inTransit: Number(inTransit.rows[0]?.count ?? 0),
        pendingApprovals: Number(pending.rows[0]?.count ?? 0),
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/bookings`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const q = String(req.query.q ?? "").trim().toLowerCase();
      const status = String(req.query.status ?? "").trim().toLowerCase();
      const sort = String(req.query.sort ?? "created_desc").trim().toLowerCase();
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const offset = (page - 1) * limit;
      const sortSql =
        sort === "scheduled_asc"
          ? "b.scheduled_at asc"
          : sort === "scheduled_desc"
            ? "b.scheduled_at desc"
            : sort === "created_asc"
              ? "b.created_at asc"
              : "b.created_at desc";
      const params: unknown[] = [partnerId];
      const where: string[] = ["b.created_by = $1"];
      if (status && status !== "all") {
        params.push(status);
        where.push(`lower(b.status) = $${params.length}`);
      }
      if (q) {
        params.push(`%${q}%`);
        where.push(
          `(lower(b.pickup) like $${params.length}
            or lower(b.dropoff) like $${params.length}
            or lower(coalesce(rp.full_name,'')) like $${params.length}
            or lower(coalesce(u.email,'')) like $${params.length})`,
        );
      }
      const whereSql = where.length ? `where ${where.join(" and ")}` : "";
      const countRes = await pool.query(
        `select count(*)::int as c from bookings b
         left join rider_profiles rp on rp.user_id = b.rider_id
         left join users u on u.id = b.rider_id
         ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const result = await pool.query(
        `select b.id, b.pickup, b.dropoff, b.pickup_lat, b.pickup_lng, b.dropoff_lat, b.dropoff_lng,
                b.scheduled_at, b.status, b.rider_id, b.mobility_needs, b.notes,
                rp.full_name as rider_name, u.email as rider_email,
                t.id as trip_id, t.state as trip_state, t.driver_id,
                dp.full_name as driver_name, du.email as driver_email
         from bookings b
         left join rider_profiles rp on rp.user_id = b.rider_id
         left join users u on u.id = b.rider_id
         left join trips t on t.booking_id = b.id
         left join users du on du.id = t.driver_id
         left join driver_profiles dp on dp.user_id = t.driver_id
         ${whereSql}
         order by ${sortSql}
         limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      const total = Number(countRes.rows[0]?.c ?? 0);
      return res.json({ items: result.rows, total, page, limit });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/clients`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const q = String(req.query.q ?? "").trim().toLowerCase();
      const sort = String(req.query.sort ?? "name_asc").trim().toLowerCase();
      const page = Math.max(1, Number(req.query.page ?? 1) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 20) || 20));
      const offset = (page - 1) * limit;
      const sortSql =
        sort === "name_desc"
          ? "rp.full_name desc nulls last, u.email desc"
          : sort === "bookings_desc"
            ? "bookings_count::int desc, rp.full_name asc nulls last, u.email asc"
            : sort === "bookings_asc"
              ? "bookings_count::int asc, rp.full_name asc nulls last, u.email asc"
              : "rp.full_name asc nulls last, u.email asc";
      const params: unknown[] = [partnerId];
      const where: string[] = ["pc.partner_id = $1"];
      if (q) {
        params.push(`%${q}%`);
        where.push(
          `(lower(coalesce(rp.full_name,'')) like $${params.length}
            or lower(u.email) like $${params.length}
            or lower(coalesce(rp.ndis_id,'')) like $${params.length}
            or lower(coalesce(pc.notes,'')) like $${params.length})`,
        );
      }
      const whereSql = where.length ? `where ${where.join(" and ")}` : "";
      const countRes = await pool.query(
        `select count(*)::int as c
         from partner_clients pc
         join users u on u.id = pc.rider_id
         left join rider_profiles rp on rp.user_id = u.id
         ${whereSql}`,
        params,
      );
      params.push(limit, offset);
      const result = await pool.query(
        `select u.id, u.email, rp.full_name, rp.phone, rp.ndis_id, pc.notes,
                (select count(*) from bookings b where b.rider_id = u.id and b.created_by = $1) as bookings_count
         from partner_clients pc
         join users u on u.id = pc.rider_id
         left join rider_profiles rp on rp.user_id = u.id
         ${whereSql}
         order by ${sortSql}
         limit $${params.length - 1} offset $${params.length}`,
        params,
      );
      const total = Number(countRes.rows[0]?.c ?? 0);
      return res.json({ items: result.rows, total, page, limit });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/riders`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const result = await pool.query(
        `select u.id, u.email, rp.full_name, rp.phone
         from partner_clients pc
         join users u on u.id = pc.rider_id
         left join rider_profiles rp on rp.user_id = u.id
         where pc.partner_id = $1
         order by rp.full_name nulls last, u.email
         limit 500`,
        [partnerId],
      );
      return res.json({ items: result.rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.post(`${prefix}/clients`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const { riderId, email, fullName, phone, ndisId, notes } = parseClientInput(req.body);
      if (!riderId && !email) return res.status(400).json({ error: "Provide riderId or email" });

      let finalRiderId = riderId;
      if (!finalRiderId) {
        const existing = await pool.query("select id from users where email = $1", [email]);
        if (existing.rowCount && existing.rows[0]?.id) {
          finalRiderId = existing.rows[0].id as string;
        } else {
          const placeholder = crypto.randomBytes(24).toString("hex");
          const passwordHash = await hashPassword(placeholder);
          const inserted = await pool.query(
            "insert into users (email, password_hash, created_by) values ($1, $2, $3) returning id",
            [email, passwordHash, claims.sub],
          );
          finalRiderId = inserted.rows[0].id as string;
        }
      }

      await pool.query(
        "insert into user_roles (user_id, role) values ($1, 'rider') on conflict do nothing",
        [finalRiderId],
      );
      await pool.query(
        `insert into rider_profiles (user_id, full_name, phone, ndis_id)
         values ($1, $2, $3, $4)
         on conflict (user_id) do update set
           full_name = coalesce(excluded.full_name, rider_profiles.full_name),
           phone = coalesce(excluded.phone, rider_profiles.phone),
           ndis_id = coalesce(excluded.ndis_id, rider_profiles.ndis_id)`,
        [finalRiderId, fullName, phone, ndisId],
      );
      await pool.query(
        `insert into partner_clients (partner_id, rider_id, notes, created_by)
         values ($1, $2, $3, $4)
         on conflict (partner_id, rider_id) do update set notes = coalesce(excluded.notes, partner_clients.notes)`,
        [claims.sub, finalRiderId, notes, claims.sub],
      );
      return res.status(201).json({ riderId: finalRiderId });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.patch(`${prefix}/clients/:riderId`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const { riderId } = req.params;
      const { fullName, phone, ndisId, notes } = parseClientInput(req.body);
      const owned = await pool.query(
        "select 1 from partner_clients where partner_id = $1 and rider_id = $2",
        [partnerId, riderId],
      );
      if (!owned.rowCount) return res.status(404).json({ error: "Client not found in your partner roster" });
      await pool.query(
        `update rider_profiles set
          full_name = coalesce($2, full_name),
          phone = coalesce($3, phone),
          ndis_id = coalesce($4, ndis_id)
         where user_id = $1`,
        [riderId, fullName, phone, ndisId],
      );
      await pool.query(
        "update partner_clients set notes = coalesce($3, notes) where partner_id = $1 and rider_id = $2",
        [partnerId, riderId, notes],
      );
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.delete(`${prefix}/clients/:riderId`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const { riderId } = req.params;
      await pool.query("delete from partner_clients where partner_id = $1 and rider_id = $2", [claims.sub, riderId]);
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.post(`${prefix}/bookings`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const riderId = String(req.body?.riderId ?? "").trim();
      const pickup = String(req.body?.pickup ?? "").trim();
      const dropoff = String(req.body?.dropoff ?? "").trim();
      const scheduledAt = String(req.body?.scheduledAt ?? "").trim();
      const pickupLat = req.body?.pickupLat != null ? Number(req.body.pickupLat) : null;
      const pickupLng = req.body?.pickupLng != null ? Number(req.body.pickupLng) : null;
      const dropoffLat = req.body?.dropoffLat != null ? Number(req.body.dropoffLat) : null;
      const dropoffLng = req.body?.dropoffLng != null ? Number(req.body.dropoffLng) : null;
      if (!riderId || !pickup || !dropoff || !scheduledAt) {
        return res.status(400).json({ error: "riderId, pickup, dropoff, scheduledAt are required" });
      }

      const ownership = await pool.query(
        "select 1 from partner_clients where partner_id = $1 and rider_id = $2",
        [claims.sub, riderId],
      );
      if (!ownership.rowCount) {
        return res.status(403).json({ error: "You can only book rides for your own clients" });
      }

      let inserted;
      try {
        inserted = await pool.query(
          `insert into bookings (rider_id, pickup, dropoff, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, scheduled_at, status, mobility_needs, notes, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,'pending_matching',$9,$10,$11)
           returning id, pickup, dropoff, scheduled_at, status, created_at`,
          [riderId, pickup, dropoff, pickupLat, pickupLng, dropoffLat, dropoffLng, scheduledAt, req.body?.mobilityNeeds ?? null, req.body?.notes ?? null, claims.sub],
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : "";
        if (!/pickup_lat|dropoff_lat/i.test(msg)) throw error;
        inserted = await pool.query(
          `insert into bookings (rider_id, pickup, dropoff, scheduled_at, status, mobility_needs, notes, created_by)
           values ($1,$2,$3,$4,'pending_matching',$5,$6,$7)
           returning id, pickup, dropoff, scheduled_at, status, created_at`,
          [riderId, pickup, dropoff, scheduledAt, req.body?.mobilityNeeds ?? null, req.body?.notes ?? null, claims.sub],
        );
      }
      const booking = inserted.rows[0] as { id: string };
      const pickupState =
        inferAuStateFromLocationText(pickup) ||
        (typeof req.body?.pickupState === "string" ? String(req.body.pickupState).trim().toUpperCase().slice(0, 3) : null);
      if (pickupState) {
        await pool.query("update bookings set pickup_state = $1 where id = $2", [pickupState, booking.id]);
      }

      const tripIns = await pool.query(
        "insert into trips (booking_id, state) values ($1, 'pending_assignment') returning id",
        [booking.id],
      );
      const tripId = tripIns.rows[0]?.id as string;

      const drivers = await pool.query(
        `select dp.user_id as id, dp.state from driver_profiles dp
         where dp.verification_status = 'Approved'`,
      );
      for (const d of drivers.rows) {
        const dState = (d.state as string | null)?.trim().toUpperCase() || "";
        const stateOk = !pickupState || !dState || dState === pickupState;
        if (!stateOk) continue;
        await pool.query(
          "insert into notifications (recipient_id, type, payload) values ($1, 'new_ride_request', $2)",
          [
            d.id,
            JSON.stringify({
              tripId,
              bookingId: booking.id,
              pickup,
              dropoff,
              scheduledAt,
              pickupState,
            }),
          ],
        );
      }
      return res.status(201).json({ booking: inserted.rows[0] });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/plans`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const rows = await pool.query(
        `select id, name, target_group, frequency, start_date, end_date, priority, notes, status, created_at, updated_at
         from partner_travel_plans
         where partner_id = $1
         order by created_at desc`,
        [partnerId],
      );
      return res.json({ items: rows.rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.post(`${prefix}/plans`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const name = String(req.body?.name ?? "").trim();
      if (!name) return res.status(400).json({ error: "name is required" });
      const inserted = await pool.query(
        `insert into partner_travel_plans
         (partner_id, name, target_group, frequency, start_date, end_date, priority, notes, status)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         returning id, name, target_group, frequency, start_date, end_date, priority, notes, status, created_at, updated_at`,
        [
          claims.sub,
          name,
          String(req.body?.targetGroup ?? "").trim() || null,
          String(req.body?.frequency ?? "").trim() || "Weekly",
          String(req.body?.startDate ?? "").trim() || null,
          String(req.body?.endDate ?? "").trim() || null,
          String(req.body?.priority ?? "").trim() || "Medium",
          String(req.body?.notes ?? "").trim() || null,
          String(req.body?.status ?? "").trim() || "Draft",
        ],
      );
      return res.status(201).json({ plan: inserted.rows[0] });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.patch(`${prefix}/plans/:id`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const { id } = req.params;
      const updated = await pool.query(
        `update partner_travel_plans set
            name = coalesce($3, name),
            target_group = coalesce($4, target_group),
            frequency = coalesce($5, frequency),
            start_date = coalesce($6, start_date),
            end_date = coalesce($7, end_date),
            priority = coalesce($8, priority),
            notes = coalesce($9, notes),
            status = coalesce($10, status),
            updated_at = now()
         where id = $1 and partner_id = $2
         returning id`,
        [
          id,
          partnerId,
          req.body?.name ? String(req.body.name).trim() : null,
          req.body?.targetGroup ? String(req.body.targetGroup).trim() : null,
          req.body?.frequency ? String(req.body.frequency).trim() : null,
          req.body?.startDate ? String(req.body.startDate).trim() : null,
          req.body?.endDate ? String(req.body.endDate).trim() : null,
          req.body?.priority ? String(req.body.priority).trim() : null,
          req.body?.notes ? String(req.body.notes).trim() : null,
          req.body?.status ? String(req.body.status).trim() : null,
        ],
      );
      if (!updated.rowCount) return res.status(404).json({ error: "Plan not found" });
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.delete(`${prefix}/plans/:id`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const { id } = req.params;
      await pool.query("delete from partner_travel_plans where id = $1 and partner_id = $2", [id, claims.sub]);
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/support-tickets`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner", "partner_employee"]);
      const partnerId = await resolvePartnerScope(claims);
      const rows = await pool.query(
        `select id, issue_type, reference_id, priority, message, status, created_at, updated_at
         from support_tickets
         where created_by = $1 and role = 'partner'
         order by created_at desc`,
        [partnerId],
      );
      return res.json({ items: rows.rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.post(`${prefix}/support-tickets`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const issueType = String(req.body?.issueType ?? "").trim();
      const message = String(req.body?.message ?? "").trim();
      if (!issueType || !message) {
        return res.status(400).json({ error: "issueType and message are required" });
      }
      const inserted = await pool.query(
        `insert into support_tickets (created_by, role, issue_type, reference_id, priority, message, status)
         values ($1, 'partner', $2, $3, $4, $5, 'Open')
         returning id, issue_type, reference_id, priority, message, status, created_at, updated_at`,
        [
          claims.sub,
          issueType,
          String(req.body?.referenceId ?? "").trim() || null,
          String(req.body?.priority ?? "").trim() || "Normal",
          message,
        ],
      );
      return res.status(201).json({ ticket: inserted.rows[0] });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.get(`${prefix}/notifications`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const result = await pool.query(
        `select id, type, payload, read_at, created_at from notifications
         where recipient_id = $1 order by created_at desc limit 50`,
        [claims.sub],
      );
      return res.json({ items: result.rows });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });

  app.patch(`${prefix}/notifications/:id/read`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const { id } = req.params;
      await pool.query("update notifications set read_at = now() where id = $1 and recipient_id = $2", [id, claims.sub]);
      return res.json({ ok: true });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Internal Server Error";
      console.error("[partner-service] Error:", error);
      const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
      return res.status(status).json({ error: msg });
    }
  });
}

registerRoutes("/partner");
registerRoutes("/agent");

app.get("/partner/billing", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["partner"]);
    const result = await pool.query(
      "select * from partner_billing_settings where partner_id = $1",
      [claims.sub]
    );
    return res.json(result.rows[0] || { auto_invoice: true, invoice_frequency: 'immediate' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[partner-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/partner/billing", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["partner"]);
    const { autoInvoice, frequency, billingEmail, abn, gstRegistered } = req.body ?? {};
    
    await pool.query(
      `insert into partner_billing_settings (partner_id, auto_invoice, invoice_frequency, billing_email, abn, gst_registered)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (partner_id) do update set
         auto_invoice = excluded.auto_invoice,
         invoice_frequency = excluded.invoice_frequency,
         billing_email = excluded.billing_email,
         abn = excluded.abn,
         gst_registered = excluded.gst_registered,
         updated_at = now()`,
      [claims.sub, autoInvoice ?? true, frequency ?? 'immediate', billingEmail || null, abn || null, gstRegistered ?? true]
    );
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[partner-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/partner/invoices", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["partner"]);
    const result = await pool.query(
      `select i.*, rp.full_name as client_name from invoices i
       join partner_clients pc on pc.rider_id = i.recipient_id and pc.partner_id = $1
       left join rider_profiles rp on rp.user_id = i.recipient_id
       order by i.created_at desc limit 100`,
      [claims.sub]
    );
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[partner-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

async function start() {
  try {
    await runMigrations();
  } catch (error) {
    console.error("[partner-service] migrations failed (refusing to start):", error);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`partner-service listening on ${port}`);
  });
}

void start();

