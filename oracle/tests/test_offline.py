"""oracle-offline suite: the offline tools moved from the prototypes still work, and the shipped manifest is
exactly what the generator writes.

  - Python 3.9-compatible syntax for every file that runs in the py3.9 worker venv or the supervisor (no match
    statements, no X | Y annotations, no parenthesised context managers, no except*), checked with ast
  - train/make_manifest.py regenerates models/oracle_manifest.json byte for byte (sha256 included)
  - sim/sim.py generates [N, T, 31] telemetry; importing train/train.py writes nothing
  - eval/closed_loop.py runs a small closed loop (all four policies)
  - train/wsl_train_export.py and train/s4b_check.py parse (they run only in WSL at M6)

    python oracle/tests/test_offline.py
"""
import ast
import glob
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import common as C  # noqa: E402

PY39 = ["sidecar.py", "sidecar_lock.py", "sidecar_logs.py", "tpu_worker.py", "backends/__init__.py", "backends/cpu_np.py",
        "backends/cpu_tfl.py", "backends/manifest.py", "backends/pipe_v2.py", "backends/worker_client.py", "train/s4b_check.py"]


def py39_problems(path):
    src = open(path, encoding="utf-8").read()
    out = []
    try:
        tree = ast.parse(src, filename=path, feature_version=(3, 9))
    except SyntaxError as e:
        return ["%s:%s: not Python 3.9 syntax (%s)" % (path, e.lineno, e.msg)]
    for node in ast.walk(tree):
        if type(node).__name__ in ("Match", "TryStar"):
            out.append("%s:%d: %s statement" % (path, node.lineno, type(node).__name__))
        ann = []
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            ann = [a.annotation for a in node.args.args + node.args.kwonlyargs if a.annotation is not None]
            if node.returns is not None:
                ann.append(node.returns)
        elif isinstance(node, ast.AnnAssign):
            ann = [node.annotation]
        for a in ann:
            for sub in ast.walk(a):
                if isinstance(sub, ast.BinOp) and isinstance(sub.op, ast.BitOr):
                    out.append("%s:%d: PEP 604 union in an annotation" % (path, node.lineno))
    return out


def main():
    ck = C.Check("oracle-offline")
    probs = []
    for rel in PY39:
        probs += py39_problems(os.path.join(C.ORACLE, rel))
    ck.ok(not probs, "Python 3.9-compatible syntax in %d runtime files%s" % (len(PY39), (": " + "; ".join(probs)) if probs else ""))
    for rel in ("train/wsl_train_export.py", "train/s4b_check.py", "train/train.py", "train/nn.py", "sim/sim.py", "eval/closed_loop.py", "eval/director_ref.py"):
        try:
            ast.parse(open(os.path.join(C.ORACLE, rel), encoding="utf-8").read())
            ck.ok(True, "%s parses" % rel)
        except SyntaxError as e:
            ck.ok(False, "%s: %s" % (rel, e))

    d = C.tmpdir("manifest")
    shutil.copy(os.path.join(C.MODELS, "oracle_mlp.npz"), os.path.join(d, "oracle_mlp.npz"))
    r = subprocess.run([sys.executable, os.path.join(C.ORACLE, "train", "make_manifest.py"), "--models", d], capture_output=True, text=True, timeout=120)
    same = r.returncode == 0 and open(os.path.join(d, "oracle_manifest.json"), "rb").read() == open(os.path.join(C.MODELS, "oracle_manifest.json"), "rb").read()
    ck.ok(same, "make_manifest.py regenerates the shipped manifest byte for byte" + ("" if same else ": " + r.stdout + r.stderr))
    m = json.load(open(os.path.join(C.MODELS, "oracle_manifest.json")))
    ck.ok(m["backends"]["cpu_np"]["params"] == 34251 and m["backends"]["cpu_tfl"]["sha256"] is None and m["backends"]["edgetpu"]["sha256"] is None,
          "manifest: 34,251 cpu_np parameters; no int8/Edge TPU model before M6")
    sys.path.insert(0, os.path.join(C.ORACLE, "sim"))
    import sim  # noqa: E402
    X, S, K, M, FE, D = sim.generate(3, 40, seed=5)
    ck.ok(X.shape == (3, 40, 31) and S.shape == (3, 40), "sim.generate gives [N, T, 31] telemetry and labels")
    ck.ok(list(sim.FEATURES) == m["feature_names"], "simulator features = manifest features")
    bridge = open(os.path.join(C.ROOT, "overrides", "kubejs", "server_scripts", "pne_oracle_bridge.js"), encoding="utf-8").read()
    ck.ok(all(("'%s'" % f) in bridge for f in m["feature_names"]), "every manifest feature name appears in the bridge's PNE_ORA_FEATURES")
    before = set(os.listdir(os.getcwd()))
    sys.path.insert(0, os.path.join(C.ORACLE, "train"))
    import train  # noqa: E402,F401
    ck.ok(set(os.listdir(os.getcwd())) == before and train.OUT is None, "importing train/train.py writes nothing")
    r = subprocess.run([sys.executable, os.path.join(C.ORACLE, "eval", "closed_loop.py"), "10", "300"], capture_output=True, text=True, timeout=600,
                       env=dict(os.environ, TEMP=C.tmpdir("cl"), TMP=C.tmpdir("cl2")))
    lines = [json.loads(ln) for ln in r.stdout.splitlines() if ln.startswith("{")]
    ck.ok(r.returncode == 0 and [x["policy"] for x in lines] == ["none", "naive", "director", "director_nohyst"],
          "eval/closed_loop.py runs all four policies" + ("" if r.returncode == 0 else ": " + r.stderr[-400:]))
    return ck.done()


if __name__ == "__main__":
    sys.exit(main())
