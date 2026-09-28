"""
Suite visual-art-check: no PNG under overrides/ may be EPCA or Spore art, or derived from it.

1. Policy. A PNG under overrides/kubejs/assets/epca/** or overrides/kubejs/assets/spore/** must be listed in
   tools/visual/original_art.json with its author and how it was made (original work only). Today the list is empty:
   clade variants are generated locally by tools/visual/etf_variants_local.py and never enter the repository.
2. Evidence. When the instance's EPCA and Spore jars are present (PNE_INSTANCE, as set by tools/run_tests.py), every
   PNG under overrides/ is compared with every texture in those jars of the same size. Identical bytes, identical
   pixels, or a derived image (alpha mask at least 95% identical and a luminance or HSV-value correlation of at least
   0.80 on the pixels opaque in both, which is what a recolour such as etf_variants_local.derive leaves: hue shifts and
   desaturation keep the value order) fails the suite.
3. Self-test. The detector must flag a clade variant made by etf_variants_local.derive (from a real jar texture when
   one is available, else from a synthetic texture) and must not flag an unrelated image, so the check has teeth.
Prints PASS on success. Standard library only (tools/visual/pnglite.py decodes the PNGs).
"""
import glob
import hashlib
import json
import os
import struct
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
OVR = os.path.join(REPO, "overrides")
sys.path.insert(0, HERE)
import pnglite  # noqa: E402
import etf_variants_local as etf  # noqa: E402

ALPHA_SAME = 0.95
LUMA_CORR = 0.80
PROTECTED = ("kubejs/assets/epca/", "kubejs/assets/spore/")


def png_size(data):
    if data[:8] != pnglite.SIGNATURE or len(data) < 24:
        return None
    return struct.unpack(">II", data[16:24])


def luma(img):
    px = img.rgba
    return [0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] for i in range(0, len(px), 4)]


def value(img):
    """HSV value (max channel): unchanged in order by hue shifts and desaturation."""
    px = img.rgba
    return [max(px[i], px[i + 1], px[i + 2]) for i in range(0, len(px), 4)]


def _corr(xs, ys):
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return 1.0 if sxx == syy else 0.0
    return sxy / (sxx * syy) ** 0.5


def derived(a, b):
    """True when image a looks like image b or a recolour of it (same size required)."""
    if (a.width, a.height) != (b.width, b.height):
        return False
    if a.rgba == b.rgba:
        return True
    aa, ab = a.alpha_bytes(), b.alpha_bytes()
    n = len(aa)
    same_mask = sum(1 for i in range(n) if (aa[i] > 0) == (ab[i] > 0)) / float(n)
    if same_mask < ALPHA_SAME:
        return False
    idx = [i for i in range(n) if aa[i] > 0 and ab[i] > 0]
    if len(idx) < 4:
        return len(idx) == 0 and sum(aa) == 0
    best = 0.0
    for fn in (luma, value):
        va, vb = fn(a), fn(b)
        best = max(best, _corr([va[i] for i in idx], [vb[i] for i in idx]))
    return best >= LUMA_CORR


def synthetic(w, h, seed):
    img = pnglite.Image(w, h)
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            img.rgba[i:i + 4] = bytes(((x * 37 + seed * 11) % 256, (y * 53 + seed) % 256, (x * y * 7) % 256,
                                       0 if (x * 3 + y + seed) % 5 == 0 else 255))
    return img


def mod_jars():
    inst = os.environ.get("PNE_INSTANCE") or ""
    if not inst:
        return []
    out = []
    for jar in sorted(glob.glob(os.path.join(inst, "mods", "*.jar"))):
        try:
            with zipfile.ZipFile(jar) as z:
                names = z.namelist()
        except (zipfile.BadZipFile, OSError):
            continue
        if any(n.startswith("assets/epca/textures/") for n in names) or any(n.startswith("assets/spore/textures/") for n in names):
            out.append(jar)
    return out


def main():
    fails = []
    checks = 0
    pngs = sorted(glob.glob(os.path.join(OVR, "**", "*.png"), recursive=True))
    rels = [os.path.relpath(p, OVR).replace(os.sep, "/") for p in pngs]
    try:
        allow = json.load(open(os.path.join(HERE, "original_art.json"), encoding="utf-8")).get("files", [])
    except (OSError, ValueError) as e:
        print("FAIL cannot read tools/visual/original_art.json: %s" % e)
        return 1
    allowed = {}
    for entry in allow:
        checks += 1
        if not (isinstance(entry, dict) and entry.get("path") and entry.get("author") and entry.get("method")):
            fails.append("original_art.json entry needs path, author and method: %r" % (entry,))
            continue
        allowed[entry["path"]] = entry
        if entry["path"] not in rels:
            fails.append("original_art.json lists a file that does not exist: " + entry["path"])

    # 1. policy
    for rel in rels:
        checks += 1
        if rel.startswith(PROTECTED) and rel not in allowed:
            fails.append("PNG under an EPCA/Spore asset folder that is not declared original art: overrides/" + rel)

    # 2. evidence against the user's own jars (when present)
    jars = mod_jars()
    index = {}
    if jars and pngs:
        for jar in jars:
            with zipfile.ZipFile(jar) as z:
                for n in z.namelist():
                    if n.endswith(".png") and (n.startswith("assets/epca/") or n.startswith("assets/spore/")):
                        data = z.read(n)
                        sz = png_size(data)
                        if sz:
                            index.setdefault(sz, []).append((os.path.basename(jar) + "!" + n, data))
    for p, rel in zip(pngs, rels):
        data = open(p, "rb").read()
        sha = hashlib.sha256(data).hexdigest()
        sz = png_size(data)
        checks += 1
        if sz is None:
            fails.append("not a PNG: overrides/" + rel)
            continue
        if not jars:
            continue
        try:
            img = pnglite.read_png(data)
        except pnglite.PngError as e:
            fails.append("unreadable PNG overrides/%s: %s" % (rel, e))
            continue
        for name, jdata in index.get(sz, []):
            if hashlib.sha256(jdata).hexdigest() == sha:
                fails.append("overrides/%s is a byte copy of %s" % (rel, name))
                break
            try:
                if derived(img, pnglite.read_png(jdata)):
                    fails.append("overrides/%s looks derived from %s (same alpha mask, correlated luminance)" % (rel, name))
                    break
            except pnglite.PngError:
                continue

    # 3. self-test: the detector must catch a recolour and pass an unrelated image
    base = None
    source = "synthetic"
    for jar in jars:
        with zipfile.ZipFile(jar) as z:
            for n in sorted(z.namelist()):
                if n.startswith("assets/epca/textures/entity/") and n.endswith(".png"):
                    try:
                        cand = pnglite.read_png(z.read(n))
                    except pnglite.PngError:
                        continue
                    if cand.width * cand.height <= 64 * 64 and sum(1 for a in cand.alpha_bytes() if a) > 64:
                        base, source = cand, os.path.basename(jar) + "!" + n
                        break
        if base is not None:
            break
    if base is None:
        base = synthetic(32, 32, 1)
    for clade in range(len(etf.CLADES)):
        checks += 1
        if not derived(etf.derive(base, clade, "selftest"), base):
            fails.append("self-test: the detector missed clade %d of %s" % (clade, source))
    checks += 1
    other = synthetic(base.width, base.height, 99)
    if derived(other, base) and other.rgba != base.rgba:
        fails.append("self-test: an unrelated image was flagged as derived from " + source)

    for f in fails:
        print("  FAIL  " + f)
    if fails:
        print("FAIL %d of %d visual-art-check checks" % (len(fails), checks))
        return 1
    print("PASS visual-art-check: %d PNG(s) under overrides/, %d declared original, %s; self-test on %s" % (
        len(pngs), len(allowed), ("compared with %d jar(s)" % len(jars)) if jars else "jars not present (policy check only)", source))
    return 0


if __name__ == "__main__":
    sys.exit(main())
