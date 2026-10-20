# FlipScout server

The always-on half of the FlipScout Lead Board.

A published Artifact can only call the viewer's own connectors, so the board can
record that somebody pressed **⬆ Push to REI** but cannot carry it out. This
service carries it out: one press, one contact in REI BlackBook, in well under a
second once the session is warm.

## What it does

| Route | | |
|---|---|---|
| `POST /push` | one lead → one REI contact | needs the token |
| `GET /job/:id` | how that push went | needs the token |
| `GET /` | status page, in the board's colours | needs the token |
| `GET /health` | is the REI session still good | open |

`POST /push` is idempotent on the lead's MLS #, so a double-press never makes
two contacts.

```bash
curl -X POST https://your-server/push \
  -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"ML82065000","contact":{
        "first":"David","last":"Jones",
        "email":"david.b.jones@example.com","phone":"(916) 245-0729",
        "street":"1427 76th Avenue","city":"Oakland","state":"CA","zip":"94621"}}'
```

## How it talks to REI BlackBook

REI has no public API. Everything here is a call its own web app makes, observed
once from a real signed-in session:

```
POST /profitdial/contacts/getNewContact        -> the blank form's fields
POST /profitdial/contacts/queryDuplicateEmails -> REI's own duplicate check
POST /profitdial/contacts/queryDuplicatePhones
POST /profitdial/profiles/saveProfileFieldValues/<profileId>   -> the save
```

The save body is not `{firstName, email}`. REI echoes back the **whole field
descriptor** for every field on the form — type, key, label, icon, `field_id`,
`display_type` — with typed values nested under `[value]`, as multipart. So the
server does not hardcode that structure: it asks `getNewContact` for a blank
contact and fills the blanks in. If REI renames a field or changes an id, this
keeps working.

Authentication is a session cookie, saved to `REI_STATE_PATH` so a restart does
not force a fresh login.

## What is verified, and what is not

Being straight about this, because it decides where to look when it breaks:

- **Verified.** The save endpoint, the multipart shape, the name (`65453`) and
  email (`65454`) field ids, the duplicate-check calls, and that a contact
  created this way lands correctly — one was created on 20 Oct 2026.
- **Built from REI's own field list rather than observed.** The exact `[value]`
  sub-keys for phone and address. The capture was truncated before them, so the
  server reads them from `getNewContact` instead of guessing. Run once with
  `dryRun` against the real account to confirm before trusting it in volume.
- **Not verified at all.** `src/rei/relogin.js`. Cold login plus an emailed
  verification code has never completed on a server. Expect to watch the first
  one. Until it works, a dead session needs `REI_STATE_PATH` refreshed by hand.

`REI_PROFILE_ID` (5289) is account-specific.

## Running it

```bash
cp .env.example .env     # fill it in — never commit it
npm install
npm start
```

Re-login needs a browser, which is an optional extra:

```bash
npm i playwright && npx playwright install chromium
```

Without it the server still pushes contacts on a restored session; it just
cannot recover by itself when that session expires, and says so plainly.

### Where to run it

A small always-on box — a VPS or a machine in the office. REI wants a
long-lived session from a stable address, which is the opposite of what
scale-to-zero hosting gives you. Keep `data/` on a persistent volume: it holds
the session cookie and the queue.

## Security

This service creates records in a live CRM.

- `API_TOKEN` is the only thing standing in front of it. Make it long and random.
- Put it behind HTTPS. The token and the contacts both cross the wire.
- `REI_PASS` and `MAIL_PASS` belong in the host's secret store, not in the repo.
- `data/rei-session.json` is a live credential. It is written `0600`; back it up
  the way you would a password.

## Still to build

- The scan, on a schedule — it lives outside this repo today.
- An MCP interface, so the board calls this server directly instead of through a
  tab. That is what makes the button instant in-page.
