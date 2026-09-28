"""oracle-check-overrides suite: tools/ci/check_overrides.py passes on the repo and catches every forbidden path
in a scratch copy (files are created under %TEMP% only).

    python oracle/tests/test_check_overrides.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

CHECK = os.path.join(C.ROOT, "tools", "ci", "check_overrides.py")


def run(target=None):
    cmd = [sys.executable, CHECK] + ([target] if target else [])
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout


def main():
    ck = C.Check("oracle-check-overrides")
    code, out = run()
    ck.ok(code == 0, "the repo's overrides/ are clean:\n" + out)
    ck.ok(os.path.isfile(os.path.join(C.ROOT, "overrides", "local", "pne_oracle", ".keep")), "overrides/local/pne_oracle/.keep ships (JsonIO never creates folders)")
    base = os.path.join(C.tmpdir("ovr"), "overrides")
    bad = ["local/pne_oracle/telemetry.json", "local/pne_oracle/verdict.json", "local/pne_oracle/status.json", "local/pne_oracle/sidecar.lock",
           "local/pne_oracle/logs/0123456789abcdef0123456789abcdef-20260927.ndjson", "local/pne_oracle/worlds/abc/world.json",
           "local/pne_oracle/stop.flag", "config/somewhere/status.json", "kubejs/data/x.ndjson", "config/elsewhere/sidecar.lock.guard"]
    for rel in bad + ["local/pne_oracle/.keep", "kubejs/server_scripts/ok.js"]:
        p = os.path.join(base, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w").close()
    code, out = run(base)
    ck.ok(code == 1, "a dirty overrides tree fails")
    for rel in bad:
        key = rel if not rel.startswith("local/pne_oracle/worlds") else "local/pne_oracle/worlds/"
        ck.ok(("overrides/" + key) in out, "caught: overrides/%s" % key)
    ck.ok("ok.js" not in out and "/.keep:" not in out, "the placeholder and ordinary files pass")
    clean = os.path.join(C.tmpdir("ovr_clean"), "overrides")
    os.makedirs(os.path.join(clean, "local", "pne_oracle"))
    open(os.path.join(clean, "local", "pne_oracle", ".keep"), "w").close()
    ck.ok(run(clean)[0] == 0, "a tree with only .keep passes")
    return ck.done()


if __name__ == "__main__":
    sys.exit(main())
