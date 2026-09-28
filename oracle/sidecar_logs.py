"""Opt-in NDJSON telemetry logs of the Oracle sidecar (TDD 4.4.2, I11).

Only players whose telemetry entry says log: true (set by that player's own /pne oracle log on) are logged.
Files: <bridge>/logs/<pid>-<YYYYMMDD>.ndjson (UTC day), one JSON object per accepted second. They hold the
pseudonym, never a UUID or a name, and no x/z position (the features never contain one).
Limits: the whole logs folder stays under the cap (default 50 MB; oldest files are deleted first) and files
older than the retention (default 7 days) are deleted. Only a running sidecar enforces these limits: it applies
them when it starts, once a minute while it runs and when it stops, so logs can outlive 7 days while no sidecar
runs. /pne oracle purge reaches here as purge(pid): every file of that pseudonym is deleted, and the caller learns
how many are still there (a file another program holds open cannot be deleted yet; the purge is then retried and
not acknowledged). A failed disk write never raises: append() returns False and says why in last_error.
Python 3.9-compatible syntax.
"""
import glob
import json
import os
import re
import time

PID_RX = re.compile(r"^[0-9a-f]{32}$")
NAME_RX = re.compile(r"^([0-9a-f]{32})-(\d{8})\.ndjson$")


class Logs(object):
    def __init__(self, bridge_dir, cap_bytes=50 * 1024 * 1024, days=7.0, clock=time.time):
        self.dir = os.path.join(bridge_dir, "logs")
        self.cap = int(cap_bytes)
        self.days = float(days)
        self.clock = clock
        self.total = None
        self.skipped = 0
        self.written = 0
        self.failed = 0
        self.last_error = ""
        self.last_maint = 0.0

    def _files(self):
        out = []
        for p in glob.glob(os.path.join(self.dir, "*.ndjson")):
            if NAME_RX.match(os.path.basename(p)):
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                out.append((st.st_mtime, st.st_size, p))
        out.sort()
        return out

    def size(self):
        return sum(f[1] for f in self._files())

    def maintain(self, force=False, need=0, protect=None):
        """Retention and cap, leaving room for `need` more bytes without deleting `protect` (the file about to be
        appended to). Runs at most once a minute unless forced. Returns how many files were deleted."""
        now = self.clock()
        if not force and now - self.last_maint < 60:
            return 0
        self.last_maint = now
        gone = 0
        files = self._files()
        keep = []
        for mtime, size, p in files:
            if now - mtime > self.days * 86400:
                gone += self._rm(p)
            else:
                keep.append((mtime, size, p))
        total = sum(f[1] for f in keep)
        i = 0
        while total + need > self.cap and i < len(keep):
            if protect is None or os.path.normcase(keep[i][2]) != os.path.normcase(protect):
                total -= keep[i][1]
                gone += self._rm(keep[i][2])
            i += 1
        self.total = total
        return gone

    def _rm(self, p):
        try:
            os.remove(p)
            return 1
        except OSError:
            return 0

    def append(self, pid, record):
        """Appends one sample. Returns False when the pid is invalid, the cap leaves no room (last_error 'cap') or
        the disk write failed (last_error 'io: ...'); it never raises."""
        self.last_error = ""
        if not PID_RX.match(str(pid)):
            self.last_error = "pid"
            return False
        line = (json.dumps(record, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
        day = time.strftime("%Y%m%d", time.gmtime(self.clock()))
        path = os.path.join(self.dir, "%s-%s.ndjson" % (pid, day))
        if self.total is None:
            self.maintain(force=True)
        if self.total + len(line) > self.cap:
            if len(line) <= self.cap:
                self.maintain(force=True, need=len(line), protect=path)
            if self.total + len(line) > self.cap:
                self.skipped += 1
                self.last_error = "cap"
                return False
        try:
            os.makedirs(self.dir, exist_ok=True)
            with open(path, "ab") as f:
                f.write(line)
        except OSError as e:
            self.failed += 1
            self.last_error = "io: %s" % e
            self.total = None  # a partial write may have happened: measure again next time
            return False
        self.total += len(line)
        self.written += 1
        return True

    def files_of(self, pid):
        return glob.glob(os.path.join(self.dir, "%s-*.ndjson" % pid)) if PID_RX.match(str(pid)) else []

    def purge(self, pid):
        """Deletes every log file of this pseudonym. Returns (deleted, remaining): remaining counts the files of that
        pseudonym still on disk afterwards (for example one held open by another program), so the caller can keep
        the purge pending instead of acknowledging it."""
        if not PID_RX.match(str(pid)):
            return 0, 0
        n = 0
        for p in self.files_of(pid):
            n += self._rm(p)
        self.total = None
        return n, len(self.files_of(pid))
