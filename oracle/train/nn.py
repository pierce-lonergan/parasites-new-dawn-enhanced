"""Numpy-only multitask MLP / multinomial logistic regression, metrics and int8 PTQ emulation."""
import numpy as np

HEADS = (4, 4, 3)  # stress, tactic, flee/engage


class MLP:
    def __init__(self, d_in, hidden, heads=HEADS, seed=0):
        rng = np.random.default_rng(seed)
        dims = [d_in] + list(hidden)
        self.W, self.b = [], []
        for a, c in zip(dims[:-1], dims[1:]):
            self.W.append((rng.normal(0, np.sqrt(2 / a), (a, c))).astype(np.float32))
            self.b.append(np.zeros(c, np.float32))
        self.heads = heads
        self.Wo = (rng.normal(0, np.sqrt(1 / dims[-1]), (dims[-1], sum(heads)))).astype(np.float32)
        self.bo = np.zeros(sum(heads), np.float32)
        self.params = self.W + self.b + [self.Wo, self.bo]
        self.m = [np.zeros_like(p) for p in self.params]
        self.v = [np.zeros_like(p) for p in self.params]
        self.k = 0

    def n_params(self):
        return int(sum(p.size for p in self.params))

    def forward(self, x, keep=False):
        hs = [x]
        h = x
        for W, b in zip(self.W, self.b):
            h = np.maximum(h @ W + b, 0)
            hs.append(h)
        z = h @ self.Wo + self.bo
        if keep:
            self._hs = hs
        return z

    def split(self, z):
        out, i = [], 0
        for k in self.heads:
            zz = z[:, i:i + k]
            zz = zz - zz.max(1, keepdims=True)
            e = np.exp(zz)
            out.append(e / e.sum(1, keepdims=True))
            i += k
        return out

    def step(self, x, ys, cw, lr=2e-3, l2=1e-5, hw=(1, 1, 1)):
        z = self.forward(x, keep=True)
        P = self.split(z)
        n = x.shape[0]
        dz = np.zeros_like(z)
        loss, i = 0.0, 0
        for h, (p, y, w) in enumerate(zip(P, ys, cw)):
            k = p.shape[1]
            sw = w[y] * hw[h]
            loss += float(-(sw * np.log(p[np.arange(n), y] + 1e-9)).sum() / n)
            g = p.copy()
            g[np.arange(n), y] -= 1
            dz[:, i:i + k] = g * sw[:, None] / n
            i += k
        hs = self._hs
        gWo = hs[-1].T @ dz + l2 * self.Wo
        gbo = dz.sum(0)
        dh = dz @ self.Wo.T
        gW, gb = [None] * len(self.W), [None] * len(self.W)
        for j in range(len(self.W) - 1, -1, -1):
            dh = dh * (hs[j + 1] > 0)
            gW[j] = hs[j].T @ dh + l2 * self.W[j]
            gb[j] = dh.sum(0)
            dh = dh @ self.W[j].T
        grads = gW + gb + [gWo, gbo]
        self.k += 1
        b1, b2 = 0.9, 0.999
        for p, g, m, v in zip(self.params, grads, self.m, self.v):
            m *= b1; m += (1 - b1) * g
            v *= b2; v += (1 - b2) * g * g
            p -= (lr * (m / (1 - b1 ** self.k)) / (np.sqrt(v / (1 - b2 ** self.k)) + 1e-8)).astype(np.float32)
        return loss

    def predict(self, x, bs=8192):
        outs = [[], [], []]
        for s in range(0, x.shape[0], bs):
            P = self.split(self.forward(x[s:s + bs]))
            for o, p in zip(outs, P):
                o.append(p)
        return [np.concatenate(o) for o in outs]


def class_weights(y, k, power=0.5):
    c = np.bincount(y, minlength=k).astype(float) + 1
    w = (c.sum() / (k * c)) ** power
    return (w / w[y].mean()).astype(np.float32)


def train(model, X, ys, Xv, yvs, epochs=12, bs=512, lr=2e-3, seed=0, cw_power=(0.5, 0.5, 0.5), log=None):
    rng = np.random.default_rng(seed)
    cw = [class_weights(y, k, pw) for y, k, pw in zip(ys, model.heads, cw_power)]
    best, best_state = -1, None
    for ep in range(epochs):
        idx = rng.permutation(X.shape[0])
        lr_ep = lr * (0.5 * (1 + np.cos(np.pi * ep / epochs)))
        tot = 0
        for s in range(0, len(idx), bs):
            j = idx[s:s + bs]
            tot += model.step(X[j], [y[j] for y in ys], cw, lr=lr_ep)
        P = model.predict(Xv)
        score = np.mean([macro_f1(y, p.argmax(1), p.shape[1]) for y, p in zip(yvs, P)])
        if log:
            log("  epoch %d loss %.4f val meanF1 %.4f" % (ep, tot / (len(idx) / bs), score))
        if score > best:
            best = score
            best_state = [p.copy() for p in model.params]
    for p, q in zip(model.params, best_state):
        p[...] = q
    return best


# ---------------- metrics ----------------
def confusion(y, yh, k):
    C = np.zeros((k, k), int)
    np.add.at(C, (y, yh), 1)
    return C


def macro_f1(y, yh, k):
    C = confusion(y, yh, k)
    tp = np.diag(C).astype(float)
    prec = tp / np.maximum(C.sum(0), 1)
    rec = tp / np.maximum(C.sum(1), 1)
    f1 = 2 * prec * rec / np.maximum(prec + rec, 1e-9)
    present = C.sum(1) > 0
    return float(f1[present].mean())


def balanced_acc(y, yh, k):
    C = confusion(y, yh, k)
    rec = np.diag(C) / np.maximum(C.sum(1), 1)
    return float(rec[C.sum(1) > 0].mean())


def ece(y, p, bins=15):
    conf = p.max(1)
    pred = p.argmax(1)
    e = 0.0
    edges = np.linspace(0, 1, bins + 1)
    for a, b in zip(edges[:-1], edges[1:]):
        m = (conf > a) & (conf <= b)
        if m.any():
            e += m.mean() * abs((pred[m] == y[m]).mean() - conf[m].mean())
    return float(e)


def auroc(pos, score):
    pos = pos.astype(bool)
    r = score.argsort().argsort().astype(float) + 1
    n1, n0 = pos.sum(), (~pos).sum()
    if n1 == 0 or n0 == 0:
        return float("nan")
    return float((r[pos].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


def report(name, y, p, k, ordinal=False):
    yh = p.argmax(1)
    d = dict(model=name, acc=float((yh == y).mean()), bal_acc=balanced_acc(y, yh, k), macro_f1=macro_f1(y, yh, k), ece=ece(y, p))
    if ordinal:
        err = yh != y
        d["adjacent_err_frac"] = float((np.abs(yh - y)[err] == 1).mean()) if err.any() else 1.0
    d["confusion"] = confusion(y, yh, k).tolist()
    return d


# ---------------- int8 post-training quantisation emulation ----------------
def _qparams(lo, hi):
    lo, hi = min(lo, 0.0), max(hi, 0.0)
    s = (hi - lo) / 255.0 if hi > lo else 1.0
    z = int(round(-128 - lo / s))
    return s, z


def quantize_mlp(model, Xcal):
    """TFLite-style full-integer PTQ: int8 per-tensor asymmetric activations (calibrated min/max on a
    representative set), int8 symmetric per-output-channel weights, int32 bias. Returns a function
    that runs the integer pipeline (int32 accumulate, float requantise emulated)."""
    acts = [Xcal]
    h = Xcal
    for W, b in zip(model.W, model.b):
        h = np.maximum(h @ W + b, 0)
        acts.append(h)
    z = h @ model.Wo + model.bo
    acts.append(z)
    aq = [_qparams(float(a.min()), float(a.max())) for a in acts]
    layers = list(zip(model.W, model.b)) + [(model.Wo, model.bo)]
    qw = []
    for W, b in layers:
        ws = np.abs(W).max(0) / 127.0 + 1e-12
        Wq = np.clip(np.round(W / ws), -127, 127).astype(np.int32)
        qw.append((Wq, ws, b))

    def run(x):
        s, zp = aq[0]
        q = np.clip(np.round(x / s) + zp, -128, 127).astype(np.int32)
        for li, (Wq, ws, b) in enumerate(qw):
            s_in, z_in = aq[li]
            s_out, z_out = aq[li + 1]
            acc = (q - z_in) @ Wq  # int32 accumulate
            bq = np.round(b / (s_in * ws)).astype(np.int64)
            real = (acc + bq) * (s_in * ws)
            if li < len(qw) - 1:
                real = np.maximum(real, 0)
            q = np.clip(np.round(real / s_out) + z_out, -128, 127).astype(np.int32)
        s_out, z_out = aq[-1]
        return (q - z_out) * s_out  # dequantised logits

    return run, aq


def split_logits(z, heads=HEADS):
    out, i = [], 0
    for k in heads:
        zz = z[:, i:i + k] - z[:, i:i + k].max(1, keepdims=True)
        e = np.exp(zz)
        out.append(e / e.sum(1, keepdims=True))
        i += k
    return out
