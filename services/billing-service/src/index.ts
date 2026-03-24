import {
  pool,
  requireAuth,
  requireRole,
  runMigrations,
  sendGenericEmail,
} from "@lumi/shared";
import express from "express";
import cors from "cors";
import { generateInvoicePDF, InvoiceData } from "./pdf-engine.js";

const app = express();
const port = Number(process.env.BILLING_SERVICE_PORT ?? 4600);
const INTERNAL_SECRET = String(process.env.BILLING_INTERNAL_SECRET ?? "").trim();

function internalOk(req: express.Request, res: express.Response): boolean {
  if (!INTERNAL_SECRET) return true;
  if (String(req.headers["x-internal-secret"] ?? "") !== INTERNAL_SECRET) {
    res.status(403).json({ error: "Invalid internal secret" });
    return false;
  }
  return true;
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "billing-service" });
});

/**
 * Get all invoices (Admin)
 */
app.get("/admin/invoices", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    
    const result = await pool.query(
      `select i.*, u.email as recipient_email from invoices i
       join users u on u.id = i.recipient_id
       order by i.created_at desc limit 100`
    );
    return res.json({ items: result.rows });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[billing-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

/**
 * Manual Invoice Creation (Admin)
 */
app.post("/admin/invoices/manual", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);

    const { recipientId, items, notes, dueDate } = req.body ?? {};
    if (!recipientId || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: "recipientId and items array are required" });
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      
      const invNumber = `INV-${Date.now()}`;
      
      // Calculate total
      const total = items.reduce((acc, item) => acc + (Number(item.quantity) * Number(item.unitPrice)), 0);

      const inserted = await client.query(
        `insert into invoices (invoice_number, owner_id, recipient_id, due_date, total_amount, status, notes)
         values ($1, $2, $3, $4, $5, 'draft', $6)
         returning id`,
        [invNumber, claims.sub, recipientId, dueDate || null, total, notes || null]
      );
      
      const invoiceId = inserted.rows[0].id;

      for (const item of items) {
        await client.query(
          `insert into invoice_items (invoice_id, description, ndis_support_item, quantity, unit_price, total_price)
           values ($1, $2, $3, $4, $5, $6)`,
          [invoiceId, item.description, item.ndisSupportItem || null, item.quantity, item.unitPrice, Number(item.quantity) * Number(item.unitPrice)]
        );
      }

      await client.query("commit");
      return res.status(201).json({ id: invoiceId, invoiceNumber: invNumber });
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : "Internal Error" });
  }
});

app.post("/admin/invoices/:id/send", async (req, res) => {
  try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["admin"]);
    const { id } = req.params;
    const to = String(req.body?.to ?? "").trim();
    if (!to) return res.status(400).json({ error: "to is required" });

    const invoiceRes = await pool.query(
      `select i.id, i.invoice_number, i.total_amount, i.currency, i.status, i.notes, i.issue_date, i.due_date,
              i.trip_id, u.email as recipient_email
       from invoices i
       join users u on u.id = i.recipient_id
       where i.id = $1`,
      [id],
    );
    if (!invoiceRes.rowCount) return res.status(404).json({ error: "Invoice not found" });
    const invoice = invoiceRes.rows[0] as Record<string, unknown>;

    const itemsRes = await pool.query(
      `select description, ndis_support_item, quantity, unit_price, total_price
       from invoice_items where invoice_id = $1`,
      [id],
    );

    const tripInfo = invoice.trip_id
      ? await pool.query(
          `select b.pickup, b.dropoff, b.scheduled_at, t.state
           from trips t join bookings b on b.id = t.booking_id where t.id = $1`,
          [invoice.trip_id],
        )
      : { rows: [] };
    const trip = tripInfo.rows[0] as Record<string, unknown> | undefined;

    const itemsHtml = itemsRes.rows
      .map((it) => {
        const row = it as Record<string, unknown>;
        return `<li>${String(row.description ?? "Service")} | Qty: ${row.quantity} | Unit: ${row.unit_price} | Total: ${row.total_price}${row.ndis_support_item ? ` | NDIS: ${row.ndis_support_item}` : ""}</li>`;
      })
      .join("");

    const html = `
      <h2>Lumi Ride Invoice ${String(invoice.invoice_number)}</h2>
      <p><strong>Total:</strong> ${String(invoice.total_amount)} ${String(invoice.currency ?? "AUD")}</p>
      <p><strong>Status:</strong> ${String(invoice.status)}</p>
      <p><strong>Issue Date:</strong> ${String(invoice.issue_date ?? "")}</p>
      <p><strong>Due Date:</strong> ${String(invoice.due_date ?? "")}</p>
      ${trip ? `<p><strong>Trip:</strong> ${String(trip.pickup ?? "")} → ${String(trip.dropoff ?? "")} | ${String(trip.scheduled_at ?? "")} | ${String(trip.state ?? "")}</p>` : ""}
      <p><strong>Recipient:</strong> ${String(invoice.recipient_email ?? "")}</p>
      <p><strong>Notes:</strong> ${String(invoice.notes ?? "-")}</p>
      <h3>Line Items</h3>
      <ul>${itemsHtml || "<li>No invoice items.</li>"}</ul>
    `;

    const result = await sendGenericEmail({
      to,
      subject: `Invoice ${String(invoice.invoice_number)} from Lumi Ride`,
      html,
      text: html.replace(/<[^>]*>/g, " "),
    });

    if (result.delivered) {
      await pool.query("update invoices set status = 'sent', updated_at = now() where id = $1 and status = 'draft'", [id]);
    }
    return res.json({ ok: true, result });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Error";
    return res.status(500).json({ error: msg });
  }
});

async function htmlForInvoiceEmail(invoiceId: string): Promise<{ html: string; text: string } | null> {
  const invoiceRes = await pool.query(
    `select i.id, i.invoice_number, i.total_amount, i.currency, i.status, i.notes, i.issue_date, i.due_date, i.trip_id, u.email as recipient_email
     from invoices i join users u on u.id = i.recipient_id where i.id = $1`,
    [invoiceId],
  );
  if (!invoiceRes.rowCount) return null;
  const invoice = invoiceRes.rows[0] as Record<string, unknown>;
  const itemsRes = await pool.query(
    `select description, ndis_support_item, quantity, unit_price, total_price from invoice_items where invoice_id = $1`,
    [invoiceId],
  );
  const tripInfo = invoice.trip_id
    ? await pool.query(
        `select b.pickup, b.dropoff, b.scheduled_at, t.state from trips t join bookings b on b.id = t.booking_id where t.id = $1`,
        [invoice.trip_id],
      )
    : { rows: [] as Record<string, unknown>[] };
  const trip = tripInfo.rows[0] as Record<string, unknown> | undefined;
  const itemsHtml = itemsRes.rows
    .map((it) => {
      const row = it as Record<string, unknown>;
      return `<li>${String(row.description ?? "Service")} | Qty: ${row.quantity} | Unit: ${row.unit_price} | Total: ${row.total_price}${row.ndis_support_item ? ` | NDIS: ${row.ndis_support_item}` : ""}</li>`;
    })
    .join("");
  const html = `
      <h2>Lumi Ride Invoice ${String(invoice.invoice_number)}</h2>
      <p><strong>Total:</strong> ${String(invoice.total_amount)} ${String(invoice.currency ?? "AUD")}</p>
      <p><strong>Status:</strong> ${String(invoice.status)}</p>
      <p><strong>Issue Date:</strong> ${String(invoice.issue_date ?? "")}</p>
      <p><strong>Due Date:</strong> ${String(invoice.due_date ?? "")}</p>
      ${trip ? `<p><strong>Trip:</strong> ${String(trip.pickup ?? "")} → ${String(trip.dropoff ?? "")} | ${String(trip.scheduled_at ?? "")} | ${String(trip.state ?? "")}</p>` : ""}
      <p><strong>Recipient:</strong> ${String(invoice.recipient_email ?? "")}</p>
      <p><strong>Notes:</strong> ${String(invoice.notes ?? "-")}</p>
      <h3>Line Items</h3>
      <ul>${itemsHtml || "<li>No invoice items.</li>"}</ul>
    `;
  return { html, text: html.replace(/<[^>]*>/g, " ") };
}

/**
 * Triggered on trip completion (internal or from event)
 */
async function processTripCompletion(
  tripId: string,
  opts?: { sendEmailToRider?: boolean; emailTo?: string },
): Promise<Record<string, unknown> | null> {
  const dup = await pool.query(
    "select id, invoice_number, status from invoices where trip_id = $1 order by created_at desc limit 1",
    [tripId],
  );
  if (dup.rowCount) {
    return { ...(dup.rows[0] as object), reused: true };
  }

  const tripResult = await pool.query(
    `select t.*, b.rider_id, b.pickup, b.dropoff, b.is_ndis, b.vehicle_type_needed,
            rp.full_name as rider_name, rp.address_line1, rp.suburb, rp.state as rider_state, rp.postcode
     from trips t
     join bookings b on b.id = t.booking_id
     left join rider_profiles rp on rp.user_id = b.rider_id
     where t.id = $1`,
    [tripId],
  );

  if (!tripResult.rowCount) return null;
  const trip = tripResult.rows[0] as Record<string, unknown>;

  const ownerRow = await pool.query("select user_id from user_roles where role = 'admin' order by user_id asc limit 1");
  const ownerId = ownerRow.rows[0]?.user_id as string | undefined;
  if (!ownerId) throw new Error("No admin user in user_roles; cannot set invoice owner");

  const rawTotal = Number(trip.final_cost) || Number(trip.estimated_cost) || 0;
  const safeTotal = rawTotal > 0 ? rawTotal : 85;
  const dist = Number(trip.distance_km) > 0 ? Number(trip.distance_km) : 1;
  const unitPrice = Math.round((safeTotal / dist) * 100) / 100;

  const invNumber = `LUMI-${String(trip.id).split("-")[0].toUpperCase()}-${Date.now().toString().slice(-4)}`;
  const ndisItem =
    trip.is_ndis ?
      trip.vehicle_type_needed === "accessible" || trip.vehicle_type_needed === "Wheelchair-accessible" ?
        "04_590_0125_6_1"
      : "04_591_0125_6_1"
    : null;

  const invoiceData: InvoiceData = {
    invoiceNumber: invNumber,
    issueDate: new Date().toLocaleDateString("en-AU"),
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString("en-AU"),
    recipientName: String(trip.rider_name || "Valued Rider"),
    recipientAddress: `${trip.address_line1 || ""}\n${trip.suburb || ""} ${trip.rider_state || ""} ${trip.postcode || ""}`,
    items: [
      {
        description: `Transport: ${trip.pickup} → ${trip.dropoff}`,
        ndisCode: ndisItem ?? undefined,
        quantity: dist,
        unitPrice,
        totalPrice: safeTotal,
      },
    ],
    totalAmount: safeTotal,
    taxAmount: 0,
    currency: "AUD",
    notes: `Trip ${tripId} completed ${new Date(String(trip.created_at)).toLocaleDateString("en-AU")}`,
  };

  let fileName: string | null = null;
  try {
    await generateInvoicePDF(invoiceData);
    fileName = `${invNumber}.pdf`;
  } catch (e) {
    console.warn("[billing-service] PDF generation skipped:", e);
  }

  const inserted = await pool.query(
    `insert into invoices (invoice_number, owner_id, recipient_id, trip_id, total_amount, status, pdf_url, notes)
     values ($1, $2, $3, $4, $5, 'draft', $6, $7)
     returning id, invoice_number`,
    [invNumber, ownerId, trip.rider_id, trip.id, safeTotal, fileName, invoiceData.notes],
  );
  const invoiceId = inserted.rows[0]?.id as string;

  await pool.query(
    `insert into invoice_items (invoice_id, description, ndis_support_item, quantity, unit_price, total_price, tax_rate)
     values ($1, $2, $3, $4, $5, $6, 0)`,
    [invoiceId, invoiceData.items[0].description, ndisItem, dist, unitPrice, safeTotal],
  );

  let emailed = false;
  const override = String(opts?.emailTo ?? "").trim();
  let toAddr = override;
  if (!toAddr && opts?.sendEmailToRider) {
    const em = await pool.query("select email from users where id = $1", [trip.rider_id]);
    toAddr = String(em.rows[0]?.email ?? "").trim();
  }
  if (toAddr) {
    const built = await htmlForInvoiceEmail(invoiceId);
    if (built) {
      const result = await sendGenericEmail({
        to: toAddr,
        subject: `Lumi Ride invoice ${invNumber}`,
        html: built.html,
        text: built.text,
      });
      if (result.delivered) {
        await pool.query("update invoices set status = 'sent', updated_at = now() where id = $1", [invoiceId]);
        emailed = true;
      }
    }
  }

  return { id: invoiceId, invoice_number: invNumber, emailed, total: safeTotal };
}

app.post("/internal/process-trip", async (req, res) => {
  try {
    if (!internalOk(req, res)) return;
    const { tripId, sendEmailToRider, emailTo } = req.body ?? {};
    if (!tripId) return res.status(400).json({ error: "tripId required" });
    const result = await processTripCompletion(String(tripId), {
      sendEmailToRider: Boolean(sendEmailToRider),
      emailTo: String(emailTo ?? "").trim() || undefined,
    });
    return res.json({ ok: true, invoice: result });
  } catch (error) {
    console.error("process-trip:", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed to generate invoice" });
  }
});

/** Driver / internal: email an existing trip invoice to NDIA, plan manager, or custom address */
app.post("/internal/send-trip-invoice", async (req, res) => {
  try {
    if (!internalOk(req, res)) return;
    const tripId = String(req.body?.tripId ?? "").trim();
    const to = String(req.body?.to ?? "").trim();
    if (!tripId || !to) return res.status(400).json({ error: "tripId and to are required" });
    const inv = await pool.query(
      "select id from invoices where trip_id = $1 order by created_at desc limit 1",
      [tripId],
    );
    if (!inv.rowCount) return res.status(404).json({ error: "No invoice for this trip yet" });
    const invoiceId = inv.rows[0].id as string;
    const built = await htmlForInvoiceEmail(invoiceId);
    if (!built) return res.status(404).json({ error: "Invoice not found" });
    const invRow = await pool.query("select invoice_number from invoices where id = $1", [invoiceId]);
    const num = String(invRow.rows[0]?.invoice_number ?? "invoice");
    const result = await sendGenericEmail({
      to,
      subject: `Lumi Ride invoice ${num}`,
      html: built.html,
      text: built.text,
    });
    if (result.delivered) {
      await pool.query("update invoices set status = 'sent', updated_at = now() where id = $1 and status = 'draft'", [invoiceId]);
    }
    return res.json({ ok: true, result });
  } catch (error) {
    console.error("send-trip-invoice:", error);
    return res.status(500).json({ error: error instanceof Error ? error.message : "Failed" });
  }
});

/**
 * Get Partner Billing Settings
 */
app.get("/partner/billing-settings", async (req, res) => {
   try {
    const claims = requireAuth(req.headers.authorization);
    requireRole(claims, ["partner"]);
    
    const result = await pool.query(
      "select * from partner_billing_settings where partner_id = $1",
      [claims.sub]
    );
    return res.json(result.rows[0] || { auto_invoice: true, invoice_frequency: 'immediate' });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Internal Server Error";
    console.error("[billing-service] Error:", error);
    const status = msg === "Unauthorized" ? 401 : msg === "Forbidden" ? 403 : 500;
    return res.status(status).json({ error: msg });
  }
});

async function start() {
  try {
    await runMigrations();
  } catch (error) {
    console.error("[billing-service] migrations failed (refusing to start):", error);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`billing-service listening on ${port}`);
  });
}

void start();
