# Twin Network

Formerly **FlipScout**. Renamed 20 Oct 2026. The lowercase directory names
(`flipscout-board/`, `flipscout-server/`, `/opt/flipscout`) are paths and
service names and were deliberately left alone; everything a person reads says
Twin Network.

Strapline: *Connect the agent. Close the deal.*
How it works: *Find deals on the MLS, catch coming-soon listings early, run the
comps, and connect with the listing agent. Nothing gets missed.*

## The pieces

| | |
|---|---|
| **Lead Board** | A published Artifact: https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1 — the live board the team works. Source is NOT in this repo; it is the artifact itself. |
| `flipscout-board/apps-script/` | The Google Apps Script bridges the board calls — pass, alerts, outreach, Instantly, videos, and REI. |
| `flipscout-server/` | An always-on service that creates REI BlackBook contacts. Written and tested; **nowhere to run it yet**. |
| **The scan app** | **A Windows .exe, not a repository.** `FlipScout-1.31.0-portable.exe` (78 MB) lives in the Drive folder now called *Twin Network*; an older `FlipScout-1.2.0.exe` is in *Twin Network App*. It runs on somebody's machine and writes the Leads tab. The two GitHub repos named after it — `Flip-Scout-Agent` and `Juan-s-Autonomous-Real-Estate-Flip-Scout-Agent` — are **empty shells**: README and .gitignore only. Checked 20 Oct. So its source is nowhere we can reach, which is why the scan rules below cannot be changed from here. |
| The prod sheet | `1DAZ_FrU_I8Yh2cKpa10U05EueLl7ctrBlVi6eFErXGQ`, tab `Leads`, 27 columns. Titled **Twin Network — Leads**. Everything references it by id, never by name, so renaming it is safe. |

## The open problem: the scan grades houses it has not looked at

Bryan's standing complaint, and it is correct: **nice, already-renovated houses
keep reaching the team as A/B leads.** 1402 Darwin Ct, San Jose (ML82065063) is
the example he cites — fully renovated and staged, graded B on the single word
"vacant".

Audited against a fresh pull on 20 Oct (`scripts/scan-audit.py`, re-runnable).
Of **1,125 live A/B leads**:

- **377 (34%)** were graded with a check the scan itself says it skipped:
  `scored on refresh` ×308, `photo check off` ×53, `judged by eye` ×16.
- **326 (29%)** carry **no condition evidence at all** — nothing in Why, Notes
  or the remarks says anyone assessed the state of the house.
- **20** have the single word `vacant` as the entire case.

### Why it happens

The scan scores on **proxies for motivation, not condition**: `vacant`,
`original / long-held — "first time on the market"`, `price cut 21%`,
`built 1946`, `28 days on market`. Stack three and it reaches 65–75 and calls
it A. None of them mean the house needs work — a vacant, long-held, 1946 house
with a price cut is very often beautifully remodelled.

Do **not** propose a $/sqft gate as the fix. It was tried and disproved:
Darwin Ct looks expensive only because it is small (872 sqft); size-matched it
is 99% of its area's median, and a 1.10× rule would silence 26% of genuine
fixers.

### The fix, in order of effect

1. **Run the checks on the refresh path** — 308 leads, 27% of live A/B, were
   scored by a path that skips $/sqft and photos entirely. Biggest hole.
2. **Require condition evidence for A/B.** Vacancy, age, price cuts and DOM may
   raise a score but must never carry one alone. No condition signal → C, or
   hold for photos.
3. **Photos: look at every one.** Bryan is explicit — scroll the whole gallery
   and judge each image, not the first shot or the remarks. The 53 with the
   photo check off are the obvious start.

The scan app is not in this repo, so this cannot be fixed from here. Ask for
its repo before promising otherwise.

## Things already established — do not re-derive

- **REI BlackBook** has no public API. Contacts are created with
  `POST /profitdial/profiles/saveProfileFieldValues/5289`, multipart, echoing
  back every field descriptor with values under `[value]`. Build the body from
  `POST /profitdial/contacts/getNewContact` rather than hardcoding ids.
  Auth is a session cookie; REI emails a code on an unrecognised login.
  **Phone Type is required and is always "Mobile"** (Bryan's rule).
  The working scripts are in `rei/` — `rei/README.md` has the gotchas. Read it
  before touching REI; it is all hard-won and none of it is guessable.
- **Texting works**, through the contact's **Chat** tab, from any of the ~142
  ProfitDial numbers (`rei/sendtext.js`). The From picker is a react-select —
  wait for the option itself to render or the old number stays selected. The
  reply box is **TinyMCE in a `srcdoc` iframe**, invisible to `querySelector`.
  Proof a text went out: the bubble's `Processing…` clears and the line reads
  `PD #: … · Sent to: … · <time>`. Tested 21 Oct from `Realtor (510) 800-1607`.
- Replies arrive in **ProfitDial → Inbox → Texts**, one page for the whole
  account, with a **PD Number** column saying which line each came in on
  (`rei/replies.js`). That table prints the ACCOUNT's wall clock, not UTC.
  Do not drive a watch off `/profitdial/indicators/get`: its unread counts
  drop the moment a person opens the inbox in a browser.
- The board's **Email & SMS Log** screen (`#messages`) was built 21 Oct —
  `scripts/patch-board-msglog.py` holds the exact patch. It only READS what
  the board already stores: the `agents` log, the Instantly rows, board-sent
  emails. Texts reach it by writing `agents/<id>.log` (`rei/logtoboard.js`),
  which needs no republish. `Analytics` and `Reports` in the nav are still
  stubs (`class="soon"`).
- A published Artifact can only reach the **viewer's connectors** — no
  arbitrary fetch. That is why the board pushes through Google Drive
  (folder `13PbzvxhyIZDrBayETV3ymNXUQQik_sFr`) and Apps Script picks it up.
- The sheet has **no Property Type column**, and its `Status` column is dead
  (reads `Needs Comps` on every row).
- Redfin photo URLs **cannot** be derived from an MLS #; only 2 of 18 tried
  returned 200. A real listing URL is needed.
- The board's sign-in gate is **off** (`GATE_ON = false` in the artifact). It is
  switched off, not deleted — flip it back and every account still works.

## Working agreements

- Bryan wants automation with **no human step** beyond one-time setup, and
  dislikes long replies. Lead with what changed, then the caveat.
- Never claim something is running when it is not. The board checks what is
  actually connected before promising a contact will be created.
- Credentials in this repo: none, ever. `.env`, `data/`, session cookies and
  `.claude/settings.local.json` are gitignored.
