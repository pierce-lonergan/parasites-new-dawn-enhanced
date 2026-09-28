"""Writes oracle/models/oracle_manifest.json (TDD 4.2 S6) from the model files next to it.

    python oracle/train/make_manifest.py [--models oracle/models] [--tflite-report out/tflite_report.json]

Always records the cpu_np model (oracle_mlp.npz): sha256, layer shapes, parameter count, and mu/sd copied from
the npz so the supervisor can check they agree. The int8 TFLite models (cpu_tfl, edgetpu) are listed with their
sha256 only once they exist; their quantisation parameters and operator versions come from the report that
train/wsl_train_export.py and train/s4b_check.py write in WSL (M6). Until then those fields stay null and the
supervisor refuses those backends (BAD_MODEL), which is the intended state before the downloads are approved.
"""
import argparse
import hashlib
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "sim"))
from sim import FEATURES  # noqa: E402


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def tfl_entry(models, fn, report, key):
    p = os.path.join(models, fn)
    r = (report or {}).get(key) or {}
    return {
        "file": fn,
        "sha256": sha(p) if os.path.isfile(p) else None,
        "input": {"dtype": r.get("input_dtype", "int8"), "shape": [1, 496], "scale": r.get("input_scale"), "zero_point": r.get("input_zero_point")},
        "output": {"dtype": r.get("output_dtype", "int8"), "shape": [1, 11], "scale": r.get("output_scale"), "zero_point": r.get("output_zero_point")},
        "op_versions": r.get("op_versions"),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default=os.path.join(ROOT, "models"))
    ap.add_argument("--tflite-report", default=None)
    a = ap.parse_args(argv)
    npz = os.path.join(a.models, "oracle_mlp.npz")
    z = np.load(npz)
    arrs = [z["arr_%d" % i] for i in range(6)]
    report = json.load(open(a.tflite_report, encoding="utf-8")) if a.tflite_report else None
    m = {
        "schema": 1,
        "model": "oracle-mlp-496-64-32-11",
        "feature_names": list(FEATURES),
        "window": 16,
        "input_layout": "time-major [16 x 31] flattened to 496, oldest second first; x_n = (x - mu) / sd per feature; "
                        "zero-padded in normalised space until the window is full",
        "heads": {"arousal": ["calm", "uneasy", "tense", "panic"], "style": ["hide", "kite", "turtle", "explore"],
                  "fe": ["neither", "flee", "engage"]},
        "output_layout": {"arousal": [0, 4], "style": [4, 8], "fe": [8, 11]},
        "postprocess": "per-head softmax on the host; conf = max(arousal); E_O = (p1 + 2 p2 + 3 p3) / 3",
        "mu": [float(v) for v in z["mu"]],
        "sd": [float(v) for v in z["sd"]],
        "backends": {
            "cpu_np": {"file": "oracle_mlp.npz", "sha256": sha(npz), "dtype": "float32", "layers": [[496, 64], [64, 32], [32, 11]],
                       "npz_order": ["W0", "W1", "b0", "b1", "Wo", "bo"], "params": int(sum(x.size for x in arrs))},
            "cpu_tfl": tfl_entry(a.models, "oracle_mlp_int8.tflite", report, "int8"),
            "edgetpu": dict(tfl_entry(a.models, "oracle_mlp_int8_edgetpu.tflite", report, "edgetpu"),
                            compiler_log_sha256=(report or {}).get("compiler_log_sha256")),
        },
        "training": {
            "source": "oracle/train/train.py (numpy) on the synthetic simulator oracle/sim/sim.py; measured results in TDD 4.3",
            "seeds": {"train_data": 11, "val_data": 12, "test_data": 13, "model": 2},
            "data_hash": (report or {}).get("data_hash"),
            "tf_version": (report or {}).get("tf_version"),
        },
        "generated_by": "oracle/train/make_manifest.py",
    }
    out = os.path.join(a.models, "oracle_manifest.json")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(m, f, indent=1)
        f.write("\n")
    print("wrote %s (cpu_np sha256 %s)" % (out, m["backends"]["cpu_np"]["sha256"][:12]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
