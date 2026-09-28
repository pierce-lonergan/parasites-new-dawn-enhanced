"""
Offline EMF groundwork for Spore (TDD 3.5.2 and open question 6): lists every entity model layer and its part names
straight from the bytecode of YOUR OWN Spore jar, so the EMF .jem work can start before the in-game export.

Spore uses vanilla EntityModels (no GeckoLib), and each model class declares
    public static final ModelLayerLocation LAYER_LOCATION = new ModelLayerLocation(new ResourceLocation("spore", "<path>"), "main");
builds its parts with PartDefinition.addOrReplaceChild("<Part>", ...) (SRG m_171599_) and looks them up with
ModelPart.getChild("<Part>") (SRG m_171324_). Renderers reference <Model>.LAYER_LOCATION and their textures
("textures/entity/..."). All of that is read here with a small class-file parser (standard library only).

What stays unconfirmed offline: the .jem file EMF 3.3.9 loads for a modded layer. Its string constants show the
lookup roots "<ns>:emf/cem/<name>" and "optifine/cem/modded/<ns>/<name>", with automated fallbacks, so the report
lists both as CANDIDATES. Confirm them with EMF's own in-game model export before shipping any .jem (and ship only
original work: a .jem that scales existing parts, never Spore's geometry or textures).

Usage:
    python tools/visual/emf_spore_parts.py --instance "<instance>"               JSON report on stdout
    python tools/visual/emf_spore_parts.py --instance "<instance>" --summary     one line per model
    python tools/visual/emf_spore_parts.py --jar PATH --out FILE                 write the report (instance or temp only)
Nothing is written anywhere unless --out is given, and --out may not point into the repository.
"""
import argparse
import glob
import hashlib
import json
import os
import struct
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import etf_variants_local as etf  # noqa: E402  (shared output guard)

MLL = "net/minecraft/client/model/geom/ModelLayerLocation"
RL = "net/minecraft/resources/ResourceLocation"
GET_CHILD = ("net/minecraft/client/model/geom/ModelPart", "m_171324_")
ADD_CHILD = ("net/minecraft/client/model/geom/builders/PartDefinition", "m_171599_")

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


class ClassFile:
    """Just enough of a JVM class file: constant pool, this class, fields and method code."""

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
                raw = data[pos + 2:pos + 2 + n].replace(b"\xc0\x80", b"\x00")
                self.cp.append(("Utf8", raw.decode("utf-8", "replace")))
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
                self.cp.append(("Handle", None))
                pos += 3
            else:
                raise ValueError("bad constant pool tag %d" % tag)
            i += 1
        self.this = self.cls_name(struct.unpack(">H", data[pos + 2:pos + 4])[0])
        pos += 6
        nif = struct.unpack(">H", data[pos:pos + 2])[0]
        pos += 2 + 2 * nif
        self.fields = []
        self.methods = []
        for kind in ("fields", "methods"):
            n = struct.unpack(">H", data[pos:pos + 2])[0]
            pos += 2
            for _ in range(n):
                acc, name, desc, na = struct.unpack(">HHHH", data[pos:pos + 8])
                pos += 8
                code = None
                for _a in range(na):
                    an, alen = struct.unpack(">HI", data[pos:pos + 6])
                    body = data[pos + 6:pos + 6 + alen]
                    if kind == "methods" and self.utf(an) == "Code":
                        clen = struct.unpack(">I", body[4:8])[0]
                        code = body[8:8 + clen]
                    pos += 6 + alen
                getattr(self, kind).append({"acc": acc, "name": self.utf(name), "desc": self.utf(desc), "code": code})

    def utf(self, i):
        e = self.cp[i]
        return e[1] if e and e[0] == "Utf8" else ""

    def cls_name(self, i):
        e = self.cp[i]
        return self.utf(e[1]) if e and e[0] == "Class" else ""

    def string(self, i):
        e = self.cp[i]
        return self.utf(e[1]) if e and e[0] == "String" else None

    def member(self, i):
        """(owner, name, descriptor) of a Fieldref/Methodref/InterfaceMethodref."""
        e = self.cp[i]
        if not e or e[0] not in ("Field", "Method", "IMethod"):
            return None
        nat = self.cp[e[1][1]]
        return self.cls_name(e[1][0]), self.utf(nat[1][0]), self.utf(nat[1][1])


def instructions(code):
    """Yields (offset, opcode, operand index or None) for every instruction."""
    pc = 0
    n = len(code)
    while pc < n:
        op = code[pc]
        if op == 0xAA:
            p = (pc + 4) & ~3
            low, high = struct.unpack(">ii", code[p + 4:p + 12])
            size = p + 12 + 4 * (high - low + 1) - pc
            yield pc, op, None
        elif op == 0xAB:
            p = (pc + 4) & ~3
            npairs = struct.unpack(">i", code[p + 4:p + 8])[0]
            size = p + 8 + 8 * npairs - pc
            yield pc, op, None
        elif op == 0xC4:
            size = 6 if code[pc + 1] == 0x84 else 4
            yield pc, op, None
        else:
            size = _LEN.get(op, 1)
            idx = None
            if op == 0x12:
                idx = code[pc + 1]
            elif size >= 3 and op in (0x13, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8, 0xB9, 0xBB):
                idx = struct.unpack(">H", code[pc + 1:pc + 3])[0]
            yield pc, op, idx
        pc += size


def scan_class(cf):
    """Returns (model or None, renderer or None) facts for one class."""
    layer = None
    parts_add = []
    parts_get = []
    uses_layers = []
    textures = []
    for m in cf.methods:
        code = m["code"]
        if not code:
            continue
        strings = []
        pending = None
        prev_str = None
        for _pc, op, idx in instructions(code):
            if op in (0x12, 0x13) and idx is not None:
                s = cf.string(idx)
                if s is not None:
                    strings.append(s)
                    if pending is None:
                        pending = s
                    if s.startswith("textures/entity/") and s.endswith(".png") and s not in textures:
                        textures.append(s)
                prev_str = s
                continue
            mem = cf.member(idx) if idx is not None and op in (0xB2, 0xB3, 0xB6, 0xB7, 0xB8, 0xB9) else None
            if mem and op in (0xB6, 0xB9) and (mem[0], mem[1]) == GET_CHILD and prev_str:
                if prev_str not in parts_get:
                    parts_get.append(prev_str)
            if mem and op in (0xB6, 0xB9) and (mem[0], mem[1]) == ADD_CHILD:
                if pending and pending not in parts_add:
                    parts_add.append(pending)
                pending = None
            if mem and op == 0xB7 and mem[0] == MLL and mem[1] == "<init>" and len(strings) >= 3 and m["name"] == "<clinit>":
                layer = "%s:%s#%s" % (strings[-3], strings[-2], strings[-1])
            if mem and op == 0xB2 and mem[2] == "L%s;" % MLL and mem[0] != cf.this:
                ref = mem[0] + "." + mem[1]
                if ref not in uses_layers:
                    uses_layers.append(ref)
            prev_str = None
    model = None
    if layer:
        ns, rest = layer.split(":", 1)
        path, lay = rest.split("#", 1)
        name = path if lay == "main" else "%s_%s" % (path, lay)
        model = {
            "class": cf.this.replace("/", "."),
            "layer": layer,
            "parts": parts_add or parts_get,
            "parts_from": "addOrReplaceChild" if parts_add else ("getChild" if parts_get else "none"),
            "emf_candidates": ["assets/%s/emf/cem/%s.jem" % (ns, name),
                               "assets/minecraft/optifine/cem/modded/%s/%s.jem" % (ns, name)],
        }
    renderer = None
    if uses_layers:
        renderer = {"class": cf.this.replace("/", "."), "layers": uses_layers, "textures": textures}
    return model, renderer


def extract(jar, prefix=""):
    models = []
    renderers = []
    errors = 0
    with open(jar, "rb") as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    with zipfile.ZipFile(jar) as z:
        for n in sorted(z.namelist()):
            if not n.endswith(".class") or not n.startswith(prefix):
                continue
            try:
                cf = ClassFile(z.read(n))
            except (ValueError, struct.error, IndexError):
                errors += 1
                continue
            mdl, rnd = scan_class(cf)
            if mdl:
                models.append(mdl)
            if rnd:
                renderers.append(rnd)
    layer_of = {}
    for mdl in models:
        layer_of[mdl["class"].replace(".", "/") + ".LAYER_LOCATION"] = mdl["layer"]
    for r in renderers:
        r["layers"] = [layer_of.get(ref, ref) for ref in r["layers"]]
    return {"jar": os.path.basename(jar), "jar_sha256": sha, "models": models, "renderers": renderers,
            "unparsed_classes": errors,
            "note": "emf_candidates are unconfirmed lookup locations; confirm with EMF's in-game model export"}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance")
    ap.add_argument("--jar")
    ap.add_argument("--out")
    ap.add_argument("--summary", action="store_true")
    ap.add_argument("--prefix", default="", help="only classes under this path (e.g. com/Harbinger/Spore/Client/)")
    args = ap.parse_args(argv)
    jar = args.jar
    if not jar and args.instance:
        cands = [j for j in sorted(glob.glob(os.path.join(args.instance, "mods", "*.jar"))) if os.path.basename(j).lower().startswith("spore")]
        jar = cands[0] if cands else None
    if not jar or not os.path.isfile(jar):
        print("no Spore jar found (pass --jar or --instance)")
        return 3
    if args.out:
        try:
            etf.check_output(os.path.dirname(os.path.abspath(args.out)), args.instance)
        except etf.Refused as e:
            print("REFUSED: " + str(e))
            return 2
    rep = extract(jar, args.prefix)
    if args.summary:
        for m in rep["models"]:
            print("%-40s %-28s %3d parts (%s)" % (m["layer"], m["class"].rsplit(".", 1)[-1], len(m["parts"]), m["parts_from"]))
        print("%d model layers, %d renderers" % (len(rep["models"]), len(rep["renderers"])))
    text = json.dumps(rep, indent=2, sort_keys=True)
    if args.out:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print("wrote " + args.out)
    elif not args.summary:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
