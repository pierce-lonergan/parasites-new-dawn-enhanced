"""
Suite visual-kjs-renames: Minecraft methods that KubeJS renames for scripts, so their Mojang names do not exist in game.

KubeJS 2001.6.5 puts @RemapForJS("newName") on @Shadow methods of its mixins; Mixin copies a shadow's runtime
annotations onto the target method (the mechanism of contract fact F8), and Rhino's JavaMembers reads RemapForJS
before the remapper, so the method is visible to scripts ONLY under the new name. Where Minecraft has other overloads
of the same name (moveTo, push, distanceToSqr, isAlliedTo, setDeltaMovement), only the renamed overload disappears.

This suite:
1. reads the RemapForJS annotations of every mixin in the KubeJS jar (when present) and checks that they are exactly
   RENAMES below (a KubeJS update that changes them fails here);
2. runs a probe in the instance's own Rhino jar (JDK 17, when present): a class whose getGameTime() carries
   @RemapForJS("getTime") and whose getYRot() carries @RemapForJS("getYaw") must show typeof getGameTime/getYRot
   'undefined' and working getTime()/getYaw() (the state Mixin leaves on Level and Entity);
3. fails when overrides/kubejs/server_scripts/pne_visual.js calls a fully hidden Mojang name;
4. prints, as notes for the lead, every call of a hidden name in the other scripts (not a failure of this suite).
Prints PASS on success. Standard library only (plus JDK 17 for the probe).
"""
import glob
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import passenger_scan as ps  # noqa: E402  (class-file parser)

REMAP = "Ldev/latvian/mods/rhino/util/RemapForJS;"
MIXIN = "Lorg/spongepowered/asm/mixin/Mixin;"
E = "net/minecraft/world/entity/Entity"
L = "net/minecraft/world/level/Level"
S = "net/minecraft/server/MinecraftServer"
P = "net/minecraft/server/level/ServerPlayer"
D = "net/minecraft/world/damagesource/DamageSource"
I = "net/minecraft/world/item/ItemStack"
PL = "net/minecraft/world/entity/player/Player"
LP = "net/minecraft/client/player/LocalPlayer"
# (mixin target, member as in the mixin (SRG), Mojang name, name scripts must use, fully hidden: no other overload)
RENAMES = [
    (E, "m_20148_", "getUUID", "getUuid", True),
    (E, "m_20149_", "getStringUUID", "getStringUuid", True),
    (E, "m_6302_", "getScoreboardName", "getUsername", True),
    (E, "m_142038_", "isCurrentlyGlowing", "isGlowing", True),
    (E, "m_146915_", "setGlowingTag", "setGlowing", True),
    (E, "m_146908_", "getYRot", "getYaw", True),
    (E, "m_146922_", "setYRot", "setYaw", True),
    (E, "m_146909_", "getXRot", "getPitch", True),
    (E, "m_146926_", "setXRot", "setPitch", True),
    (E, "m_20334_", "setDeltaMovement", "setMotion", False),
    (E, "m_7678_", "moveTo", "setPositionAndRotation", False),
    (E, "m_5997_", "push", "addMotion", False),
    (E, "m_7307_", "isAlliedTo", "isOnSameTeam", False),
    (E, "m_6350_", "getDirection", "getHorizontalFacing", True),
    (E, "m_20095_", "clearFire", "extinguish", True),
    (E, "m_6469_", "hurt", "attack", True),
    (E, "m_20275_", "distanceToSqr", "getDistanceSq", False),
    (E, "m_6095_", "getType", "getEntityType", True),
    (E, "m_20280_", "distanceToSqr", "distanceToEntitySqr", False),
    (E, "m_20270_", "distanceTo", "distanceToEntity", True),
    (L, "m_46467_", "getGameTime", "getTime", True),
    (L, "m_46472_", "dimension", "getDimensionKey", True),
    (S, "m_6982_", "isDedicatedServer", "isDedicated", True),
    (S, "m_7041_", "stopServer", "stop", True),
    (P, "m_8951_", "getStats", "getStatsCounter", True),
    (LP, "m_108630_", "getStats", "getStatsCounter", True),
    (PL, "m_6915_", "closeContainer", "closeMenu", True),
    (D, "m_19385_", "getMsgId", "getType", True),
    (D, "m_7639_", "getEntity", "getActual", True),
    (D, "m_7640_", "getDirectEntity", "getImmediate", True),
    (I, "m_41663_", "enchant", "enchantStack", True),
    (I, "m_41751_", "setTag", "setNbt", True),
    (I, "m_41782_", "hasTag", "hasNBT", True),
    (I, "m_41783_", "getTag", "getNbt", True),
    # Forge's IForgeEntity.getPersistentData: scripts reach it as getForgePersistentData(); the name getPersistentData
    # stays taken by KubeJS's own compound (F8), so it is not "hidden".
    (E, "getPersistentData", "getPersistentData", "getForgePersistentData", False),
]
OWN_SCRIPT = os.path.join(REPO, "overrides", "kubejs", "server_scripts", "pne_visual.js")


def element(cf, b, q):
    """Parses one annotation element_value at b[q:]; returns (value, next offset)."""
    tag = chr(b[q])
    q += 1
    if tag in "BCDFIJSZs":
        idx = struct.unpack(">H", b[q:q + 2])[0]
        return (cf.utf(idx) if tag == "s" else None), q + 2
    if tag == "e":
        return None, q + 4
    if tag == "c":
        return cf.utf(struct.unpack(">H", b[q:q + 2])[0]), q + 2
    if tag == "@":
        _ann, q = annotation(cf, b, q)
        return None, q
    if tag == "[":
        n = struct.unpack(">H", b[q:q + 2])[0]
        q += 2
        out = []
        for _k in range(n):
            v, q = element(cf, b, q)
            out.append(v)
        return out, q
    raise ValueError("bad element tag %r" % tag)


def annotation(cf, b, q):
    typ, npairs = struct.unpack(">HH", b[q:q + 4])
    q += 4
    vals = {}
    for _k in range(npairs):
        name = cf.utf(struct.unpack(">H", b[q:q + 2])[0])
        v, q = element(cf, b, q + 2)
        vals[name] = v
    return (cf.utf(typ), vals), q


def annotations(cf, attrs):
    out = []
    for key in ("RuntimeVisibleAnnotations", "RuntimeInvisibleAnnotations"):
        b = attrs.get(key)
        if not b:
            continue
        n = struct.unpack(">H", b[0:2])[0]
        q = 2
        for _k in range(n):
            ann, q = annotation(cf, b, q)
            out.append(ann)
    return out


def jar_renames(jar):
    """{(target, member, js)} from the RemapForJS annotations on methods of KubeJS's mixin classes."""
    found = set()
    with zipfile.ZipFile(jar) as z:
        for n in z.namelist():
            if not (n.startswith("dev/latvian/mods/kubejs/core/mixin/") and n.endswith(".class")):
                continue
            cf = ps.ClassFile(z.read(n))
            targets = []
            for typ, vals in annotations(cf, cf.attrs):
                if typ == MIXIN:
                    for c in (vals.get("value") or []):
                        if c and c.startswith("L") and c.endswith(";"):
                            targets.append(c[1:-1])
            for m in cf.methods:
                for typ, vals in annotations(cf, m["attrs"]):
                    if typ == REMAP and isinstance(vals.get("value"), str):
                        member = m["name"]
                        if not (member.startswith("m_") or member == "getPersistentData"):
                            continue  # a method KubeJS adds itself (no Minecraft name is hidden)
                        for t in targets or ["?"]:
                            found.add((t, member, vals["value"]))
    return found


def kubejs_jar():
    p = os.environ.get("PNE_KUBEJS_JAR")
    if p and os.path.isfile(p):
        return p
    inst = os.environ.get("PNE_INSTANCE") or ""
    cands = sorted(glob.glob(os.path.join(inst, "mods", "kubejs-forge-*.jar"))) if inst else []
    return cands[0] if cands else None


PROBE = r"""
import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.ScriptableObject;
import dev.latvian.mods.rhino.util.RemapForJS;

public class PneRemapProbe {
    public static class Lvl {
        @RemapForJS("getTime") public long getGameTime() { return 42L; }
    }
    public static class Ent {
        @RemapForJS("getYaw") public float getYRot() { return 90f; }
        public float getVisualRotationYInDegrees() { return 91f; }
    }
    public static void main(String[] a) {
        Context cx = Context.enter();
        ScriptableObject scope = cx.initStandardObjects();
        ScriptableObject.putProperty(scope, "lvl", Context.javaToJS(cx, new Lvl(), scope), cx);
        ScriptableObject.putProperty(scope, "ent", Context.javaToJS(cx, new Ent(), scope), cx);
        Object r = cx.evaluateString(scope, "['getGameTime:' + typeof lvl.getGameTime, 'getTime:' + typeof lvl.getTime,"
            + " 'value:' + Number(lvl.getTime()), 'getYRot:' + typeof ent.getYRot, 'getYaw:' + typeof ent.getYaw,"
            + " 'yaw:' + Number(ent.getYaw()), 'visual:' + Number(ent.getVisualRotationYInDegrees())].join(' ')", "probe", 1, null);
        System.out.println(cx.toString(r));
    }
}
"""
PROBE_WANT = "getGameTime:undefined getTime:function value:42 getYRot:undefined getYaw:function yaw:90 visual:91"


def rhino_probe():
    """Output of the RemapForJS probe in the real Rhino jar, or None when JDK 17 or the Rhino classpath is missing."""
    javac = os.environ.get("PNE_JAVAC") or ""
    java = os.environ.get("PNE_JAVA") or ""
    cp = os.environ.get("PNE_RHINO_CP") or ""
    if not (os.path.isfile(javac) and os.path.isfile(java) and cp):
        return None
    root = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
    os.makedirs(root, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="visual_remap_", dir=root)
    try:
        src = os.path.join(tmp, "PneRemapProbe.java")
        with open(src, "w", encoding="utf-8") as f:
            f.write(PROBE)
        r = subprocess.run([javac, "-nowarn", "-encoding", "UTF-8", "-cp", cp, "-d", tmp, src], capture_output=True, text=True)
        if r.returncode:
            return "javac failed: " + (r.stdout + r.stderr).strip()
        r = subprocess.run([java, "-cp", tmp + os.pathsep + cp, "PneRemapProbe"], capture_output=True, text=True, timeout=120)
        return (r.stdout.strip().splitlines() or [""])[-1] if r.returncode == 0 else "java failed: " + (r.stdout + r.stderr).strip()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def hidden_calls(text):
    """[(line number, Mojang name, KubeJS name)] for calls of fully hidden names in one script's code lines."""
    # A Mojang name that is also the script name of another rename (Entity.getType vs DamageSource.getType, the new
    # name of getMsgId) depends on the receiver and is not flagged. getEntity keeps its name on Level and elsewhere,
    # so it is flagged only on a receiver that looks like a damage source.
    new_names = {r[3] for r in RENAMES}
    names = {r[2]: r[3] for r in RENAMES if r[4] and r[2] not in new_names and r[2] != "getEntity"}
    rx = re.compile(r"\.(%s)\s*\(" % "|".join(sorted(names, key=len, reverse=True)))
    rx_src = re.compile(r"\b(source|damageSource|dmgSource)\.getEntity\s*\(")
    out = []
    for i, line in enumerate(text.splitlines(), start=1):
        if line.lstrip().startswith("//"):
            continue
        for m in rx.finditer(line):
            out.append((i, m.group(1), names[m.group(1)]))
        for m in rx_src.finditer(line):
            out.append((i, "getEntity", "getActual"))
    return out


def main():
    fails = []
    n = [0]

    def check(cond, msg):
        n[0] += 1
        if not cond:
            fails.append(msg)

    # the table itself
    js = [r[3] for r in RENAMES]
    check(len(set((r[0], r[1]) for r in RENAMES)) == len(RENAMES), "one row per (target, member)")
    check(all(re.match(r"^[a-z][A-Za-z]+$", x) for x in js), "script names are plain identifiers")
    # the detector on a synthetic script
    sample = ("var a = mob.getYRot()\n// mob.getGameTime() in a comment is fine\nvar b = level.getGameTime()\n"
              "var c = mob.getYaw()\nvar d = mob.moveTo(1, 2, 3)\nvar e = source.getEntity()\nvar f = level.getEntity(id)\n"
              "var g = source.getType()\nvar h = source.getMsgId()\n")
    got = hidden_calls(sample)
    check(got == [(1, "getYRot", "getYaw"), (3, "getGameTime", "getTime"), (6, "getEntity", "getActual"), (9, "getMsgId", "getType")],
          "detector: %s" % got)

    jar = kubejs_jar()
    note = "KubeJS jar not present"
    if jar:
        found = jar_renames(jar)
        want = {(r[0], r[1], r[3]) for r in RENAMES}
        check(found == want, "KubeJS jar RemapForJS renames equal the table; only in jar: %s; only in table: %s" % (
            sorted(found - want), sorted(want - found)))
        note = "%s: %d renames" % (os.path.basename(jar), len(found))
    probe = rhino_probe()
    if probe is None:
        note += "; Rhino probe skipped (no JDK 17 or Rhino classpath)"
    else:
        check(probe == PROBE_WANT, "Rhino probe: %s (want %s)" % (probe, PROBE_WANT))
        note += "; Rhino probe: " + probe

    own = hidden_calls(open(OWN_SCRIPT, encoding="utf-8").read())
    check(not own, "pne_visual.js calls no hidden Mojang name: %s" % own)

    notes = []
    for path in sorted(glob.glob(os.path.join(REPO, "overrides", "kubejs", "*_scripts", "*.js"))):
        if os.path.normcase(path) == os.path.normcase(OWN_SCRIPT):
            continue
        for line, name, new in hidden_calls(open(path, encoding="utf-8").read()):
            notes.append("%s:%d %s() is hidden in game; KubeJS name %s()" % (
                os.path.relpath(path, REPO).replace(os.sep, "/"), line, name, new))
    for x in notes:
        print("  note  " + x)
    for f in fails:
        print("  FAIL  " + f)
    if fails:
        print("FAIL %d of %d visual-kjs-renames checks" % (len(fails), n[0]))
        return 1
    print("PASS %d visual-kjs-renames checks (%s; %d hidden-name call(s) noted in other modules' scripts)" % (n[0], note, len(notes)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
