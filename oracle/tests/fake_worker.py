"""A fake TPU worker for the watchdog tests. Speaks the v2 pipe protocol with a chosen misbehaviour:

    python fake_worker.py MODE [--manifest PATH]
  ok          answers like a real worker (cpu_np weights on the dequantised input), backend code 2 (edgetpu)
  slow        answers correctly but 30 ms late (soft deadline misses)
  hang        never answers INFER_WINDOW (hard deadline); still leaves on EXIT or end of stdin
  crash       leaves in the middle of the first INFER_WINDOW (os._exit inside its own code path)
  garbage     answers INFER_WINDOW with a frame whose magic is wrong
  error       answers INFER_WINDOW with ERROR DEVICE_LOST
  no_welcome  never answers HELLO
  stuck       never reads its pipe at all (ignores HELLO, EXIT and the end of stdin, like a delegate hung in native
              code) and leaves by itself after --stuck-s seconds (default 3)
Every other mode exits when stdin closes, so the supervisor never has to kill anything.
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ORACLE = os.path.dirname(HERE)
sys.path.insert(0, ORACLE)

import numpy as np  # noqa: E402

from backends import dequantize, softmax_heads  # noqa: E402
from backends import pipe_v2 as P  # noqa: E402
from backends.cpu_np import CpuNpBackend  # noqa: E402
from backends.manifest import load, sha256_file  # noqa: E402

S_IN, ZP_IN = 0.05, 0


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "ok"
    if mode == "stuck":
        time.sleep(float(sys.argv[sys.argv.index("--stuck-s") + 1]) if "--stuck-s" in sys.argv else 3.0)
        return 0
    mpath = os.path.join(ORACLE, "models", "oracle_manifest.json")
    if "--manifest" in sys.argv:
        mpath = sys.argv[sys.argv.index("--manifest") + 1]
    if os.name == "nt":
        import msvcrt
        msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
        msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    m = load(mpath)
    net = CpuNpBackend(m)

    def send(b):
        out.write(b)
        out.flush()

    while True:
        payload = P.read_frame(inp)
        if payload is None:
            return 0
        mtype, seq, tick, n, body = P.parse(payload)
        if mtype == P.EXIT:
            return 0
        if mtype == P.HELLO:
            if mode == "no_welcome":
                continue
            send(P.json_frame(P.WELCOME, {"v": 2, "backend": "edgetpu", "model": m["model"], "manifest_sha256": sha256_file(mpath),
                                           "feature_names": m["feature_names"], "window": 16, "mu": m["mu"], "sd": m["sd"],
                                           "s_in": S_IN, "zp_in": ZP_IN, "deadline_ms": 5, "usb": {"vidpid": "18D1:9302", "speed": "fake"}}))
        elif mtype == P.PING:
            send(P.json_frame(P.PONG, {}, seq, tick))
        elif mtype == P.INFER_WINDOW:
            if mode == "hang":
                continue
            if mode == "crash":
                os._exit(3)
            if mode == "garbage":
                send(P.LEN.pack(24) + b"XXXX" + b"\x02\x05" + b"\x00" * 18)
                continue
            if mode == "error":
                send(P.json_frame(P.ERROR, {"seq": seq, "code": "DEVICE_LOST"}, seq, tick))
                continue
            pids, q = P.parse_infer_window(n, body)
            t0 = time.perf_counter()
            probs = softmax_heads(net.infer(dequantize(q, S_IN, ZP_IN).astype(np.float32)))
            if mode == "slow":
                time.sleep(0.03)
            send(P.result_frame(seq, tick, 2, int((time.perf_counter() - t0) * 1e6), pids, probs))


if __name__ == "__main__":
    sys.exit(main())
