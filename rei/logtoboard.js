// Write a text/email touch into the Lead Board's agent log.
//
// The board already has this log. Every agent card carries one
// ("＋ Log a call, text or meeting") and a History timeline that merges it with
// Instantly emails, visits, stage changes and notes, and drives "Last
// contacted" and the hot/warm/cold badge. Until now the text side was typed in
// by hand; email arrives on its own from Instantly.
//
// So nothing on the page needs changing — this only writes the documents the
// page already reads. No republish, no new UI.
//
// Shape, from the board's own reader (agDoc):
//   agents/<id> = {name, log: {<entryId>: {k, t, by, at, del?}}}
//   k is one of call | text | email | met | other — any other k is ignored.
//
// <id> is "e-<slug of email>", "p-<digits of phone>" or "n-<slug of name>".
// agDoc walks EVERY id an agent has gone by, so a doc keyed by phone shows up
// on the card even when the agent's canonical id is the email one. That is what
// makes this writable from here: a reply gives us a phone number, not an email.
//
// This prints the document it would write; pass --write to actually write it.
const { execFileSync } = require("child_process");
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const digits = (s) => String(s || "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const phone = arg("--phone", ""), email = arg("--email", ""), name = arg("--name", "");
const kind = arg("--kind", "text"), text = arg("--text", ""), by = arg("--by", "Twin Network");
const at = arg("--at", new Date().toISOString());

if (!["call", "text", "email", "met", "other"].includes(kind)) {
  console.error("--kind must be call|text|email|met|other (the board ignores anything else)"); process.exit(1);
}
const id = email ? "e-" + slug(email) : phone ? "p-" + digits(phone) : name ? "n-" + slug(name) : "";
if (!id) { console.error("need --phone, --email or --name"); process.exit(1); }

// one entry id per event, so re-running the same event cannot double-log it
const entry = kind + "-" + at.replace(/[^0-9]/g, "").slice(0, 14);
const doc = { name: name || undefined, log: { [entry]: { k: kind, t: text.slice(0, 300), by, at } } };
console.log(JSON.stringify({ collection: "agents", doc_id: id, entry, data: doc }, null, 2));
if (!process.argv.includes("--write")) { console.log("\n(dry run — pass --write to send it)"); }
