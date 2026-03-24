import { config as loadEnv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(__dirname, "../../../.env") });
import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const port = Number(process.env.GATEWAY_PORT ?? 4000);

/** Nginx default proxy_read_timeout is 60s; align so long SMTP tests and slow admin queries do not get 504 early. */
const PROXY_TIMEOUT_MS = Number(process.env.GATEWAY_PROXY_TIMEOUT_MS ?? 300_000);

/** Use IPv4 loopback on EC2/Linux — `localhost` can resolve to ::1 while services listen on 127.0.0.1 only, causing flaky proxies. */
const upstreamHost = process.env.GATEWAY_UPSTREAM_HOST ?? "127.0.0.1";

const authTarget = `http://${upstreamHost}:${process.env.AUTH_SERVICE_PORT ?? 4100}`;
const riderTarget = `http://${upstreamHost}:${process.env.RIDER_SERVICE_PORT ?? 4200}`;
const driverTarget = `http://${upstreamHost}:${process.env.DRIVER_SERVICE_PORT ?? 4300}`;
const partnerTarget = `http://${upstreamHost}:${process.env.PARTNER_SERVICE_PORT ?? process.env.AGENT_SERVICE_PORT ?? 4400}`;
const adminTarget = `http://${upstreamHost}:${process.env.ADMIN_SERVICE_PORT ?? 4500}`;
const billingTarget = `http://${upstreamHost}:${process.env.BILLING_SERVICE_PORT ?? 4600}`;

app.use(cors({ origin: true, credentials: true }));
// Do NOT use express.json() - it consumes the body and breaks proxy forwarding of POST/PUT

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "api-gateway" });
});

function probeService(name: string, url: string): Promise<{ name: string; ok: boolean; ms: number; error?: string }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = http.get(url, { timeout: 3000 }, (r) => {
      r.resume();
      const ok = (r.statusCode ?? 0) >= 200 && (r.statusCode ?? 0) < 300;
      resolve({ name, ok, ms: Date.now() - t0, ...(ok ? {} : { error: `HTTP ${r.statusCode}` }) });
    });
    req.on("error", (e) => resolve({ name, ok: false, ms: Date.now() - t0, error: e.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ name, ok: false, ms: Date.now() - t0, error: "timeout" });
    });
  });
}

/** Quick diagnosis when every /api/* returns 504 — open in browser: /api/healthz/services */
app.get("/healthz/services", async (_req, res) => {
  const checks = await Promise.all([
    probeService("auth", `${authTarget}/healthz`),
    probeService("rider", `${riderTarget}/healthz`),
    probeService("driver", `${driverTarget}/healthz`),
    probeService("partner", `${partnerTarget}/healthz`),
    probeService("admin", `${adminTarget}/healthz`),
    probeService("billing", `${billingTarget}/healthz`),
  ]);
  const allOk = checks.every((c) => c.ok);
  res.status(allOk ? 200 : 503).json({ ok: allOk, upstreamHost, checks });
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

