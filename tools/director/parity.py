"""
Suite director-parity: the director's pure core must give identical results in Python (tools/director/director.py),
Node (pne_resonance.js through tools/director/parity_js.js) and the instance's real Rhino jar
(tools/director/parity_rhino.js through tools/rhino/pne_rhino.py), step for step: state, tier, spawn, aggression,
beckon, GA weight, governor, hard trigger, and e (exactly equal as IEEE doubles).

    python tools/director/parity.py

Inputs are deterministic synthetic 1 Hz traces (calm stretches, approaches, fights with damage, flee spikes, mercy
and grace episodes, stale and low-confidence verdicts, hive-death counts) plus edge cases at the thresholds. Files
go to PNE_TMP only. Rhino is skipped (reported, not failed) when the toolchain is missing; Node is required.

The shipped Python port is also checked against the measured TDD prototype itself (tools/director/proto_director.py,
vendored unchanged): on traces written in the prototype's own input format (Oracle stress probabilities, the
low-confidence teacher blend, P(flee), health, respawn and death events), the shipped FSM must give the same state,
the same e (bit for bit) and the same spawn multiplier at every step, and the same aggression outside respawn grace
(v1.1 also caps aggression at 0.8 in grace: the one documented difference).
"""
import json
import os
import random
import subprocess
import sys
import tempfile

sys.dont_write_bytecode = True   # tests write nothing into the repo (no __pycache__)

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import director as D  # noqa: E402
import proto_director as PROTO  # noqa: E402

FIELDS = ["state", "tier", "raw", "spawn", "aggro", "beckon", "ga", "gov", "hard", "e"]


def proto_trace(seed, steps):
    """Prototype-format inputs: Oracle stress probabilities (sometimes below the 0.45 confidence floor), the teacher
    stress level (0..3), flee/engage probabilities, health, nearest parasite, damage age, respawn and death events."""
    r = random.Random(seed)
    out = []
    lvl, near, hp, tsd = 0.0, 32.0, 1.0, 600.0
    mode, left = "calm", 0
    for _ in range(steps):
        if left <= 0:
            u = r.random()
            mode = "calm" if u < 0.4 else "approach" if u < 0.6 else "fight" if u < 0.78 else "flee" if u < 0.86 else "lull"
            left = 8 + int(r.random() * 80)
        left -= 1
        target = {"calm": 0.0, "approach": 1.75, "fight": 2.4, "flee": 2.9, "lull": 0.9}[mode]
        lvl += (target - lvl) * 0.25
        if mode == "fight":
            near = 1 + r.random() * 4
            if r.random() < 0.3:
                tsd = 0.0
                hp = max(0.05, hp - r.random() * 0.2)
        elif mode == "flee":
            near = 3 + r.random() * 6
        elif mode == "approach":
            near = max(5.0, near - 1.5)
        else:
            near = min(32.0, near + 2)
        tsd += 1
        if mode != "fight" and hp < 1:
            hp = min(1.0, hp + 0.02)
        # four-band stress distribution around lvl; sometimes flat (low confidence)
        w = [max(0.0, 1.0 - abs(lvl + (r.random() - 0.5) * 0.6 - k)) for k in range(4)]
        if r.random() < 0.2:
            w = [x + 0.8 for x in w]
        s = sum(w) or 1.0
        p = [x / s for x in w]
        fl = 0.5 + r.random() * 0.5 if mode == "flee" else r.random() * 0.55
        died = r.random() < 0.0008
        resp = died or r.random() < 0.0004
        if resp:
            hp = 1.0
        out.append(dict(stressP=p, teacherStress=int(r.random() * 4) if r.random() < 0.9 else min(3, int(lvl + 0.5)),
                        feP=[1 - fl - 0.1, fl, 0.1], health=hp, nearest=near, tSinceDamage=tsd, respawned=resp, died=died))
    return out


def proto_compare(traces):
    """Runs the vendored prototype and the shipped port on the same prototype-format traces."""
    total = diff = 0
    first = None
    for ti, tr in enumerate(traces):
        dp = PROTO.new()
        st = D.new_state()
        t = 0
        last_resp = -99999
        deaths = []
        for j, x in enumerate(tr):
            t += 1
            po = PROTO.step(dp, x)
            p = x["stressP"]
            if x["respawned"]:
                last_resp = t
            if x["died"]:
                deaths.append(t)
            while deaths and t - deaths[0] > 3600:
                deaths.pop(0)
            inp = dict(eo=(p[1] + 2 * p[2] + 3 * p[3]) / 3, conf=max(p), fresh=True, sh=x["teacherStress"] / 3,
                       theta=0.0, nearest=x["nearest"], tsd=x["tSinceDamage"], pflee=x["feP"][1],
                       mercy=x["health"] <= 0.30, grace=(t - last_resp) < 120, deaths1h=len(deaths))
            so = D.pure_step(st, inp)
            total += 1
            same = (po["state"] == so["state"] and po["e"] == so["e"] and po["spawn"] == so["spawn"]
                    and po["mercy"] == inp["mercy"] and po["grace"] == inp["grace"]
                    and (inp["grace"] or po["aggro"] == so["aggro"]))
            if not same:
                diff += 1
                if first is None:
                    first = "trace %d step %d: prototype %s vs shipped %s" % (
                        ti, j, [po["state"], po["e"], po["spawn"], po["aggro"]], [so["state"], so["e"], so["spawn"], so["aggro"]])
    return total, diff, first


def gen_trace(seed, steps):
    r = random.Random(seed)
    out = []
    near, tsd, hp, eo, grace, deaths = 32.0, 600.0, 1.0, 0.1, 0, 0
    mode, left = "calm", 0
    for _ in range(steps):
        if left <= 0:
            u = r.random()
            mode = "calm" if u < 0.35 else "approach" if u < 0.55 else "fight" if u < 0.8 else "flee" if u < 0.9 else "lull"
            left = 10 + int(r.random() * 90)
            if r.random() < 0.05:
                grace, hp, deaths = 120, 1.0, min(6, deaths + 1)
        left -= 1
        if mode == "calm":
            near = min(32.0, near + 2)
            eo += (0.08 - eo) * 0.2
        elif mode == "approach":
            near = max(6.0, near - 1.5)
            eo += (0.45 - eo) * 0.15
        elif mode == "fight":
            near = 1 + r.random() * 4
            eo += (0.85 - eo) * 0.3
            if r.random() < 0.3:
                tsd = 0.0
                hp = max(0.05, hp - r.random() * 0.15)
        elif mode == "flee":
            near = 3 + r.random() * 6
            eo += (0.95 - eo) * 0.4
        else:
            near = 12 + r.random() * 10
            eo += (0.3 - eo) * 0.1
        tsd += 1
        if mode != "fight" and hp < 1:
            hp = min(1.0, hp + 0.01)
        if grace > 0:
            grace -= 1
        if r.random() < 0.002:
            deaths = max(0, deaths - 1)
        conf = r.random() * 0.45 if r.random() < 0.15 else 0.45 + r.random() * 0.55
        fresh = r.random() > 0.1
        n16 = int(r.random() * 8) if near < 16 else 0
        light = int(r.random() * 16)
        prox = max(0.0, 1 - near / 32)
        out.append(dict(
            eo=max(0.0, min(1.0, eo + (r.random() - 0.5) * 0.1)), conf=conf, fresh=fresh,
            sh=min(1.0, 0.45 * prox + 0.2 * min(1.0, n16 / 8) + 0.15 * (1 - light / 15) + 0.2 * (1 - hp)),
            theta=min(1.0, 0.6 * prox + 0.25 * min(1.0, n16 / 8) + 0.15 * (1 - light / 15)),
            nearest=near, tsd=tsd, pflee=(0.5 + r.random() * 0.5 if mode == "flee" else r.random() * 0.5) if fresh else -1,
            mercy=hp <= 0.3, grace=grace > 0, deaths1h=deaths))
    return out


def edge_traces():
    base = dict(eo=0.0, conf=0.45, fresh=True, sh=0.0, theta=0.0, nearest=32.0, tsd=600.0, pflee=-1, mercy=False,
                grace=False, deaths1h=0)
    out = []
    for level in (0.25, 0.5, 0.75, 0.38, 0.15, 0.6):
        tr = []
        for t in range(400):
            x = dict(base)
            x["eo"] = level if (t // 50) % 2 == 0 else level - 1e-12
            x["theta"] = level
            x["conf"] = 0.45 if t % 3 else 0.4499999999
            x["nearest"] = 4.0 if t % 17 == 0 else (3.999999 if t % 19 == 0 else 20.0)
            x["tsd"] = 1.0 if t % 5 == 0 else 1.0000001
            x["pflee"] = 0.6 if t % 23 == 0 else 0.59999
            x["mercy"] = t % 97 == 0
            x["grace"] = 150 <= t < 170
            x["deaths1h"] = (t // 60) % 8
            tr.append(x)
        out.append(tr)
    return out


def run_py(traces):
    res = []
    for tr in traces:
        st = D.new_state()
        res.append([D.pure_step(st, x) for x in tr])
    return res


def norm(o):
    return [o["state"], int(o["tier"]), int(o["raw"]), float(o["spawn"]), float(o["aggro"]), bool(o["beckon"]),
            float(o["ga"]), float(o["gov"]), bool(o["hard"]), float(o["e"])]


def compare(name, a, b):
    total = 0
    diff = 0
    first = None
    for i, (ta, tb) in enumerate(zip(a, b)):
        if len(ta) != len(tb):
            return 0, 1, "%s: trace %d length %d vs %d" % (name, i, len(ta), len(tb))
        for j, (x, y) in enumerate(zip(ta, tb)):
            total += 1
            if norm(x) != norm(y):
                diff += 1
                if first is None:
                    first = "%s: trace %d step %d: %s vs %s" % (name, i, j, norm(x), norm(y))
    if len(a) != len(b):
        diff += 1
        first = first or "%s: %d vs %d traces" % (name, len(a), len(b))
    return total, diff, first


def main():
    tmp = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
    os.makedirs(tmp, exist_ok=True)
    traces = [gen_trace(1000 + s, 900) for s in range(40)] + edge_traces()
    py = run_py(traces)
    fin = os.path.join(tmp, "director_parity_in.json")
    fout = os.path.join(tmp, "director_parity_node.json")
    with open(fin, "w", encoding="utf-8") as f:
        json.dump(traces, f)
    node = os.environ.get("PNE_NODE") or "node"
    r = subprocess.run([node, os.path.join(HERE, "parity_js.js"), fin, fout], capture_output=True, text=True, cwd=ROOT)
    if r.returncode != 0:
        print(r.stdout + r.stderr)
        print("FAIL director-parity: node driver failed")
        return 1
    js = json.load(open(fout, encoding="utf-8"))
    total, diff, first = compare("node", py, js)
    lines = ["python vs node: %d/%d steps identical" % (total - diff, total)]
    ok = diff == 0 and total > 0
    if first:
        lines.append("  first difference " + first)
    # the shipped FSM against the measured TDD prototype (state, e bit for bit, spawn; aggression outside grace)
    pt, pd, pf = proto_compare([proto_trace(5000 + s, 1800) for s in range(24)])
    lines.append("python vs TDD prototype director.py: %d/%d steps identical" % (pt - pd, pt))
    if pf:
        lines.append("  first difference " + pf)
    ok = ok and pd == 0 and pt > 0
    # Rhino: the same driver in the instance's Rhino jar, on a subset (stdout carries the result)
    try:
        import pne_rhino
        e = pne_rhino.env()
        have_rhino = pne_rhino.ready(e)
    except SystemExit:
        have_rhino = False
    if have_rhino:
        sub = traces[:10] + traces[-6:]
        fjs = os.path.join(tmp, "director_parity_in.js")
        with open(fjs, "w", encoding="utf-8") as f:
            f.write("var PNE_PAR_IN = " + json.dumps(sub) + "\n")
        cmd = [sys.executable, os.path.join(ROOT, "tools", "rhino", "pne_rhino.py"), "run", "pneParResult",
               "tools/tests/kjs_mocks.js", "overrides/kubejs/server_scripts/pne_00_core.js",
               "tools/director/fixtures/empty_catalog.js", "overrides/kubejs/server_scripts/pne_resonance.js",
               fjs, "tools/director/parity_rhino.js"]
        r = subprocess.run(cmd, capture_output=True, text=True, cwd=ROOT, timeout=900)
        last = [ln for ln in r.stdout.splitlines() if ln.startswith("PASS ")]
        if r.returncode != 0 or not last:
            print(r.stdout[-3000:] + r.stderr[-2000:])
            lines.append("rhino driver failed")
            ok = False
        else:
            rh = json.loads(last[-1][5:])
            rh = [[dict(zip(FIELDS, [s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7], s[8], s[9]])) for s in tr] for tr in rh]
            t2, d2, f2 = compare("rhino", [py[i] for i in list(range(10)) + list(range(len(py) - 6, len(py)))], rh)
            lines.append("python vs rhino: %d/%d steps identical" % (t2 - d2, t2))
            if f2:
                lines.append("  first difference " + f2)
            ok = ok and d2 == 0 and t2 > 0
    else:
        lines.append("rhino: toolchain not found, Rhino parity not run")
    for ln in lines:
        print(ln)
    print(("PASS director-parity: 100%% identical over %d steps" % total) if ok else "FAIL director-parity")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
