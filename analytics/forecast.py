"""Budget forecast: monthly Google Ads spend -> leads -> deals -> net revenue.

Model (fit on months with complete lead data and meaningful spend):
  leads    ~ Poisson(exp(a + b*log(spend) + noise))   b < 1 = diminishing returns
  deals    ~ Binomial(leads, p),   p ~ Beta(1 + deals, 1 + leads - deals)
  net rev  = sum of deal profits resampled from the actual acquired-deal history
Outputs P10 / P50 / P90 ranges from a Monte Carlo simulation.
"""
import numpy as np
import pandas as pd

MIN_MONTHLY_SPEND = 1000
# Cost per lead has risen ~4%/month since 2024, so older months overstate what a
# dollar buys today. From 2025 on, spend explains ~70% of lead variation.
FIT_START = "2025-01-01"


def build_monthly(ads_daily, leads, deals, lead_data_end=None):
    """One row per month: spend, PPC leads, qualified+ leads, acquired deals, net revenue."""
    m = ads_daily.set_index("date").resample("MS")[["cost", "clicks", "conversions"]].sum()
    lm = leads.set_index("date").resample("MS").agg(
        leads=("stage", "size"),
        qualified=("stage", lambda s: s.isin(["appointment", "offer", "contract",
                                             "cancelled", "acquired"]).sum()),
        engaged=("stage", lambda s: s.isin(["engaged", "appointment", "offer", "contract",
                                           "cancelled", "acquired"]).sum()))
    acq = deals[deals.acquired]
    dm = acq.set_index("lead_date").resample("MS").agg(
        deals=("acquired", "size"), net_revenue=("net_revenue", "sum"))
    out = m.join(lm, how="left").join(dm, how="left").fillna(0)
    end = pd.Timestamp(lead_data_end) if lead_data_end else leads["date"].max()
    # a month only counts as having lead data if the sheet covers the whole month
    out["lead_data"] = (out.index >= leads["date"].min().to_period("M").to_timestamp()) & \
                       (out.index + pd.offsets.MonthEnd(0) <= end)
    return out


def fit(monthly, start=FIT_START):
    fit_rows = monthly[monthly.lead_data & (monthly.index >= start) &
                       (monthly.cost >= MIN_MONTHLY_SPEND) & (monthly.leads > 0)]
    x, y = np.log(fit_rows.cost.values), np.log(fit_rows.leads.values)
    b, a = np.polyfit(x, y, 1)
    resid = y - (a + b * x)
    leads_n, deals_n = fit_rows.leads.sum(), fit_rows.deals.sum()
    return {
        "intercept": a, "elasticity": b, "sigma": resid.std(ddof=2),
        "r2": 1 - resid.var() / y.var(), "months": len(fit_rows),
        "deal_prior": (1 + deals_n, 1 + leads_n - deals_n),
        "cost_per_lead": fit_rows.cost.sum() / leads_n,
        "qualified_rate": fit_rows.qualified.sum() / leads_n,
        "fit_rows": fit_rows,
    }


def simulate(model, deal_profits, budgets, months=3, fee=0, n=20000, seed=7):
    """Monte Carlo over `months` at each monthly budget. Returns a summary DataFrame."""
    rng = np.random.default_rng(seed)
    profits = np.asarray([p for p in deal_profits if pd.notna(p)])
    rows = []
    for budget in budgets:
        tot_leads = np.zeros(n)
        tot_deals = np.zeros(n)
        tot_rev = np.zeros(n)
        p = rng.beta(*model["deal_prior"], size=n)
        for _ in range(months):
            mu = np.exp(model["intercept"] + model["elasticity"] * np.log(budget) +
                        rng.normal(0, model["sigma"], size=n))
            leads = rng.poisson(mu)
            deals = rng.binomial(leads, p)
            tot_leads += leads
            tot_deals += deals
            tot_rev += np.array([rng.choice(profits, size=d).sum() if d else 0.0 for d in deals])
        cost = budget * months + fee * months
        roi = (tot_rev - cost) / cost
        pct = lambda a: np.percentile(a, [10, 50, 90])
        rows.append({
            "monthly_budget": budget, "total_cost": cost,
            **{f"leads_p{q}": v for q, v in zip((10, 50, 90), pct(tot_leads))},
            **{f"deals_p{q}": v for q, v in zip((10, 50, 90), pct(tot_deals))},
            **{f"net_rev_p{q}": v for q, v in zip((10, 50, 90), pct(tot_rev))},
            "p_zero_deals": float((tot_deals == 0).mean()),
            "p_profit": float((tot_rev > cost).mean()),
            "roi_p50": float(np.median(roi)),
        })
    return pd.DataFrame(rows)
