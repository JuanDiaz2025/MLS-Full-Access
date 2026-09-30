# DealTrack

Google Ads results for Twin Home Buyer, built from the AdPilot hackathon app.

It reports on one Google Ads account. The pages are grouped the way the work goes:

**Overview.** Spend, leads, cost per lead, clicks, click-through rate, and search impression share, each with its change against the period before and a sparkline; a chart that compares any two metrics (`?m1=cost&m2=leads`); status cards for open alerts, this month's pacing, the weekly negatives, and the go-live audit; and what needs attention.

**Monitor**

- **Alerts:** rules checked every time the page (or the Overview) opens: the budget's alert and pause lines, a month heading past budget, $20K+ in a month with no leads, days of spend with no leads, cost per lead over a limit, yesterday's spend, clicks, or cost per click far above normal, ads that stopped spending, disapproved ads in running campaigns, invalid clicks, broken landing pages, soft conversions, script errors, and last week's unusual numbers. Every alert goes into a history with when it started and when it cleared. Admins set the limits on the page.
- **Budget & pacing:** this month's spend against the monthly budget, with the alert and pause lines: where the month is heading at the recent pace and at full budgets, the daily spend needed to land on budget, and each campaign's spend and share lost to budget. At the pause line, admins can pause running campaigns from here (turning them back on is done in Google Ads, on purpose).
- **Quality Score:** each keyword's 1–10 score and its three parts, a 12-month weekly trend, how scores are spread, and what to fix. Seller (non-brand) keywords by default.

**Audit**

- **Go-live audit:** grades the account A to F in six areas (conversion tracking, location targeting, keywords and negatives, ads and landing pages, budget, campaign setup), with a "fix first" list. Checks Google Ads can't see (click ID capture, the test lead, after-hours coverage, the call outcome form, retargeting, baseline numbers) are ticked by a person with their name.
- **Ads & creatives:** every enabled ad: disapprovals and limits with the reason in plain English and the fix, ad strength, too few headlines or descriptions, heavy pinning, broken landing pages, and Google's Best/Good/Low rating of each headline and description.
- **Landing pages:** where your ads send people. Pages behind ads that are running right now come first, then the most-spent pages. Up to 8 get a mobile PageSpeed test and a check for a short form, tap-to-call, and reviews, next to their spend, conversions, and PostHog submit rate.
- **Conversions:** what Google counts as a conversion, with a warning if a primary conversion isn't really a lead.

**Optimize**

- **Campaigns:** every campaign in the account, running or not, with its daily budget and results. Filter by status like Google Ads.
- **Search terms:** what people typed, which terms spent money without converting, and suggested negative keywords. Searches that say "sell" are never suggested as negatives (only competitor names and cities outside the buy area are).
- **Weekly negatives:** the weekly routine. DealTrack drafts one batch from last week's searches (the rules in `negatives.ts`, plus words that never converted in 90 days), someone reviews each line, someone else approves, an admin pushes the approved lines to Google Ads in one change, and a week later the result is checked (did spend on those searches stop, and did leads hold up?). Anything that would block a search that converted, or a seller saying "sell", is held back. At most one push a week.
- **Keywords:** each keyword marked "Stop or fix" (spent $100+ without converting) or "Scale" (converting cheaper than average).
- **Locations:** spend by city, with anything outside the buy area flagged.
- **Day & hour:** a heat map of spend and conversions by weekday and hour.

**Insights**

- **Behavior:** Google Ads visitors by default: each recent visit with its campaign, keyword, pages, time on site, device, city, whether they submitted the form, and a link to the PostHog replay; plus submit rates by campaign, keyword, landing page, device, day, and hour.
- **Forecast:** Google Ads leads and cost per lead to expect by monthly budget over 3, 6, or 12 months. With the PPC LEAD sheet connected it also forecasts deals, net revenue, ad spend per deal, and the chance of zero deals.

**Reports**

- **Weekly report:** one week against the week before: headline numbers, the month's pacing, campaigns, searches that cost money without a conversion, invalid clicks by month and campaign, alerts, the week's negatives, and every change made in the account. Print it, or copy a plain-text summary into Slack or an email.
- **Changes:** Google's own change history for the last 30 days: who changed what, and from where.

Most pages have date presets (including the Bateman period, Jun 5 – Jul 23, 2026) and a custom from/to range.

## Saved data

DealTrack keeps its own records in one file on the computer running it: `.data/dealtrack.json` in this folder (git ignores it). It holds the budget and alert lines, the alert history, the weekly negative batches with every step's name and time, and the go-live audit ticks. Set `DEALTRACK_DATA_DIR` to keep it somewhere else.

- It's per computer. If two people each run DealTrack on their own laptop, each has their own history. Run it on one computer (or copy the file) to share one record.
- Back it up like any other file. Deleting it resets the settings and history; Google Ads isn't affected.
- It needs a disk to write to. On hosting without one (Vercel, for example), the reports work but saving shows an error.
- Checks run when someone opens the app, not on a schedule: alerts are evaluated when the Alerts page or the Overview opens.
- Steps that need a name (budget lines, audit ticks, proving, approving, pushing) use the name typed in the "Your name" field. It's remembered in that browser for a year.

## Making changes (admins only)

Reports are read-only for everyone. People who sign in with `ADMIN_PASSWORD` can also:

- **Add negative keywords** from the Search terms page: tick suggested ones or type your own, choose phrase, exact, or broad match, and choose campaigns.
- **Push the weekly negatives** batch once it's proven and approved.
- **Exclude cities** outside the buy area from the Locations page.
- **Pause campaigns** from Budget & pacing once spend reaches the pause line.
- **Undo** negatives and exclusions with Remove, in the lists below each panel.
- **Set the budget lines and alert limits** (these only change DealTrack's saved data).

Safeguards:

- Every change shows exactly what will happen and needs a second click to confirm.
- Only running campaigns are chosen by default. Paused ones can be added from a search box.
- Terms and cities that brought conversions are left unchecked.
- Cities in the buy area can't be excluded, whatever is sent to the server.
- Remove only works on negative keywords and location exclusions, so it can't delete keywords, ads, or campaigns.
- Nothing is changed automatically: alerts and the budget's pause line only ask a person.
- Changes appear in Google Ads' change history (and on the Changes page) as made through the API.
- **Dry run:** with `DEALTRACK_VALIDATE_ONLY=1`, every change is sent with Google's validate-only flag: Google checks it and applies nothing. Use it to try the buttons.

Without `ADMIN_PASSWORD`, nobody can make changes and the dashboard is read-only.

## Run it

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. In this folder, copy `.env.example` to `.env.local` and fill in the values (below).
3. Run:

   ```bash
   npm install
   npm run dev
   ```

4. Open http://localhost:3000.

**Windows:** double-click `start.bat`. The first time, it creates `.env.local` and opens it in Notepad so you can paste in the keys. Run it again after saving, and it installs everything and opens the dashboard. It runs the production build, so it takes about a minute to start. For editing the code, use `npm run dev` instead.

## Settings

All settings are environment variables. On your computer they go in `.env.local`, which git ignores. When the app is online, add them in the hosting provider's settings (on Vercel: Project → Settings → Environment Variables). Never put the values in the code.

| Variable | Where to find it |
| --- | --- |
| `GOOGLE_ADS_DEVELOPER_TOKEN` | Google Ads manager account → Admin → API Center |
| `GOOGLE_ADS_CLIENT_ID` | Google Cloud → Google Auth Platform → Clients → the web client |
| `GOOGLE_ADS_CLIENT_SECRET` | Same client, under Client secrets |
| `GOOGLE_ADS_REFRESH_TOKEN` | OAuth Playground with the `https://www.googleapis.com/auth/adwords` scope |
| `GOOGLE_ADS_CUSTOMER_ID` | The ad account's 10-digit ID, top right in Google Ads (Twin Home Buyer: `9897155298`) |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Optional. The manager account's ID, only if access goes through it |
| `APP_PASSWORD` | A team password you choose, for viewing. Required online; optional on your computer |
| `ADMIN_PASSWORD` | Optional. A separate password that allows changes in Google Ads |
| `SESSION_SECRET` | Any long random string |
| `LEADS_SHEET_ID` | Optional. Adds deals and profit to Forecast. The PPC LEAD sheet's ID, from its URL between `/d/` and `/edit` |
| `GOOGLE_SHEETS_REFRESH_TOKEN` | Forecast. OAuth Playground → gear → "Use your own OAuth credentials" (the Ads web client) → scope `https://www.googleapis.com/auth/spreadsheets.readonly`. Enable the Google Sheets API in the same Cloud project. Optional if `GOOGLE_ADS_REFRESH_TOKEN` has both scopes |
| `POSTHOG_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` | Behavior, Alerts. PostHog → Settings → Personal API keys → "Read-only access", limited to the project (Twin Home Buyer: `421236`, host `https://us.posthog.com`) |
| `CLARITY_API_TOKEN` | Alerts. Clarity → Settings → Data export. Allows ~10 calls a day, so results are cached 3 hours |
| `PAGESPEED_API_KEY` | Landing pages, Go-live audit. Google Cloud → enable PageSpeed Insights API → Credentials → Create API key |
| `DEALTRACK_DATA_DIR` | Optional. Where the saved data goes (default: `.data` in this folder) |
| `DEALTRACK_VALIDATE_ONLY` | Optional. `1` turns on dry-run mode: Google checks every change and applies nothing |

If a value is missing, the page that needs it says which one; the other pages keep working.

## How it works

- `src/lib/google-ads/client.ts` trades the refresh token for an access token and runs GAQL queries against the Google Ads API (v22). Results are cached for 10 minutes, since Explorer access allows 2,880 API operations a day.
- `src/lib/google-ads/reports.ts` holds the report queries and turns Google's micros and strings into dollars and numbers. `overview.ts`, `ads.ts`, `quality.ts`, and `invalid-clicks.ts` hold the newer pages' queries.
- `src/lib/store.ts` reads and writes the saved data file. Saves are queued and written to a temporary file first, so two at once can't overwrite each other and a crash can't leave half a file.
- `src/lib/alert-rules.ts` holds the alert rules and the alert history; `src/lib/budget.ts` the pacing; `src/lib/audit.ts` the go-live audit; `src/lib/negative-batches.ts` the weekly negatives.
- `src/lib/service-area.ts` lists the buy area. Edit it to change the buy box.
- `src/lib/negatives.ts` holds the rules behind suggested negative keywords. Edit them as the team learns from lead outcomes.
- `src/lib/google-ads/changes.ts` makes the changes (negative keywords, location exclusions, pausing) and re-checks every input against the live account first. `src/app/actions/changes.ts` is the only way the pages reach it, and it checks for an admin session.

## Next steps

- Sign in with Google (one login per person) instead of a shared password and a typed name.
- If more than one computer runs DealTrack, move the saved data to a shared database so everyone sees one history.
- Host it online so alerts can run on a schedule and send email or Slack, instead of only when the app is open.
