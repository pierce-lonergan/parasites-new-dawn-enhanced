"""
Suite director-closed-loop: closed-loop simulation of the shipped director logic (tools/director/director.py, the
parity-checked port of pne_resonance.js) with simulated players, the Oracle MLP online, audio feeding back into the
players' arousal, and natural hive spawns the director does not schedule. Port of the measured prototype
final/cl/closed_loop2.py (TDD 2.5.4-2.5.5, Appendix B), with the v1.1 heuristic S_H as the fusion partner.

    python tools/director/closed_loop2.py [--quick]

Runs (150 simulated players x 1 h each, seed 21, synthetic): no director; v1.1 at k = 0 and k = 0.3; k = 0.15 with a
60% natural-spawn share ungated and gated (deny with probability 1 - min(1, m), the startup gate's rule).
Gates (TDD 6.3 closed loop): at a 60% natural share the gate must work, not merely stay under a loose bound:
gated deaths/hr <= 1.10 (TDD 2.5.5 measured 1.03) and at least 0.10 below the ungated run (TDD: 1.37 -> 1.03);
with k = 0.3 the mean arousal rises by <= 0.04 over k = 0, and dread-level audio outside encounters is at most
0.01% of the time as a raw fraction (the TDD's "0.0%"; the residue is the 10 s DREAD exit hold on theta right after
an encounter ends); repeat deaths ~ 0; encounters >= 85% of the no-director figure; state flips <= 1.5/min;
PANIC <= 45 s.
Needs numpy. Writes nothing (results are printed as JSON lines).
"""
import json
import os
import sys
import time

sys.dont_write_bytecode = True   # tests write nothing into the repo (no __pycache__)

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "cl"))
import director as D  # noqa: E402
from sim import Sim, F  # noqa: E402

z = np.load(os.path.join(HERE, "cl", "oracle_mlp.npz"))
W0, W1, b0, b1, Wo, bo = [z["arr_%d" % i] for i in range(6)]
mu, sd = z["mu"], z["sd"]
WIN = 16
HEADS = (4, 4, 3)
TIER_LEVEL = [0.1, 0.4, 0.8]


def split_logits(zz):
    out, i = [], 0
    for k in HEADS:
        a = zz[:, i:i + k] - zz[:, i:i + k].max(1, keepdims=True)
        e = np.exp(a)
        out.append(e / e.sum(1, keepdims=True))
        i += k
    return out


def mlp(xw):
    h = np.maximum(xw @ W0 + b0, 0)
    h = np.maximum(h @ W1 + b1, 0)
    return split_logits(h @ Wo + bo)


def run(policy, k_audio, nat_frac=0.0, gated=False, N=150, T=3600, seed=21):
    sim = Sim(N, seed)
    buf = np.zeros((N, WIN, F), np.float32)
    dirs = [D.new_state() for _ in range(N)]
    pressure = np.ones(N)
    aggro = np.ones(N)
    audio = np.zeros(N)
    S = np.zeros((N, T), np.int8)
    ENC = np.zeros((N, T), bool)
    DEAD = np.zeros((N, T), bool)
    A = np.zeros((N, T), np.float32)
    AUD = np.zeros((N, T), np.float32)
    STD = np.zeros((N, T), np.int8)
    prev_dead = np.zeros(N, bool)
    last_resp = np.full(N, -10 ** 9)
    deaths = [[] for _ in range(N)]
    sidx = {s: i for i, s in enumerate(D.STATES)}
    for t in range(T):
        if policy == "none":
            x, s, k, m, dead = sim.step(None, None)
        else:
            gate = np.minimum(1.0, pressure) if gated else None
            x, s, k, m, dead = sim.step(pressure, aggro, audio=k_audio * audio, nat_frac=nat_frac, nat_gate=gate)
        buf = np.roll(buf, -1, 1)
        buf[:, -1] = x
        S[:, t] = s
        ENC[:, t] = sim.enc
        DEAD[:, t] = dead
        A[:, t] = sim.a
        if policy == "none":
            continue
        Ps, Pt, Pf = mlp(((buf - mu) / sd).reshape(N, -1).astype(np.float32))
        tsd_s = np.expm1(x[:, 13] * np.log1p(600))
        prox = np.maximum(0.0, 1 - x[:, 17])
        sh = np.clip(0.45 * prox + 0.20 * x[:, 15] + 0.15 * (1 - x[:, 8]) + 0.20 * (1 - x[:, 5]), 0, 1)
        theta = np.clip(0.60 * prox + 0.25 * x[:, 15] + 0.15 * (1 - x[:, 8]), 0, 1)
        for i in range(N):
            if prev_dead[i]:
                last_resp[i] = t
            if dead[i]:
                deaths[i].append(t)
            while deaths[i] and t - deaths[i][0] > 3600:
                deaths[i].pop(0)
            p = Ps[i]
            inp = dict(eo=float((p[1] + 2 * p[2] + 3 * p[3]) / 3), conf=float(p.max()), fresh=True, sh=float(sh[i]),
                       theta=float(theta[i]), nearest=float(x[i, 17] * 32), tsd=float(tsd_s[i]), pflee=float(Pf[i, 1]),
                       mercy=bool(x[i, 5] <= 0.30), grace=bool(t - last_resp[i] < 120), deaths1h=len(deaths[i]))
            o = D.pure_step(dirs[i], inp)
            pressure[i] = o["spawn"]
            aggro[i] = o["aggro"]
            st = o["state"]
            STD[i, t] = sidx[st]
            lvl = TIER_LEVEL[o["tier"]]
            if st == "PANIC":
                lvl = 0.3
            if st == "RELEASE":
                lvl = 0.0
            if inp["mercy"] or inp["grace"]:
                lvl = min(lvl, 0.1)
            audio[i] = lvl
            AUD[i, t] = lvl
        prev_dead = dead
    hours = N * T / 3600
    snow = 0
    for row in DEAD:
        ts_ = np.flatnonzero(row)
        snow += int((np.diff(ts_) <= 120).sum())
    quiet = ~ENC
    r = dict(policy=policy, k=k_audio, nat_frac=nat_frac, gated=gated,
             deaths_hr=round(float(DEAD.sum() / hours), 3), repeat_deaths_hr=round(snow / hours, 3),
             true_panic_pct=round(100 * float((S == 3).mean()), 2), mean_arousal=round(float(A.mean()), 4),
             arousal_no_enc=round(float(A[quiet].mean()), 3),
             dread_audio_no_enc_raw=float((AUD[quiet] >= 0.8).mean()),
             encounters_hr=round(float((ENC[:, 1:] & ~ENC[:, :-1]).sum() / hours), 2))
    r["dread_audio_pct_no_enc"] = round(100 * r["dread_audio_no_enc_raw"], 2)
    if policy != "none":
        r["fsm_dread_or_panic_pct"] = round(100 * float(((STD == 2) | (STD == 3)).mean()), 2)
        r["flips_per_min"] = round(float((STD[:, 1:] != STD[:, :-1]).sum() / (N * T / 60)), 3)
        mx = 0
        for row in STD:
            run_ = 0
            for v in row:
                run_ = run_ + 1 if v == 3 else 0
                mx = max(mx, run_)
        r["max_panic_s"] = mx
    return r


def main():
    quick = "--quick" in sys.argv
    N, T = (60, 1800) if quick else (150, 3600)
    t0 = time.time()
    res = {}
    for key, args in [("none", ("none", 0.0)), ("k0", ("v11", 0.0)), ("k03", ("v11", 0.3)),
                      ("nat", ("v11", 0.15, 0.6, False)), ("nat_gated", ("v11", 0.15, 0.6, True))]:
        r = run(*args, N=N, T=T)
        res[key] = r
        print(json.dumps(r), flush=True)
    fails = []
    g = res["nat_gated"]
    if g["deaths_hr"] > 1.10:
        fails.append("deaths/hr with the natural gate at a 60%% natural share %.3f > 1.10 (TDD 1.03)" % g["deaths_hr"])
    cut = res["nat"]["deaths_hr"] - g["deaths_hr"]
    if cut < 0.10:
        fails.append("the natural gate cuts deaths/hr by only %.3f (ungated %.3f, gated %.3f; need >= 0.10)"
                     % (cut, res["nat"]["deaths_hr"], g["deaths_hr"]))
    da = res["k03"]["mean_arousal"] - res["k0"]["mean_arousal"]
    if da > 0.04:
        fails.append("mean arousal increase at k = 0.3: %.4f > 0.04" % da)
    if res["k03"]["dread_audio_no_enc_raw"] > 1e-4:
        fails.append("dread-level audio outside encounters at k = 0.3: raw fraction %.6f > 0.0001 (0.01%%)"
                     % res["k03"]["dread_audio_no_enc_raw"])
    for key in ("k0", "k03", "nat_gated"):
        r = res[key]
        if r["repeat_deaths_hr"] > 0.05:
            fails.append("%s: repeat deaths %.3f/hr" % (key, r["repeat_deaths_hr"]))
        if r["flips_per_min"] > 1.5:
            fails.append("%s: %.3f state flips/min > 1.5" % (key, r["flips_per_min"]))
        if r["max_panic_s"] > 45:
            fails.append("%s: PANIC run %d s > 45" % (key, r["max_panic_s"]))
    enc_ratio = res["k0"]["encounters_hr"] / max(1e-9, res["none"]["encounters_hr"])
    if enc_ratio < 0.85:
        fails.append("encounters %.1f%% of the no-director figure < 85%%" % (100 * enc_ratio))
    print("summary: gated deaths/hr %.3f (ungated %.3f, none %.3f; gate cut %.3f); arousal +%.4f at k=0.3; dread audio outside "
          "encounters %.4f%% (raw %.6f); encounters %.1f%% of no-director; flips/min %.3f; max PANIC %d s; %d players x %d s; %.0f s"
          % (g["deaths_hr"], res["nat"]["deaths_hr"], res["none"]["deaths_hr"], res["nat"]["deaths_hr"] - g["deaths_hr"], da,
             100 * res["k03"]["dread_audio_no_enc_raw"], res["k03"]["dread_audio_no_enc_raw"], 100 * enc_ratio,
             res["k03"]["flips_per_min"], max(res[k]["max_panic_s"] for k in ("k0", "k03", "nat_gated")), N, T, time.time() - t0))
    for f in fails:
        print("  FAIL " + f)
    print("PASS director-closed-loop" if not fails else "FAIL director-closed-loop: %d gate(s) missed" % len(fails))
    return 0 if not fails else 1


if __name__ == "__main__":
    sys.exit(main())
