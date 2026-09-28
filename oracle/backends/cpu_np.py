"""cpu_np: the float32 numpy MLP 496-64-32-11 (the production default, runs in the supervisor process).

Weights come from oracle_mlp.npz as saved by oracle/train/train.py: arr_0..arr_5 = W0 (496x64), W1 (64x32),
b0 (64), b1 (32), Wo (32x11), bo (11), plus mu and sd (31 each). The file's sha256, every shape, finiteness
and mu/sd equality with the manifest are checked before the backend is used (BadModel otherwise).
Measured on the 9950X: median 17 us per window (TDD 4.5).
"""
import numpy as np

from . import N_FEATURES, N_INPUT, N_OUTPUT
from .manifest import BadModel, backend_file, sha256_file

LAYERS = ((N_INPUT, 64), (64, 32), (32, N_OUTPUT))


class CpuNpBackend(object):
    name = "cpu_np"

    def __init__(self, manifest):
        path = backend_file(manifest, "cpu_np", verify=True)
        spec = manifest["backends"]["cpu_np"]
        layers = tuple(tuple(x) for x in spec.get("layers") or ())
        if layers != LAYERS:
            raise BadModel("cpu_np layers must be %s" % (list(LAYERS),))
        try:
            z = np.load(path, allow_pickle=False)
            arrs = [z["arr_%d" % i] for i in range(6)]
            mu = z["mu"]
            sd = z["sd"]
        except Exception as e:  # zip, key or format errors all mean a bad model
            raise BadModel("cpu_np weights unreadable: %s" % e)
        W0, W1, b0, b1, Wo, bo = arrs
        want = ((W0, (N_INPUT, 64)), (W1, (64, 32)), (b0, (64,)), (b1, (32,)), (Wo, (32, N_OUTPUT)), (bo, (N_OUTPUT,)),
                (mu, (N_FEATURES,)), (sd, (N_FEATURES,)))
        for a, shape in want:
            if tuple(a.shape) != shape:
                raise BadModel("cpu_np array shape %s, expected %s" % (tuple(a.shape), shape))
            if not np.all(np.isfinite(a)):
                raise BadModel("cpu_np weights hold NaN or infinity")
        if not np.array_equal(mu.astype(np.float32), np.asarray(manifest["mu"], np.float32)) or \
                not np.array_equal(sd.astype(np.float32), np.asarray(manifest["sd"], np.float32)):
            raise BadModel("cpu_np mu/sd differ from the manifest")
        self.W0, self.W1, self.Wo = W0.astype(np.float32), W1.astype(np.float32), Wo.astype(np.float32)
        self.b0, self.b1, self.bo = b0.astype(np.float32), b1.astype(np.float32), bo.astype(np.float32)
        self.sha256 = sha256_file(path)
        self.path = path

    def infer(self, xn):
        """xn: [n, 496] standardised windows -> [n, 11] float32 logits."""
        x = np.asarray(xn, dtype=np.float32)
        if x.ndim != 2 or x.shape[1] != N_INPUT:
            raise ValueError("cpu_np expects [n, %d], got %s" % (N_INPUT, x.shape))
        h = np.maximum(x @ self.W0 + self.b0, 0)
        h = np.maximum(h @ self.W1 + self.b1, 0)
        return h @ self.Wo + self.bo
