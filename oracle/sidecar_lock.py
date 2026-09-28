"""Single-instance lock for the Oracle sidecar, without trusting PIDs (TDD 4.4.2).

Two layers:
  1. sidecar.lock.guard: an OS-level exclusive lock held for the whole life of the process (msvcrt.locking on
     Windows, fcntl.flock elsewhere). The operating system releases it when the process ends, however it ends, so
     no PID is ever trusted and two sidecars can never both pass acquire(), whatever their start offset. A second
     instance that cannot take it exits (code 3).
  2. sidecar.lock: the informational record {pid, create_time, exe_path, cmdline, nonce}. A new instance that holds
     the guard still treats an existing lock as live only if ALL of these hold (this also covers a sidecar of an
     older version that did not take the guard):
       - a process with that pid exists and is still running,
       - its creation time and executable path match the lock,
       - its command line contains 'sidecar.py',
       - status.json carries the same nonce with ts_ms under 5 s old.
     Otherwise the lock is stale and is overwritten. Every running sidecar re-reads the lock once a second
     (check()) and leaves cooperatively if another nonce ever appears in it.
No process is ever signalled, stopped or killed: a live lock only makes the new instance exit, and a stale one is
simply replaced. While a sidecar runs, its open guard file keeps the bridge folder from being renamed or deleted
(Windows); stop the sidecar first.

Process facts come from read-only queries: on Windows OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION) with
GetExitCodeProcess, GetProcessTimes, QueryFullProcessImageNameW and NtQueryInformationProcess
(ProcessCommandLineInformation); on Linux /proc. Python 3.9-compatible syntax.
"""
import json
import os
import sys
import time

LIVE_STATUS_MS = 5000
CTIME_TOL = 1e-3
GUARD_NAME = "sidecar.lock.guard"
GUARD_WAIT_S = 1.0  # a sidecar that is just shutting down releases the guard within this time


def _win_info(pid):
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    ntdll = ctypes.WinDLL("ntdll")
    k32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.CloseHandle.argtypes = (wintypes.HANDLE,)
    k32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    k32.GetProcessTimes.argtypes = (wintypes.HANDLE,) + (ctypes.POINTER(wintypes.FILETIME),) * 4
    k32.QueryFullProcessImageNameW.argtypes = (wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD))
    ntdll.NtQueryInformationProcess.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.ULONG, ctypes.POINTER(wintypes.ULONG))
    ntdll.NtQueryInformationProcess.restype = ctypes.c_long
    h = k32.OpenProcess(0x1000, False, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return None
    try:
        code = wintypes.DWORD()
        alive = bool(k32.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        ft = [wintypes.FILETIME() for _ in range(4)]
        ctime = None
        if k32.GetProcessTimes(h, *[ctypes.byref(x) for x in ft]):
            v = (ft[0].dwHighDateTime << 32) | ft[0].dwLowDateTime
            ctime = (v - 116444736000000000) / 1e7
        size = wintypes.DWORD(32768)
        buf = ctypes.create_unicode_buffer(size.value)
        exe = buf.value if k32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)) else ""
        cmdline = ""

        class UNICODE_STRING(ctypes.Structure):
            _fields_ = (("Length", ctypes.c_ushort), ("MaximumLength", ctypes.c_ushort), ("Buffer", ctypes.c_void_p))

        need = wintypes.ULONG(0)
        n = 4096
        for _ in range(3):
            raw = ctypes.create_string_buffer(n)
            st = ntdll.NtQueryInformationProcess(h, 60, raw, n, ctypes.byref(need))  # ProcessCommandLineInformation
            if st == 0:
                us = UNICODE_STRING.from_buffer(raw)
                if us.Buffer and us.Length:
                    cmdline = ctypes.wstring_at(us.Buffer, us.Length // 2)
                break
            n = max(n * 2, int(need.value) + 64)
        return {"pid": int(pid), "alive": alive, "create_time": ctime, "exe": exe, "cmdline": cmdline}
    finally:
        k32.CloseHandle(h)


def _linux_info(pid):
    base = "/proc/%d" % int(pid)
    try:
        with open(base + "/stat", "r") as f:
            stat = f.read()
        fields = stat[stat.rindex(")") + 2:].split()
        state = fields[0]
        start_ticks = int(fields[19])
        btime = 0
        with open("/proc/stat", "r") as f:
            for line in f:
                if line.startswith("btime"):
                    btime = int(line.split()[1])
        ctime = btime + start_ticks / float(os.sysconf("SC_CLK_TCK"))
        try:
            exe = os.readlink(base + "/exe")
        except OSError:
            exe = ""
        with open(base + "/cmdline", "rb") as f:
            cmdline = f.read().replace(b"\0", b" ").decode("utf-8", "replace").strip()
        return {"pid": int(pid), "alive": state not in ("Z", "X"), "create_time": ctime, "exe": exe, "cmdline": cmdline}
    except (OSError, ValueError, IndexError):
        return None


def process_info(pid):
    """{'pid', 'alive', 'create_time', 'exe', 'cmdline'} for a pid, or None if it cannot be read. Read-only."""
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None
    if os.name == "nt":
        try:
            return _win_info(pid)
        except (OSError, AttributeError, ValueError):
            return None
    if sys.platform.startswith("linux"):
        return _linux_info(pid)
    return None


def _norm(p):
    return os.path.normcase(os.path.normpath(str(p or "")))


def _read_json(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def assess(lock_path, status_path, now_ms=None):
    """(live, reason) for an existing lock file. live only when every rule holds."""
    data = _read_json(lock_path)
    if not isinstance(data, dict):
        return False, "lock unreadable"
    info = process_info(data.get("pid"))
    if info is None:
        return False, "no process with pid %s" % data.get("pid")
    if not info["alive"]:
        return False, "process %s has exited" % data.get("pid")
    try:
        want_ct = float(data.get("create_time"))
    except (TypeError, ValueError):
        return False, "lock has no creation time"
    if info["create_time"] is None or abs(info["create_time"] - want_ct) > CTIME_TOL:
        return False, "pid %s now belongs to a different process (creation time differs)" % data.get("pid")
    if _norm(info["exe"]) != _norm(data.get("exe_path")):
        return False, "pid %s runs a different executable" % data.get("pid")
    if "sidecar.py" not in (info["cmdline"] or ""):
        return False, "pid %s is not a sidecar (command line)" % data.get("pid")
    st = _read_json(status_path)
    if not isinstance(st, dict) or st.get("nonce") != data.get("nonce"):
        return False, "status.json nonce does not match"
    now = time.time() * 1000.0 if now_ms is None else now_ms
    try:
        age = now - float(st.get("ts_ms"))
    except (TypeError, ValueError):
        return False, "status.json has no timestamp"
    if not (-LIVE_STATUS_MS < age < LIVE_STATUS_MS):
        return False, "status.json is %.1f s old" % (age / 1000.0)
    return True, "live sidecar pid %s" % data.get("pid")


def _os_lock(fd):
    """Non-blocking exclusive lock on byte 0 of fd; raises OSError when another process holds it."""
    os.lseek(fd, 0, os.SEEK_SET)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
        return
    import fcntl
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)


def _os_unlock(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
        return
    import fcntl
    fcntl.flock(fd, fcntl.LOCK_UN)


class Guard(object):
    """An OS-level exclusive lock on a file, held until release() or the end of the process (the OS drops it then,
    so a crashed sidecar never leaves it behind). The guard file itself is never deleted (deleting a lock file is
    what reopens the race)."""

    def __init__(self, path):
        self.path = path
        self.fd = None
        self.why = ""

    def acquire(self, wait_s=0.0):
        end = time.time() + max(0.0, float(wait_s))
        while True:
            fd = None
            try:
                fd = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o644)
                _os_lock(fd)
                self.fd = fd
                return True
            except ImportError:
                # no locking primitive on this platform: fall back to the sidecar.lock rules alone
                if fd is not None:
                    os.close(fd)
                self.why = "no OS lock on this platform"
                return True
            except OSError as e:
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                self.why = str(e)
            if time.time() >= end:
                return False
            time.sleep(0.05)

    def release(self):
        fd, self.fd = self.fd, None
        if fd is None:
            return
        try:
            _os_unlock(fd)
        except (OSError, ImportError):
            pass
        try:
            os.close(fd)
        except OSError:
            pass


class AlreadyRunning(Exception):
    pass


class SidecarLock(object):
    def __init__(self, bridge_dir, nonce):
        self.path = os.path.join(bridge_dir, "sidecar.lock")
        self.status_path = os.path.join(bridge_dir, "status.json")
        self.guard = Guard(os.path.join(bridge_dir, GUARD_NAME))
        self.nonce = nonce
        self.me = process_info(os.getpid()) or {"pid": os.getpid(), "create_time": None, "exe": sys.executable, "cmdline": " ".join(sys.argv)}
        self.replaced = None
        self.held = False

    def record(self):
        return {"pid": os.getpid(), "create_time": self.me.get("create_time"), "exe_path": self.me.get("exe") or sys.executable,
                "cmdline": self.me.get("cmdline") or " ".join(sys.argv), "nonce": self.nonce, "started_ms": int(time.time() * 1000)}

    def _write(self):
        tmp = "%s.%s.tmp" % (self.path, self.nonce[:12])  # never shared with another instance
        try:
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.record(), f)
            os.replace(tmp, self.path)
        except OSError:
            try:
                os.remove(tmp)
            except OSError:
                pass
            raise

    def acquire(self, guard_wait_s=GUARD_WAIT_S):
        """Takes the lock or raises AlreadyRunning. A stale lock is overwritten; nothing is ever killed."""
        if not self.guard.acquire(guard_wait_s):
            raise AlreadyRunning("another sidecar holds %s" % GUARD_NAME)
        try:
            if os.path.exists(self.path):
                live, why = assess(self.path, self.status_path)
                if live:
                    raise AlreadyRunning(why)
                self.replaced = why
            self._write()
            back = _read_json(self.path)
            if not isinstance(back, dict) or back.get("nonce") != self.nonce:
                raise AlreadyRunning("another sidecar took the lock at the same moment")
        except (AlreadyRunning, OSError):
            self.guard.release()
            raise
        self.held = True
        return self.replaced

    def check(self):
        """Once a second while running: 'ok', 'rewritten' (the lock file had vanished and was written again) or
        'taken' (another nonce is in it: this instance must leave). An unreadable lock counts as ok this time."""
        if not self.held:
            return "ok"
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                back = json.load(f)
        except FileNotFoundError:
            try:
                self._write()
                return "rewritten"
            except OSError:
                return "ok"
        except (OSError, ValueError):
            return "ok"
        if isinstance(back, dict) and back.get("nonce") not in (None, self.nonce):
            return "taken"
        return "ok"

    def release(self):
        """Deletes sidecar.lock if it is still ours, then drops the guard (even if the delete failed)."""
        try:
            back = _read_json(self.path)
            if isinstance(back, dict) and back.get("nonce") == self.nonce:
                try:
                    os.remove(self.path)
                except OSError:
                    pass
        finally:
            self.held = False
            self.guard.release()
