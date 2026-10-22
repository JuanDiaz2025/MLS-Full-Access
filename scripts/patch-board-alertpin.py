#!/usr/bin/env python3
"""Make "Show me" land on exactly the leads the pop-up named, and no others.

The last fix pointed "Show me" at a view whose test is alertMatch() — the same
test the alert runs. That is still not the same list. The pop-up lists the
leads NOBODY HERE HAS LOOKED AT YET (alertShown: alertMatch minus everything
already marked seen this visit); alertMatch on its own is every new lead in
the watched areas. So a pop-up naming a handful handed the screen the whole
day's intake, which is what it looks like from the outside: "it routed me to
all leads".

The two lists cannot be kept in step by running the same test twice, because
the pop-up's list is not a test — it is a list. So pin it: the moment "Show
me" is clicked, remember the MLS numbers the pop-up had on screen, and have
the view show those and nothing else. Picking the view by hand from the Show
menu drops the pin and the view stands on its own test again.

The pin has to be taken BEFORE markAlertSeen(), which empties alertShown.

Anchors are exact strings from the live page; if one stops matching, the page
changed underneath and the patch should be re-derived rather than forced.

    python3 scripts/patch-board-alertpin.py <in.html> <out.html>
"""
import sys

# --- 1. where the pinned list lives ---------------------------------------
DECL_ANCHOR = """  var alertShown = [], alertSeen = {}, alertMuted = "";"""

DECL_NEW = """  var alertShown = [], alertSeen = {}, alertMuted = "";
  // The leads "Show me" was told to show, pinned by MLS the moment it is
  // clicked. The pop-up lists what nobody here has looked at yet, which is a
  // smaller set than "new in my areas" — so a view that ran alertMatch again
  // came back with the whole day's intake instead of the handful just named.
  // null means nothing is pinned and the view stands on its own test.
  var alertPicked = null;"""

# --- 2. the view reads the pin --------------------------------------------
VIEW_ANCHOR = """    fresh:   {label: "New in my areas", hint: "The leads the \U0001F514 New alert listed: in the areas the team watches and on the market since yesterday", sort: "date",
              test: function(l){ return alertMatch(l); }},"""

VIEW_NEW = """    fresh:   {label: "New in my areas", hint: "The leads the \U0001F514 New alert named — exactly those while its list is pinned, otherwise everything new in the areas the team watches", sort: "date",
              test: function(l){ return alertPicked ? alertPicked[l.mls] === 1 : alertMatch(l); }},"""

# --- 3. "Show me" takes the pin -------------------------------------------
SHOW_ANCHOR = """  // "Show me" lands on the leads the pop-up listed and nothing else: the New
  // in my areas view, which runs the same alertMatch test the pop-up ran.
  // Every filter that cuts rows on its own is cleared first — the minimum
  // score included, which is why a score left set used to hide some of the
  // leads that had just been named.
  $("alertShow").addEventListener("click", function(){
    markAlertSeen();"""

SHOW_NEW = """  // "Show me" lands on the leads the pop-up listed and nothing else — the
  // pinned list above, not a test that happens to agree with it. Every filter
  // that cuts rows on its own is cleared too: the minimum score included,
  // which cuts rows independently of the view and was hiding some of the
  // leads that had just been named.
  $("alertShow").addEventListener("click", function(){
    // Pin the list FIRST: markAlertSeen() empties alertShown.
    alertPicked = {};
    alertShown.forEach(function(l){ alertPicked[l.mls] = 1; });
    markAlertSeen();"""

# --- 4. picking the view by hand drops the pin ----------------------------
SEL_ANCHOR = """  $("showSel").addEventListener("change", function(){
    preset = this.value;"""

SEL_NEW = """  $("showSel").addEventListener("change", function(){
    preset = this.value;
    // picked by hand, so "New in my areas" means its own test again rather
    // than whatever the pop-up last named
    alertPicked = null;"""

EDITS = [
    ("the pinned list", DECL_ANCHOR, DECL_NEW),
    ("the New in my areas test", VIEW_ANCHOR, VIEW_NEW),
    ("the Show me button", SHOW_ANCHOR, SHOW_NEW),
    ("the Show menu clearing the pin", SEL_ANCHOR, SEL_NEW),
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
