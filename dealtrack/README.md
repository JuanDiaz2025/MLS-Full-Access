# DealTrack

Google Ads results for Twin Home Buyer, built from the AdPilot hackathon app.

It reads one Google Ads account (read-only; it never changes your ads) and shows:

- **Overview:** spend, clicks, conversions, cost per conversion, daily trends, and what needs attention.
- **Campaigns:** every campaign that ran in the period, including paused and removed ones.
- **Search terms:** what people typed, which terms spent money without converting, and suggested negative keywords you can copy into Google Ads.
- **Keywords:** each keyword marked "Stop or fix" (spent $100+ without converting) or "Scale" (converting cheaper than average).
- **Locations:** spend by city, with anything outside the nine Bay Area counties flagged.
- **Day & hour:** a heat map of spend and conversions by weekday and hour.
- **Conversions:** what Google counts as a conversion, with a warning if a primary conversion isn't really a lead.

Every page has date presets (including the Bateman period, Jun 5 – Jul 23, 2026) and a custom from/to range.

## Run it

1. Install [Node.js](https://nodejs.org) 20 or newer.
2. In this folder, copy `.env.example` to `.env.local` and fill in the values (below).
3. Run:

   ```bash
   npm install
   npm run dev
   ```

4. Open http://localhost:3000.

**Windows:** double-click `start.bat`. The first time, it creates `.env.local` and opens it in Notepad so you can paste in the keys. Run it again after saving, and it installs everything and opens the dashboard.

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
| `APP_PASSWORD` | A team password you choose. Required online; optional on your computer |
| `SESSION_SECRET` | Any long random string |

If a Google Ads value is missing, the pages say which one.

## How it works

- `src/lib/google-ads/client.ts` trades the refresh token for an access token and runs GAQL queries against the Google Ads API (v22). Results are cached for 10 minutes, since Explorer access allows 2,880 API operations a day.
- `src/lib/google-ads/reports.ts` holds the report queries and turns Google's micros and strings into dollars and numbers.
- `src/lib/service-area.ts` lists the Bay Area cities used to flag out-of-area spend. Edit it to change the buy box.
- `src/lib/negatives.ts` holds the rules behind suggested negative keywords. Edit them as the team learns from lead outcomes.

## Next steps

- Sign in with Google (one login per person) instead of a shared refresh token.
- Leads from the landing page, with outcomes sent back to Google as offline conversions.
- Budget alerts: daily spend cap, spend without leads.
