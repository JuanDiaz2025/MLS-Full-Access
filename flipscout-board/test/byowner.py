#!/usr/bin/env python3
"""Homes for sale by their owners, for the FlipScout Test board: a BETA
(Seth, 14 Nov: "build it first to see if it's feasible, make it a beta of
FlipScout and use the Test board"). A feasibility test run by hand: no
schedule, no Grok key, nothing on the real board.

    python3 -I byowner.py <data.js> <out dir> [--sections sfc,pen,eby,sby,nby] [--max-posts 40] [--delay 2.5]

1. Find. Craigslist's "real estate - by owner" section for each part of the SF
   Bay Area (one page each, newest first). Search engines don't index these
   posts, so they are read from Craigslist itself, slowly.
2. Sort. Rentals, rooms, land, multi-unit buildings, condos and townhouses,
   commercial space, mobile homes, "we buy houses" and partner ads, posts
   outside our counties (by city, map pin, a far-away place or zip in the
   title) and homes over the board's $3M ceiling are counted and left out.
   A home over the board's price cap (San Mateo County $2.5M, elsewhere
   $1.5M) stays in, flagged, as on the board (-20 points there).
3. Read. Each house left is opened: street address (when the owner gave one),
   map pin, posted date, beds, baths, square feet and the description. The
   description gets compcheck.py's condition read (as-is / light update /
   remodeled), and signs of a scam are flagged.
4. Match. Against the board's own leads (data.js), and against the public MLS
   site's active listings for the home's zip (the zip from the US Census
   geocoder): a "by owner" post that is also an MLS listing is an agent or a
   wholesaler reposting it.

Writes <out>/byowner.js for the Test board:

    window.__BYOWNER__ = {v, built, sections: [{sub, name, url, posts}], skipped: {reason: n},
        list: [{id, sub, title, price, city, county, addr, bd, ba, sqft, posted, url, imgs,
                c, w, fixer, flags: [...], board, mls, dup, verdict: 'lead'|'check'|'skip', why, text}]}

PropertyRadar (is the poster the owner of record? equity? behind on the
mortgage?) stays a person's check: it is a login.
"""
import datetime, html, json, os, re, sys, time, urllib.parse, urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from thumbs import UA, load_data, street_no  # noqa: E402
from compcheck import condition, CITY_COUNTY  # noqa: E402

SECTIONS = {'sfc': 'San Francisco', 'pen': 'Peninsula', 'eby': 'East Bay', 'sby': 'South Bay', 'nby': 'North Bay'}
CAP = {'San Mateo': 2500000}     # the board's Buy Box defaults
CAP_ELSE = 1500000
CEIL = 3000000                   # over this the board auto-passes
BOX = (37.1, 38.35, -122.75, -121.45)   # lat, lat, lng, lng around our six counties
BAY_ZIP = re.compile(r'^9(?:4[0-9]|5[01]|54)')
FAR = re.compile(r'\b(reno|nevada|tahoe|truckee|oregon|arizona|phoenix|texas|idaho|washington state|puerto rico|japan|mexico|las vegas|hawaii|illinois|sacramento|stockton|modesto|fresno|redding|lathrop|tracy|manteca|clearlake|lake county|mendocino|humboldt|tulare|merced|los banos|gold country|placerville|sonora|chico)\b', re.I)
GEOCODER = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?benchmark=Public_AR_Current&format=json&address='

RENT = re.compile(r'\b(for rent|for lease|rent(?:al)?\b|lease\b|leasing|/\s*mo(?:nth)?\b|per month|room for|roommate|furnished room|sublet|short[- ]term|studio (?:with|available))', re.I)
AD = re.compile(r'\b(we buy|cash (?:buyer|offer)s?|buy(?:ing)? houses|any condition|sell (?:your|my) (?:house|home) fast|close (?:fast|quick)|fast clos|investors? looking|looking for (?:a )?(?:fixer|house|home|property|partners?)|wanted|partners?\b|partnership|joint venture|crypto|bitcoin|\bbtc\b|\?\s*$)', re.I)
FIXER = re.compile(r'\b(fixer|tlc|needs? (?:some )?(?:work|updating|repairs?)|handyman|as[- ]is|original condition|blank canvas|bring your (?:ideas|vision|contractor|tools)|investor special|contractor special|sweat equity|estate sale|probate|inherited|deferred maintenance)', re.I)
MULTI = re.compile(r'\b(duplex|triplex|fourplex|four-plex|\d-?plex|plex\b|\d+\s*units?\b|(?:apartment|apt\.?) (?:building|complex|bldg)|multi[- ]?(?:unit|family)|mobile home park|rv park)', re.I)
LAND = re.compile(r'\b(acres?|\blot\b|lots\b|land\b|parcel|building lot|vacant lot)', re.I)
HOUSE = re.compile(r'\b(house|home|bungalow|ranch|cottage|victorian|craftsman|single[- ]family|sfr|\dbd|\d\s*b(?:ed)?r?\s*/|\d\s*bed)', re.I)
COMM = re.compile(r'\b(warehouse|office|retail|commercial|storefront|industrial|business|restaurant|flex property|mooring)', re.I)
MOBILE = re.compile(r'\b(mobile home|manufactured|park model|\brv\b|trailer|tiny home)', re.I)
CONDO = re.compile(r'\b(condo|condominium|townho(?:use|me)|apartment|co-?op|loft)', re.I)
SCAM = re.compile(r'\b(wire (?:the|a|transfer)|western union|moneygram|zelle|cashier.?s check|gift card|deposit (?:before|to hold|first)|send (?:me )?(?:the )?(?:deposit|money)|out of the country|overseas|missionary|military (?:duty|deployment)|keys (?:will be )?(?:mailed|sent))', re.I)
STREET = re.compile(r'\b(\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z][A-Za-z\.\']*(?:\s+[A-Za-z][A-Za-z\.\']*){0,3}\s+(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ct|Court|Ln|Lane|Way|Blvd|Boulevard|Pl|Place|Ter|Terrace|Cir|Circle|Pkwy|Parkway|Hwy|Highway|Loop|Row|Sq|Square|Trl|Trail))\b\.?', re.I)


def get(url, delay):
    time.sleep(delay)
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html'})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read(5_000_000).decode('utf8', 'replace')


def text(s):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s or ''))).strip()


def money(s):
    s = re.sub(r'[^\d]', '', s or '')
    return int(s) if s else 0


def search(sub, delay):
    """The section's posts: title, price, area, url, and from its structured data the
    home type, city, zip, map pin, beds and baths."""
    url = 'https://www.craigslist.org/search/subarea/%s?cat=rea&purveyor=owner' % sub
    s = get(url, delay)
    lis = re.findall(r'<li class="cl-static-search-result"[^>]*>(.*?)</li>', s, re.S)
    m = re.search(r'id="ld_searchpage_results"[^>]*>(.*?)</script>', s, re.S)
    ld = []
    if m:
        try:
            ld = [x.get('item', {}) for x in json.loads(m.group(1)).get('itemListElement', [])]
        except ValueError:
            ld = []
    out = []
    for i, li in enumerate(lis):
        h = re.search(r'href="([^"]+)"', li)
        if not h:
            continue
        it = ld[i] if i < len(ld) and text(ld[i].get('name', ''))[:20] == text(re.search(r'<div class="title">(.*?)</div>', li, re.S).group(1) if re.search(r'<div class="title">(.*?)</div>', li, re.S) else '')[:20] else {}
        a = it.get('address') or {}
        out.append({'id': h.group(1).rstrip('/').rsplit('/', 1)[-1], 'sub': sub, 'url': h.group(1),
                    'title': text((re.search(r'<div class="title">(.*?)</div>', li, re.S) or [None, ''])[1]),
                    'price': money((re.search(r'<div class="price">(.*?)</div>', li, re.S) or [None, ''])[1]),
                    'hood': text((re.search(r'<div class="location">(.*?)</div>', li, re.S) or [None, ''])[1]),
                    'type': it.get('@type', ''), 'city': a.get('addressLocality', ''), 'zip': a.get('postalCode', ''),
                    'lat': it.get('latitude'), 'lng': it.get('longitude'),
                    'bd': it.get('numberOfBedrooms'), 'ba': it.get('numberOfBathroomsTotal')})
    return url, out


def county_of(p):
    for c in (p.get('city') or '', p.get('hood') or ''):
        c = c.strip().lower()
        if c in CITY_COUNTY:
            return CITY_COUNTY[c]
        for part in re.split(r'\s*/\s*', c):
            if part in CITY_COUNTY:
                return CITY_COUNTY[part]
    return ''


def early(p):
    """Why a post is left out from its title, price and type alone, or '' to read it."""
    t = p['title']
    if not re.search(r'\s', t.strip()) or AD.search(t):
        return 'cash-buyer ad or wanted ad'
    if RENT.search(t) or (0 < p['price'] < 60000 and not LAND.search(t)):
        return 'rental or room'
    if COMM.search(t):
        return 'commercial'
    if MOBILE.search(t):
        return 'mobile home or RV'
    if MULTI.search(t):
        return 'multi-unit'
    if LAND.search(t) and not HOUSE.search(t):
        return 'land'
    if CONDO.search(t):
        return 'condo or townhouse'
    p['county'] = county_of(p)
    if not p['county'] or far(p, t):
        return 'outside our counties'
    if p['price'] and p['price'] > CEIL:
        return 'over the $3M ceiling'
    return ''


def far(p, t):
    """A post that is about a home somewhere else: its map pin outside our counties,
    a far-away place in its title, or a zip outside the Bay Area."""
    lat, lng = p.get('lat'), p.get('lng')
    if lat and lng and not (BOX[0] <= lat <= BOX[1] and BOX[2] <= lng <= BOX[3]):
        return True
    if FAR.search(t):
        return True
    z = re.search(r'\b(9\d{4})\b', t)
    return bool(z and not BAY_ZIP.match(z.group(1)))


def read_post(p, delay):
    s = get(p['url'], delay)
    g = lambda pat: (re.search(pat, s, re.S) or [None, ''])[1]
    p['map'] = text(g(r'<div class="mapaddress">(.*?)</div>'))
    p['lat'] = float(g(r'data-latitude="([^"]+)"') or p.get('lat') or 0) or None
    p['lng'] = float(g(r'data-longitude="([^"]+)"') or p.get('lng') or 0) or None
    p['posted'] = g(r'<time class="date timeago" datetime="([^"]+)"')[:10]
    attrs = text(' '.join(re.findall(r'class="attrgroup"(.*?)</div>', s, re.S)))
    p['attrs'] = attrs[:200]
    m = re.search(r'(\d+)BR\s*/\s*(\d+(?:\.\d+)?)Ba', attrs)
    if m:
        p['bd'], p['ba'] = int(m.group(1)), float(m.group(2))
    m = re.search(r'(\d[\d,]*)\s*ft2', attrs)
    p['sqft'] = money(m.group(1)) if m else None
    p['price'] = money(g(r'class="price">([^<]+)<')) or p['price']
    body = text(g(r'<section id="postingbody">(.*?)</section>')).replace('QR Code Link to This Post', '').strip()
    p['text'] = body[:1500]
    p['imgs'] = len(set(re.findall(r'images\.craigslist\.org/([A-Za-z0-9_]+?)_\d', s)))
    # the street address: the map line when it starts with a number, else one in the title or text
    addr = p['map'] if re.match(r'^\d{1,6}\s+\S', p['map']) else ''
    if not addr:
        m = STREET.search(p['title']) or STREET.search(body)
        addr = m.group(1) if m else ''
    addr = re.sub(r'\s+(near|at|&|and)\s+.*$', '', addr, flags=re.I).strip()
    if re.search(r'\b(minutes?|mins?|miles?|blocks?|hours?|seconds?|years?|feet|ft|sq)\b', addr, re.I):
        addr = ''
    p['addr'] = addr
    return attrs, body


def late(p, attrs, body):
    """Why a house is left out once its page is read, or ''."""
    a = attrs.lower()
    if re.search(r'\b(manufactured)\b', a):
        return 'mobile home or RV'
    if re.search(r'\b(land)\b', a) and not re.search(r'\bhouse\b', a):
        return 'land'
    if re.search(r'\b(condo|townhouse|duplex|in-law|flat|loft)\b', a) and not re.search(r'\bhouse\b', a):
        return 'condo, townhouse or multi-unit (post details)'
    # owners often leave Craigslist's home type on "apartment": keep it, flagged
    p['apt'] = bool(re.search(r'\bapartment\b', a) and not re.search(r'\bhouse\b', a))
    if (not p['price'] or p['price'] < 100000) and re.search(r'\b(for rent|for lease|per month|/\s*mo\b|security deposit|lease term)', body[:600], re.I) \
            and not re.search(r'\b(for sale|sell|selling|asking|offers?|seller (?:will )?carr(?:y|ies)|owner financ\w*|financing|down payment|escrow)\b', body + ' ' + p['title'], re.I):
        return 'rental or room'
    if far(p, p['title'] + ' ' + body[:300]):
        return 'outside our counties'
    if re.search(r'\bfire[- ]damage', body + ' ' + p['title'], re.I):
        return 'fire damage (a hard rule on the board)'
    return ''


def norm(addr):
    """'1242 Shafter Street' -> '1242 shafter' (number and first street word)."""
    m = re.match(r'\s*(\d{1,6})\s+(?:[NSEW]\.?\s+)?([A-Za-z0-9]+)', addr or '')
    return (m.group(1) + ' ' + m.group(2).lower()) if m else ''


def geocode_zip(addr, city):
    try:
        req = urllib.request.Request(GEOCODER + urllib.parse.quote('%s, %s, CA' % (addr, city)), headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            hits = (json.loads(r.read().decode('utf8')).get('result') or {}).get('addressMatches') or []
    except Exception:
        return ''
    m = re.search(r'\b(9\d{4})\b', hits[0].get('matchedAddress', '')) if hits else None
    return m.group(1) if m else ''


MLS_CACHE = {}


def mls_active(z, delay):
    """{'1242 shafter': 'ML…'} for the zip's active listings on the public MLS site (up to 3 pages)."""
    if z in MLS_CACHE:
        return MLS_CACHE[z]
    out = {}
    try:
        s = get('https://www.mlslistings.com/search/result/zip/%s' % z, delay)
        pages = [s]
        for n in range(2, 4):
            m = re.search(r'href="(/Search/Result/%s/%d\?[^"]+)"' % (z, n), s)
            if not m:
                break
            pages.append(get('https://www.mlslistings.com' + html.unescape(m.group(1)), delay))
        for pg in pages:
            for c in re.split(r'<!-- Listing Result Card -->', pg)[1:]:
                mm = re.search(r'data-target="([A-Z0-9]+)"', c)
                t = text(re.sub(r'<style.*?</style>|<script.*?</script>', '', c, flags=re.S))
                am = re.search(r'(\d{1,6}\s+[^,]{2,60}),', t)
                if mm and am and norm(am.group(1)):
                    out[norm(am.group(1))] = mm.group(1)
    except Exception as e:
        print('  MLS page for %s failed: %s' % (z, str(e)[:80]))
    MLS_CACHE[z] = out
    return out


def main():
    a = sys.argv[1:]
    if len(a) < 2:
        sys.exit(__doc__)
    data_js, out = a[:2]
    opt = lambda k, d: a[a.index(k) + 1] if k in a else d
    subs = [x for x in opt('--sections', 'sfc,pen,eby,sby,nby').split(',') if x in SECTIONS]
    max_posts, delay = int(opt('--max-posts', '40')), float(opt('--delay', '2.5'))
    today = datetime.date.today()
    d = load_data(data_js)
    cols = d['cols']
    board = {}
    for r in d['rows']:
        row = dict(zip(cols, r))
        k = norm(row.get('addr', ''))
        if k:
            board.setdefault(k, []).append((row['mls'], row.get('addr', '')))
    os.makedirs(out, exist_ok=True)

    sections, posts, skipped = [], [], {}
    for sub in subs:
        try:
            url, got = search(sub, delay)
        except Exception as e:
            print('%s: search failed: %s' % (sub, str(e)[:80]))
            continue
        sections.append({'sub': sub, 'name': SECTIONS[sub], 'url': url, 'posts': len(got)})
        print('%s: %d posts' % (SECTIONS[sub], len(got)))
        posts += got
    # a post crossposted to two sections counts once
    seen, uniq = set(), []
    for p in posts:
        if p['id'] in seen:
            skipped['in two sections'] = skipped.get('in two sections', 0) + 1
            continue
        seen.add(p['id'])
        uniq.append(p)
    keep = []
    for p in uniq:
        why = early(p)
        if why:
            skipped[why] = skipped.get(why, 0) + 1
        else:
            keep.append(p)
    print('%d posts, %d houses to read' % (len(uniq), len(keep)))
    if len(keep) > max_posts:
        skipped['not read (over --max-posts)'] = len(keep) - max_posts
        keep = keep[:max_posts]

    lst, by_key = [], {}
    for p in keep:
        try:
            attrs, body = read_post(p, delay)
        except Exception as e:
            print('  %s: page failed: %s' % (p['url'], str(e)[:80]))
            continue
        why = late(p, attrs, body)
        if why:
            skipped[why] = skipped.get(why, 0) + 1
            print('  out   %-10s %-48s %s' % ('$' + format(p['price'], ',') if p['price'] else 'no price', p['title'][:48], why))
            continue
        c, lux, k, b, w = condition(body + ' ' + p['title'], None, today.year)
        fx = FIXER.search(body + ' ' + p['title'])
        if fx and c not in ('remodel', 'new'):
            c, w = 'asis', fx.group(0)
        p['c'], p['w'] = c, w
        p['fixer'] = c == 'asis'
        flags = []
        if SCAM.search(body):
            flags.append('scam signs in the text: ' + SCAM.search(body).group(0))
        if not p['addr']:
            flags.append('no street address: ask the owner')
        if not p['price']:
            flags.append('no price')
        if p.get('imgs', 0) == 0:
            flags.append('no photos')
        if p.get('apt'):
            flags.append('the owner marked it an apartment: check it is a house, not a condo')
        capv = CAP.get(p.get('county'), CAP_ELSE)
        if re.search(r'\b(seller (?:will )?carr(?:y|ies)|owner financ\w*|seller financ\w*)', body + ' ' + p['title'], re.I):
            flags.append('the owner offers to carry the loan (seller financing)')
        if p['price'] and p['price'] > capv:
            flags.append('over our $%sM cap for %s County (-20 points on the board)' % (('%.1f' % (capv / 1e6)).rstrip('0').rstrip('.'), p.get('county')))
        # the same house posted twice (same address, or the same text)
        key = norm(p['addr']) or body[:160].lower()
        twin = '%s|%s|%s' % ((p.get('city') or '').lower(), p['price'], p.get('bd')) if p['price'] else ''
        p['dup'] = by_key.get(key, '') or (by_key.get(twin, '') if twin else '')
        if not p['dup']:
            by_key[key] = p['id']
            if twin:
                by_key[twin] = p['id']
        # on the board already? on the MLS (an agent or wholesaler reposting it)?
        nk = norm(p['addr'])
        p['board'] = board[nk][0][0] if nk in board else ''
        p['mls'] = ''
        if nk:
            z = p.get('zip') or geocode_zip(p['addr'], p.get('city') or p.get('hood') or '')
            p['zip'] = z
            if z:
                p['mls'] = mls_active(z, delay).get(nk, '')
        p['flags'] = flags
        if p['dup']:
            p['verdict'], p['why'] = 'skip', 'the same house is posted again (same text, address, or city, price and beds)'
        elif p['mls']:
            p['verdict'], p['why'] = 'skip', 'it is an MLS listing (%s): an agent or wholesaler reposting it' % p['mls']
        elif p['board']:
            p['verdict'], p['why'] = 'skip', 'already on the board (%s)' % p['board']
        elif c in ('remodel', 'new'):
            p['verdict'], p['why'] = 'skip', 'already remodeled or new (%s)' % w
        elif p['fixer'] or c in ('unknown', 'light'):
            p['verdict'] = 'lead' if p['fixer'] and not any(f.startswith('scam') for f in flags) else 'check'
            p['why'] = ('needs work: “%s”' % w) if p['fixer'] else ('condition not clear from the post' if c == 'unknown' else 'a light update: “%s”' % w)
        else:
            p['verdict'], p['why'] = 'check', 'read the post'
        lst.append({k2: p.get(k2) for k2 in ('id', 'sub', 'title', 'price', 'city', 'county', 'hood', 'addr', 'zip', 'bd', 'ba', 'sqft',
                                            'posted', 'url', 'imgs', 'c', 'w', 'fixer', 'flags', 'board', 'mls', 'dup', 'verdict', 'why', 'text', 'lat', 'lng')})
        print('  %-5s %-10s %-48s %s' % (p['verdict'], '$' + format(p['price'], ',') if p['price'] else 'no price', (p['addr'] or p['title'])[:48], p['why'][:70]))

    order = {'lead': 0, 'check': 1, 'skip': 2}
    lst.sort(key=lambda x: (order[x['verdict']], -(x['price'] or 0)))
    doc = {'v': 1, 'built': datetime.datetime.now().strftime('%Y-%m-%d %H:%M'), 'sections': sections,
           'skipped': dict(sorted(skipped.items(), key=lambda kv: -kv[1])), 'list': lst}
    with open(os.path.join(out, 'byowner.js'), 'w') as f:
        f.write('window.__BYOWNER__ = ' + json.dumps(doc, separators=(',', ':')) + ';\n')
    n = lambda v: sum(1 for x in lst if x['verdict'] == v)
    print('byowner.js: %d posts in %d sections; %d houses read: %d leads, %d to check, %d skipped after reading; left out before reading: %s'
          % (len(uniq), len(sections), len(lst), n('lead'), n('check'), n('skip'), ', '.join('%s %d' % kv for kv in doc['skipped'].items())))


if __name__ == '__main__':
    main()
