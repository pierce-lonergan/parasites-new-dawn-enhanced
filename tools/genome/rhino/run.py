"""
GA-core cross-engine harness: the same ES5 files in Node and in the instance's real Rhino jar.

    python tools/genome/rhino/run.py golden        golden digest in Node and in Rhino, both against
                                                   tools/genome/test/golden_expected.json; the guard test also runs in Rhino
    python tools/genome/rhino/run.py replay        interleaved replay golden (random legal B/P/J/I/D/R/G orders) in Node
                                                   and in Rhino, both against golden_expected.json; then java_values.js in the
                                                   PneRhino harness (global, Java.loadClass): load/replay/join/outcome/dawn/
                                                   dreamSlice fed java.lang.String, Java Lists and boxed numbers
    python tools/genome/rhino/run.py bench         Rhino benchmark (warm JVM): per-call p50/p95/max of breed(), outcome(), the
                                                   first breed after load(), every dream step type, the first dream slice after
                                                   a mid-dream load(), dawn(), save(); each gated against the PNE_CORE_COST key
                                                   HIVE charges for it (a key missing from the core fails the suite);
                                                   breed+insert with and without the sharing-denominator cache; at the maximum
                                                   state (IMPLEMENTATION 4.1 limits) every step of the incremental save gated
                                                   against PNE_CORE_COST.gaSavePart, the charge of one HIVE save step (saveBegin,
                                                   each savePart piece type, and the last piece together with saveEnd, which
                                                   HIVE runs in the same step), an outcome while a save is registered (copy on
                                                   write), and save() in one call. Best of up to 3 trials (fresh JVMs), like
                                                   hive-rhino-bench: the machine may be shared with other suites, so every
                                                   timing gate takes its best trial, every trial must pass the state check, and
                                                   a further trial runs (after a pause) only while a gate is over its limit.
                                                   Before any trial, the gate wiring check of mode "gates" runs
    python tools/genome/rhino/run.py gates         gate wiring check, no JVM: synthetic timings through the bench's own gates;
                                                   every budgeted call must fail its gate just over the PNE_CORE_COST key the
                                                   contract (7.3) names for it and pass just under, and the last save piece
                                                   plus saveEnd must fit one gaSavePart together
    python tools/genome/rhino/run.py saveparts     tools/genome/test/test_save_parts.js in Node and in Rhino: the incremental save
                                                   (saveBegin/savePart/saveDone/saveEnd) against save() at saveBegin while the
                                                   state keeps changing, its edge cases, the LRU list of the baselines against a
                                                   reference model, the load epoch (ids, E event, replay, rollback uniqueness);
                                                   both engines must pass with the same digest
    python tools/genome/rhino/run.py eval EXPR FILE...   evaluate files in Rhino and print EXPR (debugging)

JDK 17 is pinned through tools/rhino/pne_rhino.py (PNE_JDK17, default C:\\Program Files\\Java\\jdk-17.0.15+6; the javac
on PATH may be Java 8, which cannot compile against the class-version-61 Rhino jar). The Rhino jar and its libraries come
from the CurseForge instance (PNE_INSTANCE, PNE_MC_LIBS). Classes are compiled into the system temp folder, never into the
repo. Exit code 77 means the toolchain is missing (run_tests.py reports SKIP).
"""
import json
import re
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import pne_rhino  # noqa: E402

CORE = os.path.join(ROOT, "overrides", "kubejs", "server_scripts", "pne_hive_core.js")
TEST = os.path.join(ROOT, "tools", "genome", "test")
EXPECTED = os.path.join(TEST, "golden_expected.json")
SKIP = 77


def rhino(e, expr, files, main="RhinoRun", timeout=900):
    cls = pne_rhino.build(e, [os.path.join(HERE, "KubeFilter.java"), os.path.join(HERE, "RhinoRun.java"),
                              os.path.join(HERE, "RhinoGolden.java")], "pnegenome")
    args = ([expr] if expr is not None else []) + files
    if main == "RhinoGolden":
        args = ["bench"] + files
    r = pne_rhino.run_java(e, cls, main, args, timeout=timeout)
    out = (r.stdout or "") + (r.stderr or "")
    return r.returncode, out.strip()


def node(args, timeout=900):
    exe = shutil.which("node")
    if not exe:
        return None, "node not found"
    r = subprocess.run([exe] + args, capture_output=True, text=True, timeout=timeout, cwd=ROOT)
    return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()


def last_line(out):
    lines = [ln for ln in out.splitlines() if ln.strip()]
    return lines[-1].strip() if lines else ""


def expected():
    return json.load(open(EXPECTED, encoding="utf-8"))


def compare(label, got, want):
    bad = []
    g = dict(kv.split("=", 1) for kv in got.split(";") if "=" in kv)
    for k, v in want.items():
        if g.get(k) != v:
            bad.append(f"{label}: {k} = {g.get(k)!r}, expected {v!r}")
    return bad


def mode_golden(e):
    want = expected()["golden"]
    bad = []
    code, out = node([os.path.join(TEST, "golden.js")])
    if code is None:
        print("SKIP: node not found")
        return SKIP
    node_digest = last_line(out)
    print("node : " + node_digest)
    if code:
        bad.append("node golden.js failed: " + out[-500:])
    bad += compare("node", node_digest, want)
    code, out = rhino(e, "pneGoldDigestStr", [CORE, os.path.join(TEST, "sim_hive.js"), os.path.join(TEST, "golden.js")])
    rh_digest = last_line(out)
    print("rhino: " + rh_digest)
    if code:
        bad.append("rhino golden failed: " + out[-500:])
    bad += compare("rhino", rh_digest, want)
    if node_digest != rh_digest:
        bad.append("node and rhino digests differ")
    code, out = rhino(e, "pneGuardResult", [CORE, os.path.join(TEST, "test_guard.js")])
    print("rhino guard: " + last_line(out))
    if code or not last_line(out).startswith("PASS"):
        bad.append("guard test in rhino: " + out[-800:])
    for b in bad:
        print("  " + b)
    if bad:
        print(f"FAIL golden parity ({len(bad)} problem(s))")
        return 1
    print(f"PASS golden digests identical in Node and Rhino ({len(want)} keys) and equal to golden_expected.json")
    return 0


def mode_replay(e):
    want = expected()["replay"]
    bad = []
    code, out = node([os.path.join(TEST, "replay_golden.js")])
    if code is None:
        print("SKIP: node not found")
        return SKIP
    nl = last_line(out)
    print("node : " + nl)
    if code or not nl.startswith("PASS"):
        bad.append("node replay: " + out[-800:])
    code, out = rhino(e, "pneRepResult", [CORE, os.path.join(TEST, "replay_golden.js")])
    rl = last_line(out)
    print("rhino: " + rl)
    if code or not rl.startswith("PASS"):
        bad.append("rhino replay: " + out[-800:])
    nd = nl.split(" digest=")[-1].split(" ")[0] if " digest=" in nl else ""
    rd = rl.split(" digest=")[-1].split(" ")[0] if " digest=" in rl else ""
    if nd != want or rd != want:
        bad.append(f"replay digest node={nd} rhino={rd} expected={want}")
    # The same entry points fed what HIVE really passes in game (F6): java.lang.String logs and save strings, Java
    # Lists, int[] and boxed numbers. RhinoRun has no global and no Java access, so this runs in the PneRhino harness.
    r = pne_rhino.run_java(e, pne_rhino.harness(e), "PneRhino", ["run", "pneJvResult", CORE, os.path.join(TEST, "java_values.js")], timeout=600)
    jl = last_line((r.stdout or "") + (r.stderr or ""))
    print("rhino java-typed inputs: " + jl)
    if r.returncode or not jl.startswith("PASS"):
        bad.append("java-typed inputs: " + ((r.stdout or "") + (r.stderr or ""))[-800:])
    for b in bad:
        print("  " + b)
    if bad:
        print(f"FAIL replay golden ({len(bad)} problem(s))")
        return 1
    print(f"PASS interleaved replay golden identical in Node and Rhino (digest {want}); Java-typed inputs replay and match in Rhino")
    return 0


def mode_saveparts(e):
    code, out = node([os.path.join(TEST, "test_save_parts.js")])
    if code is None:
        print("SKIP: node not found")
        return SKIP
    nl = last_line(out)
    print("node : " + nl)
    bad = []
    if code or not nl.startswith("PASS"):
        bad.append("node: " + out[-800:])
    code, out = rhino(e, "pneSpResult", [CORE, os.path.join(TEST, "test_save_parts.js")])
    rl = last_line(out)
    print("rhino: " + rl)
    if code or not rl.startswith("PASS"):
        bad.append("rhino: " + out[-800:])
    nd = nl.split(" digest=")[-1].split(" ")[0] if " digest=" in nl else ""
    rd = rl.split(" digest=")[-1].split(" ")[0] if " digest=" in rl else ""
    if not nd or nd != rd:
        bad.append(f"digests differ: node {nd!r}, rhino {rd!r}")
    for b in bad:
        print("  " + b)
    if bad:
        print(f"FAIL incremental save, epoch and LRU list ({len(bad)} problem(s))")
        return 1
    print(f"PASS incremental save, epoch and LRU list identical in Node and Rhino (digest {nd}): " + nl[len("PASS "):].split(" digest=")[0])
    return 0


def core_costs():
    """PNE_CORE_COST values from the shared core (the budget the GA work is charged against)."""
    src = open(os.path.join(ROOT, "overrides", "kubejs", "server_scripts", "pne_00_core.js"), encoding="utf-8").read()
    block = src[src.index("var PNE_CORE_COST = {"):]
    block = block[:block.index("}")]
    out = {}
    for m in re.finditer(r"(\w+):\s*([0-9.]+)", block):
        out[m.group(1)] = float(m.group(2))
    return out


# Every gate uses the PNE_CORE_COST key HIVE charges for the call (IMPLEMENTATION 7.3 lists all of them, outcome, dawn,
# gaSave and gaSavePart included). A key missing from the core fails the suite instead of falling back to a proposed
# value: GA-CORE's earlier proposed outcome 0.7 was twice the constant HIVE charges, so a fallback would loosen a gate.

# Step types of the incremental save (bench case savepart_one), each gated against PNE_CORE_COST.gaSavePart: HIVE runs
# one step per free save slot and charges it gaSavePart (pne_hive.js pneHiveSaveStepCost; the first step, saveBegin,
# is charged gaSavePart plus one `save` for HIVE's own runtime string, which hive-rhino-bench gates as saveStart).
# The last piece (the log is always last: pne_hive_core.js saveDone) and saveEnd run in the same HIVE step
# (pneHiveSavePart), so SAVE_LAST gates the sum of their p95 against one gaSavePart as well.
PART_TYPES = ("begin", "pool", "queue", "state", "samples", "base", "log", "end")
SAVE_LAST = ("log", "end")
# Dream step types (bench case dream_one) and the cases every trial must report (bench_breed.js).
DREAM_STEPS = ("score", "elite", "pairs", "share", "kids", "insert")
CASES_NEEDED = ("breed_one", "outcome_one", "breed_first_one", "dream_one", "dream_first_one", "dawn_one", "save_one",
                "breed_insert", "breed_insert_nocache", "join_pop", "express", "savemax_one", "savepart_one",
                "outcome_max_one", "outcome_saving_one")
# Largest p50 an outcome() may gain while an incremental save is registered (the copy on write of a baseline: 4 numbers).
COW_MAX = 0.03


# Timing trials, as in hive-rhino-bench: the machine may be shared with other test suites, and one contended trial can
# push a tail percentile over its constant (seen once: outcome() p95 over PNE_CORE_COST.outcome under full-suite load).
# So the benchmark runs in up to TRIALS fresh JVMs and every timing gate is judged on its best trial; a regression in the
# code shows in every trial, contention does not. Every trial must pass the workload's own state check (bench state,
# cache consistency, incremental saves equal to save(): correctness is never retried away). A further trial runs only
# while some gate is over its limit in every trial so far, which gives the verdict of running all TRIALS (a best can
# only get lower). A repeat waits TRIAL_PAUSE first, so a burst of load from another process (a JVM warming up, a render)
# can pass instead of landing on all three back-to-back trials. The trials do not change the gates: per-call p95 against
# the PNE_CORE_COST key HIVE charges, the heaviest dream step type, every incremental save step within gaSavePart, copy
# on write within +COW_MAX, the sharing cache more than x2.
# Load that saturates the machine for the whole run still fails (it slows every call): the output then shows every
# trial's gates over their limits.
TRIALS = 3
TRIAL_PAUSE = (20, 40)  # seconds before trial 2 and trial 3; nothing waits when trial 1 passes
# One trial takes about 15 s; three trials at this limit plus the pauses stay inside the suite's 1800 s timeout
# (tools/suites/ga-core.json).
TRIAL_TIMEOUT = 540


def gate(gates, gid, what, p95, key, cost):
    """One per-call p95 against the PNE_CORE_COST key HIVE charges for that call; KeyError when the core lacks the key."""
    if key not in cost:
        raise KeyError(f"PNE_CORE_COST has no key {key!r} (IMPLEMENTATION 7.3)")
    limit = cost[key]
    src = "PNE_CORE_COST." + key
    gates[gid] = {"value": p95, "ok": not p95 > limit,
                  "note": f"{what} p95 {p95:.3f} ms vs {src} {limit}",
                  "bad": f"{what} p95 {p95:.3f} ms exceeds {src} {limit}"}


def recommend(p95):
    """Smallest 0.1 ms step with at least 30% headroom over a measured per-call p95."""
    return float(int(p95 * 1.3 * 10 + 0.999999)) / 10


def bench_trial(e):
    """One run of bench_breed.js in a fresh JVM: (output, cases, dream steps, save steps, problems)."""
    code, out = rhino(e, None, [CORE, os.path.join(TEST, "bench_breed.js")], main="RhinoGolden", timeout=TRIAL_TIMEOUT)
    cases = {}
    steps = {}
    parts = {}
    if code or not last_line(out).startswith("PASS"):
        return out, cases, steps, parts, ["the benchmark run or its state check failed"]
    num = r"mean_ms=([0-9.]+) p50_ms=([0-9.]+) p95_ms=([0-9.]+) max_ms=([0-9.]+) units=\d+ reps=(\d+)"
    for m in re.finditer(r"^case (\w+) " + num, out, re.M):
        cases[m.group(1)] = tuple(float(m.group(i)) for i in range(2, 6))
    for m in re.finditer(r"^step dream_one (\w+) " + num, out, re.M):
        steps[m.group(1)] = tuple(float(m.group(i)) for i in range(2, 6))
    for m in re.finditer(r"^step savepart_one (\w+) " + num, out, re.M):
        parts[m.group(1)] = tuple(float(m.group(i)) for i in range(2, 6)) + (int(m.group(6)),)
    bad = []
    for k in CASES_NEEDED:
        if k not in cases:
            bad.append("missing case " + k)
    for k in DREAM_STEPS:
        if k not in steps:
            bad.append("missing dream step type " + k)
    for k in PART_TYPES:
        if k not in parts:
            bad.append("missing incremental save step " + k)
    return out, cases, steps, parts, bad


def trial_gates(cases, steps, parts, cost):
    """Every timing gate of one trial, in report order: {id: {value, ok, note, bad}}; a lower value is always better."""
    gates = {}
    # Each budgeted call is gated on its own per-call p95 against the constant HIVE charges for it (7.2/7.3):
    # breed() on the breed tick, outcome() in the leave drain, one dream slice on a dream tick. A dream slice is charged
    # one fixed constant whatever its step type, so the heaviest step type of the trial decides. The first breed and the
    # first dream slice after load() must fit too (load builds the derived data).
    gate(gates, "breed", "breed()", cases["breed_one"][2], "breed", cost)
    gate(gates, "breed_first", "first breed() after load()", cases["breed_first_one"][2], "breed", cost)
    gate(gates, "outcome", "outcome()", cases["outcome_one"][2], "outcome", cost)
    heavy = max(steps, key=lambda k: (steps[k][2], k))
    gate(gates, "dream", f"dream slice (heaviest step type '{heavy}')", steps[heavy][2], "dreamSlice", cost)
    gates["dream"]["step"] = heavy
    gate(gates, "dream_first", "first dream slice after a mid-dream load()", cases["dream_first_one"][2], "dreamSlice", cost)
    gate(gates, "dawn", "dawn()", cases["dawn_one"][2], "dawn", cost)
    gate(gates, "save", "save()", cases["save_one"][2], "gaSave", cost)
    # The incremental save at the maximum state: HIVE runs one step per free save slot and charges it gaSavePart, so
    # every step type (saveBegin, each savePart piece type, saveEnd) must fit one gaSavePart on its own (the base and
    # samples steps repeat per slice), and the last piece with saveEnd, which share one HIVE step, must fit it together.
    for k in PART_TYPES:
        gate(gates, "part_" + k, f"incremental save step '{k}' at the maximum state ({parts[k][4]} calls)", parts[k][2], "gaSavePart", cost)
    gate(gates, "part_last", f"last incremental save step at the maximum state (piece '{SAVE_LAST[0]}' then saveEnd in one "
         f"HIVE step, sum of both)", sum(parts[k][2] for k in SAVE_LAST), "gaSavePart", cost)
    # save() in one call at the maximum state (server stop, pillar switch-off) fits the one-call save constant too.
    gate(gates, "savemax", "save() in one call at the maximum state", cases["savemax_one"][2], "gaSave", cost)
    # Copy on write must not make an outcome dearer: the same outcomes at the maximum state with and without a registered
    # save (a fresh registration every 16 outcomes, so about half of them copy a baseline first), compared within one
    # trial. The absolute p95 at the maximum state (long ids and context keys) is reported against the outcome constant,
    # not gated: it sits near that constant with or without a save.
    cow = cases["outcome_saving_one"][1] - cases["outcome_max_one"][1]
    gates["cow"] = {
        "value": cow, "ok": not cow > COW_MAX,
        "note": (f"copy on write: outcome() p50 {cases['outcome_saving_one'][1]:.3f} ms with a registered save vs "
                 f"{cases['outcome_max_one'][1]:.3f} without ({cow:+.3f}, limit +{COW_MAX}); p95 {cases['outcome_saving_one'][2]:.3f} / "
                 f"{cases['outcome_max_one'][2]:.3f} at the maximum state vs PNE_CORE_COST.outcome {cost['outcome']} (reported)"),
        "bad": f"copy on write adds {cow:.3f} ms to an outcome (limit {COW_MAX})"}
    # The sharing-denominator cache pays off: breed+insert p50 with the cache under half of the same without it (one trial).
    bi, bn = cases["breed_insert"][1], cases["breed_insert_nocache"][1]
    gates["cache"] = {
        "value": bi / bn if bn > 0 else float("inf"), "ok": bn > 2 * bi, "bi": bi, "bn": bn,
        "note": f"sharing cache: breed+insert p50 {bi:.3f} ms with the cache vs {bn:.3f} without (x{bn / bi if bi > 0 else 0:.1f}, must exceed x2)",
        "bad": f"the sharing cache does not pay off (breed+insert p50 {bi:.3f} ms with it vs {bn:.3f} without)"}
    return gates


# The budget of every timed call as the contract states it (IMPLEMENTATION 7.3 "Used for", and HIVE's charges), written
# out here instead of read back from trial_gates, so a gate wired to a looser key fails the wiring check:
# (table, name, PNE_CORE_COST key). A dream slice is one dreamSlice whatever its step type; saveBegin, every savePart piece
# and saveEnd are one gaSavePart step each; save() is gaSave, in one call at the maximum state too.
GATE_SPEC = ([("case", "breed_one", "breed"), ("case", "breed_first_one", "breed"), ("case", "outcome_one", "outcome")] +
             [("step", k, "dreamSlice") for k in DREAM_STEPS] + [("case", "dream_first_one", "dreamSlice")] +
             [("case", "dawn_one", "dawn"), ("case", "save_one", "gaSave"), ("case", "savemax_one", "gaSave")] +
             [("part", k, "gaSavePart") for k in PART_TYPES])


def gate_selftest(cost):
    """Gate wiring check with synthetic timings through trial_gates (no JVM): (number of checks, problems).
    Every timed call must fail its gate 1% over the key GATE_SPEC names and pass 1% under it (a looser key lets the
    first through, a tighter one fails the second); the last save piece and saveEnd, each within gaSavePart, must fail
    together over it; copy on write over +COW_MAX and a sharing cache under x2 must fail."""
    probs = []
    checks = [0]

    def over(times, p50=None):
        """Gate ids over their limit for all-zero timings with the given (table, name) -> p95 (or p50) overrides."""
        tabs = {"case": {k: (0.0, 0.0, 0.0, 0.0) for k in CASES_NEEDED},
                "step": {k: (0.0, 0.0, 0.0, 0.0) for k in DREAM_STEPS},
                "part": {k: (0.0, 0.0, 0.0, 0.0, 60) for k in PART_TYPES}}
        tabs["case"]["breed_insert"] = (1.0, 1.0, 1.0, 1.0)
        tabs["case"]["breed_insert_nocache"] = (3.0, 3.0, 3.0, 3.0)
        for (tab, name), v in times.items():
            row = tabs[tab][name]
            tabs[tab][name] = row[:2] + (v,) + row[3:]
        for (tab, name), v in (p50 or {}).items():
            row = tabs[tab][name]
            tabs[tab][name] = row[:1] + (v,) + row[2:]
        checks[0] += 1
        g = trial_gates(tabs["case"], tabs["step"], tabs["part"], cost)
        return sorted(gid for gid, x in g.items() if not x["ok"])

    try:
        base = over({})
        if base:
            probs.append("all-zero timings fail gate(s) " + ", ".join(base))
        for tab, name, key in GATE_SPEC:
            if key not in cost:
                probs.append(f"PNE_CORE_COST has no key {key!r} for {name}")
                continue
            lim = cost[key]
            if not over({(tab, name): lim * 1.01}):
                probs.append(f"{name} p95 1% over PNE_CORE_COST.{key} {lim} passes every gate (gated against a looser key)")
            under = over({(tab, name): lim * 0.99})
            if under:
                probs.append(f"{name} p95 1% under PNE_CORE_COST.{key} {lim} fails gate(s) {', '.join(under)}")
        if "gaSavePart" in cost:
            lim = cost["gaSavePart"]
            if over({("part", k): lim * 0.6 for k in SAVE_LAST}) != ["part_last"]:
                probs.append(f"pieces {' + '.join(SAVE_LAST)} at 0.6 x gaSavePart each (one HIVE step, 1.2 x together) "
                             "do not fail exactly the last-step gate")
            if over({("part", k): lim * 0.49 for k in SAVE_LAST}):
                probs.append(f"pieces {' + '.join(SAVE_LAST)} at 0.49 x gaSavePart each (0.98 x together) fail a gate")
        if over({}, {("case", "outcome_saving_one"): COW_MAX * 1.5}) != ["cow"]:
            probs.append(f"copy on write +{COW_MAX * 1.5:.3f} ms does not fail exactly the copy-on-write gate")
        if over({}, {("case", "breed_insert_nocache"): 1.9}) != ["cache"]:
            probs.append("a sharing cache worth x1.9 does not fail exactly the cache gate")
    except KeyError as err:
        probs.append("gate wiring: " + str(err.args[0] if err.args else err))
    return checks[0], probs


def mode_gates(cost=None):
    """The gate wiring check on its own (no JVM); ga-core-breed-bench runs it before its trials."""
    cost = core_costs() if cost is None else cost
    n, probs = gate_selftest(cost)
    for p in probs:
        print("  " + p)
    if probs:
        print(f"FAIL gate wiring ({len(probs)} problem(s) in {n} synthetic runs)")
        return 1
    print(f"PASS gate wiring: {n} synthetic runs; each of {len(GATE_SPEC)} timed calls fails its gate 1% over its PNE_CORE_COST "
          f"key and passes 1% under it (every incremental save step against gaSavePart {cost['gaSavePart']}); the last piece "
          f"with saveEnd fails over one gaSavePart together; copy on write and the sharing cache gates trip")
    return 0


def mode_bench(e):
    cost = core_costs()
    if mode_gates(cost):
        return 1
    best = {}
    runs = []
    for t in range(1, TRIALS + 1):
        if t > 1:
            print(f"a timing gate is over its limit in every trial so far: waiting {TRIAL_PAUSE[t - 2]} s before trial {t}", flush=True)
            time.sleep(TRIAL_PAUSE[t - 2])
        out, cases, steps, parts, bad = bench_trial(e)
        print(f"--- trial {t} (up to {TRIALS}) ---")
        print(out)
        if bad:
            print(f"FAIL breed benchmark, trial {t}: " + "; ".join(bad))
            return 1
        gates = trial_gates(cases, steps, parts, cost)
        over = [g["bad"] for g in gates.values() if not g["ok"]]
        print(f"trial {t}: " + ("every timing gate within its limit" if not over else
                                f"{len(over)} timing gate(s) over the limit in this trial: " + "; ".join(over)))
        runs.append((cases, steps, parts))
        for gid, g in gates.items():
            if gid not in best or g["value"] < best[gid][1]["value"]:
                best[gid] = (t, g)
        if all(g["ok"] for _, g in best.values()):
            break
    n = len(runs)

    def low(idx):
        """Per-value best (lowest) of every trial, for the information lines."""
        return {k: tuple(min(r[idx][k][j] for r in runs) for j in range(len(v))) for k, v in runs[0][idx].items()}

    cases, steps, parts = low(0), low(1), low(2)
    b = {gid: g for gid, (_, g) in best.items()}
    rec = {
        "breed": recommend(max(b["breed"]["value"], b["breed_first"]["value"])),
        "outcome": recommend(b["outcome"]["value"]),
        "dreamSlice": recommend(max(b["dream"]["value"], b["dream_first"]["value"])),
        "dawn": recommend(b["dawn"]["value"]),
        "gaSave": recommend(b["save"]["value"]),
        "gaSavePart": recommend(max(b["part_" + k]["value"] for k in PART_TYPES + ("last",))),
    }
    heavy_part = max(PART_TYPES, key=lambda k: (b["part_" + k]["value"], k))
    tag = f"best of {n} trial(s)"
    print(f"dream step types (per-call p50 / p95 ms, {tag} per value): " +
          ", ".join(f"{k} {steps[k][1]:.3f} / {steps[k][2]:.3f}" for k in DREAM_STEPS))
    print(f"incremental save steps at the maximum state (per-call p50 / p95 / max ms, {tag} per value): " +
          ", ".join(f"{k} {parts[k][1]:.3f} / {parts[k][2]:.3f} / {parts[k][3]:.3f}" for k in PART_TYPES) +
          f"; save() in one call p50 {cases['savemax_one'][1]:.3f} / p95 {cases['savemax_one'][2]:.3f} / max {cases['savemax_one'][3]:.3f}" +
          f"; outcome() at the maximum state p50 {cases['outcome_max_one'][1]:.3f} / p95 {cases['outcome_max_one'][2]:.3f}, while a save is registered p50 "
          f"{cases['outcome_saving_one'][1]:.3f} / p95 {cases['outcome_saving_one'][2]:.3f}")
    print(f"recommended PNE_CORE_COST (p95 + 30% headroom, 0.1 ms steps; {tag} per gate): " + ", ".join(f"{k} {v}" for k, v in rec.items()))
    print(f"timing gates ({tag}, up to {TRIALS}; each gate judged on its best trial, every trial passed the state check):")
    for gid, (t, g) in best.items():
        print("  " + g["note"] + (f" [trial {t}]" if n > 1 else ""))
    summary = (f"breed() p50 {cases['breed_one'][1]:.3f} / p95 {b['breed']['value']:.3f} ms; outcome() p50 {cases['outcome_one'][1]:.3f} / "
               f"p95 {b['outcome']['value']:.3f}; first breed after load p95 {b['breed_first']['value']:.3f}; dream slice heaviest "
               f"step '{b['dream']['step']}' p95 {b['dream']['value']:.3f}, first slice after a mid-dream load p95 {b['dream_first']['value']:.3f}; "
               f"dawn p95 {b['dawn']['value']:.3f}; save p95 {b['save']['value']:.3f}; max-state incremental save: heaviest step "
               f"'{heavy_part}' p95 {b['part_' + heavy_part]['value']:.3f}, last step ({' + '.join(SAVE_LAST)}) "
               f"{b['part_last']['value']:.3f} (every step <= gaSavePart {cost['gaSavePart']}), one-call save "
               f"p95 {b['savemax']['value']:.3f}; breed+insert p50 {b['cache']['bi']:.3f} with the sharing cache "
               f"vs {b['cache']['bn']:.3f} without (x{b['cache']['bn'] / b['cache']['bi']:.1f}); join {cases['join_pop'][1]:.3f}; "
               f"express {cases['express'][1]:.4f}; timing {tag}")
    bad = [g["bad"] for _, g in best.values() if not g["ok"]]
    if bad:
        print(f"FAIL (over the limit in all {n} trials) " + "; ".join(bad) + " | " + summary)
        return 1
    print("PASS " + summary)
    return 0


def main(argv):
    if len(argv) < 2 or argv[1] not in ("golden", "replay", "bench", "gates", "saveparts", "eval"):
        print(__doc__)
        return 2
    if argv[1] == "gates":
        return mode_gates()
    e = pne_rhino.env()
    if not pne_rhino.ready(e):
        print("SKIP: JDK 17, the instance's Rhino jar or its libraries were not found (set PNE_JDK17 / PNE_INSTANCE / PNE_MC_LIBS)")
        return SKIP
    if argv[1] == "golden":
        return mode_golden(e)
    if argv[1] == "replay":
        return mode_replay(e)
    if argv[1] == "bench":
        return mode_bench(e)
    if argv[1] == "saveparts":
        return mode_saveparts(e)
    code, out = rhino(e, argv[2], argv[3:])
    print(out)
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv))
