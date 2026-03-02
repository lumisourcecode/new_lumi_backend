import "dotenv/config";
import express from "express";
import cors from "cors";

import { pool, requireAuth, requireRole } from "@lumi/shared";

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
    return res.status(201).json({ ok: true, message: "Interest recorded. We'll be in touch." });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
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
    const row = result.rows[0] as Record<string, unknown>;
    return res.json({
      email: row.email,
      fullName: row.full_name ?? "",
      phone: row.phone ?? "",
      vehicleRego: row.vehicle_rego ?? "",
      vehicleMake: row.vehicle_make ?? "",
      vehicleColor: row.vehicle_color ?? "",
      verificationStatus: row.verification_status ?? "Pending",
      emergencyContact: row.emergency_contact ?? "",
      dateOfBirth: row.date_of_birth ?? null,
      addressLine1: row.address_line1 ?? "",
      suburb: row.suburb ?? "",
      state: row.state ?? "",
      postcode: row.postcode ?? "",
      licenseNumber: row.license_number ?? "",
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.patch("/driver/profile", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const fullName = String(req.body?.fullName ?? "").trim() || null;
    const phone = String(req.body?.phone ?? "").trim() || null;
    const vehicleRego = String(req.body?.vehicleRego ?? "").trim() || null;
    const vehicleMake = String(req.body?.vehicleMake ?? "").trim() || null;
    const vehicleColor = String(req.body?.vehicleColor ?? "").trim() || null;
    const emergencyContact = String(req.body?.emergencyContact ?? "").trim() || null;
    const dateOfBirth = req.body?.dateOfBirth || null;
    const addressLine1 = String(req.body?.addressLine1 ?? "").trim() || null;
    const suburb = String(req.body?.suburb ?? "").trim() || null;
    const state = String(req.body?.state ?? "").trim() || null;
    const postcode = String(req.body?.postcode ?? "").trim() || null;
    const licenseNumber = String(req.body?.licenseNumber ?? "").trim() || null;
    await pool.query(
      `insert into driver_profiles (user_id, full_name, phone, vehicle_rego, vehicle_make, vehicle_color, emergency_contact, date_of_birth, address_line1, suburb, state, postcode, license_number, verification_status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'Pending')
       on conflict (user_id) do update set
         full_name = coalesce($2, driver_profiles.full_name),
         phone = coalesce($3, driver_profiles.phone),
         vehicle_rego = coalesce($4, driver_profiles.vehicle_rego),
         vehicle_make = coalesce($5, driver_profiles.vehicle_make),
         vehicle_color = coalesce($6, driver_profiles.vehicle_color),
         emergency_contact = coalesce($7, driver_profiles.emergency_contact),
         date_of_birth = coalesce($8, driver_profiles.date_of_birth),
         address_line1 = coalesce($9, driver_profiles.address_line1),
         suburb = coalesce($10, driver_profiles.suburb),
         state = coalesce($11, driver_profiles.state),
         postcode = coalesce($12, driver_profiles.postcode),
         license_number = coalesce($13, driver_profiles.license_number)`,
      [claims.sub, fullName, phone, vehicleRego, vehicleMake, vehicleColor, emergencyContact, dateOfBirth, addressLine1, suburb, state, postcode, licenseNumber],
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

const NDIS_DOC_TYPES = [
  "Driver License (Australian)",
  "NDIS Worker Screening Check",
  "National Police Check",
  "Manual Handling Certificate",
  "CPR / First Aid Certificate",
  "Vehicle Registration",
  "Comprehensive Insurance",
];

app.get("/driver/onboarding", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const [profile, enrollment, docs] = await Promise.all([
      pool.query(
        `select full_name, phone, date_of_birth, address_line1, suburb, state, postcode, license_number, emergency_contact,
                vehicle_rego, vehicle_make, vehicle_color, verification_status
         from driver_profiles where user_id = $1`,
        [claims.sub],
      ),
      pool.query("select id, status, verification_stage, admin_notes from driver_enrollments where user_id = $1", [claims.sub]),
      pool.query("select doc_type, status from driver_documents where driver_id = $1", [claims.sub]),
    ]);
    const p = profile.rows[0] as Record<string, unknown> | undefined;
    const e = enrollment.rows[0] as { status: string; verification_stage: string; admin_notes: string } | undefined;
    const docList = docs.rows as { doc_type: string; status: string }[];

    const step1Complete = !!(p?.full_name && p?.phone && p?.date_of_birth && p?.address_line1 && p?.suburb && p?.state && p?.postcode);
    const step2Complete = !!(p?.license_number && p?.emergency_contact);
    const step3Complete = !!(p?.vehicle_rego && p?.vehicle_make);
    const requiredDocs = ["Driver License (Australian)", "NDIS Worker Screening Check", "National Police Check", "Manual Handling Certificate", "CPR / First Aid Certificate"];
    const step4Complete = requiredDocs.every((d) => docList.some((x) => x.doc_type === d));
    const totalSteps = 5;
    const completedSteps = [step1Complete, step2Complete, step3Complete, step4Complete, false].filter(Boolean).length;
    const profileCompletionPercent = Math.round(
      ((step1Complete ? 25 : 0) + (step2Complete ? 25 : 0) + (step3Complete ? 25 : 0) + (step4Complete ? 25 : 0)) / 1,
    );

    const canSubmit = step1Complete && step2Complete && step3Complete && step4Complete && (!e?.id || e?.status === "rejected");
    const isApproved = e?.status === "approved";
    const isPending = e?.status === "pending";
    const isRejected = e?.status === "rejected";

    return res.json({
      profileCompletionPercent: Math.min(100, completedSteps * 25),
      steps: [
        { id: 1, label: "Personal details", complete: step1Complete, required: ["Full name", "Phone", "Date of birth", "Address (street, suburb, state, postcode)"] },
        { id: 2, label: "License & emergency contact", complete: step2Complete, required: ["License number", "Emergency contact"] },
        { id: 3, label: "Vehicle details", complete: step3Complete, required: ["Registration", "Make/model"] },
        { id: 4, label: "NDIS compliance documents", complete: step4Complete, required: requiredDocs },
        { id: 5, label: "Submit for verification", complete: isPending || isApproved, required: ["Complete all steps above first"] },
      ],
      canSubmit,
      enrollment: e ? { status: e.status, verificationStage: e.verification_stage, adminNotes: e.admin_notes } : null,
      verificationStatus: p?.verification_status ?? "Pending",
      documents: docList,
    });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/earnings", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      `select t.id, t.state, t.created_at, b.pickup, b.dropoff, b.scheduled_at,
              rp.full_name as rider_name
       from trips t
       join bookings b on b.id = t.booking_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       where t.driver_id = $1
       order by t.created_at desc limit 200`,
      [claims.sub],
    );
    const completed = result.rows.filter((r: { state: string }) => r.state === "Completed");
    return res.json({
      items: result.rows,
      completedCount: completed.length,
      totalTrips: result.rows.length,
    });
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
    return res.json({
      tripsToday: Number(tripsToday.rows[0]?.c ?? 0),
      totalTrips: Number(totalTrips.rows[0]?.c ?? 0),
      inProgress: Number(inProgress.rows[0]?.c ?? 0),
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
      "select verification_status from driver_profiles where user_id = $1",
      [claims.sub],
    );
    if (!dp.rowCount || dp.rows[0]?.verification_status !== "Approved") {
      return res.json({ items: [] });
    }
    const result = await pool.query(
      `select t.id, t.created_at, b.pickup, b.dropoff, b.scheduled_at, b.mobility_needs,
              rp.full_name as rider_name
       from trips t
       join bookings b on b.id = t.booking_id
       left join rider_profiles rp on rp.user_id = b.rider_id
       where t.driver_id is null and t.state = 'pending_assignment'
       order by b.scheduled_at asc
       limit 50`,
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/notifications", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
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

app.patch("/driver/notifications/:id/read", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    await pool.query(
      "update notifications set read_at = now() where id = $1 and recipient_id = $2",
      [req.params.id, claims.sub],
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.post("/driver/enroll", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const existing = await pool.query("select id, status from driver_enrollments where user_id = $1", [claims.sub]);
    if (existing.rowCount && (existing.rows[0] as { status: string }).status === "pending") {
      return res.status(409).json({ error: "Application already pending review" });
    }
    const profile = await pool.query(
      `select full_name, phone, vehicle_rego, date_of_birth, address_line1, suburb, state, postcode, license_number, emergency_contact, vehicle_make
       from driver_profiles where user_id = $1`,
      [claims.sub],
    );
    const p = profile.rows[0] as Record<string, unknown> | undefined;
    const step1 = !!(p?.full_name && p?.phone && p?.date_of_birth && p?.address_line1 && p?.suburb && p?.state && p?.postcode);
    const step2 = !!(p?.license_number && p?.emergency_contact);
    const step3 = !!(p?.vehicle_rego && p?.vehicle_make);
    const docs = await pool.query("select doc_type from driver_documents where driver_id = $1", [claims.sub]);
    const docList = docs.rows as { doc_type: string }[];
    const requiredDocs = ["Driver License (Australian)", "NDIS Worker Screening Check", "National Police Check", "Manual Handling Certificate", "CPR / First Aid Certificate"];
    const step4 = requiredDocs.every((d) => docList.some((x) => x.doc_type === d));
    if (!step1 || !step2 || !step3 || !step4) {
      return res.status(400).json({ error: "Complete all profile steps and upload required documents before applying" });
    }
    const fullName = p?.full_name ?? null;
    const phone = p?.phone ?? null;
    const vehicleRego = p?.vehicle_rego ?? null;
    if (existing.rowCount) {
      await pool.query(
        `update driver_enrollments set status = 'pending', verification_stage = 'profile_review', full_name = $1, phone = $2, vehicle_rego = $3, reviewed_by = null, reviewed_at = null, admin_notes = null
         where user_id = $4`,
        [fullName, phone, vehicleRego, claims.sub],
      );
    } else {
      await pool.query(
        `insert into driver_enrollments (user_id, full_name, phone, vehicle_rego, verification_stage) values ($1, $2, $3, $4, 'profile_review')`,
        [claims.sub, fullName, phone, vehicleRego],
      );
    }
    await pool.query(
      "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'driver_enrolled', 'enrollment', $2, $3)",
      [claims.sub, claims.sub, JSON.stringify({ fullName, phone, vehicleRego })],
    );
    const enrollment = await pool.query("select * from driver_enrollments where user_id = $1", [claims.sub]);
    return res.json({ enrollment: enrollment.rows[0] });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/enroll/status", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      "select id, status, full_name, phone, vehicle_rego, notes, reviewed_at, created_at from driver_enrollments where user_id = $1",
      [claims.sub],
    );
    return res.json({ enrollment: result.rows[0] ?? null });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.get("/driver/documents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const result = await pool.query(
      "select id, doc_type, status, expiry, created_at from driver_documents where driver_id = $1 order by doc_type",
      [claims.sub],
    );
    return res.json({ items: result.rows });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.post("/driver/documents", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const { docType, expiry } = req.body ?? {};
    if (!docType) return res.status(400).json({ error: "docType is required" });
    const inserted = await pool.query(
      "insert into driver_documents (driver_id, doc_type, status, expiry) values ($1, $2, 'Pending', $3) returning id, doc_type, status, expiry",
      [claims.sub, docType, expiry ?? null],
    );
    return res.status(201).json({ document: inserted.rows[0] });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.post("/driver/trips/:tripId/accept", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const tripId = req.params.tripId;
    const trip = await pool.query(
      "select id from trips where id = $1 and driver_id is null and state = 'pending_assignment'",
      [tripId],
    );
    if (!trip.rowCount) return res.status(404).json({ error: "Trip not found or already assigned" });
    await pool.query(
      "update trips set driver_id = $1, state = 'Assigned', assigned_at = now() where id = $2",
      [claims.sub, tripId],
    );
    const booking = await pool.query("select rider_id from bookings where id = (select booking_id from trips where id = $1)", [tripId]);
    await pool.query(
      "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'driver_accepted_trip', 'trip', $2, $3)",
      [claims.sub, tripId, JSON.stringify({ driverId: claims.sub })],
    );
    return res.json({ ok: true });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.patch("/driver/trips/:tripId/state", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["driver"]);
    const tripId = req.params.tripId;
    const state = String(req.body?.state ?? "");
    if (!state) return res.status(400).json({ error: "state is required" });

    const updated = await pool.query(
      "update trips set state = $1 where id = $2 and driver_id = $3 returning id, state, booking_id",
      [state, tripId, claims.sub],
    );
    if (!updated.rowCount) return res.status(404).json({ error: "Trip not found" });
    const row = updated.rows[0] as { booking_id?: string };
    if (state === "Completed" && row?.booking_id) {
      await pool.query("update bookings set status = 'completed' where id = $1", [row.booking_id]);
    }
    await pool.query(
      "insert into activity_log (user_id, action, entity_type, entity_id, payload) values ($1, 'trip_state_updated', 'trip', $2, $3)",
      [claims.sub, tripId, JSON.stringify({ state })],
    );
    return res.json({ trip: updated.rows[0] });
  } catch (error) {
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.listen(port, () => {
  console.log(`driver-service listening on ${port}`);
});

