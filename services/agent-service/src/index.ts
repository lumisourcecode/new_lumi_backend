import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "node:crypto";

import { hashPassword, pool, requireAuth, requireRole } from "@lumi/shared";

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

function registerRoutes(prefix: "/partner" | "/agent") {
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
    }
  });

  app.get(`${prefix}/stats`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const today = new Date().toISOString().slice(0, 10);
      const clientsCount = await pool.query("select count(*) from partner_clients where partner_id = $1", [claims.sub]);
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

  app.get(`${prefix}/bookings`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
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
         where b.created_by = $1
         order by b.created_at desc limit 200`,
        [claims.sub],
      );
      return res.json({ items: result.rows });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
    }
  });

  app.get(`${prefix}/clients`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const result = await pool.query(
        `select u.id, u.email, rp.full_name, rp.phone, rp.ndis_id, pc.notes,
                (select count(*) from bookings b where b.rider_id = u.id and b.created_by = $1) as bookings_count
         from partner_clients pc
         join users u on u.id = pc.rider_id
         left join rider_profiles rp on rp.user_id = u.id
         where pc.partner_id = $1
         order by rp.full_name nulls last, u.email
         limit 500`,
        [claims.sub],
      );
      return res.json({ items: result.rows });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
    }
  });

  app.get(`${prefix}/riders`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const result = await pool.query(
        `select u.id, u.email, rp.full_name, rp.phone
         from partner_clients pc
         join users u on u.id = pc.rider_id
         left join rider_profiles rp on rp.user_id = u.id
         where pc.partner_id = $1
         order by rp.full_name nulls last, u.email
         limit 500`,
        [claims.sub],
      );
      return res.json({ items: result.rows });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
    }
  });

  app.patch(`${prefix}/clients/:riderId`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const { riderId } = req.params;
      const { fullName, phone, ndisId, notes } = parseClientInput(req.body);
      const owned = await pool.query(
        "select 1 from partner_clients where partner_id = $1 and rider_id = $2",
        [claims.sub, riderId],
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
        [claims.sub, riderId, notes],
      );
      return res.json({ ok: true });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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

      const inserted = await pool.query(
        `insert into bookings (rider_id, pickup, dropoff, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, scheduled_at, status, mobility_needs, notes, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'pending_matching',$9,$10,$11)
         returning id, pickup, dropoff, scheduled_at, status, created_at`,
        [riderId, pickup, dropoff, pickupLat, pickupLng, dropoffLat, dropoffLng, scheduledAt, req.body?.mobilityNeeds ?? null, req.body?.notes ?? null, claims.sub],
      );
      const booking = inserted.rows[0] as { id: string };
      await pool.query("insert into trips (booking_id, state) values ($1, 'pending_assignment')", [booking.id]);

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

  app.get(`${prefix}/plans`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const rows = await pool.query(
        `select id, name, target_group, frequency, start_date, end_date, priority, notes, status, created_at, updated_at
         from partner_travel_plans
         where partner_id = $1
         order by created_at desc`,
        [claims.sub],
      );
      return res.json({ items: rows.rows });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
    }
  });

  app.patch(`${prefix}/plans/:id`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
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
          claims.sub,
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
    }
  });

  app.get(`${prefix}/support-tickets`, async (req, res) => {
    try {
      const claims = requireAuth(req.headers.authorization);
      requireRole(claims, ["partner"]);
      const rows = await pool.query(
        `select id, issue_type, reference_id, priority, message, status, created_at, updated_at
         from support_tickets
         where created_by = $1 and role = 'partner'
         order by created_at desc`,
        [claims.sub],
      );
      return res.json({ items: rows.rows });
    } catch (error) {
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
      return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.listen(port, () => {
  console.log(`partner-service listening on ${port}`);
});

