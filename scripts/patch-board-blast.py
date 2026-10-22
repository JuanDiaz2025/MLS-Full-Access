#!/usr/bin/env python3
"""Add the Text Blast to the board's Agent Relationships screen.

Bryan, 22 Oct 22:49: "are you able to create a feature that can we make a text
blast here on the artifact like 50 a day ... like batch text".

WHAT THIS ADDS
  - a tick box on every agent card on the Agent Relationships screen
  - a bar above the grid: how many are picked, which line to send from, a
    daily cap, "Select all shown", and "Queue blast"
  - a `blast` collection on the board holding each queued batch

WHAT IT DOES NOT DO
  The board does not send anything. It writes the batch down and the runner
  (rei/blast.js, through REI's own lines) sends it. That is deliberate: a
  published artifact can only reach the VIEWER's connectors, so a page that
  claimed to send texts would be lying on every machine but one. The same
  separation as Push to REI, which has worked all week.

Each anchor must match EXACTLY ONCE or the script aborts without writing.
"""
import sys, pathlib

SRC = pathlib.Path("/tmp/claude-0/-home-user-MLS-Full-Access/3a32f38f-9daf-53d9-943c-90ecbea25b3d/scratchpad/board-texttpl.html")

s = SRC.read_text()
orig = len(s)

def cut(anchor, new, what):
    """Replace `anchor` with `new`, refusing anything but a single match."""
    n = s.count(anchor)
    if n != 1:
        sys.exit("ABORT: %s matched %d times, expected 1" % (what, n))
    return s.replace(anchor, new, 1)

# ---------------------------------------------------------------- 1. CSS
CSS_ANCHOR = "\n/* ---------- Email & SMS Log (#messages) ---------- */"
CSS_NEW = """
/* ---------- Text Blast (Agent Relationships) ---------- */
.rel-blast{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:0 0 12px;
  padding:11px 13px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.rel-blast .bl-t{font-weight:650;margin-right:2px}
.rel-blast .bl-n{font-variant-numeric:tabular-nums}
.rel-blast select{min-width:0}
.rel-blast .bl-sp{flex:1 1 auto}
.rel-blast .bl-cap{font-size:.86rem;color:var(--muted)}
.rel-blast .bl-cap b{color:var(--ink);font-variant-numeric:tabular-nums}
.rel-blast .bl-over{color:var(--t-pass)}
.agc-pick{display:flex;align-items:center;gap:7px;font-size:.84rem;color:var(--muted);
  margin:0 0 8px;cursor:pointer;user-select:none}
.agc-pick input{width:16px;height:16px;margin:0;cursor:pointer;flex:0 0 auto}
.agc-pick.off{cursor:not-allowed;opacity:.55}
.agc-pick.off input{cursor:not-allowed}
.agc.picked{outline:2px solid var(--t-review);outline-offset:-2px}
@media (max-width:640px){.rel-blast{gap:8px}.rel-blast .bl-sp{flex-basis:100%}}

/* ---------- Email & SMS Log (#messages) ---------- */"""
s = cut(CSS_ANCHOR, CSS_NEW, "blast CSS")

# ------------------------------------------------------------- 2. markup
MK_ANCHOR = """    <p class="rel-note" id="relNote"></p>
    <div class="rel-grid" id="relGrid"></div>"""
MK_NEW = """    <p class="rel-note" id="relNote"></p>
    <div class="rel-blast" id="relBlast">
      <span class="bl-t">Text blast</span>
      <span class="bl-n" id="blCount">0 picked</span>
      <button type="button" class="btn tiny" id="blAll">Select all shown</button>
      <button type="button" class="btn tiny" id="blNone" hidden>Clear</button>
      <span class="bl-sp"></span>
      <select id="blLine" aria-label="Send from which line">
        <option value="Realtor">From: Realtor (510) 800-1607</option>
        <option value="Juan - Outbound">From: Juan - Outbound (650) 844-3415</option>
        <option value="Cherry - Outbound">From: Cherry - Outbound (650) 780-3794</option>
      </select>
      <select id="blCap" aria-label="How many a day">
        <option value="25">Cap: 25 a day</option>
        <option value="50" selected>Cap: 50 a day</option>
        <option value="100">Cap: 100 a day</option>
      </select>
      <span class="bl-cap" id="blLeft"></span>
      <button type="button" class="btn go" id="blGo" disabled>Queue blast</button>
    </div>
    <div class="rel-grid" id="relGrid"></div>"""
s = cut(MK_ANCHOR, MK_NEW, "blast bar markup")

# ------------------------------------------------- 3. tick box on the card
CARD_ANCHOR = """    return '<div class="agc' + (inDlg ? ' in-dlg' : '') + '" data-ag="' + id + '">' +
      '<div class="agc-top">' + agAvHTML(g) +"""
CARD_NEW = """    return '<div class="agc' + (inDlg ? ' in-dlg' : '') + (!inDlg && blastSel[g.id] ? ' picked' : '') + '" data-ag="' + id + '">' +
      (inDlg ? '' : blastPickHTML(g)) +
      '<div class="agc-top">' + agAvHTML(g) +"""
s = cut(CARD_ANCHOR, CARD_NEW, "agent card tick box")

# ------------------------------------------------------------ 4. the code
JS_ANCHOR = "  var REL = false, relF = {heat: \"\", area: \"\", sort: \"n\", rep: false}, relShown = 48;"
JS_NEW = """  var REL = false, relF = {heat: "", area: "", sort: "n", rep: false}, relShown = 48;

  /* ---------- Text Blast ----------
     Pick agents on this screen, press Queue blast, and the batch is written to
     `blast` for the runner to send through our own REI lines. The board never
     sends a text itself: a published artifact can only reach the VIEWER's
     connectors, so a page that claimed to send would be telling the truth on
     one machine and lying on every other. Push to REI works the same way and
     has been right all week. */
  var BLASTS = {}, blastSel = {};

  // The listing we would text them about: their newest listing that is still
  // live and not passed, else their newest of any kind. Naming a house the
  // agent has already sold reads worse than not texting at all.
  function blastLead(g){
    if (!g || !g.leads.length) return null;
    var live = g.leads.filter(function(l){ return !removedOf(l) && isLive(l) && statusOf(l) !== "Pass"; });
    return live[0] || g.leads[0];
  }
  // No phone, no text. Saying so on the card beats a batch that silently
  // drops a third of the people in it.
  function blastWhyNot(g){
    if (!g) return "no agent";
    if (!g.phone) return "no mobile number on file — nothing to text";
    if (!blastLead(g)) return "no listing to name in the text";
    return "";
  }
  function blastPickHTML(g){
    var why = blastWhyNot(g), on = blastSel[g.id] && !why;
    return '<label class="agc-pick' + (why ? ' off' : '') + '"' + (why ? ' title="' + esc(why) + '"' : '') + '>' +
      '<input type="checkbox" data-bl-pick="' + esc(g.id) + '"' + (on ? ' checked' : '') + (why ? ' disabled' : '') + '>' +
      (why ? esc("Can't text — " + why) : 'Include in the text blast') + '</label>';
  }

  // How many agents have already been queued today, across everyone's batches.
  // The cap is a day of texts, not a day of presses: two batches of 30 is 60.
  function blastToday(){
    var today = vzISO(new Date()), n = 0;
    Object.keys(BLASTS).forEach(function(k){
      var b = BLASTS[k];
      if (!b || b.st === "error" || typeof b.at !== "string") return;
      var t = new Date(b.at);
      if (!isNaN(t) && vzISO(t) === today) n += Array.isArray(b.agents) ? b.agents.length : 0;
    });
    return n;
  }
  function blastCap(){ var n = parseInt($("blCap").value, 10); return n > 0 ? n : 50; }
  // Only the agents still on screen count as picked: filter the list down and
  // the batch follows what you can see, so nobody is texted off a stale tick.
  function blastPicked(rows){
    return rows.filter(function(x){ return blastSel[x.g.id] && !blastWhyNot(x.g); });
  }
  function blastDraw(rows){
    var picked = blastPicked(rows), sent = blastToday(), cap = blastCap();
    var room = Math.max(0, cap - sent), over = picked.length > room;
    $("blCount").textContent = picked.length + (picked.length === 1 ? " agent picked" : " agents picked");
    $("blNone").hidden = !picked.length;
    $("blLeft").innerHTML = sent
      ? '<b>' + sent + '</b> queued today · <b>' + room + '</b> left' + (over ? ' — <span class="bl-over">over the cap</span>' : '')
      : '<b>' + room + '</b> left today';
    $("blGo").disabled = !picked.length || over || !db;
    $("blGo").textContent = picked.length ? "Queue blast · " + Math.min(picked.length, room || picked.length) : "Queue blast";
    $("blGo").title = !db ? "Not connected — reload the page"
      : over ? "That is more than the daily cap. Untick some, or raise the cap."
      : picked.length ? "Writes the batch for the runner to send from " + $("blLine").value
      : "Tick the agents you want texted";
  }
  function blastQueue(rows){
    var picked = blastPicked(rows), cap = blastCap(), room = Math.max(0, cap - blastToday());
    if (!picked.length || picked.length > room) return;
    if (!db) { toast("Not connected — nothing was queued. Reload the page."); return; }
    var line = $("blLine").value, at = new Date().toISOString();
    var agents = picked.map(function(x){
      var l = blastLead(x.g), c = reiContact(l);
      // The agent's own name wins over whatever the newest listing spells it
      // as — the card is what a person has been correcting all week.
      return {agId: x.g.id, name: x.g.name, mls: l.mls, dom: l.dom != null ? l.dom : "",
              c: Object.assign({}, c, {phone: x.g.phone || c.phone, email: x.g.email || c.email})};
    });
    var id = "b-" + at.replace(/[^0-9]/g, "").slice(0, 14);
    var body = {at: at, by: myName || "Someone", line: line, st: "queued", n: agents.length, agents: agents};
    $("blGo").disabled = true;
    db.doc("blast/" + id).set(body).then(function(){
      blastSel = {};
      toast("✓ " + agents.length + (agents.length === 1 ? " agent queued" : " agents queued") + " — sending from " + line);
      draw();
    }).catch(function(){
      toast("✗ Couldn't queue that blast — try again");
      draw();
    });
  }"""
s = cut(JS_ANCHOR, JS_NEW, "blast state and helpers")

# ------------------------------------------- 5. draw it with the rel screen
DRAW_ANCHOR = """    $("relNote").textContent = rows.length === all.length ? all.length.toLocaleString("en-US") + " agents" :
      rows.length.toLocaleString("en-US") + " of " + all.length.toLocaleString("en-US") + " agents";"""
DRAW_NEW = DRAW_ANCHOR + """
    blastDraw(rows);
    blastRows = rows;"""
s = cut(DRAW_ANCHOR, DRAW_NEW, "blast draw call")

# `blastRows` is what the buttons act on, so a press can never use a list that
# differs from the one on screen.
s = cut("  var BLASTS = {}, blastSel = {};",
        "  var BLASTS = {}, blastSel = {}, blastRows = [];",
        "blastRows declaration")

# ----------------------------------------------------------- 6. listeners
LIS_ANCHOR = "  $(\"relMore\").addEventListener(\"click\", function(){ relShown += 48; draw(); });"
LIS_NEW = """  $("relMore").addEventListener("click", function(){ relShown += 48; draw(); });
  $("relGrid").addEventListener("change", function(ev){
    var t = ev.target, id = t && t.dataset ? t.dataset.blPick : null;
    if (!id) return;
    if (t.checked) blastSel[id] = 1; else delete blastSel[id];
    var card = t.closest(".agc");
    if (card) card.classList.toggle("picked", !!t.checked);
    blastDraw(blastRows);
  });
  $("blAll").addEventListener("click", function(){
    // "all shown" is the cards actually rendered, not every match — ticking
    // 900 agents behind a Show more button is not something anyone meant.
    blastRows.slice(0, relShown).forEach(function(x){ if (!blastWhyNot(x.g)) blastSel[x.g.id] = 1; });
    draw();
  });
  $("blNone").addEventListener("click", function(){ blastSel = {}; draw(); });
  $("blCap").addEventListener("change", function(){ this.blur(); blastDraw(blastRows); });
  $("blLine").addEventListener("change", function(){ this.blur(); blastDraw(blastRows); });
  $("blGo").addEventListener("click", function(){ blastQueue(blastRows); });"""
s = cut(LIS_ANCHOR, LIS_NEW, "blast listeners")

# --------------------------------------------------------- 7. subscription
SUB_ANCHOR = """      // what we text a listing agent first, and which wording is live
      db.collection("templates").onSnapshot(function(snap){"""
SUB_NEW = """      // batches of agents queued for a text blast, waiting for the runner
      db.collection("blast").onSnapshot(function(snap){
        var next = {};
        snap.docs.forEach(function(d){ next[d.id] = d.data() || {}; });
        BLASTS = next;
        draw();
      }, function(){});
      // what we text a listing agent first, and which wording is live
      db.collection("templates").onSnapshot(function(snap){"""
s = cut(SUB_ANCHOR, SUB_NEW, "blast subscription")

SRC.write_text(s)
print("OK  %d -> %d bytes (+%d)" % (orig, len(s), len(s) - orig))
