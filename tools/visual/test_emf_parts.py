"""
Suite visual-emf-tools: tools/visual/emf_spore_parts.py on synthetic classes compiled with JDK 17 into PNE_TMP (stub
ModelLayerLocation / ModelPart / PartDefinition with the SRG method names Spore calls), and, when the instance's Spore
jar is present, on the real jar (facts read with javap: spore:bairnmodel#main, parts Torso/Head/Jaw, BairnRenderer's
textures). Also checks that the report can only be written inside the instance or the temp folder. Prints PASS.
"""
import glob
import json
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
import emf_spore_parts as emf  # noqa: E402
import etf_variants_local as etf  # noqa: E402

# A fresh folder per run under PNE_TMP: several test runs may overlap on one machine.
TMP_ROOT = os.environ.get("PNE_TMP") or os.path.join(tempfile.gettempdir(), "pne_tests")
TMP = None

SOURCES = {
    "net/minecraft/resources/ResourceLocation.java":
        "package net.minecraft.resources; public class ResourceLocation { public ResourceLocation(String a, String b) {} }",
    "net/minecraft/client/model/geom/ModelLayerLocation.java":
        "package net.minecraft.client.model.geom; public class ModelLayerLocation {"
        " public ModelLayerLocation(net.minecraft.resources.ResourceLocation r, String l) {} }",
    "net/minecraft/client/model/geom/ModelPart.java":
        "package net.minecraft.client.model.geom; public class ModelPart { public ModelPart m_171324_(String n) { return this; } }",
    "net/minecraft/client/model/geom/builders/PartDefinition.java":
        "package net.minecraft.client.model.geom.builders; public class PartDefinition {"
        " public PartDefinition m_171599_(String n, Object cubes, Object pose) { return this; } }",
    "com/example/client/FakeModel.java": """
package com.example.client;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.client.model.geom.ModelPart;
import net.minecraft.client.model.geom.builders.PartDefinition;
import net.minecraft.resources.ResourceLocation;
public class FakeModel {
  public static final ModelLayerLocation LAYER_LOCATION = new ModelLayerLocation(new ResourceLocation("spore", "fakemodel"), "main");
  private final ModelPart head;
  public FakeModel(ModelPart root) { this.head = root.m_171324_("Body").m_171324_("Head"); }
  public static void createBodyLayer(PartDefinition pd) {
    PartDefinition body = pd.m_171599_("Body", new float[] {1.5f, 2.5f, 1234567.0f}, "pose-not-a-part");
    body.m_171599_("Head", Double.valueOf(12345678.9), null);
    body.m_171599_("Tail_r1", Long.valueOf(123456789012L), "another");
  }
  static int sw(int x) { switch (x) { case 1: return 5; case 2: return 7; case 3: return 9; default: return 0; } }
  static int lk(int x) { switch (x) { case 10: return 1; case 100000: return 2; default: return 3; } }
  static int wide() { int a = 0; int b1=1,b2=2,b3=3,b4=4,b5=5,b6=6,b7=7,b8=8,b9=9,b10=10; int[] big = new int[300];
    for (int i = 0; i < 300; i++) big[i] = i + b1 + b2 + b3 + b4 + b5 + b6 + b7 + b8 + b9 + b10; return a + big[299]; }
}
""",
    "com/example/client/FakeOuterModel.java": """
package com.example.client;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.client.model.geom.builders.PartDefinition;
import net.minecraft.resources.ResourceLocation;
public class FakeOuterModel {
  public static final ModelLayerLocation LAYER_LOCATION = new ModelLayerLocation(new ResourceLocation("spore", "fakeouter"), "outer");
  public static void createBodyLayer(PartDefinition pd) { pd.m_171599_("Shell", null, null); }
}
""",
    "com/example/client/FakeRenderer.java": """
package com.example.client;
import net.minecraft.client.model.geom.ModelLayerLocation;
import net.minecraft.resources.ResourceLocation;
public class FakeRenderer {
  static final ResourceLocation TEX = new ResourceLocation("spore", "textures/entity/fake.png");
  ModelLayerLocation layer() { return FakeModel.LAYER_LOCATION; }
}
""",
}


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
    jar = os.path.join(TMP, "fake-spore.jar")
    with zipfile.ZipFile(jar, "w") as z:
        for dirpath, _, names in os.walk(out):
            for nme in names:
                full = os.path.join(dirpath, nme)
                z.write(full, os.path.relpath(full, out).replace(os.sep, "/"))
        z.writestr("com/example/client/Broken.class", b"\xca\xfe\xba\xbe\x00\x00\x00\x3d\x00\x05\x07")
        z.writestr("assets/spore/textures/entity/fake.png", b"not scanned")

    rep = emf.extract(jar)
    models = {m["layer"]: m for m in rep["models"]}
    check(set(models) == {"spore:fakemodel#main", "spore:fakeouter#outer"}, "two model layers found: %s" % sorted(models))
    fm = models.get("spore:fakemodel#main", {})
    check(fm.get("parts") == ["Body", "Head", "Tail_r1"], "parts from addOrReplaceChild in order, other strings ignored: %s" % fm.get("parts"))
    check(fm.get("parts_from") == "addOrReplaceChild", "parts taken from addOrReplaceChild")
    check(fm.get("class") == "com.example.client.FakeModel", "model class name")
    check(fm.get("emf_candidates") == ["assets/spore/emf/cem/fakemodel.jem", "assets/minecraft/optifine/cem/modded/spore/fakemodel.jem"],
          "EMF candidate locations for a main layer")
    fo = models.get("spore:fakeouter#outer", {})
    check(fo.get("parts") == ["Shell"] and fo.get("emf_candidates", [""])[0] == "assets/spore/emf/cem/fakeouter_outer.jem",
          "a non-main layer gets the _<layer> suffix in its candidates")
    rends = {x["class"]: x for x in rep["renderers"]}
    fr = rends.get("com.example.client.FakeRenderer", {})
    check(fr.get("layers") == ["spore:fakemodel#main"], "renderer mapped to its model layer: %s" % fr.get("layers"))
    check(fr.get("textures") == ["textures/entity/fake.png"], "renderer textures listed")
    check(rep["unparsed_classes"] == 1, "a broken class file is counted, not fatal")
    check("unconfirmed" in rep["note"], "report says the candidates are unconfirmed")

    # CLI: the report goes only to the instance or the temp folder
    rpt = os.path.join(TMP, "report.json")
    check(emf.main(["--jar", jar, "--out", rpt]) == 0 and json.load(open(rpt, encoding="utf-8"))["models"], "--out into the temp folder works")
    repo_out = os.path.join(REPO, "tools", "visual", "emf_report_should_not_exist.json")
    try:
        etf.check_output(os.path.dirname(repo_out), None)
        guarded = False
    except etf.Refused:
        guarded = True
    check(guarded, "guard refuses the repository")
    if guarded:
        check(emf.main(["--jar", jar, "--out", repo_out]) == 2 and not os.path.exists(repo_out), "--out into the repository is refused")
    check(emf.main(["--instance", os.path.join(TMP, "none")]) == 3, "exit 3 without a Spore jar")

    # the real Spore jar, when present
    inst = os.environ.get("PNE_INSTANCE") or ""
    real = [j for j in sorted(glob.glob(os.path.join(inst, "mods", "*.jar"))) if os.path.basename(j).lower().startswith("spore")] if inst else []
    note = "real Spore jar not present"
    if real:
        rr = emf.extract(real[0])
        rm = {m["layer"]: m for m in rr["models"]}
        check(len(rm) >= 200 and all(m["parts"] for m in rr["models"]), "real jar: >= 200 model layers, each with parts (%d)" % len(rm))
        b = rm.get("spore:bairnmodel#main", {})
        check(all(p in b.get("parts", []) for p in ("Bairn", "Torso", "Head", "Jaw", "LeftArm", "RightLeg")), "real jar: bairnmodel parts")
        br = [x for x in rr["renderers"] if x["class"].endswith(".BairnRenderer")]
        check(br and "spore:bairnmodel#main" in br[0]["layers"] and "textures/entity/bairn/bairn_human.png" in br[0]["textures"],
              "real jar: BairnRenderer -> bairnmodel with bairn_human.png")
        check(rr["unparsed_classes"] == 0, "real jar: every class parsed")
        note = "real jar %s: %d layers, %d renderers" % (os.path.basename(real[0]), len(rm), len(rr["renderers"]))

    for f in fails:
        print("  FAIL  " + f)
    if fails:
        print("FAIL %d of %d visual-emf-tools checks" % (len(fails), n[0]))
        return 1
    print("PASS %d visual-emf-tools checks (%s)" % (n[0], note))
    return 0


def run():
    global TMP
    os.makedirs(TMP_ROOT, exist_ok=True)
    TMP = tempfile.mkdtemp(prefix="visual_emf_", dir=TMP_ROOT)
    try:
        return main()
    finally:
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(run())
