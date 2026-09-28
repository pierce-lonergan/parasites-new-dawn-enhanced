import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.RhinoException;
import dev.latvian.mods.rhino.Scriptable;
import dev.latvian.mods.rhino.ScriptableObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Pack-level harness for the suites in tools/suites/pack.json (tools/tests/pack/run_pack.py builds and runs it).
 *
 * Like KubeJS, it gives each script type its OWN scope in ONE Rhino Context, and every scope shares exactly one
 * binding with the others: global, one java.util.HashMap (contract F5/F6). The driver scripts run in a control scope
 * (the mock world lives there) and create the startup scope and the server scope(s) through the __pack binding:
 *
 *   __pack.newScope()            a fresh scope with the KubeJS-like bindings: global (the shared HashMap), console,
 *                                Java (the class-filter replica of tools/rhino/PneRhino.java) and __pneRemap
 *   __pack.load(scope, file)     KubeJS-preprocesses the file (ScriptFileInfo.preload, as PneRhino) and evaluates it
 *                                in that scope; a syntax or load error is thrown to the caller as a JS exception
 *   __pack.priority(file)        the file's '// priority: N' property (0 when absent; KubeJS rules, last match wins)
 *   __pack.ms()                  wall clock in ms (System.nanoTime), for the harness's own timing report only
 *   __pack.out(text)             prints one line
 *   __brig                       real Brigadier 1.1.8 (tools/rhino/PneRhinoBrig.java) when the jar is on the classpath
 *
 * A /reload is a new server scope loaded with the same files while the world and global survive; a world restart
 * is a new server scope plus a copy of the saved state, driven by the scripts. The game's MinecraftRemapper is
 * installed as in PneRhino (SRG names invisible, F34).
 *
 *   PackRhino EXPR FILE...       evaluates FILE... in the control scope, then prints String(EXPR); exit 1 on an error
 */
public class PackRhino {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: PackRhino EXPR FILE...");
            System.exit(2);
        }
        Context cx = Context.enter();
        cx.setClassShutter((name, type) -> PneRhino.KubeFilter.allowed(name) || name.startsWith("PackRhino"));
        String remap = PneRhino.remapper(cx);
        Pack pack = new Pack(cx, new HashMap<>(), remap);
        Scriptable ctl = pack.newScope();
        Object brig = PneRhino.Brig.create();
        if (brig != null) ScriptableObject.putProperty((ScriptableObject) ctl, "__brig", Context.javaToJS(cx, brig, ctl), cx);
        try {
            for (int i = 1; i < args.length; i++) pack.load(ctl, args[i]);
            Object r = cx.evaluateString(ctl, args[0], "expr", 1, null);
            System.out.println(cx.toString(r));
            System.exit(0);
        } catch (RhinoException e) {
            System.out.println("FAIL " + e.sourceName() + ":" + e.lineNumber() + ": " + e.details());
            String st = e.getScriptStackTrace();
            if (st != null && !st.isEmpty()) System.out.println(st);
            System.exit(1);
        } catch (Throwable t) {
            System.out.println("FAIL " + t);
            System.exit(1);
        }
    }

    public static class Pack {
        private final Context cx;
        private final HashMap<String, Object> global;
        private final String remap;

        Pack(Context cx, HashMap<String, Object> global, String remap) {
            this.cx = cx;
            this.global = global;
            this.remap = remap;
        }

        public Scriptable newScope() {
            ScriptableObject scope = cx.initStandardObjects();
            ScriptableObject.putProperty(scope, "__pneRemap", remap, cx);
            ScriptableObject.putProperty(scope, "global", Context.javaToJS(cx, global, scope), cx);
            ScriptableObject.putProperty(scope, "console", Context.javaToJS(cx, new PneRhino.Console(), scope), cx);
            ScriptableObject.putProperty(scope, "Java", Context.javaToJS(cx, new PneRhino.JavaWrapper(cx, scope), scope), cx);
            ScriptableObject.putProperty(scope, "__pack", Context.javaToJS(cx, this, scope), cx);
            return scope;
        }

        public void load(Scriptable scope, String file) throws Exception {
            Map<String, List<String>> props = new HashMap<>();
            String src = new String(Files.readAllBytes(Paths.get(file)), StandardCharsets.UTF_8);
            cx.evaluateString(scope, PneRhino.preprocess(src, props), file, 1, null);
        }

        public int priority(String file) throws Exception {
            Map<String, List<String>> props = new HashMap<>();
            PneRhino.preprocess(new String(Files.readAllBytes(Paths.get(file)), StandardCharsets.UTF_8), props);
            List<String> p = props.get("priority");
            if (p == null || p.isEmpty()) return 0;
            return Integer.parseInt(p.get(p.size() - 1));
        }

        public double ms() {
            return System.nanoTime() / 1.0e6;
        }

        /** The .js files directly in a folder, sorted by name, joined with '\n' ('' when the folder is missing). */
        public String list(String dir) throws Exception {
            java.io.File[] fs = new java.io.File(dir).listFiles((d, n) -> n.endsWith(".js"));
            if (fs == null) return "";
            java.util.Arrays.sort(fs, (a, b) -> a.getName().compareTo(b.getName()));
            StringBuilder sb = new StringBuilder();
            for (java.io.File f : fs) {
                if (sb.length() > 0) sb.append('\n');
                sb.append(dir).append('/').append(f.getName());
            }
            return sb.toString();
        }

        /** A new game launch: the shared global map starts empty (it survives /reload, not a restart of the game). */
        public void resetGlobal() {
            global.clear();
        }

        /** UTF-8 length in bytes (NBT strings are limited to 65,535 modified-UTF-8 bytes, F11). */
        public int utf8(String s) {
            return s.getBytes(StandardCharsets.UTF_8).length;
        }

        public void out(Object text) {
            System.out.println(String.valueOf(text));
        }
    }
}
