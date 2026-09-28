"""Supervisor side of the TPU worker: spawn, v2 pipe protocol, and the watchdog (TDD 4.4.2).

  soft deadline   5 ms: that second is served from cpu_np; 3 soft misses in a row demote to cpu_np and the
                  TPU is re-probed after 60 s
  hard deadline 250 ms, a worker exit, a protocol error or an ERROR frame: demote at once and respawn with
                  exponential backoff 1, 2, 4 ... 60 s
Nothing here ever blocks the supervisor's 25 ms loop for long:
  - start() only spawns the worker and sends HELLO (state 'starting'); poll(), called on every loop pass, finishes
    the handshake when WELCOME arrives (state 'ready') or gives up after hello_timeout. cpu_np serves every second
    until the worker is ready, so a delegate that hangs during USB enumeration costs no verdict and no heartbeat.
  - a worker is released through its pipe only (an EXIT frame, then stdin is closed) and is not waited for; it is
    watched in `exiting` until it leaves by itself. It is never killed (I10).
  - while an earlier worker is still running after its EXIT (hung inside native code), no new one is spawned
    (state 'blocked', cpu_np serves), so at most one stuck worker can ever exist.
Python 3.9-compatible syntax.
"""
import os
import queue
import subprocess
import threading
import time

import numpy as np

from . import BACKEND_NAMES, N_FEATURES, WINDOW, quantize
from . import pipe_v2 as P

SOFT_S = 0.005
HARD_S = 0.250
EXIT_GRACE_S = 5.0     # a released worker still running after this long counts as abandoned (left alone)


class WorkerBackend(object):
    def __init__(self, cmd, cwd=None, log_path=None, manifest_sha=None, backoff_base=1.0, backoff_cap=60.0,
                 reprobe_s=60.0, hello_timeout=20.0, soft_s=SOFT_S, hard_s=HARD_S, exit_grace_s=EXIT_GRACE_S,
                 clock=time.perf_counter):
        self.cmd = list(cmd)
        self.cwd = cwd
        self.log_path = log_path
        self.manifest_sha = manifest_sha
        self.backoff_base = float(backoff_base)
        self.backoff_cap = float(backoff_cap)
        self.reprobe_s = float(reprobe_s)
        self.hello_timeout = float(hello_timeout)
        self.soft_s = float(soft_s)
        self.hard_s = float(hard_s)
        self.exit_grace_s = float(exit_grace_s)
        self.clock = clock
        self.state = "off"          # off, starting, ready, backoff, demoted, blocked
        self.starts = 0
        self.crashes = 0
        self.soft_misses = 0
        self.served = 0
        self.fallbacks = 0
        self.next_try = 0.0
        self.hello_deadline = 0.0
        self.outstanding = None     # (seq, sent_at) of an unanswered request
        self.proc = None
        self.q = None
        self.welcome = None
        self.backend = None
        self.s_in = None
        self.zp_in = None
        self.events = []            # short strings for status.errors
        self.exiting = []           # [(Popen, released_at)] released workers that have not left yet
        self.abandoned = 0          # of those, how many are past exit_grace_s (left alone, never killed)
        self._noted_stuck = False

    # -- lifecycle -------------------------------------------------------------------------------

    def _note(self, msg):
        self.events.append("WORKER: " + msg)
        del self.events[:-5]

    def _reader(self, proc, q):
        try:
            while True:
                payload = P.read_frame(proc.stdout)
                if payload is None:
                    break
                q.put(("frame", payload))
        except (P.ProtocolError, OSError, ValueError) as e:
            q.put(("error", str(e)))
        q.put(("eof", None))

    def adopt(self, other):
        """Takes over the released-but-running workers of an older WorkerBackend (model reload), so a stuck one is
        still counted and never doubled."""
        self.exiting.extend(other.exiting)
        other.exiting = []

    def _reap(self):
        now = self.clock()
        self.exiting = [(p, t) for p, t in self.exiting if p.poll() is None]
        self.abandoned = sum(1 for _p, t in self.exiting if now - t > self.exit_grace_s)
        if not self.exiting:
            self._noted_stuck = False

    def start(self):
        """Spawns the worker and sends HELLO; never waits for the answer (poll() does). Returns True when a worker
        was spawned (state 'starting'), False when it could not be (state 'backoff' or 'blocked')."""
        self._reap()
        if self.exiting:
            self.state = "blocked"
            self.next_try = self.clock() + max(0.25, min(self.backoff_base, 1.0))
            if not self._noted_stuck:
                self._noted_stuck = True
                self._note("previous worker still running after EXIT; TPU disabled until it exits (never killed)")
            return False
        self.starts += 1
        try:
            log = open(self.log_path, "wb") if self.log_path else subprocess.DEVNULL
        except OSError:
            log = subprocess.DEVNULL
        try:
            self.proc = subprocess.Popen(self.cmd, cwd=self.cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log, bufsize=0)
        except OSError as e:
            self.proc = None
            self._fail("cannot start (%s)" % e, crash=True)
            return False
        finally:
            if log is not subprocess.DEVNULL:
                log.close()
        self.q = queue.Queue()
        t = threading.Thread(target=self._reader, args=(self.proc, self.q), daemon=True)
        t.start()
        self.welcome = None
        self.outstanding = None
        try:
            self._send(P.json_frame(P.HELLO, {"v": 2, "client": "pne-supervisor", "want_model": False}))
        except (OSError, ValueError) as e:
            self._fail("cannot send HELLO (%s)" % e, crash=True)
            return False
        self.state = "starting"
        self.hello_deadline = self.clock() + self.hello_timeout
        return True

    def _handshake(self, now):
        """One non-blocking look for WELCOME while 'starting'."""
        while True:
            try:
                kind, payload = self.q.get_nowait()
            except queue.Empty:
                break
            if kind != "frame":
                self._fail("exited before WELCOME", crash=True)
                return
            err = None
            try:
                mtype, _seq, _tick, _n, body = P.parse(payload)
                if mtype == P.ERROR:
                    err = "ERROR %s" % P.body_json(body).get("code", "?")
                elif mtype != P.WELCOME:
                    continue
                else:
                    w = P.body_json(body)
                    err = self._check_welcome(w)
                    if err is None:
                        s_in, zp_in = float(w["s_in"]), int(w["zp_in"])
                        self.welcome = w
                        self.backend = str(w.get("backend"))
                        self.s_in, self.zp_in = s_in, zp_in
            except (P.ProtocolError, ValueError, KeyError, TypeError) as e:
                err = "handshake failed (%s)" % e
            if err is not None:
                self._fail(err, crash=True)
                return
            self.state = "ready"
            self.soft_misses = 0
            self.outstanding = None
            return
        if now >= self.hello_deadline:
            self._fail("no WELCOME within %.0f s" % self.hello_timeout, crash=True)

    def _check_welcome(self, w):
        if int(w.get("v", 0)) != 2:
            return "WELCOME version %r" % w.get("v")
        if str(w.get("backend")) not in ("edgetpu", "cpu_tfl", "cpu_np"):
            return "WELCOME backend %r" % w.get("backend")
        if int(w.get("window", 0)) != WINDOW or len(w.get("feature_names") or []) != N_FEATURES:
            return "WELCOME window/features do not match"
        if self.manifest_sha and w.get("manifest_sha256") != self.manifest_sha:
            return "worker loaded a different manifest"
        if w.get("s_in") is None or w.get("zp_in") is None:
            return "WELCOME without s_in/zp_in"
        return None

    def _send(self, data):
        self.proc.stdin.write(data)
        self.proc.stdin.flush()

    def _release(self, wait_s=0.0):
        """EXIT frame, close stdin, then at most wait_s for it to leave (0 = do not wait). A worker still running is
        watched in `exiting`. Never kills."""
        proc = self.proc
        self.proc = None
        self.outstanding = None
        if proc is None:
            return
        try:
            proc.stdin.write(P.json_frame(P.EXIT, {}))
            proc.stdin.flush()
        except (OSError, ValueError):
            pass
        try:
            proc.stdin.close()
        except (OSError, ValueError):
            pass
        if wait_s > 0:
            try:
                proc.wait(timeout=wait_s)
            except subprocess.TimeoutExpired:
                pass
        if proc.poll() is None:
            self.exiting.append((proc, self.clock()))

    def _fail(self, why, crash):
        """Demote to cpu_np. crash: respawn with backoff; otherwise re-probe after reprobe_s."""
        self._note(why)
        self._release()
        if crash:
            self.crashes += 1
            delay = min(self.backoff_cap, self.backoff_base * (2 ** min(self.crashes - 1, 16)))
        else:
            delay = max(self.reprobe_s, min(self.backoff_cap, self.backoff_base))
        self.state = "backoff" if crash else "demoted"
        self.next_try = self.clock() + delay

    def stop(self, wait_s=2.0):
        """Releases the worker (bounded wait; at shutdown only). Never kills."""
        self._release(wait_s=wait_s)
        self.state = "off"
        self._reap()

    # -- per poll --------------------------------------------------------------------------------

    def poll(self):
        """Once per supervisor loop pass: finishes the handshake, drains late frames, applies the hard deadline,
        notices a dead worker, respawns when due. Never blocks."""
        now = self.clock()
        if self.exiting:
            before = self.abandoned
            self._reap()
            if self.abandoned > before:
                self._note("a released worker did not exit within %.0f s; left to finish on its own (never killed)" % self.exit_grace_s)
        if self.state in ("backoff", "demoted", "blocked"):
            if now >= self.next_try:
                self.start()
            return
        if self.state == "starting":
            self._handshake(now)
            return
        if self.state != "ready" or self.proc is None:
            return
        while True:
            try:
                kind, payload = self.q.get_nowait()
            except queue.Empty:
                break
            if kind == "eof":
                self._fail("worker exited (code %s)" % self.proc.poll(), crash=True)
                return
            if kind == "error":
                self._fail("protocol error (%s)" % payload, crash=True)
                return
            if not self._late(payload):
                return
        if self.outstanding is not None and now - self.outstanding[1] > self.hard_s:
            self._fail("hard deadline %.0f ms missed" % (self.hard_s * 1000), crash=True)
            return
        if self.proc is not None and self.proc.poll() is not None:
            self._fail("worker exited (code %s)" % self.proc.poll(), crash=True)

    def _late(self, payload):
        try:
            mtype, seq, _tick, n, body = P.parse(payload)
        except P.ProtocolError as e:
            self._fail("protocol error (%s)" % e, crash=True)
            return False
        if mtype == P.ERROR:
            self._fail("ERROR %s" % P.body_json(body).get("code", "?"), crash=True)
            return False
        if mtype == P.RESULT and self.outstanding is not None and seq == self.outstanding[0]:
            self.outstanding = None  # late answer: dropped, the second was served by cpu_np
        return True

    def infer(self, seq, tick, pids, xn):
        """Windows [n, 496] (standardised) -> (probs [n, 11], backend, infer_us) or None (use cpu_np)."""
        if self.state != "ready" or self.proc is None:
            return None
        self.poll()
        if self.state != "ready" or self.outstanding is not None:
            self.fallbacks += 1
            return None
        q = quantize(xn, self.s_in, self.zp_in, np.int8)
        t0 = self.clock()
        try:
            self._send(P.infer_window_frame(seq, tick, pids, q))
        except (OSError, ValueError, P.ProtocolError) as e:
            self._fail("pipe write failed (%s)" % e, crash=True)
            return None
        deadline = t0 + self.soft_s
        answered = False
        while True:
            left = deadline - self.clock()
            try:
                kind, payload = self.q.get(timeout=left) if left > 0 else self.q.get_nowait()
            except queue.Empty:
                break
            if kind == "eof":
                self._fail("worker exited during a request", crash=True)
                return None
            if kind == "error":
                self._fail("protocol error (%s)" % payload, crash=True)
                return None
            try:
                mtype, rseq, _tick, n, body = P.parse(payload)
                if mtype == P.ERROR:
                    self._fail("ERROR %s" % P.body_json(body).get("code", "?"), crash=True)
                    return None
                if mtype != P.RESULT or rseq != seq:
                    continue  # stale result or PONG: dropped (window of 1)
                code, us, rpids, probs, _conf, _flags = P.parse_result(n, body)
            except P.ProtocolError as e:
                self._fail("protocol error (%s)" % e, crash=True)
                return None
            if rpids != list(pids):
                self._fail("result pids do not match the request", crash=True)
                return None
            if self.clock() - t0 > self.soft_s:
                answered = True  # arrived, but after the soft deadline (coarse OS timers): treated as a miss
                break
            self.soft_misses = 0
            self.served += 1
            return probs.astype(np.float64), BACKEND_NAMES.get(code, "edgetpu"), us
        # soft deadline missed: this second is served by cpu_np
        self.soft_misses += 1
        self.fallbacks += 1
        if not answered:
            self.outstanding = (seq, t0)
        if self.soft_misses >= 3:
            self._fail("3 consecutive inferences over %.0f ms" % (self.soft_s * 1000), crash=False)
        return None

    def status(self):
        left = max(0.0, self.next_try - self.clock()) if self.state in ("backoff", "demoted", "blocked") else 0.0
        return {"state": self.state, "restarts": max(0, self.starts - 1), "backend": self.backend, "soft_misses": self.soft_misses,
                "served": self.served, "fallbacks": self.fallbacks, "next_try_s": round(left, 1), "exiting": len(self.exiting),
                "abandoned": self.abandoned, "usb": (self.welcome or {}).get("usb")}


def default_worker_cmd(python_exe, manifest_path, backend="edgetpu"):
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return [python_exe, os.path.join(here, "tpu_worker.py"), "--manifest", manifest_path, "--backend", backend]
