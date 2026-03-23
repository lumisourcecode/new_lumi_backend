# Backend Deploy Setup – Step by Step

## Standalone backend repo (`new_lumi_backend`, etc.)

If your GitHub repo is **only** the backend (root shows `services/`, `docker-compose.yml`, **no** `.github` yet):

1. **Add the workflow file** to the repo root (commit & push to `dev`):
   - Copy **`backend/.github/workflows/deploy-dev.yml`** from this monorepo into **your repo** as:
     - `.github/workflows/deploy-dev.yml`
2. **GitHub → Settings → Secrets and variables → Actions**
   - **Secrets:** `EC2_HOST`, `EC2_USER`, `EC2_SSH_KEY` or `EC2_SSH_KEY_B64`, `BACKEND_ENV_B64` (base64 of your production `.env`)
   - **Variables → Actions:** `BACKEND_EC2_PATH` = absolute path on EC2 (e.g. `/var/www/lumi-ride-backend`)
3. Push to **`dev`** → **Actions** tab should show **Deploy backend to EC2**.

Without step 1, **nothing runs** — GitHub only loads workflows from `.github/workflows/` at the **repository root**.

---

> **Monorepo note:** If you use the **UI monorepo** instead, deploy workflows live at the **repository root**: `.github/workflows/deploy-dev.yml`.  
> Backend auto-deploy runs when you set the variable **`BACKEND_EC2_PATH`** (see `docs/GITHUB-DEPLOY.md`).  
> The steps below still apply for **`BACKEND_ENV_B64`** and EC2 layout.

Auto-deploy to EC2 when you push to `dev`.

---

## Step 1: Create GitHub PAT with workflow scope

1. Go to **https://github.com/settings/tokens/new**
2. **Note:** `Lumi Backend Deploy`
3. **Expiration:** 90 days (or No expiration)
4. **Scopes:** Check:
   - ✅ **repo** (Full control of private repositories)
   - ✅ **workflow** (Update GitHub Action workflows)
5. Click **Generate token**
6. Copy the token and store it safely (you won’t see it again)

---

## Step 2: Add GitHub Secrets

1. Open your **GitHub repo** (monorepo root) on GitHub
2. Go to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret** and add each:

| Secret Name       | How to get the value |
|-------------------|----------------------|
| `EC2_HOST`        | EC2 public IP (e.g. `13.239.237.63`) |
| `EC2_USER`        | SSH user, usually `ubuntu` |
| `EC2_SSH_KEY`     | Full content of your `.pem` file (including `-----BEGIN...` and `-----END...`) |
| `EC2_APP_DIR`     | **Frontend** deploy path, e.g. `/var/www/lumi-ride-dev` |
| (Variable) `BACKEND_EC2_PATH` | **Backend** path on EC2, e.g. `/var/www/lumi-ride-backend` — set under **Variables** |
| `GIT_REPO_URL`    | `https://YOUR_GITHUB_USER:YOUR_PAT@github.com/ORG/REPO.git` (backend repo URL with PAT from Step 1) |
| `BACKEND_ENV_B64` | See Step 3 below |

---

## Step 3: Create BACKEND_ENV_B64

1. Edit `backend/.env` with your real values (JWT_SECRET, DB_PASSWORD, etc.)
2. Encode it:
   ```bash
   cd backend
   base64 -i .env | tr -d '\n'
   ```
3. Copy the entire output (one long string)
4. Add as secret `BACKEND_ENV_B64` in GitHub

---

## Step 4: Configure Git to use PAT for push

```bash
cd /Users/Lumi\ rides/UI
git remote set-url origin https://YOUR_GITHUB_USER:YOUR_PAT@github.com/ORG/REPO.git
```

Replace `YOUR_GITHUB_USER`, `YOUR_PAT`, `ORG`, and `REPO` with your backend repo details.

---

## Step 5: Push the workflow

```bash
cd /path/to/your/UI
git add .github/workflows docs backend/docs
git commit -m "Add root deploy workflow"
git push origin dev
```

---

## Step 6: Verify

1. Go to your repo → **Actions**
2. You should see **Deploy dev to EC2** run (frontend; backend if `BACKEND_EC2_PATH` is set)
3. Check the run logs for success

---

## Checklist

- [ ] PAT created with **repo** + **workflow** scopes
- [ ] All 6 secrets added in GitHub
- [ ] `GIT_REPO_URL` includes PAT for private repo
- [ ] `BACKEND_ENV_B64` = base64 of `backend/.env`
- [ ] Git remote updated with PAT
- [ ] Pushed to `dev`

---

## Manual run

**Actions** → **Deploy Backend Dev to EC2** → **Run workflow** → **Run workflow**
