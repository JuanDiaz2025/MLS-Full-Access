# Paste this into a new Claude Code session

Start a new session on **JuanDiaz2025/MLS-Full-Access**, branch
**claude/keen-meitner-t4gora**, then paste everything below the line.

It takes about a minute. After it finishes, pressing "Push to REI" on the
board reaches Claude in seconds instead of up to a minute.

---

Publish one change to an existing published Artifact. Do only this, then stop.

The Twin Network Lead Board is a published Artifact:
https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1

When someone presses its "Push to REI" button, the lead is recorded in the
artifact database and a Claude session creates the contact in REI BlackBook.
Today that session only notices on a once-a-minute poll. This change makes the
board fire a routine directly on the press, so it is noticed in seconds. The
routine already exists and is enabled: trig_01HpqDG1NKtnxkxuQN9JFbHH

Steps:

1. Artifact action:"read" with url https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1
   It saves the live page to a local .html file and tells you the path. Read
   that file fully with the Read tool (allow_large: true) — the publish is
   refused until you have.

2. Make exactly three edits to that saved file with the Edit tool. Change
   nothing else. If any old_string is not found exactly once, STOP and report
   which one — do not improvise a near-match.

EDIT 1 — old_string:
  function reiSendToDrive(mls, c){

EDIT 1 — new_string:
  // Fire the session routine the moment someone presses, so the contact gets
  // made in seconds instead of waiting for the every-minute poll to come
  // round. Best effort and deliberately silent: a viewer without the Claude
  // Code Remote connector still has the push recorded in reipush, and the
  // poll collects it — this only decides whether that takes a second or up
  // to a minute.
  var REI_WAKE = "trig_01HpqDG1NKtnxkxuQN9JFbHH";
  function reiPoke(mls, who){
    if (!mcp || !mcp.callTool) return;
    try {
      mcp.callTool("Claude Code Remote", "fire_trigger", {
        trigger_id: REI_WAKE,
        text: "Push to REI pressed for MLS " + mls + " by " + (who || "someone") + " — it is in the queue now."
      }).catch(function(){});
    } catch (e) {}
  }
  function reiSendToDrive(mls, c){

EDIT 2 — old_string:
        toast("✓ Creating it in REI — usually under a minute");
        reiWatch();
        reiSendToDrive(f.mls, f.c).catch(function(){});

EDIT 2 — new_string:
        toast("✓ Creating it in REI — usually within seconds");
        reiWatch();
        reiPoke(f.mls, body.by);
        reiSendToDrive(f.mls, f.c).catch(function(){});

EDIT 3 — old_string:
      .then(function(){ toast(how === "manual" ? "✓ Recorded — paste it into REI BlackBook"
                              : how === "bridge" ? "✓ Creating it in REI — see the tab that opened"
                                                 : "✓ Queued — the server is creating this contact"); })

EDIT 3 — new_string:
      .then(function(){
        if (how === "queue") reiPoke(f.mls, body.by);
        toast(how === "manual" ? "✓ Recorded — paste it into REI BlackBook"
              : how === "bridge" ? "✓ Creating it in REI — see the tab that opened"
                                 : "✓ Queued — the server is creating this contact");
      })

3. Publish that edited file: Artifact action:"publish", url
   https://claude.ai/artifact/HawhBkTkvpFaqz8YFLArh1, file_path = the file you
   edited, label "Instant Push to REI wake", and capabilities EXACTLY as below.
   This is the full set — the artifact's stored declaration plus the one new
   server. Passing less would revoke what the board already relies on (Google
   Drive, its database, its access rules), so do not trim it:

{"assets":{},"db":{"rules":[{"path":"","read":"view","write":"interact"}]},"downloads":{},"mcp":{"servers":[{"server":"Google Drive","tools":["download_file_content","search_files","create_file"]},{"server":"Claude Code Remote","tools":["fire_trigger"]}]},"room":{},"user":{"scopes":["profile"]}}

   If the publish is refused because the live version changed under you, it
   hands you the newer content: merge the three edits into that and publish
   again. Never resend refused content unchanged and never pass force.

4. Report whether it published and the new version. Do not commit or push
   anything to git. Do not change any other file, routine, or artifact.
