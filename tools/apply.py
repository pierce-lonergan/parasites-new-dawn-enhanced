"""
Apply Parasites New Dawn - Enhanced to a CurseForge instance.

Start from a COPY of the CurseForge modpack "parasites new dawn - 100 days with parasites"
(project 1549512, Minecraft 1.20.1, Forge 47.4.10). Never run this against an instance whose
worlds you care about without a backup.

What it does, in order:
  1. Optionally downloads the added mods listed in mods/manifest.json from Modrinth,
     verifying each file's SHA-512 (--download).
  2. Copies everything under overrides/ into the instance (existing files are backed up once
     to <file>.bak-pne).
  3. Generates the Toxic Caves loot overrides from your local EPCA jar.
  4. Fixes the original "Survive 100 days" quest, which checked 10 days instead of 100.
  5. Applies the comfort settings to options.txt (no nausea wobble, no damage tilt,
     no FOV or darkness pulsing). Skip with --no-comfort.
  6. Disables the mods this pack turns off (renames them to .jar.disabled).

Usage:
    python tools/apply.py --instance "<instance path>" [--download] [--no-comfort]
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import gen_loot_overrides  # noqa: E402

UA = {"User-Agent": "parasites-new-dawn-enhanced-installer/1.0"}
COMFORT = {"screenEffectScale": "0.0", "damageTiltStrength": "0.0", "fovEffectScale": "0.0", "darknessEffectScale": "0.0"}


def sha512(path):
    h = hashlib.sha512()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def download_mods(instance, manifest):
    mods_dir = os.path.join(instance, "mods")
    for m in manifest["added"]:
        dest = os.path.join(mods_dir, m["file"])
        if os.path.exists(dest) and sha512(dest) == m["sha512"]:
            print(f"  have  {m['file']}")
            continue
        req = urllib.request.Request(m["url"], headers=UA)
        with urllib.request.urlopen(req, timeout=600) as r:
            data = r.read()
        if hashlib.sha512(data).hexdigest() != m["sha512"]:
            raise SystemExit(f"SHA-512 mismatch for {m['file']}; refusing to install it")
        with open(dest, "wb") as f:
            f.write(data)
        print(f"  got   {m['file']}  ({len(data) / 1048576:.2f} MB, SHA-512 verified)")


def copy_overrides(instance):
    src_root = os.path.join(ROOT, "overrides")
    copied = 0
    for dirpath, _, files in os.walk(src_root):
        for name in files:
            src = os.path.join(dirpath, name)
            rel = os.path.relpath(src, src_root)
            dest = os.path.join(instance, rel)
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            if os.path.exists(dest) and not os.path.exists(dest + ".bak-pne"):
                shutil.copy2(dest, dest + ".bak-pne")
            shutil.copy2(src, dest)
            copied += 1
    print(f"  copied {copied} override files")


def fix_hundred_day_quest(instance):
    path = os.path.join(instance, "config", "ftbquests", "quests", "chapters", "parasites.snbt")
    if not os.path.exists(path):
        print("  parasites.snbt not found; skipped the 100-day quest fix")
        return
    text = open(path, encoding="utf-8").read()
    fixed, n = re.subn(r'(stat: "minecraft:play_time"\s*\n\s*title: "100 days "\s*\n\s*type: "stat"\s*\n\s*value: )240000\b',
                       r"\g<1>2400000", text)
    if n:
        open(path, "w", encoding="utf-8").write(fixed)
        print("  fixed 'Survive 100 days' quest: 240000 ticks (10 days) -> 2400000 (100 days)")
    else:
        print("  100-day quest already fixed or not found")


def apply_comfort(instance):
    path = os.path.join(instance, "options.txt")
    if not os.path.exists(path):
        print("  options.txt not found (launch the game once first); comfort settings skipped")
        return
    text = open(path, encoding="utf-8").read()
    for key, value in COMFORT.items():
        if re.search(rf"(?m)^{key}:", text):
            text = re.sub(rf"(?m)^{key}:.*$", f"{key}:{value}", text)
        else:
            text += f"\n{key}:{value}"
    open(path, "w", encoding="utf-8").write(text)
    print("  comfort: " + ", ".join(f"{k}={v}" for k, v in COMFORT.items()))


def disable_mods(instance, names):
    for jar in names:
        live = os.path.join(instance, "mods", jar)
        if os.path.exists(live):
            off = live + ".disabled"
            if os.path.exists(off):
                os.remove(live)
            else:
                os.rename(live, off)
            print(f"  disabled {jar}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance", required=True, help="path to the CurseForge instance folder")
    ap.add_argument("--download", action="store_true", help="download the added mods from Modrinth")
    ap.add_argument("--no-comfort", action="store_true", help="leave options.txt alone")
    args = ap.parse_args()

    if not os.path.isdir(os.path.join(args.instance, "mods")):
        raise SystemExit(f"Not a Minecraft instance (no mods folder): {args.instance}")
    manifest = json.load(open(os.path.join(ROOT, "mods", "manifest.json"), encoding="utf-8"))

    print("1. Mods")
    if args.download:
        download_mods(args.instance, manifest)
    else:
        missing = [m["file"] for m in manifest["added"] if not os.path.exists(os.path.join(args.instance, "mods", m["file"]))]
        print(f"  {len(missing)} added mods missing" + (" (re-run with --download)" if missing else ""))
    print("2. Overrides")
    copy_overrides(args.instance)
    print("3. Toxic Caves loot")
    gen_loot_overrides.generate(args.instance)
    print("4. Quest fix")
    fix_hundred_day_quest(args.instance)
    print("5. Comfort")
    if args.no_comfort:
        print("  skipped (--no-comfort)")
    else:
        apply_comfort(args.instance)
    print("6. Disabled mods")
    disable_mods(args.instance, [m["file"] for m in manifest.get("disabled", [])])
    print("\nDone. Close CurseForge fully, then run tools/fix_instance.py so CurseForge stops")
    print("restoring the original modpack over these changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
