// A plain status page, in the Lead Board's own colours so the two read as one
// system. It answers one question — did my push go through? — and nothing else.

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const when = (iso) => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? "—" : d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};

export function statusPage({ counts, jobs, base }) {
  const tile = (label, n, tone) =>
    `<div class="t ${tone}"><dt>${esc(label)}</dt><dd>${n}</dd></div>`;

  const row = (j) => {
    const c = j.payload || {};
    const name = [c.first, c.last].filter(Boolean).join(" ") || j.id;
    const where = [c.street, c.city].filter(Boolean).join(", ");
    const link = j.result && j.result.id ? `${base}/contacts/${esc(j.result.id)}` : "";
    const state = {
      done: '<span class="p done">✓ in REI</span>',
      working: '<span class="p work">creating…</span>',
      queued: '<span class="p queued">queued</span>',
      error: '<span class="p err">failed</span>'
    }[j.status] || esc(j.status);
    return `<tr>
      <td>${state}</td>
      <td><b>${esc(name)}</b><small>${esc(where)}</small></td>
      <td class="m">${esc(j.id)}</td>
      <td class="m">${esc(when(j.queuedAt))}</td>
      <td>${j.error ? `<span class="why">${esc(j.error)}</span>` : link ? `<a href="${link}" target="_blank" rel="noopener">open ↗</a>` : "—"}</td>
    </tr>`;
  };

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FlipScout server</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=Public+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{color-scheme:light;--ground:#EDF2F8;--surface:#FFFFFF;--ink:#14202E;--muted:#57687C;--line:#D3DEEB;--line-soft:#E6EDF6;
  --brand:#0D5A87;--brand-2:#0E8585;--won-b:#D5F2E6;--won-t:#146B4C;--rev-b:#D9EAFA;--rev-t:#0B5A94;
  --off-b:#FBEBC8;--off-t:#7D4D00;--pass-b:#FBDCE3;--pass-t:#8B1A36}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--ground:#0E1620;--surface:#16212D;--ink:#E4EAF1;--muted:#9DADBE;
  --line:#2E3E50;--line-soft:#223142;--won-b:#133A2B;--won-t:#80DAB1;--rev-b:#17324B;--rev-t:#8FC6F3;
  --off-b:#3A2C10;--off-t:#F2C46B;--pass-b:#3E1A24;--pass-t:#F4A3B6;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.45 "Public Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
header{background:linear-gradient(100deg,var(--brand) 0%,#0A6E93 52%,var(--brand-2) 100%);color:#fff;box-shadow:0 2px 14px rgba(10,60,92,.25)}
.wrap{max-width:1080px;margin:0 auto;padding:0 16px}
header .wrap{padding-block:16px}
h1{font:700 19px Archivo,sans-serif;margin:0;letter-spacing:-.015em}
.sub{font:11px "IBM Plex Mono",monospace;color:#B9D9EC;margin-top:3px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:20px 0 0}
.t{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:13px 15px;border-top:3px solid var(--line)}
.t dt{font:600 10px Archivo,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin:0}
.t dd{font:500 30px "IBM Plex Mono",monospace;margin:2px 0 0;letter-spacing:-.03em}
.t.ok{border-top-color:var(--won-t)}.t.ok dd{color:var(--won-t)}
.t.go{border-top-color:var(--rev-t)}.t.go dd{color:var(--rev-t)}
.t.wait{border-top-color:var(--off-t)}.t.wait dd{color:var(--off-t)}
.t.bad{border-top-color:var(--pass-t)}.t.bad dd{color:var(--pass-t)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;margin:18px 0 40px;overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:620px}
th{font:600 10px Archivo,sans-serif;letter-spacing:.09em;text-transform:uppercase;color:var(--brand);text-align:left;
  padding:10px 14px;background:#DAEBFA;border-bottom:2px solid var(--brand)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) th{background:#16324A;color:#8FC6F3}}
td{padding:11px 14px;border-bottom:1px solid var(--line-soft);vertical-align:top}
tr:last-child td{border-bottom:0}
td small{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.m{font-family:"IBM Plex Mono",monospace;font-size:12.5px;color:var(--muted);white-space:nowrap}
.p{display:inline-block;font:700 11px Archivo,sans-serif;border-radius:999px;padding:3px 10px;white-space:nowrap}
.p.done{background:var(--won-b);color:var(--won-t)}
.p.work{background:var(--rev-b);color:var(--rev-t)}
.p.queued{background:var(--off-b);color:var(--off-t)}
.p.err{background:var(--pass-b);color:var(--pass-t)}
.why{color:var(--pass-t);font-size:12.5px}
.empty{padding:42px 16px;text-align:center;color:var(--muted)}
.empty b{display:block;font:600 15px Archivo,sans-serif;color:var(--ink);margin-bottom:4px}
a{color:var(--brand-2);font-weight:600}
</style></head><body>
<header><div class="wrap"><h1>FlipScout server</h1>
<div class="sub">pushes from the Lead Board into REI BlackBook</div></div></header>
<div class="wrap">
  <dl class="tiles">
    ${tile("In REI", counts.done || 0, "ok")}
    ${tile("Creating", counts.working || 0, "go")}
    ${tile("Queued", counts.queued || 0, "wait")}
    ${tile("Failed", counts.error || 0, "bad")}
  </dl>
  <div class="card">
    ${jobs.length ? `<table><thead><tr><th>State</th><th>Contact</th><th>Lead</th><th>Pressed</th><th>Result</th></tr></thead>
    <tbody>${jobs.map(row).join("")}</tbody></table>`
      : `<div class="empty"><b>Nothing pushed yet</b>A press of ⬆ Push to REI on the Lead Board shows up here.</div>`}
  </div>
</div></body></html>`;
}
