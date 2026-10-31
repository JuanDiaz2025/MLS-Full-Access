#!/usr/bin/env python3
"""The Deal Report Builder's property list, from the same files the daily refresh publishes to Twin Network.

    python3 -I leads_for_drb.py <data.js> <agents.js> <remarks.js> <teamcomps.js> <the exported xlsx> <out leads.js>

Cherry's Deal Report Builder (https://claude.ai/artifact/Q3w5f9wqTpWMTTWhFMpmmp) loads
leads.js: picking a property there fills its price, offer deadline, beds, baths, square
feet, lot size, year built, agent, phone, brokerage, Area, a one-line summary (occupancy, days on
market, price cut) and the disclosures link, and offers the FlipScout app's comps and ARV
behind a button (Seth, 31 Oct). It keeps the
leads still on the market (Active / Coming Soon), anything pulled in the last 30 days, and
every lead with comps in the sheet (the app's ARV / Comps columns or the Team Comps tab).

Area is the Builder's Area dropdown: a San Francisco district D1-D10, a Peninsula city,
Oakland, South Bay / San Jose, or Other. For San Francisco it uses the lead's MLS district
from the Team Comps tab's "Lead Area" or the "Lead Areas" tab (FlipScout v1.75.5's MLS
districts run) (e.g. "District 10E - Visitacion Valley" -> D10), else
the zip when the zip lies in one district (marked az=1 so the Builder says to check it);
a zip that spans districts (94110, 94112, 94116, 94131, ...) is left for the person to pick.

data.js has no baths or lot size, so those come straight from the Leads tab: the FlipScout
app fills "Baths" (the MLS's "full|half", e.g. "2|1" = 2.5 baths) and "Lot SqFt" for every
lead since 12 Oct.

    window.__TN_LEADS__ = {v, built, from, n, leads: [{m, a, st, pl, p, bd, ba, sf, lot, yr,
                           due, dt, bad, ag, ph, br, ar, az, da, ol, ds, ra, rp,
                           tr: {arv, why, c: [[addr, price, sqft, sold, mi, renovated], ...]},
                           fc: {arv, conf, c: [same]}}]}

fc is the FlipScout app's own ARV and the sales it rests on (the Leads tab's ARV / Comp
Confidence / Comps), at most 5. "Renovated" is ticked when the app's ARV rests on renovated
sales (High or Medium confidence); miles come from the map pins compcheck.py keeps in
compfacts.js, next to teamcomps.js, when that file is there.
"""
import datetime, json, math, os, re, sys

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


# the Builder's Area dropdown (Cherry's list)
PENINSULA = ['San Mateo', 'San Carlos', 'Redwood City', 'Palo Alto', 'Belmont', 'Burlingame', 'Millbrae',
             'South San Francisco', 'East Palo Alto', 'Daly City']
SOUTH_BAY = {'san jose', 'santa clara', 'sunnyvale', 'mountain view', 'cupertino', 'campbell', 'milpitas', 'los gatos',
             'saratoga', 'los altos', 'los altos hills', 'monte sereno', 'morgan hill', 'gilroy'}
# San Francisco zips that lie wholly in one district. The rest span several and are left for the person to
# pick: 94110 is Mission / Bernal (D9) but also part of Noe Valley (D5, e.g. 2 Juri St); 94112 is D3, D4 and
# D10; 94116 and 94132 reach into D2, D3 and D4; 94131, 94114, 94109, 94118, 94102, 94103 and 94133 are mixed too.
SF_ZIP_DISTRICT = {'94121': 1, '94122': 2, '94127': 4, '94123': 7, '94107': 9, '94158': 9, '94124': 10, '94134': 10}


def city_of(addr):
    seg = [x.strip() for x in str(addr or '').split(',')]
    if len(seg) < 2:
        return ''
    return re.sub(r'\s+(CA|California)\b.*$', '', seg[1], flags=re.I).strip()


def area(addr, mls_area):
    """(Area key, from-zip flag): 'D10', 'San Mateo', 'Oakland', 'South Bay', 'Other' or None."""
    city = city_of(addr).lower()
    if not city:
        return None, 0
    if city == 'san francisco':
        m = re.match(r'\s*District\s+(\d{1,2})', str(mls_area or ''), re.I)
        if m and 1 <= int(m.group(1)) <= 10:
            return 'D%d' % int(m.group(1)), 0
        z = (re.findall(r'\b9\d{4}\b', str(addr)) or [''])[-1]
        return ('D%d' % SF_ZIP_DISTRICT[z], 1) if z in SF_ZIP_DISTRICT else (None, 0)
    for c in PENINSULA:
        if city == c.lower():
            return c, 0
    if city == 'oakland':
        return 'Oakland', 0
    if city in SOUTH_BAY:
        return 'South Bay', 0
    return 'Other', 0


def miles(a, b):
    """Miles between two {lat, lng}, to 0.1; None when either is missing."""
    if not (a and b and a.get('lat') is not None and b.get('lat') is not None):
        return None
    p1, p2 = math.radians(a['lat']), math.radians(b['lat'])
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(b['lng'] - a['lng']) / 2) ** 2
    return round(3958.8 * 2 * math.asin(math.sqrt(h)), 1)


OCCUPIED = {'owner': 'Owner-occupied', 'tenant': 'Tenant-occupied', 'vacant': 'Vacant'}


def one_line(occ, dom, pulled, status, cut, today):
    """'Vacant · on the market since Oct 15 (16 days) · price cut $70K (6%)'. The board's days on
    market is the count on the day the app pulled the lead, so the listing day is worked back from
    that; the day count is today's, and only while the house is still on the market. Occupancy is
    only Owner, Tenant or Vacant (the MLS also answers "Call Agent")."""
    parts = []
    o = OCCUPIED.get(str(occ or '').strip().lower())
    if o:
        parts.append(o)
    d = number(dom) if str(dom or '').strip() not in ('', '0', '0.0') else 0
    try:
        listed = datetime.date.fromisoformat(str(pulled)[:10]) - datetime.timedelta(days=d or 0)
    except ValueError:
        listed = None
    if listed and (d or str(dom or '').strip() in ('0', '0.0')):
        day = listed.strftime('%b ') + str(listed.day)
        if re.match(r'(Active|Coming Soon)', str(status or ''), re.I):
            n = (today - listed).days
            parts.append('on the market since %s (%d day%s)' % (day, n, '' if n == 1 else 's'))
        else:
            parts.append('listed %s' % day)
    c = str(cut or '').strip().lstrip('-').strip()
    if c:
        parts.append('price cut ' + re.sub(r'(\d)k\b', r'\1K', c))
    return ' · '.join(parts)


def clip(s, n):
    return re.sub(r'\s+', ' ', str(s or '')).strip()[:n]


def main():
    data, agents, remarks, team, xlsx, out = sys.argv[1:7]
    d, bk = load(data), load(agents).get('bk', {})
    rm, tm = load(remarks).get('by', {}), load(team).get('by', {})
    # baths and lot size by MLS #, from the Leads tab
    wb = load_workbook(xlsx, read_only=True)

    def tab(name):
        rows = wb[name].iter_rows(values_only=True)
        hdr = [str(h or '').strip() for h in next(rows)]
        ci = {h: i for i, h in enumerate(hdr)}
        # read-only rows drop trailing empty cells
        return ((lambda r, k: r[ci[k]] if k in ci and ci[k] < len(r) else None), rows)
    get, rows = tab('Leads')
    extra, withcomps, links, appcomps = {}, set(), {}, {}
    # map pins, for each comp's miles: compcheck.py's page cache sits next to teamcomps.js
    facts = {}
    fpath = os.path.join(os.path.dirname(os.path.abspath(team)), 'compfacts.js')
    if os.path.exists(fpath):
        facts = load(fpath)
    for r in rows:
        m = str(get(r, 'MLS #') or '').strip()
        if m:
            extra[m] = (baths(get(r, 'Baths')), number(get(r, 'Lot SqFt')))
            disc = str(get(r, 'Disclosures') or '').strip()
            if re.match(r'https?://', disc):
                links[m] = disc
            try:
                fcomps = json.loads(get(r, 'Comps') or '[]')
            except ValueError:
                fcomps = []
            if number(get(r, 'ARV')) and isinstance(fcomps, list) and fcomps:
                appcomps[m] = (number(get(r, 'ARV')), str(get(r, 'Comp Confidence') or '').strip(), fcomps)
            if get(r, 'ARV') not in (None, '') or get(r, 'Comps') not in (None, ''):
                withcomps.add(m)
    # the lead's own MLS area (district) and its team comps, from the FlipScout app's Team Comps search
    mlsarea = {}
    if 'Team Comps' in wb.sheetnames:
        get, rows = tab('Team Comps')
        for r in rows:
            m = str(get(r, 'MLS #') or '').strip()
            if not m:
                continue
            if get(r, 'Lead Area'):
                mlsarea[m] = str(get(r, 'Lead Area')).strip()
            if get(r, 'Team Comps') not in (None, '') or get(r, 'Sales Found') not in (None, '', 0):
                withcomps.add(m)
    # FlipScout v1.75.5's "MLS districts" run: every San Francisco lead's area, on its own tab
    if 'Lead Areas' in wb.sheetnames:
        get, rows = tab('Lead Areas')
        for r in rows:
            m = str(get(r, 'MLS #') or '').strip().upper()
            if m and get(r, 'Lead Area') and m not in mlsarea:
                mlsarea[m] = str(get(r, 'Lead Area')).strip()
    withcomps |= {m for m, t in tm.items() if t and t.get('st') == 'ARV'}

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
        m = col(r, 'mls')
        if not re.match(r'(Active|Coming Soon)', st, re.I) and pulled < cut and m not in withcomps:
            continue
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
        ar, az = area(L['a'], mlsarea.get(m))
        put('ar', ar); put('az', az or None); put('da', mlsarea.get(m) if re.match(r'\s*District', mlsarea.get(m) or '') else None)
        put('ol', one_line(col(r, 'occ'), col(r, 'dom'), pulled, st, col(r, 'cut'), today))
        put('ds', links.get(m))
        put('ra', clip(col(r, 'remarks'), 1200)); put('rp', clip(rm.get(m), 1500))
        if m in appcomps:
            arv, conf, fcomps = appcomps[m]
            subj = ((tm.get(m) or {}).get('subj') or (facts.get('geo') or {}).get(m) or (facts.get('by') or {}).get(m))
            fby = facts.get('by') or {}
            reno = 1 if conf in ('High', 'Medium') else 0
            used = [c for c in fcomps if isinstance(c, dict) and c.get('use') == 1][:5]
            if used:
                L['fc'] = {'arv': arv, 'conf': conf, 'c': [
                    [c.get('addr') or c.get('mls'), c.get('price'), c.get('sqft'), c.get('sold') or '', miles(subj, fby.get(c.get('mls'))), reno]
                    for c in used]}
        t = tm.get(m)
        if t and t.get('st') == 'ARV' and (t.get('arv') or 0) > 0 and isinstance(t.get('rows'), list) and t.get('pick') is not None and t['pick'] < len(t['rows']):
            used = set(t['rows'][t['pick']].get('used') or [])
            L['tr'] = {'arv': t['arv'], 'why': t.get('why', ''), 'c': [
                [c.get('addr') or c.get('mls'), c.get('price'), c.get('sqft'), c.get('sold') or '', c.get('mi'), 1 if c.get('c') == 'remodel' else 0]
                for c in (t.get('list') or []) if c.get('mls') in used][:5]}
        leads.append(L)
    leads.sort(key=lambda l: (l.get('pl') or '', ), reverse=True)
    body = {'v': 3, 'built': today.isoformat(), 'from': 'Twin Network', 'n': len(leads), 'leads': leads}
    open(out, 'w', encoding='utf8').write('window.__TN_LEADS__ = ' + json.dumps(body, separators=(',', ':')) + ';\n')
    sf = [l for l in leads if city_of(l['a']).lower() == 'san francisco']
    print('leads.js: %d properties · %d with baths · %d with a lot size · %d with an offer deadline · %d with a team-rules ARV · '
          'Area for %d (San Francisco district for %d of %d: %d from the MLS, %d from the zip) · %d with a one-line summary · '
          '%d with a disclosures link · %d with FlipScout comps (%d of their comps with miles) · %d bytes' % (
              len(leads), sum(1 for l in leads if 'ba' in l), sum(1 for l in leads if 'lot' in l), sum(1 for l in leads if 'due' in l),
              sum(1 for l in leads if 'tr' in l), sum(1 for l in leads if 'ar' in l), sum(1 for l in sf if 'ar' in l), len(sf),
              sum(1 for l in sf if 'ar' in l and not l.get('az')), sum(1 for l in sf if l.get('az')),
              sum(1 for l in leads if 'ol' in l), sum(1 for l in leads if 'ds' in l), sum(1 for l in leads if 'fc' in l),
              sum(1 for l in leads if 'fc' in l for c in l['fc']['c'] if c[4] is not None),
              len(open(out, encoding='utf8').read().encode('utf8'))))


if __name__ == '__main__':
    main()
