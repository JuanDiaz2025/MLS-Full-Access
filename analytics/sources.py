"""Data connectors: Google Ads, PostHog, Microsoft Clarity and the PPC lead workbook.

Credentials come from environment variables only (see analytics/README.md).
"""
import json
import os
import re
import urllib.parse
import urllib.request
from functools import lru_cache

import pandas as pd

ADS_API = "https://googleads.googleapis.com/v22"
ADS_CUSTOMER_ID = os.environ.get("GOOGLE_ADS_CUSTOMER_ID", "9897155298").replace("-", "")

# CRM "Score Card Number" -> funnel stage used across reports.
# Older rows use "5 Appointment booked"; newer CRM uses "3 Appointment Booked".
# We read the score *text* so both scales map correctly.
STAGE_RULES = [
    ("acquired", r"^10\b|acquired"),
    ("cancelled", r"cancel"),
    ("contract", r"under contract|clear to close|reinstated"),
    ("offer", r"offer sent|contract sent|initial offer"),
    ("appointment", r"appointment"),
    ("unresponsive", r"not interested|unresponsive|new lead"),
    ("engaged", r"follow up|interested|offer rejected|price too low"),
    ("invalid", r"invalid|lost|dead"),
]
STAGE_ORDER = ["invalid", "unresponsive", "engaged", "appointment", "offer",
               "contract", "cancelled", "acquired"]


def _http(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read())


# ---------- Google Ads ----------

@lru_cache(maxsize=1)
def _ads_token():
    body = urllib.parse.urlencode({
        "client_id": os.environ["GOOGLE_ADS_CLIENT_ID"],
        "client_secret": os.environ["GOOGLE_ADS_CLIENT_SECRET"],
        "refresh_token": os.environ["GOOGLE_ADS_REFRESH_TOKEN"],
        "grant_type": "refresh_token",
    }).encode()
    return _http("https://oauth2.googleapis.com/token", body)["access_token"]


def ads_query(gaql, customer_id=ADS_CUSTOMER_ID):
    """Run a GAQL query, following pagination. Returns a list of result rows."""
    headers = {
        "Authorization": f"Bearer {_ads_token()}",
        "developer-token": os.environ["GOOGLE_ADS_DEVELOPER_TOKEN"],
        "Content-Type": "application/json",
    }
    rows, page = [], None
    while True:
        payload = {"query": gaql}
        if page:
            payload["pageToken"] = page
        d = _http(f"{ADS_API}/customers/{customer_id}/googleAds:search",
                  json.dumps(payload).encode(), headers)
        rows += d.get("results", [])
        page = d.get("nextPageToken")
        if not page:
            return rows


def ads_daily(start="2023-01-01", end=None):
    """Account-level daily spend, clicks, impressions and conversions."""
    end = end or pd.Timestamp.today().strftime("%Y-%m-%d")
    rows = ads_query(
        "SELECT segments.date, metrics.cost_micros, metrics.clicks, metrics.impressions, "
        "metrics.conversions FROM customer "
        f"WHERE segments.date BETWEEN '{start}' AND '{end}'")
    df = pd.DataFrame([{
        "date": r["segments"]["date"],
        "cost": int(r["metrics"].get("costMicros", 0)) / 1e6,
        "clicks": int(r["metrics"].get("clicks", 0)),
        "impressions": int(r["metrics"].get("impressions", 0)),
        "conversions": float(r["metrics"].get("conversions", 0)),
    } for r in rows])
    df["date"] = pd.to_datetime(df["date"])
    return df.sort_values("date").reset_index(drop=True)


def ads_landing_pages(start, end=None):
    """Spend, clicks and conversions per landing page URL (tracking templates stripped)."""
    end = end or pd.Timestamp.today().strftime("%Y-%m-%d")
    rows = ads_query(
        "SELECT campaign.name, landing_page_view.unexpanded_final_url, metrics.cost_micros, "
        "metrics.clicks, metrics.conversions FROM landing_page_view "
        f"WHERE segments.date BETWEEN '{start}' AND '{end}' AND metrics.clicks > 0")
    df = pd.DataFrame([{
        "campaign": r["campaign"]["name"],
        "url": clean_url(r["landingPageView"]["unexpandedFinalUrl"]),
        "cost": int(r["metrics"].get("costMicros", 0)) / 1e6,
        "clicks": int(r["metrics"].get("clicks", 0)),
        "conversions": float(r["metrics"].get("conversions", 0)),
    } for r in rows])
    if df.empty:
        return df
    return (df.groupby("url", as_index=False)
              .agg(cost=("cost", "sum"), clicks=("clicks", "sum"),
                   conversions=("conversions", "sum"),
                   campaigns=("campaign", lambda s: ", ".join(sorted(set(s)))))
              .sort_values("cost", ascending=False))


def clean_url(u):
    u = re.split(r"\{ignore\}|\?|#", u)[0]
    return u if u.endswith("/") or "." in u.rsplit("/", 1)[-1] else u + "/"


# ---------- PostHog ----------

def hogql(query):
    host = os.environ.get("POSTHOG_HOST", "https://us.posthog.com")
    pid = os.environ["POSTHOG_PROJECT_ID"]
    d = _http(f"{host}/api/projects/{pid}/query/",
              json.dumps({"query": {"kind": "HogQLQuery", "query": query}}).encode(),
              {"Authorization": f"Bearer {os.environ['POSTHOG_API_KEY']}",
               "Content-Type": "application/json"})
    return pd.DataFrame(d.get("results", []), columns=d.get("columns"))


# Traffic that is not a prospective seller: staging/dev hosts and heavy repeat
# visitors (the team editing pages generated thousands of views in June 2026).
POSTHOG_PUBLIC_FILTER = (
    "properties.$host in ('www.twinhomebuyer.com', 'twinhomebuyer.com') "
    "and person_id not in (select person_id from events where event = '$pageview' "
    "group by person_id having count() > 150)")


# ---------- Clarity ----------

def clarity_insights(days=3, dimension=None):
    """Clarity live insights for the last 1-3 days (API limit: ~10 calls/day)."""
    qs = {"numOfDays": days}
    if dimension:
        qs["dimension1"] = dimension
    url = ("https://www.clarity.ms/export-data/api/v1/project-live-insights?"
           + urllib.parse.urlencode(qs))
    d = _http(url, headers={"Authorization": f"Bearer {os.environ['CLARITY_API_TOKEN']}"})
    return {m["metricName"]: m["information"] for m in d}


# ---------- Lead workbook (Google Sheet "PPC LEAD" exported as .xlsx) ----------

def _stage(score_text):
    t = str(score_text).lower()
    for stage, pat in STAGE_RULES:
        if re.search(pat, t):
            return stage
    return None


def load_leads(path):
    """PPC leads (organic/SEO excluded) with a normalized funnel stage."""
    df = pd.read_excel(path, sheet_name="PPC LEAD Extract")
    df = df[df["Tagging"].notna()].copy()
    df = df[~df["Tagging"].str.contains("Organic|SEO", case=False, na=False)]
    date = pd.to_datetime(df.iloc[:, 1], errors="coerce")
    df["date"] = date.fillna(pd.to_datetime(df["Time Stamp"], errors="coerce"))
    df["stage"] = df["Score Card"].map(_stage)
    df["channel"] = df["Tagging"].str.contains("Call", case=False).map({True: "call", False: "form"})
    df["gclid"] = df["WEB ID NO."].astype(str).str.extract(r"(?:GCLID:\s*)?([A-Za-z0-9_-]{30,})")[0]
    keep = ["date", "Tagging", "channel", "Score Card", "stage", "Cities", "Zip Code",
            "UTM Campaign", "gclid"]
    return df[keep].rename(columns={"Tagging": "tagging", "Score Card": "score",
                                    "Cities": "city", "Zip Code": "zip",
                                    "UTM Campaign": "utm_campaign"})


def load_deals(path):
    """Acquired / cancelled PPC deals with purchase, sale and net revenue."""
    df = pd.read_excel(path, sheet_name="Acquired Leads")
    df = df[df["Score Card"].notna()].copy()
    df["lead_date"] = pd.to_datetime(df["Date Added"], errors="coerce")
    df["acquired"] = df["Score Card"].astype(str).str.startswith("10")
    for c in ["Purchase Price", "Sale Price", "Net Revenue"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df[["lead_date", "acquired", "Score Card", "City", "Tagging", "Date Acquired",
               "Date Sold", "Purchase Price", "Sale Price", "Net Revenue"]].rename(columns={
        "Score Card": "score", "City": "city", "Tagging": "tagging",
        "Date Acquired": "date_acquired", "Date Sold": "date_sold",
        "Purchase Price": "purchase_price", "Sale Price": "sale_price",
        "Net Revenue": "net_revenue"})
