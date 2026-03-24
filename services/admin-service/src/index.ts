import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  adminChangePasswordBodySchema,
  createUserBodySchema,
  hashPassword,
  pool,
  runMigrations,
  requireAuth,
  requireRole,
  sendGenericEmail,
  sendNewPasswordEmail,
} from "@lumi/shared";

const SUPER_ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "admin@lumiride.com").toLowerCase().trim();
const app = express();
const port = Number(process.env.ADMIN_SERVICE_PORT ?? 4500);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "admin-service" });
});

function isSuperAdmin(claims: { sub: string }, email?: string) {
  return email?.toLowerCase() === SUPER_ADMIN_EMAIL;
}

const PARTNER_LIST_SQL = `
  select u.id, u.email, u.is_active, u.created_at, ap.org_name, ap.contact_name,
         (select count(*) from partner_clients pc where pc.partner_id = u.id) as clients_count
  from users u
  left join partner_profiles ap on ap.user_id = u.id
  where exists (
    select 1 from user_roles ur
    where ur.user_id = u.id and ur.role in ('partner', 'agent')
  )
  order by u.created_at desc
  limit 500
`;

app.get("/admin/users", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const roleFilter = req.query.role as string | undefined;
    let sql = `
      select u.id, u.email, u.is_active, u.is_super_admin, u.created_at,
             array_agg(ur.role order by ur.role) filter (where ur.role is not null) as roles
      from users u
      left join user_roles ur on ur.user_id = u.id
    `;
    const params: unknown[] = [];
    if (roleFilter && ["rider", "driver", "partner", "admin"].includes(roleFilter)) {
      if (roleFilter === "partner") {
        sql += ` where exists (select 1 from user_roles ur2 where ur2.user_id = u.id and ur2.role in ('partner','agent'))`;
      } else {
        sql += ` where exists (select 1 from user_roles ur2 where ur2.user_id = u.id and ur2.role = $1)`;
        params.push(roleFilter);
      }
    }
    sql += ` group by u.id order by u.created_at desc limit 500`;
    const users = await pool.query(sql, params);
    return res.json({ items: users.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/search", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const query = String(req.query.q ?? "").trim();
    if (!query) {
      return res.json({ users: [], bookings: [], trips: [], tickets: [], documents: [] });
    }
    const needle = `%${query}%`;

    const users = await pool.query(
      `select u.id, u.email, u.is_active, u.created_at,
              rp.full_name as rider_name, dp.full_name as driver_name, pp.contact_name as partner_contact, pp.org_name as partner_org
       from users u
       left join rider_profiles rp on rp.user_id = u.id
       left join driver_profiles dp on dp.user_id = u.id
       left join partner_profiles pp on pp.user_id = u.id
       where u.email ilike $1
          or coalesce(rp.full_name,'') ilike $1
          or coalesce(dp.full_name,'') ilike $1
          or coalesce(pp.contact_name,'') ilike $1
          or coalesce(pp.org_name,'') ilike $1
       order by u.created_at desc
       limit 50`,
      [needle],
    );

    const bookings = await pool.query(
      `select b.id, b.rider_id, b.pickup, b.dropoff, b.status, b.scheduled_at, b.created_at, u.email as rider_email
       from bookings b
       left join users u on u.id = b.rider_id
       where b.id::text ilike $1
          or b.pickup ilike $1
          or b.dropoff ilike $1
          or coalesce(b.status,'') ilike $1
          or coalesce(u.email,'') ilike $1
       order by b.created_at desc
       limit 50`,
      [needle],
    );

    const trips = await pool.query(
      `select t.id, t.state, t.driver_id, t.created_at, b.id as booking_id, b.rider_id, b.pickup, b.dropoff
       from trips t
       left join bookings b on b.id = t.booking_id
       where t.id::text ilike $1
          or coalesce(t.state,'') ilike $1
          or b.pickup ilike $1
          or b.dropoff ilike $1
       order by t.created_at desc
       limit 50`,
      [needle],
    );

    const tickets = await pool.query(
      `select st.id, st.created_by, st.role, st.issue_type, st.priority, st.status, st.created_at, u.email as created_by_email
       from support_tickets st
       left join users u on u.id = st.created_by
       where st.id::text ilike $1
          or st.issue_type ilike $1
          or st.message ilike $1
          or coalesce(st.status,'') ilike $1
          or coalesce(u.email,'') ilike $1
       order by st.created_at desc
       limit 50`,
      [needle],
    );

    const documents = await pool.query(
      `select dd.id, dd.doc_type, dd.status, dd.expiry, dd.driver_id, u.email as driver_email
       from driver_documents dd
       left join users u on u.id = dd.driver_id
       where dd.id::text ilike $1
          or dd.doc_type ilike $1
          or coalesce(dd.status,'') ilike $1
          or coalesce(u.email,'') ilike $1
       order by dd.expiry asc nulls last
       limit 50`,
      [needle],
    );

    return res.json({
      users: users.rows,
      bookings: bookings.rows,
      trips: trips.rows,
      tickets: tickets.rows,
      documents: documents.rows,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/users/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const userRes = await pool.query(
      `select u.id, u.email, u.is_active, u.is_super_admin, u.created_at, u.created_by
       from users u where u.id = $1`,
      [id],
    );
    if (!userRes.rowCount) return res.status(404).json({ error: "User not found" });
    const user = userRes.rows[0] as Record<string, unknown>;
    const rolesRes = await pool.query(
      "select role from user_roles where user_id = $1 order by role",
      [id],
    );
    const roles = rolesRes.rows.map((r: { role: string }) => r.role);
    const rider = await pool.query(
      "select full_name, phone, ndis_id from rider_profiles where user_id = $1",
      [id],
    );
    const driver = await pool.query(
      "select full_name, phone, vehicle_rego, verification_status from driver_profiles where user_id = $1",
      [id],
    );
    const partner = await pool.query(
      "select org_name, contact_name from partner_profiles where user_id = $1",
      [id],
    );
    const admin = await pool.query(
      "select display_name from admin_profiles where user_id = $1",
      [id],
    );
    const bookingsCount = await pool.query(
      "select count(*) as c from bookings where rider_id = $1",
      [id],
    );
    const partnerClientsCount = await pool.query(
      "select count(*) as c from partner_clients where partner_id = $1",
      [id],
    );
    const tripsCount = await pool.query("select count(*) as c from trips where driver_id = $1", [id]);
    const supportTicketsCount = await pool.query(
      "select count(*) as c from support_tickets where created_by = $1",
      [id],
    );
    return res.json({
      user: { ...user, roles },
      riderProfile: rider.rows[0] ?? null,
      driverProfile: driver.rows[0] ?? null,
      partnerProfile: partner.rows[0] ?? null,
      adminProfile: admin.rows[0] ?? null,
      bookingsCount: Number(bookingsCount.rows[0]?.c ?? 0),
      partnerClientsCount: Number(partnerClientsCount.rows[0]?.c ?? 0),
      tripsCount: Number(tripsCount.rows[0]?.c ?? 0),
      supportTicketsCount: Number(supportTicketsCount.rows[0]?.c ?? 0),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/users/:id/history", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const bookings = await pool.query(
      `select b.id, b.pickup, b.dropoff, b.scheduled_at, b.status, b.created_at,
              b.created_by, t.id as trip_id, t.state as trip_state, t.driver_id
       from bookings b
       left join trips t on t.booking_id = b.id
       where b.rider_id = $1 or b.created_by = $1
       order by b.created_at desc
       limit 300`,
      [id],
    );
    const trips = await pool.query(
      `select t.id, t.state, t.assigned_at, t.created_at, t.driver_id, b.id as booking_id, b.pickup, b.dropoff
       from trips t
       join bookings b on b.id = t.booking_id
       where t.driver_id = $1
       order by t.created_at desc
       limit 300`,
      [id],
    );
    return res.json({ bookings: bookings.rows, trips: trips.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/users/:id/documents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const docs = await pool.query(
      "select id, doc_type, status, expiry, admin_notes from driver_documents where driver_id = $1 order by doc_type",
      [id],
    );
    return res.json({ items: docs.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/users/:id/activity", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const rows = await pool.query(
      `select id, action, entity_type, entity_id, payload, created_at
       from activity_log
       where user_id = $1
       order by created_at desc
       limit 300`,
      [id],
    );
    return res.json({ items: rows.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/users/:id/relationships", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const partnerClients = await pool.query(
      `select u.id, u.email, rp.full_name, rp.phone, rp.ndis_id, pc.notes, pc.created_at
       from partner_clients pc
       join users u on u.id = pc.rider_id
       left join rider_profiles rp on rp.user_id = pc.rider_id
       where pc.partner_id = $1
       order by pc.created_at desc`,
      [id],
    );
    const riderPartners = await pool.query(
      `select u.id, u.email, pp.org_name, pp.contact_name, pc.notes, pc.created_at
       from partner_clients pc
       join users u on u.id = pc.partner_id
       left join partner_profiles pp on pp.user_id = pc.partner_id
       where pc.rider_id = $1
       order by pc.created_at desc`,
      [id],
    );
    return res.json({ partnerClients: partnerClients.rows, riderPartners: riderPartners.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/users/:id/support-tickets", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const status = String(req.query.status ?? "").trim();
    const params: unknown[] = [id];
    let sql = `
      select st.id, st.created_by, st.role, st.issue_type, st.reference_id, st.priority, st.message, st.status, st.created_at, st.updated_at
      from support_tickets st
      where st.created_by = $1
    `;
    if (status) {
      sql += " and st.status = $2";
      params.push(status);
    }
    sql += " order by st.created_at desc limit 200";
    const rows = await pool.query(sql, params);
    return res.json({ items: rows.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/partners/:id/clients", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const riderId = String(req.body?.riderId ?? "").trim();
    const notes = String(req.body?.notes ?? "").trim() || null;
    if (!riderId) return res.status(400).json({ error: "riderId is required" });
    await pool.query(
      `insert into partner_clients (partner_id, rider_id, notes, created_by)
       values ($1, $2, $3, $4)
       on conflict (partner_id, rider_id) do update set notes = coalesce(excluded.notes, partner_clients.notes)`,
      [id, riderId, notes, claims.sub],
    );
    return res.status(201).json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/partners/:id/clients/:riderId", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id, riderId } = req.params;
    await pool.query("delete from partner_clients where partner_id = $1 and rider_id = $2", [id, riderId]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/users", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const parsed = createUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    }
    const { email, password, role, fullName, phone, ndisId, orgName, vehicleRego } = parsed.data;
    const normalizedEmail = email.toLowerCase().trim();

    const adminUser = await pool.query(
      "select u.email from users u join user_roles ur on ur.user_id = u.id where u.id = $1 and ur.role = 'admin'",
      [claims.sub],
    );
    const adminEmail = adminUser.rows[0]?.email as string | undefined;
    const canCreateAdmin = isSuperAdmin(claims, adminEmail);

    if (role === "admin" && !canCreateAdmin) {
      return res.status(403).json({ error: "Only super admin can create admin users." });
    }

    const existing = await pool.query("select id from users where email = $1", [normalizedEmail]);
    let userId: string;

    if (existing.rowCount && existing.rows[0]?.id) {
      userId = existing.rows[0].id as string;
      const roleCheck = await pool.query(
        "select 1 from user_roles where user_id = $1 and role = $2",
        [userId, role],
      );
      if (roleCheck.rowCount) {
        return res.status(409).json({ error: `User already has ${role} role.` });
      }
      await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, role]);
    } else {
      const passwordHash = await hashPassword(password);
      const inserted = await pool.query(
        "insert into users (email, password_hash, created_by) values ($1, $2, $3) returning id",
        [normalizedEmail, passwordHash, claims.sub],
      );
      userId = inserted.rows[0].id as string;
      await pool.query("insert into user_roles (user_id, role) values ($1, $2)", [userId, role]);
    }

    if (role === "rider") {
      await pool.query(
        "insert into rider_profiles (user_id, full_name, phone, ndis_id) values ($1, $2, $3, $4) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, rider_profiles.full_name), phone = coalesce(excluded.phone, rider_profiles.phone), ndis_id = coalesce(excluded.ndis_id, rider_profiles.ndis_id)",
        [userId, fullName ?? null, phone ?? null, ndisId ?? null],
      );
    } else if (role === "driver") {
      await pool.query(
        "insert into driver_profiles (user_id, full_name, phone, vehicle_rego) values ($1, $2, $3, $4) on conflict (user_id) do update set full_name = coalesce(excluded.full_name, driver_profiles.full_name), phone = coalesce(excluded.phone, driver_profiles.phone), vehicle_rego = coalesce(excluded.vehicle_rego, driver_profiles.vehicle_rego)",
        [userId, fullName ?? null, phone ?? null, vehicleRego ?? null],
      );
  } else if (role === "partner") {
      await pool.query(
        "insert into partner_profiles (user_id, org_name, contact_name) values ($1, $2, $3) on conflict (user_id) do update set org_name = coalesce(excluded.org_name, partner_profiles.org_name), contact_name = coalesce(excluded.contact_name, partner_profiles.contact_name)",
        [userId, orgName ?? null, fullName ?? null],
      );
      // First partner account acts as org admin/owner and can manage partner employees.
      await pool.query(
        `insert into partner_employees (partner_id, employee_user_id, title, permissions, status, invited_at, invited_by)
         values ($1, $1, 'Organization Admin', $2::jsonb, 'active', now(), $3)
         on conflict (partner_id, employee_user_id) do update set
           title = excluded.title,
           permissions = excluded.permissions,
           status = 'active',
           updated_at = now()`,
        [
          userId,
          JSON.stringify({
            org_admin: true,
            employees_manage: true,
            bookings_manage: true,
            clients_manage: true,
            plans_manage: true,
            billing_manage: true,
            settings_manage: true,
          }),
          claims.sub,
        ],
      );
    } else if (role === "admin") {
      await pool.query(
        "insert into admin_profiles (user_id, display_name) values ($1, $2) on conflict (user_id) do update set display_name = coalesce(excluded.display_name, admin_profiles.display_name)",
        [userId, fullName ?? null],
      );
    }

    const rolesRes = await pool.query(
      "select role from user_roles where user_id = $1 order by role",
      [userId],
    );
    const roles = rolesRes.rows.map((r: { role: string }) => r.role);
    return res.status(201).json({
      user: { id: userId, email: normalizedEmail, roles },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/riders", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const users = await pool.query(
      `select u.id, u.email, u.is_active, u.created_at, rp.full_name, rp.phone, rp.ndis_id,
              (select count(*) from bookings b where b.rider_id = u.id) as bookings_count
       from users u
       join user_roles ur on ur.user_id = u.id and ur.role = 'rider'
       left join rider_profiles rp on rp.user_id = u.id
       order by u.created_at desc
       limit 500`,
    );
    return res.json({ items: users.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/drivers", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const users = await pool.query(
      `select u.id, u.email, u.is_active, u.created_at, dp.full_name, dp.phone, dp.vehicle_rego, dp.verification_status
       from users u
       join user_roles ur on ur.user_id = u.id and ur.role = 'driver'
       left join driver_profiles dp on dp.user_id = u.id
       order by u.created_at desc
       limit 500`,
    );
    return res.json({ items: users.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/partners", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const users = await pool.query(PARTNER_LIST_SQL);
    return res.json({ items: users.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

// Backward-compatible alias while frontend migrates.
app.get("/admin/agents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const users = await pool.query(PARTNER_LIST_SQL);
    return res.json({ items: users.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/partners/:id/overview", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const partner = await pool.query(
      `select u.id, u.email, u.is_active, u.created_at, pp.org_name, pp.contact_name
       from users u
       left join partner_profiles pp on pp.user_id = u.id
       where u.id = $1`,
      [id],
    );
    if (!partner.rowCount) return res.status(404).json({ error: "Partner not found" });
    const roleRes = await pool.query("select role from user_roles where user_id = $1 order by role", [id]);
    const roles = roleRes.rows.map((r: { role: string }) => (r.role === "agent" ? "partner" : r.role));
    if (!roles.includes("partner")) return res.status(404).json({ error: "Partner not found" });
    const clientsCount = await pool.query("select count(*) as c from partner_clients where partner_id = $1", [id]);
    const bookingsCount = await pool.query("select count(*) as c from bookings where created_by = $1", [id]);
    const plansCount = await pool.query("select count(*) as c from partner_travel_plans where partner_id = $1", [id]);
    const ticketsCount = await pool.query("select count(*) as c from support_tickets where created_by = $1", [id]);
    return res.json({
      partner: partner.rows[0],
      stats: {
        clientsCount: Number(clientsCount.rows[0]?.c ?? 0),
        bookingsCount: Number(bookingsCount.rows[0]?.c ?? 0),
        plansCount: Number(plansCount.rows[0]?.c ?? 0),
        ticketsCount: Number(ticketsCount.rows[0]?.c ?? 0),
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/partners/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const orgName = req.body?.orgName == null ? null : String(req.body.orgName).trim() || null;
    const contactName = req.body?.contactName == null ? null : String(req.body.contactName).trim() || null;
    const isActive = req.body?.isActive;
    await pool.query(
      `insert into partner_profiles (user_id, org_name, contact_name)
       values ($1, $2, $3)
       on conflict (user_id) do update
       set org_name = coalesce(excluded.org_name, partner_profiles.org_name),
           contact_name = coalesce(excluded.contact_name, partner_profiles.contact_name)`,
      [id, orgName, contactName],
    );
    if (typeof isActive === "boolean") {
      await pool.query("update users set is_active = $2 where id = $1", [id, isActive]);
    }
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/partners/:id/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const rows = await pool.query(
      `select b.id, b.rider_id, ru.email as rider_email, rp.full_name as rider_name,
              b.pickup, b.dropoff, b.scheduled_at, b.status, b.notes, b.created_at
       from bookings b
       left join users ru on ru.id = b.rider_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       where b.created_by = $1
       order by b.created_at desc
       limit 500`,
      [id],
    );
    return res.json({ items: rows.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/partners/:id/plans", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const rows = await pool.query(
      `select id, name, target_group, frequency, start_date, end_date, priority, notes, status, created_at, updated_at
       from partner_travel_plans
       where partner_id = $1
       order by created_at desc
       limit 500`,
      [id],
    );
    return res.json({ items: rows.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/partners/:id/plans", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "name is required" });
    const created = await pool.query(
      `insert into partner_travel_plans (partner_id, name, target_group, frequency, start_date, end_date, priority, notes, status)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id`,
      [
        id,
        name,
        String(req.body?.targetGroup ?? "").trim() || null,
        String(req.body?.frequency ?? "").trim() || "Weekly",
        req.body?.startDate || null,
        req.body?.endDate || null,
        String(req.body?.priority ?? "").trim() || "Medium",
        String(req.body?.notes ?? "").trim() || null,
        String(req.body?.status ?? "").trim() || "Draft",
      ],
    );
    return res.status(201).json({ id: created.rows[0]?.id });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/partners/:id/plans/:planId", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id, planId } = req.params;
    const updated = await pool.query(
      `update partner_travel_plans
       set name = coalesce($3, name),
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
        planId,
        id,
        req.body?.name ?? null,
        req.body?.targetGroup ?? null,
        req.body?.frequency ?? null,
        req.body?.startDate ?? null,
        req.body?.endDate ?? null,
        req.body?.priority ?? null,
        req.body?.notes ?? null,
        req.body?.status ?? null,
      ],
    );
    if (!updated.rowCount) return res.status(404).json({ error: "Plan not found" });
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/partners/:id/plans/:planId", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id, planId } = req.params;
    await pool.query("delete from partner_travel_plans where id = $1 and partner_id = $2", [planId, id]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/partners/:id/support-tickets", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const rows = await pool.query(
      `select id, issue_type, reference_id, priority, message, status, created_at, updated_at
       from support_tickets
       where created_by = $1
       order by created_at desc
       limit 500`,
      [id],
    );
    return res.json({ items: rows.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/users/:id/change-password", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const adminUser = await pool.query(
      "select email from users where id = $1",
      [claims.sub],
    );
    const adminEmail = adminUser.rows[0]?.email as string | undefined;
    if (!isSuperAdmin(claims, adminEmail)) {
      return res.status(403).json({ error: "Only super admin can change user passwords." });
    }
    const { id } = req.params;
    const parsed = adminChangePasswordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    }
    const { newPassword, sendEmail } = parsed.data;

    const userRes = await pool.query("select id, email from users where id = $1", [id]);
    if (!userRes.rowCount) return res.status(404).json({ error: "User not found" });
    const userEmail = userRes.rows[0].email as string;

    const passwordHash = await hashPassword(newPassword);
    await pool.query("update users set password_hash = $2 where id = $1", [id, passwordHash]);

    if (sendEmail) {
      await sendNewPasswordEmail(userEmail, newPassword);
    }

    return res.json({ ok: true, message: sendEmail ? "Password updated and email sent." : "Password updated." });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/users/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const { is_active } = req.body as { is_active?: boolean };
    if (typeof is_active !== "boolean") {
      return res.status(400).json({ error: "is_active is required" });
    }
    const superAdminCheck = await pool.query(
      "select id from users where id = $1 and is_super_admin = true",
      [id],
    );
    if (superAdminCheck.rowCount) {
      return res.status(403).json({ error: "Cannot disable super admin." });
    }
    await pool.query("update users set is_active = $1 where id = $2", [is_active, id]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/driver-interest", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const result = await pool.query(
      "select id, full_name, email, phone, role_type, suburb, vehicle_info, notes, created_at from driver_interest order by created_at desc limit 200",
    );
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/enrollments", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const statusFilter = req.query.status as string | undefined;
    let sql = `
      select de.id, de.user_id, de.status, de.full_name, de.phone, de.vehicle_rego, de.notes, de.created_at, de.reviewed_at,
             de.verification_stage, de.admin_notes, u.email
       from driver_enrollments de
       join users u on u.id = de.user_id
    `;
    const params: unknown[] = [];
    if (statusFilter && ["pending", "approved", "rejected"].includes(statusFilter)) {
      sql += " where de.status = $1";
      params.push(statusFilter);
    }
    sql += " order by de.created_at desc limit 200";
    const result = await pool.query(sql, params);
    const items = result.rows as Record<string, unknown>[];
    for (const row of items) {
      const docs = await pool.query(
        "select id, doc_type, status, expiry from driver_documents where driver_id = $1",
        [row.user_id],
      );
      row.documents = docs.rows;
    }
    return res.json({ items });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

const VERIFICATION_STAGES = ["profile_review", "documents_review", "under_review", "approved", "rejected"] as const;

app.patch("/admin/enrollments/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const { status, notes, verificationStage, adminNotes } = req.body as { status?: string; notes?: string; verificationStage?: string; adminNotes?: string };
    const enrollment = await pool.query("select user_id from driver_enrollments where id = $1", [id]);
    if (!enrollment.rowCount) return res.status(404).json({ error: "Enrollment not found" });
    const userId = enrollment.rows[0].user_id as string;

    if (status && ["approved", "rejected"].includes(status)) {
      await pool.query(
        "update driver_enrollments set status = $1, reviewed_by = $2, reviewed_at = now(), notes = coalesce($3, notes), admin_notes = coalesce($4, admin_notes) where id = $5",
        [status, claims.sub, notes ?? null, adminNotes ?? null, id],
      );
      const enr = await pool.query("select full_name, phone, vehicle_rego from driver_enrollments where id = $1", [id]);
      const e = enr.rows[0] as { full_name: string; phone: string; vehicle_rego: string } | undefined;
      await pool.query(
        "update driver_profiles set verification_status = $1, full_name = coalesce($2, full_name), phone = coalesce($3, phone), vehicle_rego = coalesce($4, vehicle_rego) where user_id = $5",
        [status === "approved" ? "Approved" : "Rejected", e?.full_name ?? null, e?.phone ?? null, e?.vehicle_rego ?? null, userId],
      );
      await pool.query(
        "insert into notifications (recipient_id, type, payload) values ($1, $2, $3)",
        [userId, status === "approved" ? "driver_application_approved" : "driver_application_rejected", JSON.stringify({ enrollmentId: id, adminNotes: adminNotes ?? notes })],
      );
      await pool.query(
        "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'enrollment_reviewed', 'enrollment', $2, $3)",
        [claims.sub, id, JSON.stringify({ status, driverId: userId })],
      );
    } else if (verificationStage && VERIFICATION_STAGES.includes(verificationStage as (typeof VERIFICATION_STAGES)[number])) {
      await pool.query(
        "update driver_enrollments set verification_stage = $1, admin_notes = coalesce($2, admin_notes) where id = $3",
        [verificationStage, adminNotes ?? null, id],
      );
      const notifType = verificationStage === "documents_review" ? "driver_documents_review" : verificationStage === "under_review" ? "driver_under_review" : "driver_verification_update";
      await pool.query(
        "insert into notifications (recipient_id, type, payload) values ($1, $2, $3)",
        [userId, notifType, JSON.stringify({ verificationStage, adminNotes: adminNotes ?? null })],
      );
    }
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/bookings/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (!status || !["cancelled", "pending_matching", "confirmed"].includes(status)) {
      return res.status(400).json({ error: "status must be cancelled, pending_matching, or confirmed" });
    }
    const updated = await pool.query(
      "update bookings set status = $1 where id = $2 returning id",
      [status, id],
    );
    if (!updated.rowCount) return res.status(404).json({ error: "Booking not found" });
    if (status === "cancelled") {
      await pool.query("update trips set state = 'Cancelled' where booking_id = $1", [id]);
    }
    await pool.query(
      "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'admin_updated_booking', 'booking', $2, $3)",
      [claims.sub, id, JSON.stringify({ status })],
    );
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/trips/:id/state", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const { state } = req.body ?? {};
    if (!state || !["Assigned", "Completed", "Cancelled", "InProgress"].includes(state)) {
      return res.status(400).json({ error: "state must be Assigned, InProgress, Completed, or Cancelled" });
    }
    const updated = await pool.query(
      "update trips set state = $1 where id = $2 returning id",
      [state, id],
    );
    if (!updated.rowCount) return res.status(404).json({ error: "Trip not found" });
    await pool.query(
      "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'admin_updated_trip_state', 'trip', $2, $3)",
      [claims.sub, id, JSON.stringify({ state })],
    );
    if (state === "Completed") {
      await pool.query("update bookings set status = 'completed' where id = (select booking_id from trips where id = $1)", [id]);
    }
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const statusFilter = String(req.query.status ?? "").trim();
    const tripState = String(req.query.tripState ?? "").trim();
    const q = String(req.query.q ?? "").trim();
    const from = String(req.query.from ?? "").trim();
    const to = String(req.query.to ?? "").trim();
    const riderId = String(req.query.riderId ?? "").trim();

    let sql = `
      select b.id, b.rider_id, b.pickup, b.dropoff, b.pickup_lat, b.pickup_lng, b.dropoff_lat, b.dropoff_lng,
              b.scheduled_at, b.status, b.mobility_needs, b.notes, b.created_at,
              rp.full_name as rider_name, rp.phone as rider_phone, u.email as rider_email,
              t.id as trip_id, t.state as trip_state, t.driver_id,
              dp.full_name as driver_name, du.email as driver_email
       from bookings b
       join users u on u.id = b.rider_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       left join trips t on t.booking_id = b.id
       left join users du on du.id = t.driver_id
       left join driver_profiles dp on dp.user_id = t.driver_id
       where 1=1`;
    const params: unknown[] = [];
    let p = 1;
    if (statusFilter && statusFilter !== "all") {
      sql += ` and b.status = $${p}`;
      params.push(statusFilter);
      p++;
    }
    if (tripState && tripState !== "all") {
      if (tripState === "unassigned") {
        sql += " and t.id is null";
      } else {
        sql += ` and t.state = $${p}`;
        params.push(tripState);
        p++;
      }
    }
    if (q) {
      sql += ` and (b.pickup ilike $${p} or b.dropoff ilike $${p} or u.email ilike $${p} or coalesce(rp.full_name,'') ilike $${p})`;
      params.push(`%${q}%`);
      p++;
    }
    if (from) {
      sql += ` and b.scheduled_at >= $${p}::timestamptz`;
      params.push(from);
      p++;
    }
    if (to) {
      sql += ` and b.scheduled_at <= $${p}::timestamptz`;
      params.push(to);
      p++;
    }
    if (riderId) {
      sql += ` and b.rider_id = $${p}`;
      params.push(riderId);
      p++;
    }
    sql += " order by b.created_at desc limit 500";
    const result = await pool.query(sql, params);
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { riderId, pickup, dropoff, scheduledAt, mobilityNeeds, notes, driverId } = req.body ?? {};
    const pickupLat = req.body?.pickupLat != null ? Number(req.body.pickupLat) : null;
    const pickupLng = req.body?.pickupLng != null ? Number(req.body.pickupLng) : null;
    const dropoffLat = req.body?.dropoffLat != null ? Number(req.body.dropoffLat) : null;
    const dropoffLng = req.body?.dropoffLng != null ? Number(req.body.dropoffLng) : null;
    if (!riderId || !pickup || !dropoff || !scheduledAt) {
      return res.status(400).json({ error: "riderId, pickup, dropoff, scheduledAt are required" });
    }
    let inserted;
    try {
      inserted = await pool.query(
        `insert into bookings (rider_id, pickup, dropoff, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, scheduled_at, status, mobility_needs, notes, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'pending_matching', $9, $10, $11)
         returning id, pickup, dropoff, scheduled_at, status, created_at`,
        [riderId, pickup, dropoff, pickupLat, pickupLng, dropoffLat, dropoffLng, scheduledAt, mobilityNeeds ?? null, notes ?? null, claims.sub],
      );
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (!/pickup_lat|dropoff_lat/i.test(msg)) throw error;
      inserted = await pool.query(
        `insert into bookings (rider_id, pickup, dropoff, scheduled_at, status, mobility_needs, notes, created_by)
         values ($1, $2, $3, $4, 'pending_matching', $5, $6, $7)
         returning id, pickup, dropoff, scheduled_at, status, created_at`,
        [riderId, pickup, dropoff, scheduledAt, mobilityNeeds ?? null, notes ?? null, claims.sub],
      );
    }
    const booking = inserted.rows[0] as { id: string };
    await pool.query(
      driverId
        ? "insert into trips (booking_id, state, driver_id, assigned_at) values ($1, 'Assigned', $2, now())"
        : "insert into trips (booking_id, state) values ($1, 'pending_assignment')",
      driverId ? [booking.id, driverId] : [booking.id],
    );
    await pool.query(
      "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'admin_created_booking', 'booking', $2, $3)",
      [claims.sub, booking.id, JSON.stringify({ riderId, pickup, dropoff, driverId })],
    );
    if (driverId) {
      await pool.query(
        "insert into notifications (recipient_id, type, payload) values ($1, 'trip_assigned', $2)",
        [driverId, JSON.stringify({ bookingId: booking.id, pickup, dropoff, scheduledAt })],
      );
    } else {
      const drivers = await pool.query(
        `select u.id from users u join user_roles ur on ur.user_id = u.id and ur.role = 'driver'
         join driver_profiles dp on dp.user_id = u.id and dp.verification_status = 'Approved'`,
      );
      for (const d of drivers.rows) {
        await pool.query(
          "insert into notifications (recipient_id, type, payload) values ($1, 'new_ride_request', $2)",
          [d.id, JSON.stringify({ bookingId: booking.id, pickup, dropoff, scheduledAt })],
        );
      }
    }
    return res.status(201).json({ booking: inserted.rows[0] });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/trips/:id/assign", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const { driverId } = req.body ?? {};
    if (!driverId) return res.status(400).json({ error: "driverId is required" });
    const updated = await pool.query(
      "update trips set driver_id = $1, state = 'Assigned', assigned_at = now() where id = $2 returning id",
      [driverId, id],
    );
    if (!updated.rowCount) return res.status(404).json({ error: "Trip not found" });
    const trip = await pool.query("select booking_id from trips where id = $1", [id]);
    const booking = await pool.query("select pickup, dropoff, scheduled_at from bookings where id = $1", [trip.rows[0].booking_id]);
    const b = booking.rows[0] as { pickup: string; dropoff: string; scheduled_at: string };
    await pool.query(
      "insert into notifications (recipient_id, type, payload) values ($1, 'trip_assigned', $2)",
      [driverId, JSON.stringify({ tripId: id, pickup: b.pickup, dropoff: b.dropoff, scheduledAt: b.scheduled_at })],
    );
    await pool.query(
      "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'admin_assigned_driver', 'trip', $2, $3)",
      [claims.sub, id, JSON.stringify({ driverId })],
    );
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/trips", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const result = await pool.query(
      `select t.id, t.state, t.driver_id, t.assigned_at, t.created_at,
              b.pickup, b.dropoff, b.scheduled_at, b.rider_id,
              rp.full_name as rider_name, dp.full_name as driver_name
       from trips t
       join bookings b on b.id = t.booking_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       left join driver_profiles dp on dp.user_id = t.driver_id
       order by t.created_at desc
       limit 500`,
    );
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/activity", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const result = await pool.query(
      `select al.id, al.user_id, al.action, al.entity_type, al.entity_id, al.payload, al.created_at,
              u.email
       from activity_log al
       left join users u on u.id = al.user_id
       order by al.created_at desc
       limit $1`,
      [limit],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/support-tickets", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const status = String(req.query.status ?? "").trim();
    const params: unknown[] = [];
    let sql = `
      select st.id, st.created_by, st.role, st.issue_type, st.reference_id, st.priority, st.message, st.status, st.created_at, st.updated_at,
             u.email as created_by_email
      from support_tickets st
      left join users u on u.id = st.created_by
    `;
    if (status) {
      sql += " where st.status = $1";
      params.push(status);
    }
    sql += " order by st.created_at desc limit 500";
    const rows = await pool.query(sql, params);
    return res.json({ items: rows.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/support-tickets/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const status = String(req.body?.status ?? "").trim();
    if (!status) return res.status(400).json({ error: "status is required" });
    const updated = await pool.query(
      "update support_tickets set status = $2, updated_at = now() where id = $1 returning id",
      [id, status],
    );
    if (!updated.rowCount) return res.status(404).json({ error: "Ticket not found" });
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/support-tickets", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const issueType = String(req.body?.issueType ?? "").trim();
    const message = String(req.body?.message ?? "").trim();
    if (!issueType || !message) return res.status(400).json({ error: "issueType and message are required" });
    const inserted = await pool.query(
      `insert into support_tickets (created_by, role, issue_type, reference_id, priority, message, status)
       values ($1, 'admin', $2, $3, $4, $5, $6)
       returning id`,
      [
        claims.sub,
        issueType,
        String(req.body?.referenceId ?? "").trim() || null,
        String(req.body?.priority ?? "").trim() || "Normal",
        message,
        String(req.body?.status ?? "").trim() || "Open",
      ],
    );
    return res.status(201).json({ id: inserted.rows[0]?.id });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/support-tickets/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const result = await pool.query("select * from support_tickets where id = $1", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ error: "Ticket not found" });
    return res.json(result.rows[0]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/support-tickets/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    await pool.query("delete from support_tickets where id = $1", [req.params.id]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/settings/smtp", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const result = await pool.query(
      `select host, port, username, from_name, from_email, secure_mode, is_active, updated_at, last_tested_at, last_test_result
       from admin_smtp_settings where id = 1`,
    );
    return res.json(
      result.rows[0] ?? {
        host: "",
        port: 587,
        username: "",
        from_name: "Lumi Ride",
        from_email: "noreply@lumiride.com.au",
        secure_mode: "tls",
        is_active: false,
      },
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/settings/smtp", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const host = String(req.body?.host ?? "").trim() || null;
    const port = Number(req.body?.port ?? 587);
    const username = String(req.body?.username ?? "").trim() || null;
    const password = String(req.body?.password ?? "").trim() || null;
    const fromName = String(req.body?.fromName ?? "").trim() || null;
    const fromEmail = String(req.body?.fromEmail ?? "").trim() || null;
    const secureMode = String(req.body?.secureMode ?? "tls").trim() || "tls";
    const isActive = Boolean(req.body?.isActive ?? false);
    await pool.query(
      `insert into admin_smtp_settings (id, host, port, username, password, from_name, from_email, secure_mode, is_active, updated_by, updated_at)
       values (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       on conflict (id) do update set
         host = excluded.host,
         port = excluded.port,
         username = excluded.username,
         password = coalesce(excluded.password, admin_smtp_settings.password),
         from_name = excluded.from_name,
         from_email = excluded.from_email,
         secure_mode = excluded.secure_mode,
         is_active = excluded.is_active,
         updated_by = excluded.updated_by,
         updated_at = now()`,
      [host, port, username, password, fromName, fromEmail, secureMode, isActive, claims.sub],
    );
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/settings/smtp/test", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const to = String(req.body?.to ?? "").trim();
    if (!to) return res.status(400).json({ error: "to is required" });
    const result = await sendGenericEmail({
      to,
      subject: "Lumi Ride SMTP test",
      html: "<p>Your SMTP test from Lumi Ride admin settings succeeded.</p>",
      text: "Your SMTP test from Lumi Ride admin settings succeeded.",
    });
    await pool.query(
      "update admin_smtp_settings set last_tested_at = now(), last_test_result = $1, updated_by = $2 where id = 1",
      [result.delivered ? "success" : "fallback_log", claims.sub],
    );
    return res.json({ ok: true, result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/permissions", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const rows = await pool.query("select * from admin_permission_matrix order by role, entity");
    return res.json({ items: rows.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/permissions", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const role = String(req.body?.role ?? "").trim();
    const entity = String(req.body?.entity ?? "").trim();
    if (!role || !entity) return res.status(400).json({ error: "role and entity are required" });
    await pool.query(
      `insert into admin_permission_matrix (role, entity, can_create, can_read, can_update, can_delete, updated_by, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,now())
       on conflict (role, entity) do update set
         can_create = excluded.can_create,
         can_read = excluded.can_read,
         can_update = excluded.can_update,
         can_delete = excluded.can_delete,
         updated_by = excluded.updated_by,
         updated_at = now()`,
      [
        role,
        entity,
        Boolean(req.body?.canCreate ?? true),
        Boolean(req.body?.canRead ?? true),
        Boolean(req.body?.canUpdate ?? true),
        Boolean(req.body?.canDelete ?? false),
        claims.sub,
      ],
    );
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/bookings/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const row = await pool.query("select * from bookings where id = $1", [req.params.id]);
    if (!row.rowCount) return res.status(404).json({ error: "Booking not found" });
    return res.json(row.rows[0]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/bookings/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    await pool.query("delete from bookings where id = $1", [req.params.id]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/trips/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const row = await pool.query("select * from trips where id = $1", [req.params.id]);
    if (!row.rowCount) return res.status(404).json({ error: "Trip not found" });
    return res.json(row.rows[0]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/trips/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    await pool.query("delete from trips where id = $1", [req.params.id]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/documents/:docId", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const row = await pool.query("select * from driver_documents where id = $1", [req.params.docId]);
    if (!row.rowCount) return res.status(404).json({ error: "Document not found" });
    return res.json(row.rows[0]);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/admin/documents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const driverId = String(req.body?.driverId ?? "").trim();
    const docType = String(req.body?.docType ?? "").trim();
    if (!driverId || !docType) return res.status(400).json({ error: "driverId and docType are required" });
    const inserted = await pool.query(
      "insert into driver_documents (driver_id, doc_type, status, expiry, admin_notes) values ($1,$2,$3,$4,$5) returning id",
      [driverId, docType, String(req.body?.status ?? "Pending"), req.body?.expiry ?? null, req.body?.adminNotes ?? null],
    );
    return res.status(201).json({ id: inserted.rows[0]?.id });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/admin/documents/:docId", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    await pool.query(
      `update driver_documents set
        doc_type = coalesce($2, doc_type),
        status = coalesce($3, status),
        expiry = coalesce($4, expiry),
        admin_notes = coalesce($5, admin_notes)
       where id = $1`,
      [req.params.docId, req.body?.docType ?? null, req.body?.status ?? null, req.body?.expiry ?? null, req.body?.adminNotes ?? null],
    );
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/documents/:docId", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    await pool.query("delete from driver_documents where id = $1", [req.params.docId]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/users/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const superAdminCheck = await pool.query("select id from users where id = $1 and is_super_admin = true", [id]);
    if (superAdminCheck.rowCount) return res.status(403).json({ error: "Cannot delete super admin." });
    await pool.query("delete from users where id = $1", [id]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.delete("/admin/partners/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    await pool.query("update users set is_active = false where id = $1", [req.params.id]);
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/stats", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const riders = await pool.query("select count(*) as c from user_roles where role = 'rider'");
    const drivers = await pool.query("select count(*) as c from user_roles where role = 'driver'");
    const pendingEnrollments = await pool.query("select count(*) as c from driver_enrollments where status = 'pending'");
    const bookings = await pool.query("select count(*) as c from bookings");
    const pendingTrips = await pool.query("select count(*) as c from trips where state = 'pending_assignment'");
    const activeTrips = await pool.query("select count(*) as c from trips where state not in ('Completed', 'Cancelled')");
    return res.json({
      ridersCount: Number(riders.rows[0]?.c ?? 0),
      driversCount: Number(drivers.rows[0]?.c ?? 0),
      pendingEnrollmentsCount: Number(pendingEnrollments.rows[0]?.c ?? 0),
      bookingsCount: Number(bookings.rows[0]?.c ?? 0),
      pendingTripsCount: Number(pendingTrips.rows[0]?.c ?? 0),
      activeTripsCount: Number(activeTrips.rows[0]?.c ?? 0),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/billing", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const result = await pool.query(
      `select t.id as trip_id, b.id as booking_id, b.pickup, b.dropoff, b.scheduled_at,
              rp.full_name as rider_name, u.email as rider_email, t.state
       from trips t
       join bookings b on b.id = t.booking_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       left join users u on u.id = b.rider_id
       where t.state = 'Completed'
       order by b.scheduled_at desc limit 200`,
    );
    const stats = await pool.query(
      "select count(*) as c from trips where state = 'Completed'",
    );
    return res.json({
      items: result.rows,
      completedTripsCount: Number(stats.rows[0]?.c ?? 0),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/compliance", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const docs = await pool.query(
      `select dd.id, dd.doc_type, dd.status, dd.expiry, dd.admin_notes, dp.full_name as driver_name, u.email as driver_email
       from driver_documents dd
       join users u on u.id = dd.driver_id
       left join driver_profiles dp on dp.user_id = dd.driver_id
       order by dd.expiry asc nulls last limit 200`,
    );
    const total = await pool.query("select count(*) as c from driver_documents");
    const pending = await pool.query(
      "select count(*) as c from driver_documents where status in ('Pending', 'In Progress', 'Needs More Information')",
    );
    const expiring = await pool.query(
      "select count(*) as c from driver_documents where expiry is not null and expiry <= current_date + interval '30 days'",
    );
    return res.json({
      items: docs.rows,
      totalDocs: Number(total.rows[0]?.c ?? 0),
      pendingCount: Number(pending.rows[0]?.c ?? 0),
      expiringSoonCount: Number(expiring.rows[0]?.c ?? 0),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/admin/reports/summary", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const stats = await pool.query(
      `select
        (select count(*) from user_roles where role = 'rider') as riders,
        (select count(*) from user_roles where role = 'driver') as drivers,
        (select count(*) from bookings) as bookings,
        (select count(*) from trips where state = 'Completed') as completed_trips,
        (select count(*) from driver_documents where status = 'Pending') as pending_docs,
        (select count(*) from activity_log where created_at > now() - interval '7 days') as activity_7d`,
    );
    const row = stats.rows[0] as Record<string, string>;
    return res.json({
      ridersCount: Number(row?.riders ?? 0),
      driversCount: Number(row?.drivers ?? 0),
      bookingsCount: Number(row?.bookings ?? 0),
      completedTripsCount: Number(row?.completed_trips ?? 0),
      pendingDocsCount: Number(row?.pending_docs ?? 0),
      activityLast7Days: Number(row?.activity_7d ?? 0),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.put("/admin/users/:id/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const { fullName, phone, ndisId, vehicleRego, orgName, contactName, displayName } = req.body ?? {};
    const rolesRes = await pool.query("select role from user_roles where user_id = $1", [id]);
    const roles = rolesRes.rows.map((r: { role: string }) => r.role);
    if (roles.includes("rider")) {
      await pool.query(
        "insert into rider_profiles (user_id, full_name, phone, ndis_id) values ($1,$2,$3,$4) on conflict (user_id) do update set full_name=coalesce($2,rider_profiles.full_name), phone=coalesce($3,rider_profiles.phone), ndis_id=coalesce($4,rider_profiles.ndis_id)",
        [id, fullName ?? null, phone ?? null, ndisId ?? null],
      );
    }
    if (roles.includes("driver")) {
      await pool.query(
        "insert into driver_profiles (user_id, full_name, phone, vehicle_rego) values ($1,$2,$3,$4) on conflict (user_id) do update set full_name=coalesce($2,driver_profiles.full_name), phone=coalesce($3,driver_profiles.phone), vehicle_rego=coalesce($4,driver_profiles.vehicle_rego)",
        [id, fullName ?? null, phone ?? null, vehicleRego ?? null],
      );
    }
    if (roles.includes("partner")) {
      await pool.query(
        "insert into partner_profiles (user_id, org_name, contact_name) values ($1,$2,$3) on conflict (user_id) do update set org_name=coalesce($2,partner_profiles.org_name), contact_name=coalesce($3,partner_profiles.contact_name)",
        [id, orgName ?? null, contactName ?? fullName ?? null],
      );
    }
    if (roles.includes("admin")) {
      await pool.query(
        "insert into admin_profiles (user_id, display_name) values ($1,$2) on conflict (user_id) do update set display_name=coalesce($2,admin_profiles.display_name)",
        [id, displayName ?? fullName ?? null],
      );
    }
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

const DOC_VERIFY_STATUSES = ["Pending", "In Progress", "Needs More Information", "Approved", "Rejected"] as const;

app.post("/admin/documents/:docId/verify", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { docId } = req.params;
    const { status, adminNotes } = req.body ?? {};
    if (!status || !DOC_VERIFY_STATUSES.includes(status)) {
      return res.status(400).json({
        error: `status must be one of: ${DOC_VERIFY_STATUSES.join(", ")}`,
      });
    }
    await pool.query(
      "update driver_documents set status = $1, admin_notes = coalesce($2, admin_notes) where id = $3",
      [status, adminNotes ?? null, docId],
    );
    return res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[admin-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

async function start() {
  try {
    await runMigrations();
  } catch (error) {
    console.error("[admin-service] migrations failed (refusing to start):", error);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`admin-service listening on ${port}`);
  });
}

void start();

