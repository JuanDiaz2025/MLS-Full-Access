#!/usr/bin/env python3
"""Public remarks and photo sheets for the FlipScout boards.

    python3 -I listing.py <data.js> <out dir> [--thumbs <thumbs/index.js>] [--sheets DIR [--since YYYY-MM-DD]] [--only N] [--workers 6]

The sheet the boards are built from has no public remarks, so the board only
ever saw the agent-only remarks and the few words the scan kept in "Why"
(Seth, 20 Oct: the Contrarian read "no remarks" as a warning sign). This
reads each lead's public MLS page — https://www.mlslistings.com/Property/<MLS #>,
the same page thumbs.py takes the cover photo from — and keeps the "About
this Property" paragraph in <out>/remarks.js:

    window.__REMARKS__ = {v, built, by: {MLS: text}, miss: {MLS: [tries, day, why]}}

Leads already in <out>/remarks.js are not fetched again. A lead with no page
or no remarks is tried on 3 days, then left alone; a network error does not
count as a try.

With --sheets DIR every A or B lead still on the market that was pulled on or
after --since (default: the 1st of this month — Seth, 20 Oct: each upload is
a prompt for him, so only this month's leads get one) also gets ONE photo
sheet, DIR/<MLS #>.jpg: up to 12 of the listing's own photos (the gallery on
its MLS page, never "similar homes"), 4 to a row, each numbered with its place
in the gallery. It is what the Contrarian shows Claude, and the board's "All
photos" button. Upload them to the board's asset store and record the ids with
zoom_ids.py --key cs. --thumbs names that board's thumbs/index.js: leads
already in its `cs` map are skipped, `pg` gives the page id of an MLS # that
lost its board prefix, each sheet made is counted in its `csn` (MLS # ->
[photos on the sheet, photos in the gallery]) and sheets that could not be
made are recorded in its `csmiss` (the file is rewritten).
"""
import html, io, json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from thumbs import UA, TITLE, BAD_IMG, candidates, street_no, get, load_data  # noqa: E402

TRIES = 3
SW, SH, SC, SMAX = 400, 300, 4, 12          # photo size on the sheet, photos a row, photos a sheet
CLOSED = re.compile(r'sold|withdrawn|expired|cancel|off.?market|closed|duplicate|pending|contingent|under contract', re.I)
REMARKS_P = re.compile(r'_Remarks\.cshtml[\s\S]{0,1500}?<p class="mb-0[^"]*">([\s\S]*?)</p>')
PHOTO = re.compile(r'https://(?:zimg\.paragon\.ice\.com/ParagonImages/Property/[^"\'\s<>\\)]+?\.(?:JPG|jpg|jpeg|png)'
                   r'|media\.mlslmedia\.com/property/MLSL/\d+/[0-9a-f]+/\d+/\d+'
                   r'|[a-z0-9]+media\.rapmls\.com/[^"\'\s<>\\)]+?/listingpics/[^"\'\s<>\\)]+?\.(?:jpg|jpeg|png))', re.I)
ROOT = None


def page(pid):
    """(html text, page title) for one MLS page id; (None, why) when there is none."""
    r, cap = get('https://www.mlslistings.com/Property/' + pid, 'text/html', 3_000_000)
    with r:
        if ('/property/' + pid.lower()) not in r.geturl().lower():
            return None, 'no MLS page'
        buf = r.read(cap)
    s = buf.decode('utf8', 'replace')
    t = TITLE.search(buf)
    return s, (html.unescape(t.group(1).decode('utf8', 'replace')).strip() if t else '')


def remarks_of(s):
    m = REMARKS_P.search(s)
    if not m:
        return ''
    t = html.unescape(re.sub(r'<[^>]+>', ' ', m.group(1)))
    return re.sub(r'\s+', ' ', t).strip()[:2000]


def photo_key(u):
    m = re.search(r'/ParagonImages/Property/PD/[^/]+/(\d+)/(\d+)/', u)
    if m:
        return 'p%s-%s' % m.groups()
    m = re.search(r'/MLSL/(\d+)/[0-9a-f]+/\d+/(\d+)$', u)
    if m:
        return 'm%s-%s' % m.groups()
    return 'r' + u.rsplit('/', 1)[-1].lower()


def gallery(s):
    """The listing's own photos, in the gallery's order."""
    i = s.find('_ListingGallery.cshtml')
    if i < 0:
        return []
    j = s.find('<!-- Views/Partial', i + 30)
    seen, out = set(), []
    for u in PHOTO.findall(s[i:j if j > 0 else i + 400000]):
        k = photo_key(u)
        if k in seen or BAD_IMG.search(u):
            continue
        seen.add(k)
        out.append(u)
    return out


def sized(u):
    """A copy near the sheet's size where the host offers one."""
    return re.sub(r'(/ParagonImages/Property/PD/[^/]+/\d+/\d+)/0/0/', r'\1/%d/%d/' % (SW, SH), u)


def pick(urls):
    """Up to SMAX photos: all of them, or the cover plus the rest spread evenly."""
    if len(urls) <= SMAX:
        return list(enumerate(urls, 1))
    rest = list(range(1, len(urls)))
    want = SMAX - 1
    idx = [0] + [rest[round(k * (len(rest) - 1) / (want - 1))] for k in range(want)]
    return [(i + 1, urls[i]) for i in sorted(set(idx))]


def fetch_photo(u):
    for v in (sized(u), u) if sized(u) != u else (u,):
        try:
            r, cap = get(v, 'image/*', 8_000_000)
            with r:
                b = r.read(cap + 1)
            if len(b) > cap:
                raise IOError('photo too large')
            im = Image.open(io.BytesIO(b))
            im.load()
            return im.convert('RGB')
        except Exception:
            continue
    return None


def font(size):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def sheet(mls, urls):
    chosen = pick(urls)
    got = []
    for n, u in chosen:
        im = fetch_photo(u)
        if im is not None:
            got.append((n, im))
    if not got:
        return None, 'photos would not download'
    rows = (len(got) + SC - 1) // SC
    out = Image.new('RGB', (SC * SW, rows * SH), (24, 28, 36))
    dr, f = ImageDraw.Draw(out), font(22)
    for k, (n, im) in enumerate(got):
        im.thumbnail((SW, SH), Image.LANCZOS)
        x0, y0 = (k % SC) * SW, (k // SC) * SH
        out.paste(im, (x0 + (SW - im.width) // 2, y0 + (SH - im.height) // 2))
        lab = '%d/%d' % (n, len(urls))
        dr.rectangle([x0 + 6, y0 + 6, x0 + 18 + 13 * len(lab), y0 + 36], fill=(0, 0, 0))
        dr.text((x0 + 12, y0 + 9), lab, fill=(255, 255, 255), font=f)
    path = os.path.join(ROOT, mls + '.jpg')
    out.save(path, 'JPEG', quality=72, optimize=True, progressive=True)
    return path, len(got)


def one(lead):
    mls, why = lead['mls'], 'no MLS page'
    for pid in lead['pids']:
        try:
            s, title = page(pid)
        except Exception as e:
            why, err = 'page error: %s' % str(e)[:80], True
            continue
        if not s:
            why = title
            continue
        a, b = street_no(lead['addr']), street_no(title)
        if a and b and a != b:
            why = 'MLS page is %s, not %s' % (title.split(' - ')[0][:60], lead['addr'][:60])
            continue
        out = {'mls': mls, 'remarks': remarks_of(s)}
        if lead['sheet']:
            urls = gallery(s)
            if not urls:
                out['swhy'] = 'no photos in the gallery'
            else:
                try:
                    path, n = sheet(mls, urls)
                    if path:
                        out['sheet'], out['n'], out['total'] = path, n, len(urls)
                    else:
                        out['swhy'], out['serr'] = n, True
                except Exception as e:
                    out['swhy'], out['serr'] = 'sheet error: %s' % str(e)[:80], True
        return out
    return {'mls': mls, 'why': why, 'err': why.startswith('page error')}


def blocked(ms, today):
    return ms and (ms[0] >= TRIES or ms[1] == today)


def load_js(path, empty):
    if not os.path.exists(path):
        return empty
    src = open(path, encoding='utf8').read()
    return json.loads(src[src.index('{'):src.rindex('}') + 1])


def main():
    global ROOT
    args = sys.argv[1:]
    opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
    only, workers = int(opt('--only', 0)), int(opt('--workers', 6))
    ROOT, thp = opt('--sheets'), opt('--thumbs')
    since = opt('--since', time.strftime('%Y-%m-01'))
    assert re.match(r'^\d{4}-\d{2}-\d{2}$', since), '--since is YYYY-MM-DD'
    if ROOT:
        os.makedirs(ROOT, exist_ok=True)
    data_js, out = args[0], args[1]
    os.makedirs(out, exist_ok=True)
    rp = os.path.join(out, 'remarks.js')
    rx = load_js(rp, {'v': 1, 'by': {}, 'miss': {}})
    rx.setdefault('by', {}); rx.setdefault('miss', {})
    ix = load_js(thp, {}) if thp else {}
    for k in ('cs', 'csn', 'csmiss', 'pg'):
        ix.setdefault(k, {})
    D = load_data(data_js)
    ci = {c: i for i, c in enumerate(D['cols'])}
    today = time.strftime('%Y-%m-%d')
    leads, seen = [], set()
    for r in D['rows']:
        mls = str(r[ci['mls']] or '').strip().upper()
        if not mls or mls in seen or not candidates(mls):
            continue
        seen.add(mls)
        live_ab = str(r[ci['bucket']] or '') in ('A', 'B') and not CLOSED.search(str(r[ci['mstat']] or '')) and str(r[ci['date']] or '') >= since
        need_r = mls not in rx['by'] and not blocked(rx['miss'].get(mls), today)
        need_s = bool(ROOT) and live_ab and mls not in ix['cs'] and not blocked(ix['csmiss'].get(mls), today)
        if need_r or need_s:
            pg = ix['pg'].get(mls)
            leads.append({'mls': mls, 'addr': str(r[ci['addr']] or ''), 'sheet': need_s,
                          'pids': [pg] if pg else candidates(mls)})
    if only:
        leads = leads[:only]
    print('pages to read: %d (%d for a photo sheet, leads pulled since %s) · remarks on file %d · sheets on file %d' % (
        len(leads), sum(1 for l in leads if l['sheet']), since, len(rx['by']), len(ix['cs'])), flush=True)

    res, t0 = [], time.time()
    with ThreadPoolExecutor(workers) as ex:
        for i, x in enumerate(ex.map(one, leads), 1):
            res.append(x)
            if i % 100 == 0:
                print('  %d/%d  %.0fs' % (i, len(leads), time.time() - t0), flush=True)

    whys, sheets, got = {}, 0, 0
    lead_of = {l['mls']: l for l in leads}
    for x in res:
        mls, l = x['mls'], lead_of[x['mls']]
        if 'why' in x:
            w = x['why'].split(':')[0]
            whys[w] = whys.get(w, 0) + 1
            if not x.get('err'):
                prev = rx['miss'].get(mls, [0, '', ''])
                rx['miss'][mls] = [prev[0] + 1, today, x['why']]
                if l['sheet']:
                    prev = ix['csmiss'].get(mls, [0, '', ''])
                    ix['csmiss'][mls] = [prev[0] + 1, today, x['why']]
            continue
        if x['remarks']:
            if mls not in rx['by']:
                got += 1
            rx['by'][mls] = x['remarks']
            rx['miss'].pop(mls, None)
        elif mls not in rx['by']:
            prev = rx['miss'].get(mls, [0, '', ''])
            rx['miss'][mls] = [prev[0] + 1, today, 'no remarks on the page']
        if l['sheet']:
            if 'sheet' in x:
                sheets += 1
                ix['csn'][mls] = [x['n'], x['total']]
                ix['csmiss'].pop(mls, None)
            elif not x.get('serr'):
                prev = ix['csmiss'].get(mls, [0, '', ''])
                ix['csmiss'][mls] = [prev[0] + 1, today, x.get('swhy', '')]

    rx['built'] = time.strftime('%Y-%m-%dT%H:%M:%S')
    with open(rp, 'w', encoding='utf8') as f:
        f.write('window.__REMARKS__ = ' + json.dumps(rx, separators=(',', ':'), ensure_ascii=False) + ';\n')
    if thp:
        with open(thp, 'w', encoding='utf8') as f:
            f.write('window.__THUMBS__ = ' + json.dumps(ix, separators=(',', ':')) + ';\n')
    print('remarks added: %d · on file: %d of %d leads · no page/remarks: %s · %.0fs' % (
        got, len(rx['by']), len(seen), json.dumps(whys), time.time() - t0))
    if ROOT:
        print('SHEET FILES: %d in %s (upload them, then record the ids with zoom_ids.py --key cs)' % (sheets, ROOT))
    print('NEW FILES: remarks.js' + (' thumbs/index.js' if thp else ''))


if __name__ == '__main__':
    main()
