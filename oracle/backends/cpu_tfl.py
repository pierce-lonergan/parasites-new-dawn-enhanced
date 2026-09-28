"""cpu_tfl / edgetpu: the int8 TFLite model through tflite_runtime (py3.9 venv) or ai_edge_litert.

Used inside the TPU worker process (oracle/tpu_worker.py), never in the supervisor: a native crash in
edgetpu.dll or libusb must only take the worker down (TDD 4.1). Nothing here runs until the M6/M7 downloads
are approved; the validation logic and the .tflite operator reader are pure Python and tested now.

Rejection (TDD 4.4.1): wrong input/output dtype or shape, quantisation parameters that differ from the manifest,
operator versions that differ from the manifest (S4b), or a sha256 mismatch -> BadModel.
"""
import struct
import time

import numpy as np

from . import N_INPUT, N_OUTPUT, dequantize, quantize, softmax_heads
from .manifest import BadModel, backend_file

# TFLite BuiltinOperator codes this model family can contain (schema_generated.h); others print as numbers.
BUILTIN_NAMES = {0: "ADD", 3: "CONV_2D", 4: "DEPTHWISE_CONV_2D", 6: "DEQUANTIZE", 9: "FULLY_CONNECTED", 19: "RELU",
                 22: "RESHAPE", 25: "SOFTMAX", 32: "CUSTOM", 114: "QUANTIZE"}


class BackendUnavailable(Exception):
    """No TFLite interpreter module (or delegate) is installed in this Python."""


# ---------------------------------------------------------------------------------------------
# Minimal FlatBuffers reader for the TFLite Model table: operator codes and their versions.
# Model fields: 0 version, 1 operator_codes [OperatorCode], 2 subgraphs, ...
# OperatorCode fields: 0 deprecated_builtin_code (int8), 1 custom_code (string), 2 version (int32, default 1),
# 3 builtin_code (int32). The effective code is max(deprecated_builtin_code, builtin_code) (TFLite's rule).

def _u32(b, o):
    return struct.unpack_from("<I", b, o)[0]


def _i32(b, o):
    return struct.unpack_from("<i", b, o)[0]


def _field(b, table, idx):
    """Absolute position of field idx of the table at `table`, or None when absent."""
    vt = table - _i32(b, table)
    vsize = struct.unpack_from("<H", b, vt)[0]
    slot = 4 + 2 * idx
    if slot + 2 > vsize:
        return None
    off = struct.unpack_from("<H", b, vt + slot)[0]
    return table + off if off else None


def tflite_ops(data):
    """[{op, code, version, custom}] from the bytes of a .tflite file. Raises BadModel on malformed input."""
    try:
        root = _u32(data, 0)
        opcodes = _field(data, root, 1)
        if opcodes is None:
            return []
        vec = opcodes + _u32(data, opcodes)
        n = _u32(data, vec)
        out = []
        for i in range(n):
            el = vec + 4 + 4 * i
            t = el + _u32(data, el)
            f0 = _field(data, t, 0)
            f1 = _field(data, t, 1)
            f2 = _field(data, t, 2)
            f3 = _field(data, t, 3)
            dep = struct.unpack_from("<b", data, f0)[0] if f0 is not None else 0
            ver = _i32(data, f2) if f2 is not None else 1
            code = _i32(data, f3) if f3 is not None else 0
            code = max(dep, code)
            custom = ""
            if f1 is not None:
                s = f1 + _u32(data, f1)
                custom = data[s + 4:s + 4 + _u32(data, s)].decode("utf-8", "replace")
            out.append({"op": BUILTIN_NAMES.get(code, str(code)) if code != 32 else "CUSTOM:" + custom,
                        "code": code, "version": ver, "custom": custom})
        return out
    except (struct.error, IndexError, UnicodeDecodeError) as e:
        raise BadModel("not a readable .tflite flatbuffer: %s" % e)


def _key(ops):
    return sorted((str(o.get("op")), int(o.get("version", 1))) for o in ops)


def check_ops(data, spec):
    """S4b gate at load time: the file's operator versions must equal the manifest's op_versions."""
    want = spec.get("op_versions")
    if not isinstance(want, list) or not want:
        raise BadModel("manifest lists no op_versions for this model (run train/s4b_check.py)")
    got = tflite_ops(data)
    if _key(got) != _key(want):
        raise BadModel("operator versions differ from the manifest: %s vs %s" % (_key(got), _key(want)))
    return got


def _same(a, b):
    return abs(float(a) - float(b)) <= 1e-9 * max(1.0, abs(float(b)))


def check_details(inp, out, spec):
    """Interpreter tensor details against the manifest (dtype, shape, scale, zero point). Raises BadModel."""
    si = spec.get("input") or {}
    so = spec.get("output") or {}
    want_in = str(si.get("dtype", "int8"))
    if want_in not in ("int8", "uint8"):
        raise BadModel("manifest input dtype must be int8 (uint8 only if stated)")
    for d, s, shape, what in ((inp, si, [1, N_INPUT], "input"), (out, so, [1, N_OUTPUT], "output")):
        dt = np.dtype(d["dtype"]).name
        if dt != str(s.get("dtype", "int8")):
            raise BadModel("%s dtype %s, manifest says %s" % (what, dt, s.get("dtype")))
        if [int(v) for v in d["shape"]] != shape:
            raise BadModel("%s shape %s, expected %s" % (what, list(d["shape"]), shape))
        scale, zp = d["quantization"]
        if s.get("scale") is None or s.get("zero_point") is None:
            raise BadModel("manifest has no %s quantisation parameters" % what)
        if not _same(scale, s["scale"]) or int(zp) != int(s["zero_point"]):
            raise BadModel("%s quantisation (%r, %r) differs from the manifest (%r, %r)" % (what, scale, zp, s["scale"], s["zero_point"]))


class TflInterpreter(object):
    """One TFLite interpreter (batch 1, as compiled) with the manifest checks applied."""

    def __init__(self, manifest, backend="cpu_tfl", delegate_lib=None, delegate_opts=None):
        path = backend_file(manifest, backend, verify=True)
        spec = manifest["backends"][backend]
        with open(path, "rb") as f:
            data = f.read()
        self.ops = check_ops(data, spec)
        try:
            from tflite_runtime.interpreter import Interpreter, load_delegate  # py3.9 + Coral wheels
        except ImportError:
            try:
                from ai_edge_litert.interpreter import Interpreter, load_delegate  # experimental on Windows
            except ImportError:
                raise BackendUnavailable("neither tflite_runtime nor ai_edge_litert is installed")
        delegates = []
        if delegate_lib:
            delegates = [load_delegate(delegate_lib, delegate_opts or {})]
        self.it = Interpreter(model_path=path, experimental_delegates=delegates, num_threads=1)
        self.it.allocate_tensors()
        inp = self.it.get_input_details()[0]
        out = self.it.get_output_details()[0]
        check_details(inp, out, spec)
        self.iidx, self.oidx = inp["index"], out["index"]
        self.in_dtype = np.dtype(inp["dtype"])
        self.s_in, self.zp_in = float(inp["quantization"][0]), int(inp["quantization"][1])
        self.s_out, self.zp_out = float(out["quantization"][0]), int(out["quantization"][1])
        self.name = backend
        for _ in range(10):  # warm-up: the first Edge TPU invoke uploads the parameters
            self.infer_q(np.full((1, N_INPUT), self.zp_in, self.in_dtype))

    def infer_q(self, q):
        """q: [n, 496] quantised windows -> [n, 11] quantised outputs (one invoke per row: batch 1)."""
        out = np.empty((q.shape[0], N_OUTPUT), dtype=np.int32)
        for i in range(q.shape[0]):
            self.it.set_tensor(self.iidx, np.ascontiguousarray(q[i:i + 1], dtype=self.in_dtype))
            self.it.invoke()
            out[i] = self.it.get_tensor(self.oidx)[0]
        return out

    def probs(self, q):
        """Quantised windows -> [n, 11] probabilities (dequantise + per-head softmax)."""
        return softmax_heads(dequantize(self.infer_q(q), self.s_out, self.zp_out))

    def bench(self, n=5000, warm=10):
        """G6 layers (a) invoke alone and (b) quantise + set + invoke + get + decode, in microseconds."""
        x = np.zeros((1, N_INPUT), np.float32)
        q = quantize(x, self.s_in, self.zp_in, self.in_dtype)
        for _ in range(warm):
            self.infer_q(q)
        a, b = [], []
        for _ in range(n):
            t0 = time.perf_counter_ns()
            self.it.set_tensor(self.iidx, q)
            t1 = time.perf_counter_ns()
            self.it.invoke()
            t2 = time.perf_counter_ns()
            self.it.get_tensor(self.oidx)
            a.append((t2 - t1) / 1e3)
            t3 = time.perf_counter_ns()
            self.probs(quantize(x, self.s_in, self.zp_in, self.in_dtype))
            b.append((time.perf_counter_ns() - t3) / 1e3)
        return {"invoke_us": _pct(a), "worker_us": _pct(b)}


def _pct(xs):
    xs = sorted(xs)
    n = len(xs)
    return {"p50": xs[n // 2], "p95": xs[int(n * 0.95)], "p99": xs[int(n * 0.99)], "max": xs[-1]}
