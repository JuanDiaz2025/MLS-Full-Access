#!/usr/bin/env python3
"""Build the Email & SMS Log screen into the Lead Board artifact.

The nav rail has carried an "Email & SMS Log" button since the board was built,
greyed out with `class="soon"` and a "not built yet" tooltip. This fills it in.

It is a patch rather than a rewrite because the board is co-written: other
people edit it during the day, so the smallest possible change is the one least
likely to clobber someone. Every anchor below is an exact string from the live
page; if one stops matching, the page changed underneath and the patch should
be re-derived rather than forced.

The screen reads only what the board already stores — the agent log, the
Instantly campaign rows, and board-sent emails. No new collection, no new
capability, nothing to migrate.

    python3 scripts/patch-board-msglog.py <in.html> <out.html>
"""
import sys

CSS_ANCHOR = """body.rel .controls, body.rel #presets, body.rel .viewnav, body.rel #addScan, body.rel #markets, body.rel #saveSearch,
body.rel .tsearch, body.rel .filterbar, body.rel #viewLeads, body.rel #viewKpi, body.rel #viewAcq{display:none !important}"""

CSS_NEW = CSS_ANCHOR + """

/* ---------- Email & SMS Log (#messages) ---------- */
body.msg .controls, body.msg #presets, body.msg .viewnav, body.msg #addScan, body.msg #markets, body.msg #saveSearch,
body.msg .tsearch, body.msg .filterbar, body.msg #viewLeads, body.msg #viewKpi, body.msg #viewAcq, body.msg #viewRel{display:none !important}
#viewMsg{padding-top:14px}
.msg-head h2{font:700 20px Archivo,sans-serif; margin:0 0 2px; letter-spacing:-.01em}
.msg-head p{margin:0 0 14px; font-size:13px; color:var(--muted); max-width:86ch}
.msg-bar{display:flex; flex-wrap:wrap; gap:8px 12px; align-items:center; margin:0 0 10px}
.msg-bar input[type=search]{flex:1 1 260px; min-width:0}
.msg-chips{display:flex; flex-wrap:wrap; gap:6px}
.msg-chip{font:500 12.5px "Public Sans",sans-serif; padding:6px 12px; border-radius:999px; border:1px solid var(--line);
  background:var(--surface); color:var(--ink); cursor:pointer; white-space:nowrap}
.msg-chip .n{font-family:"IBM Plex Mono",ui-monospace,monospace; font-weight:600; margin-left:6px; color:var(--muted)}
.msg-chip[aria-pressed="true"]{background:var(--brand); border-color:var(--brand); color:#FFFFFF}
.msg-chip[aria-pressed="true"] .n{color:#DCEBF6}
.msg-note{font-size:12px; color:var(--muted); margin:0 0 10px}
#tblMsg{min-width:980px}
#tblMsg thead th{cursor:default}
#tblMsg td{vertical-align:top}
#tblMsg td.w{white-space:nowrap; font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12px; color:var(--muted)}
#tblMsg td.who b{display:block; font-weight:600}
#tblMsg td.who small{display:block; color:var(--muted); font-size:11.5px; overflow-wrap:anywhere}
#tblMsg td.body{max-width:60ch; font-size:13px; line-height:1.45; overflow-wrap:anywhere; white-space:pre-wrap}
#tblMsg td.body .none{color:var(--muted); font-style:italic}
/* Direction is the first thing to read on a row, so it is a filled pill rather
   than a word: out is ours, in is theirs. The two never sit side by side, so
   one ink each is enough. */
.msg-dir{display:inline-block; font:700 10.5px Archivo,sans-serif; letter-spacing:.04em; text-transform:uppercase;
  border-radius:999px; padding:2px 8px; white-space:nowrap}
.msg-dir.d-out{background:var(--b-review); color:var(--t-review)}
.msg-dir.d-in{background:var(--b-won); color:var(--t-won)}
.msg-ch{display:inline-block; margin-left:6px; font:600 10.5px Archivo,sans-serif; letter-spacing:.03em;
  border-radius:6px; padding:2px 7px; background:var(--b-none); color:var(--t-none); white-space:nowrap}
.msg-kind{display:block; margin-top:4px; font-size:11.5px; color:var(--muted)}
.msg-more{margin-top:14px; text-align:center}
@media (max-width:760px){
  #tblMsg{min-width:0}
  #tblMsg thead{display:none}
  #tblMsg, #tblMsg tbody, #tblMsg tr, #tblMsg td{display:block; width:auto}
  #tblMsg tbody tr{background:var(--surface); border:1px solid var(--line); border-radius:10px; margin-bottom:10px; padding:4px 2px}
  #tblMsg tbody td{border-bottom:1px solid var(--line-soft); padding:7px 12px}
  #tblMsg tbody td:last-child{border-bottom:0}
  #tblMsg td.body{max-width:none}
}"""

MARKUP_ANCHOR = """    <div class="rel-more"><button type="button" class="btn" id="relMore" hidden>Show more</button></div>
  </div>"""

MARKUP_NEW = MARKUP_ANCHOR + """

  <div id="viewMsg" hidden>
    <div class="msg-head"><h2>Email &amp; SMS Log</h2>
      <p>Every message between us and a listing agent, newest first — emails from Instantly and from the board, and texts and calls logged against the agent. Replies are what came back.</p></div>
    <dl class="kpi-row" id="msgTiles"></dl>
    <div class="msg-bar">
      <input type="search" id="msgQ" autocomplete="off" spellcheck="false" placeholder="Search agent, property, or what was said" aria-label="Search the log">
      <div class="msg-chips" id="msgChips" role="group" aria-label="Show"></div>
      <select id="msgDays" aria-label="How far back">
        <option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option>
        <option value="90">Last 90 days</option><option value="0">Everything</option></select>
    </div>
    <p class="msg-note" id="msgNote"></p>
    <div class="tablecard"><table id="tblMsg">
      <thead><tr><th class="plain">When</th><th class="plain">Direction</th><th class="plain">Agent</th><th class="plain">Property</th><th class="plain">What was said</th></tr></thead>
      <tbody id="msgBody"></tbody></table></div>
    <div class="msg-more"><button type="button" class="btn" id="msgMore" hidden>Show more</button></div>
  </div>"""

NAVBTN_ANCHOR = ('<button type="button" data-nav="log" title="Coming soon — not built yet" class="soon" '
                 'aria-disabled="true">')
NAVBTN_NEW = ('<button type="button" data-nav="log" title="Every email and text between us and a listing agent, '
              'and what came back">')

JS_ANCHOR = "  function relDueCount(){"

JS_NEW = r"""  /* ---------- Email & SMS Log (#messages) ---------- */
  // One list of everything said to a listing agent and everything said back.
  // Three sources, because that is where the board's history already lives:
  //   AGDOCS   what the team logged against the agent — calls, texts, emails,
  //            meetings. REI's texts arrive here too.
  //   EMAIL_BY the Instantly campaign row per lead, which carries the agent's
  //            reply when there is one.
  //   rec().em an email sent from the board itself.
  // Nothing new is stored: this screen only reads. A message we cannot place
  // in time is dropped rather than shown at the top with a guessed date.
  var MSG = false, msgShown = 60, msgQ = "", msgDir = "", msgCh = "", msgDays = 30;
  function msgOff(){
    if (!MSG) return;
    MSG = false; document.body.classList.remove("msg"); $("viewMsg").hidden = true;
    try { if (location.hash === "#messages") history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  }
  function setMsg(on){
    if (!on) { msgOff(); draw(); return; }
    if (ACQ) setAcq(false);
    if (REL) relOff();
    MSG = true; document.body.classList.add("msg"); $("viewMsg").hidden = false;
    msgShown = 60;
    try { history.replaceState(null, "", "#messages"); } catch (e) {}
    draw();
    try { window.scrollTo(0, 0); } catch (e) {}
  }
  // The sheet writes plain dates; anything we cannot read is left out.
  function msgWhen(v){
    if (!v) return "";
    var d = new Date(v);
    return isNaN(d) ? "" : d.toISOString();
  }
  function msgAll(){
    var rows = [], gs = agentGroups();
    gs.list.forEach(function(g){
      var lead = g.leads[0] || null;
      agDoc(g).log.forEach(function(x){
        rows.push({at: x.at, dir: "out", ch: x.k === "email" ? "email" : x.k === "text" ? "text" : "other",
                   kind: AG_KIND[x.k] || "Logged", g: g, lead: lead, body: x.t || "", by: x.by || ""});
      });
    });
    LEADS.forEach(function(l){
      var g = gs.by[l.mls] || null, x = EMAIL_BY[l.mls], e = rec(l.date, l.mls);
      if (x) {
        var added = msgWhen(x.added);
        if (added) rows.push({at: added, dir: "out", ch: "email", kind: x.status || "Emailing",
                              g: g, lead: l, body: "", by: x.by || "Instantly"});
        var got = msgWhen(x.replied);
        if (got) rows.push({at: got, dir: "in", ch: "email", kind: "Replied",
                            g: g, lead: l, body: x.reply || "", by: ""});
      }
      if (e && e.em) rows.push({at: e.em, dir: "out", ch: "email", kind: "Emailed from the board",
                                g: g, lead: l, body: "", by: e.eb || "Someone"});
    });
    rows = rows.filter(function(r){ return r.at && !isNaN(new Date(r.at)); });
    rows.sort(function(a, b){ return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; });
    return rows;
  }
  function msgInWindow(rows){
    if (!msgDays) return rows;
    var from = new Date(Date.now() - msgDays * 864e5).toISOString();
    return rows.filter(function(r){ return r.at >= from; });
  }
  function msgMatch(r){
    if (msgDir && r.dir !== msgDir) return false;
    if (msgCh && r.ch !== msgCh) return false;
    if (!msgQ) return true;
    var hay = [r.g ? r.g.name : "", r.lead ? addrParts(r.lead).s : "", r.lead ? r.lead.mls : "",
               r.body, r.kind, r.by].join(" ").toLowerCase();
    return hay.indexOf(msgQ) >= 0;
  }
  function renderMsg(){
    var all = msgInWindow(msgAll()), rows = all.filter(msgMatch);
    // Reply rate is per agent, not per message: four emails to one agent and
    // one answer is one conversation that replied, not a quarter of them.
    var out = {}, back = {};
    all.forEach(function(r){
      var k = r.g ? r.g.id : r.lead ? "lead-" + r.lead.mls : "";
      if (!k) return;
      if (r.dir === "out") { if (!out[k] || r.at < out[k]) out[k] = r.at; }
      else if (!back[k] || r.at < back[k]) back[k] = r.at;
    });
    var reached = Object.keys(out), waits = [];
    var replied = reached.filter(function(k){
      if (!back[k] || back[k] <= out[k]) return false;
      waits.push((new Date(back[k]) - new Date(out[k])) / 36e5);
      return true;
    });
    waits.sort(function(a, b){ return a - b; });
    var med = waits.length ? (waits.length % 2 ? waits[(waits.length - 1) / 2]
            : (waits[waits.length / 2 - 1] + waits[waits.length / 2]) / 2) : null;
    var nOut = all.filter(function(r){ return r.dir === "out"; }).length;
    var nIn = all.length - nOut;
    var rate = reached.length ? Math.round(replied.length / reached.length * 1000) / 10 : null;
    $("msgTiles").innerHTML =
      '<div class="kpi"><dt>Agents reached</dt><dd>' + reached.length + '</dd><div class="sub">' + nOut + ' sent</div></div>' +
      '<div class="kpi"><dt>Replied</dt><dd>' + replied.length + '</dd><div class="sub">' + nIn + ' messages back</div></div>' +
      '<div class="kpi"><dt>Reply rate</dt><dd>' + (rate === null ? "—" : rate + "%") + '</dd>' +
        '<div class="meter"><span style="width:' + (rate || 0) + '%"></span></div></div>' +
      '<div class="kpi"><dt>Median reply</dt><dd>' + (med === null ? "—" : med < 1 ? Math.round(med * 60) + "m"
        : med < 48 ? Math.round(med * 10) / 10 + "h" : Math.round(med / 24) + "d") + '</dd>' +
        '<div class="sub">after our first message</div></div>' +
      '<div class="kpi"><dt>Awaiting reply</dt><dd>' + (reached.length - replied.length) + '</dd>' +
        '<div class="sub">no answer yet</div></div>';
    var cOut = all.filter(function(r){ return r.dir === "out"; }).length;
    var cIn = all.length - cOut;
    var cEm = all.filter(function(r){ return r.ch === "email"; }).length;
    var cTx = all.filter(function(r){ return r.ch === "text"; }).length;
    function chip(k, v, lbl, n){ return '<button type="button" class="msg-chip" data-msg-' + k + '="' + v +
      '" aria-pressed="' + ((k === "dir" ? msgDir : msgCh) === v) + '">' + lbl + '<span class="n">' + n + '</span></button>'; }
    $("msgChips").innerHTML =
      chip("dir", "", "All", all.length) + chip("dir", "out", "Sent", cOut) + chip("dir", "in", "Replies", cIn) +
      chip("ch", "email", "Email", cEm) + chip("ch", "text", "Text", cTx);
    var shown = rows.slice(0, msgShown);
    $("msgBody").innerHTML = shown.length ? shown.map(function(r){
      var pa = r.lead ? addrParts(r.lead) : null;
      return '<tr><td class="w">' + esc(noteWhen(r.at)) + '</td>' +
        '<td><span class="msg-dir ' + (r.dir === "in" ? "d-in" : "d-out") + '">' + (r.dir === "in" ? "In" : "Out") + '</span>' +
          '<span class="msg-ch">' + esc(r.ch === "text" ? "SMS" : r.ch === "email" ? "Email" : "Other") + '</span>' +
          '<span class="msg-kind">' + esc(r.kind) + (r.by ? " · " + esc(r.by) : "") + '</span></td>' +
        '<td class="who">' + (r.g ? '<b>' + esc(r.g.name) + '</b>' + (r.g.broker ? '<small>' + esc(r.g.broker) + '</small>' : '')
                                  : '<b class="none">—</b>') + '</td>' +
        '<td class="who">' + (pa ? '<button type="button" class="ag-l-a" data-msg-lead="' + esc(r.lead.mls) + '">' +
            esc(pa.s) + '</button><small>' + esc(r.lead.mls) + '</small>' : '<small>—</small>') + '</td>' +
        '<td class="body">' + (r.body ? esc(r.body) : '<span class="none">no message body recorded</span>') + '</td></tr>';
    }).join("") : '<tr><td colspan="5"><div class="empty"><b>Nothing in this window</b>' +
        (all.length ? "Widen the dates, or clear the filters." :
         "Emails sent through Instantly and texts logged against an agent will appear here.") + '</div></td></tr>';
    $("msgMore").hidden = rows.length <= shown.length;
    $("msgMore").textContent = "Show more (" + (rows.length - shown.length) + " older)";
    $("msgNote").textContent = rows.length
      ? "Showing " + shown.length + " of " + rows.length + " messages" + (msgDays ? " in the last " + msgDays + " days" : "") + "."
      : "";
  }
  document.addEventListener("click", function(ev){
    var t = ev.target.closest && ev.target.closest("[data-msg-dir],[data-msg-ch],[data-msg-lead],#msgMore");
    if (!t) return;
    if (t.id === "msgMore") { msgShown += 60; renderMsg(); return; }
    if (t.dataset.msgLead != null) { openSide(t.dataset.msgLead, null); return; }
    if (t.dataset.msgDir != null) { msgDir = t.dataset.msgDir; msgShown = 60; renderMsg(); return; }
    if (t.dataset.msgCh != null) { msgCh = msgCh === t.dataset.msgCh ? "" : t.dataset.msgCh; msgShown = 60; renderMsg(); }
  });
  document.addEventListener("input", function(ev){
    if (ev.target.id !== "msgQ") return;
    msgQ = ev.target.value.trim().toLowerCase(); msgShown = 60; renderMsg();
  });
  document.addEventListener("change", function(ev){
    if (ev.target.id !== "msgDays") return;
    msgDays = +ev.target.value || 0; msgShown = 60; renderMsg();
  });

  function relDueCount(){"""

DRAW_ANCHOR = '    if (REL) { renderRel(); if (!$("side").hidden) drawSide(); drawNav(); return; }'
DRAW_NEW = ('    if (MSG) { renderMsg(); if (!$("side").hidden) drawSide(); drawNav(); return; }\n'
            + DRAW_ANCHOR)

NAVCUR_ANCHOR = '  function navCurrent(){ return REL ? "rel" : ACQ ? "acq" :'
NAVCUR_NEW = '  function navCurrent(){ return MSG ? "log" : REL ? "rel" : ACQ ? "acq" :'

ROUTE_ANCHOR = """    if (REL && k !== "rel" && k !== "set" && k !== "agents") relOff();
    if (k === "rel") { setRel(true); return; }"""
ROUTE_NEW = """    if (REL && k !== "rel" && k !== "set" && k !== "agents") relOff();
    if (MSG && k !== "log" && k !== "set" && k !== "agents") msgOff();
    if (k === "log") { setMsg(true); return; }
    if (k === "rel") { setRel(true); return; }"""

EDITS = [
    ("the screen's styles", CSS_ANCHOR, CSS_NEW),
    ("the screen's markup", MARKUP_ANCHOR, MARKUP_NEW),
    ("enable the nav button", NAVBTN_ANCHOR, NAVBTN_NEW),
    ("the screen's code", JS_ANCHOR, JS_NEW),
    ("draw() dispatch", DRAW_ANCHOR, DRAW_NEW),
    ("navCurrent()", NAVCUR_ANCHOR, NAVCUR_NEW),
    ("nav routing", ROUTE_ANCHOR, ROUTE_NEW),
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
