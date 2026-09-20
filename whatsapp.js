/**
 * Free WhatsApp alerts via Baileys (WhatsApp Web protocol, no paid API).
 *
 * Link your number two ways (dashboard Web section):
 *   1. QR — scan the code shown on the dashboard / terminal with your phone
 *      (WhatsApp > Settings > Linked devices > Link a device).
 *   2. Number — enter your number with country code, get an 8-char pairing
 *      code, type it on the phone (Linked devices > Link with phone number).
 * Session persists in wa-session/ so you only link once (until logout).
 *
 * Each Naukri profile picks its own target: group (by name) or personal
 * (number with country code).
 */

const fs = require("fs");
const path = require("path");

// ON by default (dashboard Settings can turn it off). NOT in .env anymore —
// .env holds ONLY the panel password + port.
let enabled = true;
function configure(opts) {
  if (opts && typeof opts.enabled === "boolean") enabled = opts.enabled;
}
function isEnabled() {
  return enabled;
}
function groupName() {
  return (process.env.WHATSAPP_GROUP_NAME || "").trim();
}
function sessionDir() {
  return path.join(__dirname, "wa-session");
}

let sock = null;
let connected = false;
let qrPending = false;
let qrAscii = null; // latest QR as terminal-art, shown on the dashboard
let starting = null;

function log(...args) {
  console.log(new Date().toISOString(), "[WA] -", ...args);
}

function accountPhone() {
  try {
    return sock && sock.user ? String(sock.user.id).split(":")[0] : null;
  } catch {
    return null;
  }
}

// True when a previous link's session files exist (no QR needed to reconnect).
function hasSession() {
  try {
    return fs.existsSync(path.join(sessionDir(), "creds.json"));
  } catch {
    return false;
  }
}

// Fail fast (no QR spam, no 60s wait) when nothing was ever linked.
function requireLinkable() {
  if (!connected && !hasSession()) {
    throw new Error("WhatsApp not linked — link it from the dashboard (scan QR or pair by number)");
  }
}

function getStatus() {
  return { enabled: isEnabled(), connected, qrPending, qrAscii: qrPending ? qrAscii : null, phone: accountPhone() };
}

// Start (or reuse) the WhatsApp connection in the background.
// Safe to call many times; resolves to the socket or null.
async function startWhatsApp() {
  if (!isEnabled()) return null;
  if (sock && connected) return sock;
  if (starting) return starting;

  starting = (async () => {
    let baileys;
    try {
      baileys = require("@whiskeysockets/baileys");
    } catch {
      log("ERROR: packages missing. Run: npm install @whiskeysockets/baileys qrcode-terminal");
      starting = null;
      return null;
    }

    const { state, saveCreds } = await baileys.useMultiFileAuthState(sessionDir());
    let version;
    try {
      version = (await baileys.fetchLatestBaileysVersion()).version;
    } catch {
      version = undefined; // offline now — Baileys falls back to its default
    }

    const qrcode = require("qrcode-terminal");
    sock = baileys.makeWASocket({
      version,
      auth: state,
      browser: ["Naukri Rotator", "Chrome", "1.0"],
    });
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("connection.update", (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        qrPending = true;
        log("Scan this QR with WhatsApp (Settings > Linked devices > Link a device):");
        qrcode.generate(qr, { small: true });
        try {
          qrcode.generate(qr, { small: true }, (ascii) => {
            qrAscii = ascii || null;
          });
        } catch {
          qrAscii = null;
        }
      }
      if (connection === "open") {
        connected = true;
        qrPending = false;
        qrAscii = null;
        log("Connected" + (sock.user ? ` as ${sock.user.id.split(":")[0]}` : ""));
      }
      if (connection === "close") {
        connected = false;
        let code = null;
        try {
          code = lastDisconnect.error.output.statusCode;
        } catch {
          code = null;
        }
        const loggedOut = code === baileys.DisconnectReason.loggedOut;
        if (loggedOut) {
          log("Logged out from phone — delete wa-session/ folder and restart to scan again");
        } else {
          log("Connection closed — reconnecting in 5s...");
        }
        sock = null;
        starting = null;
        if (!loggedOut && isEnabled()) setTimeout(() => startWhatsApp().catch(() => {}), 5000);
      }
    });
    return sock;
  })();

  return starting;
}

// Wait (up to timeoutMs) for an active connection.
async function waitForConnection(timeoutMs = 60000) {
  const s = await startWhatsApp();
  if (!s) throw new Error("WhatsApp unavailable (disabled or packages missing)");
  const start = Date.now();
  while (!connected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for WhatsApp link — scan the QR printed in the terminal");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return sock;
}

// Pure helper (unit-testable): find a group JID by exact name, case-insensitive.
function findGroupId(groups, name) {
  const want = (name || "").trim().toLowerCase();
  for (const [jid, meta] of Object.entries(groups || {})) {
    if (((meta && meta.subject) || "").trim().toLowerCase() === want) return jid;
  }
  return null;
}

function listGroupNames(groups, limit = 20) {
  return Object.values(groups || {})
    .map((g) => g && g.subject)
    .filter(Boolean)
    .slice(0, limit);
}

// Send text to a group chosen by name (per-profile target).
// groupOverride wins; falls back to WHATSAPP_GROUP_NAME env for compatibility.
async function sendGroupMessage(text, groupOverride) {
  if (!isEnabled()) return { sent: false, reason: "WhatsApp is disabled in dashboard Settings" };
  const name = (groupOverride || groupName() || "").trim();
  if (!name) throw new Error("No WhatsApp group set for this profile");
  requireLinkable();
  const s = await waitForConnection();
  const groups = await s.groupFetchAllParticipating();
  const jid = findGroupId(groups, name);
  if (!jid) {
    throw new Error(`Group "${name}" not found. Your groups: ${listGroupNames(groups).join(" | ") || "(none)"}`);
  }
  await s.sendMessage(jid, { text });
  return { sent: true, group: name };
}

// Send text to a personal number (digits with country code, e.g. 919876543210).
async function sendPersonalMessage(text, phone) {
  if (!isEnabled()) return { sent: false, reason: "WhatsApp is disabled in dashboard Settings" };
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new Error("Personal number must have 7–15 digits with country code");
  requireLinkable();
  const s = await waitForConnection();
  await s.sendMessage(digits + "@s.whatsapp.net", { text });
  return { sent: true, phone: digits };
}

// Unlink this device: logout, drop the socket, wipe the session folder.
// Next start begins fully unlinked (QR / pairing code again).
async function unlinkWhatsApp() {
  try {
    if (sock) await sock.logout();
  } catch {
    // already dead — just clean up
  }
  sock = null;
  connected = false;
  qrPending = false;
  qrAscii = null;
  starting = null;
  try {
    fs.rmSync(sessionDir(), { recursive: true, force: true });
  } catch {
    // ignore
  }
  log("Unlinked — session cleared. Relink via QR or pairing code.");
  return { ok: true };
}

// Link by NUMBER: returns an 8-char pairing code to type on the phone
// (Linked devices > Link with phone number instead). Throws if already linked.
async function requestPairingCode(phone) {
  if (!isEnabled()) throw new Error("WhatsApp is disabled in dashboard Settings");
  const digits = (phone || "").replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new Error("Enter number with country code (digits only, e.g. 919876543210)");
  const s = await startWhatsApp();
  if (!s) throw new Error("WhatsApp unavailable (packages missing?)");
  if (connected) throw new Error("Already linked — no code needed");
  if (typeof s.requestPairingCode !== "function") throw new Error("This Baileys version has no pairing-code support — use the QR");
  const code = await s.requestPairingCode(digits);
  log(`Pairing code for +${digits}: ${code} (type it on the phone within ~60s)`);
  return { code, phone: digits };
}

function buildUpdateMessage(candidateName, headline, resumeFile, template) {
  const t = (template || "").trim();
  if (t) {
    return t
      .replaceAll("{name}", candidateName)
      .replaceAll("{headline}", headline)
      .replaceAll("{resume}", resumeFile)
      .replaceAll("{time}", new Date().toLocaleString());
  }
  return (
    `Hi Boss,\n` +
    `Profile Headline & Resume updated for ${candidateName}.\n` +
    `Headline: ${headline}\n` +
    `Resume: ${resumeFile}`
  );
}

module.exports = { configure, hasSession, startWhatsApp, unlinkWhatsApp, sendGroupMessage, sendPersonalMessage, requestPairingCode, getStatus, buildUpdateMessage, findGroupId };
