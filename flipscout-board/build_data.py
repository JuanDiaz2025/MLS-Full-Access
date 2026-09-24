#!/usr/bin/env python3
"""Turn the MLS sheet's Leads tab into the board's data.js.

    python3 build_data.py leads.xlsx flipscout-board/data.js

`leads.xlsx` is the Google Sheet exported as xlsx (mime type
application/vnd.openxmlformats-officedocument.spreadsheetml.sheet).
Export the whole workbook, not one tab — a CSV export only carries the
first tab, and the leads live on "Leads".

Emits `window.__MLS__ = {pulled, dates, rows}` where each row is
[mls, address, price, ppsf, sqft, beds, year, dom, note, pull_date, offer_due,
 agent_phone, agent_email, agent_name, mls_status, offer_time, offer_from,
 offer_phrase, agent_remarks, showing, bucket, score, why, occupied, price_cut].
Everything from `offer_due` on comes from the columns the FlipScout app writes
at the end of the Leads tab; an older sheet without them gives "".

`cols` in the payload names every field in order. Read rows through it rather
than by literal index — two boards already share this file, and appending a
field must never shift one of them out from under the other.
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
FIELDS = ["Status", "MLS #", "Address", "Beds", "Baths", "SqFt", "Lot SqFt",
          "Year Built", "DOM", "Purchase Price", "$/SqFt", "Notes",
          "MLS Link", "First Added"]


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


# The app writes Offer Due as "2026-09-28 (Mon) 5:00 PM", "2026-09-28 (Mon)"
# or "TBD" — read off the listing, so it beats a guess from the Notes text.
SHEET_DUE = re.compile(r"^(\d{4}-\d{2}-\d{2})(?:\s*\(\w+\))?(?:\s+(\d{1,2}:\d{2} [AP]M))?")


def sheet_offer(value):
    """(date, time, phrase) from the app's Offer Due cell."""
    m = SHEET_DUE.match(value or "")
    if m:
        return m.group(1), m.group(2) or "", ""
    if re.match(r"^T\.?B\.?D\b", value or "", re.I):
        return "", "", "Offer date TBD"
    return "", "", ""


# The sentence an offer date was read from, so the board can quote it and
# highlight it in the agent's remarks.
OFFER_SENTENCE = re.compile(
    r"[^.!?\n]*\boffers?\b[^.!?\n]*(?:\d|\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\bTBD\b)(?:[^!?\n]*?(?:[ap]\.m\.|[.!?](?=\s|$))|[^.!?\n]*)", re.I)


def offer_sentence(text):
    m = OFFER_SENTENCE.search(text or "")
    return re.sub(r"\s+", " ", m.group(0)).strip()[:200] if m else ""


# The row layout, named. Append here, never insert: boards read rows through
# this list, and shifting an index silently rewrites every lead on screen.
COLUMNS = ["mls", "addr", "price", "ppsf", "sqft", "beds", "year", "dom",
           "note", "date", "sdue", "phone", "email", "agent", "mstat",
           "dtime", "dfrom", "dphrase", "remarks", "showing", "bucket",
           "score", "why", "occ", "cut"]


def build(xlsx_path):
    ws = openpyxl.load_workbook(xlsx_path, data_only=True)["Leads"]
    grid = list(ws.iter_rows(min_row=1, values_only=True))
    header = [cell(h) for h in grid[0][:len(FIELDS)]]
    extra = {cell(h): i for i, h in enumerate(grid[0]) if i >= len(FIELDS) and h}
    if header != FIELDS:
        raise SystemExit(
            "The Leads tab's columns have changed, so the board would be built "
            "from the wrong fields. Stop and re-map them.\n"
            "  expected: %s\n  found:    %s" % (FIELDS, header))

    rows = []
    for raw in grid[1:]:
        r = {FIELDS[i]: cell(raw[i]) for i in range(len(FIELDS))}
        for h, i in extra.items():
            r[h] = cell(raw[i]) if i < len(raw) else ""
        if not r["MLS #"] and not r["Address"]:
            continue
        note = "" if r["Notes"] == BOILERPLATE else r["Notes"]
        # remarks land in Notes today; if the pull ever adds a dedicated
        # remarks column, read both
        remarks = " ".join(x for x in (note, r.get("Agent Remarks", "")) if x)
        due, due_time, due_phrase = sheet_offer(r.get("Offer Due", ""))
        rows.append([
            r["MLS #"], r["Address"], number(r["Purchase Price"]),
            number(r["$/SqFt"]), number(r["SqFt"]), number(r["Beds"]),
            number(r["Year Built"]), number(r["DOM"]),
            note, r["First Added"],
            due or parse_offer_due(remarks, r["First Added"]),
            r.get("Agent Phone", ""), r.get("Agent Email", ""),
            r.get("Listing Agent", "").split(",")[0].strip(), r.get("MLS Status", ""),
            due_time, "agent remarks" if due else "",
            due_phrase or (offer_sentence(r.get("Private Remarks", "")) if due else ""),
            r.get("Private Remarks", "")[:2000], r.get("Showing", "")[:600],
            # "A — Work Now" -> "A"; the board spells the labels itself
            (r.get("Bucket", "")[:1] if r.get("Bucket", "")[:1] in ("A", "B", "C") else ""),
            number(r.get("Opportunity Score", "")), r.get("Why", "")[:240],
            # appended, never inserted: see the note on `cols` above
            r.get("Occupied By", ""), r.get("Price Cut", ""),
        ])

    # cheapest per square foot first within each pull date — how the team reads it
    rows.sort(key=lambda x: (x[9], x[3] if x[3] is not None else 10 ** 9))
    dates = sorted({x[9] for x in rows if x[9]}, reverse=True)
    # when this build ran, so a board can tell it from a newer in-page refresh
    built = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    return {"pulled": dates[0] if dates else "", "dates": dates, "built": built,
            "cols": COLUMNS, "rows": rows}


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
    exact = [x for x in dues if not x[10].startswith("~")]
    print("offer deadlines read from remarks: %d (%d dated, %d weekday-only)"
          % (len(dues), len(exact), len(dues) - len(exact)))
    for x in dues[:10]:
        print("   %-13s %s  <- %s" % (x[0], x[10], x[8][:60]))


if __name__ == "__main__":
    main()
