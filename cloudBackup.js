/**
 * Free off-server backup so Render's ephemeral disk can wipe freely.
 * Uses Upstash Redis REST (no extra npm deps, plain fetch):
 *   1. Create a FREE Redis database at https://upstash.com
 *   2. Set env vars (local .env AND Render dashboard):
 *        UPSTASH_REDIS_REST_URL=https://...upstash.io
 *        UPSTASH_REDIS_REST_TOKEN=AX... (never commit this)
 * What is stored: profiles.json, settings.json, every Name_Titles.txt /
 * Name_Resume.pdf, and the wa-session/ link files (all as-is; secrets in
 * them stay AES-sealed exactly as on disk).
 * Restore rule (safe by design): cloud data is only written locally when
 * the local copy is MISSING/EMPTY (fresh deploy) — a running server with
 * real data is never overwritten. Local changes push up (debounced).
 */

const fs = require("fs");
const path = require("path");

const K = {
  manifest: "nb:manifest",
  registry: "nb:registry",
  settings: "nb:settings",
  file: (name) => "nb:file:" + name,
  waChunk: (i) => "nb:wa:" + i,
};

// wa-session holds ~1000 tiny files — bundle them into few chunk keys
// (one REST call per file would burn the free quota in a single push).
const WA_CHUNK_BYTES = 300000;
function safeName(name) {
  return path.basename(String(name || ""));
}

function cfg() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return { enabled: !!(url && token), url, token };
}
function isEnabled() {
  return cfg().enabled;
}

function log(...args) {
  console.log(new Date().toISOString(), "[CLOUD] -", ...args);
}

const state = { lastPush: null, lastPull: null, error: null, pushTimer: null };

function getStatus() {
  return { enabled: isEnabled(), lastPush: state.lastPush, lastPull: state.lastPull, error: state.error };
}

async function cmd(pathname) {
  const c = cfg();
  if (!c.enabled) throw new Error("Cloud backup not configured (set UPSTASH_REDIS_REST_URL/TOKEN)");
  const res = await fetch(c.url + pathname, { headers: { authorization: "Bearer " + c.token } });
  const text = await res.text();
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${text.slice(0, 200)}`);
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Bad Upstash response: " + text.slice(0, 200));
  }
  if (data.error) throw new Error("Upstash: " + data.error);
  return data.result === undefined ? null : data.result;
}

const enc = (s) => encodeURIComponent(s);
// SET via POST body (values like PDFs are far too big for URL paths —
// servers/proxies reject long URLs, e.g. Node answers 431).
async function setKey(key, value) {
  const c = cfg();
  if (!c.enabled) throw new Error("Cloud backup not configured (set UPSTASH_REDIS_REST_URL/TOKEN)");
  const res = await fetch(c.url, {
    method: "POST",
    headers: { authorization: "Bearer " + c.token, "content-type": "application/json" },
    body: JSON.stringify(["SET", key, value]),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Upstash ${res.status}: ${text.slice(0, 200)}`);
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Bad Upstash response: " + text.slice(0, 200));
  }
  if (data.error) throw new Error("Upstash: " + data.error);
  return data.result;
}
async function getKey(key) {
  return cmd("/get/" + enc(key));
}
async function delKeys(keys) {
  if (!keys.length) return;
  await cmd("/del/" + keys.map(enc).join("/"));
}

function profilesDir() {
  return path.join(__dirname, "profiles");
}
function waDir() {
  return path.join(__dirname, "wa-session");
}
function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function readB64(p) {
  try {
    return fs.readFileSync(p).toString("base64");
  } catch {
    return null;
  }
}
function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

// Push everything up. Returns { pushed, files }.
async function pushAll() {
  if (!isEnabled()) return { pushed: false, reason: "not configured" };
  const manifest = { at: new Date().toISOString(), profiles: [], files: [], waChunks: 0, settings: false };
  const regRaw = readText(path.join(profilesDir(), "profiles.json"));
  if (regRaw) {
    await setKey(K.registry, regRaw);
    try {
      const names = (JSON.parse(regRaw).profiles || []).map((p) => p.safe).filter(Boolean);
      manifest.profiles = names;
    } catch {}
  }
  const setRaw = readText(path.join(__dirname, "settings.json"));
  if (setRaw) {
    await setKey(K.settings, setRaw);
    manifest.settings = true;
  }
  for (const f of listFiles(profilesDir())) {
    if (f === "profiles.json" || f.endsWith(".tmp")) continue;
    const v = f.toLowerCase().endsWith(".pdf") ? readB64(path.join(profilesDir(), f)) : readText(path.join(profilesDir(), f));
    if (v === null) continue;
    await setKey(K.file(f), v);
    manifest.files.push(f);
  }
  let chunk = {};
  let chunkBytes = 2;
  let chunks = 0;
  const flushChunk = async () => {
    if (!Object.keys(chunk).length) return;
    await setKey(K.waChunk(chunks), JSON.stringify(chunk));
    chunks++;
    chunk = {};
    chunkBytes = 2;
  };
  for (const f of listFiles(waDir())) {
    const v = readB64(path.join(waDir(), f));
    if (v === null) continue;
    const entryBytes = f.length + v.length + 8;
    if (chunkBytes + entryBytes > WA_CHUNK_BYTES && Object.keys(chunk).length) await flushChunk();
    chunk[f] = v;
    chunkBytes += entryBytes;
  }
  await flushChunk();
  manifest.waChunks = chunks;
  await setKey(K.manifest, JSON.stringify(manifest));
  state.lastPush = new Date().toISOString();
  state.error = null;
  log(`backed up ${manifest.profiles.length} profile(s), ${manifest.files.length} file(s), wa chunks:${chunks}`);
  return { pushed: true, manifest };
}

// Debounced push (called after every local save).
function pushSoon() {
  if (!isEnabled()) return;
  if (state.pushTimer) return; // one already queued
  state.pushTimer = setTimeout(() => {
    state.pushTimer = null;
    pushAll().catch((e) => {
      state.error = e.message;
      log("push failed:", e.message);
    });
  }, 5000);
}

function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
}
function writeB64(p, b64) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, Buffer.from(b64, "base64"));
  fs.renameSync(tmp, p);
}

function localRegistryCount() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(profilesDir(), "profiles.json"), "utf8"));
    return Array.isArray(raw.profiles) ? raw.profiles.length : 0;
  } catch {
    return 0;
  }
}
function localWaLinked() {
  try {
    return fs.existsSync(path.join(waDir(), "creds.json"));
  } catch {
    return false;
  }
}

// Pull cloud data where local is missing/empty — or everywhere with { force: true }.
// Force is for the manual Restore button (caller confirms first).
async function pullMissing(opts) {
  const force = !!(opts && opts.force);
  if (!isEnabled()) return { pulled: false, reason: "not configured" };
  let manifest = null;
  try {
    const raw = await getKey(K.manifest);
    manifest = raw ? JSON.parse(raw) : null;
  } catch (e) {
    state.error = e.message;
    throw e;
  }
  if (!manifest) return { pulled: false, reason: "nothing stored yet" };
  if (!force && (manifest.profiles || []).length === 0 && !manifest.settings && (manifest.waChunks || 0) === 0) {
    return { pulled: false, reason: "nothing stored yet" };
  }
  const restored = { profiles: false, settings: false, files: [], wa: false };
  if (((manifest.profiles || []).length > 0 && localRegistryCount() === 0) || force) {
    const regRaw = await getKey(K.registry);
    if (regRaw) {
      writeText(path.join(profilesDir(), "profiles.json"), regRaw);
      restored.profiles = true;
    }
    for (const f of manifest.files || []) {
      const v = await getKey(K.file(f));
      if (v === null) continue;
      if (f.toLowerCase().endsWith(".pdf")) writeB64(path.join(profilesDir(), f), v);
      else writeText(path.join(profilesDir(), f), v);
      restored.files.push(f);
    }
  }
  if (manifest.settings && (!fs.existsSync(path.join(__dirname, "settings.json")) || force)) {
    const sRaw = await getKey(K.settings);
    if (sRaw) {
      writeText(path.join(__dirname, "settings.json"), sRaw);
      restored.settings = true;
    }
  }
  const waCount = manifest && typeof manifest.waChunks === "number" ? manifest.waChunks : 0;
  if (waCount > 0 && (!localWaLinked() || force)) {
    for (let i = 0; i < waCount; i++) {
      const raw = await getKey(K.waChunk(i));
      if (!raw) continue;
      let obj = {};
      try {
        obj = JSON.parse(raw);
      } catch {
        continue;
      }
      for (const [f, v] of Object.entries(obj)) {
        if (typeof v !== "string") continue;
        writeB64(path.join(waDir(), safeName(f)), v);
      }
    }
    restored.wa = true;
  }
  state.lastPull = new Date().toISOString();
  state.error = null;
  if (restored.profiles || restored.settings || restored.wa) {
    log(`restored from cloud: profiles=${restored.profiles} settings=${restored.settings} wa=${restored.wa} files=${restored.files.length}`);
  }
  return { pulled: true, restored };
}

async function wipeCloud() {
  if (!isEnabled()) return { wiped: false };
  const raw = await getKey(K.manifest).catch(() => null);
  let keys = [K.manifest, K.registry, K.settings];
  try {
    const m = raw ? JSON.parse(raw) : null;
    if (m) {
      for (const f of m.files || []) keys.push(K.file(f));
      const n = typeof m.waChunks === "number" ? m.waChunks : 0;
      for (let i = 0; i < Math.min(n, 200); i++) keys.push(K.waChunk(i));
    }
  } catch {}
  await delKeys(keys);
  await setKey(K.manifest, JSON.stringify({ at: new Date().toISOString(), profiles: [], files: [], waChunks: 0, settings: false }));
  return { wiped: true };
}

// Drop only the WhatsApp link files (used on unlink — profiles stay backed up).
async function dropWaCloud() {
  if (!isEnabled()) return { dropped: false };
  const raw = await getKey(K.manifest).catch(() => null);
  let manifest = null;
  try {
    manifest = raw ? JSON.parse(raw) : null;
  } catch {}
  if (manifest && typeof manifest.waChunks === "number" && manifest.waChunks > 0) {
    const keys = [];
    for (let i = 0; i < Math.min(manifest.waChunks, 200); i++) keys.push(K.waChunk(i));
    await delKeys(keys);
    manifest.waChunks = 0;
    manifest.at = new Date().toISOString();
    await setKey(K.manifest, JSON.stringify(manifest));
  }
  return { dropped: true };
}

module.exports = { isEnabled, getStatus, pushAll, pushSoon, pullMissing, wipeCloud, dropWaCloud };
