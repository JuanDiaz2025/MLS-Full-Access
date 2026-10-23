#!/usr/bin/env python3
"""Bryan, 00:13 on 23 Oct, about what reaches Juan:

  "this is only deals that juan wants he doesn't want nice property and also
   focus on san francisco and peninsula area make sure do not include pass
   status"

Three rules, and only one of them was already enforced anywhere.

  1. NOT PASSED — the Visits view already drops passed and removed leads. The
     agent cards and the blast did not, so a lead the team had passed on could
     still be picked up elsewhere. Now one function answers it for everyone.
  2. SAN FRANCISCO AND THE PENINSULA — countyOf already resolves these, and
     the Buy Box already scores areas, but nothing ever REFUSED a lead for
     being outside them. Santa Clara, Alameda, Contra Costa and the rest are
     out of focus, not out of existence: they are refused by name so nobody
     wonders whether the board simply failed to see them.
  3. NOT A NICE HOUSE — the one with no implementation at all, and the one
     Bryan has complained about since Darwin Ct: a fully renovated, staged
     house graded B on the single word "vacant".

Rule 3 is the whole point, so it follows CLAUDE.md's audit exactly rather
than inventing a new test:

  - VACANCY, AGE, PRICE CUTS AND DAYS ON MARKET ARE NOT CONDITION. They are
    proxies for MOTIVATION. Stack three and the scan reaches 65-75 and calls
    it A, and a vacant, long-held, 1946 house with a price cut is very often
    beautifully remodelled. They may raise a score; here they carry none.
  - The scan's own admissions that it skipped the check — "scored on
    refresh", "photo check off", "judged by eye" — mean NOT ASSESSED, not
    assessed-and-fine. 377 live A/B leads, 34%, were graded by one of those.
  - A house that reads as already done — remodelled, updated, turnkey,
    staged, new kitchen — is refused outright even if something else in the
    text sounds like work.

No $/sqft gate. That was tried and disproved: Darwin Ct looks expensive only
because it is small, and a 1.10x rule would silence 26% of genuine fixers.

What this does NOT do: it cannot fix the scan, which is a Windows .exe in a
Drive folder with no reachable source. The scan will go on grading these A.
This stops them reaching a visit, a calendar booking or a blast from the
board, and says in plain words why.

Each anchor must match EXACTLY ONCE or the script aborts without writing.
"""
import sys, pathlib

SRC = pathlib.Path("/tmp/claude-0/-home-user-MLS-Full-Access/3a32f38f-9daf-53d9-943c-90ecbea25b3d/scratchpad/board-texttpl.html")
s = SRC.read_text()
orig = len(s)

def cut(anchor, new, what):
    n = s.count(anchor)
    if n != 1:
        sys.exit("ABORT: %s matched %d times, expected 1" % (what, n))
    return s.replace(anchor, new, 1)

ANCHOR = """  function countyOf(l){ return CITY_COUNTY[cityOf(l).toLowerCase()] || "Other"; }"""

NEW = """  function countyOf(l){ return CITY_COUNTY[cityOf(l).toLowerCase()] || "Other"; }

  // ---- Juan's rules: what is actually worth a visit ----------------------
  // Bryan, 23 Oct: "only deals that juan wants, he doesn't want nice
  // property, focus on san francisco and peninsula, do not include pass".
  // One gate, so the visit list, the calendar and the blast cannot disagree.

  // San Francisco and the Peninsula. San Mateo County IS the Peninsula; the
  // rest of the Bay is out of focus, not unknown.
  var JUAN_COUNTIES = {"San Francisco": 1, "San Mateo": 1};

  // The scan saying it skipped the check. "scored on refresh" is the biggest
  // hole by far — 308 live A/B leads, 27%, were scored by a path that looks
  // at neither photos nor $/sqft.
  var JUAN_SKIPPED = /scored on refresh|photo check off|judged by eye/i;

  // Already done. If the listing is selling the finish, there is no project.
  // NO TRAILING \\b: the first cut had /\\bremodel\\b/, which does not match
  // "remodeled", and a lead reading "needs work ... fully remodeled kitchen"
  // sailed through. Match the stem and let it run.
  var JUAN_NICE = /\\b(remodel|renovat|updat|upgrad|turn[- ]?key|move[- ]?in ready|newly built|new construction|stag(?:ed|ing)|designer|luxur|pristine|immaculate|like new)\\w*/i;

  // "Needs updating" is the OPPOSITE of "updated", and the stem above cannot
  // tell them apart. So these phrases are pulled out of the text before the
  // nice test runs, and count as condition evidence in their own right.
  // Without this the gate would refuse exactly the fixers Juan wants.
  var JUAN_NEEDS = /\\b(?:needs?|could use|ready for|due for|awaits?)\\s+(?:some\\s+|a\\s+|full\\s+|complete\\s+)?(?:updating|update[sd]?|remodel\\w*|renovat\\w*|work|tlc|repair\\w*|rehab\\w*|restoration)\\b/i;
  var JUAN_NEEDS_G = new RegExp(JUAN_NEEDS.source, "gi");

  // Real condition evidence. Words about the STATE of the house, not about
  // why the seller might be motivated.
  var JUAN_COND = /\\b(fixer|tlc|needs? work|handyman|contractor|as[- ]is|deferred maintenance|dated|original condition|gut|rehab|distress|damage|foundation|roof needs|teardown|uninhabitable|repairs?|dry ?rot|mold|fire damage)\\b/i;

  // Motivation, NOT condition. Listed so the refusal can name them — these
  // are exactly what stacks up to an undeserved A.
  var JUAN_PROXY = /\\b(vacant|first time on the market|long[- ]held|original owner|price (?:cut|reduc)|days on market|estate sale|probate|trust sale)\\b/i;

  function juanText(l){
    return [l.why, l.note, l.notes, l.remarks, l.remark].filter(function(x){
      return typeof x === "string" && x;
    }).join(" \\u00b7 ");
  }

  // Returns "" when Juan would want it, or the reason he would not. A string
  // rather than a boolean so every screen can say WHY out loud — a silent
  // filter is how 1,125 bad leads got trusted in the first place.
  function juanWhyNot(l){
    if (!l) return "no lead";
    if (statusOf(l) === "Pass" || removedOf(l)) return "the team passed on this one";
    if (!isLive(l)) return "no longer on the market";
    var k = countyOf(l);
    if (!JUAN_COUNTIES[k]) {
      return (k === "Other" ? "outside" : k + " County is outside") + " San Francisco and the Peninsula";
    }
    var t = juanText(l);
    // Strip "needs updating" and friends FIRST, so the nice test judges only
    // what the listing claims is already done.
    if (JUAN_NICE.test(t.replace(JUAN_NEEDS_G, " "))) return "reads as already renovated — Juan does not want a nice house";
    if (JUAN_COND.test(t) || JUAN_NEEDS.test(t)) return "";
    if (JUAN_SKIPPED.test(t)) return "the scan says it skipped the condition check here — needs eyes on the photos";
    if (JUAN_PROXY.test(t)) return "only motivation signals (" + (JUAN_PROXY.exec(t) || [""])[0] + "), nothing about the state of the house";
    return "nothing says anyone looked at the condition";
  }
  function juanWants(l){ return juanWhyNot(l) === ""; }"""

s = cut(ANCHOR, NEW, "juanWhyNot gate")

SRC.write_text(s)
print("OK  %d -> %d bytes (+%d)" % (orig, len(s), len(s) - orig))
