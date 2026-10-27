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
  → people in the company with the link see the last saved update on any device
```

- **reader/** is a small Go program built on [whatsmeow](https://github.com/tulir/whatsmeow). It links once by QR code, keeps group messages, members, quoted replies, reactions, edits and deletions in `messages.db` next to the exe, and answers four read-only tools for the Claude desktop app: `status`, `list_groups`, `get_group`, `get_messages`. One-to-one chats are never stored. Setup steps for the person running it are in `reader/README.txt`.
- **dashboard/** is the artifact. On the computer running the reader it reads live and saves to the page's storage. Everywhere else it shows the saved copy. Claude reads each new instruction once (through the viewer's own Claude, no API key) to decide who must reply, whether there is a task, its owner and deadline.

## Rules the dashboard uses

- Groups are added from "Groups and names": search the linked phone's groups (sorted by newest group, recent activity or name; newest needs WhatsApp Reader 1.0.2), tick several, then pick each one on the left and tick who gives instructions there. "Use these instruction-givers in every selected group they're in" copies the ticks to the other groups. **Select all N shown** ticks every group the search and filter leave on screen (more than 20 at once asks for a second click). **Hide groups with 0 members** (on by default, remembered on that computer) leaves out groups the phone has left or that were deleted.
- Each tracked group has its own instruction-givers, chosen at setup. Everyone else in that group is tracked. A message to everyone means the team, not the other givers, but when one giver asks another by name or @mention (Juan: "Cherry can you do this?") the one asked is tracked like anyone else. Groups can be added, edited or dropped later from "Groups and names" in the sidebar.
- People are matched by phone number, so someone in two groups has one record. The top of the page switches between all groups and one, and a "From" filter shows only one instruction-giver's messages (for example only the CEO's, or only the COO's).
- A quoted reply or a reaction answers that one message. Any other message answers everything still open for that person before it.
- If a reply was missed (a swipe-reply to a different message, or an answer in the wrong group), the person can react 👍 to the instruction in WhatsApp, or anyone in the company can press **Mark as replied** on the dashboard and pick one of that person's own messages from the 30 minutes after the instruction. It counts from when that message was sent and shows who linked it. Links are kept under `fixes/` in the page's storage, which company members can write; `settings/` and `sync/` stay owner-only.
- **Delete** on a message (owner and editors only, second click confirms) takes that request off the dashboard with its nudges, replies and task; it's kept under `sync/<group>/removed/` and can be restored from the "deleted messages" list.
- **Instructions are read in context.** Claude sees what everyone said in the two hours around a manager's message, and the text of any message it quotes. So Juan's "What is this?" right after Cherry sent something is a question for Cherry, and Vanessa's reply doesn't close it.
- **Questions anyone can answer.** Claude marks each request as needing a reply from everyone, from named people, or from anyone. "Who is tracking this order?" needs one answer: the first answer closes it, and nobody else is counted as behind on it. While nobody has answered it shows as "Waiting for anyone" with the usual reminder flags. A plain message only counts as the answer while the question is still the latest request; a swipe-reply always counts. If the rule picked the wrong message, **Mark as answered** / **Pick a different answer** lets anyone in the company choose the right one.
- **Claude reads the replies too.** Swipe-replies and reactions are certain and count as they are. Every other reply from the last week goes to Claude once, with the requests it could be answering, and Claude says which one it actually answers ("Internet service installed" answers nothing) and whether the sender took on the work ("I'm the one tracking it" becomes a task in their name). Its reason shows under the reply. The readings are saved with the page (`replies` in `sync/<group>/extra/analysis`), so each reply is read once and other computers see the same. Without Claude, or for older replies, the simple rules apply; a failed read is tried again after 5 minutes.
- **Draft reply as Juan** on any message: Claude writes a WhatsApp message the way Juan texts (style taken from the team's "Ask Juan" page, built from his voice notes), using the thread for facts. It is a follow-up to whoever hasn't answered, Juan's answer when someone asked him, or a short next step once everyone has replied. Anything Juan has to decide is left in [brackets]. The person edits it, presses Copy and sends it from their own WhatsApp; nothing is sent or saved by the page. It runs on the Claude account of whoever presses the button.
- **Clear data** (owner and editors only) wipes one group's saved messages, replies, tasks and linked replies, and records a start time in `settings/tracking`; from then on only messages sent after it count, on every device. WhatsApp Reader keeps its own copy, which is why the start time is needed.
- A task counts as done when its owner sends a photo, video or document, or says done/finished/sent/etc.
- Follow-up timing (default 15 / 30 / 60 minutes) only decides when someone is flagged "Needs 1st reminder", "Needs 2nd reminder" or "Escalate to manager". A reply after the escalation point counts as a miss; two or more misses in 30 days is a repeat non-responder.

## Download

`release/whatsapp-reader.exe` is WhatsApp Reader 1.0.2 for Windows, ready to use; setup steps are in `reader/README.txt`. Its SHA-256 is in `release/SHA256SUMS.txt`, and `reader/build.sh` rebuilds the same file byte for byte from `reader/`.

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
node dashboard/test/e2e-refresh.js  # the Refresh button reads a new message right away
node dashboard/test/e2e-newpc.js  # a newly linked reader with less history keeps what the page already saved
node dashboard/test/e2e-clear.js  # Clear data wipes one group and counts only newer messages
node dashboard/test/e2e-delete.js  # deleting one message, the deleted list, and Restore
node dashboard/test/e2e-addmany.js  # searching, ticking several groups, and setting each one up side by side
node dashboard/test/e2e-sort.js  # sorting the group list: newest groups, recent activity, name
node dashboard/test/e2e-draft.js  # Draft reply as Juan: what Claude is asked, Copy, Write another, no Claude
node dashboard/test/e2e-leave.js  # Back to dashboard from Groups to track, with nothing tracked yet (run e2e-addmany.js first)
node dashboard/test/e2e-pickall.js  # Select all shown, the second click over 20, and hiding 0-member groups
node dashboard/test/anyone.test.js  # questions anyone can answer: first answer closes it, nobody else owes it
node dashboard/test/e2e-anyone.js  # the same on the page, plus Mark as answered
node dashboard/test/judge.test.js  # Claude's reading of replies, using its real answers to a sample thread (test/judge-sample.json)
node dashboard/test/context.test.js  # "What is this?" after Cherry sent something is for Cherry, not anyone
node dashboard/test/e2e-judge.js  # the same on the page: read once, saved, shown with the reason, tasks people took on
```

## Why a linked-device reader

Checked against Meta's documentation on 26 Oct 2026. Juan's groups already exist and have more than 8 people.

| Option | Can it read Juan's existing groups? | Why |
|---|---|---|
| WhatsApp Cloud API, Groups API | No | It only works with groups the business creates through the API. Each one is capped at 8 participants, people join by invite link, and the number must be an Official Business Account ([Meta: Groups API](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/)). |
| Cloud API with Coexistence (Business app and API on one number) | No | Only one-to-one chats reach the API. Group chats stay in the app and are listed as not supported on the API ([Meta: onboarding WhatsApp Business app users](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users)). |
| Exporting the chat by hand | Only after someone exports it | Never live, so reply times can't be measured as they happen, and someone has to remember to do it. |
| Linked-device reader (chosen) | Yes, as messages arrive | It links like WhatsApp Web and receives each group message when the phone does. |

**Ban risk.** WhatsApp's [terms of service](https://www.whatsapp.com/legal/terms-of-service) don't allow unofficial or automated access, so the risk isn't zero. Reported bans target bulk or automated sending and modified WhatsApp apps ([Ubergizmo, Nov 2025](https://www.ubergizmo.com/2025/11/whatsapp-bans/), [Fullpress](https://www.fullpress.it/en/whatsapp-suspension-of-some-accounts-here-are-the-reasons/)). The reader sends nothing. Its four tools are marked read-only, and the code makes no call to whatsmeow's send, presence or read-receipt functions:

```
grep -n -i -E "SendMessage|SendPresence|SendChatPresence|MarkRead|CreateGroup" reader/*.go   # no matches
```

## Status

Tested for real from 24 Oct 2026: a phone linked to the reader on Windows, a test group read live through the Claude desktop app, and the saved copy matching WhatsApp. No warnings from WhatsApp on the test number as of 26 Oct. Message saving is covered by `reader/reader_test.go` (3 tests, passing on 26 Oct). Tracking several groups at once has only been tested against the simulated reader so far.
