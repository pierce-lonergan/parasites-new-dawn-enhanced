"""
Pack-level smoke test of The Hive Remembers (suites pack-smoke and pack-degradation in tools/suites/pack.json).

    python tools/tests/pack/run_pack.py full            pack-smoke: every server script in one scope (KubeJS load order),
                                                        the startup scripts in their own scope, one shared global HashMap,
                                                        2+ in-game days with players, parasites, deaths, respawns, a Hive
                                                        Night, dawns, /reload and a world restart
    python tools/tests/pack/run_pack.py matrix          pack-degradation: each new file removed in turn (contract 8) and
                                                        each pillar switched off and on again (contract 6.2)
    python tools/tests/pack/run_pack.py VARIANT[,...]   single variants (names in tools/tests/pack/pack_sim.js; 'quick' is a
                                                        3500-tick development run that also prints status and mobs)
    python tools/tests/pack/run_pack.py ... --root=DIR  load the scripts from DIR/server_scripts and DIR/startup_scripts
                                                        (a scratch copy, for mutation checks) instead of overrides/kubejs
    python tools/tests/pack/run_pack.py ... --strict    the world exposes only the method names KubeJS leaves visible in
                                                        game (contract F37: getTime, getType/getActual, getYaw, ...),
                                                        not the Mojang names the module mocks also answer to

Everything runs in the instance's own Rhino jar under JDK 17 (tools/rhino/pne_rhino.py: class filter, game remapper);
tools/tests/pack/PackRhino.java adds the second scope and the shared global. Nothing is written anywhere (the world,
the bridge files and the persistent data are in memory). Exit 0 on PASS, 1 on FAIL, 77 when the toolchain is missing.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
import pne_rhino  # noqa: E402

SKIP = 77
WORLD = [
    "tools/tests/kjs_mocks.js",
    "tools/hive/hive_prelude.js",
    "tools/visual/vis_prelude.js",
    "tools/oracle/ora_mocks.js",
    "tools/tests/pack/pack_world.js",
    "tools/tests/pack/pack_sim.js",
]


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    strict = "--strict" in argv
    root = ""
    for a in argv[1:]:
        if a.startswith("--root="):
            root = a[len("--root="):].replace("\\", "/")
    which = args[0] if args else "full"
    e = pne_rhino.env()
    if not pne_rhino.ready(e):
        print("SKIP: JDK 17, the instance's Rhino jar or its libraries were not found (set PNE_JDK17 / PNE_INSTANCE / PNE_MC_LIBS)")
        return SKIP
    rh = os.path.join(ROOT, "tools", "rhino")
    srcs = [os.path.join(rh, "PneRhino.java"), os.path.join(HERE, "PackRhino.java")]
    if e["libs"]["brigadier"]:
        srcs.append(os.path.join(rh, "PneRhinoBrig.java"))
    cls = pne_rhino.build(e, srcs, "pnepack")
    expr = "pnePackMain('%s', '%s', '%s')" % (which, "strict" if strict else "", root)
    r = pne_rhino.run_java(e, cls, "PackRhino", [expr] + WORLD, timeout=3000)
    out = (r.stdout or "") + (r.stderr or "")
    lines = [ln for ln in out.splitlines() if ln.strip()]
    for ln in lines:
        if not ln.startswith("[info]") and not ln.startswith("[log]") and not ln.startswith("[brig]"):
            print(ln)
    last = lines[-1].strip() if lines else ""
    if r.returncode != 0 or not last.startswith("PASS"):
        if last.startswith("PASS"):
            print("FAIL harness exit code %d" % r.returncode)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
