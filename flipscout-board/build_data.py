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
import sys, json, datetime, collections, re
import openpyxl

# every lead the scout hasn't scored yet carries this placeholder; the board
# treats it as "no note" so the notes people actually wrote stand out
BOILERPLATE = "Condition-qualified only — ARV and profit not yet calculated"
# The first fourteen columns are the board's backbone and must not move.
FIELDS = ["Status", "MLS #", "Address", "Beds", "Baths", "SqFt", "Lot SqFt",
          "Year Built", "DOM", "Purchase Price", "$/SqFt", "Notes",
          "MLS Link", "First Added"]

# Columns the scan added later. Looked up by name and optional by design: an
# older export without them still builds, the board just shows less.
EXTRA = ["Offer Due", "Private Remarks", "MLS Status", "Occupied By",
         "Opportunity Score", "Bucket", "Price Cut", "Listing Agent",
         "Agent Phone", "Agent Email"]

# "2026-09-29 (Tue) 2:30 PM" — the scan's own offer-due format. The weekday is
# redundant with the date and the time is worth keeping separate, since a
# deadline at 10 AM and one at 5 PM are different days of work.
OFFER_DUE_CELL = re.compile(
    r"^\s*(\d{4}-\d{2}-\d{2})\s*(?:\([A-Za-z]{3}\))?\s*"
    r"(\d{1,2}:\d{2}\s*[AaPp]\.?[Mm]\.?)?")


def offer_due(cell):
    """(date, time) from the sheet's Offer Due column.

    "TBD" is kept rather than dropped: the agent said there IS a deadline and
    has not named it, which is a different state from no deadline at all and
    means somebody should call.
    """
    text = cell.strip()
    if not text:
        return "", ""
    if text.upper().startswith("TBD"):
        return "TBD", ""
    m = OFFER_DUE_CELL.match(text)
    if not m:
        return "", ""
    return m.group(1), (m.group(2) or "").upper().replace(".", "").strip()


# --- reading offer deadlines out of listing remarks ------------------------
#
# "Offers due Tuesday 5pm" is written for cooperating agents and never reaches
# a structured field, so the deadline has to be read out of the prose. Two
# rules keep this from inventing deadlines:
#
#   * a date is only taken when it FOLLOWS a phrase about offers, so a closing
#     date or an open-house time elsewhere in the remarks is never mistaken
#     for one;
#   * a weekday with no date ("offers due Tuesday") is resolved against the
#     pull date and returned with a leading "~", which the board shows as
#     approximate. It is a reading, not a fact, and it is labelled as one.
#
# Anything ambiguous returns "" — an empty cell a person fills in beats a
# confident wrong date somebody plans around.

OFFER_CUE = re.compile(
    r"\b(?:offers?\s+(?:are\s+|will\s+be\s+|to\s+be\s+)?"
    r"(?:due|reviewed|review|presented|presentation|accepted)"
    r"|offer\s+deadline|deadline\s+for\s+offers"
    r"|review(?:ing)?\s+offers|present(?:ing)?\s+offers)\b", re.I)
NO_DEADLINE = re.compile(
    r"\b(?:no\s+(?:set\s+|offer\s+)?deadline|offers?\s+as\s+(?:they\s+are\s+)?received"
    r"|as\s+they\s+come|no\s+preemptive)\b", re.I)
MDY = re.compile(r"\b(\d{1,2})\s*/\s*(\d{1,2})(?:\s*/\s*(\d{2,4}))?\b")
MONTH_DAY = re.compile(
    r"\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+"
    r"(\d{1,2})(?:st|nd|rd|th)?\b", re.I)
WEEKDAY = re.compile(r"\b(mon|tues?|wed(?:nes)?|thur?s?|fri|sat|sun)[a-z]*\b", re.I)
MONTHS = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6, "jul": 7,
          "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
WEEKDAYS = {"mon": 0, "tue": 1, "tues": 1, "wed": 2, "wednes": 2, "thu": 3,
            "thur": 3, "thurs": 3, "fri": 4, "sat": 5, "sun": 6}
# how far past the cue a date still counts as that cue's date
WINDOW = 70


def _anchor(pulled):
    try:
        y, m, d = (int(x) for x in pulled.split("-"))
        return datetime.date(y, m, d)
    except (ValueError, AttributeError):
        return datetime.date.today()


def _pick_year(month, day, anchor):
    """The year that puts this month/day nearest the pull date, not before it."""
    for year in (anchor.year, anchor.year + 1, anchor.year - 1):
        try:
            cand = datetime.date(year, month, day)
        except ValueError:
            continue
        if (cand - anchor).days >= -14:
            return cand
    return None


def parse_offer_due(text, pulled):
    """An offer deadline from listing remarks, or "". "~" marks a reading."""
    if not text:
        return ""
    cue = OFFER_CUE.search(text)
    if not cue:
        return ""
    tail = text[cue.end():cue.end() + WINDOW]
    if NO_DEADLINE.search(text[max(0, cue.start() - 20):cue.end() + WINDOW]):
        return ""
    anchor = _anchor(pulled)

    m = MDY.search(tail)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        if m.group(3):
            year = int(m.group(3))
            year += 2000 if year < 100 else 0
            try:
                return datetime.date(year, month, day).isoformat()
            except ValueError:
                return ""
        got = _pick_year(month, day, anchor)
        return got.isoformat() if got else ""

    m = MONTH_DAY.search(tail)
    if m:
        month = MONTHS[m.group(1).lower()[:3]]
        got = _pick_year(month, int(m.group(2)), anchor)
        return got.isoformat() if got else ""

    m = WEEKDAY.search(tail)
    if m:
        key = m.group(1).lower()
        want = WEEKDAYS.get(key, WEEKDAYS.get(key[:3]))
        if want is None:
            return ""
        ahead = (want - anchor.weekday()) % 7 or 7
        return "~" + (anchor + datetime.timedelta(days=ahead)).isoformat()

    return ""


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
    full = [cell(h) for h in grid[0]]
    header = full[:len(FIELDS)]
    if header != FIELDS:
        raise SystemExit(
            "The Leads tab's columns have changed, so the board would be built "
            "from the wrong fields. Stop and re-map them.\n"
            "  expected: %s\n  found:    %s" % (FIELDS, header))
    at = {name: full.index(name) for name in EXTRA if name in full}

    rows = []
    for raw in grid[1:]:
        r = {FIELDS[i]: cell(raw[i]) for i in range(len(FIELDS))}
        if not r["MLS #"] and not r["Address"]:
            continue
        get = lambda name: cell(raw[at[name]]) if name in at else ""
        note = "" if r["Notes"] == BOILERPLATE else r["Notes"]

        # The sheet's own Offer Due column is authoritative. Only when it is
        # empty do we fall back to reading a deadline out of the remarks, and
        # that reading stays marked approximate.
        due, due_time = offer_due(get("Offer Due"))
        if not due:
            remarks = " ".join(x for x in (note, get("Private Remarks")) if x)
            due = parse_offer_due(remarks, r["First Added"])

        rows.append([
            r["MLS #"], r["Address"], number(r["Purchase Price"]),
            number(r["$/SqFt"]), number(r["SqFt"]), number(r["Beds"]),
            number(r["Year Built"]), number(r["DOM"]),
            note, r["First Added"],
            due, due_time,
            get("MLS Status"), get("Occupied By"),
            number(get("Opportunity Score")),
            get("Bucket").split("—")[0].strip(),   # "A — Work Now" -> "A"
            get("Price Cut"), get("Listing Agent"),
            get("Agent Phone"), get("Agent Email"),
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
    dues = [x for x in payload["rows"] if x[10]]
    read = [x for x in dues if x[10].startswith("~")]
    tbd = [x for x in dues if x[10] == "TBD"]
    print("offer deadlines: %d (%d dated from the sheet, %d TBD, %d read from remarks)"
          % (len(dues), len(dues) - len(read) - len(tbd), len(tbd), len(read)))
    market = collections.Counter(x[12] for x in payload["rows"] if x[12])
    if market:
        print("MLS status: " + ", ".join("%s %d" % (k, v) for k, v in market.most_common()))
    occ = collections.Counter(x[13] for x in payload["rows"] if x[13])
    if occ:
        print("occupancy:  " + ", ".join("%s %d" % (k, v) for k, v in occ.most_common(4)))


if __name__ == "__main__":
    main()
