"""
Validate everything under overrides/ before it goes into an instance.

  - KubeJS scripts: `node --check` (syntax) when Node.js is installed.
  - JSON: must parse.
  - TOML: must parse (Python 3.11+ tomllib).
  - FTB Quests SNBT: braces and brackets must balance, and quest IDs must be unique.
  - With --instance: every namespaced item/entity ID referenced by the scripts must exist in
    the instance's mod jars (checked against item models, lang files and data folders).

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
}


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
        refs = set(re.findall(r"'((?:epca|mekanism|alexscaves|nuclearcraft|create_new_age|create|spore):[a-z0-9_]+)'", src))
        # Prefixes that scripts complete at runtime, e.g. 'epca:infested_' + tier + metal + '_ore'.
        refs = {r for r in refs if not r.endswith("_")}
        unknown = sorted(r for r in refs if r not in known and r not in pne)
        if unknown:
            bad += len(unknown)
            print(f"  FAIL  {len(unknown)} of {len(refs)} referenced IDs are not registered by any mod: " + ", ".join(unknown))
        else:
            print(f"  IDs: all {len(refs)} referenced IDs resolve (items, blocks, entities, effects, sounds, recipe types)")

    print("\nvalidation " + ("FAILED" if bad else "passed") + f" ({bad} problem(s))")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
