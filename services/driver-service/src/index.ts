import {
  pool,
  requireAuth,
  requireRole,
  runMigrations,
  calculateHaversineDistance,
} from "@lumi/shared";
import express from "express";
import cors from "cors";

const app = express();
const port = Number(process.env.DRIVER_SERVICE_PORT ?? 4300);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/** Must match `REQUIRED_DOCS` in `lumi-ride/src/app/(driver)/driver/onboard/page.tsx`. */
const REQUIRED_DOC_TYPES = [
  "Driver License (Australian)",
  "NDIS Worker Screening Check",
  "National Police Check",
  "Manual Handling Certificate",
  "CPR / First Aid Certificate",
] as const;

type ProfileRow = {
  email: string;
  full_name: string | null;
  phone: string | null;
  vehicle_rego: string | null;
  vehicle_make: string | null;
  vehicle_color: string | null;
  emergency_contact: string | null;
  verification_status: string;
  date_of_birth: string | null;
  address_line1: string | null;
  suburb: string | null;
  state: string | null;
  postcode: string | null;
  license_number: string | null;
};

function profileToJson(row: ProfileRow) {
  return {
    email: row.email,
    fullName: row.full_name ?? "",
    phone: row.phone ?? "",
    dateOfBirth: row.date_of_birth,
    addressLine1: row.address_line1 ?? "",
    suburb: row.suburb ?? "",
    state: row.state ?? "",
    postcode: row.postcode ?? "",
    licenseNumber: row.license_number ?? "",
    emergencyContact: row.emergency_contact ?? "",
    vehicleRego: row.vehicle_rego ?? "",
    vehicleMake: row.vehicle_make ?? "",
    vehicleColor: row.vehicle_color ?? "",
    verificationStatus: row.verification_status ?? "Pending",
  };
}

function step1Complete(p: ProfileRow) {
  return !!(
    p.full_name?.trim() &&
    p.phone?.trim() &&
    p.date_of_birth &&
    p.address_line1?.trim() &&
    p.suburb?.trim() &&
    p.state?.trim() &&
    p.postcode?.trim()
  );
}

function step2Complete(p: ProfileRow) {
  return !!(p.license_number?.trim() && p.emergency_contact?.trim());
}

function step3Complete(p: ProfileRow) {
  return !!(p.vehicle_rego?.trim() && p.vehicle_make?.trim());
}

function step4Complete(docTypes: string[]) {
  return REQUIRED_DOC_TYPES.every((d) => docTypes.includes(d));
}

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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const row = result.rows[0] as ProfileRow;
    return res.json(profileToJson(row));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.patch("/driver/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const str = (k: string) => (typeof b[k] === "string" ? (b[k] as string) : b[k] != null ? String(b[k]) : "");
    const fullName = str("fullName").trim() || null;
    const phone = str("phone").trim() || null;
    const dateOfBirth = str("dateOfBirth").trim() || null;
    const addressLine1 = str("addressLine1").trim() || null;
    const suburb = str("suburb").trim() || null;
    const state = str("state").trim() || null;
    const postcode = str("postcode").trim() || null;
    const licenseNumber = str("licenseNumber").trim() || null;
    const emergencyContact = str("emergencyContact").trim() || null;
    const vehicleRego = str("vehicleRego").trim() || null;
    const vehicleMake = str("vehicleMake").trim() || null;
    const vehicleColor = str("vehicleColor").trim() || null;

    await pool.query(
      `insert into driver_profiles (user_id, full_name, phone, date_of_birth, address_line1, suburb, state, postcode, license_number, emergency_contact, vehicle_rego, vehicle_make, vehicle_color)
       values ($1, $2, $3, $4::date, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       on conflict (user_id) do update set
         full_name = coalesce(excluded.full_name, driver_profiles.full_name),
         phone = coalesce(excluded.phone, driver_profiles.phone),
         date_of_birth = coalesce(excluded.date_of_birth, driver_profiles.date_of_birth),
         address_line1 = coalesce(excluded.address_line1, driver_profiles.address_line1),
         suburb = coalesce(excluded.suburb, driver_profiles.suburb),
         state = coalesce(excluded.state, driver_profiles.state),
         postcode = coalesce(excluded.postcode, driver_profiles.postcode),
         license_number = coalesce(excluded.license_number, driver_profiles.license_number),
         emergency_contact = coalesce(excluded.emergency_contact, driver_profiles.emergency_contact),
         vehicle_rego = coalesce(excluded.vehicle_rego, driver_profiles.vehicle_rego),
         vehicle_make = coalesce(excluded.vehicle_make, driver_profiles.vehicle_make),
         vehicle_color = coalesce(excluded.vehicle_color, driver_profiles.vehicle_color)`,
      [
        claims.sub,
        fullName,
        phone,
        dateOfBirth || null,
        addressLine1,
        suburb,
        state,
        postcode,
        licenseNumber,
        emergencyContact,
        vehicleRego,
        vehicleMake,
        vehicleColor || null,
      ],
    );

    if (phone) {
      await pool.query("update users set phone = $1 where id = $2", [phone.replace(/\D/g, ""), claims.sub]);
    }

    const result = await pool.query(
      `select u.email, dp.full_name, dp.phone, dp.vehicle_rego, dp.vehicle_make, dp.vehicle_color, dp.emergency_contact, dp.verification_status,
              dp.date_of_birth, dp.address_line1, dp.suburb, dp.state, dp.postcode, dp.license_number
       from users u
       join driver_profiles dp on dp.user_id = u.id
       where u.id = $1`,
      [claims.sub],
    );
    const row = result.rows[0] as ProfileRow;
    return res.json(profileToJson(row));
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/driver/onboarding", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);

    const profRes = await pool.query(
      `select u.email, dp.full_name, dp.phone, dp.vehicle_rego, dp.vehicle_make, dp.vehicle_color, dp.emergency_contact, dp.verification_status,
              dp.date_of_birth, dp.address_line1, dp.suburb, dp.state, dp.postcode, dp.license_number
       from users u
       left join driver_profiles dp on dp.user_id = u.id
       where u.id = $1`,
      [claims.sub],
    );
    if (!profRes.rowCount) return res.status(404).json({ error: "User not found" });
    const p = profRes.rows[0] as ProfileRow;

    const docsRes = await pool.query(
      "select doc_type, status from driver_documents where driver_id = $1 order by doc_type",
      [claims.sub],
    );
    const documents = docsRes.rows as { doc_type: string; status: string }[];
    const docTypes = documents.map((d) => d.doc_type);

    const s1 = step1Complete(p);
    const s2 = step2Complete(p);
    const s3 = step3Complete(p);
    const s4 = step4Complete(docTypes);
    const s5 = s1 && s2 && s3 && s4;

    const steps = [
      { id: 1, label: "Personal details", complete: s1, required: [] as string[] },
      { id: 2, label: "License & emergency contact", complete: s2, required: [] as string[] },
      { id: 3, label: "Vehicle details", complete: s3, required: [] as string[] },
      { id: 4, label: "NDIS compliance documents", complete: s4, required: [...REQUIRED_DOC_TYPES] },
      { id: 5, label: "Submit for verification", complete: s5, required: [] as string[] },
    ];

    const completedSteps = [s1, s2, s3, s4, s5].filter(Boolean).length;
    const profileCompletionPercent = Math.round((completedSteps / 5) * 100);

    const enrRes = await pool.query(
      "select status, verification_stage, admin_notes, notes from driver_enrollments where user_id = $1 limit 1",
      [claims.sub],
    );
    const enr = enrRes.rows[0] as { status: string; verification_stage: string | null; admin_notes: string | null; notes: string | null } | undefined;

    const enrollmentPending = enr?.status === "pending";
    const canSubmit = s5 && !enrollmentPending && enr?.status !== "approved";

    return res.json({
      profileCompletionPercent,
      steps,
      canSubmit,
      enrollment: enr
        ? {
            status: enr.status,
            verificationStage: enr.verification_stage ?? "profile",
            adminNotes: enr.admin_notes ?? enr.notes ?? null,
          }
        : null,
      verificationStatus: p.verification_status ?? "Pending",
      documents,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/driver/documents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      "select id, doc_type, status, expiry from driver_documents where driver_id = $1 order by doc_type",
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/driver/documents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const docType = String((req.body as { docType?: string })?.docType ?? "").trim();
    if (!docType) return res.status(400).json({ error: "docType is required" });
    const expiryRaw = (req.body as { expiry?: string | null })?.expiry;
    const expiry = expiryRaw && String(expiryRaw).trim() ? String(expiryRaw).trim().slice(0, 10) : null;

    await pool.query("delete from driver_documents where driver_id = $1 and doc_type = $2", [claims.sub, docType]);
    await pool.query(
      "insert into driver_documents (driver_id, doc_type, status, expiry) values ($1, $2, 'Pending', $3::date)",
      [claims.sub, docType, expiry],
    );
    return res.status(201).json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.post("/driver/enroll", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);

    const profRes = await pool.query(
      `select dp.full_name, dp.phone, dp.vehicle_rego from driver_profiles dp where dp.user_id = $1`,
      [claims.sub],
    );
    if (!profRes.rowCount) return res.status(400).json({ error: "Complete your profile first" });
    const pr = profRes.rows[0] as { full_name: string | null; phone: string | null; vehicle_rego: string | null };

    const docsRes = await pool.query("select doc_type from driver_documents where driver_id = $1", [claims.sub]);
    const docTypes = (docsRes.rows as { doc_type: string }[]).map((r) => r.doc_type);
    if (!step4Complete(docTypes)) {
      return res.status(400).json({ error: "Add all required compliance documents before submitting" });
    }

    const existing = await pool.query("select status from driver_enrollments where user_id = $1", [claims.sub]);
    if (existing.rowCount && (existing.rows[0] as { status: string }).status === "pending") {
      return res.status(409).json({ error: "Application already submitted" });
    }
    if (existing.rowCount && (existing.rows[0] as { status: string }).status === "approved") {
      return res.status(409).json({ error: "Already approved" });
    }

    await pool.query(
      `insert into driver_enrollments (user_id, status, full_name, phone, vehicle_rego, verification_stage)
       values ($1, 'pending', $2, $3, $4, 'documents_review')
       on conflict (user_id) do update set
         status = 'pending',
         full_name = excluded.full_name,
         phone = excluded.phone,
         vehicle_rego = excluded.vehicle_rego,
         verification_stage = 'documents_review',
         reviewed_by = null,
         reviewed_at = null`,
      [claims.sub, pr.full_name, pr.phone?.replace(/\D/g, "") ?? null, pr.vehicle_rego],
    );

    return res.status(201).json({ ok: true, message: "Application submitted" });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
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
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

const DRIVER_TRIP_STATES = ["Assigned", "InProgress", "Completed"] as const;

app.patch("/driver/trips/:tripId/state", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const tripId = req.params.tripId;
    const state = String((req.body as { state?: string })?.state ?? "").trim();
    if (!DRIVER_TRIP_STATES.includes(state as (typeof DRIVER_TRIP_STATES)[number])) {
      return res.status(400).json({ error: "state must be Assigned, InProgress, or Completed" });
    }
    const updated = await pool.query(
      `update trips set state = $1 where id = $2 and driver_id = $3 returning id, state`,
      [state, tripId, claims.sub],
    );
    if (!updated.rowCount) {
      return res.status(404).json({ error: "Trip not found or not assigned to you" });
    }
    if (state === "Completed") {
      await pool.query(
        "update bookings set status = 'completed' where id = (select booking_id from trips where id = $1)",
        [tripId],
      );
    }
    const row = updated.rows[0] as { id: string; state: string };
    return res.json({ trip: { id: row.id, state: row.state } });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/driver/notifications", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      `select id, type, payload, read_at, created_at
       from notifications
       where recipient_id = $1
       order by created_at desc
       limit 100`,
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[driver-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

async function start() {
  try {
    await runMigrations();
  } catch (error) {
    console.error("[driver-service] migrations failed (refusing to start):", error);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`driver-service listening on ${port}`);
  });
}

void start();
