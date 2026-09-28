"""
Proves the ServerScoreboard team API that overrides/kubejs/server_scripts/pne_visual.js uses (contract 1.5, spec D: clade
teams change only through the Java API, because Recruits takes over console team commands) against the real jars:

1. javap: the SRG-named Minecraft client jar (the runtime names under Forge) declares every method with the expected
   descriptor, and ServerScoreboard overrides the two membership writes (so they broadcast and mark the scoreboard dirty,
   as the /team command does).
2. remapper (ScoreboardApiProbe.java): the Rhino fork's MinecraftRemapper, loaded from the Rhino jar's own mm.jsmappings
   as KubeJS does (fact F34), maps each SRG method to exactly the Mojang name the script calls.
3. KubeJS: no KubeJS mixin targets a scoreboard class, and none of the names is among the methods KubeJS hides from
   scripts (tools/visual/kjs_renames.py RENAMES, fact F37).
4. real Rhino, real classes (scoreboard_real_prelude.js + scoreboard_real.js): pne_visual.js runs inside the instance's
   Rhino jar with the remapper and the KubeJS class-filter replica, against a real net.minecraft.world.scores.Scoreboard
   and the real Team$Visibility / Team$CollisionRule enums: the 8 clade teams are created and verified, and joins,
   moves, leaves and emptying are verified through getPlayersTeam.

Standard library only, plus JDK 17 (tools/rhino/pne_rhino.py finds it, the instance and its libraries). Exit 77 (SKIP)
when they are missing. Prints PASS on success. Writes only to %TEMP%.
"""
import glob
import os
import subprocess
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools", "rhino"))
sys.path.insert(0, HERE)
import pne_rhino  # noqa: E402

SKIP = 77
# (class, SRG method, descriptor) that javap must show; the ServerScoreboard rows are its own overrides.
JAVAP = [
    ("net.minecraft.server.MinecraftServer", "m_129896_", "()Lnet/minecraft/server/ServerScoreboard;"),
    ("net.minecraft.world.scores.Scoreboard", "m_83489_", "(Ljava/lang/String;)Lnet/minecraft/world/scores/PlayerTeam;"),
    ("net.minecraft.world.scores.Scoreboard", "m_83492_", "(Ljava/lang/String;)Lnet/minecraft/world/scores/PlayerTeam;"),
    ("net.minecraft.world.scores.Scoreboard", "m_83500_", "(Ljava/lang/String;)Lnet/minecraft/world/scores/PlayerTeam;"),
    ("net.minecraft.world.scores.Scoreboard", "m_83495_", "(Ljava/lang/String;)Z"),
    ("net.minecraft.server.ServerScoreboard", "m_6546_", "(Ljava/lang/String;Lnet/minecraft/world/scores/PlayerTeam;)Z"),
    ("net.minecraft.server.ServerScoreboard", "m_6519_", "(Ljava/lang/String;Lnet/minecraft/world/scores/PlayerTeam;)V"),
    ("net.minecraft.server.ServerScoreboard", "m_7645_", "(Lnet/minecraft/world/scores/PlayerTeam;)V"),
    ("net.minecraft.world.scores.PlayerTeam", "m_83346_", "(Lnet/minecraft/world/scores/Team$Visibility;)V"),
    ("net.minecraft.world.scores.PlayerTeam", "m_7470_", "()Lnet/minecraft/world/scores/Team$Visibility;"),
    ("net.minecraft.world.scores.PlayerTeam", "m_83344_", "(Lnet/minecraft/world/scores/Team$CollisionRule;)V"),
    ("net.minecraft.world.scores.PlayerTeam", "m_7156_", "()Lnet/minecraft/world/scores/Team$CollisionRule;"),
    ("net.minecraft.world.scores.PlayerTeam", "m_83355_", "(Z)V"),
    ("net.minecraft.world.scores.PlayerTeam", "m_6260_", "()Z"),
    ("net.minecraft.world.scores.PlayerTeam", "m_83362_", "(Z)V"),
    ("net.minecraft.world.scores.PlayerTeam", "m_6259_", "()Z"),
    ("net.minecraft.world.scores.PlayerTeam", "m_5758_", "()Ljava/lang/String;"),
    ("net.minecraft.world.scores.PlayerTeam", "m_6809_", "()Ljava/util/Collection;"),
]
NAMES = ["getScoreboard", "getPlayerTeam", "addPlayerTeam", "getPlayersTeam", "addPlayerToTeam", "removePlayerFromTeam",
         "getName", "getPlayers", "setNameTagVisibility", "getNameTagVisibility", "setCollisionRule", "getCollisionRule",
         "setAllowFriendlyFire", "isAllowFriendlyFire", "setSeeFriendlyInvisibles", "canSeeFriendlyInvisibles"]
SCORE_TARGETS = (b"net/minecraft/world/scores/", b"net/minecraft/server/ServerScoreboard")


def libraries(e):
    """Every library jar of the instance except the other Minecraft client variants (the SRG jar is added first)."""
    base = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(e["libs"]["mc_srg"])))))
    out = []
    for p in sorted(glob.glob(os.path.join(base, "**", "*.jar"), recursive=True)):
        rel = os.path.relpath(p, base).replace("\\", "/")
        if rel.startswith("net/minecraft/client/") or rel.startswith("net/minecraftforge/"):
            continue
        out.append(p)
    return out


def javap_check(e, fails):
    javap = os.path.join(e["jdk"]["home"], "bin", "javap" + (".exe" if os.name == "nt" else ""))
    classes = sorted(set(r[0] for r in JAVAP))
    r = subprocess.run([javap, "-s", "-cp", e["libs"]["mc_srg"]] + classes, capture_output=True, text=True)
    if r.returncode:
        fails.append("javap failed: " + (r.stderr or r.stdout)[:300])
        return 0
    cur = None
    have = set()
    last = None
    for line in r.stdout.splitlines():
        s = line.strip()
        if s.startswith("Compiled from"):
            continue
        if (line.startswith("public") or line.startswith("final") or line.startswith("class")) and s.endswith("{"):
            cur = s[:-1].split(" extends ")[0].split(" implements ")[0].split()[-1]
            continue
        if s.startswith("descriptor:") and last and cur:
            have.add((cur, last, s.split(":", 1)[1].strip()))
            continue
        m = s.split("(")[0].split()
        last = m[-1] if "(" in s and m else None
    n = 0
    for cls, name, desc in JAVAP:
        if (cls, name, desc) in have:
            n += 1
        else:
            fails.append(f"javap: {cls}.{name}{desc} not declared")
    print(f"  javap: {n}/{len(JAVAP)} methods declared with the expected descriptors in the SRG jar")
    return n


def kubejs_check(e, fails):
    import kjs_renames
    hidden = set(row[2] for row in kjs_renames.RENAMES)
    for n in NAMES:
        if n in hidden:
            fails.append(f"KubeJS hides {n} (tools/visual/kjs_renames.py)")
    if not e.get("kubejs_jar"):
        print("  kubejs: jar not found, mixin scan skipped (rename table checked)")
        return
    hits = []
    with zipfile.ZipFile(e["kubejs_jar"]) as z:
        for info in z.infolist():
            if "/mixin/" in info.filename and info.filename.endswith(".class"):
                data = z.read(info)
                if any(t in data for t in SCORE_TARGETS):
                    hits.append(info.filename)
    if hits:
        fails.append("a KubeJS mixin references a scoreboard class: " + ", ".join(hits[:4]))
    print(f"  kubejs: no mixin on a scoreboard class, none of the {len(NAMES)} names is renamed for scripts")


def main():
    e = pne_rhino.env()
    if not pne_rhino.ready(e) or not e["libs"]["mc_srg"] or not e["libs"]["slf4j"]:
        print("SKIP: JDK 17, the Rhino jar, slf4j or the SRG Minecraft jar was not found")
        return SKIP
    fails = []
    javap_check(e, fails)
    kubejs_check(e, fails)
    libs = libraries(e)
    extra = [e["libs"]["mc_srg"]] + libs
    # 2. the remapper probe
    cls = pne_rhino.build(e, [os.path.join(HERE, "ScoreboardApiProbe.java")], "visscore")
    cp = pne_rhino.rhino_classpath(e, [cls] + extra)
    r = subprocess.run([e["jdk"]["java"], "-cp", cp, "ScoreboardApiProbe"], capture_output=True, text=True, cwd=ROOT)
    out = (r.stdout or "") + (r.stderr or "")
    sys.stdout.write("".join("  " + ln + "\n" for ln in out.strip().splitlines()))
    last = out.strip().splitlines()[-1] if out.strip() else ""
    if r.returncode or not last.startswith("PASS"):
        fails.append("remapper probe: " + last[:300])
    # 4. pne_visual.js on the real scoreboard classes in the real Rhino fork
    har = pne_rhino.harness(e)
    cp = pne_rhino.rhino_classpath(e, [har] + extra)
    files = ["tools/tests/kjs_mocks.js", "tools/visual/vis_prelude.js", "tools/visual/scoreboard_real_prelude.js",
             "overrides/kubejs/server_scripts/pne_00_core.js", "overrides/kubejs/server_scripts/pne_visual.js",
             "tools/visual/scoreboard_real.js"]
    r = subprocess.run([e["jdk"]["java"], "-cp", cp, "PneRhino", "run", "pneVisRealResult"] + files,
                       capture_output=True, text=True, cwd=ROOT)
    out = ((r.stdout or "") + (r.stderr or "")).strip()
    last = out.splitlines()[-1] if out else ""
    print("  real Rhino, real classes: " + last[:600])
    if r.returncode or not last.startswith("PASS"):
        tail = [ln for ln in out.splitlines() if ln.startswith("FAIL") or "Exception" in ln][:6]
        fails.append("real-class run: " + (" | ".join(tail) or last)[:600])
    if fails:
        print("FAIL " + " || ".join(fails))
        return 1
    print("PASS scoreboard team API: javap, remapper, KubeJS renames and a real-class Rhino run of pne_visual.js agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
