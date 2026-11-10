#!/usr/bin/env python3
"""Recent nearby sales for the Flip Strategy agent (TEST BOARD ONLY, Seth, 10 Nov).

    python3 -I flipdata.py <data.js> <compfacts.js> <out dir> --mls ML1,ML2,... [--today YYYY-MM-DD]
                           [--months 12] [--workers 6] [--addr comps.js,teamcomps.js]

The board can't browse, so this runs outside it and writes <out>/flip.js:

    window.__FLIP__ = {v, built, today, win, by: {MLS: {zip, mi, n, subj: {lat, lng, bd, ba, sqft, lot, yr, soldPrice, soldOn},
        list: [{mls, addr, price, sqft, ppsf, bd, ba, yr, lot, sold, dom, mi, c, lux, k, b, w, rem}]}}}

Where the sales come from, all public, no login:
  1. mlslistings.com's "recently sold" search for the property's zip
     (https://www.mlslistings.com/search/result/zip/<zip>/recentlySold, every
     page of it): single-family homes only.
  2. The sold homes compcheck.py has already read (compfacts.js), for older sales.
Each sale's public MLS page gives its map pin and its remarks (read once; pages
already in compfacts.js are not read again). The property's own pin comes from
its own MLS page, else the US Census geocoder. When the property itself is on
its zip's recently-sold search, its sale price and date go in subj (soldPrice,
soldOn): for a house THB bought, what we paid. --addr fills the street address
of older sales from the board's comps files (compfacts.js has none).

Kept: sold in the last --months months, within 1 mile, widened to 1.5 then 2
miles while fewer than 8 sales are in. c, lux, k, b and w are compcheck.py's
condition read of the remarks (remodel / light / asis / new / unknown).
"""
import datetime, html, json, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from thumbs import UA, load_data  # noqa: E402
from compcheck import fetch, geocode, miles, condition, load_js  # noqa: E402

STEPS = [1, 1.5, 2]
WANT = 8
REM = 900          # remarks kept per sale (the board sends the top sales' remarks to Claude)
MONTHS = {m: i + 1 for i, m in enumerate('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split())}


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read(4_000_000).decode('utf8', 'replace')


def num(s):
    s = (s or '').replace(',', '').strip()
    return float(s) if re.match(r'^\d+(\.\d+)?$', s) else None


def cards(s):
    """The sale cards on one search page."""
    out = []
    for c in re.split(r'<!-- Listing Result Card -->', s)[1:]:
        m = re.search(r'data-target="([A-Z0-9]+)"', c)
        if not m:
            continue
        t = re.sub(r'<style.*?</style>|<script.*?</script>', '', c, flags=re.S)
        t = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', t))).strip()
        r = {'mls': m.group(1)}
        a = re.match(r'(.+?, [A-Za-z .]+, CA \d{5})', t)
        r['addr'] = a.group(1).strip() if a else ''
        p = re.search(r'\$([\d,]+) Sold on ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})', t)
        if p and p.group(2) in MONTHS:
            r['price'] = int(num(p.group(1)) or 0)
            r['sold'] = '%s-%02d-%02d' % (p.group(4), MONTHS[p.group(2)], int(p.group(3)))
        d = re.search(r'(\d+) Days on Site', t)
        r['dom'] = int(d.group(1)) if d else None
        ty = re.search(r'Days on Site (.+?) MLS #', t)
        r['type'] = ty.group(1).strip() if ty else ''
        b = re.search(r'(\d+) Bd', t)
        r['bd'] = int(b.group(1)) if b else None
        ba = re.search(r'(\d+)(?:/(\d+))? Ba', t)
        r['ba'] = (int(ba.group(1)) + (0.5 * int(ba.group(2)) if ba.group(2) else 0)) if ba else None
        sq = re.search(r'([\d,]+) Sq Ft (?:[\d,–-]+ Sq Ft )?Lot', t)
        r['sqft'] = int(num(sq.group(1)) or 0) if sq else None
        lot = re.search(r'([\d,]+) Sq Ft Lot', t)
        r['lot'] = int(num(lot.group(1)) or 0) if lot else None
        y = re.search(r'(\d{4}) Year Built', t)
        r['yr'] = int(y.group(1)) if y else None
        out.append(r)
    return out


def sold_in_zip(z):
    """Every card on the zip's recently-sold search, following its pages."""
    s = get('https://www.mlslistings.com/search/result/zip/%s/recentlySold' % z)
    got, seen = cards(s), set()
    for n in range(2, 8):
        m = re.search(r'href="(/Search/Result/%s/%d\?[^"]+)"' % (z, n), s)
        if not m or n in seen:
            break
        seen.add(n)
        s = get('https://www.mlslistings.com' + html.unescape(m.group(1)))
        got += cards(s)
    uniq = {}
    for c in got:
        uniq.setdefault(c['mls'], c)
    return list(uniq.values())


def main():
    a = sys.argv[1:]
    if len(a) < 3 or '--mls' not in a:
        sys.exit(__doc__)
    data_js, facts_js, out = a[:3]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    subs = [m.strip() for m in opt('--mls', '').split(',') if m.strip()]
    today = datetime.date.fromisoformat(opt('--today', datetime.date.today().isoformat()))
    months, workers = int(opt('--months', '12')), int(opt('--workers', '6'))
    since = (today - datetime.timedelta(days=round(months * 30.44))).isoformat()

    d = load_data(data_js)
    cols = d['cols']
    leads = {r[0]: dict(zip(cols, r)) for r in d['rows']}
    F = load_js(facts_js, {'by': {}, 'geo': {}})
    facts = F.get('by', {})
    os.makedirs(out, exist_ok=True)
    addrs = {}
    for p in [x for x in opt('--addr', '').split(',') if x]:
        for v in (load_js(p, {'by': {}}).get('by') or {}).values():
            for r in v.get('list') or []:
                if isinstance(r, dict) and r.get('mls') and r.get('addr'):
                    addrs.setdefault(r['mls'], r['addr'])

    res = {}
    for mls in subs:
        L = leads.get(mls)
        if not L:
            print('%s: not in data.js, skipped' % mls)
            continue
        addr = L['addr']
        z = (re.search(r'\b(\d{5})\b\s*$', addr) or re.search(r'\b(\d{5})\b', addr))
        z = z.group(1) if z else ''
        # the property's own pin: its MLS page, else the census geocoder
        subj = dict(facts.get(mls) or {})
        if not subj.get('lat'):
            _, f, why = fetch((mls, addr))
            if f:
                subj.update(f)
        if not subj.get('lat'):
            g = (F.get('geo') or {}).get(mls) or geocode((mls, addr))[1] or {}
            if g.get('lat'):
                subj['lat'], subj['lng'] = g['lat'], g['lng']
        if not subj.get('lat'):
            print('%s: no location, skipped' % mls)
            continue
        # 1. the zip's recent sales, single-family only
        pool = {}
        try:
            for c in sold_in_zip(z) if z else []:
                if c['mls'] == mls and c.get('price') and c.get('sold'):
                    subj['soldPrice'], subj['soldOn'] = c['price'], c['sold']
                if c['mls'] == mls or c.get('type') != 'Single Family Residence' or not c.get('sold') or c['sold'] < since:
                    continue
                pool[c['mls']] = c
        except Exception as e:
            print('%s: search for %s failed: %s' % (mls, z, str(e)[:80]))
        # their public pages: pin and remarks (from compfacts.js when it has them)
        need = [(m, c['addr']) for m, c in pool.items() if not (facts.get(m) or {}).get('lat')]
        with ThreadPoolExecutor(workers) as ex:
            for m, f, why in ex.map(fetch, need):
                if f:
                    f['at'] = today.isoformat()
                    facts[m] = f
        for m, c in pool.items():
            f = facts.get(m) or {}
            for k in ('lat', 'lng', 'rem', 'lot', 'yr', 'sqft', 'bd', 'ba'):
                if c.get(k) in (None, '', 0) and f.get(k):
                    c[k] = f[k]
            c['lat'], c['lng'] = f.get('lat'), f.get('lng')
            c['rem'] = f.get('rem', '')
        # 2. older sales compcheck.py already read (single-family: the app comps only those)
        for m, f in facts.items():
            if m in pool or m == mls or not f.get('sold') or f['sold'] < since or not f.get('lat') or not f.get('price'):
                continue
            mi = miles(subj, f)
            if mi is None or mi > STEPS[-1]:
                continue
            pool[m] = {'mls': m, 'addr': addrs.get(m, ''), 'price': f['price'], 'sold': f['sold'], 'dom': None, 'bd': f.get('bd'),
                       'ba': f.get('ba'), 'sqft': f.get('sqft'), 'lot': f.get('lot'), 'yr': f.get('yr'),
                       'lat': f['lat'], 'lng': f['lng'], 'rem': f.get('rem', '')}
        rows = []
        for m, c in pool.items():
            mi = miles(subj, c)
            if mi is None:
                continue
            cnd, lux, k, b, w = condition(c.get('rem', ''), c.get('yr'), today.year)
            sq = c.get('sqft') or 0
            rows.append({'mls': m, 'addr': c.get('addr', ''), 'price': c.get('price'), 'sqft': sq or None,
                         'ppsf': round(c['price'] / sq) if sq and c.get('price') else None,
                         'bd': c.get('bd'), 'ba': c.get('ba'), 'yr': c.get('yr'), 'lot': c.get('lot'),
                         'sold': c.get('sold'), 'dom': c.get('dom'), 'mi': mi, 'c': cnd, 'lux': lux, 'k': k, 'b': b,
                         'w': w, 'rem': (c.get('rem') or '')[:REM]})
        r = STEPS[0]
        for r in STEPS:
            if sum(1 for x in rows if x['mi'] <= r) >= WANT:
                break
        keep = sorted([x for x in rows if x['mi'] <= r], key=lambda x: -(x['price'] or 0))
        res[mls] = {'zip': z, 'mi': r, 'n': len(keep),
                    'subj': {k: subj.get(k) for k in ('lat', 'lng', 'bd', 'ba', 'sqft', 'lot', 'yr', 'soldPrice', 'soldOn') if subj.get(k) is not None},
                    'list': keep}
        print('%s %s: %d sales within %s mi since %s (%d from the zip search)' % (mls, addr, len(keep), r, since, sum(1 for x in keep if x['dom'] is not None)))

    doc = {'v': 1, 'built': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), 'today': today.isoformat(), 'win': months, 'by': res}
    with open(os.path.join(out, 'flip.js'), 'w') as f:
        f.write('window.__FLIP__ = ' + json.dumps(doc, separators=(',', ':')) + ';\n')
    print('wrote %s (%d properties)' % (os.path.join(out, 'flip.js'), len(res)))


if __name__ == '__main__':
    main()
