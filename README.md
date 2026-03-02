# new_lumi_backend

Lumi Ride Backend (lumisourcecode)

This backend is intentionally outside the frontend project and lives at `UI/backend`.
It is split by domain so each API can be hosted independently on ECS later.

these are the services for backend

## Services

- `api-gateway` (port 4000)
- `auth-service` (4100)
- `rider-service` (4200)
- `driver-service` (4300)
- `agent-service` (4400)
- `admin-service` (4500)

## Local Run

```bash
cd "/Users/Lumi rides/UI/backend"
cp .env.example .env
docker compose up -d
npm install
npm run db:init
npm run dev
```

## Frontend connection

In `UI/lumi-ride/.env.local`:

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:4000
```

# LumiRide_Backend

## Deploy

**Direct to EC2 (SCP):**
```bash
cd backend
export EC2_HOST=your-ec2-ip
export EC2_USER=ubuntu
export EC2_KEY=~/.ssh/your-key.pem
export EC2_APP_DIR=/var/www/lumi-ride-backend
bash scripts/deploy-via-scp.sh
```

**GitHub Actions:** Push to `dev` → auto-deploys to EC2
# new_lumi_backend
