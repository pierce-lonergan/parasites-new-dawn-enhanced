"""
Suite pack-lint-recruits: tools/ci/kjs_lint.py rule recruits-team (contract 1.5, Appendix A rule 15 (b)) fails a script
that holds a console team command in a string literal.

Recruits (recruits-1.20.1-1.15.2, FactionEvents.onTypeCommandEvent, javap) takes over every server-source command whose
text contains "team" plus "add", "remove", "join" or "leave" once the server has started: it cancels the command (the
caller sees 1) and turns "team add <name>" into a Recruits faction; before the start every command fails. So the pack
changes scoreboard teams only through the ServerScoreboard Java API. This checks, against the real lint:
  1. the repo's scripts carry no console team command outside RECRUITS_PENDING (the files whose owner is rewriting
     them; reported as notes, not errors);
  2. a planted draft: team add/join/leave/remove/empty/modify in single- and double-quoted literals, also after
     "execute ... run", are each reported once; the look-alikes (a status string "teams 8/8", "steam add", "the team
     adds", the word alone, a comment, a regex literal) are not;
  3. a mutation of the real core (one console team command planted) is reported, so the rule covers pne_00_core.js;
  4. RECRUITS_PENDING is empty since the 1.5 integration, so server_scripts/pne_visual.js is checked like any file; the
     mechanism itself (a synthetic entry): a pending file is a note, not an error, and a clean one is noted for removal;
  5. legacy scripts are checked too (the hazard is at run time, whatever the style).
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

DRAFT = """// priority: 0
// Synthetic recruits-team cases for suite pack-lint-recruits (never shipped)
var pneZzR = 1

function pneZzRBad(srv, u, t) {
  srv.runCommandSilent('team add ' + t)
  srv.runCommandSilent("team join " + t + ' ' + u)
  srv.runCommandSilent('execute as ' + u + ' run team leave @s')
  srv.runCommandSilent('team remove ' + t)
  srv.runCommandSilent('team empty ' + t)
  srv.runCommandSilent('team modify ' + t + ' collisionRule always')
}

function pneZzRGood(srv, u) {
  var s = 'teams 8/8, grafts 0'
  var r = /team add/
  // srv.runCommandSilent('team add pne_clade_0') in a comment is fine
  srv.runCommandSilent('say the team adds nothing')
  srv.runCommandSilent('tag ' + u + ' add pne_steam_add')
  return [s, r, 'team', 'steam add x', 'teamwork add']
}
"""
WANT_LINES = {6, 7, 8, 9, 10, 11}


def main():
    fails = []
    every = sorted(glob.glob(os.path.join(kjs_lint.KJS, "**", "*.js"), recursive=True))
    errs = [e for e in kjs_lint.lint(every, every) if "recruits-team" in e]
    if errs:
        fails.append("the pack holds console team commands outside RECRUITS_PENDING: " + "; ".join(errs[:4]))
    pending_notes = [n for n in kjs_lint.NOTES if "RECRUITS_PENDING" in n]

    tmp = os.path.join(os.environ.get("PNE_TMP") or tempfile.gettempdir(), "pne_lint_recruits")
    shutil.rmtree(tmp, ignore_errors=True)
    srv = os.path.join(tmp, "overrides", "kubejs", "server_scripts")
    os.makedirs(srv)
    draft = os.path.join(srv, "pne_zz_recruits.js")
    open(draft, "w", encoding="utf-8", newline="\n").write(DRAFT)
    got = [e for e in kjs_lint.lint([draft], every) if "recruits-team" in e]
    lines = set(int(e.split(":")[1]) for e in got)
    if lines != WANT_LINES or len(got) != len(WANT_LINES):
        fails.append("planted draft: reported lines %s (%d errors), want %s: %s" % (sorted(lines), len(got), sorted(WANT_LINES), got[:8]))

    # mutation of the real core: one planted console team command is reported
    core_src = open(os.path.join(kjs_lint.KJS, "server_scripts", "pne_00_core.js"), encoding="utf-8").read()
    mut = os.path.join(srv, "pne_00_core.js")
    open(mut, "w", encoding="utf-8", newline="\n").write(core_src.replace(
        "function pneCoreLevels(srv) {", "function pneCoreLevels(srv) {\n  if (!srv) srv.runCommandSilent('team join pne_clade_0 x')", 1))
    merrs = [e for e in kjs_lint.lint([mut], every) if "recruits-team" in e]
    if len(merrs) != 1 or "pne_00_core.js" not in merrs[0]:
        fails.append("the mutated core was not reported exactly once: %s" % merrs[:3])
    clean_core = [e for e in kjs_lint.lint([os.path.join(kjs_lint.KJS, "server_scripts", "pne_00_core.js")], every) if "recruits-team" in e]
    if clean_core:
        fails.append("the real core holds a console team command: %s" % clean_core[:2])

    # since the 1.5 integration nothing is pending: VISUAL's own file is checked like every other (a planted console
    # team command in a file of that name is an error)
    if kjs_lint.RECRUITS_PENDING:
        fails.append("RECRUITS_PENDING is not empty after the 1.5 integration: %s" % sorted(kjs_lint.RECRUITS_PENDING))
    vis = os.path.join(srv, "pne_visual.js")
    open(vis, "w", encoding="utf-8", newline="\n").write("// priority: 50\nvar pneVisZz = 'team join pne_clade_0 x'\n")
    verrs = [e for e in kjs_lint.lint([vis], []) if "recruits-team" in e]
    if len(verrs) != 1:
        fails.append("server_scripts/pne_visual.js with a console team command was not reported once: %s" % verrs)

    # the pending mechanism (a synthetic entry): a note, never an error; a clean pending file is noted for removal
    pend_rel = "server_scripts/pne_zz_pending.js"
    kjs_lint.RECRUITS_PENDING[pend_rel] = "synthetic entry of suite pack-lint-recruits"
    try:
        pend = os.path.join(srv, "pne_zz_pending.js")
        open(pend, "w", encoding="utf-8", newline="\n").write("// priority: 0\nvar pneZzP = 'team join pne_clade_0 x'\n")
        perrs = [e for e in kjs_lint.lint([pend], []) if "recruits-team" in e]
        pnote = [n for n in kjs_lint.NOTES if "pne_zz_pending.js" in n and "pending" in n]
        if perrs or not pnote:
            fails.append("a RECRUITS_PENDING file must be a note, not an error (errors %s, notes %s)" % (perrs, kjs_lint.NOTES))
        open(pend, "w", encoding="utf-8", newline="\n").write("// priority: 0\nvar pneZzP = 'teams 8/8'\n")
        kjs_lint.lint([pend], [])
        if not any("pne_zz_pending.js" in n and "remove it from RECRUITS_PENDING" in n for n in kjs_lint.NOTES):
            fails.append("a clean RECRUITS_PENDING file is not noted for removal: %s" % kjs_lint.NOTES)
    finally:
        del kjs_lint.RECRUITS_PENDING[pend_rel]

    # legacy scripts are checked too
    legacy = os.path.join(srv, "pne_horror.js")
    open(legacy, "w", encoding="utf-8", newline="\n").write("var pneHZz = 1\nfunction pneHZzF(s) { s.runCommandSilent('team add pne_x') }\n")
    lerrs = [e for e in kjs_lint.lint([legacy], []) if "recruits-team" in e]
    if len(lerrs) != 1:
        fails.append("a legacy script with a console team command was not reported once: %s" % lerrs)
    shutil.rmtree(tmp, ignore_errors=True)

    if fails:
        for f in fails:
            print("  FAIL " + f)
        print("FAIL pack-lint-recruits: %d problem(s)" % len(fails))
        return 1
    for n in pending_notes:
        print("  note " + n)
    print("PASS pack-lint-recruits: the pack is free of console team commands (%d pending file(s)); %d planted violations "
          "reported, the look-alikes not; a mutated core, pne_visual.js and a legacy script reported; the pending mechanism holds" % (
              len(kjs_lint.RECRUITS_PENDING), len(WANT_LINES)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
