#!/usr/bin/env python3
"""Listing agents' photos for the Test board's agent cards.

    python3 -I agentphotos.py <data.js> <out dir> [--sample N] [--workers 6]

The public listing page https://www.mlslistings.com/Property/<MLS #> has a
"Listing Agent" box: the agent's name, brokerage, license number (their DRE
number) and, when the agent has put one on MLSListings, a photo. For each
agent not already in <out dir>/agphotos/index.js (the live board's copy) this
opens the page of their newest listing (up to 3 of them, until one has the
box), checks the box names the same agent
as the sheet does (same last name, or the same phone), and cuts the photo to
a 96x96 tile. New tiles go into JPEG sheets of at most 120, 12 a row.

    window.__AGPH__ = {v, w, h, cols, sheets: [[file, n]],
                       at:  {license: [sheet, slot]},     photo tiles
                       lic: {MLS #: license},             every page read
                       nm:  {license: name on MLS},
                       nop: {license: day},               no photo then
                       miss:{MLS #: [tries, day, why]},   no usable box
                       ph:  [image hash, ...]}            stand-in pictures

Only the MLS photo is used. (Gravatar was tried, 20 Oct: 2 agents in 100
have one, and many of those are a pet, a flower or a logo.) A grey
"no photo" silhouette counts as no photo.
A license is checked again for a photo 30 days after it had none. A lead
whose page gave nothing usable is tried on 3 days. The page also uses lic to
put two cards of the same license together (one agent, two emails).
Photos are agents' public MLS photos: keep them on the private board, never
in git.
"""
import datetime, hashlib, html, io, json, math, os, re, sys, urllib.request
from concurrent.futures import ThreadPoolExecutor
from PIL import Image

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/129.0 Safari/537.36')
TW, TH, COLS, PER_SHEET = 96, 96, 12, 120
TRIES, NOP_DAYS = 3, 30
TODAY = datetime.date.today().isoformat()
END = b'name="LicenseNumber"'


def load_js(path):
    src = open(path, encoding='utf8').read()
    return json.loads(src[src.index('{'):src.rindex('}') + 1])


def load_index(path):
    ix = load_js(path) if os.path.exists(path) else {'v': 1, 'w': TW, 'h': TH, 'cols': COLS, 'sheets': [], 'at': {}}
    assert ix.get('w') == TW and ix.get('h') == TH and ix.get('cols') == COLS, 'tile size changed'
    for k, v in (('lic', {}), ('nm', {}), ('nop', {}), ('miss', {}), ('ph', [])):
        ix.setdefault(k, v)
    return ix


def candidates(mls):
    """The MLS page ids to try for one lead, or [] when it has no MLS page."""
    if re.match(r'^RF', mls) or re.match(r'^\d{9,}$', mls) or re.match(r'^\d{1,7}$', mls):
        return []
    if re.match(r'^\d{8}$', mls):
        return ['BE' + mls, 'EB' + mls, 'CC' + mls]
    return [mls] if re.match(r'^[A-Z]{1,6}\d{5,12}$', mls) else []


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', str(s or '').lower()).strip()


def digits(p):
    d = re.sub(r'\D', '', str(p or ''))
    if len(d) == 11 and d[0] == '1':
        d = d[1:]
    return d if len(d) == 10 else ''


def fetch(url, accept, cap, stop=None):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': accept})
    with urllib.request.urlopen(req, timeout=30) as r:
        buf, final = b'', r.geturl()
        while len(buf) < cap:
            c = r.read(65536)
            if not c:
                break
            buf += c
            if stop and stop in buf[-len(c) - len(stop):]:
                buf += r.read(4096)
                break
        return final, buf, r.headers.get('Content-Type', '')


def agent_box(buf):
    """name, brokerage, license, phone and photo url from the page's sidebar box."""
    s = buf.decode('utf8', 'replace')
    i = s.find('AgentContact Form : Sidebar')
    if i < 0:
        return None
    j = s.find('name="LicenseNumber"', i)
    seg = s[i:j + 200 if j > 0 else i + 12000]
    lic = re.search(r'License #:\s*([0-9]{6,9})', seg) or re.search(r'name="LicenseNumber"\s+type="hidden"\s+value="([0-9]{6,9})"', seg)
    if not lic:
        return None
    nm = re.search(r'aria-label="([^"]+?) \(Open in a New Window\)"', seg) or \
        re.search(r'<p class="mb-0 font-weight-bold[^"]*">\s*([^<]{2,80}?)\s*</p>', seg)
    ps = [html.unescape(re.sub(r'<[^>]+>', '', x)).strip() for x in re.findall(r'<p class="mb-0">(.*?)</p>', seg, re.S)]
    ps = [x for x in ps if x and not x.startswith('License') and not x.startswith('Phone')]
    ph = re.search(r'Phone:\s*([^<]{7,30})', seg)
    src = re.search(r'data-src="([^"]*)"[^>]*alt="Listing Agent Thumbnail"', seg)
    return {'lic': lic.group(1), 'name': html.unescape(nm.group(1)).strip() if nm else '',
            'office': ps[0] if ps else '', 'phone': ph.group(1).strip() if ph else '',
            'photo': html.unescape(src.group(1)).strip() if src else ''}


def same_agent(lead, box):
    a, b = norm(lead['agent']).split(), norm(box['name']).split()
    if a and b and (a[-1] == b[-1] or a[-1] in b or b[-1] in a):
        return True
    return bool(digits(lead['phone'])) and digits(lead['phone']) == digits(box['phone'])


def placeholder(t):
    """A flat, colourless picture: the grey "no photo" silhouette."""
    sat = t.convert('HSV').getchannel(1).resize((24, 24))
    hist = t.convert('L').resize((48, 48)).histogram()
    tot = float(sum(hist))
    ent = -sum(c / tot * math.log2(c / tot) for c in hist if c)
    return sum(sat.histogram()[i] * i for i in range(256)) / 576.0 < 3 and ent < 5.0


def tile(raw):
    im = Image.open(io.BytesIO(raw))
    im.load()
    im = im.convert('RGB')
    w, h = im.size
    if w < 40 or h < 40:
        return None
    side = min(w, h)
    x0 = (w - side) // 2
    y0 = int((h - side) * 0.2)          # a headshot: keep the top of a tall photo
    t = im.crop((x0, y0, x0 + side, y0 + side)).resize((TW, TH), Image.LANCZOS)
    return None if placeholder(t) else t


def one(leads):
    """An agent's listings, newest first: the first with a usable box wins.
    [(MLS #, why) for each one that gave nothing], then (MLS #, box, tile, hash) or None."""
    failed = []
    for lead in leads:
        r = one_lead(lead)
        if r[1] or r[4].startswith('network'):
            return failed, r
        failed.append((r[0], r[4]))
    return failed, None


def one_lead(lead):
    """(lead MLS #, box or None, tile or None, image hash, why)"""
    box, why = None, 'no MLS page'
    for pid in candidates(lead['mls']):
        try:
            final, buf, _ = fetch('https://www.mlslistings.com/Property/' + pid, 'text/html', 2500000, END)
        except Exception as e:
            return lead['mls'], None, None, '', 'network: ' + type(e).__name__
        if ('/property/' + pid.lower()) not in final.lower():
            continue
        box = agent_box(buf)
        why = 'no agent box on the page' if not box else ''
        if box:
            break
    if not box:
        return lead['mls'], None, None, '', why
    if not same_agent(lead, box):
        return lead['mls'], None, None, '', 'the MLS page names another agent: ' + box['name']
    if not box['photo'] or not box['photo'].startswith('https://') or 'default_agent_avatar' in box['photo']:
        return lead['mls'], box, None, '', ''
    try:
        _, raw, ct = fetch(box['photo'], 'image/*', 3000000)
        t = tile(raw) if ct.startswith('image/') else None
    except Exception:
        t = None
    if not t:
        return lead['mls'], box, None, '', ''
    return lead['mls'], box, t, hashlib.sha1(t.tobytes()).hexdigest()[:16], ''


def main():
    args = sys.argv[1:]
    data, out = load_js(args[0]), args[1]
    sample = int(args[args.index('--sample') + 1]) if '--sample' in args else 0
    workers = int(args[args.index('--workers') + 1]) if '--workers' in args else 6
    os.makedirs(os.path.join(out, 'agphotos'), exist_ok=True)
    ixp = os.path.join(out, 'agphotos', 'index.js')
    ix = load_index(ixp)
    cols = data['cols']
    leads = [dict(zip(cols, r)) for r in data['rows']]
    for l in leads:
        l['mls'] = str(l.get('mls') or '').upper()
        l['agent'] = '' if re.match(r'^(redfin|n/?a|none|unknown|tbd|listing agent|agent)$', str(l.get('agent') or '').strip(), re.I) else str(l.get('agent') or '')

    def keys(l):
        e, p, n = str(l.get('email') or '').strip().lower(), digits(l.get('phone')), norm(l['agent'])
        return [k for k in ('e:' + e if '@' in e else '', 'p:' + p + '|' + n if p and n else '', 'n:' + n if n and not p and '@' not in e else '') if k]

    def settled(l):
        lic = ix['lic'].get(l['mls'])
        if not lic:
            return False
        if lic in ix['at']:
            return True
        d = ix['nop'].get(lic)
        return bool(d) and (datetime.date.fromisoformat(TODAY) - datetime.date.fromisoformat(d)).days < NOP_DAYS

    # the agents: leads that share an email, or a phone and name, or a lone name
    buckets, where = [], {}
    for l in sorted(leads, key=lambda x: x.get('date') or '', reverse=True):
        ks = keys(l)
        if not ks:
            continue
        b = next((where[k] for k in ks if k in where), None)
        if b is None:
            b = len(buckets)
            buckets.append([])
        buckets[b].append(l)
        for k in ks:
            where.setdefault(k, b)
    todo = []
    for b in buckets:
        if any(settled(l) for l in b):
            continue
        try_ = [l for l in b if candidates(l['mls']) and not (ix['miss'].get(l['mls']) and
                (ix['miss'][l['mls']][0] >= TRIES or ix['miss'][l['mls']][1] == TODAY))][:3]
        if try_:
            todo.append(try_)
    if sample:
        todo = todo[:sample]
    print('agents to look up: %d' % len(todo), flush=True)

    got, n = [], 0
    with ThreadPoolExecutor(workers) as ex:
        for failed, res in ex.map(one, todo):
            n += 1
            for mls, why in failed:
                tries = (ix['miss'].get(mls) or [0])[0] + 1
                ix['miss'][mls] = [tries, TODAY, why[:120]]
            if not res:
                continue
            mls, box, t, hsh, why = res
            if box:
                ix['lic'][mls] = box['lic']
                if box['name']:
                    ix['nm'][box['lic']] = box['name'][:60]
                ix['miss'].pop(mls, None)
                if t is not None and hsh not in ix['ph']:
                    got.append((box['lic'], t, hsh))
                elif box['lic'] not in ix['at']:
                    ix['nop'][box['lic']] = TODAY
            if n % 50 == 0:
                print('  %d / %d read, %d photos' % (n, len(todo), len(got)), flush=True)

    # the same picture for three or more licenses is a stand-in, not a person
    seen = {}
    for lic, t, h in got:
        seen.setdefault(h, set()).add(lic)
    stand = {h for h, s in seen.items() if len(s) >= 3}
    ix['ph'] = sorted(set(ix['ph']) | stand)
    fresh, done = [], set()
    for lic, t, h in got:
        if h in stand or lic in done:
            if h in stand:
                ix['nop'][lic] = TODAY
            continue
        done.add(lic)
        fresh.append((lic, t))
        ix['nop'].pop(lic, None)

    new_files = []
    for k in range(0, len(fresh), PER_SHEET):
        part = fresh[k:k + PER_SHEET]
        base = 'a' + TODAY
        name, i = base + '.jpg', 1
        names = {s[0] for s in ix['sheets']}
        while name in names or os.path.exists(os.path.join(out, 'agphotos', name)):
            i += 1
            name = '%s-%d.jpg' % (base, i)
        rows = (len(part) + COLS - 1) // COLS
        sheet = Image.new('RGB', (COLS * TW, rows * TH), (32, 40, 52))
        for slot, (lic, t) in enumerate(part):
            sheet.paste(t, ((slot % COLS) * TW, (slot // COLS) * TH))
        sheet.save(os.path.join(out, 'agphotos', name), 'JPEG', quality=84, optimize=True, progressive=True)
        ix['sheets'].append([name, len(part)])
        si = len(ix['sheets']) - 1
        for slot, (lic, t) in enumerate(part):
            ix['at'][lic] = [si, slot]
        new_files.append('agphotos/' + name)

    with open(ixp, 'w', encoding='utf8') as f:
        f.write('window.__AGPH__ = ' + json.dumps(ix, ensure_ascii=False, separators=(',', ':')) + ';\n')
    lics = set(ix['lic'].values())
    print('agents looked up %d · %d licenses known · %d with a photo (%d new) · %d leads with no usable box'
          % (n, len(lics), len(ix['at']), len(fresh), len(ix['miss'])))
    print('NEW FILES: ' + ' '.join(['agphotos/index.js'] + new_files))


if __name__ == '__main__':
    main()
