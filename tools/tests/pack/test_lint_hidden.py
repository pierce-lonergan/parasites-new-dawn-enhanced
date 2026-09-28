"""
Suite pack-lint-hidden-names: tools/ci/kjs_lint.py fails a new script that calls a Minecraft method name KubeJS hides
in game (contract F37), unless the call is a guarded fallback after the same receiver's KubeJS name.

KubeJS puts @RemapForJS("newName") on @Shadow methods of its mixins and Mixin merges the annotation, so scripts see
Level.getGameTime() only as getTime(), DamageSource.getMsgId()/getEntity() only as getType()/getActual(), Entity.getYRot()
only as getYaw(), MinecraftServer.isDedicatedServer() only as isDedicated() (tools/visual/kjs_renames.py reads all of
them from the KubeJS jar). A hidden name inside a try whose catch swallows the error fails silently in game: that is how
the natural-spawn gate lost its mercy check. This checks, against the real lint:
  1. the repo's new scripts have no unguarded hidden-name call, and the lint's table equals kjs_renames.py's;
  2. a synthetic draft: hidden names with no KubeJS name first, outside a try, on another receiver, or on a damage
     source (x.source.getEntity) are reported; the fallback forms (catch after the KubeJS name, `if (!isFinite(t))`
     after it), Forge event.getEntity(), level.getEntity(id), EntityEvents.hurt(...), level.getBlock(...).hasTag(tag) (KubeJS's
     BlockContainerJS method; ItemStack.hasTag is the hidden one) and names inside strings or comments are not;
  3. a mutation of the real core (its getTime() call renamed away) is reported at the getGameTime() fallback line;
  4. legacy scripts are not checked (they keep their own style).
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
// Synthetic F37 cases for suite pack-lint-hidden-names (never shipped)
var pneZzA = 1

function pneZzBad1(level) {
  var t = NaN
  try { t = Number(level.getGameTime()) } catch (e) { return false }
  return t
}

function pneZzGood1(level) {
  var t = NaN
  try { t = Number(level.getTime()) } catch (e) {
    try { t = Number(level.getGameTime()) } catch (e2) { t = NaN }
  }
  return t
}

function pneZzGood2(p) {
  var y = NaN
  try { y = Number(p.getYaw()) } catch (e) { y = NaN }
  if (!isFinite(y)) {
    try { y = Number(p.getYRot()) } catch (e2) { y = NaN }
  }
  return y
}

function pneZzBad2(p) {
  var y = p.getYRot()
  return y
}

function pneZzBad3(p) {
  var y = NaN
  try { y = p.getYaw() } catch (e) { y = NaN }
  y = p.getYRot()
  return y
}

function pneZzBad4(a, b) {
  var t = NaN
  try { t = a.getTime() } catch (e) {
    try { t = b.getGameTime() } catch (e2) { t = NaN }
  }
  return t
}

function pneZzBad5(event) {
  var a = null
  try { a = event.source.getEntity() } catch (e) { a = null }
  return a
}

function pneZzGood3(event, level, id) {
  var a = null
  var b = null
  var c = null
  try { a = event.getEntity() } catch (e) { a = null }
  try { b = level.getEntity(id) } catch (e2) { b = null }
  try { c = event.getSource().getActual() } catch (e3) {
    try { c = event.getSource().getEntity() } catch (e4) { c = null }
  }
  return [a, b, c, 'level.getGameTime() in a string']
}

function pneZzGood4(level, x, y, z) {
  var g = null
  try { g = level.getBlock(x, y, z).hasTag('pne:beckon_ground') } catch (e) { g = null }
  return g
}

function pneZzBad7(stack) {
  var h = null
  try { h = stack.hasTag() } catch (e) { h = null }
  return h
}

function pneZzBad6(server) {
  var d = null
  try { d = server.isDedicatedServer() } catch (e) { d = null }
  return d
}

// level.getGameTime() in a comment is fine
EntityEvents.hurt(function (event) {
  var s = null
  try { s = event.source.getType() } catch (e) {
    try { s = event.source.getMsgId() } catch (e2) { s = null }
  }
  return s
})
"""
# (function name the error line falls in, hidden name)
WANT = {("pneZzBad1", "getGameTime"), ("pneZzBad2", "getYRot"), ("pneZzBad3", "getYRot"), ("pneZzBad4", "getGameTime"),
        ("pneZzBad5", "getEntity"), ("pneZzBad6", "isDedicatedServer"),
        ("pneZzBad7", "hasTag")}


def fn_at(text, ln):
    name = "?"
    for i, line in enumerate(text.split("\n"), 1):
        if i > ln:
            break
        if line.startswith("function "):
            name = line.split()[1].split("(")[0]
    return name


def main():
    fails = []
    every = sorted(glob.glob(os.path.join(kjs_lint.KJS, "**", "*.js"), recursive=True))
    errs = kjs_lint.lint(every, every)
    hidden = [e for e in errs if "(F37" in e or "kjs_renames" in e]
    if hidden:
        fails.append("the pack has unguarded hidden-name calls or a table mismatch: " + "; ".join(hidden[:6]))
    n_new = sum(1 for p in every if kjs_lint.rel_of(p) not in kjs_lint.LEGACY)

    tmp = os.path.join(os.environ.get("PNE_TMP") or tempfile.gettempdir(), "pne_lint_hidden")
    shutil.rmtree(tmp, ignore_errors=True)
    srv = os.path.join(tmp, "overrides", "kubejs", "server_scripts")
    os.makedirs(srv)
    draft = os.path.join(srv, "pne_zz_hidden.js")
    open(draft, "w", encoding="utf-8", newline="\n").write(DRAFT)
    got = set()
    for e in kjs_lint.lint([draft], every):
        if "(F37" not in e:
            continue
        ln = int(e.split(":")[1])
        name = e.split(": ", 1)[1].split("(")[0].split(".")[-1]
        got.add((fn_at(DRAFT, ln), name))
    if got != WANT:
        fails.append("synthetic draft: reported %s, want %s (missed %s; false positives %s)" % (
            sorted(got), sorted(WANT), sorted(WANT - got), sorted(got - WANT)))

    # mutation of the real core: without its getTime() call the getGameTime() fallback is unguarded
    core_src = open(os.path.join(kjs_lint.KJS, "server_scripts", "pne_00_core.js"), encoding="utf-8").read()
    if "level.getTime()" not in core_src:
        fails.append("pne_00_core.js no longer calls level.getTime() (mutation target missing)")
    else:
        mut = os.path.join(srv, "pne_00_core.js")
        open(mut, "w", encoding="utf-8", newline="\n").write(core_src.replace("level.getTime()", "level.getTimeGone()"))
        merrs = [e for e in kjs_lint.lint([mut], every) if "(F37" in e]
        if not any("level.getGameTime()" in e for e in merrs):
            fails.append("the mutated core (getTime() removed) was not reported at its getGameTime() fallback: %s" % merrs[:3])

    # legacy scripts keep their style: the same bad call in a legacy file name is not checked
    legacy = os.path.join(srv, "pne_horror.js")
    open(legacy, "w", encoding="utf-8", newline="\n").write("var pneHZz = 1\nfunction pneHZzF(l) { return l.getGameTime() }\n")
    lerrs = [e for e in kjs_lint.lint([legacy], []) if "(F37" in e]
    if lerrs:
        fails.append("a legacy script was checked for hidden names: %s" % lerrs)
    shutil.rmtree(tmp, ignore_errors=True)

    if fails:
        for f in fails:
            print("  FAIL " + f)
        print("FAIL pack-lint-hidden-names: %d problem(s)" % len(fails))
        return 1
    print("PASS pack-lint-hidden-names: %d new scripts free of unguarded hidden names (F37 table = kjs_renames.py); "
          "%d synthetic violations reported, the fallback forms and false-positive shapes not; a mutated core reported" % (
              n_new, len(WANT)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
