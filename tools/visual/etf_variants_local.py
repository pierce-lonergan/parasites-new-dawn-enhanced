"""
Local-only ETF clade variants for The Hive Remembers (Entity Texture Features 7.2.4).

EPCA's and Spore's art is all rights reserved, so the repository ships no textures of theirs and no ETF properties
that would point at missing files. At install time this tool reads the entity textures from YOUR OWN EPCA and Spore
jars and writes, for each texture, four clade variants plus an ETF properties file keyed on the scoreboard teams
that pne_visual.js maintains, into YOUR instance only (<ns> = epca and spore):

    <instance>/kubejs/assets/<ns>/optifine/random/entity/<name>.properties
    <instance>/kubejs/assets/<ns>/optifine/random/entity/<name>2.png ... <name>5.png   (clades 0..3)

Spore uses vanilla entity renderers, where ETF applies natively; EPCA uses GeckoLib, where ETF is supported by code
path analysis and needs the in-game check.

KubeJS serves kubejs/assets as a resource pack; ETF's OPTIFINE directory maps textures/entity/x.png to
optifine/random/entity/x.png, and variant N of x.png is x<N>.png (or x.<N>.png when the name already ends in a
digit, ETFUtils2.addVariantNumberSuffix). Rules use "teams.N" / "skins.N" (TeamProperty reads the property ids
"teams" and "team" with the rule-number suffix, RandomProperty.readPropertiesOrThrow "<id>.<N>"; the team
property is not spawn-locked, so a mob that joins its clade team after it first rendered still switches).

Photosensitivity: the variants are static. No emissive (_e) layers, no blink textures, no .mcmeta animation.
Each clade keeps every pixel's alpha and shifts hue by at most 25 degrees (TDD 3.5 shader rule), plus a faint
deterministic vein pattern, so clades stay readable without any flashing.

Usage:
    python tools/visual/etf_variants_local.py --instance "<instance>"            generate (EPCA and Spore)
    python tools/visual/etf_variants_local.py --instance "<instance>" --list     show what would be generated
    python tools/visual/etf_variants_local.py --instance "<instance>" --clean    remove exactly what it generated
Options:
    --namespace NS    all (default: epca and spore, each from its own jar), epca or spore
    --jar PATH        the mod jar to read (default: the jar in <instance>/mods holding assets/<ns>/textures/entity/);
                      needs a single --namespace
    --out DIR         output folder; must be inside the instance or the system temp folder, never the repository;
                      needs a single --namespace
    --force           overwrite files this tool did not create
    --max-pixels N    skip textures larger than N pixels (default 1048576)
Exit codes: 0 done (a namespace whose jar is missing is skipped with a note), 2 refused (unsafe output path, or
--jar/--out without a single namespace), 3 no jar found for any namespace.
The files it writes are listed in pne_etf_variants.json next to them (one per namespace folder); --clean deletes only
those.
"""
import argparse
import colorsys
import glob
import hashlib
import json
import os
import re
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pnglite  # noqa: E402

VERSION = 1
MANIFEST = "pne_etf_variants.json"
TEAMS = [("pne_clade_%d" % c, "pne_clade_%d_named" % c) for c in range(4)]
# Per clade: hue shift (degrees, |dh| <= 25), saturation multiply/add, value multiply/add.
CLADES = [
    {"name": "ashen", "dh": 0.0, "s_mul": 0.45, "s_add": 0.0, "v_mul": 0.90, "v_add": 0.06},
    {"name": "rust", "dh": -18.0, "s_mul": 1.15, "s_add": 0.05, "v_mul": 0.92, "v_add": 0.0},
    {"name": "bile", "dh": 25.0, "s_mul": 1.10, "s_add": 0.0, "v_mul": 0.95, "v_add": 0.0},
    {"name": "abyssal", "dh": 12.0, "s_mul": 0.80, "s_add": 0.0, "v_mul": 0.70, "v_add": 0.0},
]
MAX_HUE_SHIFT = 25.0
SAT_CAP = 0.9
VEIN_CELL = 6
VEIN_BAND = 0.035
VEIN_DARKEN = 0.82
NAMESPACES = ("epca", "spore")
# Overlay and effect layers that should keep their original look, and non-mob textures.
SKIP_PARTS = ("_glow", "_afterimage", "_blink", "_e.png")
SKIP_NAMES = {
    "epca": {"acid_bullet", "bone_arrow", "slime_projectile"},
    # Spore: projectiles, props and blank helpers carry no team, so a variant would never be picked.
    "spore": {"blank", "empty", "noise", "chains", "syringe", "syringe_gun_juice", "tumor_bomb", "santa_hat",
              "proto_christmas_hat"},
}
# Spore layers kept as they are: the glowing eye layers (eyes/, rendered full-bright, so they stay readable in the
# dark exactly as the mod made them), light overlays and pulsing layers; projectile folders and "...round" shells.
SKIP_DIRS = {"epca": (), "spore": ("eyes/", "bomb/", "hindie_light/", "howitzer_lights/")}
SKIP_RX = {"epca": None, "spore": re.compile(r"(_light|_lights|pulsation)(_|\.png$)|round\.png$")}


class Refused(Exception):
    pass


# ---------------------------------------------------------------------------------------------
# Paths and safety

def _real(p):
    return os.path.normcase(os.path.realpath(os.path.abspath(p)))


def _inside(child, parent):
    c, p = _real(child), _real(parent)
    try:
        return os.path.commonpath([c, p]) == p
    except ValueError:
        return False


def check_output(out, instance):
    """The output may be inside the instance or the system temp folder, and never inside this repository."""
    if _inside(out, REPO):
        raise Refused("refusing to write into the repository (%s); files derived from closed-source mods stay local" % out)
    ok = _inside(out, tempfile.gettempdir()) or (instance and _inside(out, instance))
    if not ok:
        raise Refused("refusing to write outside the instance and the temp folder: %s" % out)


def find_jar(instance, ns):
    prefix = "assets/%s/textures/entity/" % ns
    for jar in sorted(glob.glob(os.path.join(instance, "mods", "*.jar"))):
        try:
            with zipfile.ZipFile(jar) as z:
                if any(n.startswith(prefix) and n.endswith(".png") for n in z.namelist()):
                    return jar
        except (zipfile.BadZipFile, OSError):
            continue
    return None


# ---------------------------------------------------------------------------------------------
# Naming (ETF 7.2.4 rules)

def variant_rel(ns, rel, n):
    """rel = path under textures/entity/ (e.g. 'ripper.png'). Returns the variant's path under the same
    folder, following ETFUtils2.addVariantNumberSuffix on the full id '<ns>:textures/entity/<rel>'."""
    full = "%s:textures/entity/%s" % (ns, rel)
    if n < 2:
        return rel
    if re.fullmatch(r"\D+\d+\.png", full):
        return rel[:-4] + ".%d.png" % n
    return rel[:-4] + "%d.png" % n


def properties_text(ns, rel, variants):
    """ETF properties for one texture: rule k (1..4) sends clade k-1 to variant file index k+1; rule 5 is
    the default (the original texture)."""
    lines = [
        "# Generated locally by tools/visual/etf_variants_local.py from your own %s jar. Never shipped." % ns,
        "# The Hive Remembers clade variants: scoreboard teams pne_clade_0..3 and pne_clade_<c>_named.",
        "# Static textures only: no emissive layer, no blink, no animation.",
    ]
    for k, (team, named) in enumerate(TEAMS, start=1):
        lines.append("skins.%d=%d" % (k, k + 1))
        lines.append("teams.%d=%s %s" % (k, team, named))
    lines.append("skins.%d=1" % (len(TEAMS) + 1))
    return "\n".join(lines) + "\n"


def parse_properties(text):
    """Tiny java.util.Properties reader (key=value lines, # comments), enough for our own files."""
    out = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("!"):
            continue
        m = re.match(r"([^=:\s]+)\s*[=:]\s*(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out


# ---------------------------------------------------------------------------------------------
# The clade transform (deterministic, pure Python)

def _seed(name, clade):
    return int.from_bytes(hashlib.sha256(("pne_clade|%s|%d" % (name, clade)).encode("utf-8")).digest()[:8], "big")


def _lattice(seed, gx, gy):
    h = hashlib.blake2b(b"%d|%d|%d" % (seed, gx, gy), digest_size=4).digest()
    return int.from_bytes(h, "big") / 4294967295.0


def _noise_field(w, h, seed):
    """Bilinear value noise on a VEIN_CELL grid, returned as a list of floats (row-major)."""
    gw, gh = w // VEIN_CELL + 2, h // VEIN_CELL + 2
    grid = [[_lattice(seed, gx, gy) for gx in range(gw)] for gy in range(gh)]
    out = [0.0] * (w * h)
    for y in range(h):
        fy = y / VEIN_CELL
        y0 = int(fy)
        ty = fy - y0
        ty = ty * ty * (3 - 2 * ty)
        r0, r1 = grid[y0], grid[y0 + 1]
        for x in range(w):
            fx = x / VEIN_CELL
            x0 = int(fx)
            tx = fx - x0
            tx = tx * tx * (3 - 2 * tx)
            a = r0[x0] + (r0[x0 + 1] - r0[x0]) * tx
            b = r1[x0] + (r1[x0 + 1] - r1[x0]) * tx
            out[y * w + x] = a + (b - a) * ty
    return out


def derive(img, clade, name):
    """Returns a new RGBA image: the clade's colour grade of img. Alpha is copied unchanged."""
    p = CLADES[clade]
    w, h = img.width, img.height
    src = img.rgba
    dst = bytearray(src)
    field = _noise_field(w, h, _seed(name, clade))
    dh = p["dh"] / 360.0
    for i in range(w * h):
        o = i * 4
        a = src[o + 3]
        if a == 0:
            continue
        hh, ss, vv = colorsys.rgb_to_hsv(src[o] / 255.0, src[o + 1] / 255.0, src[o + 2] / 255.0)
        hh = (hh + dh) % 1.0
        ss = min(SAT_CAP, max(0.0, ss * p["s_mul"] + (p["s_add"] if ss > 0.02 else 0.0)))
        vv = min(1.0, max(0.0, vv * p["v_mul"] + p["v_add"]))
        if abs(field[i] - 0.5) < VEIN_BAND:
            vv *= VEIN_DARKEN
        r, g, b = colorsys.hsv_to_rgb(hh, ss, vv)
        dst[o] = int(round(r * 255))
        dst[o + 1] = int(round(g * 255))
        dst[o + 2] = int(round(b * 255))
    return pnglite.Image(w, h, dst)


# ---------------------------------------------------------------------------------------------
# Generation

def list_textures(z, ns, max_pixels):
    """(rel, reason) pairs: reason '' for textures to process, otherwise why one is skipped."""
    prefix = "assets/%s/textures/entity/" % ns
    names = sorted(n for n in z.namelist() if n.startswith(prefix) and n.endswith(".png"))
    rels = [n[len(prefix):] for n in names]
    have = set(rels)
    out = []
    rx = SKIP_RX.get(ns)
    for rel in rels:
        base = os.path.basename(rel)
        stem = base[:-4]
        reason = ""
        if any(part in base for part in SKIP_PARTS):
            reason = "effect or overlay layer"
        elif any(rel.startswith(d) for d in SKIP_DIRS.get(ns, ())):
            reason = "effect, overlay or projectile folder (kept as is)"
        elif rx is not None and rx.search(base):
            reason = "light, pulse or projectile layer (kept as is)"
        elif stem in SKIP_NAMES.get(ns, set()):
            reason = "not a mob texture"
        elif any(variant_rel(ns, rel, n) in have for n in range(2, 2 + len(TEAMS))):
            reason = "a variant name would collide with another texture"
        else:
            try:
                data = z.read(prefix + rel)
                w, hgt = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
                if w * hgt > max_pixels:
                    reason = "larger than --max-pixels"
            except Exception as e:  # noqa: BLE001
                reason = "unreadable (%s)" % e
        out.append((rel, reason))
    return out


def load_manifest(out_dir):
    path = os.path.join(out_dir, MANIFEST)
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".pne_tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def clean(out_dir):
    """Deletes the files listed in the manifest (and only those), then the manifest. Returns the count."""
    man = load_manifest(out_dir)
    n = 0
    dirs = set()
    for rel in man.get("files", []):
        p = os.path.normpath(os.path.join(out_dir, rel))
        if not _inside(p, out_dir):
            continue
        if os.path.isfile(p):
            os.remove(p)
            n += 1
        d = os.path.dirname(p)
        while _inside(d, out_dir) and _real(d) != _real(out_dir):
            dirs.add(d)
            d = os.path.dirname(d)
    mp = os.path.join(out_dir, MANIFEST)
    if os.path.isfile(mp):
        os.remove(mp)
    # Subfolders this tool filled are removed once empty (deepest first); anything else stays.
    for d in sorted(dirs, key=len, reverse=True):
        try:
            if os.path.isdir(d) and not os.listdir(d):
                os.rmdir(d)
        except OSError:
            pass
    return n


def generate(jar, out_dir, ns="epca", force=False, max_pixels=1 << 20, log=print):
    """Writes variants and properties for every eligible texture. Returns the manifest dict."""
    with open(jar, "rb") as f:
        jar_sha = hashlib.sha256(f.read()).hexdigest()
    old = load_manifest(out_dir)
    ours = set(old.get("files", []))
    written = []
    skipped = []
    prefix = "assets/%s/textures/entity/" % ns
    with zipfile.ZipFile(jar) as z:
        items = list_textures(z, ns, max_pixels)
        for rel, reason in items:
            if reason:
                skipped.append({"texture": rel, "reason": reason})
                continue
            targets = [variant_rel(ns, rel, k + 2) for k in range(len(TEAMS))] + [rel[:-4] + ".properties"]
            foreign = [t for t in targets if os.path.exists(os.path.join(out_dir, t)) and t not in ours]
            if foreign and not force:
                skipped.append({"texture": rel, "reason": "files not made by this tool exist: " + ", ".join(foreign)})
                continue
            img = pnglite.read_png(z.read(prefix + rel))
            stem = rel[:-4]
            for k in range(len(TEAMS)):
                _write(os.path.join(out_dir, targets[k]), pnglite.write_png(derive(img, k, stem)))
            _write(os.path.join(out_dir, targets[-1]), properties_text(ns, rel, targets[:-1]).encode("utf-8"))
            written.extend(targets)
    # Files from an earlier run that this run did not produce are stale: remove them.
    stale = sorted(ours - set(written))
    for rel in stale:
        p = os.path.normpath(os.path.join(out_dir, rel))
        if _inside(p, out_dir) and os.path.isfile(p):
            os.remove(p)
    man = {
        "generator": "tools/visual/etf_variants_local.py",
        "version": VERSION,
        "namespace": ns,
        "jar": os.path.basename(jar),
        "jar_sha256": jar_sha,
        "teams": [t for pair in TEAMS for t in pair],
        "files": sorted(written),
        "skipped": skipped,
    }
    _write(os.path.join(out_dir, MANIFEST), (json.dumps(man, indent=2, sort_keys=True) + "\n").encode("utf-8"))
    log("etf_variants_local: %d textures -> %d files in %s (%d skipped, %d stale removed)" %
        (len(written) // (len(TEAMS) + 1), len(written), out_dir, len(skipped), len(stale)))
    return man


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance", help="the CurseForge instance folder")
    ap.add_argument("--jar", help="mod jar to read (default: found in <instance>/mods)")
    ap.add_argument("--out", help="output folder (default: <instance>/kubejs/assets/<ns>/optifine/random/entity)")
    ap.add_argument("--namespace", default="all", choices=["all"] + list(NAMESPACES))
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--clean", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--max-pixels", type=int, default=1 << 20)
    args = ap.parse_args(argv)
    instance = args.instance
    if not args.out and not instance:
        ap.error("--instance is required unless --out is given")
    if args.namespace == "all" and (args.out or args.jar):
        print("REFUSED: --out and --jar need a single --namespace (epca or spore)")
        return 2
    nss = list(NAMESPACES) if args.namespace == "all" else [args.namespace]
    done = 0
    for ns in nss:
        rc = run_namespace(args, instance, ns, len(nss) == 1)
        if rc == 2:
            return 2
        if rc == 0:
            done += 1
    return 0 if done else 3


def run_namespace(args, instance, ns, single):
    """One namespace: 0 done, 2 refused, 3 no jar (only a note when several namespaces run)."""
    out = args.out or os.path.join(instance, "kubejs", "assets", ns, "optifine", "random", "entity")
    try:
        check_output(out, instance)
    except Refused as e:
        print("REFUSED: " + str(e))
        return 2
    if args.clean:
        print("etf_variants_local: removed %d generated files from %s" % (clean(out), out))
        return 0
    jar = args.jar or (find_jar(instance, ns) if instance else None)
    if not jar or not os.path.isfile(jar):
        if single:
            print("no jar with assets/%s/textures/entity/ found (pass --jar or --instance)" % ns)
        else:
            print("note: no jar with assets/%s/textures/entity/ in the instance; %s skipped" % (ns, ns))
        return 3
    if args.list:
        print("[%s] %s" % (ns, os.path.basename(jar)))
        with zipfile.ZipFile(jar) as z:
            for rel, reason in list_textures(z, ns, args.max_pixels):
                if reason:
                    print("  skip  %-48s %s" % (rel, reason))
                else:
                    print("  make  %-48s -> %s" % (rel, ", ".join(variant_rel(ns, rel, k + 2) for k in range(len(TEAMS)))))
        return 0
    try:
        generate(jar, out, ns, args.force, args.max_pixels)
    except Refused as e:
        print("REFUSED: " + str(e))
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
