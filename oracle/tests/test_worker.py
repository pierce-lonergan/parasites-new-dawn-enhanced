"""oracle-worker suite: the v2 frame protocol, the .tflite operator reader and model checks, quantisation, the
real tpu_worker.py (numpy backend, since TFLite is not installed before M6/M7), and the supervisor's watchdog
against a fake worker process (soft 5 ms -> cpu_np and demotion after 3, hard 250 ms, crash, garbage, ERROR,
no WELCOME; respawn with exponential backoff). The handshake never blocks: start() returns at once and poll()
finishes it; a worker that ignores EXIT is never doubled (state blocked) and a supervisor whose worker never answers
HELLO keeps its heartbeat and its cpu_np verdicts. No worker is ever killed: each leaves on EXIT, when its stdin
closes, or (the stuck fake) by itself after a few seconds.

    python oracle/tests/test_worker.py
"""
import json
import os
import struct
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

import numpy as np  # noqa: E402

from backends import dequantize, quantize, softmax_heads  # noqa: E402
from backends import pipe_v2 as P  # noqa: E402
from backends.cpu_np import CpuNpBackend  # noqa: E402
from backends.cpu_tfl import check_details, check_ops, tflite_ops  # noqa: E402
from backends.manifest import BadModel, load as load_manifest  # noqa: E402
from backends.worker_client import WorkerBackend  # noqa: E402

MANIFEST = os.path.join(C.MODELS, "oracle_manifest.json")
FAKE = os.path.join(HERE, "fake_worker.py")
WORKER = os.path.join(C.ORACLE, "tpu_worker.py")
FIX = np.load(os.path.join(HERE, "fixtures", "parity.npz"))


def windows(n=4):
    m = load_manifest(MANIFEST)
    mu, sd = np.asarray(m["mu"], np.float32), np.asarray(m["sd"], np.float32)
    X = FIX["X"]
    return ((X[:n, 20:36] - mu) / sd).reshape(n, -1).astype(np.float32)


PIDS = [C.pid_hex(i) for i in range(4)]


def build_tflite(ops):
    """A minimal TFLite flatbuffer: Model{version, operator_codes[OperatorCode{dep, custom, version, builtin}]}."""
    b = bytearray(8)
    b[4:8] = b"TFL3"
    mvt = len(b)
    b += struct.pack("<HHHH", 8, 12, 4, 8)
    root = len(b)
    b += struct.pack("<iII", root - mvt, 3, 0)
    struct.pack_into("<I", b, 0, root)
    vec = len(b)
    b += struct.pack("<I", len(ops)) + b"\0" * (4 * len(ops))
    struct.pack_into("<I", b, root + 8, vec - (root + 8))
    for i, (dep, ver, code, custom) in enumerate(ops):
        vt = len(b)
        b += struct.pack("<HHHHHH", 12, 20, 4, 8 if custom else 0, 12 if ver is not None else 0, 16)
        t = len(b)
        b += struct.pack("<ib3xIii", t - vt, dep, 0, ver or 0, code)
        if custom:
            s = len(b)
            b += struct.pack("<I", len(custom)) + custom.encode() + b"\0"
            struct.pack_into("<I", b, t + 8, s - (t + 8))
        el = vec + 4 + 4 * i
        struct.pack_into("<I", b, el, t - el)
    return bytes(b)


def test_protocol(ck):
    q = quantize(windows(), 0.05, 0)
    f = P.infer_window_frame(7, 123456789012, PIDS, q)
    payload = f[4:]
    mtype, seq, tick, n, body = P.parse(payload)
    pids, q2 = P.parse_infer_window(n, body)
    ck.ok(mtype == P.INFER_WINDOW and seq == 7 and tick == 123456789012 and pids == PIDS and np.array_equal(q, q2), "INFER_WINDOW round trip")
    ck.ok(len(f) == 4 + 20 + 4 * (16 + 496) and f[4:8] == b"PNEO" and f[8] == 2, "frame = u32 length + 20-byte header 'PNEO' v2 + body")
    ck.ok(P.pid_bytes(PIDS[1]) == bytes.fromhex(PIDS[1]), "pid is 16 raw bytes in RFC 4122 order (hex order)")
    probs = softmax_heads(np.random.default_rng(1).normal(size=(4, 11)))
    code, us, rp, pr, conf, flags = P.parse_result(4, P.parse(P.result_frame(7, 1, 2, 812, PIDS, probs, [0, 1, 0, 0])[4:])[4])
    ck.ok(code == 2 and us == 812 and rp == PIDS and np.allclose(pr, probs, atol=1e-7) and flags == [0, 1, 0, 0] and
          np.allclose(conf, probs[:, :4].max(1), atol=1e-7), "RESULT round trip (backend, infer_us, 11 probs, conf, flags)")
    feats = FIX["X"][:4, 0]
    pids, f2 = P.parse_infer(4, P.parse(P.infer_frame(1, 1, PIDS, feats)[4:])[4])
    ck.ok(np.array_equal(f2, feats.astype(np.float32)), "INFER round trip (31 x f32, little-endian)")
    j = P.body_json(P.parse(P.json_frame(P.WELCOME, {"v": 2, "backend": "edgetpu"})[4:])[4])
    ck.ok(j == {"v": 2, "backend": "edgetpu"}, "JSON control message round trip")
    bad = [b"XXXX" + payload[4:], payload[:4] + b"\x01" + payload[5:], payload[:10], payload[:4] + b"\x02\x63" + payload[6:]]
    errs = 0
    for bp in bad:
        try:
            P.parse(bp)
        except P.ProtocolError:
            errs += 1
    ck.ok(errs == 4, "bad magic, wrong version, short payload and unknown type are protocol errors")
    try:
        P.parse_infer_window(4, body[:-1])
        ck.ok(False, "a short INFER_WINDOW body must fail")
    except P.ProtocolError as e:
        ck.ok(str(e) == "BAD_SHAPE", "a short INFER_WINDOW body is BAD_SHAPE")
    import io
    s = io.BytesIO(f[:30])
    try:
        P.read_frame(s)
        ck.ok(False, "EOF inside a frame must fail")
    except P.ProtocolError:
        ck.ok(True, "EOF inside a frame is a protocol error")
    ck.ok(P.read_frame(io.BytesIO(b"")) is None, "a clean EOF reads as None")


def test_tflite_checks(ck):
    data = build_tflite([(9, 4, 9, None), (19, None, 19, None), (0, 1, 32, "edgetpu-custom-op")])
    ops = tflite_ops(data)
    ck.ok([(o["op"], o["version"]) for o in ops] == [("FULLY_CONNECTED", 4), ("RELU", 1), ("CUSTOM:edgetpu-custom-op", 1)],
          "operator codes and versions read from the flatbuffer (%s)" % [(o["op"], o["version"]) for o in ops])
    spec = {"op_versions": [{"op": "FULLY_CONNECTED", "version": 4}, {"op": "RELU", "version": 1}, {"op": "CUSTOM:edgetpu-custom-op", "version": 1}]}
    ck.ok(len(check_ops(data, spec)) == 3, "matching op versions are accepted")
    for what, sp in (("an op version differs", {"op_versions": [{"op": "FULLY_CONNECTED", "version": 5}, {"op": "RELU", "version": 1},
                                                                  {"op": "CUSTOM:edgetpu-custom-op", "version": 1}]}),
                     ("no op_versions in the manifest", {"op_versions": None})):
        try:
            check_ops(data, sp)
            ck.ok(False, "not refused: %s" % what)
        except BadModel:
            ck.ok(True, "refused: %s" % what)
    try:
        tflite_ops(b"\x00\x01")
        ck.ok(False, "garbage must fail")
    except BadModel:
        ck.ok(True, "a non-flatbuffer is BAD_MODEL")
    spec = {"input": {"dtype": "int8", "scale": 0.0382, "zero_point": 1}, "output": {"dtype": "int8", "scale": 0.193, "zero_point": -10}}
    good_in = {"dtype": np.int8, "shape": np.array([1, 496]), "quantization": (0.0382, 1), "index": 0}
    good_out = {"dtype": np.int8, "shape": np.array([1, 11]), "quantization": (0.193, -10), "index": 5}
    check_details(good_in, good_out, spec)
    ck.ok(True, "matching dtype, shape and quantisation are accepted")
    cases = (("uint8 input", dict(good_in, dtype=np.uint8), good_out), ("batch 8 input", dict(good_in, shape=np.array([8, 496])), good_out),
             ("input scale differs", dict(good_in, quantization=(0.04, 1)), good_out), ("output zero point differs", good_in, dict(good_out, quantization=(0.193, -9))),
             ("float output", good_in, dict(good_out, dtype=np.float32)))
    for what, i, o in cases:
        try:
            check_details(i, o, spec)
            ck.ok(False, "not refused: %s" % what)
        except BadModel:
            ck.ok(True, "refused: %s" % what)
    x = np.array([-10.0, -0.024, 0.026, 3.0, 10.0])
    q = quantize(x, 0.05, 1)
    ck.ok(q.tolist() == [-128, 1, 2, 61, 127] and q.dtype == np.int8, "q = clip(round(x / s) + zp, -128, 127) (%s)" % q.tolist())
    ck.ok(np.allclose(dequantize(q, 0.05, 1), [-6.45, 0.0, 0.05, 3.0, 6.3]), "y = (q - zp) * s")


def ref_probs(xn, s_in=0.05, zp=0):
    net = CpuNpBackend(load_manifest(MANIFEST))
    return softmax_heads(net.infer(dequantize(quantize(xn, s_in, zp), s_in, zp).astype(np.float32)))


def wb(mode_or_cmd, **kw):
    cmd = mode_or_cmd if isinstance(mode_or_cmd, list) else [sys.executable, FAKE, mode_or_cmd]
    kw.setdefault("backoff_base", 0.2)
    kw.setdefault("reprobe_s", 0.5)
    return WorkerBackend(cmd, cwd=C.ORACLE, log_path=os.path.join(C.tmpdir("wlog"), "worker.log"), **kw)


def settle(w, timeout=5.0):
    """Drives poll() until the handshake is over, as the supervisor loop does every 25 ms. True when ready."""
    end = time.perf_counter() + timeout
    while w.state == "starting" and time.perf_counter() < end:
        w.poll()
        time.sleep(0.005)
    return w.state == "ready"


def gone(p, timeout=5.0):
    try:
        return p.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return None


def test_real_worker(ck):
    x = windows()
    w = wb([sys.executable, WORKER, "--manifest", MANIFEST, "--backend", "numpy"], soft_s=0.25)
    ck.ok(w.start() and settle(w, 15) and w.backend == "cpu_np", "tpu_worker.py (numpy backend) answers HELLO with WELCOME")
    r = None
    for k in range(3):
        r = w.infer(10 + k, 1000, PIDS, x) or r
    ck.ok(r is not None and np.allclose(r[0], ref_probs(x), atol=1e-6) and r[1] == "cpu_np", "INFER_WINDOW -> RESULT equals cpu_np on the int8 window")
    p = w.proc
    w.stop()
    ck.ok(gone(p) == 0, "EXIT frame: the worker leaves with code 0")
    # direct protocol checks
    proc = subprocess.Popen([sys.executable, WORKER, "--manifest", MANIFEST, "--backend", "numpy"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, cwd=C.ORACLE)

    def ask(data):
        proc.stdin.write(data)
        proc.stdin.flush()
        return P.parse(P.read_frame(proc.stdout))

    t, seq, _tk, _n, body = ask(P.json_frame(P.HELLO, {"v": 2, "client": "test"}))
    wel = P.body_json(body)
    ck.ok(t == P.WELCOME and wel["window"] == 16 and len(wel["mu"]) == 31 and wel["manifest_sha256"], "WELCOME carries window, mu/sd, s_in/zp_in, manifest sha")
    t, seq, _tk, _n, _b = ask(P.json_frame(P.PING, {}, seq=77))
    ck.ok(t == P.PONG and seq == 77, "PING -> PONG with the same seq")
    t, seq, _tk, _n, body = ask(P.infer_frame(5, 1, PIDS[:1], FIX["X"][:1, 0]))
    ck.ok(t == P.ERROR and P.body_json(body)["code"] == "BAD_SHAPE", "INFER to the stateless worker -> ERROR BAD_SHAPE")
    fr = bytearray(P.json_frame(P.PING, {}))
    fr[8] = 1
    t, seq, _tk, _n, body = ask(bytes(fr))
    ck.ok(t == P.ERROR and P.body_json(body)["code"] == "VERSION_MISMATCH", "a v1 frame -> ERROR VERSION_MISMATCH")
    proc.stdin.write(P.json_frame(P.EXIT, {}))
    proc.stdin.flush()
    proc.stdin.close()
    ck.ok(gone(proc) == 0, "EXIT ends the worker (code 0)")
    # cpu_tfl without TFLite or a compiled model: refused, the supervisor stays on cpu_np
    w = wb([sys.executable, WORKER, "--manifest", MANIFEST, "--backend", "cpu_tfl"], hello_timeout=15)
    w.start()
    settle(w, 15)
    ck.ok(w.state == "backoff" and any("NO_MODEL" in e for e in w.events), "no int8 model yet: the worker reports NO_MODEL and is not used")
    out = subprocess.run([sys.executable, WORKER, "--manifest", MANIFEST, "--backend", "numpy", "--bench"], capture_output=True, text=True, timeout=120, cwd=C.ORACLE)
    ok = out.returncode == 0 and "worker_us" in out.stdout
    ck.ok(ok, "worker --bench prints latency layers")
    if ok:
        ck.note("tpu_worker numpy backend worker_us %s" % json.loads(out.stdout)["worker_us"])


def test_watchdog(ck):
    x = windows()
    w = wb("ok", soft_s=0.05)
    ck.ok(w.start() and settle(w) and w.backend == "edgetpu" and w.status()["usb"]["vidpid"] == "18D1:9302", "fake worker ready (backend edgetpu, usb info)")
    served = sum(1 for k in range(10) if w.infer(k + 1, 1, PIDS, x) is not None)
    ck.ok(served >= 9 and w.state == "ready", "normal worker serves the requests (%d/10)" % served)
    r = w.infer(99, 1, PIDS, x)
    ck.ok(r is None or np.allclose(r[0], ref_probs(x), atol=1e-6), "results match cpu_np on the int8 window")
    p = w.proc
    w.stop()
    ck.ok(gone(p) == 0, "normal worker leaves on EXIT")

    w = wb("slow", soft_s=0.005)
    w.start()
    settle(w)
    rs = []
    p = w.proc
    for k in range(3):
        rs.append(w.infer(k + 1, 1, PIDS, x))
        time.sleep(0.06)  # requests are 1 s apart in the game; the late answer drains before the next one
    ck.ok(all(r is None for r in rs), "a 30 ms worker misses the 5 ms soft deadline: each second served by cpu_np")
    ck.ok(w.state == "demoted" and 0.2 < w.next_try - time.perf_counter() <= 0.5, "3 soft misses in a row demote to cpu_np, re-probe later (%s)" % w.state)
    ck.ok(gone(p) == 0, "the demoted worker was released through its pipe and left by itself")
    time.sleep(0.55)
    w.poll()
    ck.ok(settle(w) and w.status()["restarts"] == 1, "re-probed after the delay (restarts 1)")
    w.stop()

    w = wb("hang", soft_s=0.005, hard_s=0.25)
    w.start()
    settle(w)
    p = w.proc
    ck.ok(w.infer(1, 1, PIDS, x) is None and w.outstanding is not None, "a hung worker: the second is served by cpu_np")
    time.sleep(0.3)
    w.poll()
    ck.ok(w.state == "backoff" and any("hard deadline" in e for e in w.events), "hard deadline 250 ms: demoted at once, respawn scheduled")
    ck.ok(gone(p) == 0, "the hung worker got EXIT and stdin EOF and left by itself (never killed)")

    w = wb("crash", soft_s=0.05)
    w.start()
    settle(w)
    p = w.proc
    ck.ok(w.infer(1, 1, PIDS, x) is None and w.state == "backoff", "a worker dying mid-request demotes at once")
    ck.ok(gone(p) == 3, "it exited on its own (code 3)")
    d1 = w.next_try - time.perf_counter()
    time.sleep(max(0.0, d1) + 0.05)
    w.poll()
    ck.ok(settle(w), "respawned after the backoff")
    w.infer(2, 1, PIDS, x)
    d2 = w.next_try - time.perf_counter()
    ck.ok(0.15 < d1 <= 0.2 and 0.3 < d2 <= 0.4, "exponential backoff 0.2 s then 0.4 s (base 0.2; 1 s .. 60 s in production)")
    w.stop()

    for mode, what in (("garbage", "protocol error"), ("error", "ERROR DEVICE_LOST")):
        w = wb(mode, soft_s=0.05)
        w.start()
        settle(w)
        p = w.proc
        ck.ok(w.infer(1, 1, PIDS, x) is None and w.state == "backoff", "%s -> demote and respawn with backoff" % what)
        ck.ok(gone(p) == 0, "%s worker released and left by itself" % mode)

    w = wb("no_welcome", hello_timeout=0.8)
    t0 = time.perf_counter()
    ok = w.start()
    dt = time.perf_counter() - t0
    ck.ok(ok and w.state == "starting" and dt < 0.5, "start() only spawns and sends HELLO: it returns at once (%.0f ms), state 'starting'" % (dt * 1000))
    ck.ok(w.infer(1, 1, PIDS, x) is None, "while the worker is starting, infer() returns None at once (cpu_np serves)")
    worst = 0.0
    end = time.perf_counter() + 3
    while w.state == "starting" and time.perf_counter() < end:
        t1 = time.perf_counter()
        w.poll()
        worst = max(worst, time.perf_counter() - t1)
        time.sleep(0.01)
    ck.ok(w.state == "backoff" and any("no WELCOME" in e for e in w.events) and worst < 0.05,
          "no WELCOME within the timeout -> backoff, noticed by poll(); no poll() took 50 ms or more (worst %.1f ms)" % (worst * 1000))
    ck.ok(C.wait_for(lambda: (w._reap() or True) and not w.exiting, 5), "the silent worker left by itself after EXIT and stdin EOF")
    ck.ok(w.abandoned == 0, "every fake worker left on its own (none abandoned, none killed)")

    w = wb([sys.executable, FAKE, "ok", "--manifest", MANIFEST], manifest_sha="0" * 64)
    w.start()
    ck.ok(not settle(w) and any("different manifest" in e for e in w.events), "a worker that loaded another manifest is refused")


def test_stuck(ck):
    """A worker hung in native code ignores EXIT and the end of stdin. It is never killed, and no second worker is
    started while it runs, so stuck children can never pile up."""
    w = wb([sys.executable, FAKE, "stuck", "--stuck-s", "3"], hello_timeout=0.3, backoff_base=0.2, exit_grace_s=1.0)
    w.start()
    p1 = w.proc
    settle(w, 2)
    ck.ok(w.state == "backoff" and p1.poll() is None, "a worker that ignores EXIT and stdin EOF is still running after it was released")
    time.sleep(0.3)
    w.poll()
    ck.ok(w.state == "blocked" and w.starts == 1 and any("still running" in e for e in w.events),
          "no second worker is spawned while the first still runs (state blocked, cpu_np serves; %s)" % w.state)
    for _ in range(3):
        time.sleep(0.45)
        w.poll()
    ck.ok(w.abandoned == 1 and w.starts == 1 and w.status()["exiting"] == 1, "past the exit grace it counts as abandoned; still exactly one child")
    ck.ok(gone(p1, 6) is not None, "the stuck worker finished on its own (never killed)")
    time.sleep(0.3)
    w.poll()
    ck.ok(w.starts == 2 and w.state == "starting" and w.abandoned == 0, "once it has left, the TPU is probed again (%s, starts %d)" % (w.state, w.starts))
    p2 = w.proc
    w.stop(wait_s=0.0)
    ck.ok(gone(p2, 6) is not None, "the second stuck worker also left by itself")


def test_supervisor_tpu(ck):
    bridge = C.tmpdir("tpu_ok")
    proc = C.start_sidecar(bridge, "--tpu", "--worker-cmd", "%s|%s|ok" % (sys.executable, FAKE), "--worker-soft-ms", "80")
    st = C.wait_status(bridge, 15, lambda s: s["worker"]["state"] == "ready")
    ck.ok(st is not None and st["backend"] == "edgetpu", "supervisor with --tpu uses the worker when it is healthy")
    kube = C.FakeKube(bridge)
    from test_sidecar import entries
    got = []
    for k in range(4):
        kube.tick += 20
        kube.write(entries(k, kube.tick))
        C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
        got.append(C.read_json(kube.ver))
    ck.ok(all(v and v.get("backend") == "edgetpu" for v in got), "verdicts served by the worker (%s)" % [v.get("backend") for v in got if v])
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stop.flag stops the supervisor and its worker")
    C.output(proc)

    bridge = C.tmpdir("tpu_crash")
    proc = C.start_sidecar(bridge, "--tpu", "--worker-cmd", "%s|%s|crash" % (sys.executable, FAKE), "--worker-backoff", "0.3")
    C.wait_status(bridge, 15)
    kube = C.FakeKube(bridge)
    got = []
    for k in range(6):
        kube.tick += 20
        kube.write(entries(k, kube.tick))
        C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
        got.append(C.read_json(kube.ver))
        time.sleep(0.2)
    ck.ok(all(v and v.get("seq") == i + 1 for i, v in enumerate(got)), "every second still gets a verdict while the worker keeps crashing (I6)")
    ck.ok(all(v.get("backend") == "cpu_np" for v in got), "served by cpu_np")
    st = C.wait_status(bridge, 3, lambda s: any(e.startswith("WORKER:") for e in s["errors"]))
    ck.ok(st is not None and st["worker"]["state"] in ("backoff", "ready") and st["worker"]["restarts"] >= 1,
          "status shows the worker state and its restarts (%s)" % ((st or {}).get("worker") or {}).get("detail"))
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stopped")
    C.output(proc)


def test_supervisor_hang(ck):
    """The supervisor with a worker that never answers HELLO (production 20 s handshake timeout): nothing blocks."""
    from test_sidecar import entries
    bridge = C.tmpdir("tpu_hang")
    t0 = time.time()
    proc = C.start_sidecar(bridge, "--tpu", "--worker-cmd", "%s|%s|no_welcome" % (sys.executable, FAKE))
    st = C.wait_status(bridge, 10, lambda s: s.get("state") == "running")
    ck.ok(st is not None and time.time() - t0 < 6 and st["worker"]["state"] == "starting" and st["backend"] == "cpu_np",
          "with a worker that never answers HELLO the supervisor is up at once on cpu_np (worker %s)" % ((st or {}).get("worker") or {}).get("state"))
    kube = C.FakeKube(bridge)
    beats = []

    def watch(k):
        s = C.read_json(os.path.join(bridge, "status.json"))
        if isinstance(s, dict) and (not beats or s["ts_ms"] != beats[-1]):
            beats.append(s["ts_ms"])
    kube.run(5.0, lambda sec: entries(sec, kube.tick), each_tick=watch)
    gaps = [(b - a) / 1000.0 for a, b in zip(beats, beats[1:])]
    ck.ok(len(kube.accepted) >= 4 and all(v.get("backend") == "cpu_np" for _s, _w, _r, v in kube.accepted),
          "every second gets a cpu_np verdict while the worker hangs in its handshake (%d)" % len(kube.accepted))
    ck.ok(len(gaps) >= 3 and max(gaps) < 2.0, "heartbeats keep coming every second (max gap %.1f s)" % max(gaps or [0.0]))
    t1 = time.time()
    ck.ok(C.stop_sidecar(bridge, proc) == 0 and time.time() - t1 < 4, "stop.flag stops it promptly; the silent worker is released through its pipe")
    C.output(proc)


def main():
    ck = C.Check("oracle-worker")
    for fn in (test_protocol, test_tflite_checks, test_real_worker, test_watchdog, test_stuck, test_supervisor_hang, test_supervisor_tpu):
        print("-- %s" % fn.__name__)
        try:
            fn(ck)
        except Exception as e:
            import traceback
            traceback.print_exc()
            ck.ok(False, "%s raised %r" % (fn.__name__, e))
    return ck.done()


if __name__ == "__main__":
    sys.exit(main())
