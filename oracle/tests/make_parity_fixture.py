"""Builds oracle/tests/fixtures/parity.npz, the recorded input and golden output of the cpu_np parity test.

    python oracle/tests/make_parity_fixture.py <prototype oracle folder (tdd/oracle)>

Not run by the suites (it needs the prototype folder). It records:
  X         [4, 80, 31] float32   raw telemetry of 4 simulated players for 80 s (oracle/sim/sim.py, seed 99)
  expected  [4, 80, 11] float64   the prototype's own MLP (tdd/oracle/closed_loop.py mlp(): weights from its
                                  oracle_mlp.npz, nn.split_logits) on the window ending at each second, built by the
                                  TDD 4.4.1 rule: standardise with mu/sd, zero-pad in normalised space until full
  proto_full [4, 80, 11]          the prototype closed loop's own buffer semantics (raw zeros before the first
                                  second, then normalised); equals `expected` from the 16th second on
"""
import importlib.util
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ORACLE = os.path.dirname(HERE)


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main(proto):
    sim = load("pne_sim", os.path.join(ORACLE, "sim", "sim.py"))
    pnn = load("proto_nn", os.path.join(proto, "nn.py"))
    z = np.load(os.path.join(proto, "oracle_mlp.npz"))
    W0, W1, b0, b1, Wo, bo = [z["arr_%d" % i] for i in range(6)]
    mu, sd = z["mu"], z["sd"]

    def mlp(xw):  # verbatim from tdd/oracle/closed_loop.py
        h = np.maximum(xw @ W0 + b0, 0)
        h = np.maximum(h @ W1 + b1, 0)
        return pnn.split_logits(h @ Wo + bo)

    X, _s, _k, _m, _fe, _d = sim.generate(4, 80, seed=99)
    X = X.astype(np.float32)
    N, T, F = X.shape
    expected = np.zeros((N, T, 11))
    proto_full = np.zeros((N, T, 11))
    buf = np.zeros((N, 16, F), np.float32)
    for t in range(T):
        win = np.zeros((N, 16, F), np.float32)
        k = min(16, t + 1)
        win[:, 16 - k:] = ((X[:, t + 1 - k:t + 1] - mu) / sd).astype(np.float32)
        P = mlp(win.reshape(N, -1).astype(np.float32))
        expected[:, t] = np.concatenate(P, axis=1)
        buf = np.roll(buf, -1, 1)
        buf[:, -1] = X[:, t]
        Q = mlp(((buf - mu) / sd).reshape(N, -1).astype(np.float32))
        proto_full[:, t] = np.concatenate(Q, axis=1)
    assert np.abs(expected[:, 15:] - proto_full[:, 15:]).max() < 1e-9
    out = os.path.join(HERE, "fixtures", "parity.npz")
    np.savez_compressed(out, X=X, expected=expected, proto_full=proto_full)
    print("wrote %s: X %s, max |expected - proto| over full windows %.2e" % (out, X.shape, np.abs(expected[:, 15:] - proto_full[:, 15:]).max()))


if __name__ == "__main__":
    main(sys.argv[1])
