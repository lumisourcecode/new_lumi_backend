import "dotenv/config";
import express from "express";
import cors from "cors";
import { 
  pool, 
  requireAuth, 
  requireRole 
} from "@lumi/shared";
import { generateInvoicePDF, InvoiceData } from "./pdf-engine.js";

const app = express();
const port = Number(process.env.BILLING_SERVICE_PORT ?? 4600);

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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
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

/**
 * Triggered on trip completion (internal or from event)
 */
async function processTripCompletion(tripId: string) {
  const tripResult = await pool.query(
    `select t.*, b.rider_id, b.pickup, b.dropoff, b.is_ndis, b.vehicle_type_needed,
            rp.full_name as rider_name, rp.address_line1, rp.suburb, rp.state, rp.postcode
     from trips t
     join bookings b on b.id = t.booking_id
     left join rider_profiles rp on rp.user_id = b.rider_id
     where t.id = $1`,
    [tripId]
  );
  
  if (!tripResult.rowCount) return;
  const trip = tripResult.rows[0];
  
  const invNumber = `LUMI-${trip.id.split('-')[0].toUpperCase()}-${Date.now().toString().slice(-4)}`;
  
  const invoiceData: InvoiceData = {
    invoiceNumber: invNumber,
    issueDate: new Date().toLocaleDateString('en-AU'),
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-AU'),
    recipientName: trip.rider_name || "Valued Rider",
    recipientAddress: `${trip.address_line1 || ''}\n${trip.suburb || ''} ${trip.state || ''} ${trip.postcode || ''}`,
    items: [
      {
        description: `Transport Service: ${trip.pickup} to ${trip.dropoff}`,
        ndisCode: trip.is_ndis ? (trip.vehicle_type_needed === 'accessible' ? '04_590_0125_6_1' : '04_591_0125_6_1') : undefined,
        quantity: Number(trip.distance_km || 1),
        unitPrice: Number(trip.final_cost) / Number(trip.distance_km || 1),
        totalPrice: Number(trip.final_cost)
      }
    ],
    totalAmount: Number(trip.final_cost),
    taxAmount: 0, // NDIS transport usually GST free
    currency: "AUD",
    notes: `Trip completed on ${new Date(trip.created_at).toLocaleDateString('en-AU')}`
  };

  const pdfBuffer = await generateInvoicePDF(invoiceData);
  // In a real app, upload to S3 here. For now, we'll store local path summary or similar.
  const fileName = `${invNumber}.pdf`;

  const inserted = await pool.query(
    `insert into invoices (invoice_number, owner_id, recipient_id, trip_id, total_amount, status, pdf_url)
     values ($1, $2, $3, $4, $5, 'sent', $6)
     returning id`,
    [invNumber, '00000000-0000-0000-0000-000000000000', trip.rider_id, trip.id, trip.final_cost, fileName]
  );
  
  return inserted.rows[0];
}

app.post("/internal/process-trip", async (req, res) => {
  try {
    const { tripId } = req.body ?? {};
    if (!tripId) return res.status(400).send("tripId required");
    const result = await processTripCompletion(tripId);
    return res.json({ ok: true, invoice: result });
  } catch (error) {
    console.error("PDF Gen Error:", error);
    return res.status(500).json({ error: "Failed to generate invoice" });
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
    return res.status(401).json({ error: error instanceof Error ? error.message : "Unauthorized" });
  }
});

app.listen(port, () => {
  console.log(`billing-service listening on ${port}`);
});
