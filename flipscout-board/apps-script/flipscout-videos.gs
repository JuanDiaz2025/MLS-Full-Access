/**
 * FlipScout — property video uploads to Google Drive.
 *
 * The Lead Board's own file storage stops at 20 MB a file and its Drive
 * connector at 16 MB, so a 5-10 minute walkthrough (~50 MB) cannot go
 * through the board. The board's "🎬 Upload video" button opens this web
 * app in a new tab instead. The phone sends the video here in 4 MB pieces;
 * the script streams them into one file in Drive with a resumable upload,
 * so there is no size limit worth worrying about.
 *
 *   Drive:  FlipScout property videos / <address> · <MLS #> / <video>
 *           each video: anyone at Twin Home Buyer with the link can view
 *   Sheet:  "Videos" tab of the prod sheet (Updated Flip Scout Agent) —
 *           one row per video. The board reads it when you come back to
 *           its tab and shows a Watch / Download card on the lead.
 *
 * Setup (once): script.google.com → New project → paste this file →
 * Deploy → New deployment → Web app → Execute as: Me · Who has access:
 * Anyone within Twin Home Buyer → Deploy → authorize → copy the Web app URL
 * and send it to Claude (it goes into the board as VIDEO_BRIDGE).
 *
 * Runs as the person who deploys it (Bryan), so every video lands in that
 * person's Drive, in one place. To use a company Shared drive instead, put
 * the id of a folder in it in ROOT_ID (the part of the folder's link after
 * /folders/); the deployer needs to be able to add files there. The upload session stays on the server
 * (CacheService); the page only ever holds an opaque id for it.
 */

var SHEET_ID = '1DAZ_FrU_I8Yh2cKpa10U05EueLl7ctrBlVi6eFErXGQ';
var ROOT_NAME = 'FlipScout property videos';
var ROOT_ID = '';                         // optional: a folder id (e.g. in a Shared drive)
var TAB = 'Videos';
var HEAD = ['Added On', 'MLS #', 'Address', 'File', 'Link', 'Download', 'Added By', 'Size MB', 'File Id'];
var CHUNK = 4 * 1024 * 1024;              // a multiple of 256 KB, as Drive requires
var MAX_BYTES = 2 * 1024 * 1024 * 1024;   // 2 GB — a sanity bound, not a real limit

function doGet(e) {
  var p = (e && e.parameter) || {};
  var ctx = {
    mls: String(p.mls || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20),
    addr: String(p.addr || '').slice(0, 160),
    by: String(p.by || '').slice(0, 60),
    chunk: CHUNK
  };
  var out = HtmlService.createHtmlOutput(PAGE.replace('__CTX__', JSON.stringify(ctx).replace(/</g, '\\u003c')))
    .setTitle('Upload a property video')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  return out;
}

/** Start one upload: make the folders, open a resumable session in Drive. */
function startUpload(meta) {
  var mls = String(meta.mls || '').toUpperCase();
  if (!/^[A-Z0-9]{5,20}$/.test(mls)) throw new Error('This link has no MLS # — open it from the board.');
  var size = Number(meta.size) || 0;
  if (size <= 0 || size > MAX_BYTES) throw new Error('That file is empty or too large.');
  var name = String(meta.name || 'video').replace(/[\\\/:*?"<>|\u0000-\u001f]/g, ' ').slice(0, 150);
  var type = /^[\w.+-]+\/[\w.+-]+$/.test(meta.type || '') ? meta.type : 'application/octet-stream';
  var folder = propertyFolder_(mls, String(meta.addr || ''));

  var res = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: {
      Authorization: 'Bearer ' + ScriptApp.getOAuthToken(),
      'X-Upload-Content-Type': type,
      'X-Upload-Content-Length': String(size)
    },
    payload: JSON.stringify({name: name, parents: [folder.getId()]}),
    muteHttpExceptions: true
  });
  var h = res.getAllHeaders(), loc = h.Location || h.location;
  if (res.getResponseCode() !== 200 || !loc) throw new Error('Drive would not start the upload (' + res.getResponseCode() + ').');

  var id = Utilities.getUuid();
  CacheService.getUserCache().put('up_' + id, JSON.stringify({
    loc: loc, size: size, mls: mls, addr: String(meta.addr || '').slice(0, 160),
    name: name, by: String(meta.by || '').slice(0, 60) || Session.getActiveUser().getEmail()
  }), 6 * 60 * 60);
  return {upload: id, chunk: CHUNK};
}

/** One piece of the file, base64. Returns {next} until Drive has it all, then the links. */
function putChunk(upload, start, b64) {
  var raw = CacheService.getUserCache().get('up_' + upload);
  if (!raw) throw new Error('This upload expired — start it again.');
  var up = JSON.parse(raw);
  var bytes = Utilities.base64Decode(b64);
  var end = start + bytes.length - 1;
  var res = UrlFetchApp.fetch(up.loc, {
    method: 'put',
    contentType: 'application/octet-stream',
    headers: {Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'Content-Range': 'bytes ' + start + '-' + end + '/' + up.size},
    payload: bytes,
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code === 308) return {next: end + 1};
  if (code !== 200 && code !== 201) throw new Error('Drive refused part of the file (' + code + '). Try again.');
  var fileId = JSON.parse(res.getContentText()).id;
  CacheService.getUserCache().remove('up_' + upload);
  return finish_(fileId, up);
}

function finish_(fileId, up) {
  var file = DriveApp.getFileById(fileId);
  try { file.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  var link = 'https://drive.google.com/file/d/' + fileId + '/view';
  var dl = 'https://drive.google.com/uc?export=download&id=' + fileId;
  var sh = videosTab_();
  sh.appendRow([new Date(), up.mls, up.addr, up.name, link, dl, up.by, Math.round(up.size / 1048576 * 10) / 10, fileId]);
  return {done: true, link: link, download: dl, folder: file.getParents().hasNext() ? file.getParents().next().getUrl() : ''};
}

function propertyFolder_(mls, addr) {
  var root;
  if (ROOT_ID) root = DriveApp.getFolderById(ROOT_ID);
  else { var roots = DriveApp.getFoldersByName(ROOT_NAME); root = roots.hasNext() ? roots.next() : DriveApp.createFolder(ROOT_NAME); }
  // one folder per property; the MLS # in the name is what finds it again
  var it = root.getFolders();
  while (it.hasNext()) { var f = it.next(); if (f.getName().indexOf(mls) !== -1) return f; }
  var street = addr.split(',')[0].trim();
  var f2 = root.createFolder((street ? street + ' · ' : '') + mls);
  try { f2.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) {}
  return f2;
}

function videosTab_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(TAB) || ss.insertSheet(TAB);
  var cur = sh.getRange(1, 1, 1, HEAD.length).getValues()[0];
  if (cur.join('|') !== HEAD.join('|')) sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold');
  return sh;
}

var PAGE = '<!doctype html><html><head><base target="_top"><style>' +
  'body{margin:0;font:15px system-ui,-apple-system,sans-serif;background:#EDF2F8;color:#14202E}' +
  '.w{max-width:520px;margin:0 auto;padding:22px 18px}' +
  'h1{font-size:20px;margin:0 0 4px}.sub{color:#57687C;font-size:13px;margin:0 0 18px}' +
  '.card{background:#fff;border:1px solid #D3DEEB;border-radius:12px;padding:18px}' +
  'label.pick{display:block;text-align:center;padding:26px 12px;border:2px dashed #9FB4CC;border-radius:10px;cursor:pointer;font-weight:600;color:#0D5A87}' +
  'input[type=file]{display:none}.name{margin-top:12px;font-size:13px;color:#57687C;word-break:break-all}' +
  'button{margin-top:14px;width:100%;min-height:46px;border:0;border-radius:10px;background:#0D5A87;color:#fff;font:600 15px system-ui;cursor:pointer}' +
  'button[disabled]{background:#9FB4CC}.bar{height:10px;border-radius:99px;background:#E6EDF6;overflow:hidden;margin-top:16px}' +
  '.bar i{display:block;height:100%;width:0;background:#0E8585;transition:width .3s}.msg{margin-top:10px;font-size:14px}' +
  '.ok{color:#146B4C;font-weight:600}.err{color:#8B1A36;font-weight:600}a{color:#0B6FB0}' +
  '</style></head><body><div class="w"><h1>Upload a property video</h1><p class="sub" id="for"></p><div class="card">' +
  '<label class="pick" for="f">Tap to choose a video</label><input type="file" id="f" accept="video/*,image/*">' +
  '<div class="name" id="n"></div><button id="go" disabled>Upload</button><div class="bar"><i id="b"></i></div><div class="msg" id="m"></div>' +
  '</div></div><script>var C=__CTX__;' +
  'var $=function(i){return document.getElementById(i)};' +
  '$("for").textContent=C.mls?((C.addr||"")+" · "+C.mls):"Open this page from the Lead Board so the video goes to the right property.";' +
  'var file=null;$("f").onchange=function(){file=this.files[0];$("n").textContent=file?file.name+" · "+(file.size/1048576).toFixed(1)+" MB":"";$("go").disabled=!file||!C.mls;};' +
  'function run(fn,args){return new Promise(function(res,rej){var r=google.script.run.withSuccessHandler(res).withFailureHandler(function(e){rej(e)});r[fn].apply(r,args);});}' +
  'function b64(blob){return new Promise(function(res,rej){var fr=new FileReader();fr.onload=function(){res(String(fr.result).split(",")[1]||"")};fr.onerror=rej;fr.readAsDataURL(blob);});}' +
  'function say(t,c){$("m").className="msg "+(c||"");$("m").innerHTML=t;}' +
  '$("go").onclick=function(){if(!file)return;$("go").disabled=true;$("f").disabled=true;say("Starting…");' +
  'run("startUpload",[{mls:C.mls,addr:C.addr,by:C.by,name:file.name,type:file.type,size:file.size}]).then(function(s){' +
  'var pos=0,tries=0;function next(){var part=file.slice(pos,Math.min(pos+s.chunk,file.size));' +
  'return b64(part).then(function(d){return run("putChunk",[s.upload,pos,d]);}).then(function(r){tries=0;' +
  'if(r.done){$("b").style.width="100%";say("✓ Uploaded. Go back to the board — the video shows on the lead in a moment.<br><a href=\\""+r.link+"\\" target=\\"_blank\\">Watch it in Drive</a>","ok");return;}' +
  'pos=r.next;$("b").style.width=(pos/file.size*100).toFixed(1)+"%";say("Uploading… "+Math.round(pos/file.size*100)+"% — keep this tab open");return next();' +
  '},function(e){if(++tries<=3){say("Connection hiccup — retrying…");return new Promise(function(r){setTimeout(r,2000*tries)}).then(next);}throw e;});}' +
  'return next();}).catch(function(e){say("✗ "+((e&&e.message)||e)+" — nothing was saved on the board. Try again.","err");$("go").disabled=false;$("f").disabled=false;});};' +
  '</script></body></html>';
