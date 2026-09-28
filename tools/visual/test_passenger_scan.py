"""
Suite visual-passenger-scan: tools/visual/passenger_scan.py on synthetic classes compiled with JDK 17 into PNE_TMP
(stub Entity / Goal / vanilla goals with the real SRG names, an EPCA-style and a Spore-style registry), then, when
the instance is present:
  - the real EPCA and Spore jars: every entity whose fighting changes with a passenger is listed in PNE_VIS_NO_GRAFT
    of overrides/kubejs/server_scripts/pne_visual.js, and every listed id is a registered entity id;
  - the real client jar (PNE_MC_SRG): the vanilla goals that check isVehicle are exactly the tool's combat + idle lists,
    and Entity.push(Entity) tests isVehicle (so a vehicle is not pushed by other entities).
Prints PASS.
"""
import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "tools", "rhino"))
import passenger_scan as ps  # noqa: E402

TMP_ROOT = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
TMP = None
SCRIPT = os.path.join(REPO, "overrides", "kubejs", "server_scripts", "pne_visual.js")

MC = "net/minecraft/world/entity/"
SOURCES = {
    MC + "Entity.java": "package net.minecraft.world.entity; public class Entity {"
                        " public boolean m_20160_() { return false; } public Entity m_146895_() { return null; }"
                        " public void m_20153_() {} protected void m_19956_(Entity e, Object f) {}"
                        " public double m_6048_() { return 1.0; } }",
    MC + "EntityType.java": "package net.minecraft.world.entity; public class EntityType {}",
    "net/minecraft/world/level/Level.java": "package net.minecraft.world.level; public class Level {}",
    MC + "ai/goal/Goal.java": "package net.minecraft.world.entity.ai.goal; public abstract class Goal { public abstract boolean canUse(); }",
    MC + "ai/goal/LeapAtTargetGoal.java": "package net.minecraft.world.entity.ai.goal; public class LeapAtTargetGoal extends Goal {"
                                          " net.minecraft.world.entity.Entity mob; public boolean canUse() { return !mob.m_20160_(); } }",
    MC + "ai/goal/RandomStrollGoal.java": "package net.minecraft.world.entity.ai.goal; public class RandomStrollGoal extends Goal {"
                                          " net.minecraft.world.entity.Entity mob; public boolean canUse() { return !mob.m_20160_(); } }",
    MC + "ai/goal/WaterAvoidingRandomStrollGoal.java": "package net.minecraft.world.entity.ai.goal;"
                                                       " public class WaterAvoidingRandomStrollGoal extends RandomStrollGoal {}",
    MC + "ai/goal/MeleeAttackGoal.java": "package net.minecraft.world.entity.ai.goal; public class MeleeAttackGoal extends Goal {"
                                         " public boolean canUse() { return true; } }",
    # mod classes
    "tm/Walker.java": "package tm; import net.minecraft.world.entity.*; import net.minecraft.world.level.Level;"
                      " import net.minecraft.world.entity.ai.goal.*;"
                      " public class Walker extends Entity { public Walker(EntityType t, Level l) {}"
                      " void goals() { Object a = new WaterAvoidingRandomStrollGoal(); Object b = new MeleeAttackGoal(); } }",
    "tm/Carrier.java": "package tm; import net.minecraft.world.entity.*; import net.minecraft.world.level.Level;"
                       " public class Carrier extends Entity { public Carrier(EntityType t, Level l) {}"
                       " void tickCarry() { if (m_20160_()) m_20153_(); } }",
    "tm/CarryGoal.java": "package tm; import net.minecraft.world.entity.Entity; import net.minecraft.world.entity.ai.goal.Goal;"
                         " public class CarryGoal extends Goal { Entity mob; public boolean canUse() { return mob.m_146895_() == null; } }",
    "tm/Hauler.java": "package tm; import net.minecraft.world.entity.*; import net.minecraft.world.level.Level;"
                      " public class Hauler extends Entity { public Hauler(EntityType t, Level l) {} void goals() { Object g = new CarryGoal(); } }",
    "tm/Pouncer.java": "package tm; import net.minecraft.world.entity.*; import net.minecraft.world.level.Level;"
                       " import net.minecraft.world.entity.ai.goal.LeapAtTargetGoal;"
                       " public class Pouncer extends Entity { public Pouncer(EntityType t, Level l) {}"
                       " void goals() { Object g = new LeapAtTargetGoal() { }; } }",
    "tm/BaseRider.java": "package tm; import net.minecraft.world.entity.Entity;"
                         " public abstract class BaseRider extends Entity { protected void m_19956_(Entity e, Object f) {} }",
    "tm/Rider.java": "package tm; import net.minecraft.world.entity.*; import net.minecraft.world.level.Level;"
                     " public class Rider extends BaseRider { public Rider(EntityType t, Level l) {} }",
    "tm/Tall.java": "package tm; import net.minecraft.world.entity.*; import net.minecraft.world.level.Level;"
                    " public class Tall extends Entity { public Tall(EntityType t, Level l) {} public double m_6048_() { return 3.0; } }",
    "tm/Victim.java": "package tm; import net.minecraft.world.entity.*; import net.minecraft.world.level.Level;"
                      " public class Victim extends Entity { public Victim(EntityType t, Level l) {} }",
    "tm/client/VictimModel.java": "package tm.client; public class VictimModel {"
                                  " boolean ride(net.minecraft.world.entity.Entity e) { return e.m_20160_(); } }",
    "tm/Reg.java": """
package tm;
import net.minecraft.world.entity.*;
import net.minecraft.world.level.Level;
import java.util.function.Supplier;
public class Reg {
  public interface F { Entity make(EntityType t, Level l); }
  static Object reg(String id, float w, F f) { return f; }
  static Object build(F f, String ns, String id) { return f; }
  // EPCA style: the id string comes before the factory, all in <clinit>
  public static final Object WALKER = reg("walker", 0.6f, Walker::new);
  public static final Object CARRIER = reg("carrier", 1.2f, Carrier::new);
  public static final Object HAULER = reg("hauler", 1.0f, Hauler::new);
  public static final Object TALL = reg("tall", 1.0f, Tall::new);
  // Spore style: the factory first, then the namespace and the id, inside a lambda
  public static final Supplier<Object> POUNCER = () -> build(Pouncer::new, "tm", "pouncer");
  public static final Supplier<Object> RIDER = () -> build(Rider::new, "tm", "rider");
  public static final Supplier<Object> VICTIM = () -> build(Victim::new, "tm", "victim");
}
""",
}


def cli(args):
    """Runs passenger_scan.main quietly; returns (exit code, printed text)."""
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = ps.main(args)
    return rc, buf.getvalue()


def javac_path():
    p = os.environ.get("PNE_JAVAC")
    if p and os.path.isfile(p):
        return p
    import pne_rhino
    e = pne_rhino.env()
    return e["jdk"]["javac"] if e["jdk"] else None


def main():
    fails = []
    n = [0]

    def check(cond, msg):
        n[0] += 1
        if not cond:
            fails.append(msg)

    javac = javac_path()
    if not javac:
        print("SKIP: JDK 17 javac not found")
        return 77
    src = os.path.join(TMP, "src")
    out = os.path.join(TMP, "classes")
    files = []
    for rel, text in SOURCES.items():
        p = os.path.join(src, *rel.split("/"))
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, "w", encoding="utf-8").write(text)
        files.append(p)
    os.makedirs(out, exist_ok=True)
    r = subprocess.run([javac, "-nowarn", "-encoding", "UTF-8", "-d", out] + files, capture_output=True, text=True)
    if r.returncode:
        print("FAIL javac: " + r.stdout + r.stderr)
        return 1
    mod = os.path.join(TMP, "tm-mod.jar")
    mcj = os.path.join(TMP, "fake-client.jar")
    with zipfile.ZipFile(mod, "w") as zm, zipfile.ZipFile(mcj, "w") as zc:
        for dirpath, _, names in os.walk(out):
            for nme in names:
                full = os.path.join(dirpath, nme)
                rel = os.path.relpath(full, out).replace(os.sep, "/")
                (zc if rel.startswith("net/") else zm).write(full, rel)
        zm.writestr("tm/Broken.class", b"\xca\xfe\xba\xbe\x00\x00")
        zm.writestr("assets/tm/textures/entity/walker.png", b"not scanned")

    rep = ps.scan(mod)
    check(rep["namespace"] == "tm", "namespace found from assets/<ns>/textures/entity/: %r" % rep["namespace"])
    check(rep["unparsed"] == 1, "a broken class file is counted, not fatal")
    reg = rep["registry"]
    want = {"tm:walker": "tm/Walker", "tm:carrier": "tm/Carrier", "tm:hauler": "tm/Hauler", "tm:tall": "tm/Tall",
            "tm:pouncer": "tm/Pouncer", "tm:rider": "tm/Rider", "tm:victim": "tm/Victim"}
    check(reg == want, "registry from both styles (id before the factory; factory then namespace and id): %s" % sorted(reg.items()))
    combat = rep["combat"]
    check(set(combat) == {"tm:carrier", "tm:hauler", "tm:pouncer", "tm:rider"},
          "combat-sensitive: own calls, a mod goal, an anonymous LeapAtTargetGoal, an inherited override: %s" % sorted(combat))
    check(any("calls isVehicle" in w for w in combat.get("tm:carrier", [])) and any("ejectPassengers" in w for w in combat.get("tm:carrier", [])),
          "carrier reasons name the calls: %s" % combat.get("tm:carrier"))
    check(any("CarryGoal" in w and "getFirstPassenger" in w for w in combat.get("tm:hauler", [])), "hauler flagged through its goal class")
    check(any("LeapAtTargetGoal" in w for w in combat.get("tm:pouncer", [])), "pouncer flagged through LeapAtTargetGoal")
    check(any("positionRider" in w for w in combat.get("tm:rider", [])), "rider flagged through its superclass override")
    check(rep["idle"] == ["tm:walker"], "idle strollers (a RandomStrollGoal subclass) reported apart: %s" % rep["idle"])
    check("tm:tall" not in combat and "tm:victim" not in combat,
          "a riding-offset override and a client model asking isVehicle do not count")
    check(ps.vanilla_goals(mcj) == ["LeapAtTargetGoal", "RandomStrollGoal", "WaterAvoidingRandomStrollGoal"],
          "vanilla recompute: direct isVehicle callers closed over subclasses: %s" % ps.vanilla_goals(mcj))

    # --check-script against a synthetic script
    good = os.path.join(TMP, "good.js")
    open(good, "w", encoding="utf-8").write("var PNE_VIS_NO_GRAFT = {\n  'tm:carrier': 1, 'tm:hauler': 1,\n  'tm:pouncer': 1, 'tm:rider': 1\n}\n")
    bad = os.path.join(TMP, "bad.js")
    open(bad, "w", encoding="utf-8").write("var PNE_VIS_NO_GRAFT = { 'tm:carrier': 1, 'tm:nobody': 1 }\n")
    rc, txt = cli(["--jar", mod, "--check-script", good])
    check(rc == 0 and "covers all 4" in txt, "--check-script passes when the list covers the scan")
    rc, txt = cli(["--jar", mod, "--check-script", bad])
    check(rc == 1 and "tm:hauler changes how it fights" in txt and "lists tm:nobody" in txt,
          "--check-script fails on a missing id and on an unregistered id")
    check(ps.script_no_graft(bad) == {"tm:carrier", "tm:nobody"}, "the script's list is parsed")
    rpt = os.path.join(TMP, "scan.json")
    rc, txt = cli(["--jar", mod, "--out", rpt])
    check(rc == 0 and os.path.isfile(rpt), "--out into the temp folder works")
    repo_out = os.path.join(REPO, "tools", "visual", "scan_should_not_exist.json")
    rc, txt = cli(["--jar", mod, "--out", repo_out])
    check(rc == 2 and "REFUSED" in txt and not os.path.exists(repo_out), "--out into the repository is refused")
    rc, txt = cli(["--instance", os.path.join(TMP, "none")])
    check(rc == 3, "exit 3 without a jar")

    notes = []
    listed = ps.script_no_graft(SCRIPT)
    check(listed is not None and len(listed) > 0, "pne_visual.js declares PNE_VIS_NO_GRAFT")
    inst = os.environ.get("PNE_INSTANCE") or ""
    jars = ps.find_jars(inst) if inst else []
    if jars:
        reps = [ps.scan(j, ns) for j, ns in jars]
        need = set()
        known = set()
        for rr in reps:
            check(rr["unparsed"] == 0, "real jar %s: every class parsed" % rr["jar"])
            check(rr["entities"] >= 50, "real jar %s: >= 50 entity ids recovered (%d)" % (rr["jar"], rr["entities"]))
            need |= set(rr["combat"])
            known |= set(rr["registry"])
            notes.append("%s: %d ids, %d no-graft, %d idle" % (rr["namespace"], rr["entities"], len(rr["combat"]), len(rr["idle"])))
        spore = [rr for rr in reps if rr["namespace"] == "spore"]
        if spore:
            s = spore[0]["combat"]
            check(all(x in s for x in ("spore:busser", "spore:umarmed", "spore:brute", "spore:leaper", "spore:kraken", "spore:ogre")),
                  "real Spore jar: the carriers and grabbers read with javap are found: %s" % sorted(s))
            check(spore[0]["registry"].get("spore:busser", "").endswith("/Busser") and
                  spore[0]["registry"].get("spore:umarmed", "").endswith("/Umarmer"), "real Spore registry: busser, umarmed")
        epca = [rr for rr in reps if rr["namespace"] == "epca"]
        if epca:
            check(epca[0]["registry"].get("epca:ripper", "").endswith("/Ripper"), "real EPCA registry: ripper")
        missing = sorted(need - (listed or set()))
        check(not missing, "pne_visual.js PNE_VIS_NO_GRAFT covers every combat-sensitive id; missing: %s" % missing)
        unknown = sorted(x for x in (listed or set()) if x not in known)
        check(not unknown, "every PNE_VIS_NO_GRAFT id is a registered entity id; unknown: %s" % unknown)
    else:
        notes.append("real jars not present")
    mcsrg = os.environ.get("PNE_MC_SRG") or ""
    if mcsrg and os.path.isfile(mcsrg):
        v = ps.vanilla_goals(mcsrg)
        check(set(v) == ps.VANILLA_COMBAT | ps.VANILLA_IDLE,
              "client jar: goals that check isVehicle = combat + idle lists (%s)" % ", ".join(v))
        notes.append("client jar: %d vanilla goals" % len(v))
        phys = ps.vehicle_physics(mcsrg)
        check(phys.get("Entity.push(Entity) tests isVehicle") is True,
              "client jar: Entity.push(Entity) tests isVehicle (a grafted host is not pushed while it carries its graft)")
        notes.append("Entity.push tests isVehicle: %s" % phys.get("Entity.push(Entity) tests isVehicle"))
    else:
        notes.append("client jar not present")

    for f in fails:
        print("  FAIL  " + f)
    if fails:
        print("FAIL %d of %d visual-passenger-scan checks" % (len(fails), n[0]))
        return 1
    print("PASS %d visual-passenger-scan checks (%s)" % (n[0], "; ".join(notes)))
    return 0


def run():
    global TMP
    os.makedirs(TMP_ROOT, exist_ok=True)
    TMP = tempfile.mkdtemp(prefix="visual_pscan_", dir=TMP_ROOT)
    try:
        return main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(run())
