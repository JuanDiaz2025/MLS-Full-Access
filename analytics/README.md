# Google Ads analytics

Weekly report for Twin Home Buyer's Google Ads (account 989-715-5298): forecast,
behavioral patterns, landing page audit and anomaly detection.

## Setup

Environment variables (set in the Claude Code environment settings; never commit them):

| Variable | Used for |
|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_REFRESH_TOKEN`, `GOOGLE_ADS_CUSTOMER_ID` | Google Ads API |
| `POSTHOG_API_KEY` (read-only personal key), `POSTHOG_PROJECT_ID` (421236), `POSTHOG_HOST` (`https://us.posthog.com`) | Site behavior |
| `CLARITY_API_TOKEN` | Site errors, bots (API returns only the last 1–3 days, ~10 calls/day) |

Lead outcomes come from the "PPC LEAD" Google Sheet (REI Blackbook has no API).
Export it as .xlsx and pass the path; keep it out of git (it contains contact details).

```
pip install -r analytics/requirements.txt
python -m analytics.run_report --leads data/PPC_LEAD.xlsx          # full report (~5 min)
python -m analytics.run_report --leads data/PPC_LEAD.xlsx --no-lighthouse
```

The landing page audit needs Node (`npx lighthouse`) and Chromium (`CHROME_PATH`).

Output: `reports/<date>/report.md` plus CSVs per section.

## How the numbers are defined

- **Leads**: PPC rows in the sheet (Tagging = PPC Webform or Incoming Call); organic/SEO excluded.
- **Stage**: mapped from the Score Card text (`sources.STAGE_RULES`), so the old
  (5 = appointment) and new (3 = appointment) CRM scales both work.
- **Deals / net revenue**: "Acquired Leads" tab, attributed to the month the lead came in.
- **Forecast** (`forecast.py`): log-log fit of monthly leads on spend since 2025-01
  (older months overstate what a dollar buys today), deal rate with a Beta prior,
  deal profits resampled from actual deals; P10/P50/P90 from 20k simulations.
  Costs are Google Ads spend only.
- **Behavior** (`behavior.py`): PostHog sessions; a conversion is a form submit.
  Staging hosts and visitors with >150 pageviews (the team) are excluded.
- **Anomalies** (`anomalies.py`): robust z-score (median/MAD of the prior 8 weeks) on
  weekly Ads and site metrics, plus hard checks: broken/dead landing pages on ads,
  non-lead conversion actions, JavaScript error rate, bot and internal traffic.
