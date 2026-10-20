#!/usr/bin/env python3
"""Record the asset ids of uploaded zoomed photos in a board's index.

    python3 -I zoom_ids.py <thumbs/index.js> <ids.txt> [--zoom DIR [--delete]] [--key cs]

--key cs records listing.py's photo sheets in `cs` instead of the zoomed
photos in `z` (DIR is then the sheets folder); everything else is the same.

ids.txt holds one uploaded photo per line: its MLS # (or <MLS #>.jpg), the
32-character asset id the upload returned (or its /_blob/<id> url) and,
last, the byte count the upload reported. With --zoom DIR that count must
match DIR/<MLS #>.jpg, so a line copied against the wrong file is refused;
--delete then removes the recorded files, leaving only what still needs
uploading. Only leads that have a tile are recorded.
"""
import json, os, re, sys

ID = re.compile(r'(?:/_blob/)?\b([0-9a-f]{32})\b')
MLS = re.compile(r'\b([A-Z]{1,6}\d{5,12}|\d{8})(?:\.jpg)?\b')


def main():
    args = sys.argv[1:]
    ixp, idsp = args[0], args[1]
    zdir = args[args.index('--zoom') + 1] if '--zoom' in args else None
    key = args[args.index('--key') + 1] if '--key' in args else 'z'
    assert key in ('z', 'cs'), 'the key is z or cs'
    mkey = 'zmiss' if key == 'z' else 'csmiss'
    src = open(ixp, encoding='utf8').read()
    ix = json.loads(src[src.index('{'):src.rindex('}') + 1])
    ix.setdefault(key, {})
    ix.setdefault(mkey, {})
    added, skipped = 0, []
    for line in open(idsp, encoding='utf8'):
        i, m = ID.search(line), MLS.search(line.replace(ID.search(line).group(0), ' ') if ID.search(line) else line)
        if not i or not m:
            if line.strip():
                skipped.append(line.strip()[:80])
            continue
        mls, aid = m.group(1).upper(), i.group(1)
        # "<MLS> <id> <bytes>": the size the upload reported must be the file's
        sz = re.search(r'\b(\d+)(?: bytes)?\s*$', line.replace(i.group(0), ' ').replace(m.group(0), ' ').strip())
        local = os.path.join(zdir, mls + '.jpg') if zdir else ''
        if sz and local and os.path.exists(local) and os.path.getsize(local) != int(sz.group(1)):
            skipped.append('%s: upload reported %s bytes, the file has %d' % (mls, sz.group(1), os.path.getsize(local)))
            continue
        if key == 'z' and mls not in ix['at']:
            skipped.append('%s has no tile' % mls)
            continue
        if ix[key].get(mls) != aid:
            added += 1
        ix[key][mls] = aid
        ix[mkey].pop(mls, None)
        if zdir and '--delete' in args and os.path.exists(os.path.join(zdir, mls + '.jpg')):
            os.remove(os.path.join(zdir, mls + '.jpg'))
    dup = {}
    for m, a in ix[key].items():
        dup.setdefault(a, []).append(m)
    dups = [v for v in dup.values() if len(v) > 1]
    assert not dups, 'one asset id recorded for several leads: %s' % dups[:5]
    with open(ixp, 'w', encoding='utf8') as f:
        f.write('window.__THUMBS__ = ' + json.dumps(ix, separators=(',', ':')) + ';\n')
    left = len([f for f in os.listdir(zdir) if f.endswith('.jpg')]) if zdir else 0
    print('%s recorded: %d new, %d in all%s' % ('zoomed photos' if key == 'z' else 'photo sheets', added, len(ix[key]),
                                              (' · %d files still to upload' % left) if zdir else ''))
    for s in skipped:
        print('  not recorded: ' + s)


if __name__ == '__main__':
    main()
