import "dotenv/config";
import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const port = Number(process.env.GATEWAY_PORT ?? 4000);

/** Nginx default proxy_read_timeout is 60s; align so long SMTP tests and slow admin queries do not get 504 early. */
const PROXY_TIMEOUT_MS = Number(process.env.GATEWAY_PROXY_TIMEOUT_MS ?? 180_000);

const authTarget = `http://localhost:${process.env.AUTH_SERVICE_PORT ?? 4100}`;
const riderTarget = `http://localhost:${process.env.RIDER_SERVICE_PORT ?? 4200}`;
const driverTarget = `http://localhost:${process.env.DRIVER_SERVICE_PORT ?? 4300}`;
const partnerTarget = `http://localhost:${process.env.PARTNER_SERVICE_PORT ?? process.env.AGENT_SERVICE_PORT ?? 4400}`;
const adminTarget = `http://localhost:${process.env.ADMIN_SERVICE_PORT ?? 4500}`;
const billingTarget = `http://localhost:${process.env.BILLING_SERVICE_PORT ?? 4600}`;

app.use(cors({ origin: true, credentials: true }));
// Do NOT use express.json() - it consumes the body and breaks proxy forwarding of POST/PUT

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "api-gateway" });
});

const proxyOpts = (target: string, pathRewrite: Record<string, string>) => ({
  target,
  changeOrigin: true,
  pathRewrite,
  proxyTimeout: PROXY_TIMEOUT_MS,
});

app.use(
  "/auth",
  createProxyMiddleware({
    ...proxyOpts(authTarget, { "^/": "/auth/" }),
  }),
);

app.use(
  "/rider",
  createProxyMiddleware({
    ...proxyOpts(riderTarget, { "^/": "/rider/" }),
  }),
);

app.use(
  "/driver",
  createProxyMiddleware({
    ...proxyOpts(driverTarget, { "^/": "/driver/" }),
    on: {
      proxyReq: (proxyReq, req) => {
        if (req.headers.authorization) {
          proxyReq.setHeader("Authorization", req.headers.authorization);
        }
      },
    },
  }),
);

app.use(
  "/partner",
  createProxyMiddleware({
    ...proxyOpts(partnerTarget, { "^/": "/partner/" }),
  }),
);

// Backward-compatible route alias during migration.
app.use(
  "/agent",
  createProxyMiddleware({
    ...proxyOpts(partnerTarget, { "^/": "/partner/" }),
  }),
);

app.use(
  "/admin",
  createProxyMiddleware({
    ...proxyOpts(adminTarget, { "^/": "/admin/" }),
  }),
);

app.use(
  "/billing",
  createProxyMiddleware({
    ...proxyOpts(billingTarget, { "^/": "/billing/" }),
  }),
);

app.listen(port, () => {
  console.log(`api-gateway listening on ${port}`);
});

