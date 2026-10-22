#!/usr/bin/env python3
"""Drop the leads the team passed or removed out of the Visits view.

Bryan: "even we passed the property already and still showing on the open
house". He is right, and it is in the board's data: two leads carry a
Scheduled visit while their team status is Pass — COMINGSOON2335 (visit
6 Oct) and SF426168504 (visit 21 Oct). Both still appear under Visits.

The view's test only asked whether a visit date or status exists. The other
views guard with teamOpen(), but that would change nothing here: presetMatch
turns teamOpen into "yes" while a view picks its leads, deliberately, so that
a lead passed by mistake still lands in the Passed section with its Restore
button. A visit list is the one place that is wrong — a property the team has
passed has no visit left to keep, and leaving it there is what Bryan keeps
seeing. So this reads the status directly instead.

Passed and Removed only. A WON lead keeps its visit: under contract there is
still a reason to walk the house.

Anchors are exact strings from the live page; if one stops matching, the page
changed underneath and the patch should be re-derived rather than forced.

    python3 scripts/patch-board-visitspass.py <in.html> <out.html>
"""
import sys

ANCHOR = """    visits:  {label: "Visits", hint: "Leads with a property visit date or status, soonest visit first", sort: "visit",
              test: function(l){ var v = visitOf(l); return !!(v.d || v.s); }},"""

NEW = """    visits:  {label: "Visits", hint: "Leads with a property visit date or status, soonest visit first — what the team passed or removed is left out", sort: "visit",
              test: function(l){
                // statusOf and removedOf directly, NOT teamOpen: presetMatch
                // turns teamOpen into "yes" while a view picks its leads, so a
                // lead passed by mistake still lands in the Passed section. A
                // visit list is the one place that is wrong — a property the
                // team passed has no visit left to keep.
                if (removedOf(l) || statusOf(l) === "Pass") return false;
                var v = visitOf(l); return !!(v.d || v.s);
              }},"""

EDITS = [("the Visits view", ANCHOR, NEW)]


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
