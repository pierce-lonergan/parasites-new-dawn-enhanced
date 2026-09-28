"""
HIVE-RUNTIME test driver (the suites in tools/suites/hive.json).

    python tools/hive/run_hive.py node      hive-node: runtime tests on the shared mocks, in Node
    python tools/hive/run_hive.py rhino     hive-rhino: the same tests in the instance's Rhino jar (real HashMap global,
                                            real ArrayList queues)
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


def mode_node(e):
    code, out = node_run("pneHiveTestResult", PACK + ["tools/hive/test_hive.js"])
    if code is None:
        print("SKIP: node not found")
        return SKIP
    ok = report("node", code, out)
    print(last_line(out) if ok else "FAIL hive-node")
    return 0 if ok else 1


def mode_rhino(e):
    if not need_rhino(e):
        return SKIP
    code, out = rhino_run(e, "pneHiveTestResult", PACK + ["tools/hive/test_hive.js"])
    ok = report("rhino", code, out)
    print(last_line(out) if ok else "FAIL hive-rhino")
    return 0 if ok else 1


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
    if len(argv) < 2 or argv[1] not in modes:
        print(__doc__)
        return 2
    e = pne_rhino.env()
    return modes[argv[1]](e)


if __name__ == "__main__":
    sys.exit(main(sys.argv))
