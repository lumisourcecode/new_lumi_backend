import fs from 'node:fs';

import puppeteer from 'puppeteer';
import handlebars from 'handlebars';

/** On servers we set PUPPETEER_SKIP_DOWNLOAD and use apt-installed Chromium. */
function resolveChromeExecutable(): string | undefined {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

export type InvoiceData = {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  recipientName: string;
  recipientAddress: string;
  items: Array<{
    description: string;
    ndisCode?: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
  }>;
  totalAmount: number;
  taxAmount: number;
  currency: string;
  notes?: string;
};

const INVOICE_TEMPLATE = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; color: #1e293b; padding: 40px; }
    .header { display: flex; justify-content: space-between; margin-bottom: 40px; }
    .logo { font-size: 24px; font-weight: 900; color: #4338ca; }
    .invoice-info { text-align: right; }
    .bill-to { margin-bottom: 40px; }
    .bill-to h2 { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.1em; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 40px; }
    th { text-align: left; border-bottom: 2px solid #e2e8f0; padding: 12px 0; font-size: 12px; text-transform: uppercase; color: #64748b; }
    td { padding: 16px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
    .total-section { display: flex; justify-content: flex-end; }
    .total-box { width: 200px; }
    .total-row { display: flex; justify-content: space-between; padding: 8px 0; }
    .grand-total { border-top: 2px solid #4338ca; font-weight: 900; font-size: 18px; color: #4338ca; margin-top: 8px; padding-top: 16px; }
    .footer { margin-top: 60px; font-size: 10px; color: #94a3b8; text-align: center; border-top: 1px solid #f1f5f9; padding-top: 20px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">LUMI RIDES</div>
    <div class="invoice-info">
      <h1 style="margin:0; font-size: 24px;">TAX INVOICE</h1>
      <p style="margin:4px 0; font-size: 14px; font-weight: bold;">{{invoiceNumber}}</p>
      <p style="margin:0; font-size: 12px; color: #64748b;">Issued: {{issueDate}}</p>
    </div>
  </div>

  <div class="bill-to">
    <h2>Bill To</h2>
    <p style="margin:0; font-weight: bold;">{{recipientName}}</p>
    <p style="margin:4px 0; color: #64748b; font-size: 14px; white-space: pre-line;">{{recipientAddress}}</p>
  </div>

  <table>
    <thead>
      <tr>
        <th>Description</th>
        <th style="text-align: right;">Qty</th>
        <th style="text-align: right;">Rate</th>
        <th style="text-align: right;">Amount</th>
      </tr>
    </thead>
    <tbody>
      {{#each items}}
      <tr>
        <td>
          <div style="font-weight: bold;">{{description}}</div>
          {{#if ndisCode}}<div style="font-size: 11px; color: #64748b; margin-top: 2px;">NDIS Code: {{ndisCode}}</div>{{/if}}
        </td>
        <td style="text-align: right;">{{quantity}}</td>
        <td style="text-align: right;">{{currency}} {{unitPrice}}</td>
        <td style="text-align: right; font-weight: bold;">{{currency}} {{totalPrice}}</td>
      </tr>
      {{/each}}
    </tbody>
  </table>

  <div class="total-section">
    <div class="total-box">
      <div class="total-row">
        <span style="color: #64748b;">Subtotal</span>
        <span style="font-weight: bold;">{{currency}} {{totalAmount}}</span>
      </div>
      <div class="total-row">
        <span style="color: #64748b;">Tax</span>
        <span style="font-weight: bold;">{{currency}} {{taxAmount}}</span>
      </div>
      <div class="total-row grand-total">
        <span>TOTAL</span>
        <span>{{currency}} {{totalAmount}}</span>
      </div>
    </div>
  </div>

  {{#if notes}}
  <div style="margin-top: 40px; padding: 20px; background: #f8fafc; border-radius: 8px;">
     <h3 style="margin:0 0 8px 0; font-size: 12px; text-transform: uppercase; color: #64748b;">Notes</h3>
     <p style="margin:0; font-size: 13px; color: #334155;">{{notes}}</p>
  </div>
  {{/if}}

  <div class="footer">
    <p>Lumi Rides Australia | ABN: 45 678 901 234</p>
    <p>Payment due within 7 days of issue.</p>
  </div>
</body>
</html>
`;

export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  const executablePath = resolveChromeExecutable();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(executablePath ? { executablePath } : {}),
  });
  
  const page = await browser.newPage();
  const template = handlebars.compile(INVOICE_TEMPLATE);
  const html = template(data);

  await page.setContent(html, { waitUntil: 'networkidle0' });
  const pdf = await page.pdf({ 
    format: 'A4',
    printBackground: true,
    margin: { top: '0', right: '0', bottom: '0', left: '0' }
  });

  await browser.close();
  return Buffer.from(pdf);
}
