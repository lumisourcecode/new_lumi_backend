# GitHub Account Guide – Personal vs Org

Clear steps to know which account you're using and what to do where.

---

## Part 1: Find which GitHub account you're using

### Method A: Check in browser

1. Open **https://github.com**
2. If logged in, click your **profile picture** (top right)
3. Your **username** is shown under your name
4. Check the URL when you click your profile: `https://github.com/YOUR_USERNAME`

### Method B: Check your Git config

Open Terminal and run:

```bash
# Who does Git think you are?
git config user.name
git config user.email

# Which account is used for this repo?
cd /Users/Lumi\ rides/UI
git remote -v
```

- `origin` URL shows the repo: `github.com/lumisourcecode/Frontend_Lumi_New`
- `lumisourcecode` is the **owner** (org or user)
- Your **login** is whoever is authenticated when you push

### Method C: Check GitHub CLI (if installed)

```bash
gh auth status
```

This shows which account is logged in.

---

## Part 2: Personal vs Org – what’s what

| | **Personal account** | **Org account** |
|---|----------------------|------------------|
| **Example** | `binayapuri` | `lumisourcecode` |
| **URL** | github.com/binayapuri | github.com/lumisourcecode |
| **Repos** | Your own repos | Org’s repos |
| **PAT** | Created in your settings | Created in your settings (but can access org repos you have access to) |
| **Secrets** | In your repo settings | In the org repo settings |

---

## Part 3: Where is your backend repo?

Your backend repo is: **https://github.com/lumisourcecode/Frontend_Lumi_New**

- **Owner:** `lumisourcecode` (org)
- **Repo:** `Frontend_Lumi_New`

So the repo lives under the **org** `lumisourcecode`.

---

## Part 4: What to do – step by step

### Step 1: Log in to the right account

1. Go to **https://github.com**
2. If you see the wrong account, click your profile picture → **Sign out**
3. Sign in with the account that has access to `lumisourcecode/Frontend_Lumi_New`

### Step 2: Create a PAT (Personal Access Token)

PATs are always created in **your** account, even for org repos.

1. Go to **https://github.com/settings/tokens**
   - If you see your org, you’re in the org. Switch to your user: click your profile picture → **Your profile** → **Settings**
2. Or go directly: **https://github.com/settings/tokens** (this is always your personal account)
3. Click **Generate new token** → **Generate new token (classic)**
4. **Note:** `Backend Deploy`
5. **Expiration:** 90 days
6. **Scopes:** check **repo** and **workflow**
7. Click **Generate token**
8. Copy the token and store it safely

### Step 3: Add secrets in the **repo** (org repo)

1. Open **https://github.com/lumisourcecode/Frontend_Lumi_New**
2. Go to **Settings** (repo settings, not your profile)
3. Left sidebar: **Secrets and variables** → **Actions**
4. Click **New repository secret**
5. Add each secret (see list below)

### Step 4: Update Git remote with your PAT

Use **your** GitHub username and the PAT you created:

```bash
cd /Users/Lumi\ rides/UI
git remote set-url origin https://YOUR_USERNAME:YOUR_PAT@github.com/lumisourcecode/Frontend_Lumi_New.git
```

Example: if your username is `binayapuri` and PAT is `ghp_xxxx`:

```bash
git remote set-url origin https://binayapuri:ghp_xxxx@github.com/lumisourcecode/Frontend_Lumi_New.git
```

### Step 5: Push

```bash
git push origin dev
```

---

## Part 5: Quick checklist

| Task | Where | Notes |
|------|--------|------|
| Create PAT | **Your** account → Settings → Developer settings → Tokens | Use your personal GitHub login |
| Add secrets | **Repo** lumisourcecode/Frontend_Lumi_New → Settings → Secrets | Repo is under org |
| Set Git remote | Your terminal | Use YOUR_USERNAME:YOUR_PAT |
| Push | Your terminal | Uses the remote URL with PAT |

---

## Part 6: Common confusions

**Q: I’m in the org. Where do I create the PAT?**  
A: In your personal account: https://github.com/settings/tokens (not org settings).

**Q: I have two accounts. Which one should I use?**  
A: The one that has access to `lumisourcecode/Frontend_Lumi_New`. Usually the one in the org.

**Q: GIT_REPO_URL – whose PAT?**  
A: Use the same PAT you created. Format: `https://YOUR_USERNAME:YOUR_PAT@github.com/lumisourcecode/Frontend_Lumi_New.git`

**Q: Do I need org admin to add secrets?**  
A: You need **write** or **admin** on the repo to add secrets. If you can’t see Settings → Secrets, ask an org admin.

---

## Part 7: Verify your setup

```bash
# 1. Which remote?
git remote -v

# 2. Which branch?
git branch

# 3. Test push (after PAT and secrets are set)
git push origin dev
```

Then check **Actions** in the repo to see if the workflow runs.
