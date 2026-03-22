import "dotenv/config";
import express from "express";
import cors from "cors";
import { pool, requireAuth, requireRole, calculateHaversineDistance } from "@lumi/shared";

const app = express();
const port = Number(process.env.DRIVER_SERVICE_PORT ?? 4300);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "driver-service" });
});

app.post("/driver/interest", async (req, res) => {
  try {
    const { fullName, email, phone, roleType, suburb, vehicleInfo, notes } = req.body ?? {};
    const emailStr = String(email ?? "").trim();
    if (!emailStr) return res.status(400).json({ error: "email is required" });
    await pool.query(
      `insert into driver_interest (full_name, email, phone, role_type, suburb, vehicle_info, notes)
       values ($1, $2, $3, $4, $5, $6, $7)`,
      [
        String(fullName ?? "").trim() || null,
        emailStr,
        String(phone ?? "").trim() || null,
        String(roleType ?? "").trim() || null,
        String(suburb ?? "").trim() || null,
        String(vehicleInfo ?? "").trim() || null,
        String(notes ?? "").trim() || null,
      ],
    );
    return res.status(201).json({ ok: true, message: "Interest recorded" });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
  }
});

/**
 * Update Driver Location
 */
app.post("/driver/location", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const { lat, lng } = req.body ?? {};
    if (lat === undefined || lng === undefined) return res.status(400).json({ error: "lat/lng required" });
    await pool.query(
      `update driver_profiles set last_lat = $1, last_lng = $2, last_ping_at = now() where user_id = $3`,
      [Number(lat), Number(lng), claims.sub]
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      `select u.email, dp.full_name, dp.phone, dp.vehicle_rego, dp.vehicle_make, dp.vehicle_color, dp.emergency_contact, dp.verification_status,
              dp.date_of_birth, dp.address_line1, dp.suburb, dp.state, dp.postcode, dp.license_number
       from users u
       left join driver_profiles dp on dp.user_id = u.id
       where u.id = $1`,
      [claims.sub],
    );
    if (!result.rowCount) return res.status(404).json({ error: "Profile not found" });
    const row = result.rows[0];
    return res.json(row);
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/earnings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      `select t.id, t.state, t.created_at, t.final_cost, b.pickup, b.dropoff, b.scheduled_at,
              rp.full_name as rider_name
       from trips t
       join bookings b on b.id = t.booking_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       where t.driver_id = $1
       order by t.created_at desc limit 200`,
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/stats", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const today = new Date().toISOString().slice(0, 10);
    const tripsToday = await pool.query(
      `select count(*) as c from trips t where t.driver_id = $1 and t.created_at::date = $2`,
      [claims.sub, today],
    );
    const totalTrips = await pool.query(
      "select count(*) as c from trips where driver_id = $1",
      [claims.sub],
    );
    const inProgress = await pool.query(
      `select count(*) as c from trips where driver_id = $1 and state not in ('Completed', 'Cancelled')`,
      [claims.sub],
    );
    const totalEarnings = await pool.query(
      "select sum(final_cost) as s from trips where driver_id = $1 and state = 'Completed'",
      [claims.sub]
    );
    return res.json({
      tripsToday: Number(tripsToday.rows[0]?.c ?? 0),
      totalTrips: Number(totalTrips.rows[0]?.c ?? 0),
      inProgress: Number(inProgress.rows[0]?.c ?? 0),
      totalEarnings: Number(totalEarnings.rows[0]?.s ?? 0),
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/manifest", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      `select t.id, t.state, t.created_at, t.assigned_at, b.pickup, b.dropoff, b.scheduled_at, b.mobility_needs, b.notes,
              rp.full_name as rider_name, rp.phone as rider_phone
       from trips t
       join bookings b on b.id = t.booking_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       where t.driver_id = $1
       order by t.created_at desc
       limit 200`,
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/available-trips", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    
    const dp = await pool.query(
      "select last_lat, last_lng, verification_status from driver_profiles where user_id = $1",
      [claims.sub],
    );
    if (!dp.rowCount || dp.rows[0]?.verification_status !== "Approved") {
      return res.json({ items: [] });
    }

    const { last_lat: dLat, last_lng: dLng } = dp.rows[0];

    const result = await pool.query(
      `select t.id, t.created_at, b.pickup, b.dropoff, b.scheduled_at, b.mobility_needs, b.pickup_lat, b.pickup_lng,
              t.estimated_cost, t.distance_km, rp.full_name as rider_name
       from trips t
       join bookings b on b.id = t.booking_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       where t.driver_id is null and t.state = 'pending_assignment'
       order by b.scheduled_at asc
       limit 50`,
    );

    const itemsWithDist = result.rows.map(r => {
      const dist = (dLat && dLng && r.pickup_lat && r.pickup_lng)
        ? calculateHaversineDistance(dLat, dLng, r.pickup_lat, r.pickup_lng)
        : null;
      return { ...r, distanceToPickup: dist ? dist.toFixed(1) + "km" : "Global" };
    });

    return res.json({ items: itemsWithDist });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.post("/driver/trips/:tripId/accept", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const tripId = req.params.tripId;
    
    // Atomic check and assign
    const updated = await pool.query(
      `update trips set driver_id = $1, state = 'Assigned', assigned_at = now() 
       where id = $2 and driver_id is null and state = 'pending_assignment' 
       returning id`,
      [claims.sub, tripId]
    );

    if (!updated.rowCount) {
      return res.status(409).json({ error: "Trip no longer available or already accepted" });
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.listen(port, () => {
  console.log(`driver-service listening on ${port}`);
});
