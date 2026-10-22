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
| `outreach.js <contactId> "<From label>" "<sender>" --dom <days>` | Sends the agent-outreach text, filling the blanks from the contact's own record. `--dry` captures and prints without sending. |
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

### The opening question depends on the listing's age

From the Realtor Outreach Guide, and the reason `--dom` is **required**:

| Listing | Question |
|---|---|
| 0-7 days | *When are you reviewing offers?* |
| 8+ days, price cut, or back on market | *Is it still available?* |

Asking "is it still available?" about a house that went up on Tuesday tells the
agent we did not look. So the script will not guess: with no `--dom` (or
`--cut` / `--bom`) it refuses to send and prints both versions instead.

`--text 1|2|3|4` picks one of the guide's four texts. **Text 3 is the control**;
1, 2 and 4 each add exactly one sentence to it, so a test can tell which
sentence moved the number. Each carries a precondition the script cannot check
and therefore prints: Text 1 needs the review count re-confirmed, Text 2 needs
a proof-of-funds letter ready today, Text 4 needs real condition evidence.
The default is Text 1, which is what has been going out.

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

## kpi.js — the outreach numbers

```
node rei/kpi.js --replies <replies.js output> [--line "Realtor"] [--days 30]
                [--sent sent.jsonl] [--board <dir of agents/*.json>]
```

Reports: contacts texted, texts sent, contacts that replied, **reply rate**,
median hours to first reply, how many are still awaiting one, and
`repliesNotMatchedToASend`.

Four decisions behind those numbers, so nobody reads them wrong:

- **Reply rate is per contact, not per message.** Texting one agent four times
  and getting one answer is one conversation that replied, not 25%.
- **A reply only counts if it arrived after our first text to that number.**
  An inbound text that predates our outreach is someone else's conversation.
- **`repliesNotMatchedToASend` is not noise** — it is replies on a line we have
  no logged send for. Today that is Barton Smith on the Realtor line: either he
  was texted from somebody's own phone, or the send predates this logging.
  A number that climbs means outreach is happening outside the system, and the
  reply rate is flattering itself.
- **`--board` folds in what the team logged by hand**, so the figure describes
  the business rather than only what this machine did.

Verified 21 Oct on a real round trip: sent 1:24 PM, outreach 1:45 PM, reply
1:54 PM → 1 contact, 2 sent, replied, 0.5 h to first reply.

`sent.jsonl` is gitignored: it grows, it holds agents' phone numbers, and the
container it lives in is reclaimed. Its durable home is the board's agent log.

## replywatch.js — catching a reply without being asked

```
node rei/replywatch.js --state <file> [--line "Realtor"] [--days 14]
```

Prints `{newReplies, writes, alert, advanceTo}` and **writes nothing itself** —
the board's database is reached with the Artifact tools, not from node, so this
stays a pure read and is safe to run at any time.

The caller does three things in order, and the order is the point:

1. apply `writes` to `agents/<id>.log` — the reply lands on the agent card and
   on the Email & SMS Log screen;
2. send `alert` to a person;
3. **only then** save `advanceTo` to the state file.

Advancing the mark first would lose the reply if either step failed. A reply
reported twice is a nuisance; a reply dropped is a lost deal.

A reply from a number that matches no agent on the board is still written,
keyed by phone. `agDoc` walks every id an agent has gone by, so the entry
attaches itself the day that agent's listing reaches the board — inert rather
than lost.

**The limit worth stating out loud:** this runs only while a session with the
REI login is alive. The signed-in browser profile lives in a container that is
reclaimed, so there is no unattended alerting until that login lives somewhere
that persists.

## thread.js — the conversation, before you answer it

```
node rei/thread.js <contactId> [--json]
```

Read-only. Prints the whole SMS exchange in order with direction, taken from
REI's own wording (`Sent to:` is ours, `Received from:` is theirs) rather than
from guessing by position.

Any reply has to be written against this, not against the one line the inbox
feed hands you. The first time it was run in anger it showed exactly why:
Michelle Loeza's "Please text me." at 2:58 PM had **already been answered by
Gen at 3:00 PM**, by phone and then a long text. An auto-reply firing off the
inbox feed alone would have talked over a colleague two minutes behind her.

Scope the text to the conversation before parsing — the left rail and right
panels share the page's innerText, and without that the first message comes
back with "Cold Primary Details (925) …" glued to the front.

## autoreply.json — which threads may be answered without a person

`replywatch.js` reads this file and tags each new reply as eligible or not.
It only *reports* eligibility; the caller decides and sends.

**It fails closed.** A missing file, or one that will not parse, means nothing
is eligible — verified both ways. A typo in an allowlist must never be what
starts a machine talking to real agents.

Turned on 21 Oct with exactly one entry: Bryan's own TEST line, so the thing
could be proven somewhere harmless first. Barton Smith and Michelle Loeza are
deliberately absent.

Before any auto-reply goes out:

- read the whole thread (`thread.js`), never the one line from the inbox feed;
- if a human answered within 30 minutes, stay quiet and say so — Gen answered
  Michelle two minutes after the alert, and a bot would have talked over her;
- never state a price, an offer figure, or a commitment. If the right answer
  needs a number, say a person will follow up and flag it.

Adding a real agent to `allow` is a decision about letting software speak for
the business, one contact at a time. There is no wildcard, and there should
not be one.
