# UpdateMyNaukariProfile 🚀

Keep your **Naukri.com** profile fresh on autopilot — rotating **Resume Headlines** + dated **Resume uploads** for **multiple profiles**, with a beautiful password-protected dashboard and **free WhatsApp alerts**. No paid APIs. No browser automation. Just Naukri's own web endpoints.

![Node](https://img.shields.io/badge/Node-18%2B-339933?logo=node.js&logoColor=white)
![Free](https://img.shields.io/badge/APIs-100%25%20Free-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/4sudosu/UpdateMyNaukariProfile)

---

## ✨ Features

| Feature | Details |
|---|---|
| 👥 **Multi-profile** | Add unlimited Naukri profiles from the dashboard — everything stored as session cookies (browser capture, server login, or paste) |
| 🔁 **Headline rotation** | Cycles `Name_Titles.txt` sequentially, loops forever, never deletes a line |
| 📄 **Dated resume uploads** | Re-uploads as `Name_Resume_20Sept.pdf` every cycle (delete → upload, like the site) |
| ☑️ **Per-profile tasks** | Title only, Resume only, or both — editable anytime |
| ⏰ **Smart scheduling** | Every X hours counted from each profile's last update; downtime = single catch-up, never spam |
| 💬 **WhatsApp alerts** | Free via QR/pairing link — group or personal target per profile, custom message templates, session-expiry warnings |
| 🎨 **10 themes** | 5 light + 5 dark, applies instantly |
| 🔐 **Secure** | Panel login + 3-strike lockout, credentials sealed with AES-256-GCM, secrets never committed |

---

## 🚀 Deploy to Render (1 click)

1. Click **Deploy to Render** above (uses the included `render.yaml` blueprint).
2. When asked, set **one** environment variable:
   - `WEB_PASSWORD` → your dashboard password (pick something strong)
3. Open your service URL → log in → add your first profile. Done!

> ⚠️ **Render free-tier note:** files live on ephemeral disk — added profiles, WhatsApp link and settings are wiped on redeploy/restart. For persistence, attach a **Render Disk** mounted at `/opt/render/project/src` (paid), or run it at home with Node.

---

## 💻 Run locally

```bash
git clone https://github.com/4sudosu/UpdateMyNaukariProfile.git
cd UpdateMyNaukariProfile
npm install
```

Create a `.env` file — **only 2 variables, nothing else:**

```env
PORT=3000
WEB_PASSWORD=pick-something-strong
```

```bash
npm start
```

Open **http://localhost:3000** → log in with your panel password.

### 🔑 Environment variables

| Variable | Required | What it does |
|---|---|---|
| `WEB_PASSWORD` | ✅ Yes | Password for the whole dashboard (login screen + every action). 3 wrong tries locks everything until restart. |
| `PORT` | No | Server port. Render injects its own — you never set this there. Defaults to `3000` locally. |

Everything else (update interval, themes, WhatsApp, profiles) lives in the **dashboard Settings** — on purpose, so secrets stay out of env files.

---

## 📖 Using the dashboard

### ➕ Add a profile
1. **Profile Name** → becomes `Name_Titles.txt` + `Name_Resume.pdf` (separate files per profile, never mixed).
2. **Link via** — pick one (default: email + password):
    - **Email + password** → optional **Test creds** button (checks the login live, handles 2-step OTP with code entry).
    - **Server login** → enter creds once in the browser card below (never stored); a headless browser logs in, handles MFA codes, and captures `nauk_at` (required), `nauk_sid`, `nauk_rt` into the three boxes automatically. Manual paste works too.
3. Upload **resume `.pdf`** (verified) + **titles `.txt`** (one headline per line, or paste).
4. Tick **Update Title / Update Resume** tasks, set WhatsApp notifications (optional).

### 📊 Profiles section
Each card shows live **Last update + Next-update countdown**, rotation progress, and lets you **Update now**, **Edit files**, **Refresh login**, **Test login**, **Clear cookies**, **Delete** — all collapsible.

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
Update interval (0.5–720h, re-anchors all countdowns instantly) + **10 themes** (Indigo Dream, Ocean Breeze, Emerald Field, Sunset Glow, Rose Petal, Midnight, Royal Plum, Forest Night, Abyss, Cocoa Ember).

---

## 🔐 Security model

- Panel password gates **everything** (login screen + all APIs), 12h session tokens, 3 wrong tries = locked till restart.
- Emails, passwords and cookies are sealed with **AES-256-GCM** (key from your panel password) — `profiles/profiles.json` never holds plaintext.
- These are **git-ignored and never pushed**: `.env`, `profiles/`, `wa-session/`, `browser-profile/`, `settings.json`, `node_modules/`.

---

## 🧰 Troubleshooting

**Dashboard looks old / buttons missing after an update?**
Your browser cached the previous page. Hard-refresh once:
- Windows/Linux: **CTRL + SHIFT + R**
- Mac: **CMD + SHIFT + R**

This matters most on Render after a redeploy — e.g. seeing only *Login via Browser* with *"No visible browser on this server"* means you're looking at the cached page; hard-refresh to reveal the **Server login** form. (The server now sends `no-store` headers, so fresh loads never go stale — only that one hard refresh is needed.)

**"No visible browser on this server"?**
Expected on Render/cloud (no screen, no Chrome). Use the **Server login** form right below that message: enter Naukri email + password once (never stored) — a headless browser logs in, captures the session, and supports OTP codes if Naukri asks.

---

## 🛠️ Tech notes

- Zero-dependency core (native `fetch`/`FormData`), Node 18+.
- Optional deps: `@whiskeysockets/baileys` + `qrcode-terminal` (WhatsApp), `puppeteer-core` (browser login, uses your system Chrome).
- Endpoints used are Naukri's own web APIs (login, dashboard, fullprofiles, advResume, filevalidation) — the same calls the site makes, including its pinned resume-upload component key.

---

## ⚠️ Disclaimer

Personal automation for **your own** Naukri account. Not affiliated with or endorsed by Naukri / InfoEdge India Ltd. Use responsibly and per [Naukri's Terms](https://www.naukri.com/termsAndConditions).

---

## 🤝 Connect with the developer

[![Instagram](https://img.shields.io/badge/Instagram-4sudo.su-E4405F?logo=instagram&logoColor=white)](https://www.instagram.com/4sudo.su/)
[![Telegram](https://img.shields.io/badge/Telegram-verifiedharyanvi-229ED9?logo=telegram&logoColor=white)](https://t.me/verifiedharyanvi)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-sudhir19-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/in/sudhir19/)
[![GitHub](https://img.shields.io/badge/GitHub-4sudosu-181717?logo=github&logoColor=white)](https://github.com/4sudosu)
