"""
Suite visual-etf-local: tools/visual/etf_variants_local.py on synthetic "EPCA" and "Spore" jars, writing only under
PNE_TMP.

Checks the ETF 7.2.4 naming and key syntax (and, when the instance's ETF jar is present, confirms that syntax in
the jar's bytecode), that every properties rule points at a file that exists (no broken references), alpha
preserved, hue shift <= 25 degrees, no emissive/blink/animation output, determinism, stale-file removal,
protection of files the tool did not make, --clean, the Spore namespace (assets/spore/..., Spore's own skips: eye
layers, light and pulse overlays, projectiles), --namespace all (both jars, one manifest per folder, --clean of both),
and the refusal to write into the repository or outside the instance and the temp folder. Prints PASS on success.
"""
import colorsys
import glob
import hashlib
import io
import os
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pnglite  # noqa: E402
import etf_variants_local as etf  # noqa: E402

# A fresh folder per run under PNE_TMP: several test runs may overlap on one machine.
TMP_ROOT = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
TMP = None
FAILS = []
COUNT = [0]


def check(cond, msg):
    COUNT[0] += 1
    if not cond:
        FAILS.append(msg)


# ---------------------------------------------------------------------------------------------
# Synthetic textures (no imaging library)

def rgba_texture(w, h, seed):
    img = pnglite.Image(w, h)
    for y in range(h):
        for x in range(w):
            i = (y * w + x) * 4
            a = 0 if (x + y + seed) % 7 == 0 else 255
            r = (40 + 23 * x + 11 * seed) % 256
            g = (90 + 17 * y) % 256
            b = (160 + 5 * x * y) % 256
            img.rgba[i:i + 4] = bytes((r, g, b, a))
    return pnglite.write_png(img)


def palette4_texture(w, h):
    pal = [(200, 30, 30), (30, 200, 60), (40, 60, 220), (220, 200, 40), (0, 0, 0)]
    rows = []
    for y in range(h):
        idx = [(x + y) % len(pal) for x in range(w)]
        packed = bytearray()
        for x in range(0, w, 2):
            hi = idx[x]
            lo = idx[x + 1] if x + 1 < w else 0
            packed.append((hi << 4) | lo)
        rows.append(bytes(packed))
    return pnglite.encode_raw(w, h, rows, 4, 3, palette=pal, trns=bytes([255, 255, 255, 255, 0]))


def grey_alpha_texture(w, h):
    rows = [bytes(v for x in range(w) for v in ((x * 30 + y * 7) % 256, 255 if x % 3 else 0)) for y in range(h)]
    return pnglite.encode_raw(w, h, rows, 8, 4)


def rgb16_texture(w, h):
    rows = []
    for y in range(h):
        row = bytearray()
        for x in range(w):
            for v in ((x * 4000) % 65536, (y * 9000) % 65536, 30000):
                row += v.to_bytes(2, "big")
        rows.append(bytes(row))
    return pnglite.encode_raw(w, h, rows, 16, 2)


def interlaced_texture(w, h):
    full = pnglite.read_png(rgba_texture(w, h, 3))
    rows = []
    for x0, y0, dx, dy in pnglite._ADAM7:
        for y in range(y0, h, dy):
            row = bytearray()
            for x in range(x0, w, dx):
                row += full.rgba[(y * w + x) * 4:(y * w + x) * 4 + 4]
            if row:
                rows.append(bytes(row))
    return pnglite.encode_raw(w, h, rows, 8, 6, interlace=True), full


def build_jar(path, drop=()):
    lace, lace_full = interlaced_texture(9, 7)
    files = {
        "assets/epca/textures/entity/ripper.png": rgba_texture(16, 8, 1),
        "assets/epca/textures/entity/infested_slime_size0.png": palette4_texture(7, 5),
        "assets/epca/textures/entity/sub/walker.png": grey_alpha_texture(6, 6),
        "assets/epca/textures/entity/deep.png": rgb16_texture(5, 4),
        "assets/epca/textures/entity/lace.png": lace,
        "assets/epca/textures/entity/infested_zombie_glow.png": rgba_texture(4, 4, 2),
        "assets/epca/textures/entity/bone_arrow.png": rgba_texture(4, 4, 5),
        "assets/epca/textures/entity/clash.png": rgba_texture(4, 4, 6),
        "assets/epca/textures/entity/clash3.png": rgba_texture(4, 4, 7),
        "assets/epca/textures/entity/huge.png": rgba_texture(65, 65, 8),
        "assets/epca/textures/item/not_entity.png": rgba_texture(4, 4, 9),
        "assets/epca/lang/en_us.json": b"{}",
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            if name not in drop:
                z.writestr(name, data)
    return files, lace_full


def build_spore_jar(path):
    files = {
        "assets/spore/textures/entity/brute.png": rgba_texture(8, 8, 11),
        "assets/spore/textures/entity/bairn/bairn_human.png": grey_alpha_texture(6, 6),
        "assets/spore/textures/entity/kraken/kraken_t1.png": rgba_texture(6, 4, 12),
        "assets/spore/textures/entity/delight.png": rgba_texture(4, 4, 18),
        "assets/spore/textures/entity/eyes/brute.png": rgba_texture(8, 8, 13),
        "assets/spore/textures/entity/hindie_light/hindie_blue.png": rgba_texture(4, 4, 14),
        "assets/spore/textures/entity/gorgon_light.png": rgba_texture(4, 4, 15),
        "assets/spore/textures/entity/volatile_pulsation.png": rgba_texture(4, 4, 16),
        "assets/spore/textures/entity/acid_round.png": rgba_texture(4, 4, 17),
        "assets/spore/textures/entity/blank.png": rgba_texture(4, 4, 19),
        "assets/spore/textures/entity/bomb/top.png": rgba_texture(4, 4, 20),
        "assets/spore/textures/item/not_entity.png": rgba_texture(4, 4, 21),
    }
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with zipfile.ZipFile(path, "w") as z:
        for name, data in files.items():
            z.writestr(name, data)
    return files


def spore_checks(inst, jar):
    """The Spore namespace, then --namespace all over both jars."""
    sjar = os.path.join(inst, "mods", "synthetic-spore.jar")
    sfiles = build_spore_jar(sjar)
    check(etf.find_jar(inst, "spore") == sjar and etf.find_jar(inst, "epca") == jar, "find_jar picks the right jar per namespace")
    check(etf.variant_rel("spore", "kraken/kraken_t1.png", 2) == "kraken/kraken_t1.2.png", "digit-ending Spore name uses .N.png")
    rc = etf.main(["--instance", inst, "--namespace", "spore", "--max-pixels", "4096"])
    sout = os.path.join(inst, "kubejs", "assets", "spore", "optifine", "random", "entity")
    check(rc == 0 and os.path.isdir(sout), "Spore generation into <instance>/kubejs/assets/spore/optifine/random/entity")
    man = etf.load_manifest(sout)
    made = set(man.get("files", []))
    check(man.get("namespace") == "spore" and man.get("jar") == "synthetic-spore.jar", "the Spore manifest names its namespace and jar")
    expect = {
        "brute.png": ["brute%d.png" % k for k in range(2, 6)],
        "bairn/bairn_human.png": ["bairn/bairn_human%d.png" % k for k in range(2, 6)],
        "kraken/kraken_t1.png": ["kraken/kraken_t1.%d.png" % k for k in range(2, 6)],
        "delight.png": ["delight%d.png" % k for k in range(2, 6)],
    }
    for src, vs in expect.items():
        for v in vs:
            check(v in made and os.path.isfile(os.path.join(sout, v)), "Spore variant written: " + v)
        check(src[:-4] + ".properties" in made, "Spore properties written for " + src)
        props = etf.parse_properties(open(os.path.join(sout, src[:-4] + ".properties"), encoding="utf-8").read())
        for k in range(1, 5):
            check(props.get("skins.%d" % k) == str(k + 1) and props.get("teams.%d" % k) == "pne_clade_%d pne_clade_%d_named" % (k - 1, k - 1),
                  "Spore rule %d of %s: clade team -> variant %d" % (k, src, k + 1))
            ref = etf.variant_rel("spore", src, k + 1)
            check(os.path.isfile(os.path.join(sout, ref)), "Spore rule %d of %s references an existing file (%s)" % (k, src, ref))
        check(props.get("skins.5") == "1" and "teams.5" not in props, "Spore rule 5 is the default in " + src)
    check(len(made) == len(expect) * 5, "exactly 4 variants + 1 properties per processed Spore texture (%d files)" % len(made))
    skipped = {x["texture"]: x["reason"] for x in man.get("skipped", [])}
    for name, why in (("eyes/brute.png", "folder"), ("hindie_light/hindie_blue.png", "folder"), ("bomb/top.png", "folder"),
                      ("gorgon_light.png", "light"), ("volatile_pulsation.png", "pulse"), ("acid_round.png", "projectile"),
                      ("blank.png", "not a mob")):
        check(name in skipped and why in skipped[name], "Spore skipped %s (%s): %s" % (name, why, skipped.get(name)))
    kept = ("eyes/", "hindie_light/", "bomb/", "gorgon_light", "volatile_pulsation", "acid_round", "blank", "item/")
    check(not any(f.startswith(kept) for f in made),
          "no Spore eye layer, light overlay, projectile or item texture is recoloured")
    base = pnglite.read_png(sfiles["assets/spore/textures/entity/brute.png"])
    v = pnglite.read_png(open(os.path.join(sout, "brute3.png"), "rb").read())
    check(v.alpha_bytes() == base.alpha_bytes() and v.rgba != base.rgba, "Spore variant keeps alpha and differs in colour")
    # --namespace all (the default): both jars, each into its own folder with its own manifest
    eout = os.path.join(inst, "kubejs", "assets", "epca", "optifine", "random", "entity")
    check(etf.main(["--instance", inst, "--max-pixels", "4096"]) == 0, "default --namespace all runs")
    em, sm = etf.load_manifest(eout), etf.load_manifest(sout)
    check(em.get("namespace") == "epca" and sm.get("namespace") == "spore" and em.get("files") and sm.get("files"),
          "--namespace all generated EPCA and Spore variants, one manifest each")
    check(etf.main(["--instance", inst, "--out", os.path.join(TMP, "one_out")]) == 2 and not os.path.exists(os.path.join(TMP, "one_out")),
          "--out without a single --namespace is refused")
    check(etf.main(["--instance", inst, "--list"]) == 0, "--list covers both namespaces")
    check(etf.main(["--instance", inst, "--clean"]) == 0, "--clean for both namespaces runs")
    left_e = [n for d, _, ns in os.walk(eout) for n in ns] if os.path.isdir(eout) else []
    left_s = [n for d, _, ns in os.walk(sout) for n in ns] if os.path.isdir(sout) else []
    check(left_e == [] and left_s == [], "--clean removed every generated file of both namespaces (left %s / %s)" % (left_e[:3], left_s[:3]))
    other = os.path.join(TMP, "only_epca_instance")
    os.makedirs(os.path.join(other, "mods"), exist_ok=True)
    shutil.copy(jar, os.path.join(other, "mods", "synthetic-epca.jar"))
    check(etf.main(["--instance", other, "--max-pixels", "4096"]) == 0 and
          os.path.isfile(os.path.join(other, "kubejs", "assets", "epca", "optifine", "random", "entity", etf.MANIFEST)),
          "--namespace all with only the EPCA jar still generates EPCA (Spore skipped with a note)")


def tree_hash(root):
    h = hashlib.sha256()
    for dirpath, _, names in sorted(os.walk(root)):
        for n in sorted(names):
            p = os.path.join(dirpath, n)
            h.update(os.path.relpath(p, root).replace(os.sep, "/").encode())
            h.update(open(p, "rb").read())
    return h.hexdigest()


def hue_deg(r, g, b):
    h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
    return h * 360.0, s, v


def quiet(*a, **k):
    pass


# ---------------------------------------------------------------------------------------------

def etf_bytecode_checks():
    """When the instance's ETF 7.2.4 jar is present, confirm the syntax the generator relies on."""
    inst = os.environ.get("PNE_INSTANCE") or ""
    jars = glob.glob(os.path.join(inst, "mods", "entity_texture_features-*.jar")) if inst else []
    if not jars:
        print("  note: ETF jar not found (PNE_INSTANCE unset); bytecode confirmation skipped, naming rules still tested")
        return
    base = "traben/entity_texture_features/features/"
    with zipfile.ZipFile(jars[0]) as z:
        team = z.read(base + "property_reading/properties/etf_properties/TeamProperty.class")
        rp = z.read(base + "property_reading/properties/RandomProperty.class")
        var = z.read(base + "texture_handlers/ETFTextureVariator.class")
        dirs = z.read(base + "texture_handlers/ETFDirectory.class")
        utils = z.read("traben/entity_texture_features/utils/ETFUtils2.class")
        fac = z.read(base + "property_reading/properties/RandomProperties.class")
    check(b"\x00\x05teams" in team and b"\x00\x04team" in team, "ETF TeamProperty reads the property ids 'teams' and 'team'")
    check(b"\x01.\x01" in rp, "ETF RandomProperty builds keys as '<id>.<rule>' (concat recipe \\u0001.\\u0001)")
    check(b"\x00\x05skins" in var and b"\x00\x08textures" in var, "ETF variator reads 'skins.N' / 'textures.N'")
    check(b"optifine/random" in dirs and b"optifine/random/entity" in dirs, "ETF OPTIFINE directory is optifine/random")
    check(b"\\D+\\d+\\.\x01" in utils, "ETF variant suffix rule: names ending in digits use '.N.png'")
    check(b"\x00\x05teams" in fac, "ETF registers the teams property factory")
    print("  ETF bytecode confirmation: " + os.path.basename(jars[0]))


def main():
    inst = os.path.join(TMP, "instance")
    jar = os.path.join(inst, "mods", "synthetic-epca.jar")
    files, lace_full = build_jar(jar)
    os.makedirs(os.path.join(inst, "mods"), exist_ok=True)
    with open(os.path.join(inst, "mods", "not-a-zip.jar"), "wb") as f:
        f.write(b"not a zip")

    # naming rules (ETFUtils2.addVariantNumberSuffix)
    check(etf.variant_rel("epca", "ripper.png", 2) == "ripper2.png", "variant name ripper2.png")
    check(etf.variant_rel("epca", "infested_slime_size0.png", 3) == "infested_slime_size0.3.png", "digit-ending name uses .N.png")
    check(etf.variant_rel("epca", "sub/walker.png", 5) == "sub/walker5.png", "subfolder variant keeps its folder")
    check(etf.variant_rel("epca", "ripper.png", 1) == "ripper.png", "variant 1 is the original texture")
    check(etf.variant_rel("epca", "a1b.png", 2) == "a1b2.png", "a digit inside the name does not trigger the .N rule")
    check(max(abs(c["dh"]) for c in etf.CLADES) <= etf.MAX_HUE_SHIFT, "clade table hue shifts are within 25 degrees")

    # jar discovery and default output path
    check(etf.find_jar(inst, "epca") == jar, "find_jar picks the jar holding assets/epca/textures/entity/ and ignores bad zips")
    check(etf.main(["--instance", inst, "--list"]) == 0, "--list runs")
    rc = etf.main(["--instance", inst, "--max-pixels", "4096"])
    out = os.path.join(inst, "kubejs", "assets", "epca", "optifine", "random", "entity")
    check(rc == 0 and os.path.isdir(out), "generation into <instance>/kubejs/assets/epca/optifine/random/entity")
    man = etf.load_manifest(out)
    made = set(man.get("files", []))
    expect = {
        "ripper.png": ["ripper2.png", "ripper3.png", "ripper4.png", "ripper5.png"],
        "infested_slime_size0.png": ["infested_slime_size0.%d.png" % k for k in range(2, 6)],
        "sub/walker.png": ["sub/walker%d.png" % k for k in range(2, 6)],
        "deep.png": ["deep%d.png" % k for k in range(2, 6)],
        "lace.png": ["lace%d.png" % k for k in range(2, 6)],
        "clash3.png": ["clash3.%d.png" % k for k in range(2, 6)],
    }
    for src, vs in expect.items():
        for v in vs:
            check(v in made and os.path.isfile(os.path.join(out, v)), "variant written: " + v)
        check(src[:-4] + ".properties" in made, "properties written for " + src)
    skipped = {s["texture"]: s["reason"] for s in man.get("skipped", [])}
    for name, why in (("infested_zombie_glow.png", "effect"), ("bone_arrow.png", "not a mob"), ("clash.png", "collide"),
                      ("huge.png", "max-pixels")):
        check(name in skipped and why in skipped[name], "skipped %s (%s)" % (name, why))
        check(not any(f.startswith(name[:-4] + "2") or f == name[:-4] + ".properties" for f in made), "no output for skipped " + name)
    check(not any("item/" in f or "not_entity" in f for f in made), "only textures/entity/ is used")
    check(len(made) == 6 * 5, "exactly 4 variants + 1 properties per processed texture (%d files)" % len(made))

    # properties: key syntax, rule numbering, no broken references
    for src in expect:
        props = etf.parse_properties(open(os.path.join(out, src[:-4] + ".properties"), encoding="utf-8").read())
        rules = sorted({int(k.split(".")[1]) for k in props})
        check(rules == [1, 2, 3, 4, 5], "rules 1..5 contiguous in " + src)
        check(all(k.split(".")[0] in ("skins", "teams") for k in props), "only skins.N / teams.N keys in " + src)
        for k in range(1, 5):
            check(props.get("skins.%d" % k) == str(k + 1), "skins.%d -> %d" % (k, k + 1))
            check(props.get("teams.%d" % k) == "pne_clade_%d pne_clade_%d_named" % (k - 1, k - 1), "teams.%d names both clade teams" % k)
        check(props.get("skins.5") == "1" and "teams.5" not in props, "rule 5 is the unconditional default (original texture)")
        for k in range(1, 6):
            idx = int(props["skins.%d" % k])
            ref = etf.variant_rel("epca", src, idx)
            check(idx == 1 or os.path.isfile(os.path.join(out, ref)), "rule %d of %s references an existing file (%s)" % (k, src, ref))

    # pixels: alpha preserved, transparent RGB untouched, variants differ, hue shift bounded
    for src in ("ripper.png", "infested_slime_size0.png", "sub/walker.png", "deep.png", "lace.png"):
        base = pnglite.read_png(files["assets/epca/textures/entity/" + src])
        vs = []
        for k in range(2, 6):
            v = pnglite.read_png(open(os.path.join(out, etf.variant_rel("epca", src, k)), "rb").read())
            vs.append(v)
            check((v.width, v.height) == (base.width, base.height), "variant size matches " + src)
            check(v.alpha_bytes() == base.alpha_bytes(), "alpha preserved in %s clade %d" % (src, k - 2))
            same_rgb_where_clear = all(base.rgba[i:i + 3] == v.rgba[i:i + 3] for i in range(0, len(base.rgba), 4) if base.rgba[i + 3] == 0)
            check(same_rgb_where_clear, "fully transparent pixels untouched in " + src)
            check(v.rgba != base.rgba, "variant differs from the original: %s clade %d" % (src, k - 2))
            worst = 0.0
            for i in range(0, len(base.rgba), 4):
                if base.rgba[i + 3] == 0:
                    continue
                h0, s0, v0 = hue_deg(*base.rgba[i:i + 3])
                h1, s1, v1 = hue_deg(*v.rgba[i:i + 3])
                if s0 >= 0.25 and v0 >= 0.25 and s1 >= 0.15 and v1 >= 0.15:
                    d = abs((h1 - h0 + 540.0) % 360.0 - 180.0)
                    worst = max(worst, d)
            check(worst <= etf.MAX_HUE_SHIFT + 2.0, "hue shift %.1f deg <= 25 (+2 rounding) in %s clade %d" % (worst, src, k - 2))
        check(len({bytes(v.rgba) for v in vs}) == 4, "the four clades are pairwise different in " + src)
    check(pnglite.read_png(files["assets/epca/textures/entity/lace.png"]).rgba == lace_full.rgba, "interlaced input decodes like its plain twin")

    # photosensitivity: nothing animated, emissive or blinking
    all_out = [os.path.relpath(os.path.join(d, n), out).replace(os.sep, "/") for d, _, ns in os.walk(out) for n in ns]
    check(not any(n.endswith(".mcmeta") for n in all_out), "no .mcmeta animation files")
    check(not any(n.endswith("_e.png") or "_blink" in n or "emissive" in n for n in all_out), "no emissive or blink textures")
    check(set(all_out) == made | {etf.MANIFEST}, "the output folder holds exactly the manifest's files")

    # optional cross-check with Pillow when it happens to be installed (not a dependency)
    try:
        from PIL import Image as PILImage
        v = PILImage.open(io.BytesIO(open(os.path.join(out, "ripper3.png"), "rb").read())).convert("RGBA")
        check(v.tobytes() == bytes(pnglite.read_png(open(os.path.join(out, "ripper3.png"), "rb").read()).rgba), "Pillow reads our PNG identically")
    except ImportError:
        pass

    # determinism and idempotence
    h1 = tree_hash(out)
    etf.generate(jar, out, "epca", False, 4096, log=quiet)
    check(tree_hash(out) == h1, "a second run produces identical bytes")

    # stale files: a texture that left the jar loses its generated files
    jar2 = os.path.join(TMP, "jar2", "synthetic-epca.jar")
    build_jar(jar2, drop=("assets/epca/textures/entity/lace.png",))
    m2 = etf.generate(jar2, out, "epca", False, 4096, log=quiet)
    check(not os.path.exists(os.path.join(out, "lace2.png")) and "lace.properties" not in m2["files"], "stale variants removed")
    check(os.path.isfile(os.path.join(out, "ripper2.png")), "other variants kept")

    # files the tool did not make are protected unless --force
    out2 = os.path.join(TMP, "out_foreign")
    os.makedirs(out2, exist_ok=True)
    with open(os.path.join(out2, "ripper3.png"), "wb") as f:
        f.write(b"user file")
    with open(os.path.join(out2, "keep_me.txt"), "w") as f:
        f.write("user file")
    m3 = etf.generate(jar, out2, "epca", False, 4096, log=quiet)
    check(open(os.path.join(out2, "ripper3.png"), "rb").read() == b"user file", "a foreign file is never overwritten")
    check("ripper.properties" not in m3["files"], "a texture with foreign files in the way is skipped whole")
    m4 = etf.generate(jar, out2, "epca", True, 4096, log=quiet)
    check("ripper.properties" in m4["files"] and open(os.path.join(out2, "ripper3.png"), "rb").read() != b"user file", "--force overwrites")
    check(etf.main(["--namespace", "epca", "--out", out2, "--clean"]) == 0, "--clean runs")
    left = sorted(os.listdir(out2))
    check(left == ["keep_me.txt"], "--clean removes exactly the generated files (left: %s)" % left)

    spore_checks(inst, jar)

    # refusals: never into the repository, never outside the instance or the temp folder
    # The guard is tested directly first (no filesystem access); main() is only called with a forbidden
    # path once the guard is known to refuse it, so a broken guard can never make this test write there.
    repo_out = os.path.join(REPO, "overrides", "kubejs", "assets", "epca", "optifine", "random", "entity_pne_test")
    drive = os.path.splitdrive(os.path.abspath(TMP))[0] or "/"
    outside = os.path.join(drive + os.sep, "pne_etf_refusal_probe_dir")
    for label, path, owner in (("the repository", repo_out, inst), ("a folder outside instance and temp", outside, inst),
                               ("the repository even when --instance points there", repo_out, REPO)):
        try:
            etf.check_output(path, owner)
            refused = False
        except etf.Refused:
            refused = True
        check(refused, "guard refuses " + label)
        if refused and label == "the repository":
            check(etf.main(["--namespace", "epca", "--jar", jar, "--out", path]) == 2 and not os.path.exists(path), "main exits 2 for " + label)
    try:
        etf.check_output(os.path.join(inst, "kubejs", "x"), inst)
        etf.check_output(os.path.join(TMP, "y"), None)
        allowed = True
    except etf.Refused:
        allowed = False
    check(allowed, "guard allows the instance and the temp folder")
    check(etf.main(["--instance", os.path.join(TMP, "no_instance_here")]) == 3, "exit 3 when no jar is found")

    etf_bytecode_checks()

    if FAILS:
        for f in FAILS:
            print("  FAIL  " + f)
        print("FAIL %d of %d visual-etf-local checks" % (len(FAILS), COUNT[0]))
        return 1
    print("PASS %d visual-etf-local checks (synthetic jar, output only under %s)" % (COUNT[0], TMP))
    return 0


def run():
    global TMP
    os.makedirs(TMP_ROOT, exist_ok=True)
    TMP = tempfile.mkdtemp(prefix="visual_etf_", dir=TMP_ROOT)
    try:
        return main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(run())
