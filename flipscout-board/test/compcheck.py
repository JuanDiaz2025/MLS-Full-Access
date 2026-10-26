#!/usr/bin/env python3
"""The team's comp rules (Gen's way) applied to the FlipScout app's saved comps,
for the FlipScout Board TEST only (Seth, 26 Oct: "for test page, only ok? go!").

    python3 -I compcheck.py <data.js> <comps.js> <out dir> [--today YYYY-MM-DD] [--workers 6]

The rules (Seth, 26 Oct, from Gen's three comp write-ups):
  1. Condition: the kitchen AND a bath remodeled. Luxury remodels count. Light
     updates are floor markers only. As-is / original homes, new construction
     and full rebuilds are out.
  2. Match: within 20% of our size, beds and baths within 1, built within 20
     years, within 1 mile (and on the same side of the freeways, not checked here).
  3. Square footage: the county's, and a comp is dropped when the listing and the
     county differ by more than 10% (NOT checked here: the public pages carry
     only the listing's size. Matrix's Tax tab has the county's).
  4. Window: sold in the last 3 months; 6 months when fewer than 3 pass.
  5. Need 3. Fewer after 6 months = NEED INFO, no ARV.
  6. ARV = median $/sqft of those comps x our size, never above the highest of
     their sale prices.

The pool is what the app saved per lead (comps.js: the sold homes in the lead's
zip nearest in size, up to 16), not yet Gen's full 1-mile Matrix search. Each
comp's public MLS page (https://www.mlslistings.com/Property/<MLS #>) gives
its location, sale date, sale price, size, beds, baths, year and remarks; so
does the lead's own page. Pages read are kept in <out>/compfacts.js and not
read again (a sale does not change; a lead's page is re-read after 30 days):

    window.__COMPFACTS__ = {v, built, by: {MLS: {lat, lng, sold, price, sqft, bd, ba, yr, lot, rem, at}},
                            miss: {MLS: [tries, day, why]}}

and the result for each lead goes to <out>/teamcomps.js, which only the Test
board reads:

    window.__TEAMCOMPS__ = {v, built, today, rules, by: {MLS: {st: 'ARV'|'NEED', arv, ppsf, n, win, cap,
        capped, floor, why, subj: {lat, lng, ba}, list: [{mls, addr, price, sqft, ppsf, sold, bd, ba, yr,
        mi, c, lux, k, b, ok, x, w}]}}}

c is the condition (remodel / light / asis / new / unknown), k and b the kitchen
and bath (R remodeled, L light update, '' not said), ok 1 when the comp counts,
x why it does not, w the remarks' words that decided the condition.
"""
import datetime, html, json, math, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from thumbs import candidates, street_no, load_data  # noqa: E402
from listing import page, remarks_of  # noqa: E402

TRIES = 3            # a comp with no public page is tried on this many days, then left
LEAD_DAYS = 30       # a lead's own page (location, baths) is read again after this many days
RULES = {'size': 0.20, 'beds': 1, 'baths': 1, 'years': 20, 'miles': 1.0, 'months': [3, 6], 'need': 3}

# ---------- what a sold home's remarks say was done ----------
# Read against the team's line (Seth, 26 Oct): "kitchen AND a bath remodeled".
# "Updated" is a light update until the photos say otherwise.
WORK = r'(?:remodel(?:l)?ed|renovated|redone|rebuilt)'
QUAL = (r'(?:fully|completely|totally|extensively|comprehensively|thoughtfully|meticulously|impeccably|'
        r'beautifully|newly|recently|tastefully|stunningly|gorgeously|lovingly|expertly|professionally)')
ROOMS = r'(?:kitchen|bath|bathroom|baths|bathrooms|primary|master|guest|hall|powder|en[- ]?suite|garage|basement)'
# the whole house: a remodel that names no one room
WHOLE = re.compile(
    r'\b(?:' + QUAL + r'\s+' + WORK + r'(?!\s+(?:and\s+\w+\s+)?' + ROOMS + r')'
    r'|(?:complete|comprehensive|full|total|extensive|gut|whole[- ]house|major|meticulous|thoughtful|stunning)\s+'
    r'(?:remodel|renovation|rehab|transformation)'
    r'|' + WORK + r'\s+(?:from\s+)?top\s+to\s+bottom|' + WORK + r'\s+throughout'
    r'|every\s+(?:surface|inch)\s+(?:has\s+been\s+|was\s+)?(?:touched|updated|' + WORK + r'))', re.I)
KIT_R = re.compile(
    r"\b(?:(?:new|brand[- ]new|all[- ]new|" + WORK + r"|custom|designer)\s+(?:eat[- ]in\s+|chef'?s\s+|gourmet\s+)?kitchen"
    r"|kitchen\s+(?:was\s+|has\s+been\s+|is\s+)?(?:fully\s+|completely\s+|newly\s+|recently\s+|totally\s+)?" + WORK +
    r"|kitchen\s+(?:remodel|renovation)|(?:abundant\s+|all\s+)?new\s+(?:kitchen\s+)?cabinet(?:s|ry)"
    r"|custom\s+(?:kitchen\s+)?cabinet(?:s|ry)|thermador|sub[- ]?zero|wolf\s+(?:range|appliance|stove|oven)"
    r"|new\s+(?:quartz|stone|marble|granite|quartzite|caesarstone)\s+(?:counter|countertop)s?\s+and\s+cabinet)", re.I)
KIT_L = re.compile(
    r"\b(?:(?:updated|refreshed|upgraded|refinished|renewed|remodeled\s+looking)\s+(?:eat[- ]in\s+)?kitchen"
    r"|kitchen\s+(?:was\s+|has\s+been\s+|is\s+)?(?:fully\s+|recently\s+|nicely\s+)?(?:updated|refreshed|upgraded)"
    r"|(?:newly\s+)?painted\s+cabinet|new\s+(?:cooktop|range|stove|appliances|stainless(?:\s+steel)?\s+appliances|dishwasher)"
    r"|kitchen\s+with\s+(?:new|modern|stainless|updated))", re.I)
BATH = r'(?:bath|bathroom)s?'
BATH_R = re.compile(
    r"\b(?:(?:new|brand[- ]new|all[- ]new|" + WORK + r"|newly[- ]tiled|spa[- ](?:like|inspired)|designer)\s+"
    r"(?:(?:primary|master|guest|hall|full|both|two|three|all|the|en[- ]?suite)\s+)?" + BATH +
    r"|" + BATH + r"\s+(?:were\s+|was\s+|have\s+been\s+|has\s+been\s+)?(?:fully\s+|completely\s+|newly\s+|recently\s+|all\s+)?" + WORK +
    r"|(?:bath|bathroom)\s+(?:remodel|renovation)s?|new\s+tiled?\s+(?:shower|tub|bath)s?|new\s+vanit(?:y|ies))", re.I)
BATH_L = re.compile(
    r"\b(?:(?:updated|refreshed|upgraded|refinished)\s+(?:stylish\s+)?(?:(?:primary|master|guest|hall|the)\s+)?" + BATH +
    r"|" + BATH + r"\s+(?:was\s+|were\s+|has\s+been\s+|have\s+been\s+)?(?:nicely\s+)?(?:updated|refreshed))", re.I)
# one verb for both rooms: "remodeled kitchen and baths", "kitchen and bathrooms were renovated"
BOTH_R = re.compile(
    r"\b(?:(?:new|brand[- ]new|all[- ]new|" + QUAL + r"\s+" + WORK + r"|" + WORK + r")\s+kitchen\s+(?:and|&)\s+(?:the\s+)?(?:\w+\s+)?" + BATH +
    r"|kitchen\s+(?:and|&)\s+(?:the\s+)?(?:\w+\s+)?" + BATH + r"\s+(?:were\s+|have\s+been\s+|are\s+)?(?:all\s+|fully\s+|completely\s+|newly\s+)?" + WORK + r")",
    re.I)
LUX = re.compile(
    r"\b(?:thermador|sub[- ]?zero|wolf\s+(?:range|appliance|stove|oven)|miele|viking|gaggenau|la\s+cornue|"
    r"espresso\s+machine|wine\s+(?:fridge|refrigerator|cooler)|architect[- ](?:owner|designed|led)|"
    r"designer\s+(?:cabinet|finish|fixture|light|pendant)|smart[- ]home|heated\s+floor|"
    r"steam\s+shower|every\s+surface|ultra[- ]custom|bespoke)", re.I)
NEWB = re.compile(
    r"\b(?:new\s+construction|newly\s+(?:built|constructed)|brand[- ]new\s+(?:home|construction|build)|"
    r"rebuilt\s+from|(?:down\s+to|from)\s+the\s+studs|studs?[- ]up|ground[- ]up)\b", re.I)
ASIS = re.compile(
    r"\b(?:fixer|as[- ]is|original\s+condition|needs?\s+(?:work|tlc|updating|updates|renovation|some\s+love|a\s+full)|"
    r"tlc\b|contractor'?s?\s+(?:special|delight)|investor\s+(?:special|opportunity)|bring\s+your\s+(?:contractor|vision|ideas|tools)|"
    r"handyman|sweat\s+equity|deferred\s+maintenance|tear[- ]?down|renovate\s+or\s+rebuild|"
    r"opportunity\s+to\s+(?:renovate|update|remodel|restore)|ready\s+for\s+(?:your|a)\s+(?:renovation|remodel|update|vision|personal\s+touch))", re.I)
SOFT = re.compile(
    r"\b(?:updated|refreshed|remodel(?:l)?ed|renovated|fresh(?:ly)?\s+paint(?:ed)?|new\s+(?:paint|flooring|floors|carpet|windows)|"
    r"refinished|move[- ]in[- ]ready|turn[- ]?key)", re.I)


def condition(rem, yr, today_year):
    """(c, lux, k, b, words): what a sold home's remarks say was done to it."""
    t = re.sub(r'\s+', ' ', rem or '')
    hit = lambda rx: (rx.search(t).group(0) if rx.search(t) else '')
    lux = 1 if LUX.search(t) else 0
    both = BOTH_R.search(t)
    k = 'R' if both or KIT_R.search(t) else 'L' if KIT_L.search(t) else ''
    b = 'R' if both or BATH_R.search(t) else 'L' if BATH_L.search(t) else ''
    words = [w for w in (hit(WHOLE), hit(BOTH_R) or hit(KIT_R) or hit(KIT_L), '' if both else hit(BATH_R) or hit(BATH_L)) if w]
    if yr and today_year - yr < 10:
        return 'new', lux, k, b, 'built %d' % yr
    if NEWB.search(t):
        return 'new', lux, k, b, hit(NEWB)
    if not t:
        return 'unknown', 0, '', '', 'no remarks'
    # a whole-house claim counts unless the remarks call the kitchen or a bath only an update
    if (WHOLE.search(t) and k != 'L' and b != 'L') or (k == 'R' and b == 'R'):
        return 'remodel', lux, k, b, ' · '.join(dict.fromkeys(words))[:90]
    if ASIS.search(t):
        return 'asis', lux, k, b, hit(ASIS)
    if k or b or SOFT.search(t):
        return 'light', lux, k, b, (' · '.join(dict.fromkeys(words)) or hit(SOFT))[:90]
    return 'unknown', lux, k, b, 'remarks say nothing about the work'


# ---------- one public page -> facts ----------
NUM = lambda s: float(s.replace(',', '')) if s else 0
MONTHS = {m: i + 1 for i, m in enumerate('Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split())}


def facts(s, title):
    f = {}
    m = re.search(r'"latitude":\s*(-?\d+\.\d+)[^}]*?"longitude":\s*(-?\d+\.\d+)', s)
    if m:
        f['lat'], f['lng'] = round(float(m.group(1)), 6), round(float(m.group(2)), 6)
    m = re.search(r'Sold on ([A-Z][a-z]{2}) (\d{1,2}), (\d{4})', s)
    if m and m.group(1) in MONTHS:
        f['sold'] = '%s-%02d-%02d' % (m.group(3), MONTHS[m.group(1)], int(m.group(2)))
    m = re.search(r'"offers":\s*\{[^}]*?"price":\s*(\d+)', s)
    if m:
        f['price'] = int(m.group(1))
    m = re.search(r'(\d+) Beds? \| (\d+(?:\.\d+)?) Baths?', title or '')
    if m:
        f['bd'], f['ba'] = int(m.group(1)), float(m.group(2))
    t = html.unescape(re.sub(r'<[^>]+>', ' ', s))
    m = re.search(r'This ([\d,]+) square foot property sits on an? ([\d,.]+) (Sq Ft|Acre)', t)
    if m:
        f['sqft'] = int(NUM(m.group(1)))
        f['lot'] = int(NUM(m.group(2)) * (43560 if m.group(3) == 'Acre' else 1))
    m = re.search(r'(?:was|were) built in (\d{4})', t)
    if m:
        f['yr'] = int(m.group(1))
    f['rem'] = remarks_of(s)[:1500]
    return f


def fetch(job):
    mls, addr = job
    why = 'no MLS page'
    for pid in candidates(mls):
        try:
            s, title = page(pid)
        except Exception as e:
            return mls, None, 'page error: %s' % str(e)[:80]
        if not s:
            why = title
            continue
        a, b = street_no(addr), street_no(title)
        if a and b and a != b:
            why = 'MLS page is %s' % title.split(' - ')[0][:60]
            continue
        return mls, facts(s, title), ''
    return mls, None, why


def miles(a, b):
    if not (a.get('lat') and b.get('lat')):
        return None
    p1, p2 = math.radians(a['lat']), math.radians(b['lat'])
    dp, dl = p2 - p1, math.radians(b['lng'] - a['lng'])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return round(3958.8 * 2 * math.asin(math.sqrt(h)), 2)


def median(xs):
    xs = sorted(xs)
    n = len(xs)
    return 0 if not n else xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def judge(lead, subj, comps, F, today):
    """The team rules over one lead's saved comps."""
    sq, by, yr = lead.get('sqft') or 0, lead.get('beds') or 0, lead.get('year') or 0
    sba = subj.get('ba')
    rows = []
    for c in comps:
        f = F.get(c['mls']) or {}
        price = f.get('price') or c.get('price') or 0
        csq = f.get('sqft') or c.get('sqft') or 0
        sold = f.get('sold') or c.get('sold') or ''
        cyr = f.get('yr') or c.get('yr') or 0
        cbd = f.get('bd') if f.get('bd') is not None else c.get('bd')
        cba = f.get('ba') if f.get('ba') is not None else c.get('ba')
        cond, lux, k, b, w = condition(f.get('rem', ''), cyr, today.year) if f else ('unknown', 0, '', '', 'public page not read')
        r = {'mls': c['mls'], 'addr': c.get('addr', ''), 'price': price, 'sqft': csq,
             'ppsf': round(price / csq) if price and csq else 0, 'sold': sold, 'bd': cbd, 'ba': cba, 'yr': cyr,
             'mi': miles(subj, f) if f else None, 'c': cond, 'lux': lux, 'k': k, 'b': b, 'w': w}
        age = (today - datetime.date.fromisoformat(sold)).days if re.match(r'\d{4}-\d\d-\d\d$', sold) else None
        r['days'] = age
        x = ''
        if not f:
            x = 'public page not read'
        elif age is None:
            x = 'no sale date'
        elif age > 183:
            x = 'sold over %d months ago' % max(6, int(age / 30.4))
        elif r['mi'] is None:
            x = 'no location'
        elif r['mi'] > RULES['miles']:
            x = '%.1f mi away' % r['mi']
        elif not (sq and csq) or abs(csq - sq) / sq > RULES['size']:
            x = '%+d%% size' % round((csq - sq) / sq * 100) if sq and csq else 'no size'
        elif by and cbd not in (None, '') and abs(cbd - by) > RULES['beds']:
            x = '%s beds vs %s' % (cbd, by)
        elif sba and cba not in (None, '') and abs(cba - sba) > RULES['baths']:
            x = '%s baths vs %g' % (cba, sba)
        elif yr and cyr and abs(cyr - yr) > RULES['years']:
            x = 'built %d' % cyr
        elif cond != 'remodel':
            x = {'light': 'light update: floor only', 'asis': 'as-is', 'new': 'new or rebuilt',
                 'unknown': 'condition not said: check photos in Matrix'}[cond]
        r['x'] = x
        rows.append(r)
    passing = [r for r in rows if not r['x']]
    win = 3
    used = [r for r in passing if r['days'] <= 92]
    if len(used) < RULES['need']:
        win, used = 6, passing
    for r in rows:
        r['ok'] = 1 if r in used else 0
        if not r['x'] and not r['ok']:
            r['x'] = 'outside %d months' % win
    floor_rows = [r for r in rows if r['x'] == 'light update: floor only']
    out = {'n': len(used), 'win': win, 'subj': {k: subj[k] for k in ('lat', 'lng', 'ba') if k in subj}}
    if floor_rows:
        lo = min(floor_rows, key=lambda r: r['ppsf'] or 1e9)
        out['floor'] = {'mls': lo['mls'], 'addr': lo['addr'], 'price': lo['price'], 'ppsf': lo['ppsf']}
    if len(used) >= RULES['need'] and sq:
        ppsf = median([r['ppsf'] for r in used])
        cap = max(r['price'] for r in used)
        arv = round(ppsf * sq)
        out.update(st='ARV', ppsf=round(ppsf), cap=cap, capped=1 if arv > cap else 0, arv=min(arv, cap),
                   why='%d comps, %d months, median $%s/sqft x %s sqft%s' % (
                       len(used), win, f'{round(ppsf):,}', f'{sq:,}', ', capped at the top sale' if arv > cap else ''))
    else:
        out.update(st='NEED', arv=0, why='%d of %d saved comps pass in 6 months; 3 needed' % (len(used), len(rows))
                   if sq else 'no square feet on the lead')
    order = lambda r: (-r['ok'], 0 if not r['x'] else 1, r['mi'] if r['mi'] is not None else 99)
    out['list'] = [{k: v for k, v in r.items() if k != 'days' and v not in (None, '')} for r in sorted(rows, key=order)]
    return out


def load_js(path, empty):
    if not os.path.exists(path):
        return empty
    src = open(path, encoding='utf8').read()
    return json.loads(src[src.index('{'):src.rindex('}') + 1])


def main():
    a = sys.argv[1:]
    if len(a) < 3:
        sys.exit(__doc__)
    opt = lambda n, d: a[a.index(n) + 1] if n in a else d
    data, comps, out = load_data(a[0]), load_js(a[1], {'by': {}}), a[2]
    today = datetime.date.fromisoformat(opt('--today', datetime.date.today().isoformat()))
    workers = int(opt('--workers', '6'))
    os.makedirs(out, exist_ok=True)
    cf_path = os.path.join(out, 'compfacts.js')
    CF = load_js(cf_path, {'v': 1, 'by': {}, 'miss': {}})
    CF.setdefault('by', {}), CF.setdefault('miss', {})
    ix = {k: i for i, k in enumerate(data['cols'])}
    leads = {r[ix['mls']]: {k: r[ix[k]] for k in ('mls', 'addr', 'sqft', 'beds', 'year')} for r in data['rows']}
    by = {m: c for m, c in (comps.get('by') or {}).items() if m in leads and c and c.get('list')}
    tday = today.isoformat()

    def stale(m, lead):
        f = CF['by'].get(m)
        if f:
            return lead and (today - datetime.date.fromisoformat(f.get('at', '2000-01-01'))).days > LEAD_DAYS
        ms = CF['miss'].get(m)
        return not (ms and (ms[0] >= TRIES or ms[1] == tday))
    jobs = {}
    for m in by:
        if stale(m, True):
            jobs[m] = leads[m]['addr']
        for c in by[m]['list']:
            if c['mls'] not in jobs and stale(c['mls'], False):
                jobs[c['mls']] = c.get('addr', '')
    t0, got, miss, errs = time.time(), 0, 0, 0
    with ThreadPoolExecutor(workers) as ex:
        for m, f, why in ex.map(fetch, list(jobs.items())):
            if f:
                f['at'] = tday
                CF['by'][m] = f
                CF['miss'].pop(m, None)
                got += 1
            elif why.startswith('page error'):
                errs += 1
            else:
                ms = CF['miss'].get(m, [0, ''])
                CF['miss'][m] = [ms[0] + 1, tday, why[:80]]
                miss += 1
    CF['v'], CF['built'] = 1, time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    with open(cf_path, 'w', encoding='utf8') as fh:
        fh.write('window.__COMPFACTS__ = ' + json.dumps(CF, separators=(',', ':')) + ';\n')

    res = {}
    for m, c in by.items():
        res[m] = judge(leads[m], CF['by'].get(m) or {}, c['list'], CF['by'], today)
    T = {'v': 1, 'built': CF['built'], 'today': tday, 'rules': RULES, 'by': res}
    with open(os.path.join(out, 'teamcomps.js'), 'w', encoding='utf8') as fh:
        fh.write('window.__TEAMCOMPS__ = ' + json.dumps(T, separators=(',', ':')) + ';\n')
    n_arv = sum(1 for r in res.values() if r['st'] == 'ARV')
    print('pages read: %d new, %d with no page, %d errors, %d on file · %ds' % (
        got, miss, errs, len(CF['by']), time.time() - t0))
    print('teamcomps.js: %d leads · %d with an ARV under the team rules · %d NEED INFO' % (len(res), n_arv, len(res) - n_arv))
    print('NEW FILES: compfacts.js teamcomps.js')


if __name__ == '__main__':
    main()
