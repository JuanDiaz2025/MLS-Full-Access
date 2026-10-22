#!/usr/bin/env python3
"""Two changes Bryan asked for at 23:43, on top of the Text Blast (v129).

  1. "are we able to select 50 one at a time" — a Pick next 50 button that
     fills the batch up to the day's remaining room in one press, instead of
     ticking fifty cards by hand. It reaches the whole filtered list, not just
     the cards rendered, because the grid only draws 48 at a time.

  2. "make sure it will remove it on my next blast after" — an agent who has
     already been in a blast drops out of every later one. The card says so
     and its tick box is dead, the same way a missing phone already works:
     refuse visibly rather than silently.

Together these are what makes 50-a-day repeatable — press, send, come back
tomorrow and the next fifty are a different fifty.

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

# ------------------------------------------------------- 1. the new button
MK_ANCHOR = """      <button type="button" class="btn tiny" id="blAll">Select all shown</button>"""
MK_NEW = """      <button type="button" class="btn tiny" id="blNext">Pick next 50</button>
      <button type="button" class="btn tiny" id="blAll">Select all shown</button>"""
s = cut(MK_ANCHOR, MK_NEW, "Pick next button")

# ------------------------------------- 2. an agent is only ever blasted once
WHY_ANCHOR = """  // No phone, no text. Saying so on the card beats a batch that silently
  // drops a third of the people in it.
  function blastWhyNot(g){
    if (!g) return "no agent";
    if (!g.phone) return "no mobile number on file — nothing to text";
    if (!blastLead(g)) return "no listing to name in the text";
    return "";
  }"""
WHY_NEW = """  // Everyone who has already been in a batch, and when. Read off the blast
  // documents rather than kept separately: the batches ARE the record, so
  // there is nothing to fall out of step with.
  function blastDone(){
    var done = {};
    Object.keys(BLASTS).forEach(function(k){
      var b = BLASTS[k];
      if (!b || b.st === "error" || !Array.isArray(b.agents)) return;
      b.agents.forEach(function(a){
        if (!a || typeof a.agId !== "string") return;
        // Keep the FIRST time they were texted, not the latest — "texted on
        // the 22nd" is the useful fact, and a second batch cannot overwrite
        // it into looking newer than it was.
        if (!done[a.agId] || (typeof b.at === "string" && b.at < done[a.agId])) done[a.agId] = b.at || "";
      });
    });
    return done;
  }
  // No phone, no text. Saying so on the card beats a batch that silently
  // drops a third of the people in it. Same for an agent already texted:
  // the whole point of a daily fifty is that tomorrow's fifty are new people.
  function blastWhyNot(g, done){
    if (!g) return "no agent";
    if (!g.phone) return "no mobile number on file — nothing to text";
    if (!blastLead(g)) return "no listing to name in the text";
    var d = (done || blastDone())[g.id];
    if (d !== undefined) return "already texted" + (d ? " " + agDay(d) : "") + " — they only get one";
    return "";
  }"""
s = cut(WHY_ANCHOR, WHY_NEW, "blastDone and the already-texted refusal")

# The card and the picked list both pass the map in, so a screen of 900 cards
# does not rebuild it 900 times.
CARD_ANCHOR = """  function blastPickHTML(g){
    var why = blastWhyNot(g), on = blastSel[g.id] && !why;"""
CARD_NEW = """  function blastPickHTML(g, done){
    var why = blastWhyNot(g, done), on = blastSel[g.id] && !why;"""
s = cut(CARD_ANCHOR, CARD_NEW, "blastPickHTML signature")

PICKED_ANCHOR = """  function blastPicked(rows){
    return rows.filter(function(x){ return blastSel[x.g.id] && !blastWhyNot(x.g); });
  }"""
PICKED_NEW = """  function blastPicked(rows){
    var done = blastDone();
    return rows.filter(function(x){ return blastSel[x.g.id] && !blastWhyNot(x.g, done); });
  }"""
s = cut(PICKED_ANCHOR, PICKED_NEW, "blastPicked uses the done map")

AGC_ANCHOR = """      (inDlg ? '' : blastPickHTML(g)) +"""
AGC_NEW = """      (inDlg ? '' : blastPickHTML(g, blastDoneMemo)) +"""
s = cut(AGC_ANCHOR, AGC_NEW, "card passes the memo")

# One map per draw. agentCardHTML is called once per card, so without this the
# whole blast history would be walked again for every agent on screen.
MEMO_ANCHOR = "  var BLASTS = {}, blastSel = {}, blastRows = [];"
MEMO_NEW = "  var BLASTS = {}, blastSel = {}, blastRows = [], blastDoneMemo = {};"
s = cut(MEMO_ANCHOR, MEMO_NEW, "blastDoneMemo declaration")

DRAW_ANCHOR = """    blastDraw(rows);
    blastRows = rows;"""
DRAW_NEW = """    blastDoneMemo = blastDone();
    blastDraw(rows);
    blastRows = rows;"""
s = cut(DRAW_ANCHOR, DRAW_NEW, "memo refreshed each draw")

# ------------------------------------------------- 3. label and the listener
LBL_ANCHOR = """    $("blGo").disabled = !picked.length || over || !db;"""
LBL_NEW = """    // The button says the number it will actually add, so pressing it twice
    // cannot be a surprise.
    var free = Math.max(0, room - picked.length);
    $("blNext").textContent = "Pick next " + (free || cap);
    $("blNext").disabled = !free;
    $("blGo").disabled = !picked.length || over || !db;"""
s = cut(LBL_ANCHOR, LBL_NEW, "Pick next label")

LIS_ANCHOR = """  $("blAll").addEventListener("click", function(){"""
LIS_NEW = """  $("blNext").addEventListener("click", function(){
    // Fills up to the day's remaining room from the WHOLE filtered list, not
    // only the 48 cards drawn — "the next fifty" means the next fifty agents,
    // not the next fifty you have scrolled to.
    var done = blastDone(), room = Math.max(0, blastCap() - blastToday());
    var want = room - blastPicked(blastRows).length, added = 0;
    for (var i = 0; i < blastRows.length && added < want; i++) {
      var g = blastRows[i].g;
      if (blastSel[g.id] || blastWhyNot(g, done)) continue;
      blastSel[g.id] = 1; added++;
    }
    if (!added) toast(want <= 0 ? "That is the cap for today" : "Nobody left to add — everyone showing has been texted already");
    draw();
  });
  $("blAll").addEventListener("click", function(){"""
s = cut(LIS_ANCHOR, LIS_NEW, "Pick next listener")

# "Select all shown" has to respect the same refusals.
ALL_ANCHOR = """    blastRows.slice(0, relShown).forEach(function(x){ if (!blastWhyNot(x.g)) blastSel[x.g.id] = 1; });"""
ALL_NEW = """    var doneAll = blastDone();
    blastRows.slice(0, relShown).forEach(function(x){ if (!blastWhyNot(x.g, doneAll)) blastSel[x.g.id] = 1; });"""
s = cut(ALL_ANCHOR, ALL_NEW, "Select all shown respects the refusals")

SRC.write_text(s)
print("OK  %d -> %d bytes (+%d)" % (orig, len(s), len(s) - orig))
