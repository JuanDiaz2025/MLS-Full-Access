"""Anomaly detection: weekly metric outliers plus hard health checks (dead pages, tracking, errors)."""
import urllib.request

import numpy as np
import pandas as pd

from .lp_audit import resolves
from .sources import POSTHOG_PUBLIC_FILTER, ads_query, clean_url, hogql

WINDOW = 8        # trailing weeks used as the baseline
Z_ALERT = 3.0     # robust z-score threshold


def robust_z(series, window=WINDOW):
    """z-score of each point vs the median/MAD of the preceding `window` points."""
    med = series.shift(1).rolling(window, min_periods=4).median()
    mad = (series.shift(1) - med).abs().rolling(window, min_periods=4).median()
    return (series - med) / (1.4826 * mad.replace(0, np.nan))


def ads_weekly(ads_daily):
    # weeks start Monday; drop the current, incomplete week
    w = (ads_daily.set_index("date")
         .resample("W-MON", label="left", closed="left")[["cost", "clicks", "impressions", "conversions"]].sum())
    w = w[w.index + pd.Timedelta(days=7) <= ads_daily["date"].max() + pd.Timedelta(days=1)]
    w["cpc"] = w.cost / w.clicks.replace(0, np.nan)
    w["ctr"] = w.clicks / w.impressions.replace(0, np.nan)
    w["cost_per_conv"] = w.cost / w.conversions.replace(0, np.nan)
    return w


def site_weekly(days=365):
    return hogql(f"""
    select toStartOfWeek(timestamp) as week,
      countIf(event = '$pageview' and {POSTHOG_PUBLIC_FILTER}) as public_pageviews,
      countIf(event = '$pageview' and not ({POSTHOG_PUBLIC_FILTER})) as internal_or_staging_pageviews,
      countIf(event = '$pageview' and properties.$current_url ilike '%gclid=%') as ad_landings,
      countIf(event = '$autocapture' and properties.$event_type = 'submit' and {POSTHOG_PUBLIC_FILTER}) as form_submits,
      countIf(event = '$rageclick') as rage_clicks
    from events where timestamp > now() - interval {days} day
      and timestamp < toStartOfWeek(now())
    group by week order by week""").set_index("week")


def flag_outliers(frame, metrics, min_value=None):
    """Return one row per (week, metric) whose robust z exceeds the threshold."""
    out = []
    for m in metrics:
        s = frame[m].astype(float)
        z = robust_z(s)
        for week, zv in z.items():
            if pd.notna(zv) and abs(zv) >= Z_ALERT and (min_value is None or frame.loc[week, min_value] > 0):
                base = s.shift(1).rolling(WINDOW, min_periods=4).median().loc[week]
                out.append({"week": pd.Timestamp(week).date(), "metric": m, "value": s.loc[week],
                            "baseline": base, "z": round(zv, 1),
                            "direction": "spike" if zv > 0 else "drop"})
    return pd.DataFrame(out)


def http_status(url):
    # a real GET with a browser user agent: the site firewall answers 403 to HEAD/bot requests
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36",
        "Accept": "text/html"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            r.read(2048)
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception:
        return None


def health_checks(clarity=None, lookback_days=120):
    """Hard failures that should never happen, regardless of history."""
    findings = []
    # 1. Enabled ads (in enabled or paused campaigns) pointing at dead domains or broken pages
    rows = ads_query(
        "SELECT campaign.name, campaign.status, ad_group_ad.ad.final_urls FROM ad_group_ad "
        "WHERE ad_group_ad.status = 'ENABLED' AND campaign.status IN ('ENABLED', 'PAUSED')")
    urls = {}
    for r in rows:
        for u in r["adGroupAd"]["ad"].get("finalUrls", []):
            urls.setdefault(clean_url(u), []).append((r["campaign"]["name"], r["campaign"]["status"]))
    dead_hosts = {h for h in {u.split("/")[2] for u in urls} if not resolves("https://" + h)}
    for url, ads in urls.items():
        host = url.split("/")[2]
        if host in dead_hosts:
            problem = "domain does not resolve"
        else:
            status = http_status(url)
            if status in (200, 301, 302, 307, 308):
                continue
            problem = f"returns HTTP {status}"
        camps = sorted({c for c, _ in ads})
        live = sorted({c for c, st in ads if st == "ENABLED"})
        findings.append({
            "severity": "critical" if live else "warning",
            "check": "broken landing page",
            "detail": f"{url} {problem}; {len(ads)} ad(s) in {len(camps)} campaign(s)"
                      + (f", {len(live)} ENABLED" if live else ", all paused: fix before re-enabling"),
            "campaigns": ", ".join(camps)[:300]})
    # 2. Conversion tracking polluted by non-lead actions
    conv = ads_query(
        "SELECT conversion_action.name, conversion_action.category, conversion_action.primary_for_goal "
        "FROM conversion_action WHERE conversion_action.status = 'ENABLED'")
    junk = [c["conversionAction"]["name"] for c in conv
            if c["conversionAction"].get("primaryForGoal")
            and c["conversionAction"]["category"] in ("PAGE_VIEW", "GET_DIRECTIONS", "ENGAGEMENT")]
    if junk:
        findings.append({"severity": "high", "check": "non-lead actions counted as conversions",
                         "detail": f"{len(junk)} primary conversion actions are page views/directions/engagement",
                         "campaigns": "; ".join(junk)})
    # 3. Site health from Clarity
    if clarity:
        err = clarity.get("ScriptErrorCount", [{}])[0].get("sessionsWithMetricPercentage")
        if err is not None and err > 10:
            findings.append({"severity": "high", "check": "JavaScript errors",
                             "detail": f"{err:.0f}% of sessions hit a script error (can break forms/tracking)",
                             "campaigns": ""})
        t = clarity.get("Traffic", [{}])[0]
        if t.get("totalSessionCount") and t.get("totalBotSessionCount", 0) > t["totalSessionCount"]:
            findings.append({"severity": "info", "check": "bot traffic",
                             "detail": f"{t['totalBotSessionCount']} bot vs {t['totalSessionCount']} human sessions (last days)",
                             "campaigns": ""})
    # 4. Internal / staging traffic polluting analytics
    internal = hogql(f"""
      select count() from events where event = '$pageview'
        and timestamp > now() - interval {lookback_days} day and not ({POSTHOG_PUBLIC_FILTER})""").iloc[0, 0]
    total = hogql(f"""select count() from events where event = '$pageview'
        and timestamp > now() - interval {lookback_days} day""").iloc[0, 0]
    if total and internal / total > 0.1:
        findings.append({"severity": "medium", "check": "internal traffic in analytics",
                         "detail": f"{internal / total:.0%} of pageviews in the last {lookback_days} days are "
                                   "staging hosts or heavy repeat visitors (team)",
                         "campaigns": ""})
    return pd.DataFrame(findings)
