"""Find upcoming open houses for active San Francisco leads on the board.

    python3 -I scan.py <data.js> <verdicts.json> > candidates.json

data.js is the board's published lead file (read it with the Artifact tool,
path "data.js", from https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1).
The schedule comes from the public MLSListings page; Redfin blocks us.
Leads already judged RENOVATED or DATED in verdicts.json are skipped, so a
rejected house is never looked at (or added) again.
"""
import html, json, re, subprocess, sys, time

# San Francisco only (Bryan, 26 Oct).
AREA = re.compile(r", San Francisco, CA", re.I)

GONE = re.compile(r"sold|withdrawn|expired|cancel|off.?market|closed|duplicate|pending|contingent", re.I)
SLOT = re.compile(r"(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, (\w+) (\d+) ([\d:]+ [ap]m) - ([\d:]+ [ap]m)")
MONTHS = {m: i + 1 for i, m in enumerate("January February March April May June July August September October November December".split())}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0"


def t24(s):
    h, m = map(int, s[:-3].split(":"))
    return f"{h % 12 + (12 if s.endswith('pm') else 0):02d}:{m:02d}"


def page(mls):
    r = subprocess.run(["curl", "-sSL", "--max-time", "25", "-A", UA, "https://www.mlslistings.com/Property/" + mls],
                       capture_output=True, timeout=40)
    return r.stdout.decode("utf-8", "ignore")


def main(data_js, verdicts_json):
    t = open(data_js, encoding="utf-8").read()
    rows = json.loads(t[t.index("{"):t.rindex("}") + 1])["rows"]
    verdicts = json.load(open(verdicts_json))
    year = time.localtime().tm_year
    out = []
    for r in rows:
        mls, addr, status = str(r[0]), r[1] or "", str(r[14] if len(r) > 14 else "")
        if not re.fullmatch(r"[A-Z0-9]{5,20}", mls) or not AREA.search(addr) or GONE.search(status):
            continue
        if verdicts.get(mls, {}).get("v") in ("RENOVATED", "DATED"):
            continue
        h = page(mls)
        time.sleep(1)
        i = h.find("Upcoming Open Houses")
        if i < 0:
            continue
        s = re.sub(r"<script.*?</script>|<style.*?</style>", "", h[i:i + 8000], flags=re.S)
        s = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s)))
        slots = [{"start": f"{year}-{MONTHS[m[2]]:02d}-{int(m[3]):02d}T{t24(m[4])}:00",
                  "end": f"{year}-{MONTHS[m[2]]:02d}-{int(m[3]):02d}T{t24(m[5])}:00"} for m in SLOT.finditer(s)]
        if slots:
            out.append({"mls": mls, "addr": addr, "verdict": verdicts.get(mls, {}).get("v", ""), "slots": slots})
    json.dump(out, sys.stdout, indent=1)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
