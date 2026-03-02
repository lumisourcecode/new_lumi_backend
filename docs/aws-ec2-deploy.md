# Backend Deployment to EC2 (Dev Server)

Backend deploys **automatically** with the frontend when you push to `dev`. Same EC2 instance.

> **Main/production** uses a separate deployment setup.

## Prerequisites

- Fresh Ubuntu EC2 instance (Action installs Node, PM2, nginx, Docker)
- GitHub repo with `lumi-ride` (frontend) and `backend` folders
- GitHub Actions secrets (see below)

## 1. GitHub Secrets

| Secret | Required | Description |
|--------|----------|-------------|
| `EC2_HOST` | Yes | EC2 public IP (e.g. `13.239.237.63`) |
| `EC2_USER` | Yes | SSH user (e.g. `ubuntu`) |
| `EC2_SSH_KEY` | Yes | Full PEM private key content |
| `EC2_APP_DIR` | Yes | Deploy path (e.g. `/var/www/lumi-ride-dev`) |
| `GIT_REPO_URL` | Yes | Clone URL. `https://github.com/lumisourcecode/new_lumi_backend.git` · Private: `https://USER:PAT@github.com/lumisourcecode/new_lumi_backend.git` |
| `BACKEND_ENV_B64` | Yes (for backend) | Base64 of your `backend/.env` (see below) |

### How to create `BACKEND_ENV_B64`

1. **Edit** `backend/.env` with your real values (JWT_SECRET, DB_PASSWORD, etc.). Use `backend/.env.example` as a template.
2. **Encode** the file content to base64:
   - **Linux:** `base64 -w0 backend/.env`
   - **macOS:** `base64 -i .env | tr -d '\n'` (run from `backend/` dir)
3. **Copy** the entire output (one long string, no line breaks).
4. **Paste** into GitHub → Settings → Secrets → `BACKEND_ENV_B64`.

Example `.env` structure (values are examples):

```
JWT_SECRET=your-long-random-secret
DB_HOST=localhost
DB_PASSWORD=postgres
DB_NAME=lumi_backend
REDIS_URL=redis://localhost:6379
ADMIN_EMAIL=admin@lumiride.com.au
ADMIN_PASSWORD=YourStrongPassword
...
```

> **Security:** Never commit real `.env` to git. The base64 secret is stored encrypted in GitHub.

## 2. Server Setup

**None required.** The GitHub Action installs Node, PM2, nginx, Docker, clones the repo, starts Postgres/Redis, and deploys. You only need the secrets above.

## 3. Nginx

Configured automatically by the Action (frontend on `/`, backend on `/api/`).

## 4. (Optional) Manual nginx config

```nginx
server {
    listen 80;
    server_name 13.239.237.63;  # or your domain

    # Frontend (Next.js)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Backend API (gateway on port 4000)
    location /api/ {
        proxy_pass http://127.0.0.1:4000/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Reload nginx: `sudo nginx -t && sudo systemctl reload nginx`

## 5. Frontend API URL

**Same-instance deploy:** The GitHub Action sets `NEXT_PUBLIC_API_BASE_URL=/api` at build time. Frontend and backend share the same domain; nginx routes `/api/` to the backend.

## 6. Deploy

**Automatic:** Push to `dev` → frontend + backend both deploy to the dev server.

**Manual:**

```bash
cd /var/www/lumi-ride-dev
git pull origin dev
cd backend
bash ./scripts/deploy-ec2.sh
pm2 status
```

## 7. PM2 Apps

After deploy, you should see:

- `lumi-ride-dev` (frontend, port 3000)
- `lumi-ride-dev-backend-gateway` (port 4000)
- `lumi-ride-dev-backend-auth` (4100)
- `lumi-ride-dev-backend-rider` (4200)
- `lumi-ride-dev-backend-driver` (4300)
- `lumi-ride-dev-backend-agent` (4400)
- `lumi-ride-dev-backend-admin` (4500)
