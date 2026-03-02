import "dotenv/config";
import express from "express";
import cors from "cors";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const port = Number(process.env.GATEWAY_PORT ?? 4000);

const authTarget = `http://localhost:${process.env.AUTH_SERVICE_PORT ?? 4100}`;
const riderTarget = `http://localhost:${process.env.RIDER_SERVICE_PORT ?? 4200}`;
const driverTarget = `http://localhost:${process.env.DRIVER_SERVICE_PORT ?? 4300}`;
const agentTarget = `http://localhost:${process.env.AGENT_SERVICE_PORT ?? 4400}`;
const adminTarget = `http://localhost:${process.env.ADMIN_SERVICE_PORT ?? 4500}`;

app.use(cors({ origin: true, credentials: true }));
// Do NOT use express.json() - it consumes the body and breaks proxy forwarding of POST/PUT

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, service: "api-gateway" });
});

app.use(
  "/auth",
  createProxyMiddleware({
    target: authTarget,
    changeOrigin: true,
    pathRewrite: { "^/": "/auth/" },
  }),
);

app.use(
  "/rider",
  createProxyMiddleware({
    target: riderTarget,
    changeOrigin: true,
    pathRewrite: { "^/": "/rider/" },
  }),
);

app.use(
  "/driver",
  createProxyMiddleware({
    target: driverTarget,
    changeOrigin: true,
    pathRewrite: { "^/": "/driver/" },
    onProxyReq: (proxyReq, req) => {
      if (req.headers.authorization) {
        proxyReq.setHeader("Authorization", req.headers.authorization);
      }
    },
  }),
);

app.use(
  "/agent",
  createProxyMiddleware({
    target: agentTarget,
    changeOrigin: true,
    pathRewrite: { "^/": "/agent/" },
  }),
);

app.use(
  "/admin",
  createProxyMiddleware({
    target: adminTarget,
    changeOrigin: true,
    pathRewrite: { "^/": "/admin/" },
  }),
);

app.listen(port, () => {
  console.log(`api-gateway listening on ${port}`);
});

