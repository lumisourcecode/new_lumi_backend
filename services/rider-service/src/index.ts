import {
  pool,
  requireAuth,
  requireRole,
  runMigrations,
  calculateEstimatedPrice,
  calculateHaversineDistance,
  inferAuStateFromLocationText,
} from "@lumi/shared";
import express from "express";
import cors from "cors";

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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[rider-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[rider-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/rider/bookings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
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
    const params: unknown[] = [claims.sub];
    const where: string[] = ["b.rider_id = $1"];
    if (status && status !== "all") {
      if (status === "completed") {
        where.push("(lower(b.status) like 'completed%' or lower(coalesce(t.state,'')) = 'completed')");
      } else if (status === "cancelled") {
        where.push("(lower(b.status) = 'cancelled' or lower(coalesce(t.state,'')) = 'cancelled')");
      } else if (status === "in-progress") {
        where.push("(lower(b.status) <> 'cancelled' and lower(b.status) not like 'completed%')");
      } else {
        params.push(status);
        where.push(`lower(b.status) = $${params.length}`);
      }
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(
        `(lower(b.pickup) like $${params.length}
          or lower(b.dropoff) like $${params.length}
          or lower(b.id::text) like $${params.length}
          or lower(coalesce(t.id::text,'')) like $${params.length}
          or lower(coalesce(dp.full_name,'')) like $${params.length}
          or lower(coalesce(du.email,'')) like $${params.length})`,
      );
    }
    const whereSql = where.length ? `where ${where.join(" and ")}` : "";
    const countRes = await pool.query(
      `select count(*)::int as c
       from bookings b
       left join trips t on t.booking_id = b.id
       left join users du on du.id = t.driver_id
       left join driver_profiles dp on dp.user_id = t.driver_id
       ${whereSql}`,
      params,
    );
    params.push(limit, offset);
    const result = await pool.query(
      `select b.id, b.pickup, b.dropoff, b.pickup_lat, b.pickup_lng, b.dropoff_lat, b.dropoff_lng,
              b.scheduled_at, b.status, b.mobility_needs, b.notes, b.created_at, b.is_ndis,
              t.id as trip_id, t.state as trip_state, t.driver_id, t.estimated_cost, t.distance_km,
              dp.full_name as driver_name, du.email as driver_email
       from bookings b
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
    console.error("[rider-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/rider/nearby-drivers", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["rider"]);
    const pickupLatRaw = req.query.pickupLat;
    const pickupLngRaw = req.query.pickupLng;
    let pickupLat = pickupLatRaw != null ? Number(pickupLatRaw) : NaN;
    let pickupLng = pickupLngRaw != null ? Number(pickupLngRaw) : NaN;
    if (!Number.isFinite(pickupLat) || !Number.isFinite(pickupLng)) {
      const latest = await pool.query(
        `select pickup_lat, pickup_lng
         from bookings
         where rider_id = $1 and pickup_lat is not null and pickup_lng is not null
         order by created_at desc
         limit 1`,
        [claims.sub],
      );
      pickupLat = Number(latest.rows[0]?.pickup_lat);
      pickupLng = Number(latest.rows[0]?.pickup_lng);
    }

    const drivers = await pool.query(
      `select dp.user_id as id, dp.full_name, dp.vehicle_rego, dp.last_lat, dp.last_lng
       from driver_profiles dp
       where dp.verification_status = 'Approved'
       order by dp.last_ping_at desc nulls last
       limit 60`,
    );

    const items = drivers.rows
      .map((d) => {
        const dLat = Number(d.last_lat);
        const dLng = Number(d.last_lng);
        const canDistance = Number.isFinite(pickupLat) && Number.isFinite(pickupLng) && Number.isFinite(dLat) && Number.isFinite(dLng);
        const distanceKm = canDistance ? calculateHaversineDistance(pickupLat, pickupLng, dLat, dLng) : null;
        return {
          id: String(d.id),
          full_name: d.full_name as string | undefined,
          vehicle_rego: d.vehicle_rego as string | undefined,
          distance_km: distanceKm == null ? null : Number(distanceKm.toFixed(2)),
          eta_min: distanceKm == null ? null : Math.max(2, Math.round(distanceKm * 2.5)),
        };
      })
      .filter((row) => row.distance_km == null || row.distance_km <= 25)
      .sort((a, b) => {
        if (a.distance_km == null && b.distance_km == null) return 0;
        if (a.distance_km == null) return 1;
        if (b.distance_km == null) return -1;
        return a.distance_km - b.distance_km;
      })
      .slice(0, 12);

    return res.json({ items });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[rider-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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

    let inserted;
    try {
      inserted = await pool.query(
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
    } catch (error) {
      const msg = error instanceof Error ? error.message : "";
      if (!/pickup_lat|dropoff_lat|is_ndis|vehicle_type_needed/i.test(msg)) throw error;
      inserted = await pool.query(
        `insert into bookings (rider_id, pickup, dropoff, scheduled_at, status, mobility_needs, notes)
         values ($1,$2,$3,$4,'pending_matching',$5,$6)
         returning id, pickup, dropoff, scheduled_at, status, created_at`,
        [claims.sub, pickup, dropoff, scheduledAt, mobilityNeeds || null, notes || null],
      );
    }
    const booking = inserted.rows[0] as { id: string };
    const pickupState =
      inferAuStateFromLocationText(String(pickup)) ||
      (typeof req.body?.pickupState === "string" ? String(req.body.pickupState).trim().toUpperCase().slice(0, 3) : null);

    if (pickupState) {
      await pool.query("update bookings set pickup_state = $1 where id = $2", [pickupState, booking.id]);
    }

    const tripIns = await pool.query(
      `insert into trips (booking_id, state, estimated_cost, final_cost, distance_km, duration_minutes) 
       values ($1, 'pending_assignment', $2, $2, $3, $4) returning id`,
      [booking.id, pricing.total, distanceEst, Math.round(distanceEst * 2.5)],
    );
    const tripId = tripIns.rows[0]?.id as string;

    const activeDrivers = await pool.query(
      `select dp.user_id, dp.last_lat, dp.last_lng, dp.state from driver_profiles dp
       where dp.verification_status = 'Approved'`,
    );

    const notifications: Promise<unknown>[] = [];
    for (const driver of activeDrivers.rows) {
      const dState = (driver.state as string | null)?.trim().toUpperCase() || "";
      const stateOk = !pickupState || !dState || dState === pickupState;
      if (!stateOk) continue;

      const dist =
        driver.last_lat && driver.last_lng && pickupLat && pickupLng
          ? calculateHaversineDistance(driver.last_lat, driver.last_lng, pickupLat, pickupLng)
          : null;

      if (dist === null || dist <= 25) {
        notifications.push(
          pool.query(
            "insert into notifications (recipient_id, type, payload) values ($1, 'new_ride_request', $2)",
            [
              driver.user_id,
              JSON.stringify({
                tripId,
                bookingId: booking.id,
                pickup,
                dropoff,
                scheduledAt,
                pickupState,
                price: pricing.total,
                distance: distanceEst.toFixed(1) + "km",
              }),
            ],
          ),
        );
      }
    }

    await Promise.all(notifications);

    return res.status(201).json({ 
      booking: inserted.rows[0], 
      estimatedPrice: pricing 
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[rider-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[rider-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[rider-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

async function start() {
  try {
    await runMigrations();
  } catch (error) {
    console.error("[rider-service] migrations failed (refusing to start):", error);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`rider-service listening on ${port}`);
  });
}

void start();
