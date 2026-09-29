"""Landing page audit: Lighthouse (mobile) + on-page conversion checks + ad/visitor results.

Requires Node (npx lighthouse) and Chromium. Set CHROME_PATH if Chromium is not on PATH.
"""
import json
import os
import re
import socket
import subprocess
import tempfile
import urllib.parse
import urllib.request

import pandas as pd

CHROME = os.environ.get("CHROME_PATH", "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
LH_METRICS = {
    "lcp_s": "largest-contentful-paint",
    "fcp_s": "first-contentful-paint",
    "tbt_ms": "total-blocking-time",
    "cls": "cumulative-layout-shift",
}


def resolves(url):
    host = urllib.parse.urlparse(url).hostname
    try:
        # the sandbox resolves through a proxy, so ask public DNS-over-HTTPS
        with urllib.request.urlopen(f"https://dns.google/resolve?name={host}&type=A", timeout=20) as r:
            return json.loads(r.read()).get("Status") == 0
    except Exception:
        try:
            socket.gethostbyname(host)
            return True
        except OSError:
            return False


def lighthouse(url):
    with tempfile.NamedTemporaryFile(suffix=".json") as out:
        flags = "--headless=new --no-sandbox"
        if os.environ.get("HTTPS_PROXY"):
            flags += f" --proxy-server={os.environ['HTTPS_PROXY']}"
        cmd = ["npx", "-y", "lighthouse@12", url, "--quiet", "--output=json",
               f"--output-path={out.name}", "--form-factor=mobile",
               "--only-categories=performance,accessibility,best-practices,seo",
               f"--chrome-flags={flags}"]
        subprocess.run(cmd, env={**os.environ, "CHROME_PATH": CHROME},
                       capture_output=True, timeout=240)
        d = json.load(open(out.name))
    if d.get("runtimeError"):
        return {"lh_error": d["runtimeError"].get("code")}
    res = {f"lh_{k.replace('-', '_')}": round((v["score"] or 0) * 100)
           for k, v in d["categories"].items()}
    a = d["audits"]
    for key, audit in LH_METRICS.items():
        v = a.get(audit, {}).get("numericValue")
        if v is not None:
            res[key] = round(v / 1000, 1) if key.endswith("_s") else round(v, 2 if key == "cls" else 0)
    res["page_weight_kb"] = round(a.get("total-byte-weight", {}).get("numericValue", 0) / 1024)
    third = a.get("third-party-summary", {}).get("details", {}).get("items", [])
    res["third_party_blocking_ms"] = round(sum(i.get("blockingTime", 0) for i in third))
    res["top_blockers"] = ", ".join(
        str(i.get("entity", {}).get("text") if isinstance(i.get("entity"), dict) else i.get("entity"))
        for i in sorted(third, key=lambda i: -i.get("blockingTime", 0))[:3]
        if i.get("blockingTime", 0) > 100)
    return res


def page_checks(url):
    """Conversion elements a seller landing page should have above the fold / on page."""
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Linux; Android 14) Mobile"})
        with urllib.request.urlopen(req, timeout=30) as r:
            status, html = r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return {"http_status": e.code}
    except Exception as e:
        return {"http_status": None, "fetch_error": type(e).__name__}
    text = re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", html, flags=re.S | re.I)
    text = re.sub(r"\s+", " ", text)
    h1 = re.findall(r"<h1[^>]*>(.*?)</h1>", html, re.S | re.I)
    forms = len(re.findall(r"<form\b", html, re.I))
    inputs = len(re.findall(r"<input\b(?![^>]*type=[\"']?(?:hidden|submit|button))", html, re.I))
    return {
        "http_status": status,
        "h1": re.sub(r"<[^>]+>|\s+", " ", h1[0]).strip()[:90] if h1 else "",
        "h1_count": len(h1),
        "forms": forms,
        "form_fields": inputs,
        "tel_link": bool(re.search(r'href=["\']tel:', html, re.I)),
        "mentions_reviews": bool(re.search(r"review|testimonial|stars?\b|rating", text, re.I)),
        "mentions_no_fees": bool(re.search(r"no (fees|commission|repairs)|as[- ]is", text, re.I)),
        "mentions_timeline": bool(re.search(r"\b\d+\s*(days?|hours?)\b|close fast|fast close", text, re.I)),
        "word_count": len(text.split()),
        "has_posthog": "posthog" in html.lower(),
        "has_clarity": "clarity.ms" in html.lower(),
    }


def audit(pages, run_lighthouse=True):
    """pages: DataFrame with a `url` column (plus any ad/visitor stats to carry through)."""
    rows = []
    for rec in pages.to_dict("records"):
        url = rec["url"]
        row = dict(rec)
        row["dns_ok"] = resolves(url)
        if row["dns_ok"]:
            row.update(page_checks(url))
            if run_lighthouse and row.get("http_status") == 200:
                try:
                    row.update(lighthouse(url))
                except Exception as e:
                    row["lh_error"] = type(e).__name__
        rows.append(row)
    df = pd.DataFrame(rows)
    df["issues"] = df.apply(issues, axis=1)
    return df


def issues(r):
    out = []
    if not r.get("dns_ok"):
        return "Domain does not resolve: every ad click lands on an error"
    if r.get("http_status") not in (200, None):
        out.append(f"HTTP {r.get('http_status'):.0f}: page is broken")
    if pd.notna(r.get("lh_performance")) and r.get("lh_performance", 100) < 50:
        out.append(f"slow on mobile (perf {r['lh_performance']:.0f})")
    if pd.notna(r.get("tbt_ms")) and r.get("tbt_ms", 0) > 600:
        out.append(f"page frozen {r['tbt_ms'] / 1000:.1f}s by scripts")
    if pd.notna(r.get("lcp_s")) and r.get("lcp_s", 0) > 4:
        out.append(f"main content shows after {r['lcp_s']}s")
    if r.get("forms") == 0:
        out.append("no form in page HTML")
    elif r.get("form_fields", 0) > 6:
        out.append(f"{r['form_fields']:.0f} form fields (friction)")
    if r.get("tel_link") is False:
        out.append("no tap-to-call link")
    if r.get("mentions_reviews") is False:
        out.append("no reviews/testimonials")
    if r.get("has_posthog") is False and r.get("has_clarity") is False:
        out.append("no PostHog/Clarity tag found in HTML")
    return "; ".join(out)
