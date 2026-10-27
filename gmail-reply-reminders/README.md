# Gmail reply reminders

When Juan emails someone on the team and they haven't replied, this emails them a short reminder:

> **Juan Diaz is waiting for your reply**
>
> Hi Cherry,
>
> Juan Diaz sent you an email and is still waiting for your reply.
>
> Juan Diaz emailed you on Tue, Oct 27 at 6:00 PM. [Open the email]
>
> Please reply to Juan Diaz in Gmail. This is reminder 1 of 3. It was sent automatically and doesn't include what the email says.

The reminder never includes the email's subject or content. The link opens the email in the person's own Gmail.

It's a Google Apps Script that checks every few minutes (5 by default) on Google's servers. It doesn't use Claude or WhatsApp, and it costs nothing.

## What it can see

A Google Workspace admin gives a service account permission to read **email headers only** (the `gmail.metadata` scope): who sent an email, to whom, when, the subject and the message id. It can't open bodies or attachments. Juan installs nothing. The script only reads the mailboxes listed in `WATCH`.

The permission is company-wide: the key can read the headers of any mailbox at twinhomebuyer.com, even though the script only reads Juan's. Keep the script project and its key private, because anyone who can edit the script can read the key.

Reading Juan's email headers falls under the same sign-off as the WhatsApp tracker (Greg's written OK, and counsel). Juan should know it's running.

## The rules

- Only emails **Juan started** count. His replies in threads someone else started are usually answers ("Thanks!"), and from headers alone they can't be told apart. To count them too, set `ONLY_THREADS_STARTED: false`.
- Only people in **To** at **@twinhomebuyer.com** owe a reply. Cc, outside addresses and anything in `IGNORE` (group lists like team@) don't.
- Someone has replied when they write in the same email thread after Juan. A reply in a new thread, a call or a WhatsApp message doesn't count. For emails like that, Juan can add a **No reply needed** label in his Gmail and the email is skipped.
- Subjects starting with **FYI** are skipped.
- Reminders go out after **4 hours, 1 day and 2 days** (`REMIND_AFTER_MINUTES: [240, 1440, 2880]`), then stop. Each one is sent once. Someone with several emails waiting gets one reminder listing them all.
- It checks every **5 minutes** (`CHECK_EVERY_MINUTES`: 1, 5, 10, 15 or 30), so a reminder goes out within that long of being due.
- Everyone gets the reminder **as soon as it's due, wherever they are**, day or night. Quiet hours are off (`QUIET_FROM_HOUR` and `QUIET_TO_HOUR` both 0). Setting them to, for example, 20 and 8 holds reminders between 8 PM and 8 AM in each person's time zone.
- The time shown in the email is in the person's time zone: Manila unless they're listed in `PEOPLE_TIME_ZONES` (Bryan is set to California).
- Emails older than **7 days** are left alone.

All of these are at the top of `Code.gs` under `CONFIG`.

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
10. **Project Settings → Script properties → Add script property.** Property: `SA_KEY`. Value: the **whole contents** of the JSON key file from step 5. Save, then delete the downloaded file.
11. In the editor, pick **checkSetup** and press **Run**. Allow the permissions it asks for. The log should say something like `juan@twinhomebuyer.com: 23 threads with sent mail in the last 7 days, 2 replies still owed by: cherry@...`. It sends nothing.
12. Run **sendSampleToMe** to get one sample reminder in your own inbox.
13. Run **installTrigger**. It now checks every `CHECK_EVERY_MINUTES` minutes, but `DRY_RUN` is still `true`, so it only writes "would email ..." to **Executions**. Check that for a day.
14. When it looks right, change `DRY_RUN: true` to `DRY_RUN: false` at the top of `Code.gs` and save. Reminders go out from the next run.

To stop it, run **removeTrigger**. To watch someone else's sent emails too, add their address to `WATCH`.

## Tests

The rules and the run against a stand-in for Google are tested with Node:

```
node gmail-reply-reminders/test/reminders.test.js  # who owes a reply, stages, quiet hours, what the email says
node gmail-reply-reminders/test/run.test.js        # sign-in, reading headers, sending once, quiet hours, dry run
```

Not yet run against a real Google Workspace. Part C's `checkSetup` and the dry-run day are the first real check.
