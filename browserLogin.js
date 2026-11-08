/**
 * "Login with Naukri" two ways — no email/password ever stored.
 *
 * A) Visible window (local machine with Chrome + screen): a real Chrome
 *    window opens on the Naukri login page -> YOU log in manually
 *    (OTP/captcha are fine, it's just Chrome) -> session auto-captured.
 *
 * B) Headless form login (servers like Render: no screen, no Chrome):
 *    the dashboard collects email+password (used once, never stored),
 *    a headless Chromium fills and submits the Naukri form. If Naukri
 *    asks for an OTP code, the dashboard prompts for it (submitOtp).
 *    Same button re-captures fresh cookies when a session expires.
 */

const fs = require("fs");
const path = require("path");

const BROWSER_PROFILE_DIR = path.join(__dirname, "browser-profile");
const HEADLESS_PROFILE_DIR = path.join(__dirname, "browser-profile-headless");
const LOGIN_URL = "https://www.naukri.com/nlogin/login";
const TIMEOUT_MS = 5 * 60 * 1000;
const HEADLESS_TIMEOUT_MS = 4 * 60 * 1000;
// Real desktop UA: headless Chrome's default UA advertises "HeadlessChrome"
// and Naukri answers with a bot wall instead of the login form.
const DESKTOP_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

let active = null; // { mode, profileId, profileName, browser, page, status, cookies, error, startedAt }

function log(...args) {
  console.log(new Date().toISOString(), "[BROWSER] -", ...args);
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const localApp = process.env.LOCALAPPDATA || "";
  const candidates = [
    localApp ? path.join(localApp, "Microsoft\\Edge\\Application\\msedge.exe") : "",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    localApp ? path.join(localApp, "Google\\Chrome\\Application\\chrome.exe") : "",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

// True when a visible window login is possible on this machine.
function headedCapable() {
  return !!findChrome();
}

function needPuppeteer() {
  try {
    return require("puppeteer-core");
  } catch {
    throw new Error("Browser login needs one install: npm install puppeteer-core");
  }
}

async function closeQuietly() {
  try {
    if (active && active.browser) await active.browser.close();
  } catch {
    // already closed
  }
}

async function readSessionCookies(page) {
  const cookies = await page.cookies();
  const map = {};
  for (const c of cookies) map[c.name] = c.value;
  if (!map.nauk_at) return null;
  return { nauk_at: map.nauk_at || "", nauk_sid: map.nauk_sid || "", nauk_rt: map.nauk_rt || "" };
}

function captureDone(where) {
  log(`Session captured for ${active.profileName} (${where}) — closing browser`);
}

async function launchWithFallback(puppeteer, opts) {
  try {
    return await puppeteer.launch(opts);
  } catch (e1) {
    log("Normal launch failed, retrying with --no-sandbox: " + String((e1 && e1.message) || e1).split("\n")[0]);
    try {
      return await puppeteer.launch({ ...opts, args: [...(opts.args || []), "--no-sandbox", "--disable-setuid-sandbox"] });
    } catch (e2) {
      throw new Error("Could not open Chrome: " + String((e2 && e2.message) || e2).split("\n")[0]);
    }
  }
}

// ---------- headless form-driven flow (VPS, incl. GUI VPS) ----------
async function resolveHeadless() {
  const puppeteer = needPuppeteer();
  if (process.platform === "linux") {
    // Render / containers: use the server-compatible Chromium build.
    let chromium;
    try {
      chromium = require("@sparticuz/chromium").default || require("@sparticuz/chromium");
    } catch {
      throw new Error("Headless login needs one install: npm install @sparticuz/chromium");
    }
    return {
      puppeteer,
      executablePath: await chromium.executablePath(),
      args: [...(chromium.args || []), "--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    };
  }
  const exe = findChrome();
  if (!exe) throw new Error("No browser found on this server for headless login either.");
  return { puppeteer, executablePath: exe, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu"] };
}

async function pageSnapshot(page) {
  return page.evaluate(() => {
    const body = ((document.body && document.body.innerText) || "").slice(0, 3000);
    const inputs = Array.from(document.querySelectorAll("input")).map((i) => ({
      type: (i.type || "").toLowerCase(),
      id: i.id || "",
      name: i.name || "",
      ph: i.placeholder || "",
      ml: i.maxLength > 0 ? i.maxLength : 0,
      visible: i.offsetParent !== null,
    }));
    const buttons = Array.from(document.querySelectorAll("button"))
      .filter((b) => b.offsetParent !== null)
      .map((b) => (b.innerText || "").trim().slice(0, 40));
    return { body, inputs, buttons, url: location.href };
  });
}

function onLoginPage(snap) {
  return /nlogin\/login/i.test(snap.url || "") || snap.inputs.some((i) => i.id === "usernameField" && i.visible);
}

function looksLoggedOutWithError(snap) {
  return /invalid|incorrect|wrong password|failed|not registered|account (does not|doesn't) exist|try again|cannot be left blank/i.test(snap.body);
}

// True OTP challenge: past the login form, code talk + a code-like box.
// (The login page itself advertises "Use OTP to Login" — never count that.)
function looksOtpChallenge(snap) {
  if (onLoginPage(snap)) return false;
  if (!/otp|verif|two[\s-]?step|two[\s-]?factor|authenticat|enter.*code|code.*(sent|expired)/i.test(snap.body)) return false;
  return snap.inputs.some((i) => i.visible && (i.type === "text" || i.type === "tel" || i.type === "number" || i.type === ""));
}

function pickCodeInput(snap) {
  const vis = snap.inputs
    .map((i, idx) => ({ ...i, idx }))
    .filter((i) => i.visible && (i.type === "text" || i.type === "tel" || i.type === "number" || i.type === ""));
  if (!vis.length) return -1;
  const scored = vis.find((i) => /otp|code|verif|mobile|phone|number/i.test(i.id + " " + i.name + " " + i.ph) || (i.ml > 0 && i.ml <= 8));
  return (scored || vis[vis.length - 1]).idx;
}

async function typeInto(page, selector, text) {
  await page.waitForSelector(selector, { timeout: 15000 });
  // React-controlled inputs need real input events, not just keystrokes.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.focus();
    el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector);
  await page.type(selector, text, { delay: 40 });
}

async function headlessPoll() {
  const deadline = Date.now() + HEADLESS_TIMEOUT_MS;
  const settledAt = Date.now(); // form was just submitted by the starter
  while (active && (active.status === "waiting" || active.status === "otp")) {
    if (Date.now() > deadline) {
      active.status = "timeout";
      active.error = "Timed out — no Naukri session established. Check credentials and try again.";
      log(active.error);
      await closeQuietly();
      return;
    }
    let snap;
    try {
      const found = await readSessionCookies(active.page);
      if (found) {
        active.cookies = found;
        active.status = "done";
        captureDone("headless");
        await closeQuietly();
        return;
      }
      snap = await pageSnapshot(active.page);
    } catch {
      active.status = "closed";
      active.error = "Headless browser died unexpectedly — try again.";
      log(active.error);
      return;
    }
    if (active.status === "otp") {
      // paused: waiting for the user to POST the code via /api/browser/otp
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (looksOtpChallenge(snap)) {
      active.status = "otp";
      active.error = null;
      log("Naukri asks for a verification code — waiting for it on the dashboard");
      continue;
    }
    if (Date.now() - settledAt > 12000 && looksLoggedOutWithError(snap)) {
      active.status = "error";
      active.error = "Naukri rejected the login (wrong email/password, or account blocked).";
      log(active.error);
      await closeQuietly();
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Start headless login with dashboard-supplied creds (used once, never stored).
async function startHeadlessLogin(profileId, profileName, email, password) {
  if (active && (active.status === "waiting" || active.status === "otp" || active.status === "filling")) {
    throw new Error(`A browser login is already in progress for "${active.profileName}" — finish or cancel it first`);
  }
  if (!email || !password) throw new Error("Email and password are required for headless login.");
  const { puppeteer, executablePath, args } = await resolveHeadless();
  if (!fs.existsSync(HEADLESS_PROFILE_DIR)) fs.mkdirSync(HEADLESS_PROFILE_DIR, { recursive: true });
  active = { mode: "headless", profileId: profileId || "new", profileName: profileName || "profile", browser: null, page: null, status: "filling", cookies: null, error: null, startedAt: Date.now() };
  try {
    const browser = await puppeteer.launch({ executablePath, headless: true, args, userDataDir: HEADLESS_PROFILE_DIR });
    active.browser = browser;
    const page = await browser.newPage();
    active.page = page;
    await page.setUserAgent(DESKTOP_UA);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    try {
      await page.click("button#cookieButton", { timeout: 2500 });
    } catch {}
    await typeInto(page, "#usernameField", email);
    await typeInto(page, "#passwordField", password);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
    ]);
    active.status = "waiting";
    log(`Headless login submitted for "${active.profileName}" — watching for session or OTP`);
    headlessPoll().catch(() => {});
    return { started: true, mode: "headless" };
  } catch (e) {
    const msg = String((e && e.message) || e).split("\n")[0];
    await closeQuietly();
    active = null; // free the slot so the user can retry immediately
    throw new Error(msg);
  }
}

// Submit the OTP code the user typed on the dashboard.
async function submitOtp(code) {
  if (!active || active.status !== "otp" || !active.page) {
    throw new Error("No OTP challenge pending right now.");
  }
  const clean = String(code || "").trim();
  if (!clean) throw new Error("Enter the code first.");
  const page = active.page;
  const ok = await page.evaluate((idx) => {
    const inputs = Array.from(document.querySelectorAll("input")).filter((i) => {
      const t = (i.type || "").toLowerCase();
      return (t === "" || t === "text" || t === "tel" || t === "number") && i.offsetParent !== null;
    });
    const el = (idx >= 0 && inputs[idx]) || inputs[inputs.length - 1] || inputs[0];
    if (!el) return false;
    el.id = "__otp_box";
    return true;
  }, pickCodeInput(await pageSnapshot(page)));
  if (!ok) throw new Error("Could not find the code box on the Naukri page.");
  await typeInto(page, "#__otp_box", clean);
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button")).filter((b) => b.offsetParent !== null);
    const rx = /verify|submit|continue|confirm|login|proceed/i;
    const el = btns.find((b) => rx.test(b.innerText || "")) || btns[btns.length - 1];
    if (!el) return false;
    el.click();
    return true;
  });
  if (!clicked) await page.keyboard.press("Enter").catch(() => {});
  active.status = "waiting"; // poll resumes: cookies => done, else error/timeout
  log("OTP submitted — watching result");
  headlessPoll().catch(() => {});
  return { submitted: true };
}

function getBrowserStatus() {
  if (!active) return { active: false, headed: false, chrome: !!findChrome(), mode: null };
  return {
    active: true,
    headed: false,
    chrome: !!findChrome(),
    mode: active.mode || "headless",
    profileId: active.profileId,
    profileName: active.profileName,
    status: active.status,
    error: active.error,
    elapsedSec: Math.floor((Date.now() - active.startedAt) / 1000),
  };
}

// One-shot pickup of captured cookies (clears the session slot).
function takeBrowserCookies() {
  if (!active || active.status !== "done" || !active.cookies) {
    throw new Error("No captured session yet — finish logging in first");
  }
  const cookies = active.cookies;
  active = null;
  return cookies;
}

async function cancelBrowserLogin() {
  await closeQuietly();
  active = null;
  return { ok: true };
}

// ---------- Persistent farm: one browser, one isolated tab per profile ----------
// The browser stays open; each profile gets its own incognito context (own tab,
// own cookies) so many Naukri logins stay active side by side. Test-login only
// READS these tabs — it never POSTs a password, so it never triggers MFA.
let farm = null; // { browser, mode, startedAt }

const farmTabs = new Map(); // profileId -> { profileId, profileName, context, page, status, cookies, error, startedAt }

function farmMode() {
  // Headless only (works on GUI VPS too — no visible window needed).
  return "headless";
}

async function ensureFarmBrowser() {
  if (farm && farm.browser) {
    try {
      if (farm.browser.connected) return farm;
    } catch {}
    try { await farm.browser.close().catch(() => {}); } catch {}
    farm = null;
  }
  const puppeteer = needPuppeteer();
  const mode = farmMode();
  let browser;
  {
    const { executablePath, args } = await resolveHeadless();
    if (!fs.existsSync(HEADLESS_PROFILE_DIR)) fs.mkdirSync(HEADLESS_PROFILE_DIR, { recursive: true });
    browser = await launchWithFallback(puppeteer, {
      executablePath, headless: true, args, userDataDir: HEADLESS_PROFILE_DIR,
    });
  }
  browser.on("disconnected", () => { farm = null; farmTabs.clear(); log("Farm browser closed — tabs cleared"); });
  farm = { browser, mode, startedAt: Date.now() };
  log(`Farm browser open (${mode}) — stays open, one tab per profile`);
  return farm;
}

async function openProfileTab(profileId, profileName) {
  if (!profileId) throw new Error("profileId is required");
  const f = await ensureFarmBrowser();
  let tab = farmTabs.get(String(profileId));
  try {
    if (tab && tab.page && !tab.page.isClosed()) {
      await tab.page.bringToFront().catch(() => {});
      return { opened: false, reused: true, mode: f.mode, status: tab.status };
    }
  } catch {}
  if (tab) { try { await tab.context.close().catch(() => {}); } catch {} farmTabs.delete(String(profileId)); }
  const context = await f.browser.createBrowserContext();
  const page = await context.newPage();
  if (f.mode === "headless") await page.setUserAgent(DESKTOP_UA);
  tab = { profileId: String(profileId), profileName: profileName || "profile", context, page, status: "open", cookies: null, error: null, startedAt: Date.now() };
  farmTabs.set(String(profileId), tab);
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
  log(`Tab opened for "${tab.profileName}" (${f.mode}) — stays open alongside other profiles`);
  return { opened: true, reused: false, mode: f.mode, status: tab.status };
}

async function readTabCookies(tab) {
  try {
    const cookies = await tab.page.cookies();
    const map = {};
    for (const c of cookies) map[c.name] = c.value;
    if (!map.nauk_at) return null;
    return { nauk_at: map.nauk_at || "", nauk_sid: map.nauk_sid || "", nauk_rt: map.nauk_rt || "" };
  } catch {
    return null;
  }
}

function farmTabPoll(tab) {
  const deadline = Date.now() + HEADLESS_TIMEOUT_MS;
  const settledAt = Date.now();
  (async () => {
    while (farmTabs.get(tab.profileId) === tab && (tab.status === "waiting" || tab.status === "otp")) {
      if (Date.now() > deadline) {
        tab.status = "timeout";
        tab.error = "Timed out — no Naukri session established in this tab.";
        log(tab.error);
        return;
      }
      let snap = null;
      try {
        const found = await readTabCookies(tab);
        if (found) {
          tab.cookies = found;
          tab.status = "done";
          log(`Tab session live for "${tab.profileName}" — tab stays open`);
          return;
        }
        snap = await pageSnapshot(tab.page);
      } catch {
        tab.status = "closed";
        tab.error = "Tab was closed before login completed";
        log(tab.error);
        return;
      }
      if (tab.status === "otp") { await new Promise((r) => setTimeout(r, 2000)); continue; }
      if (looksOtpChallenge(snap)) {
        tab.status = "otp";
        tab.error = null;
        log(`Naukri asks for a code in "${tab.profileName}" tab — waiting on dashboard`);
        continue;
      }
      if (Date.now() - settledAt > 12000 && looksLoggedOutWithError(snap)) {
        tab.status = "error";
        tab.error = "Naukri rejected the login (wrong email/password, or account blocked).";
        log(tab.error);
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })().catch(() => {});
}

// Log a persistent tab in with dashboard-supplied (or stored) creds — used once,
// never stored. The tab stays open afterwards with the session live in it.
async function startTabLogin(profileId, profileName, email, password) {
  if (!email || !password) throw new Error("Email and password are required for tab login.");
  const opened = await openProfileTab(profileId, profileName);
  const tab = farmTabs.get(String(profileId));
  if (!tab) throw new Error("Tab could not be opened.");
  if (tab.status === "waiting" || tab.status === "otp" || tab.status === "filling") {
    throw new Error(`Tab login already in progress for "${tab.profileName}"`);
  }
  tab.status = "filling";
  tab.error = null;
  try {
    const page = tab.page;
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    try { await page.click("button#cookieButton", { timeout: 2500 }); } catch {}
    await typeInto(page, "#usernameField", email);
    await typeInto(page, "#passwordField", password);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {}),
    ]);
    tab.status = "waiting";
    log(`Tab login submitted for "${tab.profileName}" — tab stays open`);
    farmTabPoll(tab);
    return { started: true, mode: (farm && farm.mode) || "headless", reused: opened.reused };
  } catch (e) {
    tab.status = "error";
    tab.error = String((e && e.message) || e).split("\n")[0];
    throw new Error(tab.error);
  }
}

async function submitTabOtp(profileId, code) {
  const tab = farmTabs.get(String(profileId));
  if (!tab || tab.status !== "otp" || !tab.page) throw new Error("No OTP challenge pending in this profile's tab.");
  const clean = String(code || "").trim();
  if (!clean) throw new Error("Enter the code first.");
  const page = tab.page;
  const ok = await page.evaluate((idx) => {
    const inputs = Array.from(document.querySelectorAll("input")).filter((i) => {
      const t = (i.type || "").toLowerCase();
      return (t === "" || t === "text" || t === "tel" || t === "number") && i.offsetParent !== null;
    });
    const el = (idx >= 0 && inputs[idx]) || inputs[inputs.length - 1] || inputs[0];
    if (!el) return false;
    el.id = "__otp_box";
    return true;
  }, pickCodeInput(await pageSnapshot(page)));
  if (!ok) throw new Error("Could not find the code box in this tab.");
  await typeInto(page, "#__otp_box", clean);
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button")).filter((b) => b.offsetParent !== null);
    const rx = /verify|submit|continue|confirm|login|proceed/i;
    const el = btns.find((b) => rx.test(b.innerText || "")) || btns[btns.length - 1];
    if (!el) return false;
    el.click();
    return true;
  });
  if (!clicked) await page.keyboard.press("Enter").catch(() => {});
  tab.status = "waiting";
  log(`OTP submitted in "${tab.profileName}" tab — watching result (tab stays open)`);
  farmTabPoll(tab);
  return { submitted: true };
}

async function checkProfileTab(profileId) {
  const tab = farmTabs.get(String(profileId));
  if (!tab) return { open: false, live: false };
  try {
    if (!tab.page || tab.page.isClosed()) { farmTabs.delete(String(profileId)); return { open: false, live: false }; }
  } catch { farmTabs.delete(String(profileId)); return { open: false, live: false }; }
  const cookies = await readTabCookies(tab);
  if (cookies) { tab.cookies = cookies; if (tab.status !== "otp") tab.status = "done"; }
  let url = "";
  try { url = tab.page.url(); } catch {}
  return { open: true, live: !!cookies, status: tab.status, error: tab.error, cookies, url, profileName: tab.profileName };
}

async function closeProfileTab(profileId) {
  const tab = farmTabs.get(String(profileId));
  farmTabs.delete(String(profileId));
  if (tab) { try { await tab.context.close().catch(() => {}); } catch {} }
  return { ok: true };
}

function getFarmStatus() {
  const tabs = [];
  for (const [id, t] of farmTabs) {
    let closed = true;
    try { closed = !t.page || t.page.isClosed(); } catch {}
    tabs.push({ profileId: id, profileName: t.profileName, status: closed ? "closed" : t.status, live: !!(t.cookies && t.cookies.nauk_at), error: t.error });
  }
  return { running: !!(farm && farm.browser), mode: farm ? farm.mode : farmMode(), headed: false, tabs };
}

module.exports = {
  startHeadlessLogin,
  submitOtp,
  getBrowserStatus,
  takeBrowserCookies,
  cancelBrowserLogin,
  findChrome,
  openProfileTab,
  startTabLogin,
  submitTabOtp,
  checkProfileTab,
  closeProfileTab,
  getFarmStatus,
};
