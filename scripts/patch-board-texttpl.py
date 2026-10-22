#!/usr/bin/env python3
"""Add a Text Templates screen to the Lead Board.

Bryan, 21:25 on 22 Oct: "are you able to save the template here on the artifact
create a text template here where can we add the text template so we can test
what is working and not".

Three things, in that order:

  SAVE IT HERE   The wording lives in the board's own `templates` collection
                 rather than inside a script in a repo nobody on the team can
                 open. Whoever is looking at the board can read it.

  ADD ONE        A dialog off the left menu, the same shape as Buy Box
                 Settings and AI Agents: write a template, name it, save it
                 for the team, pick which one is live.

  TEST IT        Each template carries its own Sent / Replied / Reply rate,
                 counted off the agent log, so "what is working and not" is a
                 number on the card instead of an opinion.

The placeholders are the ones the sender already fills:
[Agent Name], [Name], [Property Address] and [Question] — the last one being
the opening question, which swaps on the listing's age and so cannot be typed
into the template by hand.

Storage: `templates/<id>` for each template, `templates/_active` for which one
is live. `_active` is a document of its own rather than a flag on each
template, so switching is ONE write instead of one per template — two people
switching at once can't leave two live or none.

Anchors are exact strings from the live page; if one stops matching, the page
changed underneath and the patch should be re-derived rather than forced.

    python3 scripts/patch-board-texttpl.py <in.html> <out.html>
"""
import sys

# --- 1. styles -------------------------------------------------------------
# The heading alone appears twice — once over the stylesheet and once over the
# matching block of script — so the anchor carries the CSS line beneath it.
CSS_ANCHOR = """/* ---------- Email & SMS Log (#messages) ---------- */
body.msg .controls,"""

CSS_NEW = """/* ---------- Text templates (22 Oct) ---------- */
#tplDlg{border:1px solid var(--line); border-radius:12px; padding:0; width:min(860px, calc(100% - 24px));
  max-height:calc(100vh - 32px); background:var(--surface); color:var(--ink);
  box-shadow:0 24px 60px -20px rgba(10,30,50,.55); overflow:hidden}
#tplDlg::backdrop{background:rgba(4,10,22,.6)}
#tplDlg[open]{display:flex}
.tpl-wrap{display:flex; flex-direction:column; width:100%; max-height:calc(100vh - 34px); min-height:0}
.tpl-scroll{overflow:auto; padding:20px 22px 8px; flex:1 1 auto; min-height:0}
.tpl-head{display:flex; align-items:center; justify-content:space-between; gap:12px}
.tpl-head h2{font-family:Archivo,sans-serif; font-size:19px; margin:0; letter-spacing:-.01em}
.tpl-keys{display:flex; flex-wrap:wrap; gap:6px; margin:10px 0 2px}
.tpl-keys code{font:600 11.5px "IBM Plex Mono",ui-monospace,monospace; background:var(--b-review); color:var(--t-review);
  border-radius:5px; padding:2px 7px}
.tpl-keys code small{font-family:"Public Sans",sans-serif; font-weight:400; color:var(--muted); margin-left:5px}
.tpl-card{border:1px solid var(--line); border-top:3px solid var(--line); border-radius:10px; background:var(--surface);
  padding:12px 14px 14px; margin-top:12px}
.tpl-card.live{border-top-color:var(--m-won); background:var(--surface-2)}
.tpl-top{display:flex; flex-wrap:wrap; align-items:center; gap:8px 12px}
.tpl-name{font:600 14px "Public Sans",sans-serif; flex:1 1 180px; min-width:0}
.tpl-live{display:inline-block; font:700 10px Archivo,sans-serif; letter-spacing:.08em; text-transform:uppercase;
  border-radius:999px; padding:2px 9px; background:var(--b-won); color:var(--t-won)}
.tpl-body{display:block; width:100%; margin-top:9px; font:13.5px "Public Sans",sans-serif; line-height:1.5; color:var(--ink);
  background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:9px 11px; resize:vertical; min-height:92px}
.tpl-prev{margin-top:8px; border-left:3px solid var(--brand-2); padding:4px 0 4px 10px; font-size:12.5px; line-height:1.5; color:var(--ink)}
.tpl-prev b{display:block; font:600 10px Archivo,sans-serif; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); margin-bottom:2px}
.tpl-prev .alt{color:var(--muted); margin-top:5px}
.tpl-stats{display:flex; flex-wrap:wrap; gap:7px; margin-top:10px}
.tpl-stat{border:1px solid var(--line-soft); border-radius:8px; background:var(--surface-2); padding:6px 11px; min-width:84px}
.tpl-stat dt{font:600 9.5px Archivo,sans-serif; letter-spacing:.09em; text-transform:uppercase; color:var(--muted); margin:0}
.tpl-stat dd{font:500 19px "IBM Plex Mono",ui-monospace,monospace; font-variant-numeric:tabular-nums; margin:1px 0 0; letter-spacing:-.02em}
.tpl-stat.none dd{color:var(--muted)}
.tpl-stat.win dd{color:var(--t-won)}
.tpl-untested{font-size:12px; color:var(--muted); font-style:italic; margin:8px 0 0}
.tpl-acts{display:flex; flex-wrap:wrap; gap:7px; margin-top:11px; align-items:center}
.tpl-acts .sp{flex:1}
.tpl-meta{font-size:11.5px; color:var(--muted)}
.tpl-foot{flex:none; display:flex; flex-wrap:wrap; gap:9px; align-items:center; justify-content:space-between;
  padding:12px 22px 16px; border-top:1px solid var(--line)}
.tpl-none{padding:16px 2px; font-size:13px; color:var(--muted)}
.tpl-none b{display:block; color:var(--ink); margin-bottom:4px; font-family:Archivo,sans-serif}
@media (max-width:620px){ .tpl-stats .tpl-stat{flex:1 1 44%} }

/* ---------- Email & SMS Log (#messages) ---------- */
body.msg .controls,"""

# --- 2. the left-menu button ----------------------------------------------
NAV_ANCHOR = """<span class="lbl-t">Email &amp; SMS Log</span></button>"""

NAV_NEW = """<span class="lbl-t">Email &amp; SMS Log</span></button>
    <button type="button" data-nav="tpl" title="The wording we text a listing agent, and how each one is performing"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.5 5.5h15v10h-9l-4 3.5z"/><path d="M8 9h8M8 12h5"/></svg><span class="lbl-t">Text Templates</span></button>"""

# --- 3. the dialog ---------------------------------------------------------
DLG_ANCHOR = """  <dialog id="agentsDlg" aria-labelledby="agentsTitle">"""

DLG_NEW = """  <dialog id="tplDlg" aria-labelledby="tplTitle">
    <div class="tpl-wrap">
      <div class="tpl-scroll" id="tplScroll">
        <div class="tpl-head"><h2 id="tplTitle">Text templates</h2><button type="button" class="btn tiny" id="tplX">Close ✕</button></div>
        <p class="dlg-sub">The wording we text a listing agent the first time, saved here for <b>the whole team</b> rather than
          buried in a script. One is live at a time; the rest sit here so we can try a different line and see which gets answered.</p>
        <div class="tpl-keys">
          <code>[Agent Name]<small>their first name</small></code>
          <code>[Name]<small>whoever pressed Push to REI</small></code>
          <code>[Property Address]<small>street and city</small></code>
          <code>[Question]<small>swaps on the listing's age</small></code>
        </div>
        <p class="dlg-sub" style="margin-top:8px">The name and address are read back out of the REI contact when the text is sent, so a contact
          created wrong shows up instead of being papered over. <b>[Question]</b> is <i>When are you reviewing offers?</i> on a listing up to a week
          old, and <i>Is it still available?</i> once it is older, has had a price cut, or is back on the market.</p>
        <div id="tplList"></div>
      </div>
      <div class="tpl-foot">
        <button type="button" class="btn" id="tplAdd">+ Add a template</button>
        <span class="tpl-meta" id="tplNote"></span>
      </div>
    </div>
  </dialog>
  <dialog id="agentsDlg" aria-labelledby="agentsTitle">"""

# --- 4. the left-menu dispatcher ------------------------------------------
NAVJS_ANCHOR = """    else if (k === "bbox") openBbx();"""

NAVJS_NEW = """    else if (k === "bbox") openBbx();
    else if (k === "tpl") openTpl();"""

# --- 5. the screen's own code ---------------------------------------------
# Goes next to the other dialog wiring, inside the one IIFE, so TPLS and
# TPL_ACTIVE are the same variables the db snapshot below assigns.
JS_ANCHOR = """  $("agentsClose").addEventListener("click", function(){ closeDlg("agentsDlg"); });"""

JS_NEW = r"""  $("agentsClose").addEventListener("click", function(){ closeDlg("agentsDlg"); });

  /* ---------- Text templates ---------- */
  // What we text a listing agent first, kept on the board instead of inside a
  // script, so the people who write to agents can read and change it.
  var TPLS = {}, TPL_ACTIVE = "", tplDraft = {};
  // The wording Bryan approved at 21:04 on 22 Oct. Offered as a starting
  // point, NOT written on load: a page opening must never put words in the
  // team's mouth. Somebody presses Save and then it exists.
  var TPL_SEED = "Hi [Agent Name], [Name] with Twin Home Buyer. We're interested in [Property Address]. " +
                 "[Question] We have 120 Google reviews. We're also looking to build long-term relationships " +
                 "with local agents. Can I ask you a couple quick questions about the property?";
  var TPL_Q_NEW = "When are you reviewing offers?", TPL_Q_OLD = "Is it still available?";

  function tplFill(body, q){
    return String(body || "")
      .replace(/\[Agent Name\]/g, "Terri")
      .replace(/\[Name\]/g, myName || "Gen")
      .replace(/\[Property Address\]/g, "1409 Hamilton Way, San Jose")
      .replace(/\[Question\]/g, q);
  }

  // Sent counts the outbound texts stamped with this template. Replied counts
  // AGENTS, not messages: one agent writing back three times is one agent who
  // answered, and a reply only counts if it came AFTER we wrote.
  function tplStats(id){
    var sent = 0, replied = 0;
    Object.keys(AGDOCS).forEach(function(aid){
      var d = AGDOCS[aid];
      if (!d || typeof d !== "object" || !d.log || typeof d.log !== "object") return;
      var mine = [], ins = [];
      Object.keys(d.log).forEach(function(k){
        var x = d.log[k];
        if (!x || typeof x !== "object" || x.del || typeof x.at !== "string") return;
        if (msgDirOf(x) === "in") ins.push(x.at);
        else if (x.tpl === id) mine.push(x.at);
      });
      if (!mine.length) return;
      sent += mine.length;
      mine.sort();
      if (ins.some(function(t){ return t > mine[0]; })) replied++;
    });
    return {sent: sent, replied: replied};
  }

  function tplCard(id, t){
    var live = id === TPL_ACTIVE, s = tplStats(id);
    var body = Object.prototype.hasOwnProperty.call(tplDraft, id) ? tplDraft[id] : (t.body || "");
    var rate = s.sent ? Math.round(s.replied / s.sent * 100) : null;
    var dirty = body !== (t.body || "");
    return '<div class="tpl-card' + (live ? ' live' : '') + '" data-tpl="' + esc(id) + '">' +
      '<div class="tpl-top">' +
        '<input class="tpl-name" type="text" maxlength="60" data-tplname="' + esc(id) + '" value="' + esc(t.name || "Untitled") + '" aria-label="Template name">' +
        (live ? '<span class="tpl-live">Live</span>'
              : '<button type="button" class="btn tiny" data-tpluse="' + esc(id) + '">Use this one</button>') +
      '</div>' +
      '<textarea class="tpl-body" data-tplbody="' + esc(id) + '" rows="4" aria-label="Template wording">' + esc(body) + '</textarea>' +
      '<div class="tpl-prev"><b>How it reads</b>' + esc(tplFill(body, TPL_Q_NEW)) +
        '<div class="alt">On an older listing: ' + esc(tplFill(body, TPL_Q_OLD)) + '</div></div>' +
      (s.sent
        ? '<div class="tpl-stats">' +
            '<dl class="tpl-stat"><dt>Sent</dt><dd>' + s.sent + '</dd></dl>' +
            '<dl class="tpl-stat' + (s.replied ? ' win' : ' none') + '"><dt>Replied</dt><dd>' + s.replied + '</dd></dl>' +
            '<dl class="tpl-stat' + (rate ? ' win' : ' none') + '"><dt>Reply rate</dt><dd>' + rate + '%</dd></dl>' +
          '</div>'
        : '<p class="tpl-untested">Not sent yet — nothing to judge it on.</p>') +
      '<div class="tpl-acts">' +
        '<button type="button" class="btn tiny go" data-tplsave="' + esc(id) + '"' + (dirty ? '' : ' disabled') + '>' +
          (dirty ? 'Save for the team' : 'Saved') + '</button>' +
        '<span class="sp"></span>' +
        '<span class="tpl-meta">' + (t.by ? 'by ' + esc(t.by) : '') + (t.at ? ' · ' + esc(fmtDate(t.at.slice(0, 10))) : '') + '</span>' +
        (live ? '' : '<button type="button" class="btn tiny" data-tpldel="' + esc(id) + '">Delete</button>') +
      '</div>' +
    '</div>';
  }

  function tplDraw(){
    var ids = Object.keys(TPLS).sort(function(a, b){
      if (a === TPL_ACTIVE) return -1;
      if (b === TPL_ACTIVE) return 1;
      return (TPLS[b].at || "") < (TPLS[a].at || "") ? -1 : 1;
    });
    $("tplList").innerHTML = ids.length
      ? ids.map(function(id){ return tplCard(id, TPLS[id] || {}); }).join("")
      : '<div class="tpl-none"><b>No template saved yet.</b>' +
        'The wording the team approved is below — press Save and it becomes the live one. ' +
        'Nothing is stored until somebody does.</div>' +
        tplCard("__seed__", {name: "Approved wording", body: TPL_SEED});
    var live = TPL_ACTIVE && TPLS[TPL_ACTIVE];
    $("tplNote").textContent = live
      ? 'Live: "' + (TPLS[TPL_ACTIVE].name || "Untitled") + '" — this is what a new push texts.'
      : "Nothing is live yet, so a push sends no text until one is picked.";
  }

  function openTpl(){ if (!$("tplDlg").open) openDlg("tplDlg"); tplDraw(); $("tplScroll").scrollTop = 0; }
  $("tplX").addEventListener("click", function(){ closeDlg("tplDlg"); });

  $("tplAdd").addEventListener("click", function(){
    var id = "t" + Date.now().toString(36);
    TPLS[id] = {name: "New template", body: TPL_SEED, at: "", by: ""};
    tplDraft[id] = TPL_SEED;
    tplDraw();
  });

  // Typing redraws the preview but writes nothing — Save is the only write.
  $("tplList").addEventListener("input", function(ev){
    var b = ev.target.closest("[data-tplbody]");
    if (b) { tplDraft[b.dataset.tplbody] = b.value; }
    var n = ev.target.closest("[data-tplname]");
    if (n || b) {
      var card = ev.target.closest(".tpl-card"), id = card && card.dataset.tpl;
      if (!id) return;
      if (n) (TPLS[id] = TPLS[id] || {}).name = n.value;
      var sv = card.querySelector("[data-tplsave]");
      if (sv) { sv.disabled = false; sv.textContent = "Save for the team"; }
      var pv = card.querySelector(".tpl-prev");
      if (pv && b) {
        pv.innerHTML = '<b>How it reads</b>' + esc(tplFill(b.value, TPL_Q_NEW)) +
                       '<div class="alt">On an older listing: ' + esc(tplFill(b.value, TPL_Q_OLD)) + '</div>';
      }
    }
  });

  $("tplList").addEventListener("click", function(ev){
    var t = ev.target;
    var save = t.closest("[data-tplsave]"), use = t.closest("[data-tpluse]"), del = t.closest("[data-tpldel]");
    if (!save && !use && !del) return;
    if (!db) { toast("Can't reach the shared board — nothing saved"); return; }

    if (save) {
      var sid = save.dataset.tplsave;
      var card = save.closest(".tpl-card");
      var nameEl = card.querySelector("[data-tplname]"), bodyEl = card.querySelector("[data-tplbody]");
      var body = bodyEl ? bodyEl.value.trim() : "";
      if (!body) { toast("A template needs some wording"); return; }
      // A seed card has no id of its own until it is saved.
      var id = sid === "__seed__" ? "t" + Date.now().toString(36) : sid;
      var doc = {name: (nameEl ? nameEl.value.trim() : "") || "Untitled", body: body,
                 at: new Date().toISOString(), by: myName || "Someone"};
      save.disabled = true; save.textContent = "Saving…";
      db.doc("templates/" + id).set(doc).then(function(){
        TPLS[id] = doc; delete tplDraft[sid]; delete tplDraft[id];
        if (sid === "__seed__" || !TPL_ACTIVE) {
          return db.doc("templates/_active").set({id: id, at: doc.at, by: doc.by}).then(function(){
            TPL_ACTIVE = id; toast("✓ Saved and set live for the team");
          });
        }
        toast("✓ Saved for the team");
      }).catch(function(){ toast("Could not save — nothing changed"); })
        .then(function(){ tplDraw(); });
      return;
    }

    if (use) {
      var uid = use.dataset.tpluse;
      use.disabled = true;
      db.doc("templates/_active").set({id: uid, at: new Date().toISOString(), by: myName || "Someone"})
        .then(function(){ TPL_ACTIVE = uid; toast("✓ That one is live now"); })
        .catch(function(){ toast("Could not switch — nothing changed"); })
        .then(function(){ tplDraw(); });
      return;
    }

    // Delete asks on the button itself, the way Remove does elsewhere here,
    // rather than throwing a dialog in front of a one-line change.
    var did = del.dataset.tpldel;
    if (del.dataset.sure !== "1") {
      del.dataset.sure = "1"; del.textContent = "Really delete?"; del.classList.add("sure");
      setTimeout(function(){ if (del.dataset.sure === "1") { del.dataset.sure = ""; del.textContent = "Delete"; del.classList.remove("sure"); } }, 4000);
      return;
    }
    db.doc("templates/" + did).delete().then(function(){
      delete TPLS[did]; delete tplDraft[did]; toast("Deleted");
    }).catch(function(){ toast("Could not delete"); }).then(function(){ tplDraw(); });
  });"""

# --- 6. read the collection ------------------------------------------------
DB_ANCHOR = """      db.collection("agents").onSnapshot(function(snap){
        var next = {};
        snap.docs.forEach(function(d){ next[d.id] = d.data() || {}; });
        AGDOCS = next;
        draw();
      }, function(){});"""

DB_NEW = """      db.collection("agents").onSnapshot(function(snap){
        var next = {};
        snap.docs.forEach(function(d){ next[d.id] = d.data() || {}; });
        AGDOCS = next;
        draw();
      }, function(){});
      // what we text a listing agent first, and which wording is live
      db.collection("templates").onSnapshot(function(snap){
        var next = {}, act = "";
        snap.docs.forEach(function(d){
          var x = d.data() || {};
          if (d.id === "_active") { act = typeof x.id === "string" ? x.id.slice(0, 40) : ""; return; }
          if (typeof x.body !== "string") return;
          next[d.id] = {name: str(x.name, 60), body: str(x.body, 1200), at: str(x.at, 40), by: str(x.by, 40)};
        });
        TPLS = next; TPL_ACTIVE = next[act] ? act : "";
        if ($("tplDlg").open) tplDraw();
      }, function(){});"""

EDITS = [
    ("the styles", CSS_ANCHOR, CSS_NEW),
    ("the left-menu button", NAV_ANCHOR, NAV_NEW),
    ("the dialog", DLG_ANCHOR, DLG_NEW),
    ("the left-menu dispatcher", NAVJS_ANCHOR, NAVJS_NEW),
    ("the screen's code", JS_ANCHOR, JS_NEW),
    ("reading the collection", DB_ANCHOR, DB_NEW),
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
