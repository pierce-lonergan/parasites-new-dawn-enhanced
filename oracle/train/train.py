"""Train and evaluate Oracle candidates on synthetic telemetry. numpy only (moved from the TDD prototypes).
Run: PYTHONIOENCODING=utf-8 python oracle/train/train.py [OUT_DIR] > results.txt   (about 50 s on the 9950X)
Writes OUT_DIR/oracle_mlp.npz (default: a scratch folder, never oracle/models directly: copy it there and run
train/make_manifest.py so the manifest's sha256 follows), results.json and trace.json.
"""
import json, os, time, sys
import numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "sim"))
sys.path.insert(0, HERE)
from sim import generate, FEATURES, F, FLEE, ENGAGE  # noqa: E402
from nn import MLP, train, report, auroc, quantize_mlp, split_logits, macro_f1  # noqa: E402
OUT = None  # set by main(): argv[1] or %TEMP%/pne_oracle_train (importing this module writes nothing)

T0 = time.time()
LOG = []


def log(*a):
    s = " ".join(str(x) for x in a)
    print(s, flush=True)
    LOG.append(s)


SHIFT = dict(noise=1.5, bravery_mu=-0.4, rate_mult=0.9, hostile_speed=4.0, style_conc=0.7, tau_down=15.0)


def windows(X, labels, W, stride):
    N, T, _ = X.shape
    ts = np.arange(W - 1, T, stride)
    idx = ts[:, None] + np.arange(-W + 1, 1)[None, :]
    Xw = X[:, idx, :]  # N, nt, W, F
    Xw = Xw.reshape(-1, W, F)
    ys = [l[:, ts].reshape(-1).astype(np.int64) for l in labels]
    return Xw, ys


def summary(Xw):
    """Window summary stats for the logistic-regression baseline: mean, std, last, min, max, slope."""
    W = Xw.shape[1]
    tt = np.arange(W) - (W - 1) / 2
    slope = (Xw * tt[None, :, None]).sum(1) / (tt ** 2).sum()
    return np.concatenate([Xw.mean(1), Xw.std(1), Xw[:, -1], Xw.min(1), Xw.max(1), slope], 1)


def ss_fe_label(X, h=5):
    """Self-supervised flee/engage label computed only from FUTURE OBSERVED telemetry (usable on real logs)."""
    N, T, _ = X.shape
    out = np.zeros((N, T), np.int8)
    near = X[..., 17] * 32
    dn = X[..., 18] * 8
    spr = X[..., 12]
    dealt = X[..., 29]
    for t in range(T - h):
        sl = slice(t + 1, t + 1 + h)
        threat_now = near[:, t] < 24
        eng = threat_now & ((dealt[:, sl] > 0).any(1) | ((near[:, sl].min(1) < 3) & (dn[:, sl].mean(1) <= 0) & (spr[:, sl].mean(1) < 0.8)))
        gained = np.clip(dn[:, sl], 0, 6).sum(1)  # clip removes the jump to 32 when a mob despawns/dies
        fle = threat_now & ~eng & (gained > 5) & (spr[:, sl].mean(1) >= 0.4)
        out[:, t] = np.where(fle, FLEE, np.where(eng, ENGAGE, 0))
    return out


def teacher_stress(x):
    """A-priori heuristic teacher on the last second only (weights chosen from design reasoning, not fit)."""
    near = x[:, 17] * 32
    s = (0.45 * (near < 8) + 0.25 * (near < 16) + 0.35 * (x[:, 13] < np.log1p(5) / np.log1p(600))
         + 0.2 * (x[:, 5] < 0.5) + 0.15 * (x[:, 8] < 5 / 15) + 0.25 * (x[:, 14] < np.log1p(10) / np.log1p(600))
         + 0.2 * ((x[:, 12] > 0) & (x[:, 2] > 0.25)))
    return np.digitize(s, [0.2, 0.45, 0.75])


def teacher_tactic(Xw):
    m = Xw.mean(1)
    turtle = (m[:, 26] * 10 >= 2) | ((m[:, 27] * 9 >= 6) & (m[:, 0] < 0.2))
    kite = (m[:, 20] > 0.5) & (Xw[:, :, 16].max(1) > 0) & (m[:, 2] > 0.2)
    hide = (m[:, 11] > 0.3) | ((m[:, 0] < 0.15) & (m[:, 8] < 0.45))
    return np.where(turtle, 2, np.where(kite, 1, np.where(hide, 0, 3)))


def onehot_soft(y, k, eps=0.02):
    p = np.full((len(y), k), eps / (k - 1))
    p[np.arange(len(y)), y] = 1 - eps
    return p


def build(seed, N, T, stride, W, **kw):
    X, S, K, M, FE, D = generate(N, T, seed=seed, **kw)
    SS = ss_fe_label(X)
    Xw, ys = windows(X, [S, K, FE, M, SS], W, stride)
    return X, Xw, ys, D


def eval_all(name, P, ys, extra=None):
    r = {"stress": report(name, ys[0], P[0], 4, ordinal=True), "tactic": report(name, ys[1], P[1], 4),
         "fe": report(name, ys[2], P[2], 3)}
    r["fe"]["auroc_flee"] = auroc(ys[2] == FLEE, P[2][:, FLEE])
    r["fe"]["auroc_engage"] = auroc(ys[2] == ENGAGE, P[2][:, ENGAGE])
    onset = ys[3] != ys[2]  # current mode differs from the future label: a genuine transition
    r["fe"]["onset_n"] = int(onset.sum())
    r["fe"]["onset_acc"] = float((P[2].argmax(1)[onset] == ys[2][onset]).mean())
    r["fe"]["onset_macro_f1"] = macro_f1(ys[2][onset], P[2].argmax(1)[onset], 3)
    return r


def short(r):
    s, t, f = r["stress"], r["tactic"], r["fe"]
    return ("stress acc %.3f balacc %.3f F1 %.3f ECE %.3f adj %.2f | tactic acc %.3f F1 %.3f | fe acc %.3f F1 %.3f AUROC flee %.3f eng %.3f onsetF1 %.3f"
            % (s["acc"], s["bal_acc"], s["macro_f1"], s["ece"], s["adjacent_err_frac"], t["acc"], t["macro_f1"], f["acc"], f["macro_f1"], f["auroc_flee"], f["auroc_engage"], f["onset_macro_f1"]))


def main():
    global OUT
    OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("TEMP", "/tmp"), "pne_oracle_train")
    os.makedirs(OUT, exist_ok=True)
    W = 16
    RES = {}
    log("== data generation (W=%d s at 1 Hz, F=%d) ==" % (W, F))
    Xtr_raw, Xtr, ytr, Dtr = build(11, 400, 1800, 5, W)
    Xva_raw, Xva, yva, _ = build(12, 80, 1800, 5, W)
    Xte_raw, Xte, yte, Dte = build(13, 200, 1800, 3, W)
    Xsh_raw, Xsh, ysh, _ = build(14, 200, 1800, 3, W, **SHIFT)
    log("train windows %d, val %d, test %d, shift %d; gen %.1fs" % (len(Xtr), len(Xva), len(Xte), len(Xsh), time.time() - T0))
    for nm, y in zip(["stress", "tactic", "fe"], ytr[:3]):
        log("train class freq", nm, np.round(np.bincount(y) / len(y), 4).tolist())
    log("test deaths/hour (sim baseline): %.2f" % (Dte.sum() / (200 * 0.5)))
    mu = Xtr.reshape(-1, F).mean(0)
    sd = Xtr.reshape(-1, F).std(0) + 1e-3
    norm = lambda A: ((A - mu) / sd).reshape(len(A), -1).astype(np.float32)
    ntr, nva, nte, nsh = norm(Xtr), norm(Xva), norm(Xte), norm(Xsh)

    # self-supervised FE label agreement with the latent truth
    agree = (ytr[4] == ytr[2]).mean()
    log("self-supervised FE label vs latent truth: agreement %.3f, macro-F1 %.3f" % (agree, macro_f1(ytr[2], ytr[4], 3)))
    RES["ss_fe_agreement"] = float(agree)

    # baselines
    log("\n== baselines on test ==")
    maj = [np.tile(np.eye(k)[np.bincount(y).argmax()], (len(yte[0]), 1)) for y, k in zip(ytr[:3], (4, 4, 3))]
    RES["majority"] = eval_all("majority", maj, yte); log("majority        ", short(RES["majority"]))
    tp = [onehot_soft(teacher_stress(Xte[:, -1]), 4), onehot_soft(teacher_tactic(Xte), 4), onehot_soft(yte[4], 3)]
    RES["teacher"] = eval_all("teacher", tp, yte); log("teacher rules   ", short(RES["teacher"]), "(FE head = self-supervised rule applied with future access: an upper bound, not deployable)")

    # logistic regression on window summary stats
    log("\n== multinomial logistic regression on window summary stats ==")
    str_ = summary(Xtr); smu, ssd = str_.mean(0), str_.std(0) + 1e-3
    sn = lambda A: ((summary(A) - smu) / ssd).astype(np.float32)
    lr_m = MLP(str_.shape[1], [], seed=1)
    train(lr_m, sn(Xtr), ytr[:3], sn(Xva), yva[:3], epochs=10, lr=3e-3)
    RES["logreg"] = eval_all("logreg", lr_m.predict(sn(Xte)), yte); log("logreg (%d params)" % lr_m.n_params(), short(RES["logreg"]))

    # MLP main
    log("\n== MLP on flattened window (%d inputs) ==" % (W * F))
    t = time.time()
    mlp = MLP(W * F, [64, 32], seed=2)
    train(mlp, ntr, ytr[:3], nva, yva[:3], epochs=14, lr=2e-3, log=log)
    log("train time %.1fs, params %d" % (time.time() - t, mlp.n_params()))
    Pte = mlp.predict(nte)
    RES["mlp"] = eval_all("mlp", Pte, yte); log("MLP 496-64-32-11 test ", short(RES["mlp"]))
    RES["mlp_shift"] = eval_all("mlp_shift", mlp.predict(nsh), ysh); log("MLP on SHIFTED pop  ", short(RES["mlp_shift"]))
    RES["teacher_shift"] = eval_all("teacher_shift", [onehot_soft(teacher_stress(Xsh[:, -1]), 4), onehot_soft(teacher_tactic(Xsh), 4), onehot_soft(ysh[4], 3)], ysh)
    log("teacher on SHIFTED  ", short(RES["teacher_shift"]))
    log("MLP stress confusion (rows truth calm..panic):", RES["mlp"]["stress"]["confusion"])
    log("MLP tactic confusion (hiding,kiting,turtling,exploring):", RES["mlp"]["tactic"]["confusion"])
    log("MLP fe confusion (neither,flee,engage):", RES["mlp"]["fe"]["confusion"])

    # tactic accuracy split by threat presence
    thr = Xte[:, :, 16].max(1) > 0
    for nm, m in [("threat in window", thr), ("no threat in window", ~thr)]:
        log("tactic acc %s: %.3f (n=%d)" % (nm, (Pte[1].argmax(1)[m] == yte[1][m]).mean(), m.sum()))

    # trained on teacher/self-supervised labels only (no latent truth), evaluated vs truth
    log("\n== MLP trained ONLY on teacher + self-supervised labels, scored against latent truth ==")
    ytr_t = [teacher_stress(Xtr[:, -1]), teacher_tactic(Xtr), ytr[4]]
    yva_t = [teacher_stress(Xva[:, -1]), teacher_tactic(Xva), yva[4]]
    mlp_t = MLP(W * F, [64, 32], seed=3)
    train(mlp_t, ntr, ytr_t, nva, yva_t, epochs=10, lr=2e-3)
    RES["mlp_weak"] = eval_all("mlp_weak", mlp_t.predict(nte), yte); log("MLP(weak labels) vs truth", short(RES["mlp_weak"]))

    # architecture / window sweep (shorter training)
    log("\n== sweep: window length and width (8 epochs each) ==")
    RES["sweep"] = []
    for Wk, hid in [(1, [64, 32]), (4, [64, 32]), (8, [64, 32]), (16, [32]), (16, [128, 64]), (32, [64, 32])]:
        if Wk <= W:
            a, b, c = Xtr[:, W - Wk:], Xva[:, W - Wk:], Xte[:, W - Wk:]
            ya, yb, yc = ytr, yva, yte
        else:
            _, a, ya, _ = build(11, 400, 1800, 5, Wk); _, b, yb, _ = build(12, 80, 1800, 5, Wk); _, c, yc, _ = build(13, 200, 1800, 3, Wk)
        nn_ = lambda A: ((A - mu) / sd).reshape(len(A), -1).astype(np.float32)
        m = MLP(Wk * F, hid, seed=4)
        train(m, nn_(a), ya[:3], nn_(b), yb[:3], epochs=8, lr=2e-3)
        r = eval_all("W%d_%s" % (Wk, hid), m.predict(nn_(c)), yc)
        RES["sweep"].append({"W": Wk, "hidden": hid, "params": m.n_params(), "stress_f1": r["stress"]["macro_f1"], "tactic_f1": r["tactic"]["macro_f1"], "fe_f1": r["fe"]["macro_f1"], "onset_f1": r["fe"]["onset_macro_f1"]})
        log("W=%2d hidden=%-9s params=%6d " % (Wk, hid, m.n_params()), short(r))

    # permutation importance by feature group (on MLP, test set)
    log("\n== permutation importance by feature group (drop in macro-F1 per head) ==")
    groups = {"motion(speed,accel,heading,look,vy)": [0, 1, 2, 3, 4], "vitals(health,dhealth,food,t_dmg)": [5, 6, 7, 13],
              "environment(light,sky,depth,night)": [8, 9, 10, 30], "stance(sneak,sprint)": [11, 12],
              "threat(t_sight,n16,n32,nearest,dnearest)": [14, 15, 16, 17, 18], "held item": list(range(19, 26)),
              "building(place30,enclosure,torch_rate)": [26, 27, 28], "combat(dealt)": [29]}
    base = [macro_f1(y, p.argmax(1), p.shape[1]) for y, p in zip(yte[:3], Pte)]
    rng = np.random.default_rng(7)
    RES["perm_importance"] = {}
    for g, cols in groups.items():
        Xp = Xte.copy()
        perm = rng.permutation(len(Xp))
        Xp[:, :, cols] = Xp[perm][:, :, cols]
        P = mlp.predict(norm(Xp))
        drop = [b - macro_f1(y, p.argmax(1), p.shape[1]) for b, y, p in zip(base, yte[:3], P)]
        RES["perm_importance"][g] = [round(d, 4) for d in drop]
        log("%-45s stress %+.3f tactic %+.3f fe %+.3f" % (g, drop[0], drop[1], drop[2]))

    # int8 PTQ
    log("\n== int8 post-training quantisation emulation ==")
    cal = ntr[np.random.default_rng(0).choice(len(ntr), 2000, replace=False)]
    qrun, aq = quantize_mlp(mlp, cal)
    Pq = split_logits(qrun(nte))
    RES["mlp_int8"] = eval_all("mlp_int8", Pq, yte); log("MLP int8 test", short(RES["mlp_int8"]))
    agree_q = [float((a.argmax(1) == b.argmax(1)).mean()) for a, b in zip(Pte, Pq)]
    log("float vs int8 top-1 agreement per head:", [round(a, 4) for a in agree_q])
    RES["int8_agreement"] = agree_q

    # latency
    log("\n== CPU latency (numpy, batch 1, single thread-ish) ==")
    x1 = nte[:1].copy()
    for _ in range(200):
        mlp.forward(x1)
    ts = []
    for _ in range(5000):
        a = time.perf_counter(); z = mlp.forward(x1); split_logits(z); ts.append(time.perf_counter() - a)
    ts = np.array(ts) * 1e6
    log("float32 forward+softmax: median %.1f us, p99 %.1f us" % (np.median(ts), np.percentile(ts, 99)))
    ts2 = []
    for _ in range(2000):
        a = time.perf_counter(); qrun(x1); ts2.append(time.perf_counter() - a)
    ts2 = np.array(ts2) * 1e6
    log("int8-emulated forward: median %.1f us, p99 %.1f us (emulation overhead, not a TPU number)" % (np.median(ts2), np.percentile(ts2, 99)))
    RES["latency_us"] = {"float32_median": float(np.median(ts)), "float32_p99": float(np.percentile(ts, 99)), "int8emu_median": float(np.median(ts2))}

    # save weights + a test trace for the director
    np.savez(os.path.join(OUT, "oracle_mlp.npz"), *mlp.params, mu=mu, sd=sd)
    one = Xte_raw[0:6]
    Wn = W
    tr = []
    for sidx in range(one.shape[0]):
        xs, _ = windows(one[sidx:sidx + 1], [np.zeros((1, one.shape[1]))], Wn, 1)
        P = mlp.predict(norm(xs))
        tr.append({"stress_p": np.round(P[0], 4).tolist(), "tactic_p": np.round(P[1], 4).tolist(), "fe_p": np.round(P[2], 4).tolist(),
                   "health": np.round(one[sidx, Wn - 1:, 5], 3).tolist(), "nearest": np.round(one[sidx, Wn - 1:, 17] * 32, 2).tolist()})
    json.dump(tr, open(os.path.join(OUT, "trace.json"), "w"))
    json.dump(RES, open(os.path.join(OUT, "results.json"), "w"), indent=1)
    log("\nwall time %.1fs" % (time.time() - T0))


if __name__ == "__main__":
    main()
