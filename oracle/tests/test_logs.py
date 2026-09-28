"""oracle-logs suite: telemetry logging is per-player opt-in and purgeable (TDD 4.4.2, I11).

  - only players whose entry says log: true get a file; the others leave no trace on disk
  - a log line carries the pseudonym, the features and the model output, never a UUID, name or position
  - telemetry purge: [pid] deletes that pseudonym's files; status.json and verdict.json list it in purged, but only
    once the files are really gone: a file held open by another program keeps the purge pending (PURGE_PENDING,
    retried every telemetry second, never acknowledged early)
  - the folder stays under the size cap (oldest files first) and files past the retention are deleted
  - a disk error while logging returns False (LOG_WRITE) instead of raising

    python oracle/tests/test_logs.py
"""
import glob
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

import sidecar_logs  # noqa: E402
from test_sidecar import entries  # noqa: E402

PID_ON = C.pid_hex(1)
PID_OFF = C.pid_hex(2)


def players(sec, tick, log_on=True):
    ps = entries(sec, tick, pids=[PID_ON, PID_OFF])
    ps[0]["log"] = log_on
    ps[1]["log"] = False
    return ps


def test_process(ck):
    bridge = C.tmpdir("logs")
    proc = C.start_sidecar(bridge)
    C.wait_status(bridge, 15)
    kube = C.FakeKube(bridge)
    for k in range(5):
        kube.tick += 20
        kube.write(players(k, kube.tick))
        C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
    files = sorted(glob.glob(os.path.join(bridge, "logs", "*.ndjson")))
    ck.ok(len(files) == 1 and os.path.basename(files[0]).startswith(PID_ON + "-"), "only the opted-in player has a log file (%s)" % [os.path.basename(f) for f in files])
    lines = open(files[0], encoding="utf-8").read().splitlines() if files else []
    ck.ok(len(lines) == 5, "one line per accepted second (%d)" % len(lines))
    rec = json.loads(lines[-1]) if lines else {}
    ck.ok(rec.get("pid") == PID_ON and len(rec.get("f", [])) == 31 and rec.get("out", {}).get("backend") == "cpu_np" and len(rec["out"]["arousal"]) == 4,
          "a line holds the pseudonym, 31 features and the model output")
    text = "\n".join(lines).lower()
    ck.ok(all(k not in rec for k in ("uuid", "name", "x", "z", "player")) and "uuid" not in text, "no UUID, name or position in the log")
    ck.ok(not glob.glob(os.path.join(bridge, "logs", PID_OFF + "*")), "nothing on disk for the player who did not opt in")

    # the player switches logging off: no more lines
    kube.tick += 20
    kube.write(players(5, kube.tick, log_on=False))
    C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
    ck.ok(len(open(files[0], encoding="utf-8").read().splitlines()) == 5, "log off: no new lines")

    # purge hand-shake, first with the log file held open by another program (an editor, an indexer)
    held = open(files[0], "rb") if os.name == "nt" else None  # Python's open() does not share delete access
    kube.tick += 20
    kube.write(players(6, kube.tick, log_on=False)[1:], purge=[PID_ON])
    C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
    if held is not None:
        st = C.wait_status(bridge, 3, lambda s: any(e.startswith("PURGE_PENDING") for e in s["errors"]))
        ck.ok(st is not None and PID_ON not in st.get("purged", []) and PID_ON not in (C.read_json(kube.ver) or {}).get("purged", []) and
              st.get("purge_pending") == 1 and os.path.exists(files[0]),
              "while a log file is held open the purge stays pending: PURGE_PENDING, and NOT listed in purged")
        held.close()
        kube.tick += 20
        kube.write(players(6, kube.tick, log_on=False)[1:], purge=[PID_ON])  # KubeJS repeats it until acknowledged
    ok = C.wait_for(lambda: not glob.glob(os.path.join(bridge, "logs", PID_ON + "*")), 3)
    ck.ok(ok, "purge deletes the pseudonym's log files")
    st = C.wait_status(bridge, 3, lambda s: PID_ON in s.get("purged", []))
    ck.ok(st is not None, "status.json lists the pid in purged")
    kube.tick += 20
    kube.write(players(7, kube.tick, log_on=False)[1:], purge=[PID_ON])
    C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
    ck.ok(PID_ON in (C.read_json(kube.ver) or {}).get("purged", []), "verdict.json lists it too")
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stopped")
    C.output(proc)

    # a tiny cap at the process level: LOG_CAP reported, nothing written past the cap
    bridge = C.tmpdir("logcap")
    proc = C.start_sidecar(bridge, "--log-cap-mb", "0.002")
    C.wait_status(bridge, 15)
    kube = C.FakeKube(bridge)
    for k in range(6):
        kube.tick += 20
        kube.write(players(k, kube.tick))
        C.wait_for(lambda: (C.read_json(kube.ver) or {}).get("seq") == kube.seq, 3)
    size = sum(os.path.getsize(p) for p in glob.glob(os.path.join(bridge, "logs", "*.ndjson")))
    ck.ok(size <= 0.002 * 1024 * 1024, "the logs folder stays under the cap (%d bytes)" % size)
    st = C.wait_status(bridge, 3, lambda s: any(e.startswith("LOG_CAP") for e in s["errors"]))
    ck.ok(st is not None and st["logs"]["skipped"] >= 1, "LOG_CAP reported when a sample does not fit")
    ck.ok(C.stop_sidecar(bridge, proc) == 0, "stopped")
    C.output(proc)


def test_class(ck):
    d = C.tmpdir("logclass")
    now = [time.time()]
    logs = sidecar_logs.Logs(d, cap_bytes=4000, days=7, clock=lambda: now[0])
    rec = {"pad": "x" * 300}
    ck.ok(not logs.append("not-a-pid", rec), "an invalid pid is refused")
    for k in range(5):
        ck.ok(logs.append(C.pid_hex(10 + k), rec), "append %d" % k) if k == 0 else logs.append(C.pid_hex(10 + k), rec)
    old = os.path.join(d, "logs", "%s-20000101.ndjson" % C.pid_hex(99))
    with open(old, "w") as f:
        f.write("{}\n")
    os.utime(old, (now[0] - 8 * 86400, now[0] - 8 * 86400))
    ck.ok(logs.maintain(force=True) == 1 and not os.path.exists(old), "files older than 7 days are deleted")
    for k in range(20):
        now[0] += 1
        logs.append(C.pid_hex(20 + k), rec)
        f = glob.glob(os.path.join(d, "logs", "%s-*.ndjson" % C.pid_hex(20 + k)))
        if f:
            os.utime(f[0], (now[0], now[0]))
    ck.ok(logs.size() <= 4000, "the cap holds (%d bytes)" % logs.size())
    ck.ok(glob.glob(os.path.join(d, "logs", "%s-*" % C.pid_hex(39))) and not glob.glob(os.path.join(d, "logs", "%s-*" % C.pid_hex(10))),
          "the oldest files went first, the newest stayed")
    big = sidecar_logs.Logs(C.tmpdir("logbig"), cap_bytes=100)
    ck.ok(not big.append(C.pid_hex(1), {"pad": "y" * 500}) and big.skipped == 1, "a sample bigger than the cap is skipped, not written")
    ck.ok(logs.purge(C.pid_hex(39)) == (1, 0) and not glob.glob(os.path.join(d, "logs", "%s-*" % C.pid_hex(39))),
          "purge(pid) deletes that pseudonym's files and reports none remaining")
    ck.ok(logs.purge("../../etc") == (0, 0), "purge refuses anything but a pseudonym")
    bad = C.tmpdir("logio")
    open(os.path.join(bad, "logs"), "w").close()  # 'logs' is a file: the folder cannot be created
    lg = sidecar_logs.Logs(bad)
    ok = lg.append(C.pid_hex(5), {"a": 1})
    ck.ok(ok is False and lg.last_error.startswith("io") and lg.failed == 1, "a disk error while logging returns False, no exception (%s)" % lg.last_error)


def test_purge_pending(ck):
    """White box: Logs.purge reports what is left, and the supervisor acknowledges only a complete purge."""
    d = C.tmpdir("purgepend")
    pid = C.pid_hex(77)
    s = C.supervisor(d)
    logs = s.logs
    ck.ok(logs.append(pid, {"a": 1}) and len(logs.files_of(pid)) == 1, "one line logged")
    path = logs.files_of(pid)[0]
    if os.name == "nt":
        held = open(path, "rb")  # no FILE_SHARE_DELETE: os.remove fails like with an editor or indexer holding it
        release = held.close
    else:
        orig = logs._rm
        logs._rm = lambda p: 0
        release = lambda: setattr(logs, "_rm", orig)  # noqa: E731
    ck.ok(logs.purge(pid) == (0, 1), "a log file held open is not deleted and is reported as remaining")
    s.do_purge([pid])
    st = s.status()
    ck.ok(pid not in s.purged and pid not in st["purged"] and st["purge_pending"] == 1 and any(e.startswith("PURGE_PENDING") for e in s.errors),
          "the supervisor does not acknowledge it: PURGE_PENDING, not in purged")
    s.do_purge([pid])
    ck.ok(pid not in s.purged and os.path.exists(path), "retried with the next telemetry second; still pending while held")
    release()
    s.do_purge([pid])
    st = s.status()
    ck.ok(pid in s.purged and pid in st["purged"] and not os.path.exists(path) and st["purge_pending"] == 0,
          "once the file is released the retry deletes it, and only then is the pid acknowledged")
    s.do_purge([pid])
    ck.ok(pid in s.purged, "an acknowledged pid stays acknowledged while KubeJS still lists it")


def main():
    ck = C.Check("oracle-logs")
    for fn in (test_class, test_purge_pending, test_process):
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
