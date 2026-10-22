#!/usr/bin/env python3
"""Fix two wrong columns on the Lead Board's Email & SMS Log screen.

Both bugs are in how a row is built from the agent log, so both only affect
logged calls and texts — the Instantly rows and board-sent emails were always
per-lead and are left alone.

1. PROPERTY showed the wrong house. A log entry records what was said, who
   said it and when; it does not record which listing it was about. The screen
   filled the column from `g.leads[0]` — the agent's NEWEST listing — for every
   entry. For an agent with one listing that is right by luck; for an agent
   with several it is a guess printed as a fact. Now: the listing the writer
   named, else the agent's only listing, else the column says it was not
   recorded and how many listings that agent has.

2. DIRECTION said Out for everything, including the agent's own replies, which
   rei/replywatch.js writes into the same log. The log has no direction field,
   so the writers now set one (`dir:"in"`); entries written before this read as
   inbound from the shape replywatch gives them, "Reply on <line>: ".

As with scripts/patch-board-msglog.py this is a patch, not a rewrite: the board
is co-written, so the smallest change is the one least likely to clobber
someone. Every anchor is an exact string from the live page; if one stops
matching, the page changed underneath and the patch should be re-derived.

    python3 scripts/patch-board-msglog-fix.py <in.html> <out.html>
"""
import sys

# --- 1. carry the two fields agDoc currently drops -------------------------
# The agent card reads k/t/by/at and ignores anything else, so adding them is
# inert everywhere except the log screen.
DOC_ANCHOR = """          log.push({id: k, k: x.k, t: str(x.t, 300), by: str(x.by, 40) || "Someone", at: x.at.slice(0, 40)});"""

DOC_NEW = """          log.push({id: k, k: x.k, t: str(x.t, 300), by: str(x.by, 40) || "Someone", at: x.at.slice(0, 40),
                    // Set by rei/logtoboard.js and rei/replywatch.js. Absent on anything typed into
                    // the agent card by hand, and ignored by the card itself — only the log reads them.
                    dir: x.dir === "in" ? "in" : "", mls: typeof x.mls === "string" ? x.mls.slice(0, 40) : ""});"""

# --- 2. build the row from what the entry actually says --------------------
ALL_ANCHOR = """  function msgAll(){
    var rows = [], gs = agentGroups();
    gs.list.forEach(function(g){
      var lead = g.leads[0] || null;
      agDoc(g).log.forEach(function(x){
        rows.push({at: x.at, dir: "out", ch: x.k === "email" ? "email" : x.k === "text" ? "text" : "other",
                   kind: AG_KIND[x.k] || "Logged", g: g, lead: lead, body: x.t || "", by: x.by || ""});
      });
    });"""

ALL_NEW = """  // The log has no inbound/outbound field, so our writers mark one. Nothing
  // typed into the agent card by hand carries it, and those are ours going out
  // anyway; the only inbound entries written without it are the replies
  // replywatch wrote before this change, which all begin "Reply on <line>: ".
  var MSG_IN = /^Reply on [^:\\n]{1,40}: /;
  function msgDirOf(x){ return x.dir === "in" || MSG_IN.test(x.t || "") ? "in" : "out"; }
  function msgAll(){
    var rows = [], gs = agentGroups(), byMls = {};
    LEADS.forEach(function(l){ byMls[l.mls] = l; });
    gs.list.forEach(function(g){
      // A call or text says nothing about which listing it was about unless
      // whoever logged it said so. The agent's newest listing used to stand in
      // for that, which reads as a fact and is a guess — so now it is the one
      // we were told, the agent's only listing, or nothing.
      var only = g.leads.length === 1 ? g.leads[0] : null;
      agDoc(g).log.forEach(function(x){
        var dir = msgDirOf(x);
        rows.push({at: x.at, dir: dir, ch: x.k === "email" ? "email" : x.k === "text" ? "text" : "other",
                   kind: dir === "in" ? "Replied" : AG_KIND[x.k] || "Logged",
                   g: g, lead: (x.mls && byMls[x.mls]) || only, body: x.t || "", by: x.by || ""});
      });
    });"""

# --- 3. say so in the cell rather than leaving a bare dash -----------------
CELL_ANCHOR = """        '<td class="who">' + (pa ? '<button type="button" class="ag-l-a" data-msg-lead="' + esc(r.lead.mls) + '">' +
            esc(pa.s) + '</button><small>' + esc(r.lead.mls) + '</small>' : '<small>—</small>') + '</td>' +"""

CELL_NEW = """        '<td class="who">' + (pa ? '<button type="button" class="ag-l-a" data-msg-lead="' + esc(r.lead.mls) + '">' +
            esc(pa.s) + '</button><small>' + esc(r.lead.mls) + '</small>'
          : '<small>' + (r.g && r.g.leads.length > 1
              ? "not recorded · " + r.g.leads.length + " listings" : "—") + '</small>') + '</td>' +"""

EDITS = [
    ("agDoc keeps dir and mls", DOC_ANCHOR, DOC_NEW),
    ("msgAll reads them", ALL_ANCHOR, ALL_NEW),
    ("the Property cell", CELL_ANCHOR, CELL_NEW),
]


def main():
    src, dst = sys.argv[1], sys.argv[2]
    html = open(src, encoding="utf-8").read()
    for label, old, new in EDITS:
        n = html.count(old)
        if n != 1:
            sys.exit("ABORT: %s — anchor matched %d times, expected exactly 1.\n"
                     "The page changed underneath; re-derive the patch." % (label, n))
        html = html.replace(old, new, 1)
        print("ok  %s" % label)
    open(dst, "w", encoding="utf-8").write(html)
    print("\nwrote %s (%d bytes)" % (dst, len(html.encode("utf-8"))))


if __name__ == "__main__":
    main()
