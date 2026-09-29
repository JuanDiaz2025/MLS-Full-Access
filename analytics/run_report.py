"""Build the Google Ads performance report.

usage: python -m analytics.run_report --leads path/to/PPC_LEAD.xlsx [--no-lighthouse] [--pages 12]

Writes reports/<date>/report.md plus CSVs for each section.
"""
import argparse
import os
from datetime import date

import pandas as pd

from . import anomalies, behavior, forecast, lp_audit, sources

BUDGETS = [5000, 10000, 15000, 20000, 30000]
AGENCY_FEE = 2000  # Bateman management fee per month


def money(x):
    return "—" if pd.isna(x) else f"${x:,.0f}"


def md_table(df, floatfmt="{:,.0f}"):
    cols = list(df.columns)
    lines = ["| " + " | ".join(map(str, cols)) + " |", "|" + "---|" * len(cols)]
    for _, r in df.iterrows():
        cells = ["—" if isinstance(v, float) and pd.isna(v) else
                 floatfmt.format(v) if isinstance(v, float) else str(v) for v in r]
        lines.append("| " + " | ".join(cells) + " |")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leads", required=True, help="PPC LEAD workbook (.xlsx)")
    ap.add_argument("--out", default=None)
    ap.add_argument("--pages", type=int, default=12, help="landing pages to audit")
    ap.add_argument("--no-lighthouse", action="store_true")
    a = ap.parse_args()
    today = date.today().isoformat()
    out = a.out or os.path.join("reports", today)
    os.makedirs(out, exist_ok=True)
    md = [f"# Google Ads report: {today}", ""]

    # ---- data
    ads = sources.ads_daily("2023-01-01", today)
    leads, deals = sources.load_leads(a.leads), sources.load_deals(a.leads)
    monthly = forecast.build_monthly(ads, leads, deals)
    monthly.to_csv(f"{out}/monthly.csv")

    # ---- forecast
    model = forecast.fit(monthly)
    fc = forecast.simulate(model, deals[deals.acquired].net_revenue, BUDGETS, months=3, fee=AGENCY_FEE)
    fc.to_csv(f"{out}/forecast.csv", index=False)
    md += ["## 1. Forecast (next 3 months)", "",
           f"Model fit on {model['months']} months since {forecast.FIT_START}: spend explains "
           f"{model['r2']:.0%} of monthly lead variation. Each +10% spend gives about "
           f"+{(1.1 ** model['elasticity'] - 1):.0%} leads (diminishing returns). "
           f"Deal rate {model['deal_prior'][0] / sum(model['deal_prior']):.1%} of leads; "
           f"median deal profit {money(deals[deals.acquired].net_revenue.median())}. "
           f"Costs include a {money(AGENCY_FEE)}/month agency fee.", ""]
    t = pd.DataFrame({
        "Monthly budget": fc.monthly_budget.map(money),
        "3-mo cost": fc.total_cost.map(money),
        "Leads (P10–P90)": fc.apply(lambda r: f"{r.leads_p10:.0f}–{r.leads_p90:.0f}", axis=1),
        "Deals (likely / range)": fc.apply(lambda r: f"{r.deals_p50:.0f} ({r.deals_p10:.0f}–{r.deals_p90:.0f})", axis=1),
        "Net revenue (median)": fc.net_rev_p50.map(money),
        "Chance of 0 deals": fc.p_zero_deals.map("{:.0%}".format),
        "Chance profit > cost": fc.p_profit.map("{:.0%}".format),
    })
    md += [md_table(t), ""]

    # ---- behavior
    s = behavior.sessions(180)
    prof = behavior.converter_profile(s)
    src = behavior.rate_table(s, "source", 20)
    dev = behavior.rate_table(s, "device", 20)
    ent = behavior.rate_table(s, "entry_page", 25).head(10)
    for name, df in {"sources": src, "devices": dev, "entry_pages": ent}.items():
        df.to_csv(f"{out}/behavior_{name}.csv")
    ttc = behavior.time_to_convert(180)
    md += ["## 2. Behavioral patterns (PostHog, last 180 days, team/staging traffic removed)", "",
           f"{len(s):,} sessions, {int(s.converted.sum())} form submits. Converters view "
           f"{prof.loc[True, 'median_pages']:.0f} pages and stay {prof.loc[True, 'median_duration_s'] / 60:.1f} min "
           f"(median); they submit {ttc.median():.0f}s after landing. "
           f"{prof.loc[True, 'rage_click_share']:.0%} of converters rage-clicked before submitting.", ""]
    for title, df in [("By traffic source", src), ("By device", dev), ("Top entry pages", ent)]:
        d = df.reset_index()[[df.index.name, "sessions", "conversions", "conv_rate", "bounce_rate"]]
        d["conv_rate"] = d.conv_rate.map("{:.1%}".format)
        d["bounce_rate"] = d.bounce_rate.map("{:.0%}".format)
        md += [f"**{title}**", "", md_table(d), ""]

    # ---- landing pages
    lp = sources.ads_landing_pages("2025-01-01", today).head(a.pages)
    lp = lp[lp.cost > 200]
    aud = lp_audit.audit(lp, run_lighthouse=not a.no_lighthouse)
    aud.to_csv(f"{out}/landing_pages.csv", index=False)
    cols = ["url", "cost", "clicks", "conversions", "lh_performance", "lcp_s", "tbt_ms", "issues"]
    d = aud[[c for c in cols if c in aud.columns]].copy()
    d["url"] = d.url.str.replace("https://www.twinhomebuyer.com", "", regex=False)
    d["cost"] = d.cost.map(money)
    d["conversions"] = d.conversions.map("{:.0f}".format)
    md += ["## 3. Landing page audit (mobile, pages with ad spend since 2025)", "", md_table(d), ""]

    # ---- anomalies
    clarity = sources.clarity_insights(3)
    hc = anomalies.health_checks(clarity)
    wk = anomalies.ads_weekly(ads)
    ads_out = anomalies.flag_outliers(wk[wk.index >= "2024-06-01"], ["cost", "cpc", "clicks", "conversions"],
                                      min_value="cost")
    site = anomalies.site_weekly(365)
    site_out = anomalies.flag_outliers(site, ["public_pageviews", "internal_or_staging_pageviews",
                                              "ad_landings", "form_submits"])
    hc.to_csv(f"{out}/health_checks.csv", index=False)
    pd.concat([ads_out.assign(source="google ads"), site_out.assign(source="site")]).to_csv(
        f"{out}/anomalies.csv", index=False)
    md += ["## 4. Anomalies and health checks", "",
           "Metric outliers compare each complete week (starting Monday) with the median of the 8 weeks before it.", "", md_table(hc) if len(hc) else "No health issues.", ""]
    recent = pd.concat([ads_out.assign(source="google ads"), site_out.assign(source="site")])
    if len(recent):
        recent = recent.sort_values("week", ascending=False).head(15)
        recent["value"] = recent.value.map("{:,.1f}".format)
        recent["baseline"] = recent.baseline.map("{:,.1f}".format)
        md += ["**Most recent metric outliers (robust z ≥ 3 vs trailing 8 weeks)**", "",
               md_table(recent[["week", "source", "metric", "direction", "value", "baseline", "z"]]), ""]

    open(f"{out}/report.md", "w").write("\n".join(md))
    print(f"wrote {out}/report.md")


if __name__ == "__main__":
    main()
