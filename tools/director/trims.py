"""
Parasite volume trims (TDD 2.3.4 "Existing hot assets", IMPLEMENTATION.md 2.3 DIRECTOR).

    python tools/director/trims.py measure [--compare asset_measurements.json]
        Reads the EPCA and Spore jars and the vanilla asset index of the local instance READ-ONLY, decodes every
        sound their sounds.json references in memory, and writes tools/director/data/external_levels.json:
        per-file integrated loudness and maximum momentary loudness (BS.1770-4), duration and the share of power
        below 100 Hz, plus each event's reference list exactly as the mod's sounds.json has it. Numbers and ids
        only: no audio is copied anywhere.
    python tools/director/trims.py build
        From that table and the jars' sounds.json, writes overrides/kubejs/assets/{epca,spore}/sounds.json:
        every event with at least one hot sound is re-listed with "replace": true, its sound references in the
        mod's exact order, and a per-sound "volume" so that each sound lands at <= -20 LUFS integrated and
        M-max <= -14 LUFS. Only volumes change (a plain string entry becomes {"name", "volume"} when trimmed).
    python tools/director/trims.py check
        The test (suite director-trims): the committed sounds.json files against the table (limits, order,
        completeness, "replace": true, nothing but volume changed), and against the jars when the instance is
        present. Prints PASS/FAIL. Writes nothing.

Loudness is measured on the decode the game hears (16-bit clamp, as OggAudioStream does) and on the float decode;
the louder of the two is used, so a trim never relies on the clamp. The trim fixes loudness only: the baked-in
clipping of some Spore files remains (TDD 2.3.4).
Instance lookup: PNE_INSTANCE, else the first CurseForge instance holding the Rhino jar (tools/rhino/pne_rhino.py).
"""
import hashlib
import io
import json
import math
import os
import sys
import zipfile

sys.dont_write_bytecode = True   # tests write nothing into the repo (no __pycache__)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
TABLE = os.path.join(HERE, "data", "external_levels.json")
OUT = {ns: os.path.join(ROOT, "overrides", "kubejs", "assets", ns, "sounds.json") for ns in ("epca", "spore")}
JARS = {"epca": "End-Parasitize and Convert All-0.147i-1.20.1.jar", "spore": "spore_1.20.1_2.2.0j.jar"}
# Vanilla events pne_horror.js plays (measured for the ledger's PNE_RES_EXTERNAL table, never trimmed).
VANILLA_EVENTS = ["block.bell.use", "entity.slime.squish_small"]
LUFS_MAX = -20.0
MMAX_MAX = -14.0


# ------------------------------------------------------------------------------------------------ meter

def _kweight(fs):
    import numpy as np
    G, Q, fc = 4.0, 1 / math.sqrt(2), 1681.974450955533
    A = 10 ** (G / 40)
    w0 = 2 * math.pi * fc / fs
    al = math.sin(w0) / (2 * Q)
    b1 = [A * ((A + 1) + (A - 1) * math.cos(w0) + 2 * math.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * math.cos(w0)),
          A * ((A + 1) + (A - 1) * math.cos(w0) - 2 * math.sqrt(A) * al)]
    a1 = [(A + 1) - (A - 1) * math.cos(w0) + 2 * math.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * math.cos(w0)),
          (A + 1) - (A - 1) * math.cos(w0) - 2 * math.sqrt(A) * al]
    fc2, Q2 = 38.13547087602444, 0.5003270373238773
    w0 = 2 * math.pi * fc2 / fs
    al = math.sin(w0) / (2 * Q2)
    b2 = [(1 + math.cos(w0)) / 2, -(1 + math.cos(w0)), (1 + math.cos(w0)) / 2]
    a2 = [1 + al, -2 * math.cos(w0), 1 - al]
    return (np.array(b1) / a1[0], np.array(a1) / a1[0]), (np.array(b2) / a2[0], np.array(a2) / a2[0])


def loudness(x, fs):
    """(integrated LUFS, max momentary LUFS) per BS.1770-4: 400 ms blocks, 100 ms hop for gating, 20 ms hop for
    the momentary maximum; files shorter than 400 ms count as one block of their own length (louder, so
    conservative)."""
    import numpy as np
    from scipy import signal
    if x.ndim == 1:
        x = x[:, None]
    (b1, a1), (b2, a2) = _kweight(fs)
    y = signal.lfilter(b2, a2, signal.lfilter(b1, a1, x, axis=0), axis=0)
    p = (y ** 2).sum(axis=1)
    blk = int(round(0.4 * fs))
    if len(p) < blk:
        z = float(p.mean()) if len(p) else 0.0
        v = -0.691 + 10 * math.log10(z) if z > 0 else -120.0
        return v, v
    c = np.concatenate([[0.0], np.cumsum(p)])

    def blocks(hop):
        idx = np.arange(0, len(p) - blk + 1, hop)
        return (c[idx + blk] - c[idx]) / blk

    zs = blocks(int(round(0.1 * fs)))
    ls = -0.691 + 10 * np.log10(np.maximum(zs, 1e-20))
    g = zs[ls > -70]
    if len(g) == 0:
        integ = -120.0
    else:
        rel = -0.691 + 10 * math.log10(g.mean()) - 10
        g2 = zs[(ls > -70) & (ls > rel)]
        integ = -0.691 + 10 * math.log10(g2.mean())
    zm = blocks(max(1, int(round(0.02 * fs))))
    mmax = -0.691 + 10 * math.log10(max(float(zm.max()), 1e-20))
    return float(integ), float(mmax)


def lf_share(x, fs):
    import numpy as np
    from scipy import signal
    m = x.mean(axis=1) if x.ndim > 1 else x
    if len(m) < 16:
        return 0.0
    f, pw = signal.welch(m, fs, nperseg=min(8192, len(m)))
    tot = pw.sum()
    return float(pw[f < 100].sum() / tot) if tot > 0 else 0.0


def measure_bytes(b):
    import numpy as np
    import soundfile as sf
    x, fs = sf.read(io.BytesIO(b), dtype="float64", always_2d=True)
    i_f, m_f = loudness(x, fs)
    xc = np.clip(x, -1.0, 32767 / 32768)
    i_c, m_c = loudness(xc, fs)
    return {"lufs": round(max(i_f, i_c), 2), "mmax": round(max(m_f, m_c), 2), "dur": round(len(x) / fs, 3),
            "lf": round(lf_share(x, fs), 3), "ch": int(x.shape[1])}


# ------------------------------------------------------------------------------------------------ io

def instance():
    try:
        import pne_rhino
        return pne_rhino._instance()
    except Exception:
        return os.environ.get("PNE_INSTANCE")


def jar_sounds(inst, ns):
    """(parsed sounds.json, raw bytes, zipfile) of the mod jar, or (None, None, None)."""
    if not inst:
        return None, None, None
    p = os.path.join(inst, "mods", JARS[ns])
    if not os.path.isfile(p):
        return None, None, None
    z = zipfile.ZipFile(p)
    raw = z.read("assets/%s/sounds.json" % ns)
    return json.loads(raw), raw, z


def entry_name(s):
    return s if isinstance(s, str) else s.get("name")


def measure(args):
    inst = instance()
    if not inst:
        print("SKIP: instance not found (set PNE_INSTANCE)")
        return 77
    table = {"_comment": "Generated by tools/director/trims.py measure from the local instance (read-only). "
                         "Measurements (BS.1770-4, louder of float and 16-bit-clamped decode) and sound ids only; "
                         "no audio. Used by trims.py build/check and mirrored in PNE_RES_EXTERNAL (pne_resonance.js).",
             "limits": {"lufs": LUFS_MAX, "mmax": MMAX_MAX}, "sources": {}, "files": {}, "events": {}, "vanilla": {}}
    for ns in ("epca", "spore"):
        d, raw, z = jar_sounds(inst, ns)
        if d is None:
            print("SKIP: %s jar not found" % ns)
            return 77
        table["sources"][ns] = {"jar": JARS[ns], "sounds_json_sha256": hashlib.sha256(raw).hexdigest()}
        for ev in sorted(d):
            names = [entry_name(s) for s in d[ev].get("sounds", [])]
            table["events"]["%s:%s" % (ns, ev)] = names
            for n in names:
                if n in table["files"]:
                    continue
                sns, path = n.split(":", 1) if ":" in n else ("minecraft", n)
                try:
                    b = z.read("assets/%s/sounds/%s.ogg" % (sns, path))
                except KeyError:
                    table["files"][n] = {"missing": True}
                    continue
                table["files"][n] = measure_bytes(b)
    assets = os.path.normpath(os.path.join(inst, "..", "..", "Install", "assets"))
    idx = json.load(open(os.path.join(assets, "indexes", "5.json"), encoding="utf-8"))["objects"]

    def obj(key):
        h = idx[key]["hash"]
        return open(os.path.join(assets, "objects", h[:2], h), "rb").read()

    vs = json.loads(obj("minecraft/sounds.json"))
    table["sources"]["vanilla"] = {"asset_index": "5"}
    for ev in VANILLA_EVENTS:
        ents = []
        for s in vs[ev]["sounds"]:
            n = entry_name(s)
            key = "minecraft:" + n
            if key not in table["files"]:
                table["files"][key] = measure_bytes(obj("minecraft/sounds/%s.ogg" % n))
            ents.append({"name": key, "volume": (s.get("volume", 1.0) if isinstance(s, dict) else 1.0),
                         "pitch": (s.get("pitch", 1.0) if isinstance(s, dict) else 1.0)})
        table["vanilla"]["minecraft:" + ev] = ents
    os.makedirs(os.path.dirname(TABLE), exist_ok=True)
    with open(TABLE, "w", encoding="utf-8", newline="\n") as f:
        json.dump(table, f, indent=1, sort_keys=True)
        f.write("\n")
    print("wrote %s: %d files, %d events" % (os.path.relpath(TABLE, ROOT), len(table["files"]), len(table["events"])))
    if len(args) >= 2 and args[0] == "--compare":
        am = json.load(open(args[1], encoding="utf-8"))
        worst = 0.0
        n = 0
        for ns in ("epca", "spore"):
            for r in am.get(ns, []):
                key = "%s:%s" % (ns, r["name"][:-4])
                t = table["files"].get(key)
                if t and "lufs" in t and r.get("lufs") is not None and r["lufs"] > -100:
                    n += 1
                    worst = max(worst, abs(t["lufs"] - r["lufs"]))
        print("compare with %s: %d files, max |dI| = %.2f LU" % (args[1], n, worst))
    return 0


# ------------------------------------------------------------------------------------------------ trims

def trim_volume(f):
    """Largest volume (2 decimals, rounded down) that keeps the sound at <= -20 LUFS and M-max <= -14."""
    if not f or f.get("missing"):
        return 1.0
    v = min(1.0, 10 ** ((LUFS_MAX - f["lufs"]) / 20), 10 ** ((MMAX_MAX - f["mmax"]) / 20))
    v = math.floor(v * 100 + 1e-9) / 100
    return max(0.01, v)


def plan(table):
    """{ 'ns:event': [volume per reference] } for every event with at least one trimmed sound."""
    out = {}
    for ev, names in table["events"].items():
        vols = [trim_volume(table["files"].get(n)) for n in names]
        if any(v < 1.0 for v in vols):
            out[ev] = vols
    return out


def build(args):
    table = json.load(open(TABLE, encoding="utf-8"))
    inst = instance()
    p = plan(table)
    for ns in ("epca", "spore"):
        d, raw, _ = jar_sounds(inst, ns)
        if d is None:
            print("FAIL: %s jar not found; build needs the instance" % ns)
            return 1
        if hashlib.sha256(raw).hexdigest() != table["sources"][ns]["sounds_json_sha256"]:
            print("FAIL: %s sounds.json changed since the table was measured; run measure first" % ns)
            return 1
        res = {}
        for key in sorted(k for k in p if k.startswith(ns + ":")):
            ev = key.split(":", 1)[1]
            src = d[ev]
            obj = {}
            obj["replace"] = True
            sounds = []
            for s, v in zip(src["sounds"], p[key]):
                if v >= 1.0:
                    sounds.append(s)
                elif isinstance(s, str):
                    sounds.append({"name": s, "volume": v})
                else:
                    e = dict(s)
                    e["volume"] = round(e.get("volume", 1.0) * v, 4)
                    sounds.append(e)
            obj["sounds"] = sounds
            for k2, v2 in src.items():
                if k2 not in ("sounds", "replace"):
                    obj[k2] = v2
            res[ev] = obj
        os.makedirs(os.path.dirname(OUT[ns]), exist_ok=True)
        with open(OUT[ns], "w", encoding="utf-8", newline="\n") as f:
            json.dump(res, f, indent=2)
            f.write("\n")
        print("wrote %s: %d events trimmed" % (os.path.relpath(OUT[ns], ROOT), len(res)))
    return 0


def check(args):
    fails = []
    table = json.load(open(TABLE, encoding="utf-8"))
    p = plan(table)
    inst = instance()
    checked_jar = 0
    worst = {"lufs": -99.0, "mmax": -99.0}
    n_trim = 0
    for ns in ("epca", "spore"):
        if not os.path.isfile(OUT[ns]):
            fails.append("%s missing" % os.path.relpath(OUT[ns], ROOT))
            continue
        got = json.load(open(OUT[ns], encoding="utf-8"))
        jar, raw, _ = jar_sounds(inst, ns)
        if jar is not None:
            checked_jar += 1
            if hashlib.sha256(raw).hexdigest() != table["sources"][ns]["sounds_json_sha256"]:
                fails.append("%s: the jar's sounds.json differs from the measured one (mod updated? re-run measure and build)" % ns)
        want = sorted(k.split(":", 1)[1] for k in p if k.startswith(ns + ":"))
        if sorted(got) != want:
            fails.append("%s: trimmed events %d, expected %d (missing %s, extra %s)" % (
                ns, len(got), len(want), sorted(set(want) - set(got))[:5], sorted(set(got) - set(want))[:5]))
        for ev, obj in got.items():
            key = "%s:%s" % (ns, ev)
            refs = table["events"].get(key)
            if refs is None:
                fails.append("%s: not an event of the mod" % key)
                continue
            if obj.get("replace") is not True:
                fails.append("%s: replace must be true" % key)
            names = [entry_name(s) for s in obj.get("sounds", [])]
            if names != refs:
                fails.append("%s: sound references differ from the mod's sounds.json" % key)
                continue
            src = jar[ev] if jar is not None else None
            for i, s in enumerate(obj["sounds"]):
                f = table["files"].get(refs[i], {})
                vol = 1.0 if isinstance(s, str) else float(s.get("volume", 1.0))
                if src is not None:
                    o = src["sounds"][i]
                    if isinstance(o, str) and not isinstance(s, str) and set(s) - {"name", "volume"}:
                        fails.append("%s[%d]: fields other than volume added" % (key, i))
                    if isinstance(o, dict) and not isinstance(s, str):
                        for k2 in set(o) | set(s):
                            if k2 != "volume" and o.get(k2) != s.get(k2):
                                fails.append("%s[%d]: field %s changed" % (key, i, k2))
                if f.get("missing"):
                    continue
                if vol < 1.0:
                    n_trim += 1
                li = f["lufs"] + 20 * math.log10(vol)
                lm = f["mmax"] + 20 * math.log10(vol)
                worst["lufs"] = max(worst["lufs"], li)
                worst["mmax"] = max(worst["mmax"], lm)
                if li > LUFS_MAX + 1e-9 or lm > MMAX_MAX + 1e-9:
                    fails.append("%s[%d] %s: %.2f LUFS / M-max %.2f after volume %.2f" % (key, i, refs[i], li, lm, vol))
            if src is not None:
                for k2 in src:
                    if k2 != "sounds" and src[k2] != obj.get(k2):
                        fails.append("%s: field %s changed" % (key, k2))
    # Events that are not re-listed must already be within the limits.
    for key, names in table["events"].items():
        if key in p:
            continue
        for n in names:
            f = table["files"].get(n, {})
            if not f.get("missing") and (f["lufs"] > LUFS_MAX or f["mmax"] > MMAX_MAX):
                fails.append("%s: %s is hot but the event is not trimmed" % (key, n))
    print("trims: %d events, %d trimmed sounds; loudest after trim %.2f LUFS, M-max %.2f; jar cross-check %s" % (
        len(p), n_trim, worst["lufs"], worst["mmax"], "yes (%d jars)" % checked_jar if checked_jar else "no (instance absent)"))
    for f in fails[:40]:
        print("  FAIL " + f)
    print("PASS director-trims" if not fails else "FAIL director-trims: %d problem(s)" % len(fails))
    return 0 if not fails else 1


def main(argv):
    if len(argv) < 2 or argv[1] not in ("measure", "build", "check"):
        print(__doc__)
        return 2
    return {"measure": measure, "build": build, "check": check}[argv[1]](argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
