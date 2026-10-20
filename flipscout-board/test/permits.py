#!/usr/bin/env python3
"""Permit history for the FlipScout boards, from Redfin's public records.

    python3 -I permits.py <data.js> <out dir> [--only N] [--gap 1.5]

The MLS listing never says a house had a fire in 2014; Redfin's permit tab
does (6225 Tevis St, Seth, 20 Oct). For every A or B lead still on the market
this finds the house's own Redfin page — Redfin's location lookup, kept only
when the page's house number and zip are the lead's — reads every permit card
on it, and writes <out>/permits.js:

    window.__PERMITS__ = {v, built, by: {MLS: {u, at, p: [{d, st, w, t, g}]}}, miss: {MLS: [tries, day, why]}}

d = the permit's date (YYYY-MM-DD), st = its status (Final, Issued, Expired…),
w = the work type, t = the description, g = Redfin's tags. A house with no
permits is recorded with p: [], so it is not looked up again; every house is
checked again after 30 days. A lead Redfin has no page for is tried on 3 days.

Redfin often refuses cloud servers. One request at a time, --gap seconds
apart, and after 2 refusals in a row (403/429 or a captcha page) the run
stops and saves what it has; the next run picks up where it left off.
"""
import html, json, os, re, sys, time, urllib.parse, urllib.request

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/129.0 Safari/537.36')
CLOSED = re.compile(r'sold|withdrawn|expired|cancel|off.?market|closed|duplicate|pending|contingent|under contract', re.I)
BLOCK = re.compile(r'captcha|px-captcha|access to this page has been denied|are you a robot', re.I)
TRIES, RECHECK = 3, 30


class Refused(Exception):
    pass


def load_js(path, empty):
    if not os.path.exists(path):
        return empty
    src = open(path, encoding='utf8').read()
    return json.loads(src[src.index('{'):src.rindex('}') + 1])


def fetch(url, accept='text/html'):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': accept, 'Accept-Language': 'en-US,en;q=0.9'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            b = r.read(4_000_000)
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise Refused('HTTP %d' % e.code)
        raise
    s = b.decode('utf8', 'replace')
    if BLOCK.search(s[:20000]) and 'PermitTabContent' not in s and '"payload"' not in s:
        raise Refused('captcha page')
    return s


def parts(addr):
    m = re.match(r'\s*(\d+)\b.*?(\d{5})?\s*$', addr or '')
    zm = re.search(r'\b(\d{5})\b\s*$', addr or '')
    return (m.group(1) if m else ''), (zm.group(1) if zm else '')


def home_url(addr):
    """The lead's own Redfin page, or '' when the lookup has none that matches."""
    no, z = parts(addr)
    if not no or not z:
        return ''
    s = fetch('https://www.redfin.com/stingray/do/location-autocomplete?' +
              urllib.parse.urlencode({'location': addr, 'v': '2'}), 'application/json')
    s = s.split('&&', 1)[1] if s.startswith('{}&&') else s        # Redfin's JSON-hijacking guard
    p = (json.loads(s or '{}').get('payload') or {})
    rows = [p.get('exactMatch')] if p.get('exactMatch') else []
    for sec in p.get('sections') or []:
        rows += sec.get('rows') or []
    for r in rows:
        u = (r or {}).get('url') or ''
        m = re.match(r'^/[A-Z]{2}/[^/]+/(\d+)-[^/]*-(\d{5})/home/\d+$', u)
        if m and m.group(1) == no and m.group(2) == z:
            return 'https://www.redfin.com' + u
    return ''


def txt(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip()


def iso(d):
    try:
        return time.strftime('%Y-%m-%d', time.strptime(d.strip(), '%b %d, %Y'))
    except ValueError:
        return d.strip()[:20]


def permits_of(s):
    s = s.replace('<!-- -->', '')
    out = []
    for card in s.split('class="PermitTabContent__card"')[1:]:
        card = card[:6000]
        ds = re.search(r'PermitTabContent__date-status[^"]*">([\s\S]*?)</div>', card)
        w = re.search(r'PermitTabContent__work-type[^"]*">([\s\S]*?)</div>', card)
        t = re.search(r'PermitTabContent__description-text[^"]*">([\s\S]*?)</p>', card)
        g = [txt(x) for x in re.findall(r'class="Tag__text">([\s\S]*?)</p>', card)]
        d, st = (txt(ds.group(1)).split('•') + [''])[:2] if ds else ('', '')
        out.append({'d': iso(d), 'st': st.strip()[:40], 'w': txt(w.group(1))[:120] if w else '',
                    't': txt(t.group(1))[:600] if t else '', 'g': [x for x in g if x][:6]})
    return out


def main():
    args = sys.argv[1:]
    opt = lambda k, d=None: args[args.index(k) + 1] if k in args else d
    only, gap = int(opt('--only', 0)), float(opt('--gap', 1.5))
    data_js, out = args[0], args[1]
    os.makedirs(out, exist_ok=True)
    pp = os.path.join(out, 'permits.js')
    px = load_js(pp, {'v': 1, 'by': {}, 'miss': {}})
    px.setdefault('by', {}); px.setdefault('miss', {})
    src = open(data_js, encoding='utf8').read()
    D = json.loads(src[src.index('{'):src.rindex('}') + 1])
    ci = {c: i for i, c in enumerate(D['cols'])}
    today = time.strftime('%Y-%m-%d')
    stale = time.strftime('%Y-%m-%d', time.localtime(time.time() - RECHECK * 86400))
    leads, seen = [], set()
    for r in D['rows']:
        mls = str(r[ci['mls']] or '').strip().upper()
        if not mls or mls in seen:
            continue
        seen.add(mls)
        if str(r[ci['bucket']] or '') not in ('A', 'B') or CLOSED.search(str(r[ci['mstat']] or '')):
            continue
        have, ms = px['by'].get(mls), px['miss'].get(mls)
        if have and have.get('at', '') > stale:
            continue
        if ms and (ms[0] >= TRIES or ms[1] == today):
            continue
        leads.append({'mls': mls, 'addr': str(r[ci['addr']] or ''), 'u': (have or {}).get('u', '')})
    if only:
        leads = leads[:only]
    print('houses to check: %d · on file %d' % (len(leads), len(px['by'])), flush=True)

    def save():
        px['built'] = time.strftime('%Y-%m-%dT%H:%M:%S')
        with open(pp, 'w', encoding='utf8') as f:
            f.write('window.__PERMITS__ = ' + json.dumps(px, separators=(',', ':'), ensure_ascii=False) + ';\n')

    refused, found, none, t0, stopped = 0, 0, 0, time.time(), ''
    for i, l in enumerate(leads, 1):
        try:
            u = l['u'] or home_url(l['addr'])
            time.sleep(gap)
            if not u:
                prev = px['miss'].get(l['mls'], [0, '', ''])
                px['miss'][l['mls']] = [prev[0] + 1, today, 'no Redfin page for this address']
                continue
            s = fetch(u)
            time.sleep(gap)
            no, _ = parts(l['addr'])
            if no and ('/' + no + '-') not in u:
                raise ValueError('page is not this house')
            p = permits_of(s)
            px['by'][l['mls']] = {'u': u, 'at': today, 'p': p}
            px['miss'].pop(l['mls'], None)
            found += 1 if p else 0
            none += 0 if p else 1
            refused = 0
        except Refused as e:
            refused += 1
            time.sleep(gap * 4)
            if refused >= 2:
                stopped = 'Redfin refused twice in a row (%s) — stopped, the next run continues' % e
                break
        except Exception as e:
            prev = px['miss'].get(l['mls'], [0, '', ''])
            px['miss'][l['mls']] = [prev[0], today, 'error: %s' % str(e)[:80]]   # an error is not a try
        if i % 25 == 0:
            save()
            print('  %d/%d  %.0fs · with permits %d · none %d' % (i, len(leads), time.time() - t0, found, none), flush=True)
    save()
    print('checked: %d with permits, %d with none, on file %d · %.0fs%s' % (
        found, none, len(px['by']), time.time() - t0, (' · ' + stopped) if stopped else ''))
    print('NEW FILES: permits.js')


if __name__ == '__main__':
    main()
