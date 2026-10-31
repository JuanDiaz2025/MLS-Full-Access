#!/usr/bin/env python3
"""The Deal Report Builder's property list, from the same files the daily refresh publishes to Twin Network.

    python3 -I leads_for_drb.py <data.js> <agents.js> <remarks.js> <teamcomps.js> <the exported xlsx> <out leads.js>

Cherry's Deal Report Builder (https://claude.ai/artifact/Q3w5f9wqTpWMTTWhFMpmmp) loads
leads.js: picking a property there fills its price, offer deadline, beds, baths, square
feet, lot size, year built, agent, phone and brokerage (Seth, 31 Oct). It keeps the
leads still on the market (Active / Coming Soon) and anything pulled in the last 30 days.

data.js has no baths or lot size, so those come straight from the Leads tab: the FlipScout
app fills "Baths" (the MLS's "full|half", e.g. "2|1" = 2.5 baths) and "Lot SqFt" for every
lead since 12 Oct.

    window.__TN_LEADS__ = {v, built, from, n, leads: [{m, a, st, pl, p, bd, ba, sf, lot, yr,
                           due, dt, bad, ag, ph, br, ra, rp, tr: {arv, why, c: [[addr, price,
                           sqft, sold, mi, renovated], ...]}}]}
"""
import datetime, json, re, sys

from openpyxl import load_workbook


def load(path):
    s = open(path, encoding='utf8').read()
    return json.loads(s[s.index('{'):s.rindex('}') + 1])


def baths(v):
    """'2|1' -> 2.5 (a half bath counts .5), '3 (3/0)' -> 3, 2 -> 2; blank or unreadable -> None."""
    if v is None or v == '':
        return None
    t = str(v)
    m = re.match(r'\s*(\d+)\s*\|\s*(\d+)', t)
    if m:
        n = int(m.group(1)) + 0.5 * int(m.group(2))
    else:
        m = re.match(r'\s*(\d+(?:\.\d+)?)', t)
        if not m:
            return None
        n = float(m.group(1))
    return (int(n) if n == int(n) else n) if 0 < n < 30 else None


def number(v):
    try:
        n = float(str(v).replace(',', ''))
    except (TypeError, ValueError):
        return None
    return int(round(n)) if n > 0 else None


def clip(s, n):
    return re.sub(r'\s+', ' ', str(s or '')).strip()[:n]


def main():
    data, agents, remarks, team, xlsx, out = sys.argv[1:7]
    d, bk = load(data), load(agents).get('bk', {})
    rm, tm = load(remarks).get('by', {}), load(team).get('by', {})
    # baths and lot size by MLS #, from the Leads tab
    ws = load_workbook(xlsx, read_only=True)['Leads']
    rows = ws.iter_rows(values_only=True)
    hdr = [str(h or '').strip() for h in next(rows)]
    ci = {h: i for i, h in enumerate(hdr)}
    extra = {}
    for r in rows:
        m = str(r[ci['MLS #']] or '').strip()
        if m:
            extra[m] = (baths(r[ci['Baths']]) if 'Baths' in ci else None, number(r[ci['Lot SqFt']]) if 'Lot SqFt' in ci else None)

    C = d['cols']
    col = lambda r, k: r[C.index(k)]
    today = datetime.date.today()
    cut = (today - datetime.timedelta(days=30)).isoformat()

    def near(s):
        # a deadline more than 60 days out or 14 days gone is a misread date on the sheet, not a deadline
        try:
            days = (datetime.date.fromisoformat(s) - today).days
        except (TypeError, ValueError):
            return ''
        return s if -14 <= days <= 60 else ''

    leads = []
    for r in d['rows']:
        st, pulled = col(r, 'mstat') or '', col(r, 'date') or ''
        if not re.match(r'(Active|Coming Soon)', st, re.I) and pulled < cut:
            continue
        m = col(r, 'mls')
        L = {'m': m, 'a': col(r, 'addr'), 'st': st, 'pl': pulled}

        def put(k, v):
            if v not in (None, ''):
                L[k] = v
        ba, lot = extra.get(m, (None, None))
        put('p', col(r, 'price')); put('bd', col(r, 'beds')); put('ba', ba); put('sf', col(r, 'sqft')); put('lot', lot); put('yr', col(r, 'year'))
        put('due', near(col(r, 'sdue')))
        if L.get('due'):
            put('dt', col(r, 'dtime'))
        elif col(r, 'sdue'):
            put('bad', col(r, 'sdue'))
        put('ag', col(r, 'agent')); put('ph', col(r, 'phone')); put('br', bk.get(m))
        put('ra', clip(col(r, 'remarks'), 1200)); put('rp', clip(rm.get(m), 1500))
        t = tm.get(m)
        if t and t.get('st') == 'ARV' and (t.get('arv') or 0) > 0 and isinstance(t.get('rows'), list) and t.get('pick') is not None and t['pick'] < len(t['rows']):
            used = set(t['rows'][t['pick']].get('used') or [])
            L['tr'] = {'arv': t['arv'], 'why': t.get('why', ''), 'c': [
                [c.get('addr') or c.get('mls'), c.get('price'), c.get('sqft'), c.get('sold') or '', c.get('mi'), 1 if c.get('c') == 'remodel' else 0]
                for c in (t.get('list') or []) if c.get('mls') in used][:5]}
        leads.append(L)
    leads.sort(key=lambda l: (l.get('pl') or '', ), reverse=True)
    body = {'v': 2, 'built': today.isoformat(), 'from': 'Twin Network', 'n': len(leads), 'leads': leads}
    open(out, 'w', encoding='utf8').write('window.__TN_LEADS__ = ' + json.dumps(body, separators=(',', ':')) + ';\n')
    print('leads.js: %d properties · %d with baths · %d with a lot size · %d with an offer deadline · %d with a team-rules ARV · %d bytes' % (
        len(leads), sum(1 for l in leads if 'ba' in l), sum(1 for l in leads if 'lot' in l), sum(1 for l in leads if 'due' in l),
        sum(1 for l in leads if 'tr' in l), len(open(out, encoding='utf8').read().encode('utf8'))))


if __name__ == '__main__':
    main()
