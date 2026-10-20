#!/usr/bin/env python3
"""What evidence does the scan actually have when it calls a house a deal?

Reads the Leads tab straight out of the workbook (no openpyxl on this box) and
asks one question per lead: is there anything in its own Why text that says the
CONDITION was looked at — or did it reach bucket A/B on something else?
"""
import zipfile, re, sys
import xml.etree.ElementTree as ET
from collections import Counter

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
PATH = sys.argv[1] if len(sys.argv) > 1 else 'sheet-now.xlsx'

z = zipfile.ZipFile(PATH)

# shared strings
shared = []
if 'xl/sharedStrings.xml' in z.namelist():
    root = ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in root.findall(NS + 'si'):
        shared.append(''.join(t.text or '' for t in si.iter(NS + 't')))

# find the Leads sheet
wb = ET.fromstring(z.read('xl/workbook.xml'))
rels = ET.fromstring(z.read('xl/_rels/workbook.xml.rels'))
rid = {r.get('Id'): r.get('Target') for r in rels}
target = None
for sh in wb.iter(NS + 'sheet'):
    if sh.get('name') == 'Leads':
        rel = sh.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
        target = rid[rel]
if not target:
    sys.exit('no Leads tab')
if not target.startswith('xl/'):
    target = 'xl/' + target.lstrip('/')

def colnum(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
        else:
            break
    return n - 1

rows = []
sheet = ET.fromstring(z.read(target))
for r in sheet.iter(NS + 'row'):
    cells = {}
    for c in r.findall(NS + 'c'):
        v = c.find(NS + 'v')
        t = c.get('t')
        if t == 'inlineStr':
            isn = c.find(NS + 'is')
            val = ''.join(x.text or '' for x in isn.iter(NS + 't')) if isn is not None else ''
        elif v is None:
            val = ''
        elif t == 's':
            val = shared[int(v.text)]
        else:
            val = v.text or ''
        cells[colnum(c.get('r'))] = val
    if cells:
        width = max(cells) + 1
        rows.append([cells.get(i, '') for i in range(width)])

head = [h.strip() for h in rows[0]]
ix = {h: i for i, h in enumerate(head) if h}
def g(row, name):
    i = ix.get(name)
    return (row[i] if i is not None and i < len(row) else '').strip()

leads = [r for r in rows[1:] if g(r, 'MLS #')]
print('Leads tab: %d rows, %d columns' % (len(leads), len(head)))

CLOSED = re.compile(r'sold|withdrawn|expired|cancel|off.?market|closed|duplicate', re.I)
PENDING = re.compile(r'pending|contingent|under contract', re.I)

# Words that mean somebody/something actually judged the CONDITION of the house.
COND = re.compile(
    r'fixer|as[- ]is|tlc|handyman|contractor|rehab|needs? (?:work|updating|repair|tlc|love)|'
    r'dated|outdated|original condition|deferred|distress|probate|estate sale|bank owned|reo|'
    r'foreclos|short sale|teardown|tear down|gut|damage|cosmetic|potential|opportunity to|'
    r'bring your|customize|sweat equity|not habitable|uninhabitable|roof|foundation',
    re.I)
SKIPPED = re.compile(r'no \$/sqft or photo check|photo check off|judged by eye|scored on refresh', re.I)

live = [r for r in leads if not CLOSED.search(g(r, 'MLS Status'))]
ab = [r for r in live if g(r, 'Bucket')[:1] in ('A', 'B')]
print('live (not sold/withdrawn): %d   of those bucket A/B: %d' % (len(live), len(ab)))

skipped, nocond, reasons = [], [], Counter()
for r in ab:
    why = g(r, 'Why')
    notes = g(r, 'Notes') + ' ' + g(r, 'Private Remarks')
    if SKIPPED.search(why):
        skipped.append(r)
        m = SKIPPED.search(why)
        reasons[m.group(0).lower()] += 1
    if not COND.search(why) and not COND.search(notes):
        nocond.append(r)

print()
print('=== A/B leads where the scan SKIPPED a check (its own words) ===')
print('%d of %d  (%.0f%%)' % (len(skipped), len(ab), 100.0 * len(skipped) / max(1, len(ab))))
for k, v in reasons.most_common():
    print('   %-45s %d' % (k, v))

print()
print('=== A/B leads with NO condition evidence anywhere ===')
print('%d of %d  (%.0f%%)' % (len(nocond), len(ab), 100.0 * len(nocond) / max(1, len(ab))))
why_only = Counter(g(r, 'Why').strip().lower()[:60] for r in nocond)
print('   what the scan said instead, most common:')
for k, v in why_only.most_common(12):
    print('     %-62s %d' % (k or '(blank)', v))

print()
print('=== the worst of them: top score, no condition evidence, dear per sqft ===')
def num(x):
    try:
        return float(re.sub(r'[^0-9.]', '', x) or 0)
    except Exception:
        return 0.0
worst = sorted(nocond, key=lambda r: (-num(g(r, 'Opportunity Score')), -num(g(r, '$/SqFt'))))[:12]
print('%-11s %-42s %-6s %-5s %-9s %-6s %s' % ('MLS', 'Address', 'Bucket', 'Score', '$/SqFt', 'Built', 'Why'))
for r in worst:
    print('%-11s %-42s %-6s %-5s %-9s %-6s %s' % (
        g(r, 'MLS #'), g(r, 'Address')[:42], g(r, 'Bucket')[:1], g(r, 'Opportunity Score'),
        g(r, '$/SqFt'), g(r, 'Year Built'), (g(r, 'Why') or '(blank)')[:46]))

print()
print('=== how often "vacant" alone is the whole case ===')
vac = [r for r in ab if re.fullmatch(r'\s*vacant\s*', g(r, 'Why'), re.I)]
print('%d A/B leads whose entire Why is the single word "vacant"' % len(vac))
for r in vac[:6]:
    print('   %-11s %-40s %s bucket, score %s, $%s/sqft' % (
        g(r, 'MLS #'), g(r, 'Address')[:40], g(r, 'Bucket')[:1],
        g(r, 'Opportunity Score'), g(r, '$/SqFt')))
