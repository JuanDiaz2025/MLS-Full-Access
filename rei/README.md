# REI BlackBook automation

REI has no public API, so everything here drives the real web UI with Playwright
(headless Chromium at `/opt/pw-browsers/chromium`). Auth is a signed-in browser
profile at `rei/profile/` — that folder is a live session cookie and is
gitignored. On an unrecognised login REI emails a code, so the profile has to be
signed in by hand once.

Every script takes absolute paths and prints one JSON line.

| | |
|---|---|
| `push-quick.js <lead.json>` | Creates the listing agent as a contact, in three stages. |
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
