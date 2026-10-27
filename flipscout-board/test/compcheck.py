#!/usr/bin/env python3
"""The team's comp rules (Gen's way) applied to the FlipScout app's saved comps,
for the FlipScout Board TEST only (Seth, 26 Oct: "for test page, only ok? go!").

    python3 -I compcheck.py <data.js> <comps.js> <out dir> [--today YYYY-MM-DD] [--workers 6]

The rules (Seth, 26 Oct, from Gen's three comp write-ups):
  1. Condition: the kitchen AND a bath remodeled. Luxury remodels count. Light
     updates are floor markers only. As-is / original homes, new construction
     and full rebuilds are out.
  2. Match: within 20% of our size, beds and baths within 1, built within 20
     years (and on the same side of the freeways, not checked here).
  3. Square footage: the county's, and a comp is dropped when the listing and the
     county differ by more than 10% (NOT checked here: the public pages carry
     only the listing's size. Matrix's Tax tab has the county's).
  4. Window: sold in the last 6 months (Juan, 27 Oct; it was 3, then 6).
  5. Radius (Juan, 27 Oct): 1 mile by default, widened in the market's own steps
     until 3 comps pass: San Francisco 1/2 -> 1 -> 2 mi, the five Bay counties
     around it 1 -> 2 mi, everywhere else 1 -> 2 -> 3 -> 5 mi. Every radius gets a
     row, so the board can show them side by side and the user can pick one.
  6. Need 3. Fewer at the market's last step = NEED INFO, no ARV.
  7. ARV = median $/sqft of those comps x our size, never above the highest of
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

    window.__TEAMCOMPS__ = {v, built, today, rules, radii, by: {MLS: {mk, steps, win, pick, st: 'ARV'|'NEED',
        arv, ppsf, n, mi, cap, capped, why, subj: {lat, lng, ba},
        rows: [{mi, n, used: [MLS], step, st, arv, ppsf, cap, capped, floor, odd: [{mls, addr, ppsf, off}], out: [MLS]}],
        list: [{mls, addr, price, sqft, ppsf, sold, bd, ba, yr, mi, c, lux, k, b, x, w}]}}}

rows has one entry per radius in radii; step is its place in this market's
steps (0: wider than the market goes, the user's pick only) and pick the
default row. odd lists comps whose $/sqft is more than 35% off the others'
(off, in %); out the ones left out for it, which happens only while 3 remain. c is the condition (remodel / light / asis / new / unknown), k and
b the kitchen and bath (R remodeled, L light update, '' not said), x why the
comp fails a rule other than the radius, w the remarks' words that decided the
condition.
"""
import datetime, html, json, math, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from thumbs import candidates, street_no, load_data  # noqa: E402
from listing import page, remarks_of  # noqa: E402

TRIES = 3            # a comp with no public page is tried on this many days, then left
LEAD_DAYS = 30       # a lead's own page (location, baths) is read again after this many days
RULES = {'size': 0.20, 'beds': 1, 'baths': 1, 'years': 20, 'months': 6, 'need': 3, 'odd': 0.35}
# Juan, 27 Oct: 1 mile and 6 months by default; widen the radius on its own
# where comps are thin; let the user pick a wider one; show which was used.
# Each market widens in its own steps, and stops at its last one (Seth, 27 Oct).
RADII = [0.5, 1, 2, 3, 5]                      # a row each on the board; the user can pick any
MARKET_STEPS = {'sf': [0.5, 1, 2], 'city': [1, 2], 'thin': [1, 2, 3, 5]}
# the board's county list (COUNTIES in the page), city -> county
COUNTIES = {
    'San Francisco': 'San Francisco',
    'San Mateo': 'Daly City|Pacifica|South San Francisco|Redwood City|San Bruno|San Mateo|Menlo Park|East Palo Alto|Belmont|El Granada|San Carlos|Burlingame|Foster City|Millbrae|La Honda|Half Moon Bay|Woodside|Moss Beach|Montara|Atherton|Portola Valley|Brisbane|Colma|Hillsborough|Pescadero|Emerald Hills',
    'Santa Clara': 'San Jose|Morgan Hill|Gilroy|Santa Clara|Milpitas|Campbell|Sunnyvale|Los Gatos|San Martin|Mountain View|Palo Alto|Cupertino|Saratoga|Los Altos|Monte Sereno',
    'Alameda': 'Oakland|Berkeley|San Leandro|Hayward|Fremont|Livermore|Union City|Castro Valley|Newark|Albany|Alameda|Dublin|Pleasanton|Sunol|San Lorenzo|Emeryville|Piedmont',
    'Contra Costa': 'Richmond|Antioch|Pittsburg|Concord|Martinez|Pleasant Hill|Oakley|Walnut Creek|Orinda|Brentwood|Lafayette|Clayton|Discovery Bay|San Pablo|El Sobrante|El Cerrito|Pacheco|San Ramon|North Richmond|Moraga|Danville|Pinole|Bay Point|Kensington|Hercules|Rodeo|Crockett|Byron|Knightsen|Alamo',
    'Marin': 'San Rafael|Mill Valley|Novato|San Anselmo|Fairfax|Bolinas|Larkspur|Corte Madera|Woodacre|Sausalito|Tiburon|Greenbrae|Kentfield|Point Reyes Station|Inverness|Stinson Beach|Forest Knolls|Lagunitas',
}
CITY_COUNTY = {c.lower(): k for k, v in COUNTIES.items() for c in v.split('|')}


def market(addr):
    """'sf', 'city' (the five Bay counties around it) or 'thin' (Sonoma, Napa, Solano and the rest)."""
    m = re.search(r',\s*([^,]+?),\s*CA\b', addr or '', re.I)
    county = CITY_COUNTY.get(m.group(1).strip().lower(), '') if m else ''
    return 'sf' if county == 'San Francisco' else 'city' if county else 'thin'

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
        elif age > RULES['months'] * 30.5:
            x = 'sold over %d months ago' % max(RULES['months'], int(age / 30.4))
        elif r['mi'] is None:
            x = 'no location'
        elif r['mi'] > RADII[-1]:
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
    # one row per radius: the comps that pass every other rule and lie within it
    mk = market(lead.get('addr', ''))
    steps = MARKET_STEPS[mk]
    out = {'mk': mk, 'steps': steps, 'win': RULES['months'], 'subj': {k: subj[k] for k in ('lat', 'lng', 'ba') if k in subj}}
    radii = []
    for R in RADII:
        used = [r for r in rows if not r['x'] and r['mi'] is not None and r['mi'] <= R]
        light = [r for r in rows if r['x'] == 'light update: floor only' and r['mi'] is not None and r['mi'] <= R]
        # bad data (Seth, 27 Oct): a sale whose $/sqft is far off the group's
        # median is likely a wrong size or an off-market sale. Left out when
        # enough remain; with only 3 it stays, and the board says to check it.
        # The median of all of them, not of "the others": with 3 comps one bad
        # sale would drag the other two's middle and flag a good one too.
        odd = []
        if len(used) >= RULES['need']:
            m = median([o['ppsf'] for o in used if o['ppsf']])
            for r in used:
                if m and r['ppsf'] and abs(r['ppsf'] - m) / m > RULES['odd']:
                    odd.append({'mls': r['mls'], 'addr': r['addr'], 'ppsf': r['ppsf'], 'off': round((r['ppsf'] - m) / m * 100)})
        out_ = [o['mls'] for o in odd] if odd and len(used) - len(odd) >= RULES['need'] else []
        used = [r for r in used if r['mls'] not in out_]
        row = {'mi': R, 'n': len(used), 'used': [r['mls'] for r in used], 'step': steps.index(R) + 1 if R in steps else 0}
        if odd:
            row['odd'] = odd
            row['out'] = out_
        if len(used) >= RULES['need'] and sq:
            ppsf = median([r['ppsf'] for r in used])
            cap = max(r['price'] for r in used)
            arv = round(ppsf * sq)
            row.update(st='ARV', ppsf=round(ppsf), cap=cap, capped=1 if arv > cap else 0, arv=min(arv, cap))
        else:
            row.update(st='NEED', arv=0)
        if light:
            lo = min(light, key=lambda r: r['ppsf'] or 1e9)
            row['floor'] = {'mls': lo['mls'], 'addr': lo['addr'], 'price': lo['price'], 'ppsf': lo['ppsf']}
        radii.append(row)
    # the default: the first of this market's steps with 3 comps, else its last step (NEED INFO)
    mine = [i for i, row in enumerate(radii) if row['step']]
    pick = next((i for i in mine if radii[i]['st'] == 'ARV'), mine[-1])
    p = radii[pick]
    out.update(rows=radii, pick=pick, st=p['st'], arv=p['arv'], n=p['n'], mi=p['mi'])
    if p['st'] == 'ARV':
        out.update(ppsf=p['ppsf'], cap=p['cap'], capped=p['capped'],
                   why='%d comps within %g mi, last %d months, median $%s/sqft x %s sqft%s' % (
                       p['n'], p['mi'], RULES['months'], f"{p['ppsf']:,}", f'{sq:,}', ', capped at the top sale' if p['capped'] else ''))
    else:
        out['why'] = ('%d of %d saved comps pass within %g mi in %d months; 3 needed' % (p['n'], len(rows), p['mi'], RULES['months'])
                      if sq else 'no square feet on the lead')
    order = lambda r: (0 if not r['x'] else 1, r['mi'] if r['mi'] is not None else 99)
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
    T = {'v': 2, 'built': CF['built'], 'today': tday, 'rules': RULES, 'radii': RADII, 'steps': MARKET_STEPS, 'by': res}
    with open(os.path.join(out, 'teamcomps.js'), 'w', encoding='utf8') as fh:
        fh.write('window.__TEAMCOMPS__ = ' + json.dumps(T, separators=(',', ':')) + ';\n')
    n_arv = sum(1 for r in res.values() if r['st'] == 'ARV')
    print('pages read: %d new, %d with no page, %d errors, %d on file · %ds' % (
        got, miss, errs, len(CF['by']), time.time() - t0))
    print('teamcomps.js: %d leads · %d with an ARV under the team rules · %d NEED INFO' % (len(res), n_arv, len(res) - n_arv))
    print('NEW FILES: compfacts.js teamcomps.js')


if __name__ == '__main__':
    main()
