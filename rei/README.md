# REI BlackBook automation

REI has no public API, so everything here drives the real web UI with Playwright
(headless Chromium at `/opt/pw-browsers/chromium`). Auth is a signed-in browser
profile at `rei/profile/` — that folder is a live session cookie and is
gitignored. On an unrecognised login REI emails a code, so the profile has to be
signed in by hand once.

Every script takes absolute paths and prints one JSON line. Set `REI_PROFILE`
to point at the signed-in profile if it is not `rei/profile` — a script run
against an empty profile lands on the login page, which looks exactly like REI
having signed us out. Check which it is before reporting a sign-out.

| | |
|---|---|
| `push-quick.js <lead.json>` | Creates the listing agent as a contact, in three stages. |
| `outreach.js <contactId> "<From label>" "<sender>"` | Sends the agent-outreach text, filling the blanks from the contact's own record. `--dry` captures and prints without sending. |
| `sendtext.js <contactId> "<From label>" "<message>"` | Texts a contact through a named ProfitDial number. |
| `alive.js <contactId>` | Read-only: are we still signed in, and does that contact still exist? |
| `findby.js <term>` | Read-only: search contacts. |

## push-quick.js — creating a contact

Three stages, ~37-72s in total:

1. **name + phone + email → Save.** Prints `CALLABLE` in 12-24s; the contact
   exists in REI before the rest runs.
2. **Enrich:** tags `Agent/Realtor` + `Twin Network`, opt in phone and email.
3. **Property Address** (street, city, state, zip) on the contact panel.

Stage 3 is deliberately **Property Address, not Mailing Address**: the contact is
the *listing agent*, so the lead's address is the house being sold, not where
they live.

Every field is cleared (select-all + Delete) before typing, so running it twice
repairs rather than duplicates. Before re-running on an older contact, check it
still exists with `alive.js` — a second run against a deleted contact reports
everything false after ~140s, which means nothing.

**Known flake:** on a brand-new contact the State dropdown often does not take.
The result then carries `steps.stateMissed` and the address reads back without
the state. One more run fills it.

A save whose phone is already on file is refused with HTTP 400
`{"success":false,"contact_phone1":"Phone already exists|<id>"}`. That is not an
error — the script reads the id out of it and carries on with the existing
contact. Never create a second one.

The lead **Notes and Category are still not written into REI.**

## sendtext.js — texting a contact

```
node rei/sendtext.js 20585230 "Realtor" "Message body"
```

The texting UI is the contact page's **Chat** tab. Two things there are not
obvious:

- The **From:** control at the bottom of the composer is a react-select listing
  ~142 ProfitDial numbers. Type to filter, then wait for the option *itself* to
  render before clicking — reading the list too early silently leaves the old
  number selected. Match on the label, e.g. `Realtor` → `Realtor (510) 800-1607`.
- The reply box is **TinyMCE inside a `srcdoc` iframe**, so it has no
  placeholder, name or id in the page document and `querySelector` will not find
  it. Locate the srcdoc iframe by its box and click into it.

Send is the button with `aria-label="Send Text"`. The bubble first shows
`Processing…`; once that clears the thread line reads
`PD #: <from> · Sent to: <to> · <time>`, which is the proof it went out.

Verified 21 Oct 2026: contact 20585230 (TEST), from `Realtor (510) 800-1607`.

## outreach.js — the agent-outreach text

Fills the template from the contact's own record, so nobody retypes a name or
an address:

> Hi **[first name]**, **[sender]** with Twin Home Buyer. We're interested in
> **[property address]**. When are you reviewing offers? We have 120 Google
> reviews. We're also looking to build long-term relationships with local
> agents. Can I ask you a couple quick questions about the property?

The address is trimmed to **street + city** — the stored value carries the zip
and `, UNITED STATES`, which read as noise in an SMS (and the zip is sometimes
wrong: the TEST record holds `9470`). ~270 characters, so it bills as two
segments.

Run `--dry` first on anything that matters: it prints what it captured and the
exact message without sending, which turns a bad capture into a line of output
rather than a text to a real agent.

Capturing from the About panel has its own trap: walking up from the
`Contacts (N)` heading only reaches the caption/value list once that panel has
been opened for editing. Reading the page's text from that heading onward works
in both states.

## replies.js — detecting a response

```
node rei/replies.js [--line "Realtor"] [--since <ISO>] [--state <file>]
```

Reads **ProfitDial → Inbox → Texts**, which is one page for the whole account
and carries a **PD Number** column — the line the reply came in on. That is what
separates agent-outreach replies on `Realtor` from PPC, TV and postcard traffic,
without opening a single contact.

`--state` stores the newest Received timestamp and reports only rows newer than
it next run, so nothing is counted twice.

**Do not trigger off the unread badge.** `/profitdial/indicators/get` returns
`{"text":13,"call":35,…}` in one request and is tempting, but that count drops
as soon as a person opens the inbox in a browser — a reply someone glanced at
is a reply the counter forgets. The high-water mark does not forget.

Two limits worth stating before anyone builds a number on it:

- **The Outbox is not our sent side.** `/profitdial/outbox/text` holds scheduled
  and broadcast texts only; one-off sends from the Chat tab never appear there.
  The sent side has to be logged by whatever does the sending.
- **REI shows no delivery receipt.** The bubble goes `Processing…` → sent, and
  that is all. This measures *replied*, never *delivered*.

Rows are `<tr>` whose first cell is an empty checkbox, so anchor on the cell
that matches the date rather than on column 0. The table prints no year —
a parsed date more than a day in the future belongs to last year.

## logtoboard.js — the email & SMS log on the Lead Board

The log already exists on the board; it was never missing. Every agent card has
`＋ Log a call, text or meeting`, and a **History** timeline that merges those
entries with Instantly emails, visits, stage changes and notes. That log is what
drives **Last contacted** and the hot / warm / cold badge. Email feeds itself
from Instantly (sheet tab `Agent Emails`). Texts were the hand-typed part.

So nothing on the page has to change. Writing the documents the page already
reads is enough — **no republish, no new UI**:

```
agents/<id> = { name, log: { <entryId>: { k, t, by, at, del? } } }
k ∈ call | text | email | met | other      (any other k is ignored by the board)
<id> = "e-<slug(email)>" | "p-<digits(phone)>" | "n-<slug(name)>"
```

The board's own reader (`agDoc`) walks **every id an agent has gone by**, so a
document keyed by phone appears on the card even when that agent's canonical id
is the email one. That is what makes this writable from outside the page: an
inbound reply hands us a phone number, never an email.

The entry id is derived from kind + timestamp, so replaying the same event
cannot double-log it — which matters once this feeds a KPI.

`logtoboard.js` prints the document and writes nothing unless given `--write`.
Verified end to end on 21 Oct: written, read back, removed again.
