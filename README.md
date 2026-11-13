# UpdateMyNaukariProfile 🚀

Keep your **Naukri.com** profile fresh on autopilot — rotating **Resume Headlines** + dated **Resume uploads** for **multiple profiles**, with a password-protected dashboard and **free WhatsApp alerts**. No paid APIs. It talks to Naukri's own web endpoints (with optional browser-assisted login).

![Node](https://img.shields.io/badge/Node-18%2B-339933?logo=node.js&logoColor=white)
![Version](https://img.shields.io/badge/version-2.2.0-blue)
![Free](https://img.shields.io/badge/APIs-100%25%20Free-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/4sudosu/UpdateMyNaukariProfile)

> **Repository:** [github.com/4sudosu/UpdateMyNaukariProfile](https://github.com/4sudosu/UpdateMyNaukariProfile)  
> **Default & only branch:** `main` — this repo is maintained with a **single branch**.

---

## Table of contents

- [Features](#-features)
- [What's new & version history](#-whats-new--version-history)
- [How it works](#-how-it-works)
- [Project structure](#-project-structure)
- [Deploy to Render](#-deploy-to-render-1-click)
- [Run locally / on VPS](#-run-locally--on-vps)
- [Desktop launcher (Linux)](#-desktop-launcher-linux)
- [Environment variables](#-environment-variables)
- [Using the dashboard](#-using-the-dashboard)
- [Cloud backup (free, Upstash Redis)](#-cloud-backup-free-upstash-redis)
- [Security model](#-security-model)
- [Troubleshooting](#-troubleshooting)
- [Tech notes](#-tech-notes)
- [Branching & maintenance](#-branching--maintenance)
- [Disclaimer](#-disclaimer)
- [Connect with the developer](#-connect-with-the-developer)

---

## ✨ Features

| Feature | Details |
|---|---|
| 👥 **Multi-profile** | Add unlimited Naukri profiles from the dashboard — email+password or pasted session cookies |
| 🔁 **Headline rotation** | Cycles `Name_Titles.txt` sequentially, loops forever, never deletes a line |
| 📄 **Dated resume uploads** | Re-uploads as `Name_Resume_<DDMon>.pdf` every cycle (delete → upload, like the site) |
| ☑️ **Per-profile tasks** | Title only, Resume only, or both — editable anytime |
| 🔗 **Stay logged in** | Saved session + optional linked Chrome/farm tab kept warm; a restart can re-open/seed the tab from the saved session |
| ⏰ **Smart scheduling** | Every X hours counted from each profile's last update; downtime = single catch-up, never spam |
| 💬 **WhatsApp alerts** | Free via QR/pairing link (Baileys) — group or personal target per profile, custom message templates, session-expiry warnings |
| 🎨 **10 themes** | 5 light + 5 dark, applies instantly |
| 🔐 **Secure** | Panel login + 3-strike lockout, credentials sealed with AES-256-GCM, secrets never committed |

---

## 🆕 What's new & version history

### V2.2 — current build (`2.2.0`)

- 🔁 **Sessions no longer expire ("logged out again and again" fix)** — Naukri's `nauk_at` bearer (JWT) lives **exactly 60 minutes**. The app now **renews it automatically** by visiting a logged-in page (`https://www.naukri.com/mnjuser/profile`) with the saved cookies; Naukri re-issues a fresh `nauk_at` and rotates `nauk_rt`/`nauk_sid` (long-lived). Renewal runs before every update when the token is near/past expiry (**15-min skew**) and once more on a 401 probe retry — so updates reuse the saved session instead of falling back to password login (which can trigger captcha/MFA).
- 🍪 **Every cookie is kept** — the **full cookie set** (including Akamai/device cookies like `ak_bmsc`, `bm_sv`, `bm_mi`, `nauk_ps`, `nauk_cs`, `is_login`, `nauk_otl`, …) is preserved in the jar, persisted on disk, and captured from the browser. Dropping them makes Naukri treat the session as tampered.
- 🧹 **Cookie clearing is honoured** — cookies Naukri clears (`Max-Age=0`, expired, or empty value) are **removed** from the jar instead of re-sent (stale/blank values are a bot/tamper signal).
- 🎯 **Bearer always follows the rotated cookie** — the current `nauk_at` in the jar is the source of truth (`freshBearer` / `saveSession` reads from the jar). Rotated tokens are persisted so stale-bearer 401s are avoided.
- 🌐 **Old homepage "touch" removed** — replaced by a real logged-in page renewal (the homepage visit didn't extend the token and could disrupt Akamai cookies).
- 🔄 **5-minute keep-alive (merged with V2.1 tab-farm)** — every **5 minutes**, for each idle profile:
  1. **Linked Chrome/farm tab (if live):** visit Naukri in the tab, capture cookies, probe and re-save the session.
  2. **Saved HTTP session:** renew the 60-min token when near expiry (**20-min skew**) via a logged-in page visit, probe the dashboard with the fresh bearer, and re-save if anything rotated. If the session is live, the farm tab is re-opened/seeded from it so a restart/RDP disconnect doesn't force re-linking.

### V2.1
- 🖥️ Server browser login on Render — headless Chromium logs in with email+password; OTP entered in the dashboard.
- 🗂️ Persistent multi-tab browser — one isolated tab per profile, kept open side by side.
- ✅ **Test-login is check-only** — reports connected/not from the live tab or saved session only; never performs a fresh login (can't trigger MFA).
- 🔖 Running-build badge — dashboard shows deployed version (`GET /api/version`, source of truth: `package.json`).

### V2.0
- Headless server login on Render (`@sparticuz/chromium`), dashboard OTP flow.

### V1.0 (old build)
- API-based headline/resume updates, cookie-paste login, visible-window browser login.

### Full version history

| Version | Build | Notes |
|---|---|---|
| **V2.2** | current (`2.2.0`) | 60-min token auto-renewal, full cookie set kept, cookie-clearing honoured, bearer follows rotated `nauk_at`, 5-min keep-alive (Chrome tab + HTTP renewal) |
| **V2.1** | | Tab farm, check-only Test-login, version badge |
| **V2.0** | | Headless server login on Render, dashboard OTP |
| **V1.0** | old build | API updates, cookie-paste/visible browser login |

---

## ⚙️ How it works

1. **Login / session**
   - Profiles can be linked via **email + password** (with OTP/MFA handled in dashboard/browser flows) or by pasting **session cookies** (`nauk_at` required; `nauk_sid`, `nauk_rt` recommended).
   - A successful session is saved (cookies + bearer sealed with AES-256-GCM) and reused — no password login on every run.

2. **Session renewal (V2.2 core)**
   - Naukri's bearer (`nauk_at`) expires in ~60 minutes and JSON APIs don't extend it. The app visits `https://www.naukri.com/mnjuser/profile` with the saved cookies to get a freshly issued token + rotated refresh/session cookies, then probes the dashboard to confirm.
   - `saveSession` always persists the token from the current cookie jar, so rotations are never lost.

3. **Updates**
   - Per profile, on its schedule (and/or "Update now"): optionally rotates the next headline from `Name_Titles.txt` and/or uploads a dated resume `Name_Resume_<DDMon>.pdf` via Naukri's own web endpoints (same calls the site makes). Runs are serialized to avoid overlapping sessions.

4. **Keep-alive**
   - A background loop runs every **5 minutes** (first ping ~10s after boot): keeps linked Chrome/farm tabs warm when present, and renews/probes the saved HTTP session when the bearer is near expiry, re-saving any rotated cookies.

5. **Notifications & persistence**
   - WhatsApp alerts (optional) are sent via Baileys. On Render's ephemeral disk, enable **Upstash cloud backup** (or a persistent disk) to survive restarts/redeploys.

---

## 🗂️ Project structure

| Path | Purpose |
|---|---|
| `index.js` | Main server, scheduler, session handling/renewal, keep-alive, Naukri API calls, dashboard API |
| `dashboard.html` | Password-protected web dashboard UI |
| `profiles.js` | Profile registry, per-profile files (`profiles/<safe>_Titles.txt`, `profiles/<safe>_Resume.pdf`), normalization |
| `browserLogin.js` | Puppeteer-based browser login / persistent farm tabs & cookie capture |
| `whatsapp.js` | WhatsApp linking & alerts (Baileys) |
| `cloudBackup.js` | Optional Upstash Redis backup/restore |
| `settings.js`, `settings.json` | App settings (interval, theme, timezone, WhatsApp config) — `settings.json` is git-ignored |
| `setup.sh` | One-line installer script (Node 20, clone/update, npm install, `.env`) |
| `render.yaml` | Render blueprint for 1-click deploy |
| `StartNaukri.desktop` | Linux desktop launcher (starts server and opens dashboard) |
| `.env` / `.env.example` | Environment configuration (secrets stay in `.env`, git-ignored) |
| `profiles/` | Per-profile data & sealed credentials (**git-ignored**, never commit) |
| `wa-session/` | WhatsApp session data (**git-ignored**) |
| `browser-profile/` | Browser profile data (**git-ignored**) |
| `server.log` | Runtime log file (**git-ignored**) |
| `node_modules/` | Dependencies (**git-ignored**) |

---

## 🚀 Deploy to Render (1 click)

1. Click **Deploy to Render** above (uses the included `render.yaml` blueprint).
2. When asked, set your environment variables:
   - `WEB_PASSWORD` → your dashboard password (pick something strong) — **required**
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` → free Upstash Redis REST credentials (see [Cloud backup](#-cloud-backup-free-upstash-redis)) — **optional, recommended on free tier**
3. Open your service URL → log in → add your first profile. Check Render **Logs** on boot — a restored deploy prints `restored from cloud: profiles=true…`.

> ⚠️ **Render free-tier note:** the filesystem is ephemeral — added profiles, WhatsApp link and settings are wiped on redeploy/restart. Fix it with **cloud backup** (free), attach a paid **Render Disk** mounted at `/opt/render/project/src`, or run it at home/VPS with Node.

---

## 💻 Run locally / on VPS

### 1-line setup

```bash
WEB_PASSWORD=pick-something-strong bash <(curl -fsSL https://raw.githubusercontent.com/4sudosu/UpdateMyNaukariProfile/main/setup.sh)
```

This installs Node 20 if needed, clones/updates the repo, runs `npm install`, writes `.env` with your `WEB_PASSWORD`, and prints the start command. Then run:

```bash
cd UpdateMyNaukariProfile && npm start
```

### Manual setup

```bash
git clone https://github.com/4sudosu/UpdateMyNaukariProfile.git
cd UpdateMyNaukariProfile
npm install
```

Create a `.env` file:

```env
PORT=3000
WEB_PASSWORD=pick-something-strong
# optional — free Upstash Redis cloud backup:
# UPSTASH_REDIS_REST_URL=https://xxx.upstash.io
# UPSTASH_REDIS_REST_TOKEN=AXxx...
```

Start the server:

```bash
npm start
```

Open **http://localhost:3000** → log in with your panel password.

- **Node requirement:** 18+ (see `package.json` `engines`).
- **Version endpoint:** `GET /api/version` returns the running build (e.g. `{"ok":true,"version":"2.2.0"}`).

---

## 🖥️ Desktop launcher (Linux)

`StartNaukri.desktop` is included for convenience. It sets a display/X authority, starts the app, and opens the dashboard:

```ini
[Desktop Entry]
Type=Application
Name=Start Naukri
Comment=Start Naukri Rotator and open dashboard
Path=/home/ubuntu/Desktop/UpdateMyNaukariProfile
Exec=bash -c 'export DISPLAY=:10 XAUTHORITY=/home/ubuntu/.Xauthority; (sleep 3 && xdg-open http://localhost:3000 &) ; npm start'
Icon=utilities-terminal
Terminal=true
```

> Adjust `Path`, `DISPLAY`, and `XAUTHORITY` to match your machine/user. Mark it executable and (if your desktop requires) allow launching/trust the file.

---

## 🔑 Environment variables

| Variable | Required | What it does |
|---|---|---|
| `WEB_PASSWORD` | ✅ Yes | Password for the whole dashboard (login screen + every action). 3 wrong tries locks everything until restart. |
| `PORT` | No | Server port. Render injects its own — you never set this there. Defaults to `3000` locally. |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis REST endpoint. Enables free cloud backup. |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis REST token. Keep secret — never commit it. |

Everything else (update interval, themes, WhatsApp, profiles) lives in the **dashboard Settings** — so secrets stay out of env files.

---

## 📖 Using the dashboard

### ➕ Add a profile
1. **Profile Name** → becomes `Name_Titles.txt` + `Name_Resume.pdf` (separate files per profile, never mixed).
2. **Link via** — pick one:
   - **Email + password** → optional **Test creds** (live check; handles 2-step OTP/code entry where applicable).
   - **Session cookies** → paste `nauk_at` (**required**), `nauk_sid`, `nauk_rt` (**recommended**) — verified instantly.  
     Get them in Chrome/Edge: log in at naukri.com → **F12 → Application → Cookies → https://www.naukri.com** → copy values (HttpOnly cookies won't appear in `document.cookie` — copy from the Application tab).
3. Upload **resume `.pdf`** (verified) + **titles `.txt`** (one headline per line, or paste).
4. Tick **Update Title / Update Resume** tasks, set WhatsApp notifications (optional).

### 📊 Profiles section
Each card shows **Last update + next-update countdown**, rotation progress, and actions: **Update now**, **Edit files**, **Refresh login**, **Test login** (check-only), **Clear cookies**, **Delete**.

### 💬 WhatsApp (Settings → WhatsApp linking)
1. Turn it on, optionally name the account.
2. Link by **scanning the QR** on the dashboard, or **pair by phone number** (8-char code).
3. Per profile choose **Group** (by name) or **Personal** (number with country code), plus an optional **custom message** with `{name}` `{headline}` `{resume}` `{time}`.

Example custom message:
```
From {name}
I have updated Resume and Title on your Naukri Profile.
```

### 🎨 Settings
Update interval (0.5–720h, re-anchors countdowns instantly) + **10 themes** (Indigo Dream, Ocean Breeze, Emerald Field, Sunset Glow, Rose Petal, Midnight, Royal Plum, Forest Night, Abyss, Cocoa Ember).

---

## ☁️ Cloud backup (free, Upstash Redis)

Render's free disk wipes on redeploy/restart. Cloud backup fixes that:

1. Create a **free** Redis database at [upstash.com](https://upstash.com) (region near you).
2. Open the database → **REST API** tab → copy **Endpoint** and **Token**.
3. Set env vars (`UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`) and redeploy/restart.
4. Dashboard **Settings → Cloud backup** shows status / last push; **Backup now** and **Restore from cloud** are available.

**What gets backed up:** profiles registry, settings (interval/theme/timezone/WhatsApp name), every `Name_Titles.txt` + `Name_Resume.pdf`, and the WhatsApp link session (bundled).

**When:** after changes (debounced), every ~30 minutes while awake, on demand, and before unlinking WhatsApp (session part).

**Restore:** automatic on boot **only if** local disk is empty but cloud has data (never overwrites existing local data). Look for `restored from cloud: profiles=true settings=true wa=true files=N` in logs. Manual restore asks for confirmation and refuses when the cloud is empty.

**Verify:** Settings shows *On — last push: \<time\>*; Upstash **Data Browser** contains `nb:manifest`; logs print `backed up N profile(s)…`.

---

## 🔐 Security model

- Panel password gates **everything** (login + all APIs), 12h session tokens, **3 wrong tries = locked until restart**.
- Emails, passwords and cookies are sealed with **AES-256-GCM** (key derived from your panel password) — `profiles/profiles.json` never holds plaintext secrets.
- **Git-ignored / never committed:** `.env`, `profiles/`, `wa-session/`, `browser-profile/`, `browser-profile-headless/`, `settings.json`, `server.log`, `node_modules/`.
- Treat `UPSTASH_REDIS_REST_TOKEN` and `WEB_PASSWORD` as secrets; never commit them.

---

## 🧰 Troubleshooting

**Dashboard looks old / buttons missing after an update?**  
Your browser cached the previous page. Hard-refresh once: **CTRL+SHIFT+R** (Windows/Linux) or **CMD+SHIFT+R** (Mac). The server sends `no-store` headers, so fresh loads won't go stale.

**"No visible browser on this server"?**  
Expected on Render/cloud (no display/Chrome GUI). Link profiles with **email + password** or pasted **session cookies**; headless login is used where supported.

**Session/login keeps failing (captcha/MFA)?**  
V2.2 renews the saved session automatically (before updates, on 401 retry, and via 5-min keep-alive). If a session is truly dead/invalid, you'll need to re-link once (email+password+OTP or fresh cookies). Ensure the server can reach Naukri and that cookies aren't being cleared by redeploys without cloud backup.

**No data after redeploy on Render free tier?**  
Ephemeral disk was wiped — enable [cloud backup](#-cloud-backup-free-upstash-redis) or attach a persistent disk.

**WhatsApp not reconnecting?**  
If previously linked it reconnects silently on boot; otherwise link from the dashboard (QR/pairing). Session persists only if disk/cloud backup retains `wa-session/`.

**GitHub auth issues when pushing?**  
Use `gh auth login` (device/web flow) or a PAT with `repo` scope, then `gh auth setup-git`.

---

## 🛠️ Tech notes

- **Runtime:** Node.js 18+ (`"engines": { "node": ">=18" }`), CommonJS (`"type": "commonjs"`).
- **Core:** native `http`, `fetch`, `FormData`, `crypto` — zero-dependency core logic.
- **Dependencies:** `@whiskeysockets/baileys` + `qrcode-terminal` (WhatsApp), `puppeteer-core` (browser login/tabs), `@sparticuz/chromium` (headless Chromium on serverless/Render).
- **Naukri endpoints:** uses Naukri's own web APIs (login, dashboard, fullprofiles, advResume, filevalidation) — the same calls the site makes.
- **Current version:** `2.2.0` (see `package.json`, served at `/api/version`).

---

## 🌿 Branching & maintenance

- **Single branch policy:** this repository keeps **only `main`** as the active branch (local and remote). There are no other remote branches.
- **Default branch:** `main`.
- To verify: `git branch -a` and `git ls-remote --heads origin` should show only `main`.
- Recommended workflow: work on `main` (or a short-lived local branch) and keep `origin/main` as the sole published branch; delete any stale remote branches if they ever appear (`git push origin --delete <branch>`).

---

## ⚠️ Disclaimer

Personal automation for **your own** Naukri account. Not affiliated with or endorsed by Naukri / InfoEdge India Ltd. Use responsibly and in accordance with [Naukri's Terms](https://www.naukri.com/termsAndConditions).

---

## 🤝 Connect with the developer

[![Instagram](https://img.shields.io/badge/Instagram-4sudo.su-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/4sudo.su/)
[![Telegram](https://img.shields.io/badge/Telegram-verifiedharyanvi-229ED9?logo=telegram&logoColor=white)](https://t.me/verifiedharyanvi)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-sudhir19-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/sudhir19/)
[![GitHub](https://img.shields.io/badge/GitHub-4sudosu-181717?logo=github&logoColor=white)](https://github.com/4sudosu)
