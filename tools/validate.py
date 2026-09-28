"""
Validate everything under overrides/ before it goes into an instance.

  - KubeJS scripts: `node --check` (syntax) when Node.js is installed.
  - JSON: must parse.
  - TOML: must parse (Python 3.11+ tomllib).
  - FTB Quests SNBT: braces and brackets must balance, and quest IDs must be unique.
  - KubeJS assets: every sounds.json parses and lists sounds; every sound of the pack's own namespace (pne) has
    its .ogg and its subtitle key in pne/lang/en_us.json; the generated catalog (pne_res_catalog.js) is valid
    JSON whose events are all in pne/sounds.json and whose pools list only catalog events; every 'pne:res.'
    literal in the scripts is a prefix of a real event; every model override that points into the pack's own
    namespace has its model file; no AmbientSounds region folder ships and no stereo bed (catalog amb event) ships
    (docs/IMPLEMENTATION.md 5, decisions 1.3 and 1.4).
  - The EPCA baseline (contract 1.5, section B): defaultExtraDifficulty in overrides/config/E-PCA/epca_main_config.toml
    must name the tier PNE_CORE_EPCA_BASE in pne_00_core.js stands for (EPCA DifficultyLevel ids: easy 0, normal 1,
    expert 2, master 3, custom 4, legendary 5). The core's EPCA sync treats a world whose overworld tier equals that
    baseline as pack-managed, so the two must never drift apart.
  - With --instance: every namespaced item/entity/sound ID referenced by the scripts must exist in
    the instance's mod jars (checked against item models, lang files, sounds.json and data folders), and the
    epca/spore sounds.json volume trims may only re-list events and sound files those mods really ship.

Usage:
    python tools/validate.py [--instance "<instance path>"]
"""
import argparse
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OVR = os.path.join(ROOT, "overrides")


def files(ext):
    return [p for p in glob.glob(os.path.join(OVR, "**", "*" + ext), recursive=True)]


# IDs registered in code with no item model, lang key or sound entry, so the scan below can't see
# them. Each was confirmed by reading the mod's registry class; keep the reason next to it.
EXTRA_KNOWN = {
    "spore:tentacle": "Spore 2.2.0j: registered in com/Harbinger/Spore/Core/Sentities (an organoid with no lang key)",
    # GA-CORE's species mask (pne_hive_core.js) lists Spore limbs and utility entities that deal no damage
    "spore:stahl_arm": "Spore 2.2.0j: registered in com/Harbinger/Spore/Core/Sentities (ldc 'stahl_arm'; a Stahl limb, no lang key)",
    "spore:tendril": "Spore 2.2.0j: registered in com/Harbinger/Spore/Core/Sentities (ldc 'tendril'; utility entity, no lang key)",
}
KJS_ASSETS = os.path.join(OVR, "kubejs", "assets")
CATALOG = os.path.join(OVR, "kubejs", "server_scripts", "pne_res_catalog.js")
OWN_NS = ("pne",)
CORE = os.path.join(OVR, "kubejs", "server_scripts", "pne_00_core.js")
EPCA_TOML = os.path.join(OVR, "config", "E-PCA", "epca_main_config.toml")
EPCA_TIERS = ["easy", "normal", "expert", "master", "custom", "legendary"]


def check_epca_base():
    """defaultExtraDifficulty (EPCA TOML) == the tier PNE_CORE_EPCA_BASE (core) stands for. Returns (problems, note)."""
    bad = []
    note = ""
    if not os.path.isfile(CORE) or not os.path.isfile(EPCA_TOML):
        return bad, "EPCA baseline: core or EPCA config absent, not checked"
    m = re.search(r"^var PNE_CORE_EPCA_BASE = (\d+)\s*(//.*)?$", open(CORE, encoding="utf-8").read(), re.M)
    if not m:
        return ["pne_00_core.js: no 'var PNE_CORE_EPCA_BASE = <int>' line (contract 1.5, section B)"], note
    base = int(m.group(1))
    val = None
    try:
        import tomllib

        def find(d):
            if isinstance(d, dict):
                for k, v in d.items():
                    if k == "defaultExtraDifficulty":
                        return v
                    r = find(v)
                    if r is not None:
                        return r
            return None
        val = find(tomllib.load(open(EPCA_TOML, "rb")))
    except ImportError:
        mm = re.search(r'^\s*defaultExtraDifficulty\s*=\s*"([^"]*)"', open(EPCA_TOML, encoding="utf-8").read(), re.M)
        val = mm.group(1) if mm else None
    if not isinstance(val, str):
        return ["epca_main_config.toml: no defaultExtraDifficulty string"], note
    want = EPCA_TIERS[base] if 0 <= base < len(EPCA_TIERS) else "?"
    if val.strip().lower() != want:
        bad.append(f"EPCA baseline drift: epca_main_config.toml defaultExtraDifficulty is \"{val}\", but PNE_CORE_EPCA_BASE = {base} "
                   f"({want}) in pne_00_core.js; the EPCA sync would treat every default world as deliberately changed (contract 1.5, section B)")
    else:
        note = f"EPCA baseline: defaultExtraDifficulty \"{val}\" = PNE_CORE_EPCA_BASE {base}"
    return bad, note


def sound_names(entry):
    """The sound file names ("ns:path") of one sounds.json event (entries of type 'event' are references, skipped)."""
    out = []
    for snd in entry.get("sounds", []):
        if isinstance(snd, str):
            out.append(snd)
        elif isinstance(snd, dict) and snd.get("type", "file") == "file" and "name" in snd:
            out.append(snd["name"])
    return out


NOTES = []


def check_assets():
    """Offline checks of overrides/kubejs/assets and the generated sound catalog: (problems, {ns: sounds.json})."""
    bad = []
    events = {}
    if os.path.isdir(os.path.join(KJS_ASSETS, "ambientsounds")):
        bad.append("overrides/kubejs/assets/ambientsounds exists, but no AmbientSounds bed regions ship (docs/IMPLEMENTATION.md "
                   "section 5, lead decision 1.3: a region cannot follow pacing, comfort or the ledger)")
    for sj in sorted(glob.glob(os.path.join(KJS_ASSETS, "*", "sounds.json"))):
        ns = os.path.basename(os.path.dirname(sj))
        try:
            data = json.load(open(sj, encoding="utf-8"))
        except Exception as e:
            bad.append(f"{os.path.relpath(sj, ROOT)}: {e}")
            continue
        events[ns] = data
        lang = {}
        lp = os.path.join(KJS_ASSETS, ns, "lang", "en_us.json")
        if os.path.isfile(lp):
            lang = json.load(open(lp, encoding="utf-8"))
        for key, entry in data.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("sounds"), list) or not entry["sounds"]:
                bad.append(f"{ns}/sounds.json: event {key} has no sounds list")
                continue
            if ns not in OWN_NS:
                continue
            for name in sound_names(entry):
                sns, _, path = name.partition(":")
                if sns != ns or not os.path.isfile(os.path.join(KJS_ASSETS, sns, "sounds", *path.split("/")) + ".ogg"):
                    bad.append(f"{ns}/sounds.json: {key} -> {name} has no .ogg under overrides/kubejs/assets/{sns}/sounds")
            sub = entry.get("subtitle")
            if sub and sub not in lang:
                bad.append(f"{ns}/sounds.json: {key} subtitle {sub} is missing from {ns}/lang/en_us.json")
    pne = events.get("pne", {})
    if os.path.isfile(CATALOG):
        lines = open(CATALOG, encoding="utf-8").read().splitlines()
        head = "var PNE_RES_CATALOG = "
        cat = None
        if len(lines) >= 3 and lines[2].startswith(head):
            try:
                cat = json.loads(lines[2][len(head):])
            except Exception as e:
                bad.append(f"pne_res_catalog.js line 3 is not strict JSON: {e}")
        if cat is None:
            bad.append("pne_res_catalog.js: line 3 must be 'var PNE_RES_CATALOG = ' followed by one JSON object (contract 5)")
        else:
            evs = cat.get("events", {})
            amb = sorted(ev for ev, info in evs.items() if isinstance(info, dict) and info.get("amb") is True)
            if amb:
                size = 0
                for ev in amb:
                    parts = ev[len("pne:res."):].split(".")
                    op = os.path.join(KJS_ASSETS, "pne", "sounds", "res", parts[0], "_".join(parts[1:-1]) + "_" + parts[-1] + ".ogg")
                    size += os.path.getsize(op) if os.path.isfile(op) else 0
                bad.append(f"{len(amb)} stereo bed event(s) ship (catalog amb: true, {size / 1e6:.1f} MB of OGG: {', '.join(amb[:3])}"
                           f"{' ...' if len(amb) > 3 else ''}); decision 1.3 / contract 5: beds stay in tools/resonance/out only")
            for ev in evs:
                if not ev.startswith("pne:") or ev[4:] not in pne:
                    bad.append(f"catalog event {ev} has no entry in pne/sounds.json")
            for pool, ids in cat.get("pools", {}).items():
                for ev in ids:
                    if ev not in evs:
                        bad.append(f"catalog pool {pool} lists {ev}, which is not a catalog event")
    src = "".join(open(p, encoding="utf-8").read() for p in files(".js"))
    for lit in sorted(set(re.findall(r"'(pne:res\.[a-z0-9_.]*)'", src))):
        if not any(("pne:" + k).startswith(lit) for k in pne):
            bad.append(f"scripts use '{lit}', which matches no event in pne/sounds.json")
    for mp in glob.glob(os.path.join(KJS_ASSETS, "*", "models", "**", "*.json"), recursive=True):
        try:
            model = json.load(open(mp, encoding="utf-8"))
        except Exception:
            continue
        for ov in model.get("overrides", []):
            m = ov.get("model", "")
            mns, _, mpath = m.partition(":")
            if mns in OWN_NS and not os.path.isfile(os.path.join(KJS_ASSETS, mns, "models", *mpath.split("/")) + ".json"):
                bad.append(f"{os.path.relpath(mp, ROOT)}: override model {m} does not exist in the pack")
    return bad, events


def check_trims(instance, events):
    """The epca/spore sounds.json of the pack only re-list (with lower volumes) events and files the mods ship."""
    bad = []
    jar_events = {}
    jar_names = {}
    jar_files = set()
    for j in glob.glob(os.path.join(instance, "mods", "*.jar")):
        try:
            z = zipfile.ZipFile(j)
        except Exception:
            continue
        for n in z.namelist():
            m = re.match(r"assets/([a-z0-9_]+)/sounds\.json$", n)
            if m and m.group(1) in events and m.group(1) not in OWN_NS:
                try:
                    own = json.loads(z.read(n))
                    jar_events.setdefault(m.group(1), set()).update(own.keys())
                    for k, v in own.items():
                        if isinstance(v, dict):
                            jar_names[m.group(1) + ":" + k] = set(sound_names(v))
                except Exception:
                    pass
            m = re.match(r"assets/([a-z0-9_]+)/sounds/(.+)\.ogg$", n)
            if m:
                jar_files.add(m.group(1) + ":" + m.group(2))
    for ns, data in events.items():
        if ns in OWN_NS:
            continue
        if ns not in jar_events:
            bad.append(f"{ns}/sounds.json: no mod jar in the instance ships assets/{ns}/sounds.json")
            continue
        for key, entry in data.items():
            if key not in jar_events[ns]:
                bad.append(f"{ns}/sounds.json: event {key} is not an event of the {ns} jar")
            for name in (sound_names(entry) if isinstance(entry, dict) else []):
                full = name if ":" in name else "minecraft:" + name
                if full in jar_files:
                    continue
                if name in jar_names.get(ns + ":" + key, set()):
                    # the mod's own sounds.json lists this missing file too: an upstream slip the trim only mirrors
                    print(f"  note  {ns}/sounds.json: {key} -> {name} is missing from the {ns} jar, whose own sounds.json lists it too")
                else:
                    bad.append(f"{ns}/sounds.json: {key} -> {name} is not a sound file in any jar")
    return bad


def known_ids(instance):
    """Every namespaced ID the instance's jars register: items, blocks, entities, effects, sounds, recipe types."""
    known = set(EXTRA_KNOWN)
    lang_key = re.compile(r'"(?:item|block|entity|effect)\.([a-z0-9_]+)\.([a-z0-9_]+)"\s*:')
    for j in glob.glob(os.path.join(instance, "mods", "*.jar")):
        try:
            z = zipfile.ZipFile(j)
        except Exception:
            continue
        for n in z.namelist():
            m = re.match(r"assets/([a-z0-9_]+)/models/item/([a-z0-9_/]+)\.json$", n)
            if m:
                known.add(f"{m.group(1)}:{m.group(2)}")
                continue
            try:
                if re.match(r"assets/[a-z0-9_]+/lang/en_us\.json$", n):
                    for ns, path in lang_key.findall(z.read(n).decode("utf-8", "replace")):
                        known.add(f"{ns}:{path}")
                elif re.match(r"assets/([a-z0-9_]+)/sounds\.json$", n):
                    ns = n.split("/")[1]
                    for key in json.loads(z.read(n)).keys():
                        known.add(f"{ns}:{key}")
                elif re.match(r"data/[a-z0-9_]+/recipes/.+\.json$", n):
                    t = re.search(rb'"type"\s*:\s*"([a-z0-9_]+:[a-z0-9_/]+)"', z.read(n))
                    if t:
                        known.add(t.group(1).decode())
            except Exception:
                pass
    return known


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance", help="instance folder, to check IDs against its mod jars")
    args = ap.parse_args()
    bad = 0

    node = shutil.which("node")
    for p in files(".js"):
        if not node:
            print("  skip  (node not installed) " + os.path.relpath(p, ROOT))
            continue
        r = subprocess.run([node, "--check", p], capture_output=True, text=True)
        if r.returncode:
            bad += 1
            print("  FAIL  " + os.path.relpath(p, ROOT) + "\n" + r.stderr.strip())
    for p in files(".json"):
        try:
            json.load(open(p, encoding="utf-8"))
        except Exception as e:
            bad += 1
            print(f"  FAIL  {os.path.relpath(p, ROOT)}: {e}")
    try:
        import tomllib
        for p in files(".toml"):
            try:
                tomllib.load(open(p, "rb"))
            except Exception as e:
                bad += 1
                print(f"  FAIL  {os.path.relpath(p, ROOT)}: {e}")
    except ImportError:
        print("  skip  TOML checks (needs Python 3.11+)")
    asset_bad, events = check_assets()
    for msg in asset_bad:
        bad += 1
        print("  FAIL  " + msg)
    if not asset_bad:
        print(f"  assets: {sum(len(v) for v in events.values())} sound events in {len(events)} sounds.json; catalog, subtitles and models consistent")
    for msg in NOTES:
        print("  note  " + msg)
    epca_bad, epca_note = check_epca_base()
    for msg in epca_bad:
        bad += 1
        print("  FAIL  " + msg)
    if epca_note:
        print("  " + epca_note)
    seen = {}
    for p in files(".snbt"):
        t = open(p, encoding="utf-8").read()
        stripped = re.sub(r'"(?:\\.|[^"\\])*"', '""', t)
        if stripped.count("{") != stripped.count("}") or stripped.count("[") != stripped.count("]"):
            bad += 1
            print(f"  FAIL  {os.path.relpath(p, ROOT)}: unbalanced braces or brackets")
        for qid in re.findall(r'\bid: "([0-9A-F]{16})"', t):
            if qid in seen and seen[qid] != p:
                bad += 1
                print(f"  FAIL  duplicate quest id {qid} in {os.path.basename(p)} and {os.path.basename(seen[qid])}")
            seen[qid] = p

    if args.instance:
        known = known_ids(args.instance)
        src = "".join(open(p, encoding="utf-8").read() for p in files(".js"))
        pne = set(re.findall(r"event\.create\('(pne:[a-z0-9_]+)'", src))
        refs = set(re.findall(r"'((?:epca|mekanism|alexscaves|nuclearcraft|create_new_age|create|spore):[a-z0-9_.]+)'", src))
        # Prefixes that scripts complete at runtime, e.g. 'epca:infested_' + tier + metal + '_ore'.
        refs = {r for r in refs if not r.endswith("_") and not r.endswith(".")}
        unknown = sorted(r for r in refs if r not in known and r not in pne)
        if unknown:
            bad += len(unknown)
            print(f"  FAIL  {len(unknown)} of {len(refs)} referenced IDs are not registered by any mod: " + ", ".join(unknown))
        else:
            print(f"  IDs: all {len(refs)} referenced IDs resolve (items, blocks, entities, effects, sounds, recipe types)")
        trim_bad = check_trims(args.instance, events)
        for msg in trim_bad[:40]:
            print("  FAIL  " + msg)
        bad += len(trim_bad)
        if not trim_bad:
            print("  trims: no epca/spore trim adds an event or a sound file that the instance's jars do not ship")

    print("\nvalidation " + ("FAILED" if bad else "passed") + f" ({bad} problem(s))")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
