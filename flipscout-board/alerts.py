#!/usr/bin/env python3
"""Which leads need Juan right now — the Google Chat alert for the Test board.

    python3 alerts.py data.js board-state.json [--now 2026-09-24T08:00]

`data.js` is the board's data file (build_data.py output). `board-state.json`
is the Test board's own database, as {"edits": {doc_id: data},
"alerts": {doc_id: data}} — read with the ArtifactData tool before running.

Prints JSON: {"text": <the Chat message, or "" when nothing is due>,
"record": [{"mls", "stage"}]}. Post `text` only when it is not empty, then
write each `record` entry to the board's alerts/<MLS> document so the same
alert is never sent twice.

The safety rules (agreed with Seth, 24 Sep) — a lead alerts only if ALL hold:
  * bucket A (the app's "Work Now");
  * still Active on the MLS (not pending, contingent, sold or off market);
  * the team has not passed, won or removed it on the board, nor muted it;
  * it has a real offer date — TBD, blank or a weekday guess ("~") never alert;
  * the deadline is less than a day away and not yet past.
Each lead alerts at most twice: once inside 24 hours ("due within 24h") and
once inside FINAL_HOURS ("final call"). One message per check, at most
MAX_PER_MESSAGE leads, soonest deadline first; nothing due means no message.
"""
import sys, json, re, datetime
from zoneinfo import ZoneInfo

PT = ZoneInfo("America/Los_Angeles")
FINAL_HOURS = 5
MAX_PER_MESSAGE = 5
BOARD = "https://claude.ai/artifact/76sa8TSBhyMMiECccwQax9"
CLOSED = re.compile(r"sold|withdrawn|expired|cancel|off.?market|closed|duplicate|pending|contingent|under contract", re.I)
# no time in the remarks: count down to the end of that day, and say so
NO_TIME = datetime.time(23, 59)


def load_rows(path):
    t = open(path, encoding="utf-8").read()
    d = json.loads(t[t.index("=") + 1:].rstrip().rstrip(";"))
    cols = d.get("cols")
    if not cols:
        raise SystemExit("data.js has no `cols` — rebuild it with the current build_data.py")
    return [dict(zip(cols, r)) for r in d["rows"]]


def deadline(lead, team_due):
    """(datetime in PT, time_was_stated) or None."""
    due = team_due if team_due else (lead.get("sdue") or "")
    if team_due == "-" or not due or due.startswith("~"):
        return None
    try:
        day = datetime.date.fromisoformat(due[:10])
    except ValueError:
        return None
    t, stated = NO_TIME, False
    m = re.match(r"^(\d{1,2}):(\d{2}) ([AP]M)$", lead.get("dtime") or "")
    if m and not team_due:
        h = int(m.group(1)) % 12 + (12 if m.group(3) == "PM" else 0)
        t, stated = datetime.time(h, int(m.group(2))), True
    return datetime.datetime.combine(day, t, PT), stated


def left(delta):
    mins = int(delta.total_seconds() // 60)
    h, m = divmod(mins, 60)
    return (f"{h}h {m:02d}m" if h else f"{m}m")


def main():
    args = sys.argv[1:]
    now = datetime.datetime.now(PT)
    if "--now" in args:
        i = args.index("--now")
        now = datetime.datetime.fromisoformat(args[i + 1]).replace(tzinfo=PT)
        del args[i:i + 2]
    rows = load_rows(args[0])
    state = json.load(open(args[1], encoding="utf-8"))
    edits, sent = state.get("edits", {}), state.get("alerts", {})

    due_now = []
    for l in rows:
        if l.get("bucket") != "A" or CLOSED.search(l.get("mstat") or "") or not (l.get("mstat") or "").strip():
            continue
        e = (edits.get(l["date"]) or {}).get(l["mls"]) or {}
        if e.get("r") or e.get("s") in ("Pass", "Won"):
            continue
        a = sent.get(l["mls"]) or {}
        if a.get("muted"):
            continue
        dl = deadline(l, e.get("d") or "")
        if not dl:
            continue
        when, stated = dl
        gap = when - now
        if gap.total_seconds() <= 0 or gap > datetime.timedelta(hours=24):
            continue
        stage = "final" if gap <= datetime.timedelta(hours=FINAL_HOURS) else "h24"
        if a.get(stage) or (stage == "h24" and a.get("final")):
            continue
        due_now.append((when, stated, stage, l))

    due_now.sort(key=lambda x: x[0])
    if not due_now:
        print(json.dumps({"text": "", "record": []}))
        return

    shown, rest = due_now[:MAX_PER_MESSAGE], due_now[MAX_PER_MESSAGE:]
    n = len(due_now)
    head = "🚨 *FLIPSCOUT NEEDS JUAN*" + (f" — {n} offers due" if n > 1 else "")
    blocks = []
    for when, stated, stage, l in shown:
        day = when.strftime("%a %b %-d")
        due_line = (f"*{left(when - now)}* ({day} {when.strftime('%-I:%M %p')})" if stated
                    else f"*{'today' if when.date() == now.date() else 'tomorrow'}*, {day} — time not stated, confirm with the agent")
        who = " ".join(x for x in (l.get("agent"), l.get("phone")) if x) or "no phone on file — see the Board"
        lines = [
            ("🔴 *FINAL CALL* — " if stage == "final" else "") + f"*{l['addr']}*",
            f"A · Work Now {l.get('score') or ''} · ${l['price']:,}" if l.get("price") else f"A · Work Now {l.get('score') or ''}",
            f"⏰ Offer deadline: {due_line}",
        ]
        if l.get("dphrase"):
            p = l["dphrase"]
            lines.append("“" + (p if len(p) <= 140 else p[:137].rstrip() + "…") + "”")
        lines.append(f"📞 CALL NOW: {who}")
        lines.append(f"MLS: https://www.mlslistings.com/Property/{l['mls']}")
        blocks.append("\n".join(lines))
    tail = f"\n\n+{len(rest)} more due within 24h — see the Board" if rest else ""
    text = head + "\n\n" + "\n\n".join(blocks) + tail + f"\n\nBoard: {BOARD}"
    print(json.dumps({"text": text, "record": [{"mls": l["mls"], "stage": s} for _, _, s, l in shown]},
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
