// Everything secret comes from the environment, never from a file in the repo.
// On the server these live in the host's own secret store (systemd
// EnvironmentFile, Fly secrets, Render environment, …) — not beside the code.
//
// Copy .env.example to .env on the box for local runs; .env is gitignored.

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error("Missing required environment variable " + name);
  return v;
}
function opt(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

export const config = {
  port: Number(opt("PORT", "8080")),

  rei: {
    base: opt("REI_BASE", "https://my.reiblackbook.com"),
    user: need("REI_USER"),
    pass: need("REI_PASS"),
    // The contact profile the Add Contact form saves into. Observed as 5289 on
    // Twin Home Buyer's account; it is account-specific, so it is configurable
    // and the client verifies it against REI's own field list before writing.
    profileId: opt("REI_PROFILE_ID", "5289"),
    // Where the session is kept between restarts, so a reboot doesn't trigger
    // a fresh login (and a fresh verification email) every time.
    statePath: opt("REI_STATE_PATH", "./data/rei-session.json")
  },

  // REI emails a verification code whenever it doesn't recognise the login.
  // Without a way to read that mailbox the server can get stuck at the code
  // screen, so this is optional only in the sense that the server still starts.
  mail: {
    enabled: opt("MAIL_HOST", "") !== "",
    host: opt("MAIL_HOST", ""),
    port: Number(opt("MAIL_PORT", "993")),
    user: opt("MAIL_USER", ""),
    pass: opt("MAIL_PASS", ""),
    // only messages newer than this are considered, so an old code is never reused
    maxAgeSeconds: Number(opt("MAIL_MAX_AGE", "600"))
  },

  queuePath: opt("QUEUE_PATH", "./data/queue.json"),

  // Callers must present this. The server creates records in a live CRM, so it
  // is never left open to the internet.
  apiToken: need("API_TOKEN")
};

export function redact(s) {
  if (!s) return s;
  return String(s).replace(new RegExp(escapeRe(config.rei.pass), "g"), "***")
    .replace(new RegExp(escapeRe(config.apiToken), "g"), "***");
}
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
