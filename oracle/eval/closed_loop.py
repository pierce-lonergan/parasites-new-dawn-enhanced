"""Closed-loop test: simulated players + online Oracle MLP + pacing policy. Does the director keep
'terrifying but survivable', and does a naive stress-escalating policy snowball? (moved from the TDD prototypes)
Run: python oracle/eval/closed_loop.py [N T]   (defaults N=150 sessions, T=3600 s; about 15 s for all policies)
Prints one JSON line per policy; writes closed_loop.json to %TEMP% (or /tmp)."""
import json, os, sys, time
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "sim"))
sys.path.insert(0, os.path.join(ROOT, "train"))
sys.path.insert(0, HERE)
from sim import Sim, F  # noqa: E402
from nn import split_logits  # noqa: E402
import director_ref as D  # noqa: E402

z = np.load(os.path.join(ROOT, "models", "oracle_mlp.npz"))
W0, W1, b0, b1, Wo, bo = [z["arr_%d" % i] for i in range(6)]
mu, sd = z["mu"], z["sd"]
WIN = 16


def mlp(xw):
    h = np.maximum(xw @ W0 + b0, 0)
    h = np.maximum(h @ W1 + b1, 0)
    return split_logits(h @ Wo + bo)


def episodes(mask):
    """lengths of runs of True along axis 1"""
    out = []
    for row in mask:
        run = 0
        for v in row:
            if v:
                run += 1
            elif run:
                out.append(run); run = 0
        if run:
            out.append(run)
    return np.array(out) if out else np.array([0])


def run(policy, N=150, T=3600, seed=21, cfg=D.CFG):
    from train import teacher_stress
    sim = Sim(N, seed)
    buf = np.zeros((N, WIN, F), np.float32)
    dirs = [D.new() for _ in range(N)]
    pressure = np.ones(N)
    aggro = np.ones(N)
    S = np.zeros((N, T), np.int8)
    ST = np.zeros((N, T), np.int8)
    ENC = np.zeros((N, T), bool)
    DEAD = np.zeros((N, T), bool)
    e_naive = np.zeros(N)
    prev_dead = np.zeros(N, bool)
    sidx = {s: i for i, s in enumerate(D.STATES)}
    for t in range(T):
        x, s, k, m, dead = sim.step(pressure if policy != "none" else None, aggro if policy != "none" else None)
        buf = np.roll(buf, -1, 1)
        buf[:, -1] = x
        S[:, t] = s
        ENC[:, t] = sim.enc
        DEAD[:, t] = dead
        if policy == "none":
            continue
        Ps, Pt, Pf = mlp(((buf - mu) / sd).reshape(N, -1).astype(np.float32))
        if policy == "naive":
            idx = (Ps[:, 1] + 2 * Ps[:, 2] + 3 * Ps[:, 3]) / 3
            e_naive += (idx - e_naive) * (1 - np.exp(-1 / 4.0))
            pressure = 1 + 2 * e_naive
            aggro = 1 + 0.5 * e_naive
            continue
        ts = teacher_stress(x)
        tsd_s = np.expm1(x[:, 13] * np.log1p(600))
        for i in range(N):
            o = D.step(dirs[i], dict(stressP=Ps[i].tolist(), feP=Pf[i].tolist(), health=float(x[i, 5]), nearest=float(x[i, 17] * 32),
                                     tSinceDamage=float(tsd_s[i]), teacherStress=int(ts[i]), died=bool(dead[i]), respawned=bool(prev_dead[i])), cfg)
            pressure[i] = o["spawn"]
            aggro[i] = o["aggro"]
            ST[i, t] = sidx[o["state"]]
        prev_dead = dead
    hours = N * T / 3600
    deaths = DEAD.sum()
    # deaths within 120 s after a previous death (snowball deaths)
    snow = 0
    for row in DEAD:
        ts_ = np.flatnonzero(row)
        snow += int((np.diff(ts_) <= 120).sum())
    pe = episodes(S == 3)
    starts = (ENC[:, 1:] & ~ENC[:, :-1]).sum()
    r = dict(policy=policy, deaths_per_hr=round(deaths / hours, 3), snowball_deaths_per_hr=round(snow / hours, 3),
             true_panic_pct=round(100 * (S == 3).mean(), 2), true_calm_pct=round(100 * (S == 0).mean(), 2),
             panic_ep_mean_s=round(float(pe.mean()), 1), panic_ep_p95_s=float(np.percentile(pe, 95)),
             encounters_per_hr=round(starts / hours, 2), enc_time_pct=round(100 * ENC.mean(), 2))
    if policy.startswith("director"):
        r["director_flips_per_min"] = round(float((ST[:, 1:] != ST[:, :-1]).sum() / (N * T / 60)), 3)
        r["director_state_pct"] = {s: round(100 * float((ST == i).mean()), 1) for i, s in enumerate(D.STATES)}
    return r


if __name__ == "__main__":
    out = []
    N = int(sys.argv[1]) if len(sys.argv) > 1 else 150
    T = int(sys.argv[2]) if len(sys.argv) > 2 else 3600
    for pol, cfg in [("none", D.CFG), ("naive", D.CFG), ("director", D.CFG), ("director_nohyst", D.NO_HYST)]:
        t = time.time()
        r = run(pol, N=N, T=T, cfg=cfg)
        r["wall_s"] = round(time.time() - t, 1)
        print(json.dumps(r), flush=True)
        out.append(r)
    json.dump(out, open(os.path.join(os.environ.get("TEMP", "/tmp"), "closed_loop.json"), "w"), indent=1)
