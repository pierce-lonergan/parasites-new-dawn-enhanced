"""oracle-stale-lock suite: the single-instance lock never trusts a bare PID and never kills anything.

  - a lock naming a LIVE non-sidecar process (right pid, creation time and exe; command line without sidecar.py;
    fresh status with the same nonce) is stale: a new sidecar overwrites it, and that process keeps running
  - a lock whose pid now belongs to another process (creation time differs, even with 'sidecar.py' in its
    command line) is stale
  - a lock naming a pid that no longer exists is stale
  - a matching process with a status.json older than 5 s, or with another nonce, is stale
  - a lock where every rule holds is live: the new instance exits with code 3 and touches nothing
  - a real running sidecar is detected as live the same way; it is stopped only through stop.flag
  - the OS-level guard (sidecar.lock.guard): a second holder is refused while the first holds it
  - two sidecars started 0-100 ms apart on one bridge, 20 times: exactly one runs, the other exits 3, none crashes
  - a running sidecar whose sidecar.lock is taken over by another nonce leaves cooperatively and leaves that lock
Helper processes wait on their stdin and leave by themselves when it is closed; sidecars stop through stop.flag or
--exit-after.

    python oracle/tests/test_lock.py
"""
import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

import sidecar_lock as L  # noqa: E402


def helper(*marker):
    """A live process that is not a sidecar: it waits until its stdin closes, then exits 0 by itself."""
    return subprocess.Popen([sys.executable, "-c", "import sys; sys.stdin.read()"] + list(marker), stdin=subprocess.PIPE)


def release(p):
    try:
        p.stdin.close()
    except OSError:
        pass
    try:
        return p.wait(timeout=10)
    except subprocess.TimeoutExpired:
        return None


def write_lock(bridge, info, nonce, create_time=None, status_age_ms=0, status_nonce=None):
    lock = {"pid": info["pid"], "create_time": info["create_time"] if create_time is None else create_time, "exe_path": info["exe"],
            "cmdline": info["cmdline"], "nonce": nonce}
    with open(os.path.join(bridge, "sidecar.lock"), "w") as f:
        json.dump(lock, f)
    with open(os.path.join(bridge, "status.json"), "w") as f:
        json.dump({"v": 2, "nonce": status_nonce or nonce, "ts_ms": int(time.time() * 1000) - status_age_ms}, f)


def refresh_status(bridge, nonce):
    with open(os.path.join(bridge, "status.json"), "w") as f:
        json.dump({"v": 2, "nonce": nonce, "ts_ms": int(time.time() * 1000)}, f)


def lock_owner(bridge):
    d = C.read_json(os.path.join(bridge, "sidecar.lock"))
    return d.get("pid") if isinstance(d, dict) else None


def main():
    ck = C.Check("oracle-stale-lock")
    if L.process_info(os.getpid()) is None:
        print("SKIP: process queries are not available on this platform")
        return 77

    # 1. live non-sidecar pid: stale, overwritten, the process is left alone
    bridge = C.tmpdir("lock_nonsidecar")
    h = helper()
    time.sleep(0.3)
    info = L.process_info(h.pid)
    ck.ok(info and info["alive"] and "sidecar.py" not in info["cmdline"], "helper is a live process that is not a sidecar")
    write_lock(bridge, info, "a" * 32)
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(not live and "not a sidecar" in why, "a lock naming a live non-sidecar pid is stale (%s)" % why)
    proc = C.start_sidecar(bridge, "--exit-after", "2")
    C.wait_for(lambda: lock_owner(bridge) == proc.pid, 10)
    ck.ok(lock_owner(bridge) == proc.pid, "the new sidecar overwrote the stale lock")
    out = ""
    try:
        out, _ = proc.communicate(timeout=20)
    except subprocess.TimeoutExpired:
        pass
    ck.ok("replaced a stale lock" in out and "no process was touched" in out, "the sidecar says it replaced a stale lock and touched nothing")
    ck.ok(h.poll() is None, "the non-sidecar process is still running after the sidecar ran and exited")
    ck.ok(release(h) == 0, "it leaves by itself when its stdin closes (exit 0): nothing was killed")

    # 2. pid reuse: a process with 'sidecar.py' in its command line but another creation time
    bridge = C.tmpdir("lock_reuse")
    h = helper("sidecar.py")
    time.sleep(0.3)
    info = L.process_info(h.pid)
    ck.ok("sidecar.py" in info["cmdline"], "helper carries sidecar.py in its command line")
    write_lock(bridge, info, "b" * 32, create_time=info["create_time"] - 3600.0)
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(not live and "creation time" in why, "a reused pid (creation time differs) is stale (%s)" % why)

    # 3. every rule holds -> live: a second instance exits 3 and touches nothing
    write_lock(bridge, info, "c" * 32)
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(live, "pid + creation time + exe + 'sidecar.py' + fresh status with the nonce = live (%s)" % why)
    before = open(os.path.join(bridge, "sidecar.lock")).read()
    proc = C.start_sidecar(bridge)
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass
    ck.ok(proc.poll() == 3, "a second instance exits with code 3 when the lock is live (%s)" % proc.poll())
    ck.ok(open(os.path.join(bridge, "sidecar.lock")).read() == before, "the live lock is untouched")
    ck.ok("Nothing was stopped" in C.output(proc), "it says nothing was stopped")
    ck.ok(h.poll() is None, "the lock holder keeps running")

    # 4. status older than 5 s, or another nonce -> stale
    write_lock(bridge, info, "d" * 32, status_age_ms=6000)
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(not live and "old" in why, "a status.json older than 5 s makes the lock stale (%s)" % why)
    write_lock(bridge, info, "e" * 32, status_nonce="f" * 32)
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(not live and "nonce" in why, "a status.json with another nonce makes the lock stale (%s)" % why)
    ck.ok(release(h) == 0, "helper leaves by itself (exit 0)")

    # 5. a pid that no longer exists
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(not live, "the exited helper's lock is stale (%s)" % why)
    with open(os.path.join(bridge, "sidecar.lock"), "w") as f:
        json.dump({"pid": 999999, "create_time": 1.0, "exe_path": sys.executable, "cmdline": "python sidecar.py", "nonce": "g" * 32}, f)
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(not live and ("no process" in why or "exited" in why), "a lock naming a missing pid is stale (%s)" % why)
    with open(os.path.join(bridge, "sidecar.lock"), "w") as f:
        f.write("{torn")
    ck.ok(not L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))[0], "an unreadable lock is stale")

    # 6. a real sidecar is live for a second instance; stop.flag stops it
    bridge = C.tmpdir("lock_real")
    a = C.start_sidecar(bridge)
    ok = C.wait_status(bridge, 15) is not None and C.wait_for(lambda: lock_owner(bridge) == a.pid, 5)
    ck.ok(ok, "sidecar A runs and holds the lock")
    live, why = L.assess(os.path.join(bridge, "sidecar.lock"), os.path.join(bridge, "status.json"))
    ck.ok(live, "A's lock is live (%s)" % why)
    b = C.start_sidecar(bridge)
    try:
        b.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass
    ck.ok(b.poll() == 3 and a.poll() is None, "sidecar B exits with code 3; A keeps running")
    C.output(b)
    ck.ok(C.stop_sidecar(bridge, a) == 0, "A stops through stop.flag (exit 0)")
    ck.ok(not os.path.exists(os.path.join(bridge, "sidecar.lock")), "A removed its lock")
    C.output(a)

    guard_unit(ck)
    concurrent_starts(ck)
    lock_taken(ck)
    return ck.done()


def guard_unit(ck):
    path = os.path.join(C.tmpdir("guard"), L.GUARD_NAME)
    g1, g2 = L.Guard(path), L.Guard(path)
    ck.ok(g1.acquire() and not g2.acquire(0.1), "a second holder of sidecar.lock.guard is refused while the first holds it")
    g1.release()
    ck.ok(g2.acquire(), "released: the guard can be taken again")
    g2.release()


def concurrent_starts(ck, trials=20, batch=5):
    """Two sidecars on one bridge, the second started 0, 25, 50, 75 or 100 ms after the first. The old
    check-then-write lock let both run in 3 of 20 such trials and could crash one on a shared tmp name (exit 1)."""
    bad = []
    both = 0
    for b0 in range(0, trials, batch):
        sched = []
        for k in range(b0, min(trials, b0 + batch)):
            bridge = C.tmpdir("race%02d" % k)
            a = C.start_sidecar(bridge, "--exit-after", "2.5", "--quiet")
            sched.append((time.time() + (k % 5) * 0.025, k, bridge, a))
        pairs = []
        for when, k, bridge, a in sorted(sched, key=lambda x: x[0]):
            d = when - time.time()
            if d > 0:
                time.sleep(d)
            pairs.append((k, a, C.start_sidecar(bridge, "--exit-after", "2.5", "--quiet")))
        for k, a, b in pairs:
            for p in (a, b):
                try:
                    p.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    pass
            codes = sorted([a.poll(), b.poll()], key=lambda c: -1 if c is None else c)
            if codes == [0, 0]:
                both += 1
            if codes != [0, 3]:
                bad.append("trial %d offset %d ms: exit codes %s %s" % (k, (k % 5) * 25, codes, C.output(a)[-200:] + C.output(b)[-200:]))
            else:
                C.output(a)
                C.output(b)
    ck.ok(not bad, "%d concurrent starts, 0-100 ms apart: always exactly one sidecar ran and the other exited 3 (both ran %d times; %s)" %
          (trials, both, "; ".join(bad[:3]) or "no crash"))


def lock_taken(ck):
    bridge = C.tmpdir("lock_taken")
    a = C.start_sidecar(bridge)
    ok = C.wait_status(bridge, 15) is not None
    foreign = {"pid": 1, "create_time": 1.0, "exe_path": "x", "cmdline": "python sidecar.py", "nonce": "f" * 32}
    tmp = os.path.join(bridge, "foreign.tmp")
    with open(tmp, "w") as f:
        json.dump(foreign, f)
    end = time.time() + 2
    while True:
        try:
            os.replace(tmp, os.path.join(bridge, "sidecar.lock"))
            break
        except PermissionError:
            if time.time() > end:
                raise
            time.sleep(0.01)
    t0 = time.time()
    try:
        a.wait(timeout=6)
    except subprocess.TimeoutExpired:
        pass
    st = C.read_json(os.path.join(bridge, "status.json")) or {}
    ck.ok(ok and a.poll() == 0 and time.time() - t0 < 3 and st.get("stop_reason") == "lock taken by another instance",
          "a sidecar whose sidecar.lock is taken over by another nonce leaves cooperatively within the next heartbeat (%s, %s)" % (a.poll(), st.get("stop_reason")))
    ck.ok(C.read_json(os.path.join(bridge, "sidecar.lock")) == foreign, "it leaves the other instance's lock untouched")
    C.output(a)


if __name__ == "__main__":
    sys.exit(main())
