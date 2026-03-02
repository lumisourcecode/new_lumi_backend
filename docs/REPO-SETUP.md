# Backend Repo Setup (lumisourcecode/new_lumi_backend)

Backend is in a **separate repo** from frontend.

- **Backend:** https://github.com/lumisourcecode/new_lumi_backend
- **Frontend:** lumisourcecode/Frontend_Lumi_New (lumi-ride only)

---

## Push to backend repo

```bash
cd /Users/Lumi\ rides/UI/backend
git add .
git commit -m "Your message"
git push origin main
git push origin dev
```

---

## GitHub Secrets (in lumisourcecode/new_lumi_backend)

Settings → Secrets → Actions:

- `EC2_HOST`
- `EC2_USER`
- `EC2_SSH_KEY`
- `EC2_APP_DIR` (e.g. `/var/www/lumi-ride-backend`)
- `GIT_REPO_URL` (`https://USER:PAT@github.com/lumisourcecode/new_lumi_backend.git`)
- `BACKEND_ENV_B64`
