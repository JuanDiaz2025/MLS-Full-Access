// The queue decides how hard this server leans on REI BlackBook when something
// goes wrong, so the retry rules are worth pinning down.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Queue } from "../src/queue.js";

const tmp = () => path.join(os.tmpdir(), "q-" + Math.random().toString(36).slice(2) + ".json");
const quiet = { info() {}, warn() {}, error() {} };
const lead = { first: "David", last: "Jones" };

test("a job is queued once and comes back as the next one", async () => {
  const q = new Queue(tmp(), { log: quiet });
  const { added } = await q.add("ML1", lead);
  assert.equal(added, true);
  assert.equal(q.next().id, "ML1");
});

test("pressing twice while the first is still going does not queue a second", async () => {
  const q = new Queue(tmp(), { log: quiet });
  await q.add("ML1", lead);
  const again = await q.add("ML1", lead);
  assert.equal(again.added, false, "the same lead must never become two contacts");
});

test("a failure waits before trying again instead of spinning", async () => {
  const q = new Queue(tmp(), { log: quiet });
  const { job } = await q.add("ML1", lead);
  await q.claim(job);
  await q.fail(job, new Error("network"));
  assert.equal(job.status, "queued", "it should try again");
  assert.ok(job.notBefore, "but not immediately");
  assert.equal(q.next(), null, "nothing is ready yet");
  assert.equal(q.next(Date.now() + 6000).id, "ML1", "ready once the wait is over");
});

test("the wait grows: 5s, 10s, 20s", () => {
  assert.equal(Queue.backoffMs(1), 5000);
  assert.equal(Queue.backoffMs(2), 10000);
  assert.equal(Queue.backoffMs(3), 20000);
});

test("it gives up after three attempts", async () => {
  const q = new Queue(tmp(), { log: quiet });
  const { job } = await q.add("ML1", lead);
  for (let i = 0; i < 3; i++) { await q.claim(job); await q.fail(job, new Error("network")); }
  assert.equal(job.status, "error");
  assert.equal(job.attempts, 3);
  assert.equal(q.next(Date.now() + 60000), null, "a given-up job is not retried forever");
});

test("a duplicate is never retried — it will fail the same way every time", async () => {
  const q = new Queue(tmp(), { log: quiet });
  const { job } = await q.add("ML1", lead);
  await q.claim(job);
  await q.fail(job, Object.assign(new Error("duplicate"), { code: "duplicate" }));
  assert.equal(job.status, "error");
  assert.equal(job.attempts, 1, "one attempt is enough to know");
});

test("a contact with no name is not retried either", async () => {
  const q = new Queue(tmp(), { log: quiet });
  const { job } = await q.add("ML1", {});
  await q.claim(job);
  await q.fail(job, Object.assign(new Error("bad"), { code: "bad_contact" }));
  assert.equal(job.status, "error");
});

test("a lead that failed can be pushed again from the board", async () => {
  const q = new Queue(tmp(), { log: quiet });
  const { job } = await q.add("ML1", lead);
  await q.claim(job);
  await q.fail(job, Object.assign(new Error("duplicate"), { code: "duplicate" }));
  const again = await q.add("ML1", lead);
  assert.equal(again.added, true, "pressing the button again must be able to retry a failure");
  assert.equal(again.job.status, "queued");
});

test("a push interrupted by a restart is picked up again, not lost", async () => {
  const file = tmp();
  const q1 = new Queue(file, { log: quiet });
  const { job } = await q1.add("ML1", lead);
  await q1.claim(job);
  assert.equal(job.status, "working");

  const q2 = new Queue(file, { log: quiet });
  await q2.load();
  assert.equal(q2.get("ML1").status, "queued", "a job left mid-flight must be claimable again");
  await fs.unlink(file).catch(() => {});
});

test("a finished push survives a restart and is not redone", async () => {
  const file = tmp();
  const q1 = new Queue(file, { log: quiet });
  const { job } = await q1.add("ML1", lead);
  await q1.claim(job);
  await q1.finish(job, { id: "abc" });

  const q2 = new Queue(file, { log: quiet });
  await q2.load();
  assert.equal(q2.get("ML1").status, "done");
  assert.equal(q2.get("ML1").result.id, "abc");
  assert.equal(q2.next(), null, "a done push must never be sent to REI a second time");
  await fs.unlink(file).catch(() => {});
});

test("counts report what the status page shows", async () => {
  const q = new Queue(tmp(), { log: quiet });
  await q.add("a", lead); await q.add("b", lead);
  const { job } = await q.add("c", lead);
  await q.claim(job); await q.finish(job, {});
  const c = q.counts();
  assert.equal(c.queued, 2);
  assert.equal(c.done, 1);
});
