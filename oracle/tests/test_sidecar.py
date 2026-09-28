"""oracle-sidecar suite: cpu_np inference parity, 20/20 verdicts from a fake KubeJS writer (JsonIO semantics:
truncate and rewrite in place), staleness after a stop.flag or --exit-after shutdown, torn/missing/locked read
tolerance (including slow truncating writes, the real torn mode), seq/boot_id handling, window resets, manifest
validation (a bad model is refused, the previous one stays), reload.flag, idle exit, the repo guard, a stop.flag left
from an earlier stop (ignored at start), and file errors (an unwritable status.json, an OSError inside a loop pass,
a vanished bridge folder, a failing shutdown step) that never end the sidecar with a traceback.

    python oracle/tests/test_sidecar.py        (prints PASS/FAIL on the last line; files under %TEMP%)
"""
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

import numpy as np  # noqa: E402

from backends import softmax_heads  # noqa: E402
from backends.cpu_np import CpuNpBackend  # noqa: E402
from backends.manifest import BadModel, load as load_manifest  # noqa: E402

FIX = np.load(os.path.join(HERE, "fixtures", "parity.npz"))
X, EXPECTED = FIX["X"], FIX["expected"]
PIDS = [C.pid_hex(i) for i in range(X.shape[0])]


def entries(sec, tick, extra_ev=None, dim="minecraft:overworld", pids=None, log=False):
    out = []
    for i, pid in enumerate(pids or PIDS):
        ev = {"died": False, "respawned": False, "enc_start": False, "enc_end": False, "tele": False}
        if extra_ev:
            ev.update(extra_ev)
        out.append({"pid": pid, "f": [float(v) for v in X[i % X.shape[0], sec % X.shape[1]]], "dim": dim, "comfort": True,
                    "log": log, "ev": ev, "t": tick})
    return out


def probs_of(v, pid):
    for p in v["players"]:
        if p["pid"] == pid:
            return np.array(p["arousal"] + p["style"] + p["fe"], np.float64), p
    return None, None


def retry(fn, timeout=2.0):
    """Runs a test-side delete or rename, retrying while Windows reports the file busy (the sidecar may be reading
    it at that instant). The game itself never deletes or renames telemetry.json (JsonIO truncates in place)."""
    end = time.time() + timeout
    while True:
        try:
            return fn()
        except PermissionError:
            if time.time() >= end:
                raise
            time.sleep(0.005)


def test_parity(ck):
    m = load_manifest(os.path.join(C.MODELS, "oracle_manifest.json"))
    net = CpuNpBackend(m)
    mu, sd = np.asarray(m["mu"], np.float32), np.asarray(m["sd"], np.float32)
    N, T, F = X.shape
    worst = 0.0
    wins = []
    for t in range(T):
        w = np.zeros((N, 16, F), np.float32)
        k = min(16, t + 1)
        w[:, 16 - k:] = (X[:, t + 1 - k:t + 1] - mu) / sd
        wins.append(w.reshape(N, -1))
        P = softmax_heads(net.infer(w.reshape(N, -1)))
        worst = max(worst, float(np.abs(P - EXPECTED[:, t]).max()))
    ck.ok(worst < 1e-5, "cpu_np equals the prototype MLP on %d recorded windows (max diff %.2e)" % (N * T, worst))
    xs = np.concatenate(wins)[:1]
    for _ in range(200):
        net.infer(xs)
    ts = []
    for _ in range(2000):
        t0 = time.perf_counter()
        softmax_heads(net.infer(xs))
        ts.append((time.perf_counter() - t0) * 1e6)
    ts.sort()
    ck.ok(ts[int(len(ts) * 0.99)] < 1000, "cpu_np p99 under 1 ms per window (p50 %.1f us, p99 %.1f us)" % (ts[len(ts) // 2], ts[int(len(ts) * 0.99)]))
    ck.note("cpu_np forward+softmax p50 %.1f us, p99 %.1f us" % (ts[len(ts) // 2], ts[int(len(ts) * 0.99)]))


def test_twenty(ck):
    bridge = C.tmpdir("twenty")
    proc = C.start_sidecar(bridge, "--poll-ms", "25")
    st = C.wait_status(bridge, 15)
    ck.ok(st is not None and st.get("backend") == "cpu_np" and st.get("state") == "running", "sidecar up with cpu_np")
    kube = C.FakeKube(bridge)
    kube.run(20.6, lambda sec: entries(sec, kube.tick))
    got = kube.accepted
    ck.ok(len(kube.written) == 20, "fake KubeJS wrote 20 telemetry files (%d)" % len(kube.written))
    ck.ok(len(got) == 20, "20/20 verdicts accepted (%d)" % len(got))
    ck.ok(all(r[2] - r[1] == 10 for r in got), "every verdict read at the slot-10 read of its own second (500 ms, within 1 s)")
    worst = 0.0
    fills = []
    for seq, _wt, _rt, v in got:
        for i, pid in enumerate(PIDS):
            p, e = probs_of(v, pid)
            if p is None:
                worst = 9.0
                continue
            worst = max(worst, float(np.abs(p - EXPECTED[i, seq - 1]).max()))
            if i == 0:
                fills.append(e["window_fill"])
    ck.ok(worst < 2e-4, "bridge verdicts equal the recorded golden (window, padding, normalisation, softmax; max diff %.2e)" % worst)
    ck.ok(fills[:3] == [1, 2, 3] and fills[-1] == 16, "window_fill grows to 16 (%s)" % fills[:4])
    v = got[-1][3]
    ck.ok(v.get("backend") == "cpu_np" and v.get("model", "").startswith("oracle-mlp-496-64-32-11@") and isinstance(v.get("infer_us"), int),
          "verdict carries backend, model id and infer_us")
    ck.ok(all(abs(sum(p["arousal"]) - 1) < 1e-3 and abs(p["conf"] - max(p["arousal"])) < 1e-3 for p in v["players"]), "arousal sums to 1, conf = max(arousal)")
    ck.ok(all(abs(sum(p["style"]) - 1) < 1e-3 and abs(sum(p["fe"]) - 1) < 1e-3 for p in v["players"]), "per-head softmax: style and fe sum to 1")
    ck.ok(all(abs(p["eo"] - (p["arousal"][1] + 2 * p["arousal"][2] + 3 * p["arousal"][3]) / 3) < 1e-3 and 0 <= p["eo"] <= 1 for p in v["players"]),
          "eo = (p1 + 2 p2 + 3 p3) / 3 in [0, 1]")
    ck.ok(kube.fresh(), "the KubeJS side sees a fresh verdict while the sidecar runs")
    st = C.read_json(os.path.join(bridge, "status.json"))
    ck.ok(st["reads"]["ok"] >= 20 and st["nonce"] == C.read_json(os.path.join(bridge, "sidecar.lock"))["nonce"], "status.json heartbeat carries the lock nonce")
    ck.ok(st.get("infer_p50_us") is not None and st["worker"]["state"] == "off", "status shows inference latency and no worker")

    # staleness after a cooperative stop.flag shutdown
    t0 = time.time()
    code = C.stop_sidecar(bridge, proc)
    out = C.output(proc)
    ck.ok(code == 0 and time.time() - t0 < 3, "stop.flag stops the sidecar within 3 s with exit code 0 (%s)" % code)
    ck.ok(not os.path.exists(os.path.join(bridge, "stop.flag")) and not os.path.exists(os.path.join(bridge, "sidecar.lock")),
          "stop.flag and sidecar.lock are deleted on the way out")
    st = C.read_json(os.path.join(bridge, "status.json"))
    ck.ok(st.get("state") == "stopped" and st.get("stop_reason") == "stop.flag", "final status says stopped (stop.flag)")
    n = len(kube.accepted)
    stale_at = []
    kube.run(4.0, lambda sec: entries(sec + 21, kube.tick), each_tick=lambda k: stale_at.append(k.tick) if not k.fresh() and not stale_at else None)
    ck.ok(len(kube.accepted) == n, "no verdict after the stop")
    ck.ok(not kube.fresh() and stale_at and stale_at[0] - kube.vtick == 61, "the verdict goes stale 61 ticks after its tick (fallback to heuristics)")
    ck.ok("stopped (stop.flag)" in out, "the console says why it stopped")


def test_exit_after(ck):
    bridge = C.tmpdir("exitafter")
    proc = C.start_sidecar(bridge, "--exit-after", "2")
    C.wait_status(bridge, 15)
    kube = C.FakeKube(bridge)
    exited = []
    # 6.5 s: long enough past the 2 s exit that even the latest possible answer (seq 3) is over 60 ticks old at the end
    kube.run(6.5, lambda sec: entries(sec, kube.tick), each_tick=lambda k: exited.append(k.tick) if proc.poll() is not None and not exited else None)
    ck.ok(proc.poll() == 0, "--exit-after ends the sidecar by itself with code 0 (%s)" % proc.poll())
    st = C.read_json(os.path.join(bridge, "status.json"))
    ck.ok(st and st.get("stop_reason", "").startswith("exit-after"), "final status names --exit-after")
    ck.ok(not os.path.exists(os.path.join(bridge, "sidecar.lock")), "lock released")
    ck.ok(len(kube.accepted) >= 1 and not kube.fresh(), "verdicts were served, then went stale after the exit (%d)" % len(kube.accepted))
    C.output(proc)


def test_tolerance(ck):
    bridge = C.tmpdir("tolerant")
    proc = C.start_sidecar(bridge)
    C.wait_status(bridge, 15)
    kube = C.FakeKube(bridge)
    tel, ver = kube.tel, kube.ver

    def verdict_seq():
        v = C.read_json(ver)
        return int(v["seq"]) if isinstance(v, dict) else None

    good = {"v": 2, "boot_id": kube.boot, "seq": 1, "tick": 1000, "ts_ms": 0, "want_oracle": True, "players": entries(0, 1000)}
    text = json.dumps(C._gsonify(good), indent="\t")
    with open(tel, "w") as f:
        f.write(text[:len(text) // 2])          # torn: half a file
    time.sleep(0.15)
    retry(lambda: os.remove(tel))                # missing: the delete window
    time.sleep(0.15)
    C.jsonio_write(tel, good)
    ck.ok(C.wait_for(lambda: verdict_seq() == 1, 3), "answers seq 1 after a torn and a missing file")
    locked_tested = False
    if os.name == "nt":
        import msvcrt
        good["seq"], good["tick"] = 2, 1020
        data = json.dumps(C._gsonify(good), indent="\t").encode()
        fd = os.open(tel + ".new", os.O_RDWR | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0))
        os.write(fd, data)
        os.close(fd)
        retry(lambda: os.replace(tel + ".new", tel))
        fd = os.open(tel, os.O_RDWR | getattr(os, "O_BINARY", 0))
        msvcrt.locking(fd, msvcrt.LK_NBLCK, len(data))   # the reader now gets PermissionError
        time.sleep(0.2)
        msvcrt.locking(fd, msvcrt.LK_UNLCK, len(data))
        os.close(fd)
        os.utime(tel, None)
        locked_tested = True
        ck.ok(C.wait_for(lambda: verdict_seq() == 2, 3), "answers seq 2 after the file was locked for 200 ms")
    retry(lambda: open(tel, "w").close())
    with open(tel, "w") as f:
        f.write("not json at all")
    time.sleep(0.15)
    good["seq"], good["tick"] = 3, 1040
    C.jsonio_write(tel, good)
    ck.ok(C.wait_for(lambda: verdict_seq() == 3, 3), "answers seq 3 after garbage")
    good["seq"] = 2
    C.jsonio_write(tel, good)
    time.sleep(0.3)
    ck.ok(verdict_seq() == 3, "a seq that is not newer is ignored")
    old = dict(good)
    old["v"], old["seq"] = 1, 9
    C.jsonio_write(tel, old)
    time.sleep(0.3)
    ck.ok(verdict_seq() == 3, "a v1 file is ignored")
    off = dict(good)
    off["seq"], off["want_oracle"] = 10, False
    C.jsonio_write(tel, off)
    time.sleep(0.3)
    ck.ok(verdict_seq() == 3, "want_oracle false: no verdict")
    nb = dict(good)
    nb["boot_id"], nb["seq"], nb["tick"] = "42", 1, 20
    C.jsonio_write(tel, nb)
    ck.ok(C.wait_for(lambda: verdict_seq() == 1 and C.read_json(ver).get("boot_id") == "42", 3), "a new boot_id restarts seq counting")
    v = C.read_json(ver)
    ck.ok(all(p["window_fill"] == 1 for p in v["players"]), "a new boot resets the windows")
    st = C.wait_status(bridge, 4, lambda s: s["reads"]["torn"] >= 2 and s["reads"]["stale"] >= 2 and s["last_seq"] == 1 and
                       any(e.startswith("BAD_VERSION") for e in s["errors"]))
    ck.ok(st is not None and st["reads"]["torn"] >= 2 and st["reads"]["missing"] >= 1 and st["reads"]["stale"] >= 2,
          "status counts torn, missing and stale reads (%s)" % (st or {}).get("reads"))
    if locked_tested:
        ck.ok(st["reads"]["locked"] >= 1, "status counts locked reads")
    ck.ok(st is not None and any(e.startswith("BAD_VERSION") for e in st["errors"]), "BAD_VERSION reported")
    ck.ok(proc.poll() is None, "still running after all of it")
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stopped cooperatively")
    C.output(proc)


def test_shared_read(ck):
    """The game's JsonIO.write truncates telemetry.json in place (CREATE, TRUNCATE_EXISTING, WRITE). The sidecar's
    read handle never gets in its way; its extra delete share is defensive (a delete-then-write also works)."""
    import sidecar
    d = C.tmpdir("shared")
    p = os.path.join(d, "telemetry.json")
    C.jsonio_write(p, {"v": 2, "seq": 1})
    f = sidecar.open_shared(p)
    try:
        ok_trunc = C.jsonio_write(p, {"v": 2, "seq": 2})    # truncate + rewrite while the sidecar holds its handle
        ok_del = C.delete_then_write(p, {"v": 2, "seq": 3})  # not what the game does; tolerated anyway
    finally:
        f.close()
    ck.ok(ok_trunc, "a JsonIO-style truncate-and-rewrite succeeds while the sidecar holds telemetry.json open")
    ck.ok(ok_del and C.read_json(p) == {"v": 2.0, "seq": 3.0}, "a delete-then-write succeeds too (defensive share flags); the new file is intact")
    g = open(p, "rb")
    try:
        ok_plain = C.jsonio_write(p, {"v": 2, "seq": 4})
    finally:
        g.close()
    ck.ok(ok_plain and C.read_json(p) == {"v": 2.0, "seq": 4.0}, "a truncating write works even against a plain open() reader: the game only needs write sharing")
    obj, state = sidecar.read_json_tolerant(os.path.join(d, "missing.json"))
    ck.ok(obj is None and state == "missing", "a missing file reads as missing")
    with open(p, "w") as g:
        g.write("{\"v\": 2, \"se")
    ck.ok(sidecar.read_json_tolerant(p) == (None, "torn"), "half a file reads as torn")
    if os.name == "nt":
        import msvcrt
        fd = os.open(p, os.O_RDWR | getattr(os, "O_BINARY", 0))
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 4)
            ck.ok(sidecar.read_json_tolerant(p) == (None, "locked"), "a byte-range lock reads as locked")
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 4)
        finally:
            os.close(fd)


def test_torn_writes(ck):
    """The real torn mode: KubeJS truncates telemetry.json and rewrites it; a poll can land in between. Here every
    write stops for 60 ms halfway through (longer than the 25 ms poll), and every second still gets its verdict."""
    bridge = C.tmpdir("torn")
    proc = C.start_sidecar(bridge)
    C.wait_status(bridge, 15)
    kube = C.FakeKube(bridge)
    kube.pause_s = 0.06
    kube.run(8.6, lambda sec: entries(sec, kube.tick))
    ck.ok(len(kube.written) == 8 and len(kube.accepted) == 8, "slow truncating writes: 8/8 verdicts (%d written, %d accepted)" % (len(kube.written), len(kube.accepted)))
    st = C.wait_status(bridge, 3, lambda s: s["reads"]["torn"] >= 1)
    ck.ok(st is not None, "the partial files were seen and counted as torn reads (%s)" % (C.read_json(os.path.join(bridge, "status.json")) or {}).get("reads"))
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stopped")
    C.output(proc)


def test_stale_flag(ck):
    """stop_oracle.cmd creates stop.flag even when no sidecar runs (for example after the idle exit). Such a flag,
    older than the process, must not cancel the next start; a flag created after the start still stops it."""
    bridge = C.tmpdir("staleflag")
    flag = os.path.join(bridge, "stop.flag")
    open(flag, "w").close()
    time.sleep(0.05)
    proc = C.start_sidecar(bridge)
    st = C.wait_status(bridge, 15)
    ck.ok(st is not None and st.get("state") == "running" and proc.poll() is None, "a stop.flag left from an earlier stop does not stop a new start")
    ck.ok(not os.path.exists(flag), "the stale flag was removed at start")
    kube = C.FakeKube(bridge)
    kube.tick += 20
    kube.write(entries(0, kube.tick))
    ck.ok(C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3), "verdicts flow")
    t0 = time.time()
    ck.ok(C.stop_sidecar(bridge, proc) == 0 and time.time() - t0 < 3, "a stop.flag created after the start still stops it")
    ck.ok("removed a stop.flag left from an earlier stop request" in C.output(proc), "the console says it removed the old flag")


def test_resilience(ck):
    import sidecar
    import sidecar_lock
    d = C.tmpdir("resil")
    ck.ok(sidecar.atomic_write_json(os.path.join(d, "missing", "x.json"), {"a": 1}) is False,
          "atomic_write_json into a missing folder returns False (no exception)")
    ck.ok(not os.listdir(d), "and leaves no tmp file behind")

    # process: status.json is a folder, so every heartbeat write fails; the sidecar keeps answering and stops cleanly
    bridge = C.tmpdir("resil_proc")
    os.makedirs(os.path.join(bridge, "status.json"))
    proc = C.start_sidecar(bridge)
    C.wait_for(lambda: os.path.exists(os.path.join(bridge, "sidecar.lock")), 15)
    kube = C.FakeKube(bridge)
    got = 0
    for k in range(3):
        kube.tick += 20
        kube.write(entries(k, kube.tick))
        if C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 5):
            got += 1
    ck.ok(got == 3 and proc.poll() is None, "with status.json unwritable the sidecar keeps running and answering (%d/3)" % got)
    code = C.stop_sidecar(bridge, proc)
    out = C.output(proc)
    ck.ok(code == 0 and "Traceback" not in out, "it still stops through stop.flag with exit code 0 and no traceback (%s)" % code)
    ck.ok(not os.path.exists(os.path.join(bridge, "sidecar.lock")) and not os.path.exists(os.path.join(bridge, "stop.flag")),
          "lock and flag are cleaned up although every status write failed")

    # in process: an OSError inside a loop pass is recorded, not raised
    b2 = C.tmpdir("resil_inproc")
    s = C.supervisor(b2, "--bridge-gone-s", "0.2")
    ck.ok(s.start() is None and s.lock.held, "in-process supervisor started and holds the lock")

    def boom():
        raise OSError(28, "No space left on device")
    s.poll_telemetry = boom
    ok = s.step()
    ck.ok(ok and s.io_errors == 1 and any(e.startswith("IO:") for e in s.errors), "an OSError inside a loop pass is recorded in status.errors and the loop goes on")
    del s.poll_telemetry
    ck.ok(s.step(), "the next pass runs normally")

    # the bridge folder missing (not reachable on Windows while the guard is open, so the path is swapped here)
    real = s.bridge
    s.bridge = os.path.join(b2, "gone")
    ok1 = s.step()
    time.sleep(0.25)
    ok2 = s.step()
    ck.ok(ok1 and not ok2 and str(s.stop_reason).startswith("bridge folder missing"),
          "a missing bridge folder stops the sidecar cooperatively after --bridge-gone-s (%s)" % s.stop_reason)
    s.bridge = real

    # every shutdown step runs even when one fails
    def bad_heartbeat(force=False, state="running"):
        raise OSError(2, "status.json folder vanished")
    s.heartbeat = bad_heartbeat
    s.shutdown()
    g = sidecar_lock.Guard(os.path.join(b2, sidecar_lock.GUARD_NAME))
    ck.ok(not os.path.exists(os.path.join(b2, "sidecar.lock")) and s.lock.guard.fd is None and g.acquire(),
          "a failing final status write does not skip the lock release (lock file deleted, guard free)")
    g.release()


def test_windows(ck):
    bridge = C.tmpdir("windows")
    proc = C.start_sidecar(bridge)
    C.wait_status(bridge, 15)
    kube = C.FakeKube(bridge)
    fills = []

    def step(sec, ev=None, dim="minecraft:overworld", t=None):
        kube.tick += 20
        ps = entries(sec, kube.tick if t is None else t, extra_ev=ev, dim=dim, pids=PIDS[:1])
        kube.write(ps)
        C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
        v = C.read_json(kube.ver)
        fills.append(v["players"][0]["window_fill"] if v and v.get("seq") == kube.seq else None)

    for s in range(18):
        step(s)
    ck.ok(fills[:3] == [1, 2, 3] and fills[15:18] == [16, 16, 16], "fill 1..16 then capped (%s)" % fills[14:18])
    step(18, t=kube.tick)
    same_t = kube.tick
    step(19, t=same_t)
    ck.ok(fills[-1] == 16, "a repeated sample tick is not appended twice")
    step(20, ev={"respawned": True})
    ck.ok(fills[-1] == 1, "respawn resets the window")
    step(21)
    step(22, ev={"tele": True})
    ck.ok(fills[-2] == 2 and fills[-1] == 1, "a teleport over 60 blocks resets the window")
    step(23)
    step(24, dim="minecraft:the_nether")
    ck.ok(fills[-1] == 1, "a dimension change resets the window")
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stopped")
    C.output(proc)


def _copy_models(tag):
    d = C.tmpdir(tag)
    for fn in ("oracle_manifest.json", "oracle_mlp.npz"):
        shutil.copy(os.path.join(C.MODELS, fn), os.path.join(d, fn))
    return d


def _rewrite_manifest(d, fn):
    p = os.path.join(d, "oracle_manifest.json")
    m = json.load(open(p))
    fn(m)
    json.dump(m, open(p, "w"))


def _sha(p):
    import hashlib
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


def test_manifest(ck):
    good = _copy_models("m_good")
    ck.ok(CpuNpBackend(load_manifest(os.path.join(good, "oracle_manifest.json"))) is not None, "the shipped manifest and model load")

    def refused(d, what):
        try:
            CpuNpBackend(load_manifest(os.path.join(d, "oracle_manifest.json")))
        except BadModel as e:
            return ck.ok(True, "refused: %s (%s)" % (what, e))
        return ck.ok(False, "not refused: %s" % what)

    d = _copy_models("m_sha")
    with open(os.path.join(d, "oracle_mlp.npz"), "ab") as f:
        f.write(b"x")
    refused(d, "model file sha256 mismatch")
    d = _copy_models("m_mu")
    _rewrite_manifest(d, lambda m: m.__setitem__("mu", m["mu"][:30]))
    refused(d, "mu with 30 values")
    d = _copy_models("m_layers")
    _rewrite_manifest(d, lambda m: m["backends"]["cpu_np"].__setitem__("layers", [[496, 32], [32, 11]]))
    refused(d, "wrong layer list")
    d = _copy_models("m_nan")
    z = dict(np.load(os.path.join(d, "oracle_mlp.npz")))
    z["arr_1"] = z["arr_1"].copy()
    z["arr_1"][3, 4] = np.nan
    np.savez(os.path.join(d, "oracle_mlp.npz"), **z)
    _rewrite_manifest(d, lambda m: m["backends"]["cpu_np"].__setitem__("sha256", _sha(os.path.join(d, "oracle_mlp.npz"))))
    refused(d, "NaN weight (sha256 updated to match)")
    d = _copy_models("m_shape")
    z = dict(np.load(os.path.join(d, "oracle_mlp.npz")))
    z["arr_0"] = z["arr_0"][:495]
    np.savez(os.path.join(d, "oracle_mlp.npz"), **z)
    _rewrite_manifest(d, lambda m: m["backends"]["cpu_np"].__setitem__("sha256", _sha(os.path.join(d, "oracle_mlp.npz"))))
    refused(d, "W0 of 495 x 64 (sha256 updated to match)")
    d = _copy_models("m_musd")
    _rewrite_manifest(d, lambda m: m.__setitem__("sd", [v * 1.01 for v in m["sd"]]))
    refused(d, "manifest sd differs from the model's")
    d = _copy_models("m_heads")
    _rewrite_manifest(d, lambda m: m["heads"].__setitem__("style", ["kite", "hide", "turtle", "explore"]))
    refused(d, "style head order changed")
    d = C.tmpdir("m_none")
    refused(d, "no manifest at all")

    # process level: a bad model at start -> BAD_MODEL, no backend, no verdict
    bad = _copy_models("m_proc")
    with open(os.path.join(bad, "oracle_mlp.npz"), "ab") as f:
        f.write(b"x")
    bridge = C.tmpdir("badmodel")
    proc = C.start_sidecar(bridge, models=bad)
    st = C.wait_status(bridge, 15)
    ck.ok(st and st["backend"] is None and any(e.startswith("BAD_MODEL") for e in st["errors"]), "a sidecar started with a bad model reports BAD_MODEL and no backend")
    kube = C.FakeKube(bridge)
    kube.tick += 20
    kube.write(entries(0, kube.tick))
    time.sleep(0.5)
    ck.ok(not os.path.exists(kube.ver), "no verdict without a valid model (the game falls back to heuristics)")
    # fix it through reload.flag
    shutil.copy(os.path.join(C.MODELS, "oracle_mlp.npz"), os.path.join(bad, "oracle_mlp.npz"))
    open(os.path.join(bridge, "reload.flag"), "w").close()
    ck.ok(C.wait_status(bridge, 5, lambda s: s["backend"] == "cpu_np") is not None, "reload.flag loads the repaired model")
    ck.ok(not os.path.exists(os.path.join(bridge, "reload.flag")), "reload.flag consumed")
    kube.tick += 20
    kube.write(entries(1, kube.tick))
    ck.ok(C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3), "verdicts flow after the reload")
    # a bad reload keeps the previous model
    _rewrite_manifest(bad, lambda m: m.__setitem__("mu", m["mu"][:30]))
    open(os.path.join(bridge, "reload.flag"), "w").close()
    time.sleep(0.4)
    kube.tick += 20
    kube.write(entries(2, kube.tick))
    ck.ok(C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3), "a bad reload keeps serving from the previous model")
    st = C.wait_status(bridge, 3, lambda s: sum(1 for e in s["errors"] if e.startswith("BAD_MODEL")) >= 1 and s["backend"] == "cpu_np")
    ck.ok(st is not None, "BAD_MODEL reported while the previous backend stays")
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stopped")
    C.output(proc)


def test_idle_and_guard(ck):
    bridge = C.tmpdir("idle")
    t0 = time.time()
    proc = C.start_sidecar(bridge, "--idle-exit-s", "1.5")
    try:
        proc.wait(timeout=15)
    except Exception:
        pass
    ck.ok(proc.poll() == 0 and time.time() - t0 < 12, "idle exit when telemetry never changes (%s)" % proc.poll())
    st = C.read_json(os.path.join(bridge, "status.json"))
    ck.ok(st and "unchanged" in str(st.get("stop_reason")), "final status names the idle exit")
    C.output(proc)
    proc = C.start_sidecar(C.ORACLE)
    try:
        proc.wait(timeout=15)
    except Exception:
        pass
    ck.ok(proc.poll() == 2, "refuses the repository's own oracle folder as a bridge (exit 2)")
    ck.ok(not os.path.exists(os.path.join(C.ORACLE, "sidecar.lock")) and not os.path.exists(os.path.join(C.ORACLE, "status.json")),
          "wrote nothing into the repository")
    C.output(proc)


def test_launcher(ck):
    """launch_oracle.cmd / stop_oracle.cmd from an install-shaped copy (<instance>/local/pne_oracle), Windows only."""
    if os.name != "nt":
        ck.note("launcher test skipped (not Windows)")
        return
    import subprocess
    inst = os.path.join(C.tmpdir("launch"), "local", "pne_oracle")
    os.makedirs(inst)
    for fn in ("sidecar.py", "sidecar_lock.py", "sidecar_logs.py", "tpu_worker.py", "launch_oracle.cmd", "stop_oracle.cmd"):
        shutil.copy(os.path.join(C.ORACLE, fn), os.path.join(inst, fn))
    shutil.copytree(os.path.join(C.ORACLE, "backends"), os.path.join(inst, "backends"), ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copytree(os.path.join(C.ORACLE, "models"), os.path.join(inst, "models"))
    env = dict(os.environ)
    env.pop("PNE_ORACLE_BRIDGE", None)
    r = subprocess.run(["cmd", "/c", os.path.join(inst, "launch_oracle.cmd"), "--exit-after", "2"], cwd=inst, capture_output=True, text=True,
                       timeout=90, stdin=subprocess.DEVNULL, env=env)
    st = C.read_json(os.path.join(inst, "status.json"))
    ck.ok(r.returncode == 0 and st and st.get("stop_reason", "").startswith("exit-after"), "launch_oracle.cmd runs the installed sidecar on its own folder (%s)" % r.returncode)
    p = subprocess.Popen(["cmd", "/c", os.path.join(inst, "launch_oracle.cmd")], cwd=inst, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                         stdin=subprocess.DEVNULL, env=env)
    up = C.wait_status(inst, 20, lambda x: x.get("state") == "running" and x.get("pid_proc") != (st or {}).get("pid_proc"))
    ck.ok(up is not None, "the launcher starts a sidecar that keeps running")
    s2 = subprocess.run(["cmd", "/c", os.path.join(inst, "stop_oracle.cmd")], cwd=inst, capture_output=True, text=True, timeout=30, env=env)
    try:
        p.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass
    st = C.read_json(os.path.join(inst, "status.json"))
    ck.ok(s2.returncode == 0 and p.poll() == 0 and st.get("stop_reason") == "stop.flag", "stop_oracle.cmd stops it through stop.flag only")
    ck.ok(not os.path.exists(os.path.join(inst, "stop.flag")) and not os.path.exists(os.path.join(inst, "sidecar.lock")), "flag and lock cleaned up")
    try:
        p.stdout.read()
    except (OSError, ValueError):
        pass


def main():
    ck = C.Check("oracle-sidecar")
    for fn in (test_parity, test_shared_read, test_resilience, test_stale_flag, test_manifest, test_tolerance, test_torn_writes, test_windows,
               test_exit_after, test_idle_and_guard, test_launcher, test_twenty):
        print("-- %s" % fn.__name__)
        try:
            fn(ck)
        except Exception as e:  # report and continue with the next test
            import traceback
            traceback.print_exc()
            ck.ok(False, "%s raised %r" % (fn.__name__, e))
    return ck.done()


if __name__ == "__main__":
    sys.exit(main())
