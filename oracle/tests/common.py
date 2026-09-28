"""Shared helpers for the Oracle sidecar tests. Every file lives under %TEMP% (PNE_TMP when run by
tools/run_tests.py). Processes started here are only ever stopped cooperatively: stop.flag for the sidecar,
closing stdin for helper processes. Nothing is killed.
"""
import json
import os
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ORACLE = os.path.dirname(HERE)
ROOT = os.path.dirname(ORACLE)
SIDECAR = os.path.join(ORACLE, "sidecar.py")
MODELS = os.path.join(ORACLE, "models")
if ORACLE not in sys.path:
    sys.path.insert(0, ORACLE)


def tmpdir(tag):
    base = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
    os.makedirs(base, exist_ok=True)
    return tempfile.mkdtemp(prefix="oracle_%s_" % tag, dir=base)


def pid_hex(i):
    return ("%032x" % (0x9f0c2a7e4d1b4c3a8e5f607182930000 + i))[-32:]


class Check(object):
    def __init__(self, name):
        self.name = name
        self.n = 0
        self.fails = []
        self.notes = []

    def ok(self, cond, msg):
        self.n += 1
        if not cond:
            self.fails.append(msg)
            print("  FAIL  " + msg)
        return bool(cond)

    def note(self, msg):
        self.notes.append(msg)
        print("  note  " + msg)

    def done(self):
        if self.fails:
            print("FAIL %s: %d/%d checks failed" % (self.name, len(self.fails), self.n))
            return 1
        print("PASS %s: %d checks" % (self.name, self.n))
        return 0


def _gsonify(v):
    """Numbers as doubles, like Rhino + Gson write them (1 -> 1.0)."""
    if isinstance(v, bool) or v is None or isinstance(v, str):
        return v
    if isinstance(v, (int, float)):
        return float(v)
    if isinstance(v, dict):
        return {k: _gsonify(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_gsonify(x) for x in v]
    return float(v)


def jsonio_text(obj):
    return json.dumps(_gsonify(obj), indent="\t")


def jsonio_write(path, obj, pause_s=0.0):
    """KubeJS 2001.6.5 JsonIO.write for a non-null object: Files.newBufferedWriter(path) with the default options
    CREATE, TRUNCATE_EXISTING, WRITE, i.e. the file is truncated and rewritten in place (not atomic; it is deleted
    only for a null object). pause_s > 0 stops halfway through, so a reader can see the partial (torn) file."""
    text = jsonio_text(obj)
    try:
        with open(path, "w", encoding="utf-8") as f:
            if pause_s > 0:
                f.write(text[:len(text) // 2])
                f.flush()
                time.sleep(pause_s)
                f.write(text[len(text) // 2:])
            else:
                f.write(text)
        return True
    except PermissionError:
        return False


def delete_then_write(path, obj):
    """A delete-then-write writer (NOT what the game does; kept to show the sidecar tolerates that too)."""
    try:
        os.remove(path)
    except FileNotFoundError:
        pass
    except PermissionError:
        return False
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(jsonio_text(obj))
        return True
    except PermissionError:
        return False


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def start_sidecar(bridge, *extra, **kw):
    cmd = [sys.executable, SIDECAR, "--bridge", bridge]
    if "models" in kw:
        cmd += ["--models", kw["models"]]
    if not any(str(a) == "--exit-after" for a in extra):
        cmd += ["--exit-after", "90"]  # safety net: a stuck sidecar still exits on its own
    cmd += [str(a) for a in extra]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True, cwd=ORACLE)


def wait_for(pred, timeout, step=0.02):
    end = time.time() + timeout
    while time.time() < end:
        v = pred()
        if v:
            return v
        time.sleep(step)
    return pred()


def wait_status(bridge, timeout=10.0, pred=None):
    """The first status.json that satisfies pred; without pred, the first one past the 'starting' heartbeat (which
    the sidecar writes before its model is loaded)."""
    p = os.path.join(bridge, "status.json")

    def get():
        s = read_json(p)
        if isinstance(s, dict) and (s.get("state") != "starting" if pred is None else pred(s)):
            return s
        return None
    return wait_for(get, timeout)


def supervisor(bridge, *argv):
    """An in-process sidecar.Supervisor for white-box tests (drive it with start() / step() / shutdown())."""
    import sidecar
    args = sidecar.build_parser().parse_args(["--bridge", bridge, "--quiet"] + [str(a) for a in argv])
    return sidecar.Supervisor(args)


def stop_sidecar(bridge, proc, timeout=6.0):
    """Cooperative stop: create stop.flag and wait. Returns the exit code, or None if it did not exit in time
    (then it is left to its own --exit-after safety net: never killed)."""
    with open(os.path.join(bridge, "stop.flag"), "w") as f:
        f.write("")
    try:
        proc.wait(timeout=timeout)
    except subprocess.TimeoutExpired:
        return None
    return proc.returncode


def output(proc):
    try:
        out, _ = proc.communicate(timeout=5)
        return out or ""
    except (subprocess.TimeoutExpired, ValueError):
        return ""


class FakeKube(object):
    """The KubeJS side of the bridge, in Python: JsonIO semantics (truncate and rewrite in place), slot 0 write,
    slot 10 read, and the bridge's acceptance rule (boot_id matches, seq newer than the last applied and not newer
    than the last written) and staleness rule (fresh while the answered tick is at most 60 ticks old)."""

    def __init__(self, bridge, boot=None, tick0=200000):
        self.tel = os.path.join(bridge, "telemetry.json")
        self.ver = os.path.join(bridge, "verdict.json")
        self.boot = boot or str(int(time.time() * 1000))
        self.seq = 0
        self.tick = tick0
        self.applied = -1
        self.vtick = None
        self.accepted = []       # (seq, tick written, tick read, verdict)
        self.written = {}        # seq -> tick
        self.write_fail = 0
        self.pause_s = 0.0       # > 0: every write stops halfway for this long (the torn window)

    def write(self, players, want=True, purge=None, wid=None):
        self.seq += 1
        obj = {"v": 2, "boot_id": self.boot, "seq": self.seq, "tick": self.tick, "ts_ms": int(time.time() * 1000),
               "want_oracle": want, "players": players}
        if purge:
            obj["purge"] = list(purge)
        if wid:
            obj["wid"] = wid
        if jsonio_write(self.tel, obj, self.pause_s):
            self.written[self.seq] = self.tick
        else:
            self.write_fail += 1
            self.seq -= 1

    def read(self):
        v = read_json(self.ver)
        if not isinstance(v, dict):
            return None
        try:
            seq = int(float(v.get("seq")))
        except (TypeError, ValueError):
            return None
        if str(v.get("boot_id")) != self.boot or seq <= self.applied or seq > self.seq:
            return None
        self.applied = seq
        self.vtick = float(v.get("tick"))
        self.accepted.append((seq, self.written.get(seq), self.tick, v))
        return v

    def fresh(self):
        return self.vtick is not None and self.tick - self.vtick <= 60

    def run(self, seconds, players_fn, tick_s=0.05, stop_at=None, each_tick=None):
        """Real-time ticks: slot 0 writes players_fn(second), slot 10 reads. Returns when `seconds` are done."""
        t_next = time.perf_counter()
        sec = 0
        ticks = int(seconds * 20)
        for _ in range(ticks):
            self.tick += 1
            slot = self.tick % 20
            if slot == 0:
                ps = players_fn(sec)
                if ps is not None:
                    self.write(ps)
                sec += 1
            elif slot == 10:
                self.read()
            if each_tick:
                each_tick(self)
            t_next += tick_s
            d = t_next - time.perf_counter()
            if d > 0:
                time.sleep(d)
