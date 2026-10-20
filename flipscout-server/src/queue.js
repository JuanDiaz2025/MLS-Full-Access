// A small durable queue. One push from the board is one job, and a job is only
// ever marked done after REI has actually accepted it — so a crash mid-flight
// leaves the job claimable again rather than silently lost.
//
// A JSON file is enough here: this queue holds tens of jobs a day, not
// thousands, and being able to read it with `cat` when something looks wrong is
// worth more than throughput.

import fs from "node:fs/promises";
import path from "node:path";

export class Queue {
  constructor(file, { log = console } = {}) {
    this.file = file;
    this.log = log;
    this.jobs = new Map();
    this.writing = Promise.resolve();
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8"));
      for (const j of raw.jobs || []) this.jobs.set(j.id, j);
      // Anything left "working" was interrupted by a restart, not finished.
      let revived = 0;
      for (const j of this.jobs.values()) {
        if (j.status === "working") { j.status = "queued"; j.note = "picked up again after a restart"; revived++; }
      }
      if (revived) this.log.warn?.("queue: " + revived + " interrupted job(s) requeued");
    } catch {
      this.log.info?.("queue: starting empty (" + this.file + ")");
    }
  }

  async flush() {
    const body = JSON.stringify({ jobs: [...this.jobs.values()] }, null, 2);
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, body);
    }).catch((e) => this.log.error?.("queue: could not save — " + e.message));
    return this.writing;
  }

  /** Same id twice is the same job: a double-press never makes two contacts. */
  async add(id, payload) {
    const existing = this.jobs.get(id);
    if (existing && existing.status !== "error") return { job: existing, added: false };
    const job = {
      id,
      payload,
      status: "queued",
      attempts: existing ? (existing.attempts || 0) : 0,
      queuedAt: new Date().toISOString(),
      startedAt: null, finishedAt: null, result: null, error: null, note: null
    };
    this.jobs.set(id, job);
    await this.flush();
    return { job, added: true };
  }

  /** The next job that is ready. A job waiting out its backoff is not ready. */
  next(now = Date.now()) {
    for (const j of this.jobs.values()) {
      if (j.status !== "queued") continue;
      if (j.notBefore && new Date(j.notBefore).getTime() > now) continue;
      return j;
    }
    return null;
  }

  async claim(job) {
    job.status = "working";
    job.attempts = (job.attempts || 0) + 1;
    job.startedAt = new Date().toISOString();
    await this.flush();
    return job;
  }

  async finish(job, result) {
    job.status = "done";
    job.result = result;
    job.error = null;
    job.notBefore = null;
    job.finishedAt = new Date().toISOString();
    await this.flush();
  }

  /** 5s, then 10s, then 20s. Whatever broke, retrying instantly won't fix it. */
  static backoffMs(attempts) { return 5000 * Math.pow(2, Math.max(0, attempts - 1)); }

  async fail(job, err, { retry = true } = {}) {
    job.error = String((err && err.message) || err).slice(0, 400);
    job.code = (err && err.code) || "";
    // A duplicate or a malformed contact will fail the same way every time;
    // retrying it just burns the queue.
    const permanent = ["duplicate", "bad_contact", "no_fields"].includes(job.code);
    const again = retry && !permanent && job.attempts < 3;
    job.status = again ? "queued" : "error";
    // Wait before trying again. Without this a failing push spins through its
    // three attempts in milliseconds and hammers REI for no benefit.
    job.notBefore = again ? new Date(Date.now() + Queue.backoffMs(job.attempts)).toISOString() : null;
    job.finishedAt = new Date().toISOString();
    await this.flush();
  }

  get(id) { return this.jobs.get(id) || null; }
  all() { return [...this.jobs.values()].sort((a, b) => (b.queuedAt || "").localeCompare(a.queuedAt || "")); }
  counts() {
    const c = { queued: 0, working: 0, done: 0, error: 0 };
    for (const j of this.jobs.values()) c[j.status] = (c[j.status] || 0) + 1;
    return c;
  }
}
