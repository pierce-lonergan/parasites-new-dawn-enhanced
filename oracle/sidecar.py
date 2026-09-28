"""The Oracle sidecar supervisor for Parasites New Dawn - Enhanced (TDD 4.4, docs/IMPLEMENTATION.md 3.5).

    python sidecar.py --bridge "<instance>/local/pne_oracle" [--exit-after SECONDS] [--tpu]

It owns the file bridge with the game (KubeJS can only reach files):
  telemetry.json  written by KubeJS every second. KubeJS 2001.6.5's JsonIO.write truncates the file and rewrites it
                  in place (Files.newBufferedWriter: CREATE, TRUNCATE_EXISTING, WRITE; it deletes only for a null
                  object), so a read can see an empty or partial file: that is the "torn" case. Polled every 25 ms;
                  a missing, torn or locked read is retried on the next poll. On Windows it is opened with every
                  share flag (read, write, delete), which never gets in the way of the game's writer (defensive:
                  Python's open() already shares write access, which is all the game's truncating write needs).
  verdict.json    written here per new telemetry seq, atomically (verdict.json.<tag>.tmp + os.replace, retried
                  every 0.5 ms for up to 100 ms while the game holds the file open).
  status.json     heartbeat every second with the lock nonce (the game shows it in /pne oracle status). The first
                  one ("starting") is written before the model loads.
  sidecar.lock    single instance without trusting PIDs (sidecar_lock.py): an OS-level guard lock held for the
                  life of the process plus the informational lock record, re-checked every second.
  stop.flag       cooperative shutdown: checked every loop; the flag and the lock are deleted on the way out. A
                  stop.flag older than this process (left by a stop request when no sidecar ran) is removed at
                  start instead of stopping it.
  reload.flag     reloads models/oracle_manifest.json (a bad model is refused; the previous one stays).
  logs/           opt-in NDJSON of players who ran /pne oracle log on themselves (50 MB cap; files older than 7 days
                  are deleted when the sidecar starts, once a minute while it runs, and when it stops). A purge is
                  acknowledged only once the pseudonym's files are really gone.
  worlds/<wid>/   created here (never by KubeJS) when telemetry names a world id.
A failed file operation (full disk, antivirus lock, a vanished folder) never ends the sidecar with a traceback:
writes report False, the loop logs the error and carries on, the shutdown steps each run on their own, and if the
bridge folder stays missing for 60 s the sidecar stops cooperatively.
Per player it keeps a 16-step window of standardised features (zero-padded until full; reset on respawn, a
teleport of more than 60 blocks, or a dimension change) and runs the 496-64-32-11 MLP: cpu_np in this process by
default, or the Edge TPU worker (--tpu) behind a 5 ms / 250 ms watchdog that falls back to cpu_np. The logits get a
per-head softmax here (arousal, style, flee/engage); each verdict entry carries the probabilities, conf = max(arousal)
and eo = (p1 + 2 p2 + 3 p3) / 3 (KubeJS recomputes conf, EO and the buckets itself and never trusts these).

It stops on its own when telemetry.json has not changed for 10 minutes, after --exit-after seconds, on stop.flag
or on Ctrl+C in its console. It never kills, signals or stops any other process (I10).

Python 3.13 + numpy; Python 3.9-compatible syntax (no match statements, no X | Y unions).
"""
import argparse
import glob
import json
import math
import os
import re
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import numpy as np  # noqa: E402

from backends import N_FEATURES, N_INPUT, WINDOW, softmax_heads  # noqa: E402
from backends.cpu_np import CpuNpBackend  # noqa: E402
from backends.manifest import BadModel, load as load_manifest, model_id, sha256_file  # noqa: E402
from backends.worker_client import WorkerBackend, default_worker_cmd  # noqa: E402
import sidecar_lock  # noqa: E402
import sidecar_logs  # noqa: E402

VERSION = "1.1.0"
BRIDGE_V = 2
EXIT_OK, EXIT_IO, EXIT_ARGS, EXIT_RUNNING = 0, 1, 2, 3
PID_RX = re.compile(r"^[0-9a-f]{32}$")
WID_RX = re.compile(r"^[0-9a-f-]{8,64}$")


def now_ms():
    return int(time.time() * 1000)


_WIN_OPEN = None


def _win_open_init():
    """kernel32.CreateFileW for shared reads (Windows only). None when unavailable."""
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                                wintypes.DWORD, wintypes.HANDLE)
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    return k32, ctypes.c_void_p(-1).value, ctypes.get_last_error


def open_shared(path):
    """Binary read handle that shares everything (Windows: FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE).

    The game's JsonIO.write truncates telemetry.json in place, which only needs other handles to share write access
    (Python's open() does); the delete share is defensive, so that no writer strategy (a delete-then-write, a rename
    over the file) can ever fail because the sidecar is reading at that instant. Elsewhere it is plain open()."""
    global _WIN_OPEN
    if os.name != "nt":
        return open(path, "rb")
    if _WIN_OPEN is None:
        try:
            _WIN_OPEN = _win_open_init()
        except (OSError, AttributeError, ImportError):
            _WIN_OPEN = False
    if not _WIN_OPEN:
        return open(path, "rb")
    import msvcrt
    k32, invalid, last_error = _WIN_OPEN
    h = k32.CreateFileW(path, 0x80000000, 0x7, None, 3, 0x80, None)  # GENERIC_READ, share all, OPEN_EXISTING, NORMAL
    if h is None or h == invalid:
        err = last_error()
        if err in (2, 3):  # ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND (the delete window)
            raise FileNotFoundError(2, "not found", path)
        raise PermissionError(13, "cannot open (Windows error %d)" % err, path)  # access denied, delete pending, sharing
    try:
        fd = msvcrt.open_osfhandle(h, os.O_RDONLY | getattr(os, "O_BINARY", 0))
    except OSError:
        k32.CloseHandle(h)
        raise
    return os.fdopen(fd, "rb")


def read_json_tolerant(path):
    """(obj, state): state ok | missing | torn | locked. JsonIO.write truncates and rewrites in place, so an empty or
    partial file (torn) is the common failure; missing (the game's first write, a folder mishap) and locked (an
    antivirus scan, a byte-range lock) happen too."""
    try:
        with open_shared(path) as f:
            data = f.read()
    except FileNotFoundError:
        return None, "missing"
    except PermissionError:
        return None, "locked"
    except OSError:
        return None, "locked"
    try:
        return json.loads(data.decode("utf-8")), "ok"
    except (UnicodeDecodeError, ValueError):
        return None, "torn"


def _rm_quiet(path):
    try:
        os.remove(path)
    except OSError:
        pass


def atomic_write_json(path, obj, retry_s=0.1, step_s=0.0005, tag=None):
    """tmp + os.replace, retried on PermissionError (Windows: the reader holds the target open). True on success,
    False on any failure (unserialisable object, a missing folder, a full disk, a lock that outlasts retry_s): it
    never raises. `tag` makes the tmp name private to one process (path.<tag>.tmp)."""
    tmp = "%s.%s.tmp" % (path, tag) if tag else path + ".tmp"
    try:
        data = json.dumps(obj, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError):
        return False
    try:
        with open(tmp, "wb") as f:
            f.write(data)
    except OSError:
        _rm_quiet(tmp)
        return False
    end = time.perf_counter() + retry_s
    while True:
        try:
            os.replace(tmp, path)
            return True
        except PermissionError:
            if time.perf_counter() >= end:
                _rm_quiet(tmp)
                return False
            time.sleep(step_s)
        except OSError:
            _rm_quiet(tmp)
            return False


def e_o(p):
    """E_O = (p1 + 2 p2 + 3 p3) / 3 from the arousal probabilities (TDD 4.4.1). KubeJS recomputes it; it is here for
    the logs and for other clients."""
    return float((p[1] + 2.0 * p[2] + 3.0 * p[3]) / 3.0)


def num(v, default=None):
    """Integers may arrive as 1.0 (Rhino/Gson): accept any finite number."""
    if isinstance(v, bool) or v is None:
        return default
    try:
        f = float(v)
    except (TypeError, ValueError):
        return default
    return f if math.isfinite(f) else default


class Window(object):
    __slots__ = ("rows", "last_t", "dim", "seen")

    def __init__(self):
        self.rows = []
        self.last_t = None
        self.dim = None
        self.seen = 0.0

    def reset(self):
        self.rows = []
        self.last_t = None

    def matrix(self):
        m = np.zeros((WINDOW, N_FEATURES), np.float32)
        k = len(self.rows)
        if k:
            m[WINDOW - k:] = np.asarray(self.rows, np.float32)
        return m.reshape(N_INPUT)


class Supervisor(object):
    def __init__(self, args):
        self.args = args
        self.bridge = os.path.abspath(args.bridge)
        self.models = os.path.abspath(args.models)
        self.p_tel = os.path.join(self.bridge, "telemetry.json")
        self.p_ver = os.path.join(self.bridge, "verdict.json")
        self.p_sta = os.path.join(self.bridge, "status.json")
        self.p_stop = os.path.join(self.bridge, "stop.flag")
        self.p_reload = os.path.join(self.bridge, "reload.flag")
        self.nonce = uuid.uuid4().hex
        self.tag = self.nonce[:12]  # private tmp-file suffix of this process
        self.started = time.time()
        self.lock = sidecar_lock.SidecarLock(self.bridge, self.nonce)
        self.manifest = None
        self.manifest_sha = None
        self.net = None
        self.worker = None
        self.logs = sidecar_logs.Logs(self.bridge, cap_bytes=int(args.log_cap_mb * 1024 * 1024), days=args.log_days)
        self.windows = {}
        self.boot = None
        self.last_seq = -1
        self.last_tick = None
        self.want = None
        self.sig = None
        self.bad_sig = None
        self.bad_count = 0
        self.torn_sig = None
        self.present = False
        self.last_change = time.time()
        self.reads = {"ok": 0, "missing": 0, "torn": 0, "locked": 0, "stale": 0}
        self.errors = []
        self.infer_us = []
        self.purged = {}
        self.purge_pending = {}     # pid -> files still on disk after a purge attempt (retried, never acknowledged)
        self.bridge_gone = None     # time.time() when the bridge folder was first seen missing
        self.io_errors = 0
        self.verdicts = 0
        self.verdict_fail = 0
        self.stop_reason = None
        self.next_status = 0.0
        self.wid = None
        self.wid_written = 0.0
        self.players = 0

    # -- bookkeeping ----------------------------------------------------------------------------

    def error(self, msg):
        msg = str(msg)[:200]
        if msg in self.errors:
            self.errors.remove(msg)
        self.errors.append(msg)
        del self.errors[:-5]

    def say(self, msg):
        if not self.args.quiet:
            sys.stdout.write("[oracle] %s\n" % msg)
            sys.stdout.flush()

    # -- model ----------------------------------------------------------------------------------

    def load_model(self):
        """Loads the manifest and cpu_np (and restarts the worker). A bad model keeps the previous backend."""
        path = os.path.join(self.models, "oracle_manifest.json")
        try:
            m = load_manifest(path)
            net = CpuNpBackend(m)
        except BadModel as e:
            self.error("BAD_MODEL: %s" % e)
            self.say("model refused (%s); %s" % (e, "keeping the previous model" if self.net else "no model loaded"))
            return False
        self.manifest, self.net = m, net
        self.manifest_sha = sha256_file(path)
        self.mu = np.asarray(m["mu"], np.float32)
        self.sd = np.asarray(m["sd"], np.float32)
        self.say("model %s loaded (cpu_np)" % model_id(m))
        if self.args.tpu:
            old = self.worker
            if old is not None:
                old.stop(wait_s=0.0)  # released through its pipe, not waited for (the loop never blocks)
            cmd = self.args.worker_cmd.split("|") if self.args.worker_cmd else default_worker_cmd(self.args.worker_python, path, "edgetpu")
            self.worker = WorkerBackend(cmd, cwd=HERE, log_path=os.path.join(self.bridge, "worker.log"), manifest_sha=self.manifest_sha,
                                        backoff_base=self.args.worker_backoff, reprobe_s=self.args.worker_reprobe,
                                        soft_s=self.args.worker_soft_ms / 1000.0, hard_s=self.args.worker_hard_ms / 1000.0,
                                        hello_timeout=self.args.worker_hello_s)
            if old is not None:
                self.worker.adopt(old)  # a worker still exiting is tracked, so a stuck one is never doubled
            if self.worker.start():
                self.say("TPU worker starting; cpu_np serves until it answers")
            else:
                self.say("TPU worker not available; serving from cpu_np (it is re-probed with backoff)")
        return True

    def backend_name(self):
        if self.worker is not None and self.worker.state == "ready":
            return self.worker.backend
        return "cpu_np" if self.net is not None else None

    # -- telemetry ------------------------------------------------------------------------------

    def poll_telemetry(self):
        try:
            st = os.stat(self.p_tel)
            sig = (st.st_mtime_ns, st.st_size)
        except FileNotFoundError:
            if self.present:
                self.reads["missing"] += 1  # hit the delete-then-write window (counted once per gap)
            self.present = False
            return
        except OSError:
            self.reads["locked"] += 1
            return
        self.present = True
        if sig == self.sig or sig == self.bad_sig:
            return
        self.last_change = time.time()
        obj, state = read_json_tolerant(self.p_tel)
        if state != "ok":
            if state == "missing":
                self.present = False
            self.reads[state] += 1
            if state == "torn":
                self.bad_count = self.bad_count + 1 if sig == self.torn_sig else 1
                self.torn_sig = sig
                if self.bad_count >= 3:
                    self.bad_sig = sig  # the same bytes failed three times: wait for a new file
            return
        self.sig = sig
        self.handle(obj)

    def handle(self, t):
        if not isinstance(t, dict) or num(t.get("v")) != BRIDGE_V:
            self.reads["stale"] += 1
            self.error("BAD_VERSION: telemetry v=%r" % (t.get("v") if isinstance(t, dict) else None))
            return
        boot = str(t.get("boot_id", ""))
        seq = num(t.get("seq"))
        if seq is None:
            self.reads["stale"] += 1
            return
        seq = int(seq)
        if boot != self.boot:
            if self.boot is not None:
                self.say("game restarted or reloaded (boot %s): windows reset" % boot)
            self.boot = boot
            self.last_seq = -1
            self.windows = {}
        if seq <= self.last_seq:
            self.reads["stale"] += 1
            return
        self.reads["ok"] += 1
        self.last_seq = seq
        self.last_tick = num(t.get("tick"))
        self.want = t.get("want_oracle") is True
        self.do_purge(t.get("purge"))
        self.do_world(t.get("wid"))
        entries = self.accept_players(t.get("players"))
        self.players = len(entries)
        if not self.want:
            return
        outs = self.infer(entries, seq)
        self.log_players(entries, outs, t)
        if outs is not None:
            self.write_verdict(entries, outs, seq)

    def accept_players(self, players):
        """Validated entries with their windows updated. Invalid entries are skipped."""
        out = []
        if not isinstance(players, list):
            return out
        now = time.time()
        for p in players:
            if not isinstance(p, dict):
                continue
            pid = str(p.get("pid", ""))
            f = p.get("f")
            if not PID_RX.match(pid) or not isinstance(f, list) or len(f) != N_FEATURES:
                continue
            x = np.array([num(v, float("nan")) for v in f], np.float64)
            bad = ~np.isfinite(x)
            if bad.any():
                x[bad] = self.mu[bad] if self.net is not None else 0.0
            ev = p.get("ev") if isinstance(p.get("ev"), dict) else {}
            dim = str(p.get("dim", ""))
            w = self.windows.get(pid)
            if w is None:
                w = self.windows[pid] = Window()
            if ev.get("respawned") is True or ev.get("tele") is True or (w.dim is not None and dim != w.dim):
                w.reset()
            w.dim = dim
            w.seen = now
            t = num(p.get("t"))
            if t is None or t != w.last_t:
                xn = (x - self.mu) / self.sd if self.net is not None else np.zeros(N_FEATURES)
                w.rows.append(xn.astype(np.float32))
                del w.rows[:-WINDOW]
                w.last_t = t
            out.append({"pid": pid, "f": x, "raw": f, "w": w, "ev": ev, "dim": dim, "log": p.get("log") is True,
                        "comfort": p.get("comfort") is not False})
        for pid in list(self.windows):
            if now - self.windows[pid].seen > 120:
                del self.windows[pid]
        return out

    def infer(self, entries, seq):
        """-> (probs [n, 11], backend, infer_us) or None when no model is loaded."""
        if self.net is None:
            return None
        if not entries:
            return np.zeros((0, 11)), self.backend_name(), 0
        X = np.stack([e["w"].matrix() for e in entries]).astype(np.float32)
        pids = [e["pid"] for e in entries]
        if self.worker is not None:
            r = self.worker.infer(seq, int(self.last_tick or 0), pids, X)
            if r is not None:
                probs, backend, us = r
                self.note_us(us)
                return probs, backend, int(us)
        t0 = time.perf_counter()
        probs = softmax_heads(self.net.infer(X))
        us = (time.perf_counter() - t0) * 1e6
        self.note_us(us)
        return probs, "cpu_np", int(round(us))

    def note_us(self, us):
        self.infer_us.append(float(us))
        del self.infer_us[:-2000]

    def write_verdict(self, entries, outs, seq):
        probs, backend, us = outs
        players = []
        for e, p in zip(entries, probs):
            ar = [round(float(v), 4) for v in p[0:4]]
            players.append({"pid": e["pid"], "arousal": ar, "style": [round(float(v), 4) for v in p[4:8]],
                            "fe": [round(float(v), 4) for v in p[8:11]], "conf": round(float(max(p[0:4])), 4),
                            "eo": round(e_o(p), 4), "window_fill": len(e["w"].rows)})
        v = {"v": BRIDGE_V, "boot_id": self.boot, "seq": seq, "tick": int(self.last_tick) if self.last_tick is not None else None, "ts_ms": now_ms(), "backend": backend,
             "model": model_id(self.manifest), "infer_us": us, "players": players, "purged": sorted(self.purged)}
        if atomic_write_json(self.p_ver, v, tag=self.tag):
            self.verdicts += 1
        else:
            self.verdict_fail += 1
            self.error("VERDICT_LOCKED: verdict.json stayed locked for 100 ms")

    # -- logs, purge, worlds --------------------------------------------------------------------

    def log_players(self, entries, outs, t):
        for i, e in enumerate(entries):
            if not e["log"]:
                continue
            out = None
            if outs is not None:
                p = outs[0][i]
                out = {"arousal": [round(float(v), 4) for v in p[0:4]], "style": [round(float(v), 4) for v in p[4:8]],
                       "fe": [round(float(v), 4) for v in p[8:11]], "eo": round(e_o(p), 4), "backend": outs[1]}
            rec = {"ts_ms": now_ms(), "boot_id": self.boot, "seq": self.last_seq, "tick": self.last_tick, "pid": e["pid"],
                   "dim": e["dim"], "comfort": e["comfort"], "ev": e["ev"], "f": [float(v) for v in e["f"]], "out": out,
                   "fill": len(e["w"].rows)}
            if self.wid:
                rec["wid"] = self.wid
            if not self.logs.append(e["pid"], rec):
                if self.logs.last_error == "cap":
                    self.error("LOG_CAP: logs are at the %g MB cap; a sample was not written" % self.args.log_cap_mb)
                else:
                    self.error("LOG_WRITE: a sample was not written (%s)" % self.logs.last_error)

    def do_purge(self, purge):
        """Deletes the logs of every pid in telemetry's purge list. A pid is acknowledged (listed in `purged` in
        status.json and verdict.json, which lets KubeJS forget it) only once none of its files is left; a file held
        open by another program keeps the purge pending and it is retried with every telemetry second."""
        now = time.time()
        asked = set()
        if isinstance(purge, list):
            for pid in purge:
                pid = str(pid)
                if not PID_RX.match(pid):
                    continue
                asked.add(pid)
                if pid in self.purged:
                    self.purged[pid] = now
                    continue
                deleted, remaining = self.logs.purge(pid)
                self.windows.pop(pid, None)
                if remaining:
                    if pid not in self.purge_pending:
                        self.say("purge pending: %d log file(s) of one pseudonym could not be deleted yet (open in another program?); retrying every second" % remaining)
                    self.purge_pending[pid] = remaining
                    self.error("PURGE_PENDING: %d file(s) locked" % sum(self.purge_pending.values()))
                    continue
                self.purge_pending.pop(pid, None)
                self.purged[pid] = now
                self.say("purged the logs of one pseudonym (%d file(s))" % deleted)
        for pid in list(self.purged):
            if pid not in asked and now - self.purged[pid] > 60:
                del self.purged[pid]
        for pid in list(self.purge_pending):
            if pid not in asked:
                del self.purge_pending[pid]

    def do_world(self, wid):
        if not isinstance(wid, str) or not WID_RX.match(wid):
            return
        self.wid = wid
        if time.time() - self.wid_written < 60:
            return
        d = os.path.join(self.bridge, "worlds", wid)
        try:
            os.makedirs(d, exist_ok=True)
            p = os.path.join(d, "world.json")
            old, _ = read_json_tolerant(p)
            first = old.get("first_seen_ms") if isinstance(old, dict) else None
            if not atomic_write_json(p, {"wid": wid, "first_seen_ms": first or now_ms(), "last_seen_ms": now_ms(), "boot_id": self.boot,
                                         "last_seq": self.last_seq}, tag=self.tag):
                self.error("WORLD_DIR: world.json was not written")
            self.wid_written = time.time()
        except OSError as e:
            self.error("WORLD_DIR: %s" % e)

    # -- status ---------------------------------------------------------------------------------

    def status(self, state="running"):
        us = sorted(self.infer_us)
        n = len(us)
        me = self.lock.me
        w = self.worker.status() if self.worker is not None else {"state": "off", "restarts": 0}
        usb = w.get("usb") if isinstance(w.get("usb"), dict) else {"vidpid": None, "speed": None}
        errors = list(self.errors)
        if self.worker is not None:
            errors = (errors + self.worker.events)[-5:]
        return {"v": BRIDGE_V, "pid_proc": os.getpid(), "create_time": me.get("create_time"), "nonce": self.nonce,
                "backend": self.backend_name(), "worker": {"state": w.get("state"), "restarts": w.get("restarts", 0), "detail": w},
                "ts_ms": now_ms(), "uptime_s": round(time.time() - self.started, 1),
                "infer_p50_us": round(us[n // 2], 1) if n else None, "infer_p99_us": round(us[min(n - 1, int(n * 0.99))], 1) if n else None,
                "reads": dict(self.reads), "errors": errors, "usb": usb, "purged": sorted(self.purged),
                "model": model_id(self.manifest) if self.manifest else None, "boot_id": self.boot, "last_seq": self.last_seq,
                "want_oracle": self.want, "players": self.players, "verdicts": self.verdicts, "state": state,
                "stop_reason": self.stop_reason, "logs": {"written": self.logs.written, "skipped": self.logs.skipped, "failed": self.logs.failed},
                "purge_pending": len(self.purge_pending), "io_errors": self.io_errors, "version": VERSION}

    def heartbeat(self, force=False, state="running"):
        """status.json once a second (force: now). While running it also re-reads sidecar.lock: another nonce in it
        means another instance took over, and this one leaves cooperatively."""
        t = time.time()
        if not force and t < self.next_status:
            return
        self.next_status = t + 1.0
        if state == "running":
            own = self.lock.check()
            if own == "taken":
                self.stop_reason = "lock taken by another instance"
                self.say("sidecar.lock now names another instance; this one stops (nothing else is touched)")
                return
            if own == "rewritten":
                self.error("LOCK: sidecar.lock had vanished and was written again")
        if not atomic_write_json(self.p_sta, self.status(state), tag=self.tag):
            self.error("STATUS_WRITE: status.json could not be written")

    # -- main loop ------------------------------------------------------------------------------

    def clear_stale_stop_flag(self):
        """A stop.flag older than this process was meant for an earlier sidecar (stop_oracle.cmd creates it even when
        none runs, for example after the idle exit). It is removed instead of stopping this start. Runs only after
        the lock is taken, so no live sidecar can be the flag's target."""
        try:
            mtime = os.stat(self.p_stop).st_mtime
        except OSError:
            return False
        born = self.started
        ct = self.lock.me.get("create_time")
        if isinstance(ct, (int, float)) and 0 < ct < born:
            born = ct
        if mtime >= born:
            return False
        try:
            os.remove(self.p_stop)
        except OSError:
            return False
        self.say("removed a stop.flag left from an earlier stop request")
        return True

    def clear_stale_tmp(self):
        """Removes tmp files a crashed sidecar left in the bridge folder (only this process can be writing now)."""
        for name in ("status.json", "verdict.json", "sidecar.lock"):
            for p in glob.glob(os.path.join(glob.escape(self.bridge), name + "*.tmp")):
                _rm_quiet(p)

    def check_bridge(self):
        """False (with stop_reason) once the bridge folder has been missing for bridge_gone_s seconds."""
        if os.path.isdir(self.bridge):
            if self.bridge_gone is not None:
                self.say("the bridge folder is back")
            self.bridge_gone = None
            return True
        now = time.time()
        if self.bridge_gone is None:
            self.bridge_gone = now
            self.say("the bridge folder %s is missing; stopping if it is not back within %g s" % (self.bridge, self.args.bridge_gone_s))
        if now - self.bridge_gone >= self.args.bridge_gone_s:
            self.stop_reason = "bridge folder missing for %g s" % self.args.bridge_gone_s
            return False
        return True

    def check_flags(self):
        if os.path.exists(self.p_stop):
            self.stop_reason = "stop.flag"
            return False
        if os.path.exists(self.p_reload):
            try:
                os.remove(self.p_reload)
            except OSError:
                pass
            self.say("reload.flag: reloading the model")
            try:
                self.load_model()
            except OSError as e:
                self.error("BAD_MODEL: reload failed (%s)" % e)
        return True

    def start(self):
        """Everything before the loop. Returns None when ready, else the exit code (the lock is not held then)."""
        try:
            os.makedirs(self.bridge, exist_ok=True)
        except OSError as e:
            self.say("cannot create the bridge folder %s (%s)" % (self.bridge, e))
            return EXIT_IO
        try:
            replaced = self.lock.acquire()
        except sidecar_lock.AlreadyRunning as e:
            self.say("another sidecar is already running (%s); this one exits. Nothing was stopped." % e)
            return EXIT_RUNNING
        except OSError as e:
            self.say("cannot write sidecar.lock in %s (%s); this one exits" % (self.bridge, e))
            return EXIT_IO
        if replaced:
            self.say("replaced a stale lock (%s); no process was touched" % replaced)
        self.clear_stale_stop_flag()
        self.clear_stale_tmp()
        self.heartbeat(force=True, state="starting")  # the lock is visibly live before the model loads
        try:
            self.load_model()
        except OSError as e:  # a model file vanishing between the checks: served as "no model", never a traceback
            self.error("BAD_MODEL: %s" % e)
        self.logs.maintain(force=True)
        self.say("watching %s (poll %d ms)" % (self.bridge, self.args.poll_ms))
        self.next_status = 0.0
        return None

    def step(self):
        """One loop pass. False when the sidecar should stop (stop_reason says why). A file error inside the pass is
        recorded (status.errors) and the pass is retried next time; it never ends the process."""
        if not self.check_flags():
            return False
        if self.args.exit_after and time.time() - self.started >= self.args.exit_after:
            self.stop_reason = "exit-after %gs" % self.args.exit_after
            return False
        if time.time() - self.last_change >= self.args.idle_exit_s:
            self.stop_reason = "telemetry unchanged for %d s" % self.args.idle_exit_s
            return False
        if not self.check_bridge():
            return False
        try:
            self.poll_telemetry()
            if self.worker is not None:
                self.worker.poll()
            self.logs.maintain()
            self.heartbeat()
        except OSError as e:
            self.io_errors += 1
            self.error("IO: %s" % e)
        return self.stop_reason is None

    def run(self):
        code = self.start()
        if code is not None:
            return code
        poll = self.args.poll_ms / 1000.0
        try:
            nxt = time.perf_counter()
            while self.step():
                nxt += poll
                delay = nxt - time.perf_counter()
                if delay > 0:
                    time.sleep(delay)
                else:
                    nxt = time.perf_counter()
        except KeyboardInterrupt:
            self.stop_reason = "Ctrl+C"
        finally:
            self.shutdown()
        return EXIT_OK

    def shutdown(self):
        """Each step runs on its own: one failure (a vanished folder, a full disk) never skips the others, so the
        worker is always released, the flag removed and the lock and its guard dropped."""
        def stop_worker():
            if self.worker is not None:
                self.worker.stop()

        def remove_flag():
            if self.stop_reason == "stop.flag":
                _rm_quiet(self.p_stop)

        steps = (("worker", stop_worker), ("status", lambda: self.heartbeat(force=True, state="stopped")),
                 ("logs", lambda: self.logs.maintain(force=True)), ("stop.flag", remove_flag), ("lock", self.lock.release))
        for name, fn in steps:
            try:
                fn()
            except Exception as e:  # noqa: BLE001 - shutdown must finish every step
                self.say("shutdown step '%s' failed (%s); continuing" % (name, e))
        self.say("stopped (%s)" % (self.stop_reason or "exit"))


def default_bridge():
    env = os.environ.get("PNE_ORACLE_BRIDGE")
    if env:
        return env
    parent = os.path.basename(os.path.dirname(HERE)).lower()
    if parent == "local":  # installed as <instance>/local/pne_oracle/sidecar.py
        return HERE
    return None


def looks_like_repo(bridge):
    b = os.path.abspath(bridge)
    root = os.path.dirname(b)
    return os.path.isfile(os.path.join(b, "sidecar.py")) and os.path.isdir(os.path.join(root, "overrides")) and os.path.isdir(os.path.join(root, "tools"))


def build_parser():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--bridge", default=None, help="the bridge folder, <instance>/local/pne_oracle (default: this folder when installed there)")
    ap.add_argument("--models", default=os.path.join(HERE, "models"))
    ap.add_argument("--poll-ms", type=int, default=25)
    ap.add_argument("--idle-exit-s", type=float, default=600.0)
    ap.add_argument("--exit-after", type=float, default=0.0, help="exit cooperatively after this many seconds (0 = never)")
    ap.add_argument("--log-cap-mb", type=float, default=50.0)
    ap.add_argument("--log-days", type=float, default=7.0)
    ap.add_argument("--tpu", action="store_true", help="use the Edge TPU worker (M7; needs the py3.9 venv with tflite_runtime)")
    ap.add_argument("--worker-python", default=os.environ.get("PNE_ORACLE_WORKER_PY", sys.executable))
    ap.add_argument("--worker-cmd", default="", help="full worker command, arguments separated by |")
    ap.add_argument("--worker-backoff", type=float, default=1.0)
    ap.add_argument("--worker-reprobe", type=float, default=60.0)
    ap.add_argument("--worker-soft-ms", type=float, default=5.0)
    ap.add_argument("--worker-hard-ms", type=float, default=250.0)
    ap.add_argument("--worker-hello-s", type=float, default=20.0, help="how long a starting worker may take to answer HELLO (never blocks the loop)")
    ap.add_argument("--bridge-gone-s", type=float, default=60.0, help="stop cooperatively when the bridge folder stays missing this long")
    ap.add_argument("--quiet", action="store_true")
    return ap


def main(argv=None):
    args = build_parser().parse_args(argv)
    args.bridge = args.bridge or default_bridge()
    if not args.bridge:
        sys.stderr.write("sidecar: pass --bridge <instance>\\local\\pne_oracle (or run the installed copy there)\n")
        return EXIT_ARGS
    if looks_like_repo(args.bridge):
        sys.stderr.write("sidecar: %s is the repository's oracle folder, not a bridge folder; pass --bridge <instance>\\local\\pne_oracle\n" % args.bridge)
        return EXIT_ARGS
    return Supervisor(args).run()


if __name__ == "__main__":
    sys.exit(main())
