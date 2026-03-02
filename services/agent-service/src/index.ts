import "dotenv/config";
import express from "express";
import cors from "cors";

import { pool, requireAuth, requireRole } from "@lumi/shared";

const app = express();
const port = Number(process.env.AGENT_SERVICE_PORT ?? 4400);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "agent-service" });
});

app.get("/agent/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const result = await pool.query(
      `select u.email, ap.org_name, ap.contact_name
       from users u
       left join agent_profiles ap on ap.user_id = u.id
       where u.id = $1`,
      [claims.sub],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Profile not found" });
    const row = result.rows[0] as { email: string; org_name: string | null; contact_name: string | null };
    return res.json({
      email: row.email,
      orgName: row.org_name ?? "",
      contactName: row.contact_name ?? "",
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.patch("/agent/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const orgName = String(req.body?.orgName ?? "").trim() || null;
    const contactName = String(req.body?.contactName ?? "").trim() || null;
    await pool.query(
      `insert into agent_profiles (user_id, org_name, contact_name)
       values ($1, $2, $3)
       on conflict (user_id) do update set
         org_name = coalesce($2, agent_profiles.org_name),
         contact_name = coalesce($3, agent_profiles.contact_name)`,
      [claims.sub, orgName, contactName],
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/agent/stats", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const today = new Date().toISOString().slice(0, 10);
    const clientsCount = await pool.query(
      `select count(distinct b.rider_id) from bookings b where b.created_by = $1`,
      [claims.sub],
    );
    const ridesToday = await pool.query(
      `select count(*) from bookings b where b.created_by = $1 and b.scheduled_at::date = $2`,
      [claims.sub, today],
    );
    const inTransit = await pool.query(
      `select count(*) from trips t
       join bookings b on b.id = t.booking_id and b.created_by = $1
       where t.state not in ('Completed', 'Cancelled') and t.driver_id is not null`,
      [claims.sub],
    );
    const pending = await pool.query(
      `select count(*) from trips t
       join bookings b on b.id = t.booking_id and b.created_by = $1
       where t.state = 'pending_assignment' and t.driver_id is null`,
      [claims.sub],
    );
    return res.json({
      clientsEnrolled: Number(clientsCount.rows[0]?.count ?? 0),
      ridesToday: Number(ridesToday.rows[0]?.count ?? 0),
      inTransit: Number(inTransit.rows[0]?.count ?? 0),
      pendingApprovals: Number(pending.rows[0]?.count ?? 0),
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/agent/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const result = await pool.query(
      `select b.id, b.pickup, b.dropoff, b.scheduled_at, b.status, b.rider_id, b.mobility_needs, b.notes,
              rp.full_name as rider_name, u.email as rider_email,
              t.id as trip_id, t.state as trip_state
       from bookings b
       left join rider_profiles rp on rp.user_id = b.rider_id
       left join users u on u.id = b.rider_id
       left join trips t on t.booking_id = b.id
       where b.created_by = $1
       order by b.created_at desc limit 200`,
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/agent/riders", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const result = await pool.query(
      `select u.id, u.email, rp.full_name, rp.phone
       from users u
       join user_roles ur on ur.user_id = u.id and ur.role = 'rider'
       left join rider_profiles rp on rp.user_id = u.id
       order by rp.full_name nulls last, u.email
       limit 500`,
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/agent/clients", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const result = await pool.query(
      `select distinct u.id, u.email, rp.full_name, rp.phone, rp.ndis_id,
              (select count(*) from bookings b where b.rider_id = u.id and b.created_by = $1) as bookings_count
       from users u
       join user_roles ur on ur.user_id = u.id and ur.role = 'rider'
       left join rider_profiles rp on rp.user_id = u.id
       where exists (select 1 from bookings b where b.rider_id = u.id and b.created_by = $1)
       order by rp.full_name nulls last, u.email
       limit 200`,
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.post("/agent/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const riderId = String(req.body?.riderId ?? "").trim();
    const pickup = String(req.body?.pickup ?? "").trim();
    const dropoff = String(req.body?.dropoff ?? "").trim();
    const scheduledAt = String(req.body?.scheduledAt ?? "").trim();
    if (!riderId || !pickup || !dropoff || !scheduledAt) {
      return res.status(400).json({ error: "riderId, pickup, dropoff, scheduledAt are required" });
    }
    const riderCheck = await pool.query(
      "select 1 from user_roles where user_id = $1 and role = 'rider'",
      [riderId],
    );
    if (!riderCheck.rowCount) {
      return res.status(400).json({ error: "riderId must be a registered rider" });
    }

    const inserted = await pool.query(
      `insert into bookings (rider_id, pickup, dropoff, scheduled_at, status, mobility_needs, notes, created_by)
       values ($1,$2,$3,$4,'pending_matching',$5,$6,$7)
       returning id, pickup, dropoff, scheduled_at, status, created_at`,
      [
        riderId,
        pickup,
        dropoff,
        scheduledAt,
        req.body?.mobilityNeeds ?? null,
        req.body?.notes ?? null,
        claims.sub,
      ],
    );
    const booking = inserted.rows[0] as { id: string };
    await pool.query(
      "insert into trips (booking_id, state) values ($1, 'pending_assignment')",
      [booking.id],
    );
    const drivers = await pool.query(
      `select u.id from users u
       join user_roles ur on ur.user_id = u.id and ur.role = 'driver'
       join driver_profiles dp on dp.user_id = u.id and dp.verification_status = 'Approved'`,
    );
    for (const d of drivers.rows) {
      await pool.query(
        "insert into notifications (recipient_id, type, payload) values ($1, 'new_ride_request', $2)",
        [d.id, JSON.stringify({ bookingId: booking.id, pickup, dropoff, scheduledAt })],
      );
    }

    return res.status(201).json({ booking: inserted.rows[0] });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/agent/notifications", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const result = await pool.query(
      `select id, type, payload, read_at, created_at from notifications
       where recipient_id = $1 order by created_at desc limit 50`,
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.patch("/agent/notifications/:id/read", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["agent"]);
    const { id } = req.params;
    await pool.query("update notifications set read_at = now() where id = $1 and recipient_id = $2", [id, claims.sub]);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.listen(port, () => {
  console.log(`agent-service listening on ${port}`);
});

