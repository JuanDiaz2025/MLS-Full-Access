#!/usr/bin/env python3
"""House photos for the FlipScout Test board.

    python3 -I thumbs.py <data.js> <out dir> [--only N] [--workers 4]

<out dir>/thumbs/index.js is the live Test board's copy when there is one
(Artifact read, path "thumbs/index.js"): leads already in it are not fetched
again. Every other lead with an MLS page gets its cover photo — the public
page https://www.mlslistings.com/Property/<MLS #> names it in og:image — cut
to a 112x96 tile. New tiles go into one JPEG sheet per pull date, so a board
showing one day loads one sheet. Writes the new sheets and a new index.js to
<out dir>/thumbs/ and prints the paths to publish (files left out of a
publish are kept, so only the new ones go up).

Redfin-only leads (RF..., Redfin's own listing ids) have no MLS page and keep
the house icon. The page is anchored to the MLS # asked for: a redirect to
the home page means there is no listing, and a page whose street number is
not the lead's is not used.
"""
import hashlib, html, io, json, math, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageOps

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/129.0 Safari/537.36')
TW, TH, COLS = 112, 96, 12          # tile size (16-px aligned: no JPEG bleed), tiles per sheet row
OG = re.compile(rb'<meta\s+property="og:image"\s+content="([^"]+)"')
TITLE = re.compile(rb'<title>([^<]{0,300})')
BAD_IMG = re.compile(r'nophoto|no-photo|no_photo|placeholder|coming[_-]?soon|mlslpub-cdn|mlslistings\.com/images/', re.I)
TRIES = 3                            # a lead with no photo is tried on this many days, then left
TRIES_SOON = 7                       # "photos coming soon": the photos usually follow within a week


def load_data(path):
    src = open(path, encoding='utf8').read()
    src = src[src.index('{'):src.rindex('}') + 1]
    return json.loads(src)


def load_index(path):
    if not os.path.exists(path):
        return {'v': 1, 'w': TW, 'h': TH, 'cols': COLS, 'sheets': [], 'at': {}, 'pg': {}, 'miss': {}, 'ph': []}
    src = open(path, encoding='utf8').read()
    ix = json.loads(src[src.index('{'):src.rindex('}') + 1])
    assert ix.get('w') == TW and ix.get('h') == TH and ix.get('cols') == COLS, 'tile size changed'
    for k, v in (('pg', {}), ('miss', {}), ('ph', [])):
        ix.setdefault(k, v)
    return ix


def street_no(s):
    m = re.match(r'\s*(\d+)', s or '')
    return m.group(1) if m else ''


def candidates(mls):
    """The MLS page ids to try for one lead, or [] when it has no MLS page."""
    if re.match(r'^RF', mls) or re.match(r'^\d{9,}$', mls) or re.match(r'^\d{1,7}$', mls):
        return []                    # Redfin-only: RF<homeId>, or Redfin's own listing ids
    if re.match(r'^\d{8}$', mls):    # a bridgeMLS number that lost its board prefix
        return ['BE' + mls, 'EB' + mls, 'CC' + mls]
    return [mls] if re.match(r'^[A-Z]{1,6}\d{5,12}$', mls) else []


def get(url, accept, cap):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': accept})
    return urllib.request.urlopen(req, timeout=30), cap


def page_photo(pid):
    """(photo url, page title) for one MLS page id; (None, why) when there is none."""
    r, cap = get('https://www.mlslistings.com/Property/' + pid, 'text/html', 400000)
    with r:
        if ('/property/' + pid.lower()) not in r.geturl().lower():
            return None, 'no MLS page'
        buf = b''
        while len(buf) < cap:
            c = r.read(16384)
            if not c:
                break
            buf += c
            m = OG.search(buf)
            if m:
                t = TITLE.search(buf)
                return html.unescape(m.group(1).decode('utf8', 'replace')), (
                    html.unescape(t.group(1).decode('utf8', 'replace')).strip() if t else '')
    return None, 'no photo on the MLS page'


def small(url):
    """A smaller copy of the same photo where the host offers one."""
    u = re.sub(r'^(https://media\.mlslmedia\.com/property/MLSL/\d+/[0-9a-f]+)/2/(\d+)$', r'\1/1/\2', url)
    if u != url:
        return u                     # 200 x 133
    u = re.sub(r'^(https://zimg\.paragon\.ice\.com/ParagonImages/Property/PD/[^/]+/\d+)/0/0/0/', r'\1/0/300/200/', url)
    return u if u != url else None   # fits 300 x 200


def fetch_img(url):
    r, cap = get(url, 'image/*', 8_000_000)
    with r:
        if r.status != 200:
            raise IOError('HTTP %s' % r.status)
        b = r.read(cap + 1)
    if len(b) > cap:
        raise IOError('photo too large')
    im = Image.open(io.BytesIO(b))
    im.load()
    return b, im


def one(lead):
    mls, addr = lead['mls'], lead['addr']
    why = 'no MLS page'
    for pid in candidates(mls):
        try:
            url, title = page_photo(pid)
        except Exception as e:
            why = 'page error: %s' % str(e)[:80]
            continue
        if not url:
            why = title
            continue
        if BAD_IMG.search(url):
            return {'mls': mls, 'why': 'placeholder photo'}
        a, b = street_no(addr), street_no(title)
        if a and b and a != b:
            # the page is another house: an MLS # typed wrong on the sheet, or
            # a guessed board prefix that belongs to a different listing
            why = 'MLS page is %s, not %s' % (title.split(' - ')[0][:60], addr[:60])
            continue
        last = None
        for u in [x for x in (small(url), url) if x]:
            try:
                raw, im = fetch_img(u)
                break
            except Exception as e:
                last = e
                raw = None
        if raw is None:
            return {'mls': mls, 'why': 'photo would not download: %s' % str(last)[:80], 'err': True}
        tile = ImageOps.fit(im.convert('RGB'), (TW, TH), Image.LANCZOS)
        return {'mls': mls, 'pid': pid, 'url': url, 'md5': hashlib.md5(raw).hexdigest(), 'tile': tile}
    return {'mls': mls, 'why': why, 'err': why.startswith('page error')}


def main():
    args = sys.argv[1:]
    only = int(args[args.index('--only') + 1]) if '--only' in args else 0
    workers = int(args[args.index('--workers') + 1]) if '--workers' in args else 4
    data_js, out = args[0], args[1]
    tdir = os.path.join(out, 'thumbs')
    os.makedirs(tdir, exist_ok=True)
    ixp = os.path.join(tdir, 'index.js')
    ix = load_index(ixp)
    D = load_data(data_js)
    ci = {c: i for i, c in enumerate(D['cols'])}
    today = time.strftime('%Y-%m-%d')
    leads, seen = [], set()
    for r in D['rows']:
        mls = str(r[ci['mls']] or '').strip().upper()
        if not mls or mls in seen or mls in ix['at']:
            continue
        seen.add(mls)
        if not candidates(mls):
            continue
        ms = ix['miss'].get(mls)
        if ms and (ms[0] >= (TRIES_SOON if 'placeholder' in ms[2] else TRIES) or ms[1] == today):
            continue
        leads.append({'mls': mls, 'addr': str(r[ci['addr']] or ''), 'date': str(r[ci['date']] or today)[:10]})
    if only:
        leads = leads[:only]
    print('leads to fetch: %d (already have %d photos)' % (len(leads), len(ix['at'])), flush=True)

    res, t0 = [], time.time()
    with ThreadPoolExecutor(workers) as ex:
        for i, x in enumerate(ex.map(one, leads), 1):
            res.append(x)
            if i % 100 == 0:
                print('  %d/%d  %.0fs' % (i, len(leads), time.time() - t0), flush=True)

    # the same picture on several listings is a stand-in, not the house
    count = {}
    for x in res:
        if 'md5' in x:
            count[x['md5']] = count.get(x['md5'], 0) + 1
    ph = set(ix['ph']) | {h for h, n in count.items() if n >= 3}
    ix['ph'] = sorted(ph)

    by_date, date_of = {}, {l['mls']: l['date'] for l in leads}
    whys = {}
    for x in res:
        mls = x['mls']
        if 'tile' in x and x['md5'] not in ph:
            by_date.setdefault(date_of[mls], []).append(x)
            ix['miss'].pop(mls, None)
            if x['pid'] != mls:
                ix['pg'][mls] = x['pid']
            continue
        w = x.get('why') or 'placeholder photo'
        whys[w.split(':')[0]] = whys.get(w.split(':')[0], 0) + 1
        prev = ix['miss'].get(mls, [0, '', ''])
        # a page or download error is the network's fault; it is retried every day
        ix['miss'][mls] = [prev[0] + (0 if x.get('err') else 1), today, w]

    names = {s[0] for s in ix['sheets']}
    new_files = []
    for d in sorted(by_date):
        tiles = by_date[d]
        name, k = d + '.jpg', 2
        while name in names:
            name, k = '%s-%d.jpg' % (d, k), k + 1
        names.add(name)
        rows = math.ceil(len(tiles) / COLS)
        sheet = Image.new('RGB', (COLS * TW, rows * TH), (200, 200, 200))
        si = len(ix['sheets'])
        for slot, x in enumerate(tiles):
            sheet.paste(x['tile'], ((slot % COLS) * TW, (slot // COLS) * TH))
            ix['at'][x['mls']] = [si, slot]
        sheet.save(os.path.join(tdir, name), 'JPEG', quality=74, optimize=True, progressive=True)
        ix['sheets'].append([name, len(tiles)])
        new_files.append('thumbs/' + name)

    with open(ixp, 'w', encoding='utf8') as f:
        f.write('window.__THUMBS__ = ' + json.dumps(ix, separators=(',', ':')) + ';\n')
    got = sum(len(v) for v in by_date.values())
    print('photos added: %d of %d tried in %.0fs · total with a photo: %d · no photo: %s' % (
        got, len(leads), time.time() - t0, len(ix['at']), json.dumps(whys)))
    print('NEW FILES: ' + ' '.join(['thumbs/index.js'] + new_files))


if __name__ == '__main__':
    main()
