"""
Run KubeJS scripts in the instance's real Rhino jar (rhino-forge-2001.2.3-build.10), with JDK 17 pinned.

    python tools/rhino/pne_rhino.py env                    print the resolved toolchain as JSON
    python tools/rhino/pne_rhino.py compile FILE...        KubeJS-preprocess and compile each file
    python tools/rhino/pne_rhino.py run EXPR FILE...       evaluate files in one scope, print EXPR

Other test suites can `import pne_rhino` (add tools/rhino to sys.path) and call env(), build() and run_java().

Toolchain lookup (nothing personal is written into the repo; paths come from the environment):
  PNE_JDK17      JDK 17 home. Default: C:\\Program Files\\Java\\jdk-17.0.15+6. The javac on PATH may be Java 8,
                 which cannot compile against the class-version-61 jars, so it is never used.
  PNE_INSTANCE   the CurseForge instance folder. Default: the first folder under
                 %USERPROFILE%\\curseforge\\minecraft\\Instances that holds the Rhino jar.
  PNE_MC_LIBS    the Minecraft libraries folder. Default: <instance>\\..\\..\\Install\\libraries.
Exit code 77 means "skipped: toolchain not found" (run_tests.py reports it as SKIP).
"""
import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
RHINO_JAR = "rhino-forge-2001.2.3-build.10.jar"
KUBEJS_JAR = "kubejs-forge-2001.6.5-build.26.jar"
LIBS = {
    "gson": "com/google/code/gson/gson/2.10.1/gson-2.10.1.jar",
    "fastutil": "it/unimi/dsi/fastutil/8.5.9/fastutil-8.5.9.jar",
    "lang3": "org/apache/commons/commons-lang3/3.12.0/commons-lang3-3.12.0.jar",
    "brigadier": "com/mojang/brigadier/1.1.8/brigadier-1.1.8.jar",
    # Needed only to load the Rhino fork's MinecraftRemapper (RemappingHelper logs through slf4j).
    "slf4j": "org/slf4j/slf4j-api/2.0.1/slf4j-api-2.0.1.jar",
    # SRG-named Minecraft classes (net.minecraft.nbt.NbtIo, CompoundTag, ...) for offline NBT tests. Not on the
    # Rhino classpath; suites add it themselves via PNE_MC_SRG.
    "mc_srg": "net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-srg.jar",
}
SKIP = 77


def _jdk():
    home = os.environ.get("PNE_JDK17") or r"C:\Program Files\Java\jdk-17.0.15+6"
    exe = ".exe" if os.name == "nt" else ""
    javac = os.path.join(home, "bin", "javac" + exe)
    java = os.path.join(home, "bin", "java" + exe)
    if not (os.path.isfile(javac) and os.path.isfile(java)):
        return None
    try:
        out = subprocess.run([javac, "-version"], capture_output=True, text=True, timeout=60)
        ver = (out.stdout + out.stderr).strip()
    except Exception:
        return None
    if not ver.startswith("javac 17"):
        raise SystemExit(f"PNE_JDK17 must be a JDK 17 (javac -version said: {ver})")
    return {"home": home, "javac": javac, "java": java, "version": ver}


def _instance():
    inst = os.environ.get("PNE_INSTANCE")
    if inst and os.path.isfile(os.path.join(inst, "mods", RHINO_JAR)):
        return inst
    base = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    for cand in sorted(glob.glob(os.path.join(base, "curseforge", "minecraft", "Instances", "*"))):
        if os.path.isfile(os.path.join(cand, "mods", RHINO_JAR)):
            return cand
    return None


def env():
    """Resolved toolchain, or None entries when something is missing."""
    jdk = _jdk()
    inst = _instance()
    libs_root = os.environ.get("PNE_MC_LIBS")
    if not libs_root and inst:
        libs_root = os.path.normpath(os.path.join(inst, "..", "..", "Install", "libraries"))
    libs = {}
    for key, rel in LIBS.items():
        p = os.path.join(libs_root, *rel.split("/")) if libs_root else None
        libs[key] = p if p and os.path.isfile(p) else None
    rhino = os.path.join(inst, "mods", RHINO_JAR) if inst else None
    kubejs = os.path.join(inst, "mods", KUBEJS_JAR) if inst else None
    return {
        "jdk": jdk,
        "instance": inst,
        "rhino_jar": rhino if rhino and os.path.isfile(rhino) else None,
        "kubejs_jar": kubejs if kubejs and os.path.isfile(kubejs) else None,
        "libs": libs,
        "node": shutil.which("node"),
        "python": sys.executable,
    }


def rhino_classpath(e, extra=()):
    """Rhino plus the libraries it needs at runtime (gson, fastutil, commons-lang3), Brigadier and slf4j if present."""
    parts = list(extra) + [e["rhino_jar"], e["libs"]["gson"], e["libs"]["fastutil"], e["libs"]["lang3"]]
    for opt in ("brigadier", "slf4j"):
        if e["libs"].get(opt):
            parts.append(e["libs"][opt])
    return os.pathsep.join(p for p in parts if p)


def ready(e):
    return bool(e["jdk"] and e["rhino_jar"] and e["libs"]["gson"] and e["libs"]["fastutil"] and e["libs"]["lang3"])


def build(e, sources, tag):
    """Compile Java sources against the Rhino classpath into a temp dir cached by content hash."""
    h = hashlib.sha256()
    for s in sources:
        h.update(open(s, "rb").read())
    h.update(rhino_classpath(e).encode())
    out = os.path.join(tempfile.gettempdir(), "pne_rhino_build", tag + "_" + h.hexdigest()[:12])
    stamp = os.path.join(out, ".ok")
    if not os.path.isfile(stamp):
        os.makedirs(out, exist_ok=True)
        r = subprocess.run([e["jdk"]["javac"], "-nowarn", "-encoding", "UTF-8", "-d", out, "-cp", rhino_classpath(e)] + list(sources),
                           capture_output=True, text=True)
        if r.returncode:
            raise SystemExit("javac failed:\n" + r.stdout + r.stderr)
        open(stamp, "w").close()
    return out


def harness(e):
    srcs = [os.path.join(HERE, "PneRhino.java")]
    if e["libs"]["brigadier"]:
        srcs.append(os.path.join(HERE, "PneRhinoBrig.java"))
    return build(e, srcs, "pnerhino")


def run_java(e, classes_dir, main, args, timeout=600):
    cmd = [e["jdk"]["java"], "-cp", rhino_classpath(e, [classes_dir]), main] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=ROOT)


def main(argv):
    if len(argv) < 2 or argv[1] not in ("env", "compile", "run"):
        print(__doc__)
        return 2
    e = env()
    if argv[1] == "env":
        print(json.dumps(e, indent=2))
        return 0
    if not ready(e):
        print("SKIP: JDK 17, the instance's Rhino jar or its libraries were not found (set PNE_JDK17 / PNE_INSTANCE / PNE_MC_LIBS)")
        return SKIP
    cls = harness(e)
    r = run_java(e, cls, "PneRhino", argv[1:])
    sys.stdout.write(r.stdout)
    sys.stderr.write(r.stderr)
    return r.returncode


if __name__ == "__main__":
    sys.exit(main(sys.argv))
