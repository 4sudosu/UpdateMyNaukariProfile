/**
 * Dashboard-managed settings (NOT in .env — .env holds ONLY panel password + port).
 * settings.json: { intervalHours, theme, whatsapp: { enabled, accountName } }
 */

const fs = require("fs");
const path = require("path");

const SETTINGS_FILE = path.join(__dirname, "settings.json");

// The 10 dashboard themes (ids shared with dashboard.html THEMES).
const THEME_IDS = ["indigo", "ocean", "emerald", "sunset", "rose", "midnight", "plum", "forest", "abyss", "cocoa"];

function defaults() {
  // WhatsApp is opt-in: OFF until linked from the dashboard. Never auto-links on startup.
  return { intervalHours: 18, theme: "indigo", whatsapp: { enabled: false, accountName: "" } };
}

function clampInterval(v) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(720, Math.max(0.5, n));
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    const d = defaults();
    const iv = clampInterval(raw.intervalHours);
    return {
      intervalHours: iv === null ? d.intervalHours : iv,
      theme: THEME_IDS.includes(raw.theme) ? raw.theme : d.theme,
      whatsapp: {
        enabled: raw.whatsapp && typeof raw.whatsapp.enabled === "boolean" ? raw.whatsapp.enabled : d.whatsapp.enabled,
        accountName:
          raw.whatsapp && typeof raw.whatsapp.accountName === "string"
            ? raw.whatsapp.accountName.trim().slice(0, 40)
            : "",
      },
    };
  } catch {
    return defaults();
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), "utf8");
}

module.exports = { loadSettings, saveSettings, clampInterval, THEME_IDS };
