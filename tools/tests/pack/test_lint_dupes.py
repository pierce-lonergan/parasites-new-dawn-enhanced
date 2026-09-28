"""
Suite pack-lint-duplicates: tools/ci/kjs_lint.py catches duplicate top-level names across one script pack.

Every file of a script folder shares ONE scope in KubeJS (contract F1), so a top-level var or function that two
files define silently replaces the first one. This checks, against the real pack:
  1. the repo's scripts have no such duplicate (the linted pack is clean);
  2. a new server script that redefines a core name (pneCoreTick), a legacy name (pneHStage, pne_horror.js) and
     another module's API (pneResTell) is reported three times, with both files named;
  3. the same names in a new STARTUP script are not reported (startup scripts are their own scope);
  4. a name declared inside a block of the new file (a handler body) is not a top-level name;
  5. a draft copy of a module linted in place of the repo file does not collide with that repo file itself.
The drafts live in PNE_TMP (never in the repo). Prints PASS on success.
"""
import glob
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.join(ROOT, "tools", "ci"))
import kjs_lint  # noqa: E402


def main():
    fails = []
    every = sorted(glob.glob(os.path.join(kjs_lint.KJS, "**", "*.js"), recursive=True))
    dupes = [e for e in kjs_lint.lint(every, every) if "is also defined in" in e]
    if dupes:
        fails.append("the pack itself has duplicate top-level names: " + "; ".join(dupes[:5]))

    tmp = os.path.join(os.environ.get("PNE_TMP") or tempfile.gettempdir(), "pne_lint_dupes")
    shutil.rmtree(tmp, ignore_errors=True)
    srv = os.path.join(tmp, "overrides", "kubejs", "server_scripts")
    stp = os.path.join(tmp, "overrides", "kubejs", "startup_scripts")
    os.makedirs(srv)
    os.makedirs(stp)
    body = ("// priority: 0\n"
            "var pneCoreTick = 0\n"
            "function pneHStage(server, level, dim) { return 0 }\n"
            "function pneResTell(mob, player) { return false }\n"
            "var pneZzOnly = 1\n"
            "if (pneZzOnly) {\n"
            "  var pneCoreSlot = 3\n"
            "}\n")
    draft = os.path.join(srv, "pne_zz_dupe.js")
    open(draft, "w", encoding="utf-8", newline="\n").write(body)
    errs = [e for e in kjs_lint.lint([draft], every) if "is also defined in" in e]
    want = {"pneCoreTick": "server_scripts/pne_00_core.js", "pneHStage": "server_scripts/pne_horror.js",
            "pneResTell": "server_scripts/pne_resonance.js"}
    for name, other in want.items():
        hit = [e for e in errs if "'" + name + "'" in e and other in e and "pne_zz_dupe.js" in e]
        if not hit:
            fails.append("duplicate '%s' (also in %s) was not reported; got: %s" % (name, other, errs))
    if any("pneCoreSlot" in e for e in errs):
        fails.append("a var inside a block was reported as a top-level duplicate")
    if any("pneZzOnly" in e for e in errs):
        fails.append("a unique name was reported as a duplicate")

    sdraft = os.path.join(stp, "pne_zz_dupe_startup.js")
    open(sdraft, "w", encoding="utf-8", newline="\n").write(body)
    serrs = [e for e in kjs_lint.lint([sdraft], every) if "is also defined in" in e and "pne_zz_dupe_startup.js" in e]
    if serrs:
        fails.append("startup script names were compared with server script names (separate scopes): %s" % serrs)

    # a draft of an existing module linted in place of the repo copy (same relative path) is not its own duplicate
    mod = os.path.join(srv, "pne_visual.js")
    shutil.copyfile(os.path.join(kjs_lint.KJS, "server_scripts", "pne_visual.js"), mod)
    merrs = [e for e in kjs_lint.lint([mod], every) if "is also defined in" in e]
    if merrs:
        fails.append("a draft that replaces the repo copy collided with it: %s" % merrs[:3])
    shutil.rmtree(tmp, ignore_errors=True)

    if fails:
        for f in fails:
            print("  FAIL " + f)
        print("FAIL pack-lint-duplicates: %d problem(s)" % len(fails))
        return 1
    print("PASS pack-lint-duplicates: %d scripts clean; duplicates of a core, a legacy and a module name reported with both files; "
          "startup scope, block-level vars and in-place drafts not reported" % len(every))
    return 0


if __name__ == "__main__":
    sys.exit(main())
