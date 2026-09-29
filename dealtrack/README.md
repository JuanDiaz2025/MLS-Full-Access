# DealTrack

Google Ads results for Twin Home Buyer, built from the AdPilot hackathon app.

It reports on one Google Ads account and shows:

- **Overview:** spend, clicks, conversions, cost per conversion, daily trends, and what needs attention.
- **Campaigns:** every campaign that ran in the period, including paused and removed ones.
- **Search terms:** what people typed, which terms spent money without converting, and suggested negative keywords you can copy into Google Ads.
- **Ads:** each responsive search ad's headlines and descriptions, approval status, and results.
- **Keywords:** each keyword marked "Stop or fix" (spent $100+ without converting) or "Scale" (converting cheaper than average).
- **Locations:** spend by city, with anything outside the nine Bay Area counties flagged.
- **Day & hour:** a heat map of spend and conversions by weekday and hour.
- **Conversions:** what Google counts as a conversion, with a warning if a primary conversion isn't really a lead.
- **Changes:** Google's own change history for the last 30 days: who changed what, and from where (DealTrack, the Google Ads website, Editor, scripts).

Every page has date presets (including the Bateman period, Jun 5 – Jul 23, 2026) and a custom from/to range.

## Making changes (admins only)

Reports are read-only for everyone. People who sign in with `ADMIN_PASSWORD` can also:

- **Add negative keywords** from the Search terms page: tick suggested ones or type your own, choose phrase, exact, or broad match, and choose campaigns.
- **Exclude cities** outside the Bay Area from the Locations page.
- **Undo** either one with Remove, in the lists below each panel.
- **Pause or turn on campaigns, and change daily budgets** on the Campaigns page. Running campaigns are listed; find a paused one by name.
- **Set an ad schedule** (days and hours a campaign shows ads) on the Day & hour page, under the heat map.
- **Edit ad headlines and descriptions** on the Ads page, including pins. Character counts follow Google's rules, so `{LOCATION(City):Local}` counts as "Local". Google reviews an edited ad again, usually within a day.

After a pause, budget, schedule, or ad change, the message that follows has an **Undo** button that puts back what was there before.

Safeguards:

- Every change shows exactly what will happen and needs a second click to confirm.
- Only running campaigns are chosen by default. Paused ones can be added from a search box.
- Terms and cities that brought conversions are left unchecked.
- Bay Area cities can't be excluded, whatever is sent to the server.
- Daily budgets are limited to $1–$1,000 (`MAX_DAILY_BUDGET` changes the limit). The confirm step warns when a budget is shared with other campaigns or more than doubles.
- A schedule is saved all at once or not at all, so a campaign never ends up with half a schedule. Unchanged time ranges keep their bid adjustments.
- Every change reads the current value fresh from Google first, so undo restores what was really there.
- Remove only works on negative keywords and location exclusions, so it can't delete keywords, ads, or campaigns.
- Changes appear in Google Ads' change history (and on the Changes page) as made through the API.

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
| `MAX_DAILY_BUDGET` | Optional. The highest daily budget, in dollars, admins can set (default 1000) |
| `SESSION_SECRET` | Any long random string |

If a Google Ads value is missing, the pages say which one.

## How it works

- `src/lib/google-ads/client.ts` trades the refresh token for an access token and runs GAQL queries against the Google Ads API (v22). Results are cached for 10 minutes, since Explorer access allows 2,880 API operations a day.
- `src/lib/google-ads/reports.ts` holds the report queries and turns Google's micros and strings into dollars and numbers.
- `src/lib/service-area.ts` lists the Bay Area cities used to flag out-of-area spend. Edit it to change the buy box.
- `src/lib/negatives.ts` holds the rules behind suggested negative keywords. Edit them as the team learns from lead outcomes.
- `src/lib/google-ads/changes.ts` makes the changes (campaign negative keywords and location exclusions) and re-checks every input against the live account first. `src/lib/google-ads/controls.ts` does the same for campaign status, budgets, ad schedules, and ad text. The pages reach them only through the server actions in `src/app/actions/`, which check for an admin session.

## Next steps

- Sign in with Google (one login per person) instead of a shared refresh token.
- Leads from the landing page, with outcomes sent back to Google as offline conversions.
- Budget alerts: daily spend cap, spend without leads.
