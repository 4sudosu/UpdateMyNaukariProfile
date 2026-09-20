/**
 * Naukri Multi-Profile Headline + Resume Rotator — 100% free, no paid APIs.
 *
 * - Add any number of Naukri profiles from the web dashboard:
 *   Profile Name, login email, password, resume PDF, titles (file or paste).
 * - Each profile keeps SEPARATE files (never mixed, never deleted):
 *     profiles/<Name>_Titles.txt   and   profiles/<Name>_Resume.pdf
 * - Titles cycle sequentially per profile, looping back to the 1st at the end.
 * - Each profile updates every INTERVAL_HOURS counted FROM its own last update.
 *   Server was off for days? Each profile runs ONCE on boot (no catch-up spam).
 * - Per-profile WhatsApp alerts (free via Baileys): group (by name) or
 *   personal (number with country code). Link via dashboard QR or phone number.
 * - Dashboard shows live status for ALL profiles: last update + next countdown.
 * - Dashboard actions are password-protected (WEB_PASSWORD);
 *   3 wrong tries locks everything until restart.
 *
 * .env holds ONLY: PORT + WEB_PASSWORD (panel password).
 * Everything else — update interval, WhatsApp on/off + account name — lives in
 * settings.json and is managed from the dashboard Settings section.
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const profiles = require("./profiles");
const wa = require("./whatsapp");
const bl = require("./browserLogin");

// Never die silently on a stray rejection — log and keep serving.
process.on("unhandledRejection", (e) => {
  try {
    console.log(new Date().toISOString(), "-", "UNHANDLED (kept alive):", (e && e.message) || e);
  } catch {}
});
process.on("uncaughtException", (e) => {
  try {
    console.log(new Date().toISOString(), "-", "UNCAUGHT (kept alive):", (e && e.message) || e);
  } catch {}
});

// ---------- minimal .env loader (no dependencies) ----------
function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

// ---------- config (.env holds ONLY panel password + port) ----------
const PORT = parseInt(process.env.PORT || "3000", 10);
const RUN_ONCE = (process.env.RUN_ONCE || "").toLowerCase() === "true";
const WEB_PASSWORD = process.env.WEB_PASSWORD || "";
const settingsStore = require("./settings");
const settings = settingsStore.loadSettings();
function intervalMs() {
  return settings.intervalHours * 60 * 60 * 1000;
}

// ---------- encryption for stored credentials ----------
// Uses PBKDF2 + AES-256-GCM with a key derived from the panel password.
// Only the server process can decrypt (no key stored on disk).
const ENCRYPT_ITER = 100000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const KEY_BYTES = 32;

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ENCRYPT_ITER, KEY_BYTES, "sha256");
}

function encryptSecret(plaintext, password) {
  if (!plaintext) return null;
  const salt = crypto.randomBytes(SALT_BYTES);
  const iv = crypto.randomBytes(IV_BYTES);
  const key = deriveKey(password, salt);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // store as: "enc1:" + base64(salt + iv + tag + ciphertext)
  return "enc1:" + Buffer.concat([salt, iv, tag, ct]).toString("base64");
}

function decryptSecret(encoded, password) {
  if (!encoded) return "";
  const s = String(encoded).startsWith("enc1:") ? String(encoded).slice(5) : String(encoded);
  const buf = Buffer.from(s, "base64");
  if (buf.length < SALT_BYTES + IV_BYTES + 16) return ""; // corrupted
  const salt = buf.subarray(0, SALT_BYTES);
  const iv = buf.subarray(SALT_BYTES, SALT_BYTES + IV_BYTES);
  const tag = buf.subarray(SALT_BYTES + IV_BYTES, SALT_BYTES + IV_BYTES + 16);
  const ct = buf.subarray(SALT_BYTES + IV_BYTES + 16);
  const key = deriveKey(password, salt);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ct, undefined, "utf8") + decipher.final("utf8");
}

function log(...args) {
  console.log(new Date().toISOString(), "-", ...args);
}

function secretEmail(p) {
  return p.auth && p.auth.method === "password" && p.auth.email
    ? safeDecrypt(p.auth.email)
    : "";
}
function secretPass(p) {
  return p.auth && p.auth.method === "password" && p.auth.password
    ? safeDecrypt(p.auth.password)
    : "";
}

// Never throws: "" when missing/unreadable (used for display paths).
function safeDecrypt(v) {
  try {
    return decryptSecret(v, WEB_PASSWORD);
  } catch {
    return "";
  }
}

function isSealedValue(v) {
  return !!v && String(v).startsWith("enc1:");
}

// Seal plaintext auth (password creds AND cookie values) for storage.
// Already-sealed values pass through untouched (never double-wrapped).
function sealAuth(auth) {
  if (!auth) return auth;
  if (auth.method === "cookies") {
    const c = auth.cookies || {};
    const seal = (v) => (v && !isSealedValue(v) ? encryptSecret(v, WEB_PASSWORD) : v || "");
    return { method: "cookies", email: "", password: "", cookies: { nauk_at: seal(c.nauk_at), nauk_sid: seal(c.nauk_sid), nauk_rt: seal(c.nauk_rt) } };
  }
  return {
    method: "password",
    email: auth.email && !isSealedValue(auth.email) ? encryptSecret(auth.email, WEB_PASSWORD) : auth.email || "",
    password: auth.password && !isSealedValue(auth.password) ? encryptSecret(auth.password, WEB_PASSWORD) : auth.password || "",
    cookies: { nauk_at: "", nauk_sid: "", nauk_rt: "" },
  };
}

// Open sealed cookies back to plaintext (empty stays empty).
function openCookies(auth) {
  const c = (auth && auth.cookies) || {};
  const out = {};
  for (const k of ["nauk_at", "nauk_sid", "nauk_rt"]) {
    out[k] = c[k] ? safeDecrypt(c[k]) : "";
  }
  return out;
}

// One-time self-healing: seal any legacy plaintext left by older versions.
function migrateSecrets() {
  let n = 0;
  for (const p of reg.profiles) {
    if (!p.auth) continue;
    const before = JSON.stringify(p.auth);
    p.auth = sealAuth(p.auth);
    if (JSON.stringify(p.auth) !== before) n++;
  }
  if (n > 0) {
    profiles.saveRegistry(reg);
    log(`Re-sealed stored secrets for ${n} profile(s)`);
  }
}

// Per-login cookie jar (never shared between profiles)
function createJar() {
  return new Map();
}
function storeCookies(jar, setCookieHeaders) {
  if (!setCookieHeaders) return;
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const header of arr) {
    const pair = header.split(";")[0];
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name) jar.set(name, value);
  }
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

// ---------- dated resume name: <Name>_Resume_20Sept.pdf ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sept", "Oct", "Nov", "Dec"];
function datedResumeName(prefix, date = new Date()) {
  const dd = String(date.getDate()).padStart(2, "0");
  const mmm = MONTHS[date.getMonth()];
  return `${prefix}_${dd}${mmm}.pdf`;
}

// ---------- Naukri API (free, reverse-engineered web endpoints) ----------
// ctx = { jar, email, password } — one ctx per profile run, never shared.
const LOGIN_URL = "https://www.naukri.com/central-login-services/v1/login";
const DASHBOARD_URL =
  "https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/dashboard";
const PROFILE_UPDATE_URL =
  "https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v1/users/self/fullprofiles";
const FILE_VALIDATION_URL = "https://filevalidation.naukri.com/file";
const RESUME_UPDATE_TEMPLATE =
  "https://www.naukri.com/cloudgateway-mynaukri/resman-aggregator-services/v0/users/self/profiles/{profile_id}/advResume";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

// ---------- Naukri 2-step OTP (best-effort, mirrors Naukri's own web flow) ----------
const OTP_SEND_URL = "https://www.naukri.com/central-login-services/v1/otp";
const OTP_VERIFY_URL = "https://www.naukri.com/central-login-services/v0/otp-login";

function otpHeaders() {
  return {
    accept: "application/json",
    appid: "100",
    "content-type": "application/json",
    referer: "https://www.naukri.com/nlogin/login?URL=//www.naukri.com/mnjuser/recommendedjobs",
    systemid: "jobseeker",
    "user-agent": UA,
    "x-requested-with": "XMLHttpRequest",
  };
}

async function naukriSendOtp(username, via, flowId) {
  const isMobile = via !== "email";
  const res = await fetch(OTP_SEND_URL, {
    method: "POST",
    headers: otpHeaders(),
    body: JSON.stringify({ username, flowId: flowId || "login", isLoginByEmail: !isMobile, isLoginByMobile: isMobile }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OTP send failed (${res.status}): ${text.slice(0, 200)}`);
  return true;
}

async function naukriVerifyOtp(username, otp, via, flowId) {
  const isMobile = via !== "email";
  const res = await fetch(OTP_VERIFY_URL, {
    method: "POST",
    headers: otpHeaders(),
    body: JSON.stringify({ username, token: String(otp).trim(), flowId: flowId || "login", isLoginByEmail: !isMobile, isLoginByMobile: isMobile }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new Error(`OTP verify failed (${res.status}): ${text.slice(0, 200)}`);
  const jar = createJar();
  storeCookies(jar, getSetCookies(res));
  const bearer = jar.get("nauk_at") || data.authToken || data.token || "";
  if (!bearer) throw new Error("Code accepted but Naukri returned no session — try logging in again");
  return fetchProfileId({ jar }, bearer);
}

// Login attempt that distinguishes: ok | 2-step OTP needed | plain error.
async function testCredsLogin(email, password) {
  const ctx = { jar: createJar(), email, password };
  let res;
  try {
    res = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        appid: "105",
        clientid: "d3skt0p",
        "content-type": "application/json",
        referer: "https://www.naukri.com/nlogin/login",
        systemid: "jobseeker",
        "x-requested-with": "XMLHttpRequest",
        "user-agent": UA,
      },
      body: JSON.stringify({ username: email, password }),
    });
  } catch (e) {
    throw new Error("Network error reaching Naukri: " + (e.message || e));
  }
  storeCookies(ctx.jar, getSetCookies(res));
  const text = await res.text();
  const token = ctx.jar.get("nauk_at");
  if (res.ok && token) {
    const pid = await fetchProfileId(ctx, token);
    return { status: "ok", profileId: pid };
  }
  // 2-step / MFA challenge? Pass the server's own flowId + medium back to the UI.
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {}
  if (/mfa|otp|verif|two[\s-]?step|two[\s-]?factor|challenge|authenticator|verify/i.test(text)) {
    return {
      status: "otp",
      mfa: /mfa/i.test(text),
      flowId: data.flowId || "",
      medium: data.medium || "",
      maskedEmail: data.email || "",
    };
  }
  throw new Error(`Login failed (${res.status}): ${text.slice(0, 300)}`);
}

async function naukriLogin(ctx) {
  const res = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      appid: "105",
      clientid: "d3skt0p",
      "content-type": "application/json",
      referer: "https://www.naukri.com/nlogin/login",
      systemid: "jobseeker",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": UA,
    },
    body: JSON.stringify({ username: ctx.email, password: ctx.password }),
  });
  storeCookies(ctx.jar, getSetCookies(res));
  const text = await res.text();
  if (!res.ok) throw new Error(`Login failed (${res.status}): ${text.slice(0, 300)}`);
  const token = ctx.jar.get("nauk_at");
  if (!token) {
    throw new Error(`Login got no nauk_at cookie — possible OTP block. Response: ${text.slice(0, 300)}`);
  }
  return token;
}

async function fetchProfileId(ctx, bearer) {
  const res = await fetch(DASHBOARD_URL, {
    headers: {
      accept: "application/json",
      appid: "105",
      clientid: "d3skt0p",
      authorization: `Bearer ${bearer}`,
      systemid: "Naukri",
      "x-requested-with": "XMLHttpRequest",
      Cookie: cookieHeader(ctx.jar),
    },
  });
  storeCookies(ctx.jar, getSetCookies(res));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Dashboard failed (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  const pid = data.profileId || (data.dashBoard && data.dashBoard.profileId);
  if (!pid) throw new Error("Could not find profileId in dashboard response");
  return pid;
}

async function updateHeadline(ctx, bearer, profileId, headline) {
  const res = await fetch(PROFILE_UPDATE_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.naukri.com",
      referer: "https://www.naukri.com/mnjuser/profile?id=&altresid",
      authorization: `Bearer ${bearer}`,
      appid: "105",
      clientid: "d3skt0p",
      systemid: "105",
      "x-http-method-override": "PUT",
      "x-requested-with": "XMLHttpRequest",
      Cookie: cookieHeader(ctx.jar),
    },
    body: JSON.stringify({ profile: { resumeHeadline: headline }, profileId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const hint = res.status === 401 ? " — session rejected the write; refresh login (Login via Browser)" : "";
    throw new Error(`Headline update failed (${res.status}): ${JSON.stringify(data).slice(0, 500)}${hint}`);
  }
  return data;
}

// ----- resume upload: pinned component key (NOT extracted from JS) -----
// The profile page bundles no longer contain the resume uploader config
// (only a chat uploader key lives there). This is the resume component's key
// + fileKey used by working integrations — filevalidation rejects anything
// else with "Component config not found". Attach replaces old resume in place.
const RESUME_FORM_KEY = "F51f8e7e54e205";
const RESUME_FILE_KEY = "UyFNbCXtBHdkXQ";

async function uploadResumeDated(ctx, bearer, profileId, fileBytes, datedName) {
  const formKey = RESUME_FORM_KEY;
  let fileKey = RESUME_FILE_KEY;

  const form = new FormData();
  form.append("file", new Blob([fileBytes], { type: "application/pdf" }), datedName);
  form.append("formKey", formKey);
  form.append("fileName", datedName);
  form.append("uploadCallback", "true");
  form.append("fileKey", fileKey);

  const valRes = await fetch(FILE_VALIDATION_URL, {
    method: "POST",
    headers: {
      accept: "application/json, text/javascript, */*; q=0.01",
      appid: "105",
      origin: "https://www.naukri.com",
      referer: "https://www.naukri.com/",
      systemid: "fileupload",
      Cookie: cookieHeader(ctx.jar),
    },
    body: form,
  });
  const valText = await valRes.text();
  if (!valRes.ok) throw new Error(`Resume file validation failed (${valRes.status}): ${valText.slice(0, 300)}`);
  try {
    const valJson = JSON.parse(valText);
    if (!(fileKey in valJson)) {
      const firstKey = Object.keys(valJson)[0];
      if (firstKey) fileKey = firstKey;
    }
  } catch {
    // non-JSON but OK — keep generated fileKey
  }

  const url = RESUME_UPDATE_TEMPLATE.replace("{profile_id}", profileId);
  const upRes = await fetch(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      origin: "https://www.naukri.com",
      referer: "https://www.naukri.com/mnjuser/profile",
      authorization: `Bearer ${bearer}`,
      appid: "105",
      clientid: "d3skt0p",
      systemid: "105",
      "x-http-method-override": "PUT",
      "x-requested-with": "XMLHttpRequest",
      Cookie: cookieHeader(ctx.jar),
    },
    body: JSON.stringify({ textCV: { formKey, fileKey, textCvContent: "" } }),
  });
  const upJson = await upRes.json().catch(() => ({}));
  if (!upRes.ok) {
    const hint = upRes.status === 401 ? " — session rejected the write; refresh login (Login via Browser)" : "";
    throw new Error(`Resume attach failed (${upRes.status}): ${JSON.stringify(upJson).slice(0, 500)}${hint}`);
  }
  return { skipped: false, filename: datedName };
}

// Login/session-looking failures (expired cookies, bad password, OTP blocks).
function isAuthError(err) {
  return /login failed|no nauk_at|otp|unauthor|401|403|forbidden|session|cookie|token/i.test(
    String((err && err.message) || err || "")
  );
}
async function verifyCookiesAuth(auth) {
  const jar = createJar();
  for (const [k, v] of Object.entries((auth && auth.cookies) || {})) {
    if (v) jar.set(k, v);
  }
  const bearer = auth && auth.cookies ? auth.cookies.nauk_at : "";
  if (!bearer) throw new Error("nauk_at cookie is missing");
  return fetchProfileId({ jar }, bearer);
}

// ---------- registry + runtime ----------
const reg = profiles.loadRegistry();
migrateSecrets();
// In-memory only: timers, next runs, running flags (rebuilt on boot).
const timers = {};
const nextRuns = {};
const running = {};

// Serialize all Naukri runs so sessions never overlap.
let runQueue = Promise.resolve();

// One full update cycle for a single profile. Returns true on success.
async function runProfile(p) {
  const label = `${p.name} (${p.auth.method === "password" ? profiles.maskEmail(safeDecrypt(p.auth.email)) || "password login" : "cookie login"})`;
  try {
    const titles = profiles.readProfileTitles(p);
    const rPath = profiles.resumePath(p);
    const resumeExists = fs.existsSync(rPath);
    if (titles.length === 0 && !resumeExists) {
      p.lastStatus = "no titles and no resume — nothing to do";
      profiles.saveRegistry(reg);
      return false;
    }
    const idx = titles.length ? p.titleIndex % titles.length : 0;
    const nextTitle = titles.length ? titles[idx] : null;
    const wantTitle = p.tasks.title && !!nextTitle;
    const wantResume = p.tasks.resume && resumeExists;
    if (!wantTitle && !wantResume) {
      p.lastStatus = "nothing enabled to do (check tasks / files)";
      profiles.saveRegistry(reg);
      log(`[${p.name}] SKIP:`, p.lastStatus);
      return false;
    }
    let headlineText = null;
    let resumeFile = null;
    const prefix = `${p.safe}_Resume`;
    if (nextTitle) log(`[${p.name}] Next headline #${idx + 1}/${titles.length}`);
    if (resumeExists) log(`[${p.name}] Resume will upload as: ${datedResumeName(prefix)}`);

    const ctx = { jar: createJar(), email: secretEmail(p), password: secretPass(p) };
    let bearer;
    if (p.auth.method === "cookies") {
      const ck = openCookies(p.auth);
      for (const [k, v] of Object.entries(ck)) {
        if (v) ctx.jar.set(k, v);
      }
      bearer = ck.nauk_at || "";
      if (!bearer) throw new Error("Saved cookies are missing nauk_at — refresh login on the card");
      log(`[${p.name}] using saved session cookies (email login skipped)`);
    } else {
      if (!ctx.email || !ctx.password) throw new Error("Missing login email/password — refresh login on the card");
      bearer = await naukriLogin(ctx);
      log(`[${p.name}] Login OK`);
    }
    const profileId = await fetchProfileId(ctx, bearer);

    let headlineErr = null;
    let resumeErr = null;
    if (wantTitle) {
      try {
        await updateHeadline(ctx, bearer, profileId, nextTitle);
        p.titleIndex = titles.length ? (idx + 1) % titles.length : 0;
        headlineText = nextTitle;
        p.lastHeadline = nextTitle;
        p.lastStatus = `headline #${idx + 1}/${titles.length} updated`;
        log(`[${p.name}] HEADLINE SUCCESS`);
      } catch (e) {
        headlineErr = e;
        p.lastStatus = `headline FAILED: ${e.message}`;
        log(`[${p.name}] HEADLINE ERROR:`, p.lastStatus);
      }
    } else if (!p.tasks.title) {
      p.lastStatus = "title updates off for this profile (resume only)";
      log(`[${p.name}] SKIP:`, p.lastStatus);
    } else {
      p.lastStatus = "no titles — headline skipped (resume only)";
      log(`[${p.name}] SKIP:`, p.lastStatus);
    }

    if (wantResume) {
      try {
        const bytes = fs.readFileSync(rPath);
        const datedName = datedResumeName(prefix);
        const r = await uploadResumeDated(ctx, bearer, profileId, bytes, datedName);
        p.lastResume = `uploaded as ${r.filename}`;
        resumeFile = r.filename;
        log(`[${p.name}] RESUME: ${p.lastResume}`);
      } catch (rErr) {
        resumeErr = rErr;
        p.lastResume = `FAILED: ${rErr.message}`;
        log(`[${p.name}] RESUME ERROR: ${p.lastResume}`);
      }
    } else {
      p.lastResume = p.tasks.resume ? "resume file missing — skipped" : "resume updates off for this profile";
      log(`[${p.name}] SKIP:`, p.lastResume);
    }

    const titleDone = !wantTitle || !!headlineText;
    const resumeDone = !wantResume || !!resumeFile;
    if (titleDone && resumeDone) {
      p.lastRun = new Date().toISOString();
      profiles.saveRegistry(reg);

      if (p.notify && p.notify.type !== "off") {
        try {
          const text = wa.buildUpdateMessage(p.name, headlineText, resumeFile, p.notify.customMsg);
          let wr;
          if (p.notify.type === "group") wr = await wa.sendGroupMessage(text, p.notify.group);
          else wr = await wa.sendPersonalMessage(text, p.notify.phone);
          if (wr.sent) log(`[${p.name}] WHATSAPP sent (${p.notify.type})`);
          else log(`[${p.name}] WHATSAPP skipped: ${wr.reason}`);
        } catch (wErr) {
          log(`[${p.name}] WHATSAPP ERROR (non-fatal): ${wErr.message}`);
        }
      }
      log(`[${label}] cycle done`);
      return true;
    }

    // Partial/total failure — no clock advance. Alert if the session looks dead.
    profiles.saveRegistry(reg);
    const taskAuthErr =
      headlineErr && isAuthError(headlineErr)
        ? headlineErr
        : resumeErr && isAuthError(resumeErr)
          ? resumeErr
          : null;
    if (taskAuthErr && p.notify && p.notify.type !== "off") {
      try {
        const text =
          `Hi Boss,\nNaukri session for ${p.name} expired or not working. Please refresh the login from the dashboard.\nError: ${String(taskAuthErr.message).slice(0, 200)}`;
        if (p.notify.type === "group") await wa.sendGroupMessage(text, p.notify.group);
        else await wa.sendPersonalMessage(text, p.notify.phone);
        log(`[${p.name}] WHATSAPP session alert sent`);
      } catch {
        // the alert itself must never break anything
      }
    }
    return false;
  } catch (err) {
    p.lastStatus = `FAILED: ${err.message}`;
    profiles.saveRegistry(reg);
    log(`[${p.name}] ERROR: ${p.lastStatus}`);
    // Session dead/expired? Alert on WhatsApp (if linked) so login gets refreshed.
    if (isAuthError(err) && p.notify && p.notify.type !== "off") {
      try {
        const text =
          `Hi Boss,\nNaukri session for ${p.name} expired or not working. Please refresh the login from the dashboard.\nError: ${String(err.message).slice(0, 200)}`;
        if (p.notify.type === "group") await wa.sendGroupMessage(text, p.notify.group);
        else await wa.sendPersonalMessage(text, p.notify.phone);
        log(`[${p.name}] WHATSAPP session alert sent`);
      } catch {
        // the alert itself must never break anything
      }
    }
    return false; // index NOT advanced — same title retried next cycle
  }
}

function enqueueProfileRun(id) {
  const task = runQueue.then(async () => {
    const p = profiles.getProfile(reg, id);
    if (!p) return false;
    running[id] = true;
    try {
      return await runProfile(p);
    } finally {
      running[id] = false;
    }
  });
  runQueue = task.then(
    () => {},
    () => {}
  );
  return task;
}

// ---------- per-profile scheduling ----------
// interval: every Xh from last update. daily: fixed HH:MM. window: random moment in [from, to].
// All times are server-local. A missed slot runs ONCE (no catch-up spam); daily/window run max once/day.
function parseHM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((s || "").trim());
  return m ? { h: +m[1], m: +m[2], mins: +m[1] * 60 + +m[2] } : null;
}
function sameDay(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}
function slotToday(hm, now) {
  const d = new Date(now);
  d.setHours(hm.h, hm.m, 0, 0);
  return d.getTime();
}
function nextDaily(timeStr, now) {
  const t = slotToday(parseHM(timeStr), now);
  return t <= now ? t + 86400000 : t;
}
function nextWindow(fromStr, toStr, lastRunMs, now) {
  const f = parseHM(fromStr);
  const t = parseHM(toStr);
  if (!f || !t) return now + intervalMs(); // corrupt data: safe fallback
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const w0 = day.getTime() + f.mins * 60000;
  const w1 = day.getTime() + t.mins * 60000;
  if (lastRunMs && sameDay(lastRunMs, now)) return w0 + 86400000 + Math.random() * (w1 - w0); // ran today -> tomorrow
  if (now < w1) {
    const lo = Math.max(now + 45000, w0);
    if (lo < w1) return lo + Math.random() * (w1 - lo); // later today
  }
  return now; // window missed -> once now
}
// Hours for interval mode: the profile's own value, else the global default.
function resolveHours(p) {
  const h = p.schedule && p.schedule.hours;
  if (Number.isFinite(h)) return Math.min(720, Math.max(0.5, h));
  return settings.intervalHours || 18;
}
// Absolute timestamp of the next run for a profile.
function planNext(p, now) {
  now = now || Date.now();
  const mode = (p.schedule && p.schedule.mode) || "interval";
  const last = p.lastRun ? Date.parse(p.lastRun) : NaN;
  if (mode === "daily") {
    const hm = parseHM(p.schedule.time);
    if (!hm) return now + intervalMs();
    if (Number.isFinite(last) && sameDay(last, now)) return nextDaily(p.schedule.time, now);
    const t = slotToday(hm, now);
    return t > now ? t : now;
  }
  if (mode === "window") {
    return nextWindow(p.schedule.from, p.schedule.to, Number.isFinite(last) ? last : 0, now);
  }
  if (!Number.isFinite(last)) return now;
  const due = last + resolveHours(p) * 3600000;
  return due <= now ? now : due;
}

const nextKinds = {}; // id -> 'retry' | 'slot' (why the countdown exists)

// Next strictly-future slot for daily/window (no catch-up-now).
function nextSlotFuture(p, now) {
  try {
    const mode = (p.schedule && p.schedule.mode) || "interval";
    if (mode === "daily" && parseHM(p.schedule.time)) return nextDaily(p.schedule.time, now);
    if (mode === "window") {
      const f = parseHM(p.schedule.from);
      const t = parseHM(p.schedule.to);
      if (f && t && f.mins < t.mins) {
        const day = new Date(now);
        day.setHours(0, 0, 0, 0);
        const w0 = day.getTime() + 86400000 + f.mins * 60000;
        const w1 = day.getTime() + 86400000 + t.mins * 60000;
        return w0 + Math.random() * (w1 - w0);
      }
    }
  } catch {}
  return now + intervalMs();
}

function isQuotaErrorText(t) {
  return /quota|rate.?limit|too many|429/i.test(t || "");
}

// Run once via the queue, then re-plan (success) or back off (failure).
// Quota/rate-limit failures wait for the next slot — retrying hourly would
// burn the login budget forever.
function cycleProfile(id) {
  return enqueueProfileRun(id).then((ok) => {
    const p = profiles.getProfile(reg, id);
    if (!p) return ok;
    if (ok) {
      const t = planNext(p);
      scheduleProfile(p, Math.max(1000, t - Date.now()), "slot");
    } else if (isQuotaErrorText(p.lastStatus) && ((p.schedule && p.schedule.mode) || "interval") !== "interval") {
      const t = nextSlotFuture(p, Date.now());
      scheduleProfile(p, Math.max(60000, t - Date.now()), "slot");
    } else if (isQuotaErrorText(p.lastStatus)) {
      scheduleProfile(p, 12 * 60 * 60 * 1000, "retry");
    } else {
      scheduleProfile(p, 60 * 60 * 1000, "retry");
    }
    return ok;
  });
}

function scheduleProfile(p, delayMs, kind) {
  if (timers[p.id]) clearTimeout(timers[p.id]);
  nextRuns[p.id] = new Date(Date.now() + delayMs).toISOString();
  nextKinds[p.id] = kind || "slot";
  timers[p.id] = setTimeout(() => cycleProfile(p.id), delayMs);
  log(`[${p.name}] next update in ${(delayMs / 3600000).toFixed(2)}h${nextKinds[p.id] === "retry" ? " (retry)" : ""}`);
}

function unscheduleProfile(id) {
  if (timers[id]) {
    clearTimeout(timers[id]);
    delete timers[id];
  }
  delete nextRuns[id];
  delete nextKinds[id];
  delete running[id];
}

function anchorProfile(p) {
  const t = planNext(p);
  if (t <= Date.now()) {
    log(`[${p.name}] due — updating ONCE now`);
    cycleProfile(p.id);
  } else {
    log(`[${p.name}] next update at ${new Date(t).toLocaleString()}`);
    scheduleProfile(p, t - Date.now());
  }
}

function bootProfile(p) {
  anchorProfile(p);
}

// Re-anchor every idle profile (used after the interval setting changes).
// Running profiles are skipped — their completion handler reschedules them.
function rescheduleAll() {
  for (const p of reg.profiles) {
    if (!running[p.id]) anchorProfile(p);
  }
}

function manualRunProfile(id) {
  unscheduleProfile(id);
  return cycleProfile(id);
}

// ---------- password-protected dashboard + lockout ----------
// 3 wrong passwords => locked for EVERYONE until the server restarts.
const MAX_WRONG = 3;
let wrongAttempts = 0;
let panelLocked = false;

function readJsonBody(req, maxBytes = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("Body too large (10MB max)"));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

// ---------- dashboard login sessions ----------
// Log in once on the dashboard (POST /api/login) and the token rides along
// with every request. Without a valid token the dashboard shows nothing but
// the login screen — no profiles, no status, no actions.
const sessions = new Map(); // token -> expiresAt
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function sweepSessions() {
  const now = Date.now();
  for (const [t, exp] of sessions) {
    if (exp <= now) sessions.delete(t);
  }
}

function getToken(req, body) {
  const h = req.headers["x-panel-token"] || "";
  if (h) return String(h);
  const auth = req.headers["authorization"] || "";
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  if (body && body.token) return String(body.token);
  return "";
}

function validToken(req, body) {
  const t = getToken(req, body);
  if (!t || !sessions.has(t)) return false;
  if (sessions.get(t) <= Date.now()) {
    sessions.delete(t);
    return false;
  }
  return true;
}

// True with a live session OR the correct panel password
// (password fallback keeps direct API/curl usage working).
function isAuthed(req, body) {
  if (validToken(req, body)) return true;
  const pw = body ? body.password || "" : "";
  return !!WEB_PASSWORD && !!pw && pw === WEB_PASSWORD;
}

// Returns null when authorized, otherwise { status, body } to send.
// Only real password attempts count toward the 3-strike lockout —
// stale/missing tokens just get a plain 401, never a lockout.
function panelAuth(req, body) {
  if (panelLocked) {
    return { status: 423, body: { ok: false, error: "Panel locked after 3 wrong passwords. Restart the server to unlock." } };
  }
  if (!WEB_PASSWORD) {
    return { status: 500, body: { ok: false, error: "WEB_PASSWORD is not set on the server — set it in .env and restart." } };
  }
  if (isAuthed(req, body)) {
    wrongAttempts = 0;
    return null;
  }
  if (body.password) {
    wrongAttempts++;
    if (wrongAttempts >= MAX_WRONG) {
      panelLocked = true;
      log(`Panel LOCKED after ${wrongAttempts} wrong passwords`);
      return { status: 423, body: { ok: false, error: "3 wrong passwords - panel locked for everyone until server restarts." } };
    }
    return { status: 401, body: { ok: false, error: "Wrong password.", attemptsLeft: MAX_WRONG - wrongAttempts } };
  }
  return { status: 401, body: { ok: false, error: "Login required." } };
}

// Human schedule label for the dashboard.
function scheduleText(p) {
  const s = p.schedule || { mode: "interval" };
  if (s.mode === "daily") return `Daily ${s.time}`;
  if (s.mode === "window") return `${s.from}–${s.to} daily`;
  return `Every ${resolveHours(p)}h`;
}

// Public profile view for the dashboard (passwords never leave the server).
function publicProfile(p) {
  const titles = profiles.readProfileTitles(p);
  return {
    id: p.id,
    name: p.name,
    email: p.auth.method === "password" ? profiles.maskEmail(safeDecrypt(p.auth.email)) : "cookie login",
    authMethod: p.auth.method,
    cookiesSet: p.auth.method === "cookies" ? Object.keys(p.auth.cookies || {}).filter((k) => p.auth.cookies[k]) : [],
    titlesTotal: titles.length,
    resumePresent: fs.existsSync(profiles.resumePath(p)),
    tasks: p.tasks,
    schedule: p.schedule,
    scheduleText: scheduleText(p),
    titleIndex: titles.length ? p.titleIndex % titles.length : 0,
    lastRun: p.lastRun,
    nextRun: nextRuns[p.id] || null,
    nextKind: nextKinds[p.id] || null,
    running: !!running[p.id],
    lastStatus: p.lastStatus,
    lastResume: p.lastResume,
    lastHeadline: p.lastHeadline,
    notify: {
      type: p.notify.type,
      group: p.notify.group,
      phone: profiles.maskPhone(p.notify.phone),
      customMsg: p.notify.customMsg || "",
    },
  };
}

const DASHBOARD_FILE = path.join(__dirname, "dashboard.html");

// ---------- HTTP server (also keeps Render free Web Service alive) ----------
const server = http.createServer(async (req, res) => {
  const url = (req.url || "/").split("?")[0];
  const parts = url.split("/").filter(Boolean);

  if (url === "/health") {
    const runningCount = Object.values(running).filter(Boolean).length;
    sendJson(res, 200, { ok: true, profiles: reg.profiles.length, running: runningCount, wa: wa.getStatus() });
    return;
  }

  if (url === "/api/status" && req.method === "GET") {
    if (!isAuthed(req, null)) {
      sendJson(res, 401, { ok: false, error: "Login required." });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      now: new Date().toISOString(),
      intervalHours: settings.intervalHours,
      settings: { intervalHours: settings.intervalHours, theme: settings.theme, whatsapp: settings.whatsapp },
      locked: panelLocked,
      wa: wa.getStatus(),
      profiles: reg.profiles.map(publicProfile),
    });
    return;
  }

  // POST /api/login — dashboard login, returns a 12h session token
  if (url === "/api/login" && req.method === "POST") {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 413, { ok: false, error: e.message });
      return;
    }
    sweepSessions();
    if (panelLocked) {
      sendJson(res, 423, { ok: false, error: "Panel locked after 3 wrong passwords. Restart the server to unlock." });
      return;
    }
    if (!WEB_PASSWORD) {
      sendJson(res, 500, { ok: false, error: "WEB_PASSWORD is not set on the server — set it in .env and restart." });
      return;
    }
    if ((body.password || "") !== WEB_PASSWORD) {
      wrongAttempts++;
      if (wrongAttempts >= MAX_WRONG) {
        panelLocked = true;
        log(`Panel LOCKED after ${wrongAttempts} wrong passwords`);
        sendJson(res, 423, { ok: false, error: "3 wrong passwords - panel locked for everyone until server restarts." });
      } else {
        sendJson(res, 401, { ok: false, error: "Wrong password.", attemptsLeft: MAX_WRONG - wrongAttempts });
      }
      return;
    }
    wrongAttempts = 0;
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    log("Dashboard login success (token issued)");
    sendJson(res, 200, { ok: true, token });
    return;
  }

  // ---- mutating API: all password-protected ----
  if (parts[0] === "api" && req.method !== "GET") {
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 413, { ok: false, error: e.message });
      return;
    }
    const denied = panelAuth(req, body);
    if (denied) {
      sendJson(res, denied.status, denied.body);
      return;
    }

    // POST /api/profiles — add a profile (+ its two files)
    if (url === "/api/profiles" && req.method === "POST") {
      try {
        let resumeBuffer = null;
        if (body.resumeBase64) {
          resumeBuffer = Buffer.from(body.resumeBase64, "base64");
        }
        let titlesText = body.titlesText || "";
        if (body.titlesBase64) {
          titlesText = Buffer.from(body.titlesBase64, "base64").toString("utf8");
        }
        // NOTE: profiles.js works in plaintext; seal AFTER validation + cookie verify.
        let auth = body.auth || { method: "password", email: body.email, password: body.loginPassword };
        const p = profiles.addProfile(reg, {
          name: body.name,
          auth,
          titlesText,
          titlesOrigName: body.titlesName,
          resumeBuffer,
          resumeOrigName: body.resumeName,
          notify: body.notify,
          tasks: body.tasks,
          schedule: body.schedule,
        });
        if (p.auth.method === "cookies") {
          try {
            const pid = await verifyCookiesAuth(p.auth);
            log(`[${p.name}] cookies verified live (Naukri profile ${pid})`);
          } catch (e) {
            try {
              profiles.deleteProfile(reg, p.id);
            } catch {}
            sendJson(res, 400, { ok: false, error: "Cookies invalid or expired — re-copy fresh cookies (see steps): " + e.message });
            return;
          }
        }
        log(`[${p.name}] profile added (${profiles.readProfileTitles(p).length} titles)`);
        p.auth = sealAuth(p.auth);
        profiles.saveRegistry(reg);
        bootProfile(p); // first run starts now
        sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // DELETE /api/profiles/:id
    if (parts[1] === "profiles" && parts[2] && req.method === "DELETE" && parts.length === 3) {
      try {
        unscheduleProfile(parts[2]);
        const gone = profiles.deleteProfile(reg, parts[2]);
        log(`[${gone.name}] profile deleted`);
        sendJson(res, 200, { ok: true, deleted: gone.name });
      } catch (e) {
        sendJson(res, 404, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/profiles/:id/run — update now (18h clock restarts from it)
    if (parts[1] === "profiles" && parts[2] && parts[3] === "run" && req.method === "POST") {
      const p = profiles.getProfile(reg, parts[2]);
      if (!p) {
        sendJson(res, 404, { ok: false, error: "Profile not found" });
        return;
      }
      sendJson(res, 202, { ok: true, started: true });
      manualRunProfile(p.id);
      return;
    }

    // PUT /api/profiles/:id/auth — change login method / refresh cookies+password
    if (parts[1] === "profiles" && parts[2] && parts[3] === "auth" && req.method === "PUT") {
      try {
        const auth = profiles.buildAuth(body.auth);
        if (auth.method === "cookies") {
          try {
            await verifyCookiesAuth(auth);
          } catch (e) {
            sendJson(res, 400, { ok: false, error: "Cookies invalid or expired — re-copy fresh cookies (see steps): " + e.message });
            return;
          }
        }
        const p = profiles.setAuth(reg, parts[2], sealAuth(auth));
        log(`[${p.name}] login updated (${p.auth.method})`);
        sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // PUT /api/profiles/:id/files — replace saved Titles.txt and/or Resume.pdf
    if (parts[1] === "profiles" && parts[2] && parts[3] === "files" && req.method === "PUT") {
      try {
        let titlesText = body.titlesText;
        if (body.titlesBase64) titlesText = Buffer.from(body.titlesBase64, "base64").toString("utf8");
        let resumeBuffer = null;
        if (body.resumeBase64) resumeBuffer = Buffer.from(body.resumeBase64, "base64");
        const p = profiles.updateFiles(reg, parts[2], {
          titlesText,
          titlesOrigName: body.titlesName,
          resumeBuffer,
          resumeOrigName: body.resumeName,
        });
        log(`[${p.name}] files updated`);
        sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // PUT /api/profiles/:id/notify — group/personal/off + target
    if (parts[1] === "profiles" && parts[2] && parts[3] === "notify" && req.method === "PUT") {
      try {
        const p = profiles.updateNotify(reg, parts[2], body.notify);
        log(`[${p.name}] notify -> ${p.notify.type}`);
        sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/whatsapp/pair — link by number, get pairing code
    // PUT /api/profiles/:id/tasks — choose Title and/or Resume updates
    if (parts[1] === "profiles" && parts[2] && parts[3] === "tasks" && req.method === "PUT") {
      try {
        const p = profiles.updateTasks(reg, parts[2], body.tasks);
        log(`[${p.name}] tasks -> ${p.tasks.title ? "title" : ""}${p.tasks.title && p.tasks.resume ? "+" : ""}${p.tasks.resume ? "resume" : ""}`);
        sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/profiles/:id/clear-cookies — wipe saved session cookies
    if (parts[1] === "profiles" && parts[2] && parts[3] === "clear-cookies" && req.method === "POST") {
      try {
        const p = profiles.clearCookies(reg, parts[2]);
        log(`[${p.name}] saved cookies cleared`);
        sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/profiles/:id/test-login — live Naukri credential check, changes nothing
    if (parts[1] === "profiles" && parts[2] && parts[3] === "test-login" && req.method === "POST") {
      const p = profiles.getProfile(reg, parts[2]);
      if (!p) {
        sendJson(res, 404, { ok: false, error: "Profile not found" });
        return;
      }
      try {
        if (p.auth.method === "cookies") {
          const pid = await verifyCookiesAuth({ method: "cookies", cookies: openCookies(p.auth) });
          sendJson(res, 200, { ok: true, method: "cookies", profileId: pid });
        } else {
          const email = decryptSecret(p.auth.email, WEB_PASSWORD);
          const password = decryptSecret(p.auth.password, WEB_PASSWORD);
          if (!email || !password) throw new Error("No email/password saved");
          const ctx = { jar: createJar(), email, password };
          const bearer = await naukriLogin(ctx);
          const pid = await fetchProfileId(ctx, bearer);
          sendJson(res, 200, { ok: true, method: "password", profileId: pid });
        }
        log(`[${p.name}] test login OK`);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "Login test failed: " + e.message });
      }
      return;
    }

    // POST /api/test-creds — test email+password without saving (for add-profile form)
    // Result is explicit: able to login | 2-step code needed | exact error.
    if (url === "/api/test-creds" && req.method === "POST") {
      const { email, password } = body;
      if (!email || !password) {
        sendJson(res, 400, { ok: false, error: "Email and password required" });
        return;
      }
      try {
        const r = await testCredsLogin(email, password);
        if (r.status === "otp") {
          const where = r.maskedEmail ? ` (code goes to ${r.medium || "your"} ${r.maskedEmail})` : "";
          sendJson(res, 200, {
            ok: false,
            needOtp: true,
            mfa: !!r.mfa,
            flowId: r.flowId || "",
            medium: r.medium || "",
            message: r.mfa
              ? `This account needs 2-step verification${where} — enter the code below (or press Send code to resend).`
              : "This account needs 2-step verification — Naukri wants a code. Pick where to receive it, press Send code, then enter the code.",
          });
        } else {
          sendJson(res, 200, { ok: true, profileId: r.profileId, message: "Able to login" });
        }
      } catch (e) {
        sendJson(res, 400, { ok: false, error: "Login test failed: " + e.message });
      }
      return;
    }

    // POST /api/test-creds/send-otp — send the 2-step code (mobile or email)
    if (url === "/api/test-creds/send-otp" && req.method === "POST") {
      if (!body.email) {
        sendJson(res, 400, { ok: false, error: "Email required" });
        return;
      }
      try {
        await naukriSendOtp(body.email, body.via === "email" ? "email" : "mobile", body.flowId);
        sendJson(res, 200, { ok: true, sentTo: body.via === "email" ? "email" : "mobile" });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/test-creds/verify-otp — check the 2-step code
    if (url === "/api/test-creds/verify-otp" && req.method === "POST") {
      if (!body.email || !body.otp) {
        sendJson(res, 400, { ok: false, error: "Email and code required" });
        return;
      }
      try {
        const pid = await naukriVerifyOtp(body.email, body.otp, body.via === "email" ? "email" : "mobile", body.flowId);
        sendJson(res, 200, { ok: true, profileId: pid, message: "Able to login" });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/clear-all-sessions — wipe saved cookies ONLY (never touches WhatsApp link)
    if (url === "/api/clear-all-sessions" && req.method === "POST") {
      try {
        const browserDir = path.join(__dirname, "browser-profile");
        let cleared = [];
        if (fs.existsSync(browserDir)) {
          fs.rmSync(browserDir, { recursive: true, force: true });
          cleared.push("browser-profile/");
        }
        // Also clear any profile's saved cookies
        for (const p of reg.profiles) {
          if (p.auth.method === "cookies") {
            p.auth.cookies = { nauk_at: "", nauk_sid: "", nauk_rt: "" };
          }
        }
        profiles.saveRegistry(reg);
        sendJson(res, 200, { ok: true, cleared });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // PUT /api/profiles/:id/schedule — interval | daily time | random window
    if (parts[1] === "profiles" && parts[2] && parts[3] === "schedule" && req.method === "PUT") {
      try {
        const p = profiles.updateSchedule(reg, parts[2], body.schedule);
        log(`[${p.name}] schedule -> ${scheduleText(p)}`);
        if (!running[p.id]) anchorProfile(p);
        sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/profiles/:id/clear-logs — wipe displayed status lines (schedule untouched)
    if (parts[1] === "profiles" && parts[2] && parts[3] === "clear-logs" && req.method === "POST") {
      const p = profiles.getProfile(reg, parts[2]);
      if (!p) {
        sendJson(res, 404, { ok: false, error: "Profile not found" });
        return;
      }
      p.lastStatus = "—";
      p.lastResume = "—";
      p.lastHeadline = "";
      profiles.saveRegistry(reg);
      log(`[${p.name}] logs cleared`);
      sendJson(res, 200, { ok: true, profile: publicProfile(p) });
      return;
    }

    if (url === "/api/whatsapp/pair" && req.method === "POST") {
      try {
        const r = await wa.requestPairingCode(body.phone);
        sendJson(res, 200, { ok: true, code: r.code, phone: r.phone });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // PUT /api/settings — update interval + theme (dashboard Settings)
    if (url === "/api/settings" && req.method === "PUT") {
      const out = {};
      if (body.intervalHours !== undefined) {
        const raw = parseFloat(body.intervalHours);
        if (!Number.isFinite(raw) || raw < 0.5 || raw > 720) {
          sendJson(res, 400, { ok: false, error: "Interval must be a number between 0.5 and 720 hours" });
          return;
        }
        settings.intervalHours = raw;
        out.intervalHours = raw;
        log(`Interval changed to every ${raw}h — re-anchoring all profiles`);
        rescheduleAll();
      }
      if (body.theme !== undefined) {
        if (!settingsStore.THEME_IDS.includes(body.theme)) {
          sendJson(res, 400, { ok: false, error: "Unknown theme" });
          return;
        }
        settings.theme = body.theme;
        out.theme = body.theme;
      }
      settingsStore.saveSettings(settings);
      sendJson(res, 200, { ok: true, ...out });
      return;
    }

    // PUT /api/settings/whatsapp — on/off + account name
    if (url === "/api/settings/whatsapp" && req.method === "PUT") {
      if (typeof body.enabled === "boolean") settings.whatsapp.enabled = body.enabled;
      if (typeof body.accountName === "string") {
        settings.whatsapp.accountName = body.accountName.trim().slice(0, 40);
      }
      settingsStore.saveSettings(settings);
      wa.configure({ enabled: settings.whatsapp.enabled });
      if (settings.whatsapp.enabled) wa.startWhatsApp().catch((e) => log("WHATSAPP init:", e.message));
      log(`WhatsApp settings: ${settings.whatsapp.enabled ? "ON" : "OFF"}${settings.whatsapp.accountName ? ` (${settings.whatsapp.accountName})` : ""}`);
      sendJson(res, 200, { ok: true, whatsapp: settings.whatsapp, wa: wa.getStatus() });
      return;
    }

    // POST /api/browser/start — visible window (local) or headless form login (servers).
    // Send {email,password} for headless; omit them for the manual window flow.
    if (url === "/api/browser/start" && req.method === "POST") {
      try {
        if (body.email && body.password) {
          const r = await bl.startHeadlessLogin(body.profileId, body.profileName, body.email, body.password);
          sendJson(res, 200, { ok: true, started: true, mode: r.mode, hint: "Headless login running on the server — watch the status below" });
        } else {
          await bl.startBrowserLogin(body.profileId, body.profileName);
          sendJson(res, 200, { ok: true, started: true, mode: "window", hint: "Log in to Naukri inside the opened Chrome window — the session is captured automatically" });
        }
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/browser/otp — submit the Naukri verification code (headless flow)
    if (url === "/api/browser/otp" && req.method === "POST") {
      try {
        const r = await bl.submitOtp(body.code);
        sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        sendJson(res, 400, { ok: false, error: e.message });
      }
      return;
    }

    // POST /api/browser/cancel — close the login window
    if (url === "/api/browser/cancel" && req.method === "POST") {
      await bl.cancelBrowserLogin();
      sendJson(res, 200, { ok: true, cancelled: true });
      return;
    }

    // POST /api/whatsapp/unlink — logout + wipe session (relink via QR/code)
    if (url === "/api/whatsapp/unlink" && req.method === "POST") {
      try {
        await wa.unlinkWhatsApp();
        sendJson(res, 200, { ok: true, unlinked: true });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: e.message });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "Unknown endpoint" });
    return;
  }

  if (url === "/api/browser/status" && req.method === "GET") {
    if (!isAuthed(req, null)) {
      sendJson(res, 401, { ok: false, error: "Login required." });
      return;
    }
    sendJson(res, 200, { ok: true, browser: bl.getBrowserStatus() });
    return;
  }

  if (url === "/api/browser/cookies" && req.method === "GET") {
    if (!isAuthed(req, null)) {
      sendJson(res, 401, { ok: false, error: "Login required." });
      return;
    }
    try {
      sendJson(res, 200, { ok: true, cookies: bl.takeBrowserCookies() });
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
    }
    return;
  }

  if (url === "/" || url === "/index.html") {
    try {
      const html = fs.readFileSync(DASHBOARD_FILE, "utf8");
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    } catch {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("dashboard.html missing");
    }
    return;
  }

  res.writeHead(404, { "content-type": "text/plain" });
  res.end("Not found");
});

// ---------- boot ----------
server.listen(PORT, () => {
  log(`Server listening on port ${PORT}`);
  if (WEB_PASSWORD) log("Dashboard at / requires panel login (12h session token)");
  else log("WARNING: WEB_PASSWORD is empty — NOBODY can log in until you set it in .env and restart");
  log(`Default rhythm Every ${settings.intervalHours}h — each profile sets its own schedule on its card`);
  wa.configure({ enabled: settings.whatsapp.enabled });
  // Optional: never auto-links on startup. Only a PREVIOUS link reconnects
  // silently (no QR needed). Fresh linking happens from the dashboard.
  if (wa.getStatus().enabled && wa.hasSession()) {
    log("WhatsApp was linked before — reconnecting silently in background");
    wa.startWhatsApp().catch((e) => log("WHATSAPP init:", e.message));
  } else if (wa.getStatus().enabled) {
    log("WhatsApp enabled but not linked yet — link it from the dashboard (optional)");
  } else {
    log("WhatsApp linking OFF (turn it on in dashboard Settings)");
  }
  if (RUN_ONCE) {
    log("RUN_ONCE=true — running all profiles once, then exiting");
    (async () => {
      for (const p of reg.profiles) {
        await enqueueProfileRun(p.id);
      }
      process.exit(0);
    })();
    return;
  }
  if (reg.profiles.length === 0) {
    log("No profiles yet — open the dashboard at / and add your first Naukri profile");
    return;
  }
  for (const p of reg.profiles) bootProfile(p);
});
