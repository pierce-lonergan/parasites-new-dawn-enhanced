import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.NativeJavaClass;
import dev.latvian.mods.rhino.RhinoException;
import dev.latvian.mods.rhino.Scriptable;
import dev.latvian.mods.rhino.ScriptableObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Runs KubeJS scripts inside the exact Rhino fork KubeJS 2001.6.5 ships (rhino-forge-2001.2.3-build.10).
 *
 * Modes:
 *   compile FILE...            KubeJS-preprocess each file (ScriptFileInfo.preload: lines that start with
 *                              "import" or "//" are blanked; "// key: value" comments become properties) and
 *                              compile it. Prints the priority header. Exit 1 on any syntax error or a
 *                              non-integer priority (KubeJS would throw Integer.parseInt on it).
 *   run EXPR FILE...           Evaluates the files, in order, in one scope (like one KubeJS script pack), with
 *                              the bindings global (a shared java.util.HashMap), console, Java.loadClass (with a
 *                              replica of KubeJS's class filter) and, when Brigadier is on the classpath, __brig.
 *                              Then evaluates EXPR and prints it. Exit 1 on any exception.
 *                              Like KubeJS (ScriptManager.load -> Context.setRemapper), run mode installs the fork's
 *                              MinecraftRemapper from the Rhino jar's own mm.jsmappings when slf4j is on the
 *                              classpath, so Minecraft classes expose only their Mojang member names (SRG names
 *                              such as m_128405_ are invisible, exactly as in game). The binding __pneRemap says
 *                              which remapper is active ('minecraft', or 'none ...').
 *
 * Build and run through tools/rhino/pne_rhino.py (pins JDK 17; the javac on PATH may be Java 8).
 */
public class PneRhino {
    static final Pattern PROPERTY = Pattern.compile("^(\\w+)\\s*[:=]?\\s*(-?\\w+)$");

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: PneRhino compile FILE... | run EXPR FILE...");
            System.exit(2);
        }
        if (args[0].equals("compile")) System.exit(compile(args));
        if (args[0].equals("run")) System.exit(run(args));
        System.err.println("unknown mode " + args[0]);
        System.exit(2);
    }

    /** Emulates dev.latvian.mods.kubejs.script.ScriptFileInfo.preload (2001.6.5 bytecode). */
    static String preprocess(String src, Map<String, List<String>> props) {
        String[] lines = src.split("\r?\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String t = lines[i].trim();
            if (t.isEmpty() || t.startsWith("import")) {
                lines[i] = "";
            } else if (t.startsWith("//")) {
                Matcher m = PROPERTY.matcher(t.substring(2).trim());
                if (m.find()) props.computeIfAbsent(m.group(1).trim(), k -> new ArrayList<>()).add(m.group(2).trim());
                lines[i] = "";
            }
        }
        return String.join("\n", lines);
    }

    static String read(String file) throws Exception {
        return new String(Files.readAllBytes(Paths.get(file)), StandardCharsets.UTF_8);
    }

    static int compile(String[] args) throws Exception {
        int bad = 0;
        Context cx = Context.enter();
        for (int i = 1; i < args.length; i++) {
            String file = args[i];
            Map<String, List<String>> props = new LinkedHashMap<>();
            String src = preprocess(read(file), props);
            String prio = "0";
            List<String> p = props.get("priority");
            if (p != null && !p.isEmpty()) prio = p.get(p.size() - 1);
            try {
                Integer.parseInt(prio);
            } catch (NumberFormatException e) {
                System.out.println("FAIL " + file + ": priority header '" + prio + "' is not an integer (KubeJS would throw)");
                bad++;
                continue;
            }
            for (String key : new String[]{"ignored", "ignore", "packmode", "requires"}) {
                if (props.containsKey(key)) {
                    System.out.println("FAIL " + file + ": comment line '// " + key + ": " + props.get(key) + "' is read by KubeJS as a file property");
                    bad++;
                }
            }
            try {
                cx.compileString(src, file, 1, null);
                System.out.println("OK   " + file + " (priority " + prio + ")");
            } catch (RhinoException e) {
                System.out.println("FAIL " + file + ":" + e.lineNumber() + ": " + e.details());
                bad++;
            }
        }
        return bad == 0 ? 0 : 1;
    }

    /** Installs dev.latvian.mods.rhino.mod.util.MinecraftRemapper from /mm.jsmappings (gzip) in the Rhino jar. */
    static String remapper(Context cx) {
        java.io.InputStream in = Context.class.getResourceAsStream("/mm.jsmappings");
        if (in == null) return "none (no mm.jsmappings in the Rhino jar)";
        java.io.PrintStream err = System.err;
        try {
            // slf4j prints a "no providers" notice on first use; keep test output clean
            System.setErr(new java.io.PrintStream(java.io.OutputStream.nullOutputStream()));
            cx.setRemapper(dev.latvian.mods.rhino.mod.util.MinecraftRemapper.load(
                    new java.io.BufferedInputStream(new java.util.zip.GZIPInputStream(in)), false));
            return "minecraft";
        } catch (Throwable t) {
            return "none (" + t + ")";
        } finally {
            System.setErr(err);
            try { in.close(); } catch (Exception e) { }
        }
    }

    static int run(String[] args) throws Exception {
        Context cx = Context.enter();
        cx.setClassShutter((name, type) -> KubeFilter.allowed(name));
        String remap = remapper(cx);
        ScriptableObject scope = cx.initStandardObjects();
        ScriptableObject.putProperty(scope, "__pneRemap", remap, cx);
        HashMap<String, Object> global = new HashMap<>();
        ScriptableObject.putProperty(scope, "global", Context.javaToJS(cx, global, scope), cx);
        ScriptableObject.putProperty(scope, "console", Context.javaToJS(cx, new Console(), scope), cx);
        ScriptableObject.putProperty(scope, "Java", Context.javaToJS(cx, new JavaWrapper(cx, scope), scope), cx);
        Object brig = Brig.create();
        if (brig != null) ScriptableObject.putProperty(scope, "__brig", Context.javaToJS(cx, brig, scope), cx);
        try {
            for (int i = 2; i < args.length; i++) {
                Map<String, List<String>> props = new HashMap<>();
                cx.evaluateString(scope, preprocess(read(args[i]), props), args[i], 1, null);
            }
            Object r = cx.evaluateString(scope, args[1], "expr", 1, null);
            System.out.println(cx.toString(r));
            return 0;
        } catch (RhinoException e) {
            System.out.println("FAIL " + e.sourceName() + ":" + e.lineNumber() + ": " + e.details());
            String st = e.getScriptStackTrace();
            if (st != null && !st.isEmpty()) System.out.println(st);
            return 1;
        } catch (Throwable t) {
            System.out.println("FAIL " + t);
            return 1;
        }
    }

    /** Stand-in for KubeJS's ConsoleJS: prints one line per call. */
    public static class Console {
        public void info(Object o) { System.out.println("[info] " + o); }
        public void warn(Object o) { System.out.println("[warn] " + o); }
        public void error(Object o) { System.out.println("[error] " + o); }
        public void log(Object o) { System.out.println("[log] " + o); }
        public void debug(Object o) { }
    }

    /** Stand-in for KubeJS's JavaWrapper.loadClass, filtered like the real ClassFilter. */
    public static class JavaWrapper {
        private final Context cx;
        private final Scriptable scope;
        JavaWrapper(Context cx, Scriptable scope) { this.cx = cx; this.scope = scope; }
        public Object loadClass(String name) throws Exception {
            if (!KubeFilter.allowed(name)) throw new IllegalStateException("Class " + name + " is not allowed by the KubeJS class filter");
            return new NativeJavaClass(cx, scope, Class.forName(name));
        }
    }

    /**
     * Replica of dev.latvian.mods.kubejs.util.ClassFilter.isAllowed0 plus the rules registered by
     * BuiltinKubeJSPlugin and BuiltinKubeJSForgePlugin (read from the 2001.6.5 bytecode):
     * exact deny, exact allow, deny prefix, otherwise allow.
     */
    public static class KubeFilter {
        static final Set<String> denyStrong = new HashSet<>();
        static final List<String> denyWeak = new ArrayList<>();
        static final Set<String> allowStrong = new HashSet<>();
        static void deny(String s) { denyStrong.add(s); if (!denyWeak.contains(s)) denyWeak.add(s); }
        static void allow(String s) { allowStrong.add(s); }
        static {
            deny("java.lang");
            for (String s : new String[]{"java.lang.Number", "java.lang.String", "java.lang.Character", "java.lang.Byte", "java.lang.Short",
                    "java.lang.Integer", "java.lang.Long", "java.lang.Float", "java.lang.Double", "java.lang.Boolean", "java.lang.Runnable",
                    "java.lang.Iterable", "java.lang.Comparable", "java.lang.CharSequence", "java.lang.Void", "java.lang.Package",
                    "java.lang.Appendable", "java.lang.AutoCloseable", "java.lang.Object", "java.lang.StringBuilder",
                    "java.math.BigInteger", "java.math.BigDecimal"}) allow(s);
            deny("java.io"); allow("java.io.Closeable"); allow("java.io.Serializable");
            deny("java.nio"); allow("java.nio.ByteOrder");
            allow("java.util"); deny("java.util.jar"); deny("java.util.zip");
            allow("it.unimi.dsi.fastutil");
            allow("dev.latvian.mods.kubejs"); deny("dev.latvian.mods.kubejs.script"); deny("dev.latvian.mods.kubejs.mixin");
            deny("dev.latvian.mods.kubejs.KubeJSPlugin"); deny("dev.latvian.mods.kubejs.util.KubeJSPlugins");
            allow("net.minecraft"); allow("com.mojang.authlib.GameProfile"); allow("com.mojang.util.UUIDTypeAdapter");
            allow("com.mojang.brigadier"); allow("com.mojang.blaze3d"); allow("dev.architectury");
            deny("java.net"); deny("sun"); deny("com.sun"); deny("io.netty"); deny("org.objectweb.asm");
            deny("org.spongepowered.asm"); deny("org.openjdk.nashorn"); deny("jdk.nashorn"); allow("mezz.jei");
            allow("net.minecraftforge"); deny("net.minecraftforge.fml"); deny("net.minecraftforge.accesstransformer");
            deny("net.minecraftforge.coremod"); deny("cpw.mods.modlauncher"); deny("cpw.mods.gross");
        }
        public static boolean allowed(String name) {
            if (name.startsWith("PneRhino")) return true;
            if (denyStrong.contains(name)) return false;
            if (allowStrong.contains(name)) return true;
            for (String p : denyWeak) if (name.startsWith(p)) return false;
            return true;
        }
    }

    /**
     * Real Brigadier (com.mojang.brigadier, from the Minecraft libraries) exposed to scripts as __brig, so a test
     * can check that the Rhino fork adapts JS functions to Brigadier's Command and Predicate interfaces.
     * Loaded by reflection so the harness still runs when Brigadier is not on the classpath.
     */
    public static class Brig {
        static Object create() {
            try {
                Class.forName("com.mojang.brigadier.CommandDispatcher");
                return Class.forName("PneRhinoBrig").getDeclaredConstructor().newInstance();
            } catch (Throwable t) {
                return null;
            }
        }
    }
}
