"""
I10 guard: nothing in the repo's code may kill a process. The Oracle sidecar stops only through stop.flag (or its own
console), and its TPU worker only through its pipe (EXIT frame, then stdin closed). The user runs unrelated automation
on python.exe, so a kill by PID or by name could hit it.

1. Explicit kill call forms, everywhere under oracle/** and tools/** (.py .cmd .bat .ps1 .psm1 .js .sh):
     taskkill /..., Stop-Process -..., os.kill(, os.killpg(, <x>.terminate(), <x>.kill(), TerminateProcess(,
     pkill <...>, killall <...>, signal.SIGKILL, psutil ... .kill( / .terminate(
   Mentions in prose (for example "never calls taskkill") are fine; call forms are not.
2. Implicit kills: subprocess.run / call / check_call / check_output with timeout= end their child with Popen.kill()
   when the timeout expires. Contract I10 (docs/IMPLEMENTATION.md Appendix A rule 12) allows exactly one case: a test
   harness or local tool may let a child process IT STARTED ITSELF be ended through that child's own handle when the
   child exceeds its timeout; never any other process, never by PID or name, and a sidecar child gets stop.flag first.
   Such calls are accepted only in the files listed in TIMEOUT_OK (each one a harness or tool whose children are its
   own node/java/python/ffmpeg/cmd runs); anywhere else they fail, so a new use is a deliberate, reviewed addition.
   Popen(...).communicate(timeout=) / wait(timeout=) only raise TimeoutExpired and are fine (a kill after them is
   caught by rule 1).

Usage: python tools/ci/no_kill.py [ROOT]      Exit 1 on any hit.
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
EXTS = (".py", ".cmd", ".bat", ".ps1", ".psm1", ".js", ".sh")
SCAN = ("oracle", "tools")
SELF = "tools/ci/no_kill.py"          # holds the patterns themselves
PATTERNS = [
    (re.compile(r"\btaskkill(\.exe)?\s+/", re.I), "taskkill"),
    (re.compile(r"\bStop-Process\s+-", re.I), "Stop-Process"),
    (re.compile(r"\bos\s*\.\s*kill(pg)?\s*\("), "os.kill"),
    (re.compile(r"\.\s*terminate\s*\(\s*\)"), ".terminate()"),
    (re.compile(r"\.\s*kill\s*\(\s*\)"), ".kill()"),
    (re.compile(r"\bTerminateProcess\s*\("), "TerminateProcess"),
    (re.compile(r"\b(pkill|killall)\s+\S"), "pkill/killall"),
    (re.compile(r"\bSIGKILL\b"), "SIGKILL"),
]
SUBPROCESS_CALL = re.compile(r"\bsubprocess\s*\.\s*(run|call|check_call|check_output)\s*\(")
TIMEOUT_KW = re.compile(r"\btimeout\s*=")
# Harness and local-tool files whose subprocess calls with timeout= end only their own child on expiry (I10 exception).
TIMEOUT_OK = {
    "tools/run_tests.py": "the test runner: each suite is its own child",
    "tools/rhino/pne_rhino.py": "javac -version and the Rhino harness JVM it starts",
    "tools/genome/rhino/run.py": "node runs of the GA core tests",
    "tools/hive/run_hive.py": "node, Rhino and NbtSizeTest JVM runs",
    "tools/director/parity.py": "node run of the JS director for the parity check",
    "tools/oracle/run_js_tests.py": "node and Rhino runs of the bridge tests",
    "tools/visual/kjs_renames.py": "the RemapForJS probe JVM",
    "tools/resonance/declip_local.py": "ffmpeg decode of one sound (local install tool)",
    "tools/resonance/tests/test_declip.py": "runs declip_local.py",
    "tools/resonance/tests/test_determinism.py": "a second render.py run",
    "tools/resonance/tests/test_gates.py": "a child python run",
    "oracle/tests/test_check_overrides.py": "runs check_overrides.py",
    "oracle/tests/test_offline.py": "make_manifest.py and closed_loop.py runs",
    "oracle/tests/test_worker.py": "tpu_worker.py --bench (not the sidecar)",
    "oracle/tests/test_sidecar.py": "launch_oracle.cmd --exit-after 2 and stop_oracle.cmd (the launcher's cmd.exe; the "
                                    "sidecar itself stops through --exit-after / stop.flag)",
}


def files(root):
    out = []
    for sub in SCAN:
        out += glob.glob(os.path.join(root, sub, "**", "*"), recursive=True)
    return sorted(p for p in set(out) if os.path.isfile(p) and p.lower().endswith(EXTS) and "__pycache__" not in p)


def call_args(text, start):
    """The text between the '(' ending at start and its matching ')', skipping strings."""
    i = start
    depth = 1
    q = ""
    while i < len(text) and depth > 0:
        c = text[i]
        if q:
            if c == "\\":
                i += 2
                continue
            if c == q:
                q = ""
        elif c in "'\"":
            q = c
        elif c == "(":
            depth += 1
        elif c == ")":
            depth -= 1
        i += 1
    return text[start:i]


def scan(root):
    hits = []
    for p in files(root):
        rel = os.path.relpath(p, root).replace(os.sep, "/")
        if rel == SELF:
            continue
        try:
            text = open(p, encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for ln, line in enumerate(text.splitlines(), 1):
            for rx, what in PATTERNS:
                if rx.search(line):
                    hits.append(f"{rel}:{ln}: {what} (I10: never kill a process; use stop.flag / the worker pipe)")
        if rel.endswith(".py") and rel not in TIMEOUT_OK:
            for m in SUBPROCESS_CALL.finditer(text):
                if TIMEOUT_KW.search(call_args(text, m.end())):
                    ln = text.count("\n", 0, m.start()) + 1
                    hits.append(f"{rel}:{ln}: subprocess.{m.group(1)}(..., timeout=...) kills its child when the timeout "
                                f"expires (I10); use Popen + communicate(timeout=) and report instead, or add the file to "
                                f"TIMEOUT_OK if it is a harness ending only its own child")
    return hits


def main(argv):
    root = argv[1] if len(argv) > 1 else ROOT
    hits = scan(root)
    stale = [f for f in TIMEOUT_OK if not os.path.isfile(os.path.join(root, f))]
    for h in hits:
        print("  FAIL  " + h)
    for f in stale:
        print("  note  TIMEOUT_OK lists %s, which does not exist" % f)
    print(f"no_kill: {len(files(root))} file(s) under {', '.join(s + '/' for s in SCAN)}, {len(hits)} problem(s); "
          f"{len(TIMEOUT_OK)} harness file(s) may end their own children on timeout (I10 exception)")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
