"""The Oracle's TPU worker: a subprocess of the supervisor that owns the Edge TPU delegate (TDD 4.4.2).

It speaks the v2 frame protocol on stdin/stdout (backends/pipe_v2.py): HELLO -> WELCOME, INFER_WINDOW -> RESULT
(or ERROR), PING -> PONG, EXIT (or end of stdin) -> exit. A native crash in edgetpu.dll or libusb takes down only
this process; the supervisor demotes to cpu_np and respawns it with backoff. It never writes anything but frames
to stdout (diagnostics go to stderr).

Runs in the py3.9 venv of the official Coral wheels (tflite_runtime 2.5.0.post1 + edgetpu.dll), so the syntax
stays Python 3.9-compatible. Backends:
  --backend edgetpu   int8 model + load_delegate('edgetpu.dll', {'device': 'usb'})   (M7, after the user installs
                      the driver; not runnable before the downloads are approved)
  --backend cpu_tfl   the same int8 model on the CPU interpreter
  --backend numpy     float32 cpu_np weights behind the same protocol (dequantises the int8 input); used by the
                      tests and as a protocol check on machines without TFLite
  --bench             prints the G6 latency layers (a) invoke and (b) quantise+set+invoke+get+decode as JSON
"""
import argparse
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

from backends import BACKEND_CODES, N_FEATURES, WINDOW, dequantize, softmax_heads  # noqa: E402
from backends import pipe_v2 as P  # noqa: E402
from backends.manifest import BadModel, load as load_manifest, sha256_file  # noqa: E402

DEFAULT_S_IN = 0.05   # numpy backend only, when the manifest has no int8 input quantisation yet
DEFAULT_ZP_IN = 0


def log(msg):
    sys.stderr.write("[tpu_worker] %s\n" % msg)
    sys.stderr.flush()


class NumpyEngine(object):
    """cpu_np weights behind the worker protocol: int8 windows are dequantised with (s_in, zp_in) first."""

    def __init__(self, manifest):
        from backends.cpu_np import CpuNpBackend
        self.net = CpuNpBackend(manifest)
        q = ((manifest.get("backends") or {}).get("cpu_tfl") or {}).get("input") or {}
        self.s_in = float(q["scale"]) if q.get("scale") is not None else DEFAULT_S_IN
        self.zp_in = int(q["zero_point"]) if q.get("zero_point") is not None else DEFAULT_ZP_IN
        self.name = "cpu_np"

    def probs(self, q):
        return softmax_heads(self.net.infer(dequantize(q, self.s_in, self.zp_in).astype(np.float32)))


class TflEngine(object):
    def __init__(self, manifest, backend, delegate, device):
        from backends.cpu_tfl import TflInterpreter
        lib = delegate if backend == "edgetpu" else None
        opts = {"device": device} if backend == "edgetpu" and device else None
        self.it = TflInterpreter(manifest, backend=backend, delegate_lib=lib, delegate_opts=opts)
        self.s_in, self.zp_in = self.it.s_in, self.it.zp_in
        self.name = backend

    def probs(self, q):
        return self.it.probs(q)


def make_engine(args, manifest):
    if args.backend == "numpy":
        return NumpyEngine(manifest)
    return TflEngine(manifest, args.backend, args.delegate, args.device)


def binary_stdio():
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    return sys.stdin.buffer, sys.stdout.buffer


def serve(engine, manifest, manifest_path, inp, out):
    def send(data):
        out.write(data)
        out.flush()

    while True:
        try:
            payload = P.read_frame(inp)
        except P.ProtocolError as e:
            log("protocol error: %s" % e)
            return 2
        if payload is None:
            return 0
        try:
            mtype, seq, tick, n, body = P.parse(payload)
        except P.ProtocolError as e:
            send(P.json_frame(P.ERROR, {"code": "VERSION_MISMATCH" if "VERSION" in str(e) else "BAD_SHAPE", "msg": str(e)}))
            continue
        if mtype == P.EXIT:
            return 0
        if mtype == P.PING:
            send(P.json_frame(P.PONG, {}, seq, tick))
        elif mtype == P.HELLO:
            send(P.json_frame(P.WELCOME, {
                "v": 2, "backend": engine.name, "model": manifest.get("model"), "manifest_sha256": sha256_file(manifest_path),
                "feature_names": manifest["feature_names"], "window": WINDOW, "mu": manifest["mu"], "sd": manifest["sd"],
                "s_in": engine.s_in, "zp_in": engine.zp_in, "deadline_ms": 5}))
        elif mtype == P.INFER_WINDOW:
            try:
                pids, q = P.parse_infer_window(n, body)
            except P.ProtocolError:
                send(P.json_frame(P.ERROR, {"seq": seq, "code": "BAD_SHAPE"}, seq, tick))
                continue
            t0 = time.perf_counter()
            try:
                probs = engine.probs(q)
            except Exception as e:  # a delegate or USB failure: report it and leave, the supervisor respawns us
                send(P.json_frame(P.ERROR, {"seq": seq, "code": "DEVICE_LOST", "msg": str(e)[:200]}, seq, tick))
                return 3
            us = int((time.perf_counter() - t0) * 1e6)
            send(P.result_frame(seq, tick, BACKEND_CODES.get(engine.name, 2), us, pids, probs))
        elif mtype == P.INFER:
            send(P.json_frame(P.ERROR, {"seq": seq, "code": "BAD_SHAPE", "msg": "this worker is stateless: send INFER_WINDOW"}, seq, tick))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--backend", choices=("edgetpu", "cpu_tfl", "numpy"), default="edgetpu")
    ap.add_argument("--delegate", default="edgetpu.dll")
    ap.add_argument("--device", default="usb")
    ap.add_argument("--bench", action="store_true")
    args = ap.parse_args(argv)
    try:
        manifest = load_manifest(args.manifest)
        engine = make_engine(args, manifest)
    except BadModel as e:
        log("BAD_MODEL: %s" % e)
        if args.bench:
            return 2
        inp, out = binary_stdio()
        payload = P.read_frame(inp)  # answer the HELLO so the supervisor knows why
        if payload is not None:
            out.write(P.json_frame(P.ERROR, {"code": "NO_MODEL", "msg": str(e)[:200]}))
            out.flush()
        return 2
    except Exception as e:  # interpreter or delegate unavailable
        log("backend %s unavailable: %s" % (args.backend, e))
        if args.bench:
            return 2
        inp, out = binary_stdio()
        payload = P.read_frame(inp)
        if payload is not None:
            out.write(P.json_frame(P.ERROR, {"code": "NO_MODEL", "msg": str(e)[:200]}))
            out.flush()
        return 2
    if args.bench:
        if hasattr(engine, "it"):
            print(json.dumps(engine.it.bench(), indent=1))
        else:
            x = np.zeros((1, WINDOW * N_FEATURES), np.int8)
            ts = []
            for _ in range(5000):
                t0 = time.perf_counter_ns()
                engine.probs(x)
                ts.append((time.perf_counter_ns() - t0) / 1e3)
            ts.sort()
            print(json.dumps({"worker_us": {"p50": ts[2500], "p99": ts[4950], "max": ts[-1]}}, indent=1))
        return 0
    inp, out = binary_stdio()
    return serve(engine, manifest, os.path.abspath(args.manifest), inp, out)


if __name__ == "__main__":
    sys.exit(main())
