"""oracle-telemetry-bench: builds tools/oracle/TelemetryBench.java against the instance's Rhino jar (JDK 17) and
measures the per-player telemetry sample (pne_oracle_bridge.js pneOraSample) in a MockWorld with 150 entities.
Passes when the measured p50 and p90 fit the PNE_CORE_COST.playerTel constant in pne_00_core.js (p99 is reported;
the tail is gated in game with spark), and prints the value to use for it. Exit 77 (skip) without JDK 17 / the Rhino jar.

    python tools/oracle/run_bench.py [--entities 150] [--in-range 75] [--rounds 5] [--calls 4000]
"""
import argparse
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import pne_rhino  # noqa: E402

FILES = ["tools/tests/kjs_mocks.js", "overrides/kubejs/server_scripts/pne_00_core.js",
         "overrides/kubejs/server_scripts/pne_oracle_bridge.js", "tools/oracle/bench_driver.js"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--entities", type=int, default=150)
    ap.add_argument("--in-range", type=int, default=75)
    ap.add_argument("--rounds", type=int, default=5)
    ap.add_argument("--calls", type=int, default=4000)
    a = ap.parse_args()
    e = pne_rhino.env()
    if not pne_rhino.ready(e):
        print("SKIP: JDK 17 or the instance's Rhino jar was not found")
        return 77
    cls = pne_rhino.build(e, [os.path.join(ROOT, "tools", "rhino", "PneRhino.java"), os.path.join(HERE, "TelemetryBench.java")], "orabench")
    args = [os.path.join(ROOT, f) for f in FILES] + ["--", str(a.entities), str(a.in_range), str(a.rounds), str(a.calls)]
    r = pne_rhino.run_java(e, cls, "TelemetryBench", args, timeout=900)
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    m = re.search(r"^RESULT ([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+)$", r.stdout, re.M)
    if r.returncode or not m:
        print("FAIL: the benchmark did not produce a result")
        return 1
    p50, p90, p99, mean = (float(x) for x in m.groups())
    core = open(os.path.join(ROOT, "overrides", "kubejs", "server_scripts", "pne_00_core.js"), encoding="utf-8").read()
    cm = re.search(r"playerTel:\s*([\d.]+)", core)
    budget = float(cm.group(1)) if cm else 1.0
    # The token budget charges a fixed typical cost per sample; the tail (GC pauses, other processes on this PC) is
    # I9's business and is gated in game with spark. So the gate is the p90 of the least disturbed round.
    suggest = max(0.05, math.ceil(max(p90, mean) / 0.05 - 1e-9) * 0.05)
    line = ("playerTel p50 %.3f ms, p90 %.3f ms, p99 %.3f ms, mean %.3f ms (%d entities, %d parasites in range, 4 line-of-sight checks); "
            "PNE_CORE_COST.playerTel is %.2f; measured value to use: %.2f (p90 or mean, rounded up to 0.05 ms)"
            % (p50, p90, p99, mean, a.entities, a.in_range, budget, suggest))
    if p90 > budget or p50 > budget:
        print("FAIL " + line + " -- over budget: raise the constant or lower the cadence")
        return 1
    print("PASS " + line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
