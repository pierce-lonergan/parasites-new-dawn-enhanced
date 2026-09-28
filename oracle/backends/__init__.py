"""Oracle inference backends and the shared tensor contract (TDD 4.3, 4.4.1).

Model: input [n, 496] = 16 time steps x 31 features, time-major (oldest first), standardised per feature
with the manifest's mu/sd and zero-padded in normalised space until the window is full. Output [n, 11] logits:
0-3 arousal {calm, uneasy, tense, panic}, 4-7 style {hide, kite, turtle, explore}, 8-10 {neither, flee, engage}.
The per-head softmax runs on the host (here), never in the model.

Backends:
  cpu_np   numpy float32 MLP in the supervisor process (production default, always available)
  cpu_tfl  TFLite int8 on the CPU (in the worker process; needs tflite_runtime or ai_edge_litert)
  edgetpu  TFLite int8 with the Edge TPU delegate (in the worker process)

Python 3.9-compatible syntax on purpose (no match statements, no X | Y unions): the TPU worker runs in the
py3.9 venv that the official Windows Coral wheels need.
"""
import numpy as np

WINDOW = 16
N_FEATURES = 31
N_INPUT = WINDOW * N_FEATURES
N_OUTPUT = 11
HEADS = (("arousal", 0, 4), ("style", 4, 8), ("fe", 8, 11))
AROUSAL = ("calm", "uneasy", "tense", "panic")
STYLES = ("hide", "kite", "turtle", "explore")
FE = ("neither", "flee", "engage")
BACKEND_CODES = {"cpu_np": 0, "cpu_tfl": 1, "edgetpu": 2}
BACKEND_NAMES = {0: "cpu_np", 1: "cpu_tfl", 2: "edgetpu"}


def softmax_heads(logits):
    """Per-head softmax of [n, 11] logits -> [n, 11] probabilities (float64)."""
    z = np.asarray(logits, dtype=np.float64)
    if z.ndim == 1:
        z = z[None, :]
    out = np.empty_like(z)
    for _name, a, b in HEADS:
        zz = z[:, a:b] - z[:, a:b].max(axis=1, keepdims=True)
        e = np.exp(zz)
        out[:, a:b] = e / e.sum(axis=1, keepdims=True)
    return out


def summarize(probs):
    """[n, 11] probabilities -> list of dicts {arousal, style, fe, conf, EO}."""
    res = []
    for row in np.asarray(probs, dtype=np.float64):
        ar = row[0:4]
        res.append({
            "arousal": ar.tolist(),
            "style": row[4:8].tolist(),
            "fe": row[8:11].tolist(),
            "conf": float(ar.max()),
            "EO": float((ar[1] + 2.0 * ar[2] + 3.0 * ar[3]) / 3.0),
        })
    return res


def quantize(xn, scale, zero_point, dtype=np.int8):
    """q = clip(round(xn / s) + zp, dtype range) (TDD 4.4.1 preprocess)."""
    info = np.iinfo(dtype)
    q = np.round(np.asarray(xn, dtype=np.float64) / float(scale)) + int(zero_point)
    return np.clip(q, info.min, info.max).astype(dtype)


def dequantize(q, scale, zero_point):
    """y = (q - zp) * s (TDD 4.4.1 postprocess)."""
    return (np.asarray(q, dtype=np.float64) - int(zero_point)) * float(scale)
