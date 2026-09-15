#!/usr/bin/env python3
"""Turn the MLS sheet's Leads tab into the board's data.js.

    python3 build_data.py leads.xlsx flipscout-board/data.js

`leads.xlsx` is the Google Sheet exported as xlsx (mime type
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet).
Export the whole workbook, not one tab — a CSV export only carries the
first tab, and the leads live on "Leads".

Emits `window.__MLS__ = {pulled, dates, rows}` where each row is
[mls, address, price, ppsf, sqft, beds, year, dom, note, pull_date].
The board derives the MLS link from the MLS number, so the sheet's link
column is dropped.

Team edits (removals, statuses) are NOT in this file — they live in the
artifact's own database, keyed by pull date + MLS number, so rebuilding
this file never disturbs them.
"""
import sys, json, datetime, collections
import openpyxl

# every lead the scout hasn't scored yet carries this placeholder; the board
# treats it as "no note" so the notes people actually wrote stand out
BOILERPLATE = "Condition-qualified only — ARV and profit not yet calculated"
FIELDS = ["Status", "MLS #", "Address", "Beds", "Baths", "SqFt", "Lot SqFt",
          "Year Built", "DOM", "Purchase Price", "$/SqFt", "Notes",
          "MLS Link", "First Added"]


def cell(v):
    if v is None:
        return ""
    if isinstance(v, (datetime.datetime, datetime.date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, float) and v == int(v):
        return str(int(v))
    return str(v).strip()


def number(s):
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return None


def build(xlsx_path):
    ws = openpyxl.load_workbook(xlsx_path, data_only=True)["Leads"]
    grid = list(ws.iter_rows(min_row=1, values_only=True))
    header = [cell(h) for h in grid[0][:len(FIELDS)]]
    if header != FIELDS:
        raise SystemExit(
            "The Leads tab's columns have changed, so the board would be built "
            "from the wrong fields. Stop and re-map them.\n"
            "  expected: %s\n  found:    %s" % (FIELDS, header))

    rows = []
    for raw in grid[1:]:
        r = {FIELDS[i]: cell(raw[i]) for i in range(len(FIELDS))}
        if not r["MLS #"] and not r["Address"]:
            continue
        rows.append([
            r["MLS #"], r["Address"], number(r["Purchase Price"]),
            number(r["$/SqFt"]), number(r["SqFt"]), number(r["Beds"]),
            number(r["Year Built"]), number(r["DOM"]),
            "" if r["Notes"] == BOILERPLATE else r["Notes"], r["First Added"],
        ])

    # cheapest per square foot first within each pull date — how the team reads it
    rows.sort(key=lambda x: (x[9], x[3] if x[3] is not None else 10 ** 9))
    dates = sorted({x[9] for x in rows if x[9]}, reverse=True)
    return {"pulled": dates[0] if dates else "", "dates": dates, "rows": rows}


def main():
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    payload = build(sys.argv[1])
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        f.write("window.__MLS__=" +
                json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + ";")

    by_date = collections.Counter(x[9] for x in payload["rows"])
    print("%d leads across %d pull dates -> %s"
          % (len(payload["rows"]), len(payload["dates"]), sys.argv[2]))
    for d in payload["dates"][:5]:
        print("   %s  %d" % (d, by_date[d]))


if __name__ == "__main__":
    main()
