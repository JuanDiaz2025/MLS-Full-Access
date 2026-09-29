"""Behavioral patterns from PostHog: what separates sessions that submit a form from ones that don't."""
import pandas as pd

from .sources import POSTHOG_PUBLIC_FILTER, hogql

SESSIONS_SQL = """
select
  properties.$session_id as session,
  min(timestamp) as started,
  argMin(properties.$pathname, timestamp) as entry_page,
  argMin(properties.$current_url, timestamp) as entry_url,
  argMin(properties.$referring_domain, timestamp) as referrer,
  any(properties.$device_type) as device,
  any(properties.$geoip_city_name) as city,
  countIf(event = '$pageview') as pageviews,
  dateDiff('second', min(timestamp), max(timestamp)) as duration_s,
  max(toFloat(properties.$prev_pageview_max_scroll_percentage)) as max_scroll,
  countIf(event = '$autocapture' and properties.$event_type = 'submit') as submits,
  countIf(event = '$autocapture' and properties.$event_type = 'click'
          and (properties.$el_text ilike '%call%' or toString(properties.$elements_chain) ilike '%tel:%')) as call_clicks,
  countIf(event = '$rageclick') as rage_clicks
from events
where timestamp > now() - interval {days} day
  and properties.$session_id is not null
  and {public}
group by session
having pageviews > 0
limit 50000
"""


def sessions(days=180):
    df = hogql(SESSIONS_SQL.format(days=days, public=POSTHOG_PUBLIC_FILTER))
    df["started"] = pd.to_datetime(df["started"], utc=True, format="ISO8601").dt.tz_convert("America/Los_Angeles")
    url = df["entry_url"].fillna("").str.lower()
    ref = df["referrer"].fillna("").str.lower()
    df["source"] = "direct/other"
    df.loc[ref.str.contains("google|bing|duckduckgo|yahoo"), "source"] = "organic search"
    df.loc[ref.str.contains("facebook|instagram|fb\\."), "source"] = "social"
    df.loc[url.str.contains("gclid=|gbraid=|wbraid=|utm_medium=cpc|utm_medium=ppc"), "source"] = "google ads"
    df["converted"] = df["submits"] > 0
    df["hour"] = df["started"].dt.hour
    df["weekday"] = df["started"].dt.day_name()
    df["bounced"] = (df["pageviews"] == 1) & (df["duration_s"] < 10)
    return df


def rate_table(df, col, min_sessions=30):
    g = df.groupby(col).agg(sessions=("session", "size"), conversions=("converted", "sum"),
                            bounce_rate=("bounced", "mean"), median_pages=("pageviews", "median"),
                            median_scroll=("max_scroll", "median"))
    g["conv_rate"] = g.conversions / g.sessions
    return g[g.sessions >= min_sessions].sort_values("conv_rate", ascending=False)


def converter_profile(df):
    """Median behavior of converting vs non-converting sessions."""
    return df.groupby("converted").agg(
        sessions=("session", "size"), median_pages=("pageviews", "median"),
        median_duration_s=("duration_s", "median"), median_scroll=("max_scroll", "median"),
        mobile_share=("device", lambda s: (s == "Mobile").mean()),
        rage_click_share=("rage_clicks", lambda s: (s > 0).mean()))


def time_to_convert(days=180):
    """Seconds from landing to first form submit, for converting sessions."""
    q = f"""
    select properties.$session_id s,
      dateDiff('second', min(timestamp),
               minIf(timestamp, event = '$autocapture' and properties.$event_type = 'submit')) secs
    from events
    where timestamp > now() - interval {days} day and {POSTHOG_PUBLIC_FILTER}
      and properties.$session_id is not null
    group by s
    having countIf(event = '$autocapture' and properties.$event_type = 'submit') > 0
    limit 50000
    """
    return hogql(q)["secs"]
