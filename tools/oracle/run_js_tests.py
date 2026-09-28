"""Runs an Oracle KubeJS test file in Node (tools/tests/kjs_node.js) AND in the instance's real Rhino jar
(tools/rhino/pne_rhino.py run), with the same file list, and passes only when both print PASS.

    python tools/oracle/run_js_tests.py bridge      tools/oracle/test_bridge.js   (result pneOraBridgeResult)
    python tools/oracle/run_js_tests.py features    tools/oracle/test_features.js (result pneOraFeatResult)
Rhino matters here: JsonIO hands the bridge java.util.Map / List values with java.lang.Double and String inside,
and Node can only imitate that. Exit 77 (skip) when Node or the Rhino toolchain is missing.
"""
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import pne_rhino  # noqa: E402

BASE = ["tools/tests/kjs_mocks.js", "tools/oracle/ora_mocks.js", "overrides/kubejs/server_scripts/pne_00_core.js",
        "overrides/kubejs/server_scripts/pne_oracle_bridge.js"]
SETS = {
    "bridge": ("pneOraBridgeResult", BASE + ["tools/oracle/test_bridge.js"]),
    "features": ("pneOraFeatResult", BASE + ["tools/oracle/ref/features_proto.js", "tools/oracle/fixtures/raw_trace.js", "tools/oracle/test_features.js"]),
}


def last_line(out):
    lines = [ln for ln in out.splitlines() if ln.strip()]
    return lines[-1].strip() if lines else ""


def main(argv):
    which = argv[1] if len(argv) > 1 else "bridge"
    expr, files = SETS[which]
    node = shutil.which("node")
    e = pne_rhino.env()
    if not node or not pne_rhino.ready(e):
        print("SKIP: Node or the Rhino toolchain is missing")
        return 77
    res = {}
    r = subprocess.run([node, "tools/tests/kjs_node.js", expr] + files, cwd=ROOT, capture_output=True, text=True, timeout=600)
    res["node"] = r.stdout.splitlines()[0].strip() if r.stdout.strip() else "FAIL no output " + r.stderr[-300:]
    r = subprocess.run([sys.executable, "tools/rhino/pne_rhino.py", "run", expr] + files, cwd=ROOT, capture_output=True, text=True, timeout=600)
    res["rhino"] = last_line(r.stdout) or "FAIL no output " + r.stderr[-300:]
    for k in ("node", "rhino"):
        print("%-5s %s" % (k, res[k][:3000]))
    ok = all(v.startswith("PASS") for v in res.values())
    print(("PASS" if ok else "FAIL") + " oracle %s tests in Node and real Rhino" % which)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
