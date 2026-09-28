"""Export and publish hygiene for the Oracle bridge (TDD 4.4.2, I11).

Fails when anything under overrides/ could carry a player's telemetry or the sidecar's runtime state into a
CurseForge export or a repo sync:
  - any *.ndjson file (opt-in telemetry logs)
  - a file named telemetry.json, verdict.json, status.json, sidecar.lock or sidecar.lock.guard (bridge files), anywhere
  - a folder named worlds (the sidecar's per-world archives), anywhere
  - under overrides/local/pne_oracle/: anything except the .keep placeholder (stop.flag, reload.flag, *.tmp,
    worker.log, logs/ ... are runtime files too)
The repo's .gitignore excludes the same paths; this check also catches a file added with `git add -f` or copied
in by hand before an export.

Usage: python tools/ci/check_overrides.py [OVERRIDES_DIR]      Exit 1 on any hit.
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BRIDGE_FILES = {"telemetry.json", "verdict.json", "status.json", "sidecar.lock", "sidecar.lock.guard"}


def scan(overrides):
    hits = []
    base = os.path.abspath(overrides)
    for dirpath, dirnames, filenames in os.walk(base):
        rel_dir = os.path.relpath(dirpath, base).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        for d in dirnames:
            if d.lower() == "worlds":
                hits.append("overrides/%s%s/: a worlds folder (sidecar archives) must never ship" % (rel_dir, d))
        for fn in filenames:
            rel = rel_dir + fn
            low = fn.lower()
            if low.endswith(".ndjson"):
                hits.append("overrides/%s: telemetry log (*.ndjson)" % rel)
            elif low in BRIDGE_FILES:
                hits.append("overrides/%s: Oracle bridge runtime file" % rel)
            elif rel.lower().startswith("local/pne_oracle/") and rel.lower() != "local/pne_oracle/.keep":
                hits.append("overrides/%s: only local/pne_oracle/.keep may ship" % rel)
    return hits


def main(argv):
    target = argv[1] if len(argv) > 1 else os.path.join(ROOT, "overrides")
    if not os.path.isdir(target):
        print("check_overrides: %s is not a folder" % target)
        return 1
    hits = scan(target)
    for h in hits:
        print("  FAIL  " + h)
    print("check_overrides: %d problem(s)" % len(hits))
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
