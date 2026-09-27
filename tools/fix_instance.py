"""
Stop CurseForge from undoing the enhancement.

A CurseForge modpack instance stays linked to its modpack. While CurseForge runs it keeps the
instance in memory and rewrites minecraftinstance.json from that copy within seconds of any edit,
and at launch it "repairs" the instance back toward the modpack's file list. That silently
re-enables mods you disabled and discards memory settings.

This script, run with CurseForge FULLY closed (tray icon included):
  - unlinks the instance from the modpack and unlocks it, so it becomes a custom profile;
  - sets a 12 GB heap with tuned G1GC flags. CurseForge ignores allocatedMemory unless
    isMemoryOverride is true, which is why memory settings often "revert";
  - disables this pack's disabled mods the CurseForge way: renames the jar to .jar.disabled AND
    updates the tracked fileNameOnDisk, so CurseForge does not download it again.

Usage:
    python tools/fix_instance.py --instance "<instance path>" [--check] [--memory-mb 12288]
"""
import argparse
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def g1_flags(mb):
    gb = max(2, mb // 1024)
    return (f"-Xmx{gb}G -Xms{gb}G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=130 "
            "-XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch "
            "-XX:G1NewSizePercent=28 -XX:G1HeapRegionSize=16M -XX:G1ReservePercent=20 "
            "-XX:G1MixedGCCountTarget=3 -XX:InitiatingHeapOccupancyPercent=10 -XX:SurvivorRatio=32 "
            "-XX:MaxTenuringThreshold=1 -Xss1M")


def curseforge_running():
    try:
        return "curseforge.exe" in subprocess.run(["tasklist"], capture_output=True, text=True).stdout.lower()
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance", required=True, help="path to the CurseForge instance folder")
    ap.add_argument("--check", action="store_true", help="report only; change nothing")
    ap.add_argument("--memory-mb", type=int, default=12288, help="heap size in MB (default 12288)")
    ap.add_argument("--name", default="Parasites New Dawn - Enhanced", help="profile name shown in CurseForge")
    args = ap.parse_args()

    path = os.path.join(args.instance, "minecraftinstance.json")
    if not os.path.exists(path):
        raise SystemExit(f"minecraftinstance.json not found in {args.instance}")
    if not args.check and curseforge_running():
        raise SystemExit("CurseForge is still running. Quit it fully (tray icon too), then run this again, "
                         "or add --check to only report.")

    want = {
        "name": args.name, "installedModpack": None, "projectID": 0, "fileID": 0, "isUnlocked": True,
        "allocatedMemory": args.memory_mb, "isMemoryOverride": True, "javaArgsOverride": g1_flags(args.memory_mb),
        "preferenceAutoInstallUpdates": False,
    }
    manifest = json.load(open(os.path.join(ROOT, "mods", "manifest.json"), encoding="utf-8"))
    disabled = [m["file"] for m in manifest.get("disabled", [])]

    data = json.load(open(path, encoding="utf-8-sig"))
    drift = [k for k, v in want.items() if data.get(k) != v]
    for jar in disabled:
        if os.path.exists(os.path.join(args.instance, "mods", jar)):
            drift.append(f"{jar} active on disk")
        for addon in data.get("installedAddons", []):
            if (addon.get("installedFile") or {}).get("fileNameOnDisk") == jar:
                drift.append(f"{jar} tracked as enabled")

    if args.check:
        print("drift: " + (", ".join(drift) if drift else "none -- the instance is unlinked and configured"))
        return 1 if drift else 0

    data.update(want)
    data["installPath"] = os.path.join(args.instance, "")
    for jar in disabled:
        live = os.path.join(args.instance, "mods", jar)
        if os.path.exists(live):
            off = live + ".disabled"
            if os.path.exists(off):
                os.remove(live)
            else:
                os.rename(live, off)
        for addon in data.get("installedAddons", []):
            f = addon.get("installedFile") or {}
            if f.get("fileNameOnDisk") == jar:
                f["fileNameOnDisk"] = jar + ".disabled"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    print("repaired: " + (", ".join(drift) if drift else "nothing needed"))
    print(f"heap {args.memory_mb} MB, unlinked from the modpack, disabled mods: {', '.join(disabled) or 'none'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
