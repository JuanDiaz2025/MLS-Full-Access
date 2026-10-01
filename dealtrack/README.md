# DealTrack

Google Ads results for Twin Home Buyer, built from the AdPilot hackathon app.

It reports on one Google Ads account and collects the website's leads. The leads, calls, chat and Google sign-in came over from One Marketing Command Center. The pages are grouped the way the work goes:

**Overview.** Spend, leads, cost per lead, clicks, click-through rate, and search impression share, each with its change against the period before and a sparkline; a chart that compares any two metrics (`?m1=cost&m2=leads`); status cards for open alerts, this month's pacing, the weekly negatives, and the go-live audit; and what needs attention.

**Leads.** Every lead from the website forms as it arrives (WordPress sends it by webhook): a searchable spreadsheet with the channel worked out from the UTM tags and Google click ID (Google Ads, Facebook, organic search, direct mail...), landing page, referrer and form, plus **Export CSV**. Below it, phone calls from Google Ads (answered or missed, length, area code, campaign), and the WordPress setup: the webhook address, the Contact Form 7 hidden fields, and a tracking snippet. The page refreshes itself every few seconds. Missed ad calls also raise an alert.

**Ask about your ads.** The button in the corner of every page opens a chat. Ask a question or for a report ("what went wrong last week?", "build a report for September") and it looks up the Google Ads account, the website leads, and DealTrack's own records (alerts, budget lines, weekly negatives) to answer, with tables you can copy or download. It only reads; it can't change anything. It runs on an OpenAI key, an Anthropic key, or the Claude Code app signed in with a Claude account (see Settings).

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
- **Search terms:** what people typed, which terms spent money without converting, and suggested negative keywords. Searches that say "sell" are never suggested as negatives (only competitor names and places outside California are).
- **Weekly negatives:** the weekly routine. DealTrack drafts one batch from last week's searches, or from any dates and any one campaign, paused ones too. Lines come from the rules in `negatives.ts` and from words that never converted in 12 months. Then someone reviews each line, someone else approves, an admin pushes the approved lines to Google Ads in one change, and a week later the result is checked (did spend on those searches stop, and did leads hold up?). Anything that would block a search that converted in the last 12 months, or a seller saying "sell", is held back. At most one push a week. The **Campaign check** tab lists each campaign (running ones, then paused ones by search spend) with the standard negatives it doesn't block yet (competitors, places outside California, agents, home buyers, renters, loans, jobs, listing sites, price checks) and the last 12 months' rule-matched spend nothing blocks. Choose campaigns and draft a batch from it; the push can put the lines in one shared list, "DealTrack standard negatives", attached to the chosen campaigns.
- **Keywords:** each keyword marked "Stop or fix" (spent $100+ without converting) or "Scale" (converting cheaper than average).
- **Keyword ideas:** the opposite of negatives. From a period's search terms (12 months by default): searches that converted but aren't keywords yet (exact), phrases several converting searches share (phrase), and seller situations (inherited, probate, divorce, foreclosure, repairs, tenants…) with how often they show up. Each idea goes into the ad group where it converted, or every idea goes into a campaign you pick (the running one, say), and any line can go into several ad groups. Tick lines, or take them all, to put them into one campaign at once. Never suggested: anything the negative rules block, competitor names unless you include them, anything a negative already blocks there, and keywords the campaign already has. Same review, approval, and admin push as the negatives; keywords are added paused by default. Keyword Planner volume and bids for California are added automatically once the developer token has Basic access.
- **Locations:** a campaign filter (all campaigns or one) and four tabs. **Map**: a bubble per city (size by impressions, spend, clicks or conversions; color by cost per conversion against the average), hover for its numbers and the campaigns that ran there, search to fly to a city, and quick facts (average and highest impressions, most spend, most conversions, cheapest conversions). City centers come from US ZIP code data (the zipcodes package, BSD license) in `src/lib/places/us-cities.json`; the base map is OpenStreetMap. **Overview**: spend in and outside California; people in the area versus people elsewhere searching about it (presence vs. interest), overall and per campaign; and California regions (SF & Peninsula, South Bay, East Bay, North Bay, Sacramento, Central Valley, Central Coast, Southern California) against your average cost per conversion. **Cities**: California cities that spent a lot without results (exclude on purpose, or leave), cities outside California to exclude, and the costliest cities. **Targeting**: each running campaign's targeted and excluded places and location setting, with warnings; paused ones that spent are folded below. Long periods are fetched in 90-day pieces; place names are kept once fetched, so later loads are fast.
- **Day & hour:** a heat map of spend and conversions by weekday and hour.

**Insights**

- **Behavior:** Google Ads visitors by default: each recent visit with its campaign, keyword, pages, time on site, device, city, whether they submitted the form, and a link to the PostHog replay; plus submit rates by campaign, keyword, landing page, device, day, and hour.
- **Forecast:** Google Ads leads and cost per lead to expect by monthly budget over 3, 6, or 12 months. With the PPC LEAD sheet connected it also forecasts deals, net revenue, ad spend per deal, and the chance of zero deals.

**Reports**

- **Weekly report:** one week against the week before: headline numbers, the month's pacing, campaigns, searches that cost money without a conversion, invalid clicks by month and campaign, alerts, the week's negatives, and every change made in the account. Print it, or copy a plain-text summary into Slack or an email.
- **Changes:** Google's own change history for the last 30 days: who changed what, and from where.

Most pages have date presets (including the Bateman period, Jun 5 – Jul 23, 2026) and a custom from/to range.

## Saved data

DealTrack keeps its own records in the `.data` folder on the computer running it (git ignores it). Set `DEALTRACK_DATA_DIR` to keep it somewhere else.

- `dealtrack.json`: the budget and alert lines, the alert history, the weekly negative batches with every step's name and time, and the go-live audit ticks.
- `leads.json`: the website leads (same format as One Marketing Command Center: copy its `.data/leads.json` here to bring its leads over).
- `webhook-secret`: the key WordPress sends with each lead (unless `LEADS_WEBHOOK_SECRET` is set). `webhook-log.json`: the last few webhook calls, for troubleshooting.
- `public-url`: the public address while `go-online.bat` runs.

- It's per computer. If two people each run DealTrack on their own laptop, each has their own history. Run it on one computer (or copy the file) to share one record.
- Back it up like any other file. Deleting it resets the settings and history; Google Ads isn't affected.
- It needs a disk to write to. On hosting without one (Vercel, for example), the reports work but saving shows an error.
- Checks run when someone opens the app, not on a schedule: alerts are evaluated when the Alerts page or the Overview opens.
- Steps that need a name (budget lines, audit ticks, proving, approving, pushing) use the name typed in the "Your name" field. It's remembered in that browser for a year.

## Signing in

- **Continue with Google:** set `ALLOWED_EMAILS` (addresses or whole domains, like `@twinhomebuyer.com`) and, for admins, `ADMIN_EMAILS`. It uses the Google Ads web client (or `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`); add `http://localhost:3000/api/auth/google/callback` to that client's **Authorized redirect URIs** in Google Cloud (and `https://your-address/api/auth/google/callback` once it's online). Google sign-in stays off until `ALLOWED_EMAILS` is set, so no other Google account can get in. People signed in with Google get their name filled in automatically. Taking an email off the list signs that person out.
- **Passwords:** `APP_PASSWORD` to view and `ADMIN_PASSWORD` for changes still work, alongside Google or instead of it.
- With no sign-in set up, the reports are open on your own computer only: never in production, and never while `go-online.bat` has DealTrack on a public address.

## Website leads from WordPress

1. Open **Leads** and expand **Website leads (WordPress)**. Copy the webhook address.
2. In WordPress, paste it into the form's webhook setting, method **POST** (Contact Form 7: the free **CF7 to Webhook** plugin; Elementor: Actions After Submit → Webhook; WPForms and Gravity Forms: their webhook add-on). Sending the key as an `X-Webhook-Secret` header instead of `?key=` in the address keeps it out of logs, where the plugin allows it.
3. Name the fields name, phone, email, property address and message (most forms already do). Add the hidden fields and tracking snippet shown on the page so each lead carries its UTM tags and Google click ID.
4. WordPress has to reach DealTrack: put it online, or double-click `go-online.bat` (a free Cloudflare tunnel; leads arrive only while it and DealTrack run, and the address changes each time).

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

**Faster for everyday use:** `npm run dev` compiles each page the first time you open it, which adds a few seconds per page. `start.bat` (or `npm run build` then `npm start`) runs the finished build and is much quicker.

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
| `ALLOWED_EMAILS` | Google sign-in: who may view, e.g. `@twinhomebuyer.com,partner@gmail.com` |
| `ADMIN_EMAILS` | Google sign-in: who may also make changes, e.g. `seth@twinhomebuyer.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional. A separate Google client for sign-in; defaults to the Google Ads client |
| `SITE_URL` | Once online: its address, for the Google sign-in redirect and the webhook address |
| `LEADS_WEBHOOK_SECRET` | Optional. The key WordPress sends; one is created in `.data` if empty |
| `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` | The chat. platform.openai.com → API keys, or console.anthropic.com → API keys. Billed per question (a few cents) |
| `ASSISTANT_PROVIDER` | Optional. `claude-code` uses the Claude Code app on this computer signed in with a Claude account, no key (double-click `setup-claude.bat` or click **Sign in with Claude** in the chat). With both keys, OpenAI answers unless this says `anthropic` |
| `DEALTRACK_DATA_DIR` | Optional. Where the saved data goes (default: `.data` in this folder) |
| `DEALTRACK_WARMUP` | Optional. `0` stops the startup warm-up (see Speed) |
| `DEALTRACK_VALIDATE_ONLY` | Optional. `1` turns on dry-run mode: Google checks every change and applies nothing |

If a value is missing, the page that needs it says which one; the other pages keep working.

## Speed

- When the server starts, it fetches the reports people open first (the Overview, alert rules, landing page tests, the go-live audit) in the background, so the first visit doesn't wait. It prints "DealTrack: reports ready" when done, usually within a minute.
- Google Ads reports are fresh for 10 minutes. After that, for up to 6 hours, the last result shows at once and a new one is fetched in the background. "Refresh now" on the Overview fetches everything again.
- PageSpeed results are kept 12 hours (and shown for up to a week while a new test runs), since each test takes 10–30 seconds.
- A bar across the top shows a page is loading, and slow pages show what they're waiting for.

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
- Host it online so alerts can run on a schedule and send email or Slack, instead of only when the app is open, and so WordPress can send leads without the tunnel.
- The chat sends what it looks up (ad numbers, and lead names and contact details when asked about leads) to the AI provider chosen above.
