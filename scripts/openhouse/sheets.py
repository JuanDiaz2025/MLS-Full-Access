"""Download every listing photo and tile them into numbered contact sheets.

    python3 -I sheets.py <out_dir> <MLS #> [<MLS #> ...]

Writes <out_dir>/<MLS>_1.jpg, _2.jpg ... (12 photos each, numbered by their
place in the gallery). Look at EVERY sheet before giving a verdict.
"""
import io, os, re, subprocess, sys
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw, ImageFont

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0"


def get(u):
    return subprocess.run(["curl", "-sSL", "--max-time", "40", "-A", UA, u], capture_output=True).stdout


def photo_urls(h):
    # MLSListings' own listings, numbered 1..n
    m = re.search(r"(https://media\.mlslmedia\.com/property/MLSL/[^\"'\s]+?/2/)\d+", h)
    if m:
        ns = sorted(set(re.findall(re.escape(m.group(1)) + r"(\d+)", h)), key=int)
        return [m.group(1) + n for n in ns]
    # SF (sfarmedia.rapmls.com) and East Bay (zimg.paragon.ice.com): gallery order on the page
    seen = []
    for u in re.findall(r"https?://[^\"'()\s]+?\.(?:jpe?g)", h, re.I):
        if "mlslpub-cdn" not in u and "cordless" not in u and u not in seen:
            seen.append(u)
    return seen


def main(out, mlss):
    os.makedirs(out, exist_ok=True)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 28)
    except OSError:
        font = ImageFont.load_default()
    for mls in mlss:
        urls = photo_urls(get("https://www.mlslistings.com/Property/" + mls).decode("utf-8", "ignore"))
        with ThreadPoolExecutor(8) as ex:
            blobs = list(ex.map(get, urls))
        tiles = []
        for n, b in enumerate(blobs, 1):
            try:
                im = Image.open(io.BytesIO(b)).convert("RGB")
                im.thumbnail((480, 360))
                tiles.append((n, im))
            except Exception:
                pass
        for s in range(0, len(tiles), 12):
            sheet = Image.new("RGB", (1920, 1080), (20, 20, 20))
            d = ImageDraw.Draw(sheet)
            for i, (n, im) in enumerate(tiles[s:s + 12]):
                x, y = (i % 4) * 480, (i // 4) * 360
                sheet.paste(im, (x + (480 - im.width) // 2, y + (360 - im.height) // 2))
                d.rectangle([x, y, x + 70, y + 38], fill=(0, 0, 0))
                d.text((x + 6, y + 4), str(n), fill=(255, 220, 0), font=font)
            sheet.save(f"{out}/{mls}_{s // 12 + 1}.jpg", quality=80)
        print(mls, len(urls), "photos,", (len(tiles) + 11) // 12, "sheets")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2:])
