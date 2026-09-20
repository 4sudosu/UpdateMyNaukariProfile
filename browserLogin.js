/**
 * "Login with Naukri" via YOUR OWN browser — no email/password stored anywhere.
 *
 * Flow: dashboard "Login via Browser" -> a real Chrome window opens on the
 * Naukri login page -> YOU log in manually (OTP/captcha are fine, it's just
 * Chrome) -> this module spots the session cookies (nauk_at/nauk_sid/nauk_rt),
 * captures them and closes the window. The dashboard then saves them to the
 * profile (verified live). Same button re-captures fresh cookies when a
 * session expires.
 *
 * Needs Google Chrome installed (uses it, downloads nothing).
 * Local runs only — a cloud server has no screen to log in on.
 */

const fs = require("fs");
const path = require("path");

const BROWSER_PROFILE_DIR = path.join(__dirname, "browser-profile");
const LOGIN_URL = "https://www.naukri.com/nlogin/login";
const TIMEOUT_MS = 5 * 60 * 1000;

let active = null; // { profileId, profileName, browser, page, status, cookies, error, startedAt }

function log(...args) {
  console.log(new Date().toISOString(), "[BROWSER] -", ...args);
}

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const localApp = process.env.LOCALAPPDATA || "";
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    localApp ? path.join(localApp, "Google\\Chrome\\Application\\chrome.exe") : "",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

async function closeQuietly() {
  try {
    if (active && active.browser) await active.browser.close();
  } catch {
    // already closed
  }
}

async function pollLoop() {
  const deadline = Date.now() + TIMEOUT_MS;
  while (active && active.status === "waiting") {
    if (Date.now() > deadline) {
      active.status = "timeout";
      active.error = "Timed out after 5 minutes — no Naukri login detected in the opened browser";
      log(active.error);
      await closeQuietly();
      return;
    }
    try {
      const cookies = await active.page.cookies();
      const map = {};
      for (const c of cookies) map[c.name] = c.value;
      if (map.nauk_at) {
        active.cookies = { nauk_at: map.nauk_at || "", nauk_sid: map.nauk_sid || "", nauk_rt: map.nauk_rt || "" };
        active.status = "done";
        log(`Session captured for ${active.profileName} — closing browser`);
        await closeQuietly();
        return;
      }
    } catch {
      active.status = "closed";
      active.error = "Browser window was closed before login completed";
      log(active.error);
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// Start a browser login. profileId is informational ("new" when adding).
async function startBrowserLogin(profileId, profileName) {
  if (active && active.status === "waiting") {
    throw new Error(`A browser login is already in progress for "${active.profileName}" — finish or cancel it first`);
  }
  let puppeteer;
  try {
    puppeteer = require("puppeteer-core");
  } catch {
    throw new Error("Browser login needs one install: npm install puppeteer-core");
  }
  const exe = findChrome();
  if (!exe) {
    throw new Error("Google Chrome not found. Install Chrome, or set CHROME_PATH to your chrome.exe");
  }
  if (!fs.existsSync(BROWSER_PROFILE_DIR)) fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  const baseOpts = {
    executablePath: exe,
    headless: false,
    defaultViewport: null,
    args: ["--start-maximized"],
    userDataDir: BROWSER_PROFILE_DIR, // persists, so re-login later is often instant
  };
  let browser;
  try {
    browser = await puppeteer.launch(baseOpts);
  } catch (e1) {
    // Restricted environments (admin/CI sandboxes) often need --no-sandbox: retry once.
    log("Normal launch failed, retrying with --no-sandbox: " + String((e1 && e1.message) || e1).split("\n")[0]);
    try {
      browser = await puppeteer.launch({ ...baseOpts, args: [...baseOpts.args, "--no-sandbox", "--disable-setuid-sandbox"] });
    } catch (e2) {
      throw new Error("Could not open Chrome: " + String((e2 && e2.message) || e2).split("\n")[0]);
    }
  }
  const page = await browser.newPage();
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  active = { profileId: profileId || "new", profileName: profileName || "profile", browser, page, status: "waiting", cookies: null, error: null, startedAt: Date.now() };
  log(`Browser opened for "${active.profileName}" — log in to Naukri manually in that window`);
  pollLoop().catch(() => {});
  return { started: true };
}

function getBrowserStatus() {
  if (!active) return { active: false };
  return {
    active: true,
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
    throw new Error("No captured session yet — finish logging in inside the opened browser first");
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

module.exports = { startBrowserLogin, getBrowserStatus, takeBrowserCookies, cancelBrowserLogin, findChrome };
