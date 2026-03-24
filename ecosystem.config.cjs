/**
 * PM2: all apps must run together — the gateway only proxies; it does not implement APIs.
 * From repo `backend/`: `pm2 start ecosystem.config.cjs` (or `bash scripts/deploy-ec2.sh`).
 */
/** @type {import('pm2').StartOptions} */
module.exports = {
  apps: [
    { name: "lumi-ride-dev-backend-gateway", script: "npm", args: "run start", cwd: "./services/api-gateway", env: { NODE_ENV: "production" } },
    { name: "lumi-ride-dev-backend-auth", script: "npm", args: "run start", cwd: "./services/auth-service", env: { NODE_ENV: "production" } },
    { name: "lumi-ride-dev-backend-rider", script: "npm", args: "run start", cwd: "./services/rider-service", env: { NODE_ENV: "production" } },
    { name: "lumi-ride-dev-backend-driver", script: "npm", args: "run start", cwd: "./services/driver-service", env: { NODE_ENV: "production" } },
    { name: "lumi-ride-dev-backend-partner", script: "npm", args: "run start", cwd: "./services/agent-service", env: { NODE_ENV: "production" } },
    { name: "lumi-ride-dev-backend-admin", script: "npm", args: "run start", cwd: "./services/admin-service", env: { NODE_ENV: "production" } },
    { name: "lumi-ride-dev-backend-billing", script: "npm", args: "run start", cwd: "./services/billing-service", env: { NODE_ENV: "production" } },
  ],
};
