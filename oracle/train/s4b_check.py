"""S4b operator-version gate (TDD 4.2). NOT RUN in M5: it needs the M6 WSL downloads (CPython 3.9 +
tflite_runtime 2.5.0.post1 manylinux cp39 + numpy 1.26.4), which wait for the user's approval.

    python oracle/train/s4b_check.py --out out/

Loads out/oracle_mlp_int8.tflite in tflite_runtime 2.5.0.post1 (the version of the official Windows Coral
wheels), calls allocate_tensors() and runs 100 windows (out/s4b_windows.npy). A "Didn't find op for builtin
opcode ... version N" error means TF 2.15 emitted an operator version the old runtime cannot run: then S4 is
repeated with an older TF pinned for the converter step only (TDD 4.2). On success it writes each model's
operator codes and versions (read straight from the flatbuffer) into out/tflite_report.json, which
make_manifest.py copies into the manifest so the worker can refuse a model whose operators differ.
Python 3.9 syntax.
"""
import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import numpy as np  # noqa: E402

from backends.cpu_tfl import tflite_ops  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    a = ap.parse_args()
    from tflite_runtime.interpreter import Interpreter  # the py3.9 runtime under test
    import tflite_runtime
    path = os.path.join(a.out, "oracle_mlp_int8.tflite")
    try:
        it = Interpreter(model_path=path)
        it.allocate_tensors()
        di, do = it.get_input_details()[0], it.get_output_details()[0]
        s_in, zp_in = di["quantization"]
        X = np.load(os.path.join(a.out, "s4b_windows.npy"))
        for n in range(min(100, len(X))):
            q = np.clip(np.round(X[n:n + 1] / s_in) + zp_in, -128, 127).astype(np.int8)
            it.set_tensor(di["index"], q)
            it.invoke()
            it.get_tensor(do["index"])
    except (RuntimeError, ValueError) as e:
        msg = str(e)
        if "Didn't find op for builtin opcode" in msg:
            print("S4b FAILED: tflite_runtime %s cannot run an operator version in this model:\n%s" % (tflite_runtime.__version__, msg))
            print("Re-run S4 with an older TensorFlow pinned for the converter step only (for example 2.10).")
        else:
            print("S4b FAILED: %s" % msg)
        return 1
    rp = os.path.join(a.out, "tflite_report.json")
    report = json.load(open(rp))
    for key, fn in (("int8", "oracle_mlp_int8.tflite"), ("edgetpu", "oracle_mlp_int8_edgetpu.tflite")):
        p = os.path.join(a.out, fn)
        if os.path.isfile(p):
            report[key]["op_versions"] = [{"op": o["op"], "version": o["version"]} for o in tflite_ops(open(p, "rb").read())]
    report["s4b"] = {"tflite_runtime": tflite_runtime.__version__, "windows": 100, "result": "pass"}
    json.dump(report, open(rp, "w"), indent=1)
    print("S4b passed with tflite_runtime %s; operator versions written to %s" % (tflite_runtime.__version__, rp))
    return 0


if __name__ == "__main__":
    sys.exit(main())
