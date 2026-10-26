# WhatsApp AI Accountability

Tracks who replies to instructions posted in one or more team WhatsApp groups, how long they take, who owns which task, and who keeps not responding. It only reads. Nothing in it sends a message, a reaction, a read receipt or a reminder.

Dashboard: https://claude.ai/artifact/4NXd6hMvf29C9NHX6gv9ig

## How the pieces fit

```
WhatsApp group
  → a phone in the group, linked like WhatsApp Web
  → reader/ (whatsapp-reader.exe on one Windows computer, saves group messages locally)
  → Claude desktop app on that computer (runs the reader, lets the page call it)
  → dashboard/ (the artifact: reads the reader, saves each update into the page)
  → anyone with the link sees the last saved update on any device
```

- **reader/** is a small Go program built on [whatsmeow](https://github.com/tulir/whatsmeow). It links once by QR code, keeps group messages, members, quoted replies, reactions, edits and deletions in `messages.db` next to the exe, and answers four read-only tools for the Claude desktop app: `status`, `list_groups`, `get_group`, `get_messages`. One-to-one chats are never stored. Setup steps for the person running it are in `reader/README.txt`.
- **dashboard/** is the artifact. On the computer running the reader it reads live and saves to the page's storage. Everywhere else it shows the saved copy. Claude reads each new instruction once (through the viewer's own Claude, no API key) to decide who must reply, whether there is a task, its owner and deadline.

## Rules the dashboard uses

- Each tracked group has its own instruction-givers, chosen at setup. Everyone else in that group is tracked. A message to everyone means the team, not the other givers, but when one giver asks another by name or @mention (Juan: "Cherry can you do this?") the one asked is tracked like anyone else. Groups can be added, edited or dropped later from "Groups and names" in the sidebar.
- People are matched by phone number, so someone in two groups has one record. The top of the page switches between all groups and one, and a "From" filter shows only one instruction-giver's messages (for example only the CEO's, or only the COO's).
- A quoted reply or a reaction answers that one message. Any other message answers everything still open for that person before it.
- If a reply was missed (a swipe-reply to a different message, or an answer in the wrong group), the person can react 👍 to the instruction in WhatsApp, or anyone in the company can press **Mark as replied** on the dashboard and pick one of that person's own messages from the 30 minutes after the instruction. It counts from when that message was sent and shows who linked it. Links are kept under `fixes/` in the page's storage, which company members can write; `settings/` and `sync/` stay owner-only.
- A task counts as done when its owner sends a photo, video or document, or says done/finished/sent/etc.
- Follow-up timing (default 15 / 30 / 60 minutes) only decides when someone is flagged "Needs 1st reminder", "Needs 2nd reminder" or "Escalate to manager". A reply after the escalation point counts as a miss; two or more misses in 30 days is a repeat non-responder.

## Building

```sh
# reader: runs the tests, then builds dist/whatsapp-reader.exe
reader/build.sh

# dashboard: assembles whatsapp-accountability.html from page.src.html, model.js, live.js and app.js
python3 dashboard/build.py

# dashboard end-to-end checks against a simulated reader, Claude and storage (need Playwright)
node dashboard/test/e2e.js        # one group, from setup to a second device
node dashboard/test/e2e-multi.js  # two groups, filters, edits, and moving an older single-group copy
node dashboard/test/givers.test.js  # instruction-givers asking each other (no browser needed)
node dashboard/test/e2e-link.js   # linking a missed reply from another computer, and removing it
```

## Status

Tested for real: a phone linked to the reader on Windows, a test group read live through the Claude desktop app, and the saved copy matching WhatsApp. Message saving is covered by `reader/reader_test.go`. Tracking several groups at once has only been tested against the simulated reader so far.

WhatsApp's terms don't allow third-party linked devices, even read-only ones. The risk is low because nothing is sent, but it isn't zero.
