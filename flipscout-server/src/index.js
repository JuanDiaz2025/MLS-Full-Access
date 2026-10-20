// The Twin Network server.
//
// It exists because a published Artifact cannot call anything but the viewer's
// own connectors, so the Lead Board can record that somebody pressed
// ⬆ Push to REI but cannot carry it out. This service does the carrying.
//
//   POST /push      one lead -> one REI BlackBook contact
//   GET  /job/:id   how that push went
//   GET  /health    is the REI session still good
//   GET  /          a status page, in the board's own colours
//
// Every route but /health needs the API token. The service writes to a live
// CRM; it is never left open.

import express from "express";
import { config } from "./config.js";
import { ReiSession } from "./rei/session.js";
import { ReiContacts } from "./rei/contacts.js";
import { Queue } from "./queue.js";
import { makeRelogin } from "./rei/relogin.js";
import { statusPage } from "./status-page.js";

const log = {
  info: (m) => console.log(new Date().toISOString() + "  " + m),
  warn: (m) => console.warn(new Date().toISOString() + "  WARN " + m),
  error: (m) => console.error(new Date().toISOString() + "  ERROR " + m)
};

const session = new ReiSession({
  base: config.rei.base,
  statePath: config.rei.statePath,
  relogin: makeRelogin(config, log),
  log
});
const contacts = new ReiContacts(session, { profileId: config.rei.profileId, log });
const queue = new Queue(config.queuePath, { log });

await session.load();
await queue.load();

// ---- the worker: one job at a time, so two pushes never race a re-login ----
let pumping = false;
async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    let job;
    while ((job = queue.next())) {
      await queue.claim(job);
      try {
        const res = await contacts.create(job.payload);
        if (!res.ok) { await queue.fail(job, Object.assign(new Error(res.code), { code: res.code }), { retry: false }); }
        else { await queue.finish(job, { id: res.id || "", filled: res.filled }); log.info("push " + job.id + " -> REI" + (res.id ? " #" + res.id : "")); }
      } catch (e) {
        log.error("push " + job.id + " failed: " + e.message);
        await queue.fail(job, e);
      }
    }
  } finally {
    pumping = false;
  }
}

// ---- http ----
const app = express();
app.use(express.json({ limit: "256kb" }));
app.disable("x-powered-by");

function authed(req, res, next) {
  const given = (req.get("authorization") || "").replace(/^Bearer\s+/i, "") || req.query.token;
  if (given !== config.apiToken) return res.status(401).json({ ok: false, error: "bad or missing token" });
  next();
}

app.get("/health", async (_req, res) => {
  try {
    await session.whoami();
    res.json({ ok: true, rei: "signed in", queue: queue.counts() });
  } catch (e) {
    res.status(503).json({ ok: false, rei: e.code === "signed_out" ? "signed out" : "unreachable", error: e.message, queue: queue.counts() });
  }
});

// One press on the board. `id` is the lead's MLS #, which makes the call
// idempotent: pressing twice does not create two contacts.
app.post("/push", authed, async (req, res) => {
  const { id, contact } = req.body || {};
  if (!id || !contact) return res.status(400).json({ ok: false, error: "id and contact are required" });
  const { job, added } = await queue.add(String(id), contact);
  pump();
  res.status(added ? 202 : 200).json({ ok: true, id: job.id, status: job.status, alreadyQueued: !added });
});

app.get("/job/:id", authed, (req, res) => {
  const job = queue.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: "no such push" });
  res.json({ ok: true, id: job.id, status: job.status, result: job.result, error: job.error, attempts: job.attempts });
});

app.get("/", authed, (_req, res) => {
  res.type("html").send(statusPage({ counts: queue.counts(), jobs: queue.all().slice(0, 40), base: config.rei.base }));
});

app.listen(config.port, () => {
  log.info("flipscout-server listening on :" + config.port);
  pump();
});

// A push that arrived while the server was down still goes out.
setInterval(pump, 30000).unref?.();
