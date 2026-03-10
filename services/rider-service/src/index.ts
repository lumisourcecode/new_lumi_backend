import "dotenv/config";
import express from "express";
import cors from "cors";

import { pool, requireAuth, requireRole } from "@lumi/shared";

const app = express();
const port = Number(process.env.RIDER_SERVICE_PORT ?? 4200);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "rider-service" });
});

app.get("/rider/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
    const result = await pool.query(
      `select u.email, rp.full_name, rp.phone, rp.ndis_id
       from users u
       left join rider_profiles rp on rp.user_id = u.id
       where u.id = $1`,
      [claims.sub],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Profile not found" });
    const row = result.rows[0] as { email: string; full_name: string | null; phone: string | null; ndis_id: string | null };
    return res.json({
      email: row.email,
      fullName: row.full_name ?? "",
      phone: row.phone ?? "",
      ndisId: row.ndis_id ?? "",
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.patch("/rider/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
    const fullName = String(req.body?.fullName ?? "").trim() || null;
    const phone = String(req.body?.phone ?? "").trim() || null;
    const ndisId = String(req.body?.ndisId ?? "").trim() || null;
    await pool.query(
      `insert into rider_profiles (user_id, full_name, phone, ndis_id)
       values ($1, $2, $3, $4)
       on conflict (user_id) do update set
         full_name = coalesce($2, rider_profiles.full_name),
         phone = coalesce($3, rider_profiles.phone),
         ndis_id = coalesce($4, rider_profiles.ndis_id)`,
      [claims.sub, fullName, phone, ndisId],
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/rider/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
    const result = await pool.query(
      `select b.id, b.pickup, b.dropoff, b.pickup_lat, b.pickup_lng, b.dropoff_lat, b.dropoff_lng,
              b.scheduled_at, b.status, b.mobility_needs, b.notes, b.created_at,
              t.id as trip_id, t.state as trip_state, t.driver_id,
              dp.full_name as driver_name, du.email as driver_email
       from bookings b
       left join trips t on t.booking_id = b.id
       left join users du on du.id = t.driver_id
       left join driver_profiles dp on dp.user_id = t.driver_id
       where b.rider_id = $1
       order by b.created_at desc
       limit 200`,
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.patch("/rider/bookings/:id", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (!status || status !== "cancelled") {
      return res.status(400).json({ error: "Only cancellation is supported. Send status: 'cancelled'" });
    }
    const check = await pool.query("select id from bookings where id = $1 and rider_id = $2", [id, claims.sub]);
    if (!check.rowCount) return res.status(404).json({ error: "Booking not found" });
    await pool.query("update bookings set status = 'cancelled' where id = $1", [id]);
    await pool.query("update trips set state = 'Cancelled' where booking_id = $1", [id]);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.post("/rider/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);

    const pickup = String(req.body?.pickup ?? "").trim();
    const dropoff = String(req.body?.dropoff ?? "").trim();
    const scheduledAt = String(req.body?.scheduledAt ?? "").trim();
    if (!pickup || !dropoff || !scheduledAt) {
      return res.status(400).json({ error: "pickup, dropoff, scheduledAt are required" });
    }
    const pickupLat = req.body?.pickupLat != null ? Number(req.body.pickupLat) : null;
    const pickupLng = req.body?.pickupLng != null ? Number(req.body.pickupLng) : null;
    const dropoffLat = req.body?.dropoffLat != null ? Number(req.body.dropoffLat) : null;
    const dropoffLng = req.body?.dropoffLng != null ? Number(req.body.dropoffLng) : null;
    const mobilityNeeds = String(req.body?.mobilityNeeds ?? "").trim() || null;
    const notes = String(req.body?.notes ?? "").trim() || null;

    const inserted = await pool.query(
      `insert into bookings (rider_id, pickup, dropoff, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, scheduled_at, status, mobility_needs, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'pending_matching',$9,$10)
       returning id, pickup, dropoff, scheduled_at, status, created_at`,
      [claims.sub, pickup, dropoff, pickupLat, pickupLng, dropoffLat, dropoffLng, scheduledAt, mobilityNeeds, notes],
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

app.get("/rider/notifications", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
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

app.patch("/rider/notifications/:id/read", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
    const { id } = req.params;
    await pool.query("update notifications set read_at = now() where id = $1 and recipient_id = $2", [id, claims.sub]);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.listen(port, () => {
  console.log(`rider-service listening on ${port}`);
});

