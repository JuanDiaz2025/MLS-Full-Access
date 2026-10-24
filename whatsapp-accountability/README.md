# WhatsApp AI Accountability

Tracks who replies to instructions posted in a team WhatsApp group, how long they take, who owns which task, and who keeps not responding. It only reads. Nothing in it sends a message, a reaction, a read receipt or a reminder.

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

- Instructions are messages from the people chosen at setup. Everyone else in the group is tracked.
- A quoted reply or a reaction answers that one message. Any other message answers everything still open for that person before it.
- A task counts as done when its owner sends a photo, video or document, or says done/finished/sent/etc.
- Follow-up timing (default 15 / 30 / 60 minutes) only decides when someone is flagged "Needs 1st reminder", "Needs 2nd reminder" or "Escalate to manager". A reply after the escalation point counts as a miss; two or more misses in 30 days is a repeat non-responder.

## Building

```sh
# reader: runs the tests, then builds dist/whatsapp-reader.exe
reader/build.sh

# dashboard: assembles whatsapp-accountability.html from page.src.html, model.js, live.js and app.js
python3 dashboard/build.py

# dashboard end-to-end check against a simulated reader, Claude and storage (needs Playwright)
node dashboard/test/e2e.js
```

## Status

Tested here: the reader reaches WhatsApp and produces a link code that scans; the Claude app sees exactly the four read-only tools; message saving is covered by `reader/reader_test.go`; the dashboard passes the simulated end-to-end run. Not yet tested: linking a real phone, a real group, and the Claude desktop app talking to the reader on Windows.

WhatsApp's terms don't allow third-party linked devices, even read-only ones. The risk is low because nothing is sent, but it isn't zero.
