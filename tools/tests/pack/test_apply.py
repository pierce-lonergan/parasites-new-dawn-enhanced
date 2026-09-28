"""
Suite pack-apply: the Hive Remembers install steps of tools/apply.py, against a throw-away instance in PNE_TMP (never
the real instance).

  1. step 7 copies exactly the sidecar program files into <instance>/local/pne_oracle/ (sidecar, lock, logs, worker,
     launch/stop scripts, backends/*.py, the manifest and the model), never tests/, sim/, train/, eval/, tools/ or
     __pycache__, and leaves what the sidecar owns there untouched (logs/, worlds/, telemetry.json, verdict.json,
     status.json, sidecar.lock, sidecar.lock.guard, stop.flag);
  2. while a sidecar holds its guard lock (sidecar.lock.guard, taken here with oracle/sidecar_lock.Guard exactly as the
     sidecar takes it), step 7 copies nothing and says to run stop_oracle.cmd first; once released, it copies again;
  3. step 8 runs tools/visual/etf_variants_local.py for the instance; with no EPCA/Spore jar it writes nothing and
     does not fail the install.
No process is started, stopped or signalled. Prints PASS on success.
"""
import contextlib
import io
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "oracle"))
import apply  # noqa: E402
import sidecar_lock  # noqa: E402


def run(fn, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn(*args)
    return buf.getvalue()


def main():
    fails = []
    base = os.path.join(os.environ.get("PNE_TMP") or tempfile.gettempdir(), "pne_apply_test")
    shutil.rmtree(base, ignore_errors=True)
    inst = os.path.join(base, "instance")
    bridge = os.path.join(inst, "local", "pne_oracle")
    os.makedirs(os.path.join(inst, "mods"))
    os.makedirs(os.path.join(bridge, "logs"))
    owned = {"logs/abc-20260927.ndjson": "{}\n", "telemetry.json": '{"seq": 7}', "verdict.json": '{"seq": 6}',
             "status.json": '{"ok": 1}', "sidecar.lock": '{"pid": 1}', "stop.flag": ""}
    for rel, text in owned.items():
        with open(os.path.join(bridge, *rel.split("/")), "w", encoding="utf-8") as f:
            f.write(text)

    out = run(apply.install_oracle, inst)
    want = [rel for _, rel in apply.oracle_files()]
    for rel in want:
        if not os.path.isfile(os.path.join(bridge, *rel.split("/"))):
            fails.append("sidecar file not installed: " + rel)
    for d in ("tests", "sim", "train", "eval", "tools", "__pycache__", os.path.join("backends", "__pycache__")):
        if os.path.exists(os.path.join(bridge, d)):
            fails.append("copied a repo-only folder: " + d)
    for rel, text in owned.items():
        p = os.path.join(bridge, *rel.split("/"))
        if not os.path.isfile(p) or open(p, encoding="utf-8").read() != text:
            fails.append("changed a file the sidecar owns: " + rel)
    if "copied %d sidecar files" % len(want) not in out:
        fails.append("unexpected step 7 output: " + out.strip())
    for must in ("sidecar.py", "launch_oracle.cmd", "stop_oracle.cmd", "models/oracle_mlp.npz", "backends/cpu_np.py"):
        if must not in want:
            fails.append("the install list lacks " + must)

    # a running sidecar holds sidecar.lock.guard: nothing is copied
    os.remove(os.path.join(bridge, "sidecar.py"))
    guard = sidecar_lock.Guard(os.path.join(bridge, "sidecar.lock.guard"))
    if not guard.acquire(1.0):
        fails.append("could not take the test guard lock: " + guard.why)
    else:
        out = run(apply.install_oracle, inst)
        if os.path.exists(os.path.join(bridge, "sidecar.py")) or "stop_oracle.cmd" not in out:
            fails.append("files were copied while a sidecar held its guard (output: %s)" % out.strip())
        guard.release()
        out = run(apply.install_oracle, inst)
        if not os.path.exists(os.path.join(bridge, "sidecar.py")):
            fails.append("after the guard was released the files were still not copied (output: %s)" % out.strip())

    out = run(apply.install_etf, inst)
    if os.path.exists(os.path.join(inst, "kubejs")) and os.listdir(os.path.join(inst, "kubejs")):
        fails.append("step 8 wrote files although the instance has no EPCA/Spore jar")
    if "not written" in out:
        fails.append("step 8 failed without jars: " + out.strip())

    shutil.rmtree(base, ignore_errors=True)
    if fails:
        for f in fails:
            print("  FAIL " + f)
        print("FAIL pack-apply: %d problem(s)" % len(fails))
        return 1
    print("PASS pack-apply: %d sidecar files installed, repo-only folders and sidecar-owned files untouched, nothing copied while "
          "a sidecar holds its guard, ETF step harmless without jars" % len(want))
    return 0


if __name__ == "__main__":
    sys.exit(main())
