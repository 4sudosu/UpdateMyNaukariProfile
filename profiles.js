/**
 * Multi-profile registry.
 *
 * Each Naukri profile gets its OWN files (never mixed):
 *   profiles/<SafeName>_Titles.txt   - one headline per line
 *   profiles/<SafeName>_Resume.pdf    - base resume uploaded each cycle
 *   profiles/profiles.json            - credentials, notify settings, progress
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PROFILES_DIR = path.join(__dirname, "profiles");
const REGISTRY_FILE = path.join(PROFILES_DIR, "profiles.json");

function ensureDir() {
  if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

// Filename-safe candidate name: letters, digits, dash, underscore only.
function safeName(name) {
  return (name || "").trim().replace(/[^a-zA-Z0-9-_]/g, "");
}

function titlesPath(profile) {
  return path.join(PROFILES_DIR, `${profile.safe}_Titles.txt`);
}
function resumePath(profile) {
  return path.join(PROFILES_DIR, `${profile.safe}_Resume.pdf`);
}

function blankRegistry() {
  return { profiles: [] };
}

function loadRegistry() {
  ensureDir();
  try {
    const raw = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
    const list = Array.isArray(raw.profiles) ? raw.profiles : [];
    return {
      profiles: list
        .filter((p) => p && p.id && p.name)
        .map((p) => ({
          id: String(p.id),
          name: String(p.name),
          safe: safeName(p.safe || p.name) || "Profile",
          auth: p.auth
            ? normalizeAuth(p.auth)
            : normalizeAuth({ method: "password", email: p.email, password: p.password }),
          notify: normalizeNotify(p.notify),
          tasks: normalizeTasks(p.tasks),
          schedule: normalizeSchedule(p.schedule),
          session: normalizeSession(p.session),
          titleIndex: Number.isInteger(p.titleIndex) && p.titleIndex >= 0 ? p.titleIndex : 0,
          lastRun: typeof p.lastRun === "string" ? p.lastRun : null,
          lastStatus: typeof p.lastStatus === "string" ? p.lastStatus : "never run",
          lastResume: typeof p.lastResume === "string" ? p.lastResume : "never run",
          lastHeadline: typeof p.lastHeadline === "string" ? p.lastHeadline : "",
        })),
    };
  } catch {
    return blankRegistry();
  }
}

function saveRegistry(reg) {
  ensureDir();
  // Atomic write (temp + rename) so a killed process can never leave torn JSON.
  const tmp = REGISTRY_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), "utf8");
  fs.renameSync(tmp, REGISTRY_FILE);
  try {
    require("./cloudBackup").pushSoon();
  } catch {}
}

function getProfile(reg, id) {
  return reg.profiles.find((p) => p.id === id) || null;
}

function normalizeNotify(n) {
  const type = n && (n.type === "group" || n.type === "personal") ? n.type : "off";
  return {
    type,
    group: n && typeof n.group === "string" ? n.group.trim() : "",
    phone: n && typeof n.phone === "string" ? n.phone.trim() : "",
    customMsg: n && typeof n.customMsg === "string" ? n.customMsg.trim().slice(0, 500) : "",
  };
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || "");
}

// Email+password primary (headless, no window). Chrome capture is fallback.
function normalizeAuth(input) {
  const src = input || {};
  return {
    method: "password",
    email: String(src.email || "").trim(),
    password: String(src.password || ""),
  };
}

function parseHM(s) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec((s || "").trim());
  return m ? { h: +m[1], m: +m[2], mins: +m[1] * 60 + +m[2] } : null;
}

// Daily schedule: interval (global Xh) | fixed time | random moment in window.
// Times are server-local HH:MM (24h).
function normalizeSchedule(s) {
  const mode = s && (s.mode === "daily" || s.mode === "window") ? s.mode : "interval";
  if (mode === "daily") {
    if (!parseHM(s.time)) throw new Error("Daily time must be HH:MM (24h), e.g. 09:00");
    return { mode, time: s.time.trim(), from: "", to: "" };
  }
  if (mode === "window") {
    const f = parseHM(s.from);
    const t = parseHM(s.to);
    if (!f || !t) throw new Error("Window needs From and To times (HH:MM, 24h)");
    if (f.mins >= t.mins) throw new Error("Window start must be before end (same day)");
    return { mode, from: s.from.trim(), to: s.to.trim(), time: "" };
  }
  const hrs = !s || s.hours === undefined || s.hours === "" ? 18 : parseFloat(s.hours);
  if (!Number.isFinite(hrs) || hrs < 0.5 || hrs > 720) throw new Error("Hours must be a number between 0.5 and 720");
  return { mode: "interval", hours: hrs, time: "", from: "", to: "" };
}

// Which updates a profile wants each cycle: Title and/or Resume (at least one).
function normalizeTasks(t) {
  const title = !t || t.title === undefined ? true : !!t.title;
  const resume = !t || t.resume === undefined ? true : !!t.resume;
  if (!title && !resume) throw new Error("Select at least one update task: Title and/or Resume");
  return { title, resume };
}

// Saved login session (sealed cookies + bearer). Reused until it stops working.
function normalizeSession(s) {
  const c = (s && s.cookies) || {};
  return {
    bearer: typeof s?.bearer === "string" ? s.bearer : "",
    savedAt: typeof s?.savedAt === "string" ? s.savedAt : null,
    cookies: {
      nauk_at: String(c.nauk_at || ""),
      nauk_sid: String(c.nauk_sid || ""),
      nauk_rt: String(c.nauk_rt || ""),
    },
  };
}

function validateAuth(auth) {
  if (!auth.email || !validEmail(auth.email)) throw new Error("Valid login email is required");
  if (!auth.password) throw new Error("Login password is required");
  return auth;
}

// Build + validate auth without saving (used by add + refresh-login).
function buildAuth(authInput) {
  return validateAuth(normalizeAuth(authInput));
}

function setAuth(reg, id, auth) {
  const p = getProfile(reg, id);
  if (!p) throw new Error("Profile not found");
  p.auth = auth;
  saveRegistry(reg);
  return p;
}

// Replace a saved profile's Titles.txt and/or Resume.pdf (same strict rules as add).
// New titles restart the rotation from #1.
function updateFiles(reg, id, { titlesText, titlesOrigName, resumeBuffer, resumeOrigName }) {
  const p = getProfile(reg, id);
  if (!p) throw new Error("Profile not found");
  const wantTitles = titlesText !== undefined && titlesText !== null;
  const wantResume = !!(resumeBuffer && resumeBuffer.length);
  if (!wantTitles && !wantResume) throw new Error("Nothing to update — choose a titles file/text and/or a resume PDF");

  if (wantTitles) {
    const titles = String(titlesText || "")
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    if (titles.length === 0) throw new Error("At least one title is required");
    if (titlesOrigName && !/\.txt$/i.test(titlesOrigName)) {
      throw new Error(`Titles file must be a .txt file (got "${titlesOrigName}")`);
    }
    fs.writeFileSync(titlesPath(p), titles.join("\n") + "\n", "utf8");
    p.titleIndex = 0; // fresh list → restart rotation from #1
  }

  if (wantResume) {
    if (!resumeOrigName || !/\.pdf$/i.test(resumeOrigName)) {
      throw new Error(`Resume must be a .pdf file (got "${resumeOrigName || "no file"}")`);
    }
    if (!isPdfBuffer(resumeBuffer)) throw new Error("Resume file is not a valid PDF (must start with %PDF)");
    fs.writeFileSync(resumePath(p), resumeBuffer);
  }

  saveRegistry(reg);
  return p;
}

function phoneDigits(phone) {
  return (phone || "").replace(/\D/g, "");
}

function validateNotify(notify) {
  const n = normalizeNotify(notify);
  if (n.type === "group" && !n.group) throw new Error("Group name is required for group notifications");
  if (n.type === "personal") {
    const d = phoneDigits(n.phone);
    if (d.length < 7 || d.length > 15) throw new Error("Personal number must have 7–15 digits (include country code, e.g. 919876543210)");
    n.phone = d;
  }
  return n;
}

function isPdfBuffer(buf) {
  return buf && buf.length > 4 && buf.slice(0, 5).toString("ascii") === "%PDF-";
}

// Add a profile + write its two files. Throws with a friendly message.
function addProfile(reg, { name, auth, tasks, schedule, titlesText, titlesOrigName, resumeBuffer, resumeOrigName, notify }) {
  const cleanName = (name || "").trim();
  if (!cleanName) throw new Error("Profile Name is required");
  const safe = safeName(cleanName);
  if (!safe) throw new Error("Profile Name must contain at least one letter/digit");
  if (reg.profiles.some((p) => p.safe.toLowerCase() === safe.toLowerCase())) {
    throw new Error(`A profile with file name "${safe}" already exists`);
  }
  const finalAuth = buildAuth(auth);
  const finalTasks = normalizeTasks(tasks);
  const finalSchedule = normalizeSchedule(schedule);

  const titles = (titlesText || "")
    .split("\n")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  if (titles.length === 0) throw new Error("At least one title is required (titles file or pasted text)");
  if (titlesOrigName && !/\.txt$/i.test(titlesOrigName)) {
    throw new Error(`Titles file must be a .txt file (got "${titlesOrigName}") — it will be saved as ${safe}_Titles.txt`);
  }

  if (!resumeBuffer || resumeBuffer.length === 0) throw new Error("Resume PDF is required");
  if (!resumeOrigName || !/\.pdf$/i.test(resumeOrigName)) {
    throw new Error(`Resume must be a .pdf file (got "${resumeOrigName || "no file"}") — it will be saved as ${safe}_Resume.pdf`);
  }
  if (!isPdfBuffer(resumeBuffer)) throw new Error("Resume file is not a valid PDF (must start with %PDF)");

  const profile = {
    id: crypto.randomBytes(8).toString("hex"),
    name: cleanName,
    safe,
    auth: finalAuth, // { method: 'password'|'cookies', ... } — stored on YOUR server only
    notify: validateNotify(notify),
    tasks: finalTasks,
    schedule: finalSchedule,
    session: normalizeSession(null), // filled after the first successful login
    titleIndex: 0,
    lastRun: null,
    lastStatus: "never run",
    lastResume: "never run",
    lastHeadline: "",
  };

  ensureDir();
  fs.writeFileSync(titlesPath(profile), titles.join("\n") + "\n", "utf8");
  fs.writeFileSync(resumePath(profile), resumeBuffer);
  reg.profiles.push(profile);
  saveRegistry(reg);
  return profile;
}

function deleteProfile(reg, id) {
  const i = reg.profiles.findIndex((p) => p.id === id);
  if (i === -1) throw new Error("Profile not found");
  const p = reg.profiles[i];
  // Remove files FIRST — if a file is locked, throw before touching the entry.
  for (const f of [titlesPath(p), resumePath(p)]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  reg.profiles.splice(i, 1);
  saveRegistry(reg);
  return p;
}

function updateNotify(reg, id, notify) {
  const p = getProfile(reg, id);
  if (!p) throw new Error("Profile not found");
  p.notify = validateNotify(notify);
  saveRegistry(reg);
  return p;
}

function updateTasks(reg, id, tasks) {
  const p = getProfile(reg, id);
  if (!p) throw new Error("Profile not found");
  p.tasks = normalizeTasks(tasks);
  saveRegistry(reg);
  return p;
}

function updateSchedule(reg, id, schedule) {
  const p = getProfile(reg, id);
  if (!p) throw new Error("Profile not found");
  p.schedule = normalizeSchedule(schedule);
  saveRegistry(reg);
  return p;
}

// Wipe a profile's saved session cookies + login session (re-link after).
function clearCookies(reg, id) {
  const p = getProfile(reg, id);
  if (!p) throw new Error("Profile not found");
  p.session = normalizeSession(null);
  saveRegistry(reg);
  return p;
}

function readProfileTitles(profile) {
  try {
    return fs
      .readFileSync(titlesPath(profile), "utf8")
      .split("\n")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  } catch {
    return [];
  }
}

// Public view: never leaks passwords.
function maskEmail(email) {
  const [user, domain] = (email || "").split("@");
  if (!domain) return "***";
  return (user || "").slice(0, 2) + "***@" + domain;
}
function maskPhone(phone) {
  const d = phoneDigits(phone);
  return d ? "***" + d.slice(-4) : "";
}

module.exports = {
  PROFILES_DIR,
  loadRegistry,
  saveRegistry,
  getProfile,
  addProfile,
  deleteProfile,
  updateNotify,
  buildAuth,
  setAuth,
  updateFiles,
  updateTasks,
  updateSchedule,
  clearCookies,
  readProfileTitles,
  titlesPath,
  resumePath,
  safeName,
  phoneDigits,
  maskEmail,
  maskPhone,
};
