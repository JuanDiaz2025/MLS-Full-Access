# Gmail reply reminders

When Juan emails people on the team and they haven't replied, this reminds them **inside that same email thread**, so the nudge sits right under Juan's email:

- **Juan emailed one person:** that person gets a private reminder in the thread. Nobody else sees it.
- **Juan emailed several people, or CC'd anyone:** one reminder in the thread, addressed to **everyone who still hasn't replied**, together. People who already replied are left off. Juan isn't copied.

> **Re: Fence quote**
>
> Hi Cherry, Kristine and Leo,
>
> Juan Diaz is still waiting for a reply from each of you on this email (sent 4 hours ago). Please reply in this thread.
>
> This is reminder 1 of 3. It was sent automatically and doesn't include what the email says.

The reminder shows the email's subject ("Re: ...") because Gmail only keeps a message in a thread when the subject matches. Its text never says what the email says. **Replying to the reminder goes to Juan**, in the same thread, and counts as the person's reply.

It's a Google Apps Script that checks every few minutes (5 by default) on Google's servers. It doesn't use Claude or WhatsApp, and it costs nothing.

Each check also writes a log to a Google Sheet (**Reply reminders log**) that the WhatsApp Accountability dashboard's **Email** tab reads: see [The email log](#the-email-log-for-the-dashboard) below.

## What it can see

A Google Workspace admin gives a service account permission to read **email headers only** (the `gmail.metadata` scope): who sent an email, to whom, when, the subject and the message id. It can't open bodies or attachments. Juan installs nothing. The script only reads the mailboxes listed in `WATCH`.

The reminders are sent from the account that runs the script, using that account's own permission to send email (`gmail.send`). The service account can only read headers; it never sends.

The permission is company-wide: the key can read the headers of any mailbox at twinhomebuyer.com, even though the script only reads Juan's. Keep the script project and its key private, because anyone who can edit the script can read the key.

The log sheet holds the same header data: subjects, who was emailed, and when they replied. It never holds what an email says. Share it only with people who should see it.

Reading Juan's email headers falls under the same sign-off as the WhatsApp tracker (Greg's written OK, and counsel). Juan should know it's running.

## The rules

- Only emails **Juan started** count. His replies in threads someone else started are usually answers ("Thanks!"), and from headers alone they can't be told apart. To count them too, set `ONLY_THREADS_STARTED: false`.
- People in **To and CC** at **@twinhomebuyer.com** owe a reply. Outside addresses and anything in `IGNORE` (group lists like team@) don't. An email counts as a group email when it went to more than one person on the team.
- Someone has replied when they write in the same email thread after Juan. A reply in a new thread, a call or a WhatsApp message doesn't count. For emails like that, Juan can add a **No reply needed** label in his Gmail and the email is skipped.
- Subjects starting with **FYI** are skipped.
- Reminders go out after **4 hours, 1 day and 2 days** (`REMIND_AFTER_MINUTES: [240, 1440, 2880]`), then stop. Each one is sent once, in the email's own thread, so someone waiting on three emails gets a reminder in each of the three.
- It checks every **5 minutes** (`CHECK_EVERY_MINUTES`: 1, 5, 10, 15 or 30), so a reminder goes out within that long of being due.
- Everyone gets the reminder **as soon as it's due, wherever they are**, day or night. Quiet hours are off (`QUIET_FROM_HOUR` and `QUIET_TO_HOUR` both 0). Setting them to, for example, 20 and 8 holds reminders between 8 PM and 8 AM in each person's time zone.
- Quiet hours, when on, use each person's time zone: Manila unless they're listed in `PEOPLE_TIME_ZONES` (Bryan is set to California). In a group email, someone whose night it is gets left off that reminder until their morning.
- Emails older than **7 days** are left alone.

All of these are at the top of `Code.gs` under `CONFIG`.

**Current settings (testing):** `WATCH` is Seth's own address, reminders after **1, 5 and 10 minutes**, checking **every minute**, and `DRY_RUN: false`, so test reminders are really sent. To test, email a teammate from Seth's account (the watched person never owes himself a reply, so an email to yourself gets no reminder). Because the script also runs as Seth, the reminder shows up in that same thread in Seth's Gmail as well as the teammate's. Before using it for Juan, change `WATCH` to his address and `REMIND_AFTER_MINUTES` to the real waits, then run **installTrigger** again if `CHECK_EVERY_MINUTES` changed.

## Setup

Done once, in about 20 minutes. It needs a **super admin** of the twinhomebuyer.com Google Workspace for part B, and the **sender account** for parts A and C. The sender is the account the reminders come from: a new account such as reminders@twinhomebuyer.com is best, or an existing one.

### A. Google Cloud: the service account

1. Go to [console.cloud.google.com](https://console.cloud.google.com), open the project list at the top, and create a project called **Reply reminders**.
2. **APIs & Services → Library**, search for **Gmail API**, and press **Enable**.
3. **IAM & Admin → Service accounts → Create service account**. Name it **reply-reminders**, then press **Done**. It needs no roles.
4. Open it. Copy its **Unique ID**, the long number, for part B.
5. **Keys → Add key → Create new key → JSON**. A file downloads. It's the key, so don't email it or put it in a shared folder.

   If Google says key creation is disabled, an admin opens **IAM & Admin → Organization policies → Disable service account key creation**, presses **Manage policy**, chooses **Override parent's policy**, sets it to **Not enforced**, and saves. Then repeat step 5.

### B. Admin console: allow headers only

6. Go to [admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls → Manage domain-wide delegation → Add new**.
7. **Client ID:** the Unique ID from step 4. **OAuth scopes:** exactly this, nothing else:
   ```
   https://www.googleapis.com/auth/gmail.metadata
   ```
   Press **Authorize**.

### C. Apps Script: the reminders

8. Signed in as the sender account, go to [script.google.com](https://script.google.com) → **New project**, and name it **Reply reminders**.
9. Replace everything in `Code.gs` with this folder's `Code.gs`. In **Project Settings**, tick **Show "appsscript.json" manifest file in editor**, then replace that file with this folder's `appsscript.json`. Save.
10. In the editor's left panel, press **+** next to **Services**, pick **Gmail API**, and press **Add**. This switches the Gmail API on for the script itself; without it every reminder fails with "Gmail API has not been used in project … or it is disabled". (The `appsscript.json` above already lists it, so it may already show under Services.)
11. **Project Settings → Script properties → Add script property.** Property: `SA_KEY`. Value: the **whole contents** of the JSON key file from step 5. Save, then delete the downloaded file.
12. In the editor, pick **checkSetup** and press **Run**. Allow the permissions it asks for, including **Send email on your behalf** (that's how the reminders go into the threads). The log should say something like `juan@twinhomebuyer.com: 23 threads with sent mail in the last 7 days, 2 replies still owed by: cherry@..., leo@... (group)`. It sends nothing.
13. Run **sendSampleToMe** to get one sample reminder in your own inbox.
14. Run **installTrigger**. It now checks every `CHECK_EVERY_MINUTES` minutes, but `DRY_RUN` is still `true`, so it only writes "would email ..." to **Executions**. Check that for a day.
15. When it looks right, change `DRY_RUN: true` to `DRY_RUN: false` at the top of `Code.gs` and save. Reminders go out from the next run.
16. For the dashboard's Email tab, run **makeLogSheet** once and allow the spreadsheet permission it asks for. It creates **Reply reminders log** in the sender account's Drive, fills it, and writes its link to the log. Share the sheet with the people who should see the Email tab, then paste the link into the Email tab (someone who can edit the dashboard does this once).

To stop it, run **removeTrigger**. To watch someone else's sent emails too, add their address to `WATCH`.

## Deadline agent (`Deadlines.gs`)

A second file in the same Apps Script project. Every 15 minutes it reads the assignments the assigner sends and every reply to them, chases missed deadlines, logs every miss, and emails a 5:00 PM Pacific scorecard. It uses the same service account, with two more permissions the admin added on Oct 29: `gmail.readonly` (to read what replies say and see attachments) and `gmail.send` (to send the chase as the assigner).

**An assignment** is an email from the assigner with a line like `OWNER: Cherry · DUE: Oct 30, 5 PM PT` (OWNER and DUE in either order; one line per assignment; several owners as `Cherry and Leo`). Owners are matched to the people on the email by name or address; a name that isn't on the email, or a DUE it can't read, is listed in the scorecard under "NOT READ" and never chased. DUE understands `Oct 30, 5 PM PT`, `10/30 17:00`, `tomorrow noon`, `Friday EOD`, `3 PM` (today, or tomorrow if that time had passed), `Manila`; with no time it means 5:00 PM.

**Where it stands**, from the owner's messages after the assignment:
- **Delivered:** a reply that says DONE (at the start of a line), or has an attachment, or a link to Docs / Drive / Dropbox / OneDrive / Box / Loom / Canva / Figma / WeTransfer. A signature's logo and website don't count. An email the owner sent elsewhere counts too, when its subject contains the assignment's subject (Re:/Fwd:/TEST ignored).
- **DATE** sent before the deadline moves it to that date, once. A DATE after the deadline doesn't stop the chase.
- **BLOCKED** before the deadline: not chased; shown as blocked.
- **Missed:** the deadline passed with none of these. Within 15 minutes it emails the owner only, in the assignment's thread, as the assigner: "The deadline was Oct 29, 3:00 PM PT. Send it now, plus one line on why you missed it." Once per deadline. A late DONE still counts as a miss.

**Log**: the log sheet's **Assignments** tab (rewritten each pass) and **Misses** tab (one row per miss, by name and date, never rewritten). **Scorecard**: on the first pass after 5:00 PM Pacific, an email to the assigner with DELIVERED TODAY, MISSED TODAY, STILL OPEN, and NOT READ. The dashboard's **Pause** switch holds every chase (misses are still logged).

**Setup** (after the reply reminders are set up):
1. Paste the latest `Code.gs`. Then **Files → + → Script**, name it `Deadlines`, and paste `Deadlines.gs`. Save.
2. Run **checkDeadlines**. It checks both permissions and logs every assignment it finds and what it would do. It sends nothing.
3. Run **installDeadlineTrigger**. While `DRY_RUN` is true, Executions shows `[dry run] would chase …` and the scorecard is only logged.
4. Testing (`TEST_ONLY: true`): only emails whose subject starts with TEST are read, so real email can't be caught. Send one from the assigner's account with an `OWNER: … · DUE: …` line a few minutes ahead, and watch Executions.
5. To go live: `ASSIGNER: 'juan@twinhomebuyer.com'`, `TEST_ONLY: false`, `DRY_RUN: false`. Assignments already overdue are chased on the first pass.

To stop it, run **removeDeadlineTrigger** (or use Pause on the dashboard).

## The email log (for the dashboard)

Every check rewrites two tabs in **Reply reminders log**:

- **Emails**: one row each time Juan emailed someone on the team and waited for an answer. Columns: `Thread · Subject · From · From name · Sent · Person · Name · On (To/CC) · Group · Replied · Status · Reminders · Message ID`. A wait starts at the first email the person hasn't answered and ends at their next message in the thread, so a follow-up after they answered starts a new row. Times are UTC. Only the last `LOOKBACK_DAYS` are kept. The tab is rewritten only when a row changed.
- **Status**: when the log last updated, whose emails it watches, the reminder waits, whether reminders are on or in dry run, and whether they're paused.
- **Stopped** and **Pause**: written by the dashboard's Email tab, read by the script on every check. A row in **Stopped** (`Thread · Person · Subject · Stopped by · Stopped at`) stops reminders on that email, for one person or, with Person blank, everyone; it covers waits that started before it, so once the person answers, a new email is tracked again. Resume on the dashboard clears the row. **Pause** row 2 (`yes`/`no · By · At`) holds every reminder while it says yes. The script makes both tabs (as plain text) the first time it writes the log. If they can't be read, reminders carry on as normal.

The dashboard reads it through each viewer's own Google Sheets connection, so only people the sheet is shared with see the team view, and only people with edit access can stop or pause reminders from it. If the sheet can't be written (deleted, no access), the reminders still go out and **Executions** says "Couldn't update the email log".

## Tests

The rules and the run against a stand-in for Google are tested with Node:

```
node gmail-reply-reminders/test/reminders.test.js  # who owes a reply, stages, quiet hours, what the email says
node gmail-reply-reminders/test/run.test.js        # sign-in, reading headers, sending once, quiet hours, dry run, the log sheet, stop and pause
node gmail-reply-reminders/test/deadlines.test.js      # OWNER/DUE lines, deadlines across time zones and the clock change, DONE/DATE/BLOCKED, when to chase, the scorecard
node gmail-reply-reminders/test/deadlines-run.test.js  # a day end to end: TEST-only, work sent elsewhere, dry run, the chase, Pause, the 5 PM scorecard
```

Reading headers from a real Workspace mailbox was checked on Oct 27 (`checkSetup` read 16 sent threads). Sending into a thread was checked live on Oct 28 from Seth's account: a private email to Bryan got a reminder to Bryan alone, and an email to Bryan and Lawrence got one reminder to both, each inside the original thread. Later tests the same day: with four people on an email, each one who replied (including one who replied only to Seth) was left off the next reminder, and an outside address on the email never got one. The first runs failed until the Gmail API was added under **Services** (step 10).
