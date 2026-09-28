"""oracle-bridge-e2e: the real pne_oracle_bridge.js (instance Rhino jar, class filter, remapper, a JsonIO stand-in that
copies KubeJS's: telemetry.json is truncated and rewritten in place, never deleted) against the real sidecar through
real files under %TEMP%.

  - 20/20: every slot-10 read in 21 s of real-time ticks after the first write finds a fresh verdict, although every
    second telemetry write stops halfway for 60 ms (the sidecar sees those partial files as torn reads and retries)
  - the verdict goes stale after the sidecar is stopped with stop.flag (never by PID)
  - the sidecar logged only the player who opted in; files carry pseudonyms only
Exit 77 (skip) without JDK 17 / the Rhino jar.

    python tools/oracle/run_e2e.py
"""
import glob
import json
import os
import re
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import pne_rhino  # noqa: E402

FILES = ["tools/tests/kjs_mocks.js", "tools/oracle/ora_mocks.js", "overrides/kubejs/server_scripts/pne_00_core.js",
         "overrides/kubejs/server_scripts/pne_oracle_bridge.js", "tools/oracle/e2e_driver.js"]


def main():
    e = pne_rhino.env()
    if not pne_rhino.ready(e):
        print("SKIP: JDK 17 or the instance's Rhino jar was not found")
        return 77
    base = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
    os.makedirs(base, exist_ok=True)
    game = tempfile.mkdtemp(prefix="oracle_e2e_", dir=base)
    bridge = os.path.join(game, "local", "pne_oracle")
    os.makedirs(bridge)
    cls = pne_rhino.build(e, [os.path.join(ROOT, "tools", "rhino", "PneRhino.java"), os.path.join(HERE, "BridgeE2E.java")], "orae2e")
    side = subprocess.Popen([sys.executable, os.path.join(ROOT, "oracle", "sidecar.py"), "--bridge", bridge, "--exit-after", "120"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, text=True)
    fails = []
    t0 = time.time()
    while time.time() - t0 < 15 and not os.path.exists(os.path.join(bridge, "status.json")):
        time.sleep(0.05)
    r = pne_rhino.run_java(e, cls, "BridgeE2E", [game, "50", "21", "5", "60"] + [os.path.join(ROOT, f) for f in FILES], timeout=300)
    out = r.stdout + r.stderr
    sys.stdout.write(out)
    try:
        side.wait(timeout=15)
    except subprocess.TimeoutExpired:
        fails.append("the sidecar did not exit after stop.flag (left to its --exit-after safety net; nothing is killed)")
    sout = side.stdout.read() if side.poll() is not None else ""
    kv = {}
    for m in re.finditer(r"(\w+)=(\S+)", out):
        kv[m.group(1)] = m.group(2)

    def need(cond, msg):
        if not cond:
            fails.append(msg)
        print(("  ok    " if cond else "  FAIL  ") + msg)

    need(r.returncode == 0 and "FAIL" not in r.stdout, "the Rhino harness ran without a script error")
    need(kv.get("remapper") == "minecraft", "the game's remapper was active")
    reads, fresh = int(kv.get("reads_while_running", 0)), int(kv.get("fresh_reads", 0))
    need(reads == 21 and fresh >= 20, "20/20: every read after the first write saw a fresh verdict (%d fresh of %d reads)" % (fresh, reads))
    need(int(kv.get("rOk", 0)) >= 20 and int(kv.get("wFail", 1)) == 0, "the bridge accepted >= 20 verdicts and every write worked (rOk %s, wFail %s)" % (kv.get("rOk"), kv.get("wFail")))
    need(kv.get("backendA") == "cpu_np" and kv.get("fillA") == "16", "Ann's verdict came from cpu_np with a full 16-step window")
    need(kv.get("verdictB") == "true", "Bob has a verdict too")
    stale = int(kv.get("stale_after_ticks", -1))
    need(0 < stale <= 90, "after stop.flag the verdict went stale within 90 ticks (%d)" % stale)
    need(side.poll() == 0, "the sidecar exited by itself with code 0 after stop.flag (%s)" % side.poll())
    need(kv.get("breakers") == "0/0", "no bridge handler failed (%s)" % kv.get("breakers"))
    st = json.load(open(os.path.join(bridge, "status.json")))
    need(st.get("stop_reason") == "stop.flag" and not os.path.exists(os.path.join(bridge, "stop.flag")), "status says stopped by stop.flag; the flag was removed")
    need(int(kv.get("slow_writes", 0)) >= 10 and st.get("reads", {}).get("torn", 0) >= 1 and st.get("reads", {}).get("missing", 0) == 0,
         "slow in-place writes (%s) were seen as torn reads (%s) and retried; telemetry.json never went missing (%s)" %
         (kv.get("slow_writes"), st.get("reads", {}).get("torn"), st.get("reads", {}).get("missing")))
    logs = glob.glob(os.path.join(bridge, "logs", "*.ndjson"))
    pa, pb = kv.get("pidA", "?"), kv.get("pidB", "?")
    need(len(logs) == 1 and os.path.basename(logs[0]).startswith(pa), "only the opted-in player was logged (%s)" % [os.path.basename(x) for x in logs])
    def text(name):
        try:
            return open(os.path.join(bridge, name), encoding="utf-8").read()
        except OSError:
            return ""
    tel, ver = text("telemetry.json"), text("verdict.json")
    need("11111111-0000" not in tel + ver and "Ann" not in tel + ver and pa in tel and pb in ver, "bridge files carry pseudonyms only")
    need("\t" in tel and '"v": 2,' in tel and ".0" in tel,
         "telemetry.json was written like KubeJS JsonIO (tab indent; integral map values as longs, list numbers as doubles)")
    if fails:
        print(sout[-1500:])
        print("FAIL oracle-bridge-e2e: %d problem(s)" % len(fails))
        return 1
    print("PASS oracle-bridge-e2e: real bridge <-> real sidecar, %d fresh reads, stale %d ticks after stop.flag, %s torn sidecar reads" %
          (fresh, stale, st.get("reads", {}).get("torn")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
