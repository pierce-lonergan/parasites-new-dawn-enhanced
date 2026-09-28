"""
HIVE-RUNTIME test driver (the suites in tools/suites/hive.json).

    python tools/hive/run_hive.py node      hive-node: runtime tests on the shared mocks, in Node, then the Hard baseline
                                            (tools/hive/test_hard.js against tools/hive/fixtures/hive_hard_baseline.json)
    python tools/hive/run_hive.py rhino     hive-rhino: the same tests in the instance's Rhino jar (real HashMap global,
                                            real ArrayList queues), then the Hard baseline in Rhino
    python tools/hive/run_hive.py hard-record [--force]
                                            records the Hard baseline fixture, only from the release 1.4 pne_hive.js
                                            (git 8e2f433, sha256-checked) with the current core and mocks, in Node and
                                            Rhino (they must agree); refuses to overwrite a fixture without --force
    python tools/hive/run_hive.py kmercy    hive-kmercy-rhino: the startup k_mercy formula and listeners in Rhino (and Node)
    python tools/hive/run_hive.py conv      hive-conversion-replay: join-before-leave conversions and GA replay, Node and
                                            Rhino, identical digests
    python tools/hive/run_hive.py nbt       hive-nbt-size: tools/genome/test/NbtSizeTest.java (max state through NbtIo)
    python tools/hive/run_hive.py bench     hive-rhino-bench: Rhino mock-world benchmark (tools/hive/HiveBench.java)

JDK 17 is pinned through tools/rhino/pne_rhino.py (PNE_JDK17; the javac on PATH may be Java 8). The Rhino jar, its
libraries and the SRG Minecraft jar come from the CurseForge instance (PNE_INSTANCE, PNE_MC_LIBS). Classes compile into
the system temp folder; tests write only to PNE_TMP. Exit code 77 means a tool is missing (run_tests.py reports SKIP).
Nothing here starts or stops any other process.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import pne_rhino  # noqa: E402

SKIP = 77
MOCKS = "tools/tests/kjs_mocks.js"
PRELUDE = "tools/hive/hive_prelude.js"
CORE = "overrides/kubejs/server_scripts/pne_00_core.js"
GA = "overrides/kubejs/server_scripts/pne_hive_core.js"
HIVE = "overrides/kubejs/server_scripts/pne_hive.js"
EVENTS = "overrides/kubejs/startup_scripts/pne_hive_events.js"
PACK = [MOCKS, PRELUDE, CORE, GA, HIVE, EVENTS]
HARD_TEST = "tools/hive/test_hard.js"
HARD_FIXTURE = os.path.join(HERE, "fixtures", "hive_hard_baseline.json")
HARD_PARTS = ["digest", "b", "ev", "ga", "mobs", "vis", "cmds", "stored"]
# The release 1.4 hive runtime the Hard baseline is recorded from (contract 1.5, lead decision L5), and its sha256.
HARD_SRC_GIT = "8e2f433"
HARD_SRC_SHA = "7e817169d39115f0fd443961f3a72643d5a91c2ae6736a23202b84d444faa479"

# Extra jars NbtIo needs next to the SRG client jar (paths under the Minecraft libraries folder).
NBT_LIBS = [
    "com/google/guava/guava/31.1-jre/guava-31.1-jre.jar",
    "com/google/guava/failureaccess/1.0.1/failureaccess-1.0.1.jar",
    "com/mojang/datafixerupper/6.0.8/datafixerupper-6.0.8.jar",
    "com/mojang/logging/1.1.1/logging-1.1.1.jar",
]


def last_line(out):
    lines = [ln for ln in out.splitlines() if ln.strip() and not ln.startswith("[")]
    return lines[-1].strip() if lines else ""


def node_run(expr, files, timeout=600):
    exe = shutil.which("node")
    if not exe:
        return None, "node not found"
    r = subprocess.run([exe, os.path.join(ROOT, "tools", "tests", "kjs_node.js"), expr] + [os.path.join(ROOT, f) for f in files],
                       capture_output=True, text=True, timeout=timeout, cwd=ROOT)
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def rhino_run(e, expr, files, timeout=900):
    cls = pne_rhino.harness(e)
    r = pne_rhino.run_java(e, cls, "PneRhino", ["run", expr] + [os.path.join(ROOT, f) for f in files], timeout=timeout)
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def libs_root(e):
    lr = os.environ.get("PNE_MC_LIBS")
    if not lr and e["instance"]:
        lr = os.path.normpath(os.path.join(e["instance"], "..", "..", "Install", "libraries"))
    return lr


def report(label, code, out, want="PASS"):
    ll = last_line(out)
    print(f"{label}: {ll}")
    if code != 0 or not ll.startswith(want):
        tail = "\n".join(out.splitlines()[-25:])
        print("  output tail:\n" + "\n".join("    " + t for t in tail.splitlines()))
        return False
    return True


def need_rhino(e):
    if not pne_rhino.ready(e):
        print("SKIP: JDK 17, the instance's Rhino jar or its libraries were not found (set PNE_JDK17 / PNE_INSTANCE / PNE_MC_LIBS)")
        return False
    return True


def hard_parts(line):
    """The key=value parts of a 'PASS hard digest=... b=...' line."""
    return dict(t.split("=", 1) for t in line.split()[2:] if "=" in t) if line.startswith("PASS hard ") else {}


def hard_check(label, code, out):
    """The Hard scenario's digests against the fixture recorded from release 1.4 (every part must be equal)."""
    ll = last_line(out)
    got = hard_parts(ll)
    if code != 0 or not got:
        print(f"{label} hard: {ll}")
        print("  output tail:\n" + "\n".join("    " + t for t in out.splitlines()[-25:]))
        return False, ""
    with open(HARD_FIXTURE, encoding="utf-8") as f:
        want = json.load(f)["parts"]
    bad = [k for k in HARD_PARTS if got.get(k) != want.get(k)]
    if bad:
        print(f"{label} hard: FAIL the Hard profile differs from release 1.4 in: " +
              ", ".join(f"{k} {got.get(k)} (1.4: {want.get(k)})" for k in bad))
        print(f"  {ll}")
        return False, ""
    print(f"{label} hard: digest {got['digest']} equals the release 1.4 baseline ({len(HARD_PARTS)} parts; B values {got.get('n_b')}, "
          f"GA events {got.get('n_ev')}, commands {got.get('n_cmds')}, entities {got.get('n_mobs')}, dream slices {got.get('dream')})")
    return True, got["digest"]


def mode_node(e):
    code, out = node_run("pneHiveTestResult", PACK + ["tools/hive/test_hive.js"])
    if code is None:
        print("SKIP: node not found")
        return SKIP
    ok = report("node", code, out)
    hcode, hout = node_run("pneHardResult", PACK + [HARD_TEST])
    hok, dg = hard_check("node", hcode, hout)
    if ok and hok:
        print(last_line(out) + f"; Hard profile bit-identical to release 1.4 (digest {dg})")
        return 0
    print("FAIL hive-node")
    return 1


def mode_rhino(e):
    if not need_rhino(e):
        return SKIP
    code, out = rhino_run(e, "pneHiveTestResult", PACK + ["tools/hive/test_hive.js"])
    ok = report("rhino", code, out)
    hcode, hout = rhino_run(e, "pneHardResult", PACK + [HARD_TEST])
    hok, dg = hard_check("rhino", hcode, hout)
    if ok and hok:
        print(last_line(out) + f"; Hard profile bit-identical to release 1.4 (digest {dg})")
        return 0
    print("FAIL hive-rhino")
    return 1


def mode_hard_record(e, force):
    """Records the Hard baseline from the release 1.4 pne_hive.js only (never from the working file)."""
    if os.path.exists(HARD_FIXTURE) and not force:
        print("REFUSED: " + os.path.relpath(HARD_FIXTURE, ROOT) + " exists; Hard fixtures are never regenerated from a later "
              "pne_hive.js. Pass --force only to re-record from the release 1.4 script after a core or mock change.")
        return 1
    if not need_rhino(e):
        return SKIP
    r = subprocess.run(["git", "show", HARD_SRC_GIT + ":" + HIVE], capture_output=True, cwd=ROOT)
    if r.returncode != 0 or hashlib.sha256(r.stdout).hexdigest() != HARD_SRC_SHA:
        print("FAIL the release 1.4 pne_hive.js (git " + HARD_SRC_GIT + ") is not available or its sha256 differs")
        return 1
    tmp = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
    os.makedirs(tmp, exist_ok=True)
    src = os.path.join(tmp, "pne_hive_1_4.js")
    with open(src, "wb") as f:
        f.write(r.stdout)
    files = [MOCKS, PRELUDE, CORE, GA, src, EVENTS, HARD_TEST]
    ncode, nout = node_run("pneHardResult", files)
    rcode, rout = rhino_run(e, "pneHardResult", files)
    np_, rp = hard_parts(last_line(nout)), hard_parts(last_line(rout))
    if ncode != 0 or rcode != 0 or not np_ or np_ != rp:
        print("FAIL Node and Rhino disagree (or the scenario failed):\n  node  " + last_line(nout) + "\n  rhino " + last_line(rout))
        return 1
    fx = {
        "_comment": "Hard-profile baseline of the hive runtime (contract 1.5, lead decision L5). Recorded by tools/hive/run_hive.py "
                    "hard-record from the release 1.4 overrides/kubejs/server_scripts/pne_hive.js (git " + HARD_SRC_GIT + ", sha256 "
                    "below) with the current core, mocks and GA core, in Node and in the instance's Rhino jar (identical). Never "
                    "regenerate it from a later pne_hive.js: a Hard digest that differs is a failure (difficulty spec, risk 5). "
                    "tools/hive/run_hive.py compares every part and names the ones that differ.",
        "recorded_from": {"file": HIVE, "git": HARD_SRC_GIT, "sha256": HARD_SRC_SHA},
        "parts": {k: np_[k] for k in HARD_PARTS},
        "counts": {k: np_[k] for k in np_ if k not in HARD_PARTS},
    }
    os.makedirs(os.path.dirname(HARD_FIXTURE), exist_ok=True)
    with open(HARD_FIXTURE, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(fx, indent=2) + "\n")
    print("PASS recorded " + os.path.relpath(HARD_FIXTURE, ROOT) + " from release 1.4 (digest " + np_["digest"] + ", Node and Rhino identical)")
    return 0


def mode_kmercy(e):
    if not need_rhino(e):
        return SKIP
    files = [MOCKS, PRELUDE, EVENTS, "tools/hive/test_kmercy.js"]
    ok = True
    code, out = node_run("pneKmResult", files)
    if code is not None:
        ok = report("node ", code, out) and ok
    code, out = rhino_run(e, "pneKmResult", files)
    rok = report("rhino", code, out)
    if not (ok and rok):
        print("FAIL hive-kmercy-rhino")
        return 1
    print("PASS " + last_line(out)[5:])
    return 0


def mode_conv(e):
    if not need_rhino(e):
        return SKIP
    files = PACK + ["tools/hive/test_conversion.js"]
    code, nout = node_run("pneConvResult", files)
    if code is None:
        print("SKIP: node not found")
        return SKIP
    nok = report("node ", code, nout)
    code, rout = rhino_run(e, "pneConvResult", files)
    rok = report("rhino", code, rout)
    nd = re.search(r"digest=([0-9a-f]{8})", last_line(nout))
    rd = re.search(r"digest=([0-9a-f]{8})", last_line(rout))
    same = bool(nd and rd and nd.group(1) == rd.group(1))
    if not same:
        print("  node and rhino digests differ")
    if not (nok and rok and same):
        print("FAIL hive-conversion-replay")
        return 1
    print(f"PASS join-before-leave conversions linked and replayed bit for bit in Node and Rhino (digest {nd.group(1)})")
    return 0


def mode_nbt(e):
    if not need_rhino(e):
        return SKIP
    srg = e["libs"]["mc_srg"]
    lr = libs_root(e)
    extra = [os.path.join(lr, *p.split("/")) for p in NBT_LIBS] if lr else []
    missing = [p for p in [srg] + extra if not p or not os.path.isfile(p)]
    if missing:
        print("SKIP: missing Minecraft libraries for NbtIo: " + ", ".join(str(m) for m in missing))
        return SKIP
    cls = pne_rhino.build(e, [os.path.join(ROOT, "tools", "genome", "test", "NbtSizeTest.java"),
                              os.path.join(ROOT, "tools", "rhino", "PneRhino.java")], "pnehivenbt")
    tmp = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
    os.makedirs(tmp, exist_ok=True)
    cp = pne_rhino.rhino_classpath(e, [cls, srg] + extra)
    files = [os.path.join(ROOT, f) for f in [MOCKS, PRELUDE, CORE, GA, HIVE, "tools/hive/nbt_max.js"]]
    r = subprocess.run([e["jdk"]["java"], "-cp", cp, "NbtSizeTest", tmp] + files, capture_output=True, text=True, timeout=900, cwd=ROOT)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    print(out)
    return 0 if r.returncode == 0 and last_line(out).startswith("PASS") else 1


def mode_bench(e):
    if not need_rhino(e):
        return SKIP
    srg = e["libs"]["mc_srg"]
    lr = libs_root(e)
    extra = [os.path.join(lr, *p.split("/")) for p in NBT_LIBS] if lr else []
    missing = [p for p in [srg] + extra if not p or not os.path.isfile(p)]
    if missing:
        print("SKIP: missing Minecraft libraries: " + ", ".join(str(m) for m in missing))
        return SKIP
    cls = pne_rhino.build(e, [os.path.join(HERE, "HiveBench.java"), os.path.join(ROOT, "tools", "rhino", "PneRhino.java")], "pnehivebench")
    cp = pne_rhino.rhino_classpath(e, [cls, srg] + extra)
    files = [os.path.join(ROOT, f) for f in PACK + ["tools/hive/bench_world.js"]]
    r = subprocess.run([e["jdk"]["java"], "-cp", cp, "HiveBench", core_costs_arg()] + files, capture_output=True, text=True,
                       timeout=1800, cwd=ROOT)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    print(out)
    return 0 if r.returncode == 0 and last_line(out).startswith("PASS") else 1


def core_costs_arg():
    """PNE_CORE_COST from the shared core as 'key=value,...' (the constants the benchmark checks against)."""
    src = open(os.path.join(ROOT, CORE), encoding="utf-8").read()
    block = src[src.index("var PNE_CORE_COST = {"):]
    block = block[:block.index("}")]
    return ",".join(f"{m.group(1)}={m.group(2)}" for m in re.finditer(r"(\w+):\s*([0-9.]+)", block))


def main(argv):
    modes = {"node": mode_node, "rhino": mode_rhino, "kmercy": mode_kmercy, "conv": mode_conv, "nbt": mode_nbt, "bench": mode_bench}
    if len(argv) >= 2 and argv[1] == "hard-record":
        return mode_hard_record(pne_rhino.env(), "--force" in argv[2:])
    if len(argv) < 2 or argv[1] not in modes:
        print(__doc__)
        return 2
    e = pne_rhino.env()
    return modes[argv[1]](e)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
