#!/usr/bin/env python3
"""Make the Historical agent's history.js from the Master Property List page.

    python3 -I history.py <master list page .html> <out dir> [--cap 1500000]

The Master Property List (Cherry's artifact) keeps every property on record as
JSON in its <script id="board-state">. Only deals we can trust go in (Seth,
21 Oct: "for those that are blank do not include them yet ... be picky"):

  - status Sold, with a purchase price, a sale price AND a net profit
    (the net is the QuickBooks P&L figure; a spread is not a profit);
  - in one of the nine Bay Area counties the board covers;
  - bought at or under the cap ($1.5M for now — Seth, 21 Oct);
  - at least one of the two dates known, and no unresolved status in the notes.

Everything else — Novato with no purchase price, Gmail prospects, the guide's
SF case studies with no net yet — stays out until its numbers are in. The
script prints what it left out and why.

<out>/history.js = window.__HIST__ = {v, built, cap, src, deals: [{a, c, z, co, b, s, n, ad, sd, mo, unit}]}.
No owner names and no notes leave this script.
"""
import datetime
import json
import os
import re
import sys

# The board's nine counties, city by city (the same lists as COUNTIES on the board page).
COUNTIES = {
    "San Francisco": "San Francisco",
    "San Mateo": "Daly City|Pacifica|South San Francisco|Redwood City|San Bruno|San Mateo|Menlo Park|East Palo Alto|Belmont|El Granada|San Carlos|Burlingame|Foster City|Millbrae|La Honda|Half Moon Bay|Woodside|Moss Beach|Montara|Atherton|Portola Valley|Brisbane|Colma|Hillsborough|Pescadero|Emerald Hills",
    "Santa Clara": "San Jose|Morgan Hill|Gilroy|Santa Clara|Milpitas|Campbell|Sunnyvale|Los Gatos|San Martin|Mountain View|Palo Alto|Cupertino|Saratoga|Los Altos|Monte Sereno",
    "Alameda": "Oakland|Berkeley|San Leandro|Hayward|Fremont|Livermore|Union City|Castro Valley|Newark|Albany|Alameda|Dublin|Pleasanton|Sunol|San Lorenzo|Emeryville|Piedmont",
    "Contra Costa": "Richmond|Antioch|Pittsburg|Concord|Martinez|Pleasant Hill|Oakley|Walnut Creek|Orinda|Brentwood|Lafayette|Clayton|Discovery Bay|San Pablo|El Sobrante|El Cerrito|Pacheco|San Ramon|North Richmond|Moraga|Danville|Pinole|Bay Point|Kensington|Hercules|Rodeo|Crockett|Byron|Knightsen|Alamo",
    "Marin": "San Rafael|Mill Valley|Novato|San Anselmo|Fairfax|Bolinas|Larkspur|Corte Madera|Woodacre|Sausalito|Tiburon|Greenbrae|Kentfield|Point Reyes Station|Inverness|Stinson Beach|Forest Knolls|Lagunitas",
    "Sonoma": "Santa Rosa|Sebastopol|Petaluma|Guerneville|Sonoma|Cloverdale|Rohnert Park|Healdsburg|Windsor|Cotati|Occidental|Monte Rio|Forestville|Glen Ellen|Timber Cove|The Sea Ranch|Bodega Bay|Kenwood|Geyserville|Penngrove|Cazadero|Jenner",
    "Napa": "Napa|Saint Helena|St Helena|American Canyon|Calistoga|Yountville|Angwin",
    "Solano": "Vallejo|Vacaville|Fairfield|Suisun City|Dixon|Benicia|Rio Vista|Winters",
}
CITY_COUNTY = {c.lower(): k for k, v in COUNTIES.items() for c in v.split("|")}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
UNRESOLVED = re.compile(r"STATUS CONFLICT|resale unresolved|NOT AN ACQUISITION", re.I)
UNIT = re.compile(r"(#|\bunit\b|\bapt\b|\bspc\b)", re.I)


def num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def months(a, b):
    if not (ISO.match(a or "") and ISO.match(b or "")):
        return None
    d = (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days
    return round(d / 30.44, 1) if d >= 0 else None


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        sys.exit(__doc__)
    src, out = args[0], args[1]
    cap = int(args[args.index("--cap") + 1]) if "--cap" in args else 1500000
    page = open(src, encoding="utf8").read()
    m = re.search(r'<script id="board-state" type="application/json">(.*?)</script>', page, re.S)
    if not m:
        sys.exit("no board-state JSON in " + src)
    items = json.loads(m.group(1)).get("items") or []
    deals, left = [], {}
    for x in items:
        if x.get("status") != "Sold":
            continue
        addr, cityline = str(x.get("address") or "").strip(), str(x.get("city") or "")
        city = re.sub(r",.*", "", cityline).strip()
        zm = re.search(r"\b(\d{5})\b", cityline)
        b, s, n = num(x.get("purchase")), num(x.get("sale")), num(x.get("net"))
        why = ""
        if b is None or s is None or n is None:
            why = "a blank: " + ", ".join(k for k, v in (("purchase", b), ("sale", s), ("net", n)) if v is None)
        elif city.lower() not in CITY_COUNTY:
            why = "outside the Bay Area (" + city + ")"
        elif b > cap:
            why = "bought over the $%s cap" % format(cap, ",")
        elif not (x.get("acquired") or x.get("sold")):
            why = "no dates"
        elif UNRESOLVED.search(str(x.get("notes") or "")):
            why = "status unresolved in the notes"
        if why:
            left.setdefault(why.split(" (")[0].split(":")[0], []).append(addr + ", " + city)
            continue
        ad, sd = str(x.get("acquired") or ""), str(x.get("sold") or "")
        deals.append({"a": addr, "c": city, "z": zm.group(1) if zm else "", "co": CITY_COUNTY[city.lower()],
                      "b": b, "s": s, "n": n, "ad": ad, "sd": sd, "mo": months(ad, sd), "unit": bool(UNIT.search(addr))})
    deals.sort(key=lambda d: d["sd"] or d["ad"])
    os.makedirs(out, exist_ok=True)
    body = {"v": 1, "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "cap": cap,
            "src": "Master Property List — net from the Equity Track Inc QuickBooks P&L by property", "deals": deals}
    with open(os.path.join(out, "history.js"), "w", encoding="utf8") as f:
        f.write("window.__HIST__ = " + json.dumps(body, ensure_ascii=False, separators=(",", ":")) + ";\n")
    print("deals kept: %d (%d made money, %d lost)" % (len(deals), sum(d["n"] > 0 for d in deals), sum(d["n"] < 0 for d in deals)))
    for d in deals:
        print("  %-24s %-15s bought %9s sold %9s net %+9d %s" % (d["a"][:24], d["c"][:15], format(d["b"], ","), format(d["s"], ","), d["n"],
                                                                 "%.1f mo" % d["mo"] if d["mo"] is not None else "months unknown"))
    for why, ls in sorted(left.items(), key=lambda kv: -len(kv[1])):
        print("left out, %s: %d%s" % (why, len(ls), (" — " + "; ".join(ls)) if len(ls) <= 6 else ""))
    print("NEW FILES: history.js")


if __name__ == "__main__":
    main()
