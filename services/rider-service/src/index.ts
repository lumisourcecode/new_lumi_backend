import "dotenv/config";
import express from "express";
import cors from "cors";
import { 
  pool, 
  requireAuth, 
  requireRole, 
  calculateEstimatedPrice, 
  calculateHaversineDistance 
} from "@lumi/shared";

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
              b.scheduled_at, b.status, b.mobility_needs, b.notes, b.created_at, b.is_ndis,
              t.id as trip_id, t.state as trip_state, t.driver_id, t.estimated_cost, t.distance_km,
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

app.post("/rider/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);

    const { 
      pickup, 
      dropoff, 
      scheduledAt, 
      pickupLat, 
      pickupLng, 
      dropoffLat, 
      dropoffLng, 
      mobilityNeeds, 
      notes,
      isNdis
    } = req.body ?? {};

    if (!pickup || !dropoff || !scheduledAt) {
      return res.status(400).json({ error: "pickup, dropoff, and scheduledAt are required" });
    }

    // Phase 4: Intelligent Pricing (Australia/NDIS)
    let distanceEst = 5.0; // Standard urban short trip fallback
    if (pickupLat && pickupLng && dropoffLat && dropoffLng) {
      distanceEst = calculateHaversineDistance(pickupLat, pickupLng, dropoffLat, dropoffLng) * 1.35; // Proxy for road distance
    }

    const isAccessible = mobilityNeeds?.toLowerCase().includes("wheelchair") || mobilityNeeds?.toLowerCase().includes("hoist");
    const pricing = calculateEstimatedPrice({
      distanceKm: distanceEst,
      durationMinutes: distanceEst * 2.5, // Approx 24km/h urban average with stops
      vehicleType: isAccessible ? "accessible" : "standard",
      isNdis: !!isNdis
    });

    const inserted = await pool.query(
      `insert into bookings (rider_id, pickup, dropoff, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, scheduled_at, status, mobility_needs, notes, is_ndis, vehicle_type_needed)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'pending_matching',$9,$10,$11,$12)
       returning id, pickup, dropoff, scheduled_at, status, created_at`,
      [
        claims.sub, pickup, dropoff, 
        pickupLat || null, pickupLng || null, 
        dropoffLat || null, dropoffLng || null, 
        scheduledAt, mobilityNeeds || null, notes || null, 
        !!isNdis, isAccessible ? "accessible" : "standard"
      ],
    );
    const booking = inserted.rows[0] as { id: string };

    // Create Trip with estimated cost
    await pool.query(
      `insert into trips (booking_id, state, estimated_cost, final_cost, distance_km, duration_minutes) 
       values ($1, 'pending_assignment', $2, $2, $3, $4)`,
      [booking.id, pricing.total, distanceEst, Math.round(distanceEst * 2.5)],
    );

    // Phase 4: Nearby Proximity Dispatch (5km Radius)
    const activeDrivers = await pool.query(
      `select dp.user_id, dp.last_lat, dp.last_lng from driver_profiles dp
       where dp.verification_status = 'Approved'`
    );

    const notifications = [];
    for (const driver of activeDrivers.rows) {
      const dist = (driver.last_lat && driver.last_lng && pickupLat && pickupLng)
        ? calculateHaversineDistance(driver.last_lat, driver.last_lng, pickupLat, pickupLng)
        : null;

      // Notify if within 5km, or if coordinates are missing (global broadcast as fallback)
      if (dist === null || dist <= 5.0) {
        notifications.push(pool.query(
          "insert into notifications (recipient_id, type, payload) values ($1, 'new_ride_request', $2)",
          [driver.user_id, JSON.stringify({ 
            bookingId: booking.id, 
            pickup, 
            dropoff, 
            scheduledAt, 
            price: pricing.total,
            distance: distanceEst.toFixed(1) + "km"
          })]
        ));
      }
    }
    
    await Promise.all(notifications);

    return res.status(201).json({ 
      booking: inserted.rows[0], 
      estimatedPrice: pricing 
    });
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

app.listen(port, () => {
  console.log(`rider-service listening on ${port}`);
});
