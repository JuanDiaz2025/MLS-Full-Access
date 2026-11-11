# Deal Pipeline (Phase 1)

Google Apps Script that runs the Grok bots every morning through the xAI API and routes the results through the "Deal Pipeline" Google Sheet.

| When | What happens |
| --- | --- |
| About 7:00 AM Pacific | Deal Radar and Straight Talk find leads. They land on the **Leads** tab. |
| Right after | Deal Desk ranks the new leads. The list goes on the **Deal Desk** tab and is emailed to Cherry. Leads scoring 8 or higher are also emailed to Juan. |
| Right after | Every lead Deal Desk tags VALUE-ADD goes to Add or Split This House. The report goes on the **Add or Split** tab and is emailed to Thea. |
| Every step | Results are copied onto that property's single row on **Property Cards**. The Texts and Costs columns are kept free for Phase 2. |

Each bot's instructions live on the **Settings** tab. A bot with an empty instruction cell is skipped, so nothing is sent to xAI and nothing is spent until Juan fills them in.

## Setup

### 1. Bot Google account (after Bryan grants User Management Admin)

1. admin.google.com > Directory > Users > Add new user: `grok@twinhomebuyer.com`, with a long generated password.
2. Open a separate Chrome profile so the bot account stays apart from your own, and sign in as grok@.
3. Turn on 2-Step Verification at myaccount.google.com > Security. If the company vault can hold one-time codes, set it up there so the account doesn't depend on one person's phone.
4. Put the password and backup codes in the company vault.

If the console won't let you add the user (for example, no license is free), that is a BLOCKED for Bryan.

### 2. xAI developer account (signed in as grok@)

1. Go to console.x.ai and sign up with the grok@ Google account.
2. **Billing.** Add the company card and leave the invoiced billing limit at $0. Then either buy a small amount of credit and turn on auto top-up with a **monthly maximum of $100**, or skip auto top-up and buy $100 of credit each month. Requests stop once the credit runs out.
3. **API Keys.** Create a key called `deal-pipeline` and copy it straight into the company vault. It never goes in an email or a chat.

### 3. The sheet and the script (signed in as grok@)

1. Open sheets.new. Then open Extensions > Apps Script.
2. Delete what's in `Code.gs` and paste in [`Code.gs`](Code.gs) from this folder. Save.
3. Open Project Settings (the gear icon):
   - Set the time zone to **(GMT-08:00) Pacific Time - Los Angeles**.
   - Under Script Properties, add `XAI_API_KEY` with the key from the vault.
4. Back in the editor, choose `setup` in the function list and click **Run**. Approve the permissions as grok@. Setup renames the file to "Deal Pipeline", builds the tabs and sets the daily 7 AM trigger.
5. Reload the sheet. A **Deal Pipeline** menu appears.
6. On the **Settings** tab, fill in the email addresses for Cherry, Juan, Thea, Alerts (you) and Test (you). **Leave every instruction cell empty.**
7. Click Deal Pipeline > **Run test**. It sends sample data through every step with no API cost, and every email goes to the Test address with "[TEST]" in the subject.
8. Click Deal Pipeline > **Test xAI connection**. It makes one tiny real call, which proves the key, the billing and the model all work.
9. Share the sheet. Give Juan Editor access, since he fills in the instructions. Give Cherry and Thea Viewer access. Anyone with edit access can open the script and read the API key in Script Properties, so keep the editors to Juan and yourself.
10. After the screenshots, Deal Pipeline > **Remove test rows** clears the sample data.

## Screenshots for DONE

- Leads, Deal Desk, Add or Split and Property Cards with the test rows on them
- Run Log showing the test run ending in DONE and the xAI connection test reading OK
- The four [TEST] emails: Deal Desk list (Cherry), hot leads (Juan) and two Add or Split reports (Thea)
- Apps Script > Triggers (the clock icon) showing `startMorningPipeline`, daily, 7am to 8am
- xAI billing page with the $100 limit, and the API Keys page with the key hidden
- Admin console user page for grok@ with 2-Step Verification on

## How it behaves

- **Settings tab.** One row per bot holds the Instructions, the Model (default `grok-4.7`) and Web + X search (ON or OFF). Turning search OFF makes a bot cheaper, but then it can't look anything up.
- **Output format.** The code sets each bot's reply format, so changes to the instructions can't break the sheet. Deal Desk always returns a 1 to 10 score, tags, comps, a reason and a next step. Any tag containing VALUE-ADD sends the lead to Add or Split.
- **Timing.** Apps Script fires a daily trigger within about 15 minutes of the hour it's set for. Each step runs on its own and the next one starts about 30 seconds later, so a slow bot can't trip the 6-minute limit.
- **Failures.** A failed step is retried once, then emailed to the Alerts address. A bad key or a lack of credit is not retried. Leads Deal Desk couldn't rank stay "New" and go into the next morning's batch.
- **Duplicates.** The same house from both bots, or on a later day, becomes one lead and one property card, and "Found By" lists both bots. Addresses are matched with common abbreviations evened out, so "Street" and "St" count as the same.
- **No leads.** If the lead bots ran and found nothing, Cherry gets a short "no new leads today" email. If they were skipped because their instructions are empty, nobody is emailed.
- **Run Log.** Every step is logged here with its token count and cost in dollars.

## Files

- `Code.gs` is the whole script.
- `appsscript.json` is the manifest, for anyone using `clasp`. Pasting into the editor doesn't need it, as long as the time zone is set in Project Settings.
