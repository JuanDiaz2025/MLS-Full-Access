#!/usr/bin/env python3
"""Make the new-lead alert's "Show me" land on the leads it just listed.

The pop-up lists leads matching alertMatch(): new in the last day, in the
areas the team watches, still on the market, not removed and not passed.
"Show me" then switched the board to the "My areas" quick view, which is
every lead in those areas from every pull date — hundreds of rows where the
pop-up had named a handful. The comment above the handler already claimed it
landed on "the same leads the pop-up listed"; the code never did.

Two changes:

1. A quick view of its own, "New in my areas", whose test IS alertMatch, so
   the list on screen and the list in the pop-up cannot drift apart. It also
   appears in the Show menu, so the view the alert lands on is one the team
   can pick again later.

2. "Show me" selects that view, and also clears the minimum-score filter —
   it filters rows independently of the view, so a score left set would have
   hidden some of the leads the pop-up had just named.

Anchors are exact strings from the live page; if one stops matching, the page
changed underneath and the patch should be re-derived rather than forced.

    python3 scripts/patch-board-alertshow.py <in.html> <out.html>
"""
import sys

# --- 1. the view ----------------------------------------------------------
# alertMatch is a function declaration further down the same script, so it is
# hoisted; the test only runs when a view is drawn, long after both exist.
VIEW_ANCHOR = """    mine:    {label: "My areas", hint: "Leads in the areas the team watches, still on the market — change them with 🔔 New → Areas", sort: "bk",
              test: function(l){ return inAlertAreas(l) && isLive(l) && teamOpen(l); }},"""

VIEW_NEW = """    fresh:   {label: "New in my areas", hint: "The leads the 🔔 New alert listed: in the areas the team watches and on the market since yesterday", sort: "date",
              test: function(l){ return alertMatch(l); }},
    mine:    {label: "My areas", hint: "Leads in the areas the team watches, still on the market — change them with 🔔 New → Areas", sort: "bk",
              test: function(l){ return inAlertAreas(l) && isLive(l) && teamOpen(l); }},"""

# --- 2. the button --------------------------------------------------------
SHOW_ANCHOR = """  // "Show me" lands on the same leads the pop-up listed: the My areas view,
  // every pull date, newest first, with nothing else filtering them out.
  $("alertShow").addEventListener("click", function(){
    markAlertSeen();
    if (ACQ) setAcq(false);
    showScreen("leads", true);
    preset = "mine";
    $("statusFilter").value = ""; $("q").value = ""; $("areaFilter").value = "";
    view = "__all__"; scopeFor.leads = "__all__"; sel.value = "__all__";
    sortKey = "date"; sortDir = -1;
    draw();
  });"""

SHOW_NEW = """  // "Show me" lands on the leads the pop-up listed and nothing else: the New
  // in my areas view, which runs the same alertMatch test the pop-up ran.
  // Every filter that cuts rows on its own is cleared first — the minimum
  // score included, which is why a score left set used to hide some of the
  // leads that had just been named.
  $("alertShow").addEventListener("click", function(){
    markAlertSeen();
    if (ACQ) setAcq(false);
    showScreen("leads", true);
    preset = "fresh";
    $("statusFilter").value = ""; $("q").value = ""; $("areaFilter").value = "";
    if ($("scoreFilter")) $("scoreFilter").value = "";
    view = "__all__"; scopeFor.leads = "__all__"; sel.value = "__all__";
    sortKey = "date"; sortDir = -1;
    draw();
  });"""

EDITS = [
    ("the New in my areas view", VIEW_ANCHOR, VIEW_NEW),
    ("the Show me button", SHOW_ANCHOR, SHOW_NEW),
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
