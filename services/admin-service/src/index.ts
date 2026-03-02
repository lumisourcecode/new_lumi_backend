import "dotenv/config";
import express from "express";
import cors from "cors";

import {
  adminChangePasswordBodySchema,
  createUserBodySchema,
  hashPassword,
  pool,
  requireAuth,
  requireRole,
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
    if (roleFilter && ["rider", "driver", "agent", "admin"].includes(roleFilter)) {
      sql += ` where exists (select 1 from user_roles ur2 where ur2.user_id = u.id and ur2.role = $1)`;
      params.push(roleFilter);
    }
    sql += ` group by u.id order by u.created_at desc limit 500`;
    const users = await pool.query(sql, params);
    return res.json({ items: users.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    const agent = await pool.query(
      "select org_name, contact_name from agent_profiles where user_id = $1",
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
    return res.json({
      user: { ...user, roles },
      riderProfile: rider.rows[0] ?? null,
      driverProfile: driver.rows[0] ?? null,
      agentProfile: agent.rows[0] ?? null,
      adminProfile: admin.rows[0] ?? null,
      bookingsCount: Number(bookingsCount.rows[0]?.c ?? 0),
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    } else if (role === "agent") {
      await pool.query(
        "insert into agent_profiles (user_id, org_name, contact_name) values ($1, $2, $3) on conflict (user_id) do update set org_name = coalesce(excluded.org_name, agent_profiles.org_name), contact_name = coalesce(excluded.contact_name, agent_profiles.contact_name)",
        [userId, orgName ?? null, fullName ?? null],
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/admin/agents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const users = await pool.query(
      `select u.id, u.email, u.is_active, u.created_at, ap.org_name, ap.contact_name
       from users u
       join user_roles ur on ur.user_id = u.id and ur.role = 'agent'
       left join agent_profiles ap on ap.user_id = u.id
       order by u.created_at desc
       limit 500`,
    );
    return res.json({ items: users.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/admin/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const result = await pool.query(
      `select b.id, b.pickup, b.dropoff, b.scheduled_at, b.status, b.mobility_needs, b.notes, b.created_at,
              rp.full_name as rider_name, rp.phone as rider_phone, u.email as rider_email,
              t.id as trip_id, t.state as trip_state, t.driver_id
       from bookings b
       join users u on u.id = b.rider_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       left join trips t on t.booking_id = b.id
       order by b.created_at desc
       limit 500`,
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.post("/admin/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { riderId, pickup, dropoff, scheduledAt, mobilityNeeds, notes, driverId } = req.body ?? {};
    if (!riderId || !pickup || !dropoff || !scheduledAt) {
      return res.status(400).json({ error: "riderId, pickup, dropoff, scheduledAt are required" });
    }
    const inserted = await pool.query(
      `insert into bookings (rider_id, pickup, dropoff, scheduled_at, status, mobility_needs, notes, created_by)
       values ($1, $2, $3, $4, 'pending_matching', $5, $6, $7)
       returning id, pickup, dropoff, scheduled_at, status, created_at`,
      [riderId, pickup, dropoff, scheduledAt, mobilityNeeds ?? null, notes ?? null, claims.sub],
    );
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    if (roles.includes("agent")) {
      await pool.query(
        "insert into agent_profiles (user_id, org_name, contact_name) values ($1,$2,$3) on conflict (user_id) do update set org_name=coalesce($2,agent_profiles.org_name), contact_name=coalesce($3,agent_profiles.contact_name)",
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.listen(port, () => {
  console.log(`admin-service listening on ${port}`);
});

