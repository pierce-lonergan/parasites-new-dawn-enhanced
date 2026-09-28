"""
Which parasites change how they fight when something rides them? (evidence for PNE_VIS_NO_GRAFT in pne_visual.js)

A display graft is an item_display PASSENGER of its host. The host's AI does not hand control to a display (only a Mob
passenger takes over MOVE/LOOK), but every goal or entity method that asks "am I a vehicle?" sees the graft:

- vanilla goals that return false from canUse() while the mob is a vehicle (Entity.isVehicle, SRG m_20160_), read from
  the 1.20.1 client jar: LeapAtTargetGoal and PathfindToRaidGoal (combat), and the idle strolls RandomStrollGoal (with
  its subclasses), StrollThroughVillageGoal and RunAroundLikeCrazyGoal (idle wandering only);
- mod code that calls the vehicle side of the passenger API (isVehicle, getFirstPassenger, getPassengers,
  ejectPassengers, hasPassenger, getControllingPassenger) or overrides it (positionRider, addPassenger, removePassenger,
  canAddPassenger): Spore's carriers and grabbers (Busser, Brute, Umarmer, Ogre, ...).

This tool reads YOUR OWN mod jar (standard library only, nothing is written unless --out is given, never into the
repository) and reports, per registered entity id:
  combat  the entity (its class, a superclass inside the mod, an inner class, or a mod goal class it uses) calls or
          overrides the vehicle-side passenger API, or uses a vanilla combat goal that checks isVehicle. A graft would
          change how it fights, so pne_visual.js must never graft it (PNE_VIS_NO_GRAFT).
  idle    the entity uses a vanilla idle stroll goal: a graft would stop its idle wandering. Reported only:
          pne_visual.js grafts a host only while it targets a player (and removes the graft PNE_VIS_LINGER ticks after
          it stops), so no idle host is ever a vehicle.
Besides goals, vanilla Entity.push(Entity) skips pushing a vehicle (it tests isVehicle for each side), so a grafted
host is not pushed by other entities while it fights; --mcjar reports that too.
Client-side classes (a path segment named "client", any case) are ignored: models that ask isVehicle only animate.

Entity ids come from the registry code: every EntityType factory method reference (Class::new with the entity
constructor (EntityType, Level)) is paired with the nearest id string in the same method (EPCA: the string before
the factory in <clinit>; Spore: the string after it inside the registration lambda).

Usage:
    python tools/visual/passenger_scan.py --instance "<instance>"                 both jars (EPCA and Spore), summary
    python tools/visual/passenger_scan.py --jar PATH [--namespace NS] [--json]
    python tools/visual/passenger_scan.py --instance "<instance>" --check-script overrides/kubejs/server_scripts/pne_visual.js
        exits 1 when a combat-sensitive id is missing from PNE_VIS_NO_GRAFT, or a listed id is not registered
    python tools/visual/passenger_scan.py --mcjar PATH                             recompute the vanilla goal lists
"""
import argparse
import glob
import json
import os
import re
import struct
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import etf_variants_local as etf  # noqa: E402  (shared output guard)

ENTITY = "net/minecraft/world/entity/Entity"
GOAL = "net/minecraft/world/entity/ai/goal/Goal"
GOAL_PKG = "net/minecraft/world/entity/ai/goal/"
# Vehicle side of the passenger API (1.20.1 SRG names, checked against the client jar's mappings).
VEHICLE_CALLS = {
    "m_20160_": "isVehicle", "m_146895_": "getFirstPassenger", "m_20197_": "getPassengers",
    "m_20153_": "ejectPassengers", "m_20363_": "hasPassenger", "m_6688_": "getControllingPassenger",
}
VEHICLE_OVERRIDES = {
    "m_19956_": "positionRider", "m_20348_": "addPassenger", "m_20351_": "removePassenger", "m_7310_": "canAddPassenger",
}
# Vanilla goals whose canUse() is false while the mob is a vehicle (recomputed from the client jar by the test).
VANILLA_COMBAT = {"LeapAtTargetGoal", "PathfindToRaidGoal"}
VANILLA_IDLE = {"RandomStrollGoal", "WaterAvoidingRandomStrollGoal", "WaterAvoidingRandomFlyingGoal", "RandomSwimmingGoal",
                "GolemRandomStrollInVillageGoal", "MoveBackToVillageGoal", "StrollThroughVillageGoal",
                "RunAroundLikeCrazyGoal"}
FACTORY_DESC = "(Lnet/minecraft/world/entity/EntityType;Lnet/minecraft/world/level/Level;)V"
ID_RX = re.compile(r"^[a-z0-9_][a-z0-9_./-]*$")

# Instruction lengths (opcode -> bytes), enough to walk method code.
_LEN = {}
for _op in range(0x00, 0x10):
    _LEN[_op] = 1
_LEN.update({0x10: 2, 0x11: 3, 0x12: 2, 0x13: 3, 0x14: 3})
for _op in range(0x15, 0x1A):
    _LEN[_op] = 2
for _op in range(0x1A, 0x36):
    _LEN[_op] = 1
for _op in range(0x36, 0x3B):
    _LEN[_op] = 2
for _op in range(0x3B, 0x84):
    _LEN[_op] = 1
_LEN[0x84] = 3
for _op in range(0x85, 0x99):
    _LEN[_op] = 1
for _op in range(0x99, 0xA9):
    _LEN[_op] = 3
_LEN[0xA9] = 2
for _op in range(0xAC, 0xB2):
    _LEN[_op] = 1
for _op in range(0xB2, 0xB9):
    _LEN[_op] = 3
_LEN.update({0xB9: 5, 0xBA: 5, 0xBB: 3, 0xBC: 2, 0xBD: 3, 0xBE: 1, 0xBF: 1, 0xC0: 3, 0xC1: 3, 0xC2: 1, 0xC3: 1,
             0xC5: 4, 0xC6: 3, 0xC7: 3, 0xC8: 5, 0xC9: 5})
INVOKES = (0xB6, 0xB7, 0xB8, 0xB9)


class ClassFile:
    """Constant pool (with method handles), super class, methods (name, descriptor, code), bootstrap methods."""

    def __init__(self, data):
        if data[:4] != b"\xca\xfe\xba\xbe":
            raise ValueError("not a class file")
        self.cp = [None]
        pos = 10
        count = struct.unpack(">H", data[8:10])[0]
        i = 1
        while i < count:
            tag = data[pos]
            pos += 1
            if tag == 1:
                n = struct.unpack(">H", data[pos:pos + 2])[0]
                self.cp.append(("Utf8", data[pos + 2:pos + 2 + n].replace(b"\xc0\x80", b"\x00").decode("utf-8", "replace")))
                pos += 2 + n
            elif tag in (3, 4):
                self.cp.append(("Num", None))
                pos += 4
            elif tag in (5, 6):
                self.cp.append(("Num", None))
                self.cp.append(None)
                pos += 8
                i += 1
            elif tag in (7, 8, 16, 19, 20):
                self.cp.append(({7: "Class", 8: "String", 16: "MethodType", 19: "Module", 20: "Package"}[tag],
                                struct.unpack(">H", data[pos:pos + 2])[0]))
                pos += 2
            elif tag in (9, 10, 11, 12, 17, 18):
                a, b = struct.unpack(">HH", data[pos:pos + 4])
                self.cp.append(({9: "Field", 10: "Method", 11: "IMethod", 12: "NaT", 17: "Dynamic", 18: "Indy"}[tag], (a, b)))
                pos += 4
            elif tag == 15:
                kind, ref = struct.unpack(">BH", data[pos:pos + 3])
                self.cp.append(("Handle", (kind, ref)))
                pos += 3
            else:
                raise ValueError("bad constant pool tag %d" % tag)
            i += 1
        _acc, this_i, super_i = struct.unpack(">HHH", data[pos:pos + 6])
        self.this = self.cls_name(this_i)
        self.super = self.cls_name(super_i) if super_i else ""
        pos += 6
        nif = struct.unpack(">H", data[pos:pos + 2])[0]
        self.interfaces = [self.cls_name(struct.unpack(">H", data[pos + 2 + 2 * k:pos + 4 + 2 * k])[0]) for k in range(nif)]
        pos += 2 + 2 * nif
        self.methods = []
        for kind in ("fields", "methods"):
            n = struct.unpack(">H", data[pos:pos + 2])[0]
            pos += 2
            for _ in range(n):
                _a, name, desc, na = struct.unpack(">HHHH", data[pos:pos + 8])
                pos += 8
                code = None
                attrs = {}
                for _k in range(na):
                    an, alen = struct.unpack(">HI", data[pos:pos + 6])
                    body = data[pos + 6:pos + 6 + alen]
                    if kind == "methods" and self.utf(an) == "Code":
                        code = body[8:8 + struct.unpack(">I", body[4:8])[0]]
                    elif kind == "methods":
                        attrs[self.utf(an)] = body
                    pos += 6 + alen
                if kind == "methods":
                    self.methods.append({"name": self.utf(name), "desc": self.utf(desc), "code": code, "attrs": attrs})
        self.bootstrap = []
        self.attrs = {}
        na = struct.unpack(">H", data[pos:pos + 2])[0]
        pos += 2
        for _k in range(na):
            an, alen = struct.unpack(">HI", data[pos:pos + 6])
            self.attrs[self.utf(an)] = data[pos + 6:pos + 6 + alen]
            if self.utf(an) == "BootstrapMethods":
                b = data[pos + 6:pos + 6 + alen]
                nb = struct.unpack(">H", b[0:2])[0]
                q = 2
                for _j in range(nb):
                    ref, nargs = struct.unpack(">HH", b[q:q + 4])
                    args = [struct.unpack(">H", b[q + 4 + 2 * t:q + 6 + 2 * t])[0] for t in range(nargs)]
                    self.bootstrap.append((ref, args))
                    q += 4 + 2 * nargs
            pos += 6 + alen

    def utf(self, i):
        e = self.cp[i] if 0 < i < len(self.cp) else None
        return e[1] if e and e[0] == "Utf8" else ""

    def cls_name(self, i):
        e = self.cp[i] if 0 < i < len(self.cp) else None
        return self.utf(e[1]) if e and e[0] == "Class" else ""

    def string(self, i):
        e = self.cp[i] if 0 < i < len(self.cp) else None
        return self.utf(e[1]) if e and e[0] == "String" else None

    def member(self, i):
        e = self.cp[i] if 0 < i < len(self.cp) else None
        if not e or e[0] not in ("Field", "Method", "IMethod"):
            return None
        nat = self.cp[e[1][1]]
        return self.cls_name(e[1][0]), self.utf(nat[1][0]), self.utf(nat[1][1])

    def classes(self):
        """Every class named by a Class constant (includes the super class, new, checkcast, instanceof)."""
        return {self.utf(e[1]) for e in self.cp if e and e[0] == "Class"}

    def handle_ctor(self, i):
        """(class, descriptor) when constant i is a REF_newInvokeSpecial method handle, else None."""
        e = self.cp[i] if 0 < i < len(self.cp) else None
        if not e or e[0] != "Handle" or e[1][0] != 8:
            return None
        m = self.member(e[1][1])
        return (m[0], m[2]) if m and m[1] == "<init>" else None

    def indy_ctors(self, indy_index):
        e = self.cp[indy_index] if 0 < indy_index < len(self.cp) else None
        if not e or e[0] != "Indy" or e[1][0] >= len(self.bootstrap):
            return []
        out = []
        for a in self.bootstrap[e[1][0]][1]:
            h = self.handle_ctor(a)
            if h:
                out.append(h)
        return out


def instructions(code):
    """Yields (opcode, constant index or None) for every instruction (ldc, ldc_w, field/method refs, indy, new)."""
    pc = 0
    n = len(code)
    while pc < n:
        op = code[pc]
        idx = None
        if op == 0xAA:
            p = (pc + 4) & ~3
            low, high = struct.unpack(">ii", code[p + 4:p + 12])
            size = p + 12 + 4 * (high - low + 1) - pc
        elif op == 0xAB:
            p = (pc + 4) & ~3
            size = p + 8 + 8 * struct.unpack(">i", code[p + 4:p + 8])[0] - pc
        elif op == 0xC4:
            size = 6 if code[pc + 1] == 0x84 else 4
        else:
            size = _LEN.get(op, 1)
            if op == 0x12:
                idx = code[pc + 1]
            elif op in (0x13, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBA, 0xBB):
                idx = struct.unpack(">H", code[pc + 1:pc + 3])[0]
        yield op, idx
        pc += size


def is_client(name):
    return any(seg.lower() == "client" for seg in name.split("/")[:-1])


def load_classes(jar):
    out = {}
    bad = 0
    with zipfile.ZipFile(jar) as z:
        for n in z.namelist():
            if not n.endswith(".class") or n.startswith("META-INF/"):
                continue
            try:
                cf = ClassFile(z.read(n))
            except (ValueError, struct.error, IndexError):
                bad += 1
                continue
            out[cf.this] = cf
    return out, bad


def registry(classes, ns):
    """{entity id: class} from EntityType factory method references paired with the nearest id string."""
    found = {}
    for cf in classes.values():
        for m in cf.methods:
            if not m["code"]:
                continue
            stream = []
            for op, idx in instructions(m["code"]):
                if op in (0x12, 0x13) and idx is not None:
                    s = cf.string(idx)
                    if s is not None:
                        stream.append(("s", s))
                elif op == 0xBA and idx is not None:
                    for owner, desc in cf.indy_ctors(idx):
                        if desc == FACTORY_DESC:
                            stream.append(("f", owner))
            for k, (kind, owner) in enumerate(stream):
                if kind != "f":
                    continue
                name = None
                j = k - 1
                while j >= 0 and stream[j][0] == "s":
                    if ID_RX.match(stream[j][1]) and stream[j][1] != ns:
                        name = stream[j][1]
                        break
                    j -= 1
                if name is None:
                    j = k + 1
                    while j < len(stream) and stream[j][0] == "s":
                        if ID_RX.match(stream[j][1]) and stream[j][1] != ns:
                            name = stream[j][1]
                            break
                        j += 1
                if name and ("%s:%s" % (ns, name)) not in found:
                    found["%s:%s" % (ns, name)] = owner
    return found


def chain(classes, name):
    """name and its superclasses inside the jar (stops at the first class outside it)."""
    out = []
    seen = set()
    while name in classes and name not in seen:
        seen.add(name)
        out.append(name)
        name = classes[name].super
    return out, name


def vanilla_goal(name, classes):
    """The vanilla goal a class extends, following superclasses inside the jar ('' if none)."""
    _own, outside = chain(classes, name)
    if outside.startswith(GOAL_PKG):
        return outside[len(GOAL_PKG):]
    return ""


def own_vehicle_use(cf):
    """Reasons this class itself uses the vehicle side of the passenger API."""
    why = set()
    for m in cf.methods:
        if m["name"] in VEHICLE_OVERRIDES:
            why.add("overrides " + VEHICLE_OVERRIDES[m["name"]])
        if not m["code"]:
            continue
        for op, idx in instructions(m["code"]):
            if op in INVOKES and idx is not None:
                mem = cf.member(idx)
                if mem and mem[1] in VEHICLE_CALLS:
                    why.add("calls " + VEHICLE_CALLS[mem[1]])
    return why


def scan(jar, ns=None):
    classes, bad = load_classes(jar)
    if ns is None:
        with zipfile.ZipFile(jar) as z:
            nss = sorted({n.split("/")[1] for n in z.namelist() if n.startswith("assets/") and n.count("/") >= 3 and "/textures/entity/" in n})
        ns = nss[0] if nss else ""
    reg = registry(classes, ns)
    own = {n: own_vehicle_use(cf) for n, cf in classes.items() if not is_client(n)}
    # Mod goal classes: extend a vanilla goal (directly or through mod classes).
    # Mod goal classes: their superclass chain leaves the jar at a vanilla goal class (Goal itself included).
    goal_kind = {}
    for n in classes:
        if is_client(n):
            continue
        base = vanilla_goal(n, classes)
        if not base:
            continue
        own_chain, _out = chain(classes, n)
        why = set()
        for c in own_chain:
            why |= own.get(c, set())
        if base in VANILLA_COMBAT:
            why.add("extends " + base)
        goal_kind[n] = (why, base in VANILLA_IDLE)

    inner = {}
    for n in classes:
        if "$" in n and not is_client(n):
            inner.setdefault(n.split("$", 1)[0], []).append(n)

    combat = {}
    idle = []
    for eid in sorted(reg):
        own_chain, _out = chain(classes, reg[eid])
        why = set()
        is_idle = False
        for c in own_chain:
            group = [c] + sorted(inner.get(c, []))
            refs = set()
            for g in group:
                if g not in goal_kind:
                    why |= own.get(g, set())      # the entity class and its non-goal inner classes
                refs |= classes[g].classes() | {g}
            for r in refs:
                if r.startswith(GOAL_PKG):
                    g = r[len(GOAL_PKG):]
                    if g in VANILLA_COMBAT:
                        why.add("uses " + g)
                    if g in VANILLA_IDLE:
                        is_idle = True
                if r in goal_kind:
                    gw, gi = goal_kind[r]
                    why |= {"goal %s: %s" % (r.rsplit("/", 1)[-1], w) for w in gw}
                    if gi:
                        is_idle = True
        if why:
            combat[eid] = sorted(why)
        elif is_idle:
            idle.append(eid)
    return {"jar": os.path.basename(jar), "namespace": ns, "classes": len(classes), "unparsed": bad,
            "entities": len(reg), "registry": reg, "combat": combat, "idle": idle}


def vanilla_goals(mcjar):
    """Goal classes of the client jar whose canUse checks isVehicle, closed over subclasses (simple names)."""
    classes = {}
    with zipfile.ZipFile(mcjar) as z:
        for n in z.namelist():
            if n.startswith(GOAL_PKG) and n.endswith(".class"):
                cf = ClassFile(z.read(n))
                classes[cf.this] = cf
    direct = set()
    for n, cf in classes.items():
        if "calls isVehicle" in own_vehicle_use(cf):
            direct.add(n)
    out = set(direct)
    changed = True
    while changed:
        changed = False
        for n, cf in classes.items():
            if n not in out and cf.super in out:
                out.add(n)
                changed = True
    return sorted(x[len(GOAL_PKG):] for x in out)


def vehicle_physics(mcjar):
    """Vanilla Entity methods outside the goals that treat a vehicle differently (client jar): {label: bool}."""
    with zipfile.ZipFile(mcjar) as z:
        cf = ClassFile(z.read(ENTITY + ".class"))
    out = {"Entity.push(Entity) tests isVehicle": False}
    for m in cf.methods:
        if m["name"] != "m_7334_" or m["desc"] != "(L" + ENTITY + ";)V" or not m["code"]:
            continue
        for op, idx in instructions(m["code"]):
            mem = cf.member(idx) if op in INVOKES and idx is not None else None
            if mem and mem[1] == "m_20160_":
                out["Entity.push(Entity) tests isVehicle"] = True
    return out


def script_no_graft(path):
    text = open(path, encoding="utf-8").read()
    m = re.search(r"var PNE_VIS_NO_GRAFT = \{(.*?)\}", text, re.S)
    if not m:
        return None
    return set(re.findall(r"'([a-z0-9_]+:[a-z0-9_./-]+)'\s*:", m.group(1)))


def find_jars(instance):
    out = []
    for jar in sorted(glob.glob(os.path.join(instance, "mods", "*.jar"))):
        try:
            with zipfile.ZipFile(jar) as z:
                names = z.namelist()
        except (zipfile.BadZipFile, OSError):
            continue
        for ns in ("epca", "spore"):
            if any(n.startswith("assets/%s/textures/entity/" % ns) for n in names):
                out.append((jar, ns))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance")
    ap.add_argument("--jar")
    ap.add_argument("--namespace")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--out")
    ap.add_argument("--check-script")
    ap.add_argument("--mcjar")
    args = ap.parse_args(argv)
    if args.mcjar:
        print("vanilla goals that check isVehicle: " + ", ".join(vanilla_goals(args.mcjar)))
        for k, v in sorted(vehicle_physics(args.mcjar).items()):
            print("%s: %s" % (k, "yes" if v else "no"))
        return 0
    jars = [(args.jar, args.namespace)] if args.jar else (find_jars(args.instance) if args.instance else [])
    if not jars:
        print("no EPCA or Spore jar found (pass --jar or --instance)")
        return 3
    if args.out:
        try:
            etf.check_output(os.path.dirname(os.path.abspath(args.out)), args.instance)
        except etf.Refused as e:
            print("REFUSED: " + str(e))
            return 2
    reports = [scan(j, ns) for j, ns in jars]
    if args.json or args.out:
        text = json.dumps(reports, indent=2, sort_keys=True)
        if args.out:
            with open(args.out, "w", encoding="utf-8") as f:
                f.write(text + "\n")
            print("wrote " + args.out)
        else:
            print(text)
    else:
        for r in reports:
            print("%s (%s): %d entity ids, %d combat-sensitive to a passenger, %d stroll idly" % (
                r["jar"], r["namespace"], r["entities"], len(r["combat"]), len(r["idle"])))
            for eid, why in sorted(r["combat"].items()):
                print("  no graft  %-28s %s" % (eid, "; ".join(why)))
    rc = 0
    if args.check_script:
        listed = script_no_graft(args.check_script)
        if listed is None:
            print("FAIL: PNE_VIS_NO_GRAFT not found in " + args.check_script)
            return 1
        need = set()
        known = set()
        for r in reports:
            need |= set(r["combat"])
            known |= set(r["registry"])
        missing = sorted(need - listed)
        unknown = sorted(x for x in listed - known if x.split(":")[0] in {r["namespace"] for r in reports})
        for x in missing:
            print("FAIL: %s changes how it fights with a passenger but is not in PNE_VIS_NO_GRAFT" % x)
        for x in unknown:
            print("FAIL: PNE_VIS_NO_GRAFT lists %s, which is not a registered entity id" % x)
        rc = 1 if (missing or unknown) else 0
        if not rc:
            print("PNE_VIS_NO_GRAFT covers all %d combat-sensitive ids (%d listed)" % (len(need), len(listed)))
    return rc


if __name__ == "__main__":
    sys.exit(main())
