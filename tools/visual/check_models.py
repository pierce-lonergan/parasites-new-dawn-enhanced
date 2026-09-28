"""
Suite visual-json: the visual module's model overrides and resource files are valid and consistent.

- overrides/kubejs/assets/minecraft/models/item/iron_axe.json is the vanilla 1.20.1 iron_axe model, key for key
  (read from the client jar when it is present: <instance>/../../Install/versions/1.20.1/1.20.1.jar, or PNE_MC_CLIENT),
  plus exactly one override {custom_model_data: PNE_CORE_AXE_CMD} -> pne:item/empty. PNE_CORE_AXE_CMD is read from
  pne_00_core.js, so the model and the hive's CustomModelData can never disagree.
- pne:item/empty resolves to overrides/kubejs/assets/pne/models/item/empty.json, which has no parent and no
  elements (renders nothing) and only a particle texture that exists in the client jar (when present).
- Every JSON file under the visual module's asset folders parses (models, EMF .jem files).
- Every graft item pne_visual.js names (PNE_VIS_GRAFTS) has an item model in its mod jar or the client jar, when
  those jars are present.
- Every ETF properties file shipped in the repo references only textures that ship next to it (no broken texture
  references), uses only skins/textures/teams/weights keys with our team names, and nothing is animated or blinking.
Prints PASS on success.
"""
import glob
import json
import os
import re
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
KJS = os.path.join(REPO, "overrides", "kubejs")
sys.path.insert(0, HERE)
import etf_variants_local as etf  # noqa: E402

AXE = os.path.join(KJS, "assets", "minecraft", "models", "item", "iron_axe.json")
EMPTY = os.path.join(KJS, "assets", "pne", "models", "item", "empty.json")
CORE = os.path.join(KJS, "server_scripts", "pne_00_core.js")
VISUAL = os.path.join(KJS, "server_scripts", "pne_visual.js")
VANILLA_AXE = {"parent": "minecraft:item/handheld", "textures": {"layer0": "minecraft:item/iron_axe"}}
TEAM_NAMES = {n for pair in etf.TEAMS for n in pair}


def client_jar():
    p = os.environ.get("PNE_MC_CLIENT")
    if p and os.path.isfile(p):
        return p
    inst = os.environ.get("PNE_INSTANCE") or ""
    if inst:
        cand = os.path.normpath(os.path.join(inst, "..", "..", "Install", "versions", "1.20.1", "1.20.1.jar"))
        if os.path.isfile(cand):
            return cand
    return None


def model_path(ref):
    """'ns:item/x' -> overrides/kubejs/assets/ns/models/item/x.json"""
    ns, _, path = ref.partition(":") if ":" in ref else ("minecraft", "", ref)
    return os.path.join(KJS, "assets", ns, "models", *path.split("/")) + ".json"


def main():
    fails = []
    checks = [0]
    n_items = [0]

    def check(cond, msg):
        checks[0] += 1
        if not cond:
            fails.append(msg)

    core = open(CORE, encoding="utf-8").read()
    m = re.search(r"^var PNE_CORE_AXE_CMD = (\d+)", core, re.M)
    check(m is not None, "PNE_CORE_AXE_CMD found in pne_00_core.js")
    cmd = int(m.group(1)) if m else None

    axe = json.load(open(AXE, encoding="utf-8"))
    empty = json.load(open(EMPTY, encoding="utf-8"))
    jar = client_jar()
    vanilla = VANILLA_AXE
    if jar:
        with zipfile.ZipFile(jar) as z:
            vanilla = json.loads(z.read("assets/minecraft/models/item/iron_axe.json"))
            check("assets/minecraft/models/item/handheld.json" in z.namelist(), "vanilla handheld parent exists in the client jar")
            tex = empty.get("textures", {}).get("particle", "")
            check(("assets/minecraft/textures/%s.png" % tex.split(":", 1)[-1]) in z.namelist(), "empty model's particle texture exists")
    for k, v in vanilla.items():
        check(axe.get(k) == v, "iron_axe.json keeps the vanilla '%s' (%r)" % (k, v))
    check(set(axe) == set(vanilla) | {"overrides"}, "iron_axe.json adds only 'overrides' to the vanilla model")
    ov = axe.get("overrides", [])
    check(isinstance(ov, list) and len(ov) == 1, "exactly one override")
    if ov:
        o = ov[0]
        check(o.get("predicate") == {"custom_model_data": cmd}, "override predicate is custom_model_data %s (PNE_CORE_AXE_CMD)" % cmd)
        check(o.get("model") == "pne:item/empty", "override model is pne:item/empty")
        check(os.path.normcase(model_path(o.get("model", ""))) == os.path.normcase(EMPTY), "pne:item/empty resolves to the shipped file")
    cmds = [o.get("predicate", {}).get("custom_model_data", 0) for o in ov]
    check(cmds == sorted(cmds), "overrides sorted by custom_model_data (the last match wins)")
    check("parent" not in empty, "empty model has no parent (no inherited geometry)")
    check(empty.get("elements") == [], "empty model has an empty elements list")
    check(set(empty.get("textures", {})) <= {"particle"}, "empty model defines only a particle texture")
    check(cmd == 7301, "CustomModelData is 7301 as the contract states")

    # graft items referenced by pne_visual.js exist (an item model in the mod jar or the client jar)
    vis = open(VISUAL, encoding="utf-8").read()
    items = re.findall(r"\{ item: '([a-z0-9_]+):([a-z0-9_/]+)'", vis)
    check(len(items) >= 1, "PNE_VIS_GRAFTS items found in pne_visual.js")
    inst = os.environ.get("PNE_INSTANCE") or ""
    for ns, path in items:
        src = jar if ns == "minecraft" else (etf.find_jar(inst, ns) if inst else None)
        if not src:
            continue
        with zipfile.ZipFile(src) as z:
            check("assets/%s/models/item/%s.json" % (ns, path) in z.namelist(),
                  "graft item %s:%s has an item model in %s" % (ns, path, os.path.basename(src)))
        n_items[0] += 1

    # every JSON in the visual asset folders parses
    folders = [os.path.join(KJS, "assets", "minecraft", "models"), os.path.join(KJS, "assets", "pne", "models"),
               os.path.join(KJS, "assets", "spore", "emf"), os.path.join(KJS, "assets", "spore", "optifine", "cem"),
               os.path.join(KJS, "assets", "epca", "optifine", "random", "entity")]
    n_json = 0
    for f in folders:
        for p in glob.glob(os.path.join(f, "**", "*.json"), recursive=True) + glob.glob(os.path.join(f, "**", "*.jem"), recursive=True):
            n_json += 1
            try:
                json.load(open(p, encoding="utf-8"))
                check(True, "")
            except ValueError as e:
                check(False, "%s does not parse: %s" % (os.path.relpath(p, REPO), e))

    # ETF properties shipped in the repo: no broken references, our teams only, nothing animated
    n_props = 0
    for ns in ("epca", "spore"):
        root = os.path.join(KJS, "assets", ns, "optifine", "random", "entity")
        for p in glob.glob(os.path.join(root, "**", "*.properties"), recursive=True):
            n_props += 1
            rel = os.path.relpath(p, root).replace(os.sep, "/")
            props = etf.parse_properties(open(p, encoding="utf-8").read())
            for k, v in props.items():
                kind = k.split(".")[0]
                check(kind in ("skins", "textures", "teams", "team", "weights"), "%s: key %s is allowed" % (rel, k))
                if kind in ("skins", "textures"):
                    for tok in v.split():
                        idx = int(tok.split("-")[0])
                        ref = etf.variant_rel(ns, rel[:-11] + ".png", idx)
                        check(idx == 1 or os.path.isfile(os.path.join(root, ref)), "%s: %s=%s references %s, which must ship" % (rel, k, v, ref))
                if kind in ("teams", "team"):
                    check(set(v.split()) <= TEAM_NAMES, "%s: %s names only pne_clade teams" % (rel, k))
        for p in glob.glob(os.path.join(root, "**", "*"), recursive=True):
            check(not p.endswith(".mcmeta") and "_blink" not in p, "no animated or blinking ETF texture: " + p)

    for f in fails:
        print("  FAIL  " + f)
    if fails:
        print("FAIL %d of %d visual-json checks" % (len(fails), checks[0]))
        return 1
    print("PASS %d visual-json checks (iron_axe vs %s, %d json, %d ETF properties in repo, %d graft items found in jars)" % (
        checks[0], "client jar" if jar else "embedded vanilla copy", n_json, n_props, n_items[0]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
