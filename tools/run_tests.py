"""
Run every test suite in the repo: the built-in checks plus every suite a module registers in tools/suites/*.json.

    python tools/run_tests.py                 run everything
    python tools/run_tests.py --list          list suites and whether their tools are present
    python tools/run_tests.py --only a,b      run only the named suites (or a module name from tools/suites)
    python tools/run_tests.py --milestone M0  run the suites milestone M0 requires (tools/suites/milestones.json);
                                              fails if any of them is not registered, SKIPs or FAILs, and lists
                                              the milestone's items that no suite can decide ("pending": user
                                              decisions and deferred scope, docs/TESTING.md), so MET reads
                                              "MET for the automated criteria" while any are open
    python tools/run_tests.py -v              print the output of passing suites too

Built-in suites: kjs-lint, validate, rhino-compile, core-node, core-rhino, core-hub-brigadier, no-process-kill.
A plain run passes when nothing FAILs (SKIPs are reported, not failed). Milestone exit criteria are checked only
with --milestone, where a SKIP or a missing suite counts as a failure.

A module registers suites by adding tools/suites/<module>.json (never by editing this file):

    {
      "module": "director",
      "suites": [
        {"name": "director-node", "cmd": ["{node}", "tools/director/test_director.js"], "needs": ["node"], "timeout": 600},
        {"name": "director-rhino", "cmd": ["{python}", "tools/rhino/pne_rhino.py", "run", "pneTestResult",
                                         "tools/tests/kjs_mocks.js", "overrides/kubejs/server_scripts/pne_00_core.js",
                                         "overrides/kubejs/server_scripts/pne_resonance.js", "tools/director/rhino_smoke.js"],
         "needs": ["rhino"], "expect": "PASS"}
      ]
    }

cmd placeholders: {python} {node} {java} {javac} {root} {tmp} {rhino_cp} {ffmpeg}. The working directory is the repo
root. needs: node, rhino (JDK 17 + the instance's Rhino jar + its libraries), jdk17, brigadier, kubejs, mcjar (the
SRG-named Minecraft client jar, for NbtIo tests), ffmpeg, numpy, scipy, soundfile. A suite whose needs are missing is reported as SKIP.
Pass rule: exit code 0 (and, with "expect", the last non-empty output line starts with that text). Exit code 77
means SKIP. Suites get these environment variables: PNE_ROOT, PNE_TMP (a scratch folder outside the repo),
PNE_PYTHON, PNE_NODE, PNE_JAVA, PNE_JAVAC, PNE_RHINO_CP, PNE_RHINO_JAR, PNE_KUBEJS_JAR, PNE_INSTANCE, PNE_MC_LIBS,
PNE_MC_SRG, PNE_BRIGADIER, PNE_FFMPEG. Tests must never write to the instance or into overrides/.
"""
import argparse
import glob
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import pne_rhino  # noqa: E402

SKIP = 77
CORE = "overrides/kubejs/server_scripts/pne_00_core.js"
MOCKS = "tools/tests/kjs_mocks.js"


def builtin_suites():
    scripts = sorted(os.path.relpath(p, ROOT).replace(os.sep, "/")
                     for p in glob.glob(os.path.join(ROOT, "overrides", "kubejs", "**", "*.js"), recursive=True))
    return [
        {"name": "kjs-lint", "module": "core", "cmd": ["{python}", "tools/ci/kjs_lint.py"], "needs": []},
        {"name": "validate", "module": "core", "cmd": ["{python}", "tools/validate.py"], "needs": []},
        {"name": "rhino-compile", "module": "core", "cmd": ["{python}", "tools/rhino/pne_rhino.py", "compile"] + scripts, "needs": ["rhino"]},
        {"name": "core-node", "module": "core", "cmd": ["{node}", "tools/tests/kjs_node.js", "pneTestResult", MOCKS, CORE, "tools/tests/core/core_smoke.js"],
         "needs": ["node"], "expect": "PASS"},
        {"name": "core-rhino", "module": "core", "cmd": ["{python}", "tools/rhino/pne_rhino.py", "run", "pneTestResult", MOCKS, CORE, "tools/tests/core/core_smoke.js"],
         "needs": ["rhino"], "expect": "PASS"},
        {"name": "core-hub-brigadier", "module": "core", "cmd": ["{python}", "tools/rhino/pne_rhino.py", "run", "pneHubResult", MOCKS, CORE, "tools/tests/core/hub_brigadier.js"],
         "needs": ["rhino", "brigadier"], "expect": "PASS"},
        {"name": "no-process-kill", "module": "core", "cmd": ["{python}", "tools/ci/no_kill.py"], "needs": []},
    ]


def discovered_suites():
    out = []
    for path in sorted(glob.glob(os.path.join(ROOT, "tools", "suites", "*.json"))):
        if os.path.basename(path) == "milestones.json":
            continue
        try:
            data = json.load(open(path, encoding="utf-8"))
        except Exception as e:
            out.append({"name": os.path.basename(path), "module": "?", "error": f"bad manifest: {e}"})
            continue
        for s in data.get("suites", []):
            s = dict(s)
            s["module"] = data.get("module", os.path.splitext(os.path.basename(path))[0])
            out.append(s)
    return out


def toolchain():
    e = pne_rhino.env()
    ffmpeg = os.environ.get("PNE_FFMPEG") or shutil.which("ffmpeg")
    if not ffmpeg and os.path.isfile(r"C:\ffmpeg\bin\ffmpeg.exe"):
        ffmpeg = r"C:\ffmpeg\bin\ffmpeg.exe"
    have = {
        "node": bool(e["node"]),
        "rhino": pne_rhino.ready(e),
        "jdk17": bool(e["jdk"]),
        "brigadier": bool(e["libs"]["brigadier"]),
        "kubejs": bool(e["kubejs_jar"]),
        "mcjar": bool(e["libs"]["mc_srg"]),
        "ffmpeg": bool(ffmpeg),
    }
    for mod in ("numpy", "scipy", "soundfile"):
        have[mod] = importlib.util.find_spec(mod) is not None
    return e, have, ffmpeg


def expand(cmd, subs):
    out = []
    for part in cmd:
        for k, v in subs.items():
            part = part.replace("{" + k + "}", v or "")
        out.append(part)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--only", default="")
    ap.add_argument("--milestone", default="", help="M0..M5 (comma-separated for several)")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    e, have, ffmpeg = toolchain()
    tmp = os.path.join(tempfile.gettempdir(), "pne_tests")
    os.makedirs(tmp, exist_ok=True)
    rcp = pne_rhino.rhino_classpath(e) if pne_rhino.ready(e) else ""
    libs_root = os.environ.get("PNE_MC_LIBS") or (os.path.normpath(os.path.join(e["instance"], "..", "..", "Install", "libraries")) if e["instance"] else "")
    subs = {
        "python": sys.executable, "node": e["node"] or "node", "root": ROOT, "tmp": tmp, "rhino_cp": rcp,
        "java": e["jdk"]["java"] if e["jdk"] else "", "javac": e["jdk"]["javac"] if e["jdk"] else "", "ffmpeg": ffmpeg or "",
    }
    env = dict(os.environ)
    env.update({
        "PNE_ROOT": ROOT, "PNE_TMP": tmp, "PNE_PYTHON": sys.executable, "PNE_NODE": e["node"] or "",
        "PNE_JAVA": subs["java"], "PNE_JAVAC": subs["javac"], "PNE_RHINO_CP": rcp, "PNE_RHINO_JAR": e["rhino_jar"] or "",
        "PNE_KUBEJS_JAR": e["kubejs_jar"] or "", "PNE_INSTANCE": e["instance"] or "", "PNE_MC_LIBS": libs_root or "",
        "PNE_FFMPEG": ffmpeg or "", "PNE_MC_SRG": e["libs"]["mc_srg"] or "",
        "PNE_BRIGADIER": e["libs"]["brigadier"] or "",
    })

    suites = builtin_suites() + discovered_suites()
    required = []
    pending = []
    if args.milestone:
        try:
            table = json.load(open(os.path.join(ROOT, "tools", "suites", "milestones.json"), encoding="utf-8"))["milestones"]
        except Exception as ex:
            print(f"cannot read tools/suites/milestones.json: {ex}")
            return 1
        try:
            open_items = json.load(open(os.path.join(ROOT, "tools", "suites", "milestones.json"), encoding="utf-8")).get("pending", {})
        except Exception:
            open_items = {}
        for m in (w.strip().upper() for w in args.milestone.split(",") if w.strip()):
            if m not in table:
                print(f"unknown milestone {m}; known: {', '.join(sorted(table))}")
                return 1
            for n in table[m]:
                if n not in required:
                    required.append(n)
            for item in open_items.get(m, []):
                pending.append((m, item))
        suites = [s for s in suites if s.get("name") in required]
    if args.only:
        want = set(w.strip() for w in args.only.split(",") if w.strip())
        suites = [s for s in suites if s.get("name") in want or s.get("module") in want]
        if args.milestone:
            # --only narrows a milestone run to those suites: the others are not "missing"
            names = set(s.get("name") for s in suites)
            required = [n for n in required if n in names or n in want]

    if args.list:
        for s in suites:
            missing = [n for n in s.get("needs", []) if not have.get(n)]
            state = "error: " + s["error"] if "error" in s else ("ready" if not missing else "SKIP (missing " + ", ".join(missing) + ")")
            print(f"  {s.get('name', '?'):28} {s.get('module', ''):12} {state}")
        return 0

    results = []
    for s in suites:
        name = s.get("name", "?")
        if "error" in s:
            results.append((name, "FAIL", 0.0, s["error"]))
            continue
        missing = [n for n in s.get("needs", []) if not have.get(n)]
        if missing:
            results.append((name, "SKIP", 0.0, "missing: " + ", ".join(missing)))
            continue
        t0 = time.time()
        try:
            r = subprocess.run(expand(s["cmd"], subs), cwd=ROOT, env=env, capture_output=True, text=True,
                               timeout=s.get("timeout", 900))
            out = (r.stdout or "") + (r.stderr or "")
            code = r.returncode
        except subprocess.TimeoutExpired:
            out, code = "timed out", 1
        except FileNotFoundError as ex:
            out, code = f"cannot run: {ex}", 1
        dt = time.time() - t0
        if code == SKIP:
            status = "SKIP"
        elif code != 0:
            status = "FAIL"
        else:
            status = "PASS"
            if s.get("expect"):
                last = [ln for ln in out.splitlines() if ln.strip()]
                if not last or not last[-1].strip().startswith(s["expect"]):
                    status = "FAIL"
        results.append((name, status, dt, out))

    bad = 0
    for name, status, dt, out in results:
        print(f"  {status:4}  {name:28} {dt:7.1f}s")
        if status == "FAIL" or (args.verbose and out):
            bad += status == "FAIL"
            for ln in out.strip().splitlines()[-60:]:
                print("        " + ln)
    total = len(results)
    print(f"\n{total} suite(s): {sum(1 for r in results if r[1] == 'PASS')} passed, {bad} failed, "
          f"{sum(1 for r in results if r[1] == 'SKIP')} skipped")
    if args.milestone:
        have_names = set(r[0] for r in results)
        missing = [n for n in required if n not in have_names]
        skipped = [r[0] for r in results if r[1] == "SKIP"]
        for n in missing:
            print(f"  MISSING  {n} (required by {args.milestone.upper()}; no module registered it)")
        for n in skipped:
            print(f"  SKIPPED  {n} (a required suite may not skip)")
        for m, item in pending:
            print(f"  PENDING  {m}: {item}")
        ok = not bad and not missing and not skipped
        verdict = "MET" if ok else "NOT MET"
        if ok and pending:
            verdict = f"MET for the automated criteria; {len(pending)} item(s) pending outside the suites"
        print(f"milestone {args.milestone.upper()}: {verdict} ({len(required)} required suite(s))")
        return 0 if ok else 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
