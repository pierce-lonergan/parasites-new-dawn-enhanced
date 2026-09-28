import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.RhinoException;
import dev.latvian.mods.rhino.ScriptableObject;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * Evaluates JS files in one scope inside the instance's Rhino fork (rhino-forge-2001.2.3-build.10, interpreter
 * only, like KubeJS) and prints the value of an expression.
 *
 *   RhinoRun EXPR FILE...
 *
 * Every file is preprocessed the way KubeJS 2001.6.5 does it (ScriptFileInfo.preload: lines whose trimmed text
 * starts with "import" or "//" are blanked), and KubeFilter is installed as the class shutter. No binding is
 * added (no global, no console, no Java): the GA core and its tests must run without any. Exit 1 on an exception.
 * Build and run through tools/genome/rhino/run.py (JDK 17 pinned).
 */
public class RhinoRun {
    static String preprocess(String src) {
        String[] lines = src.split("\r?\n", -1);
        for (int i = 0; i < lines.length; i++) {
            String t = lines[i].trim();
            if (t.startsWith("import") || t.startsWith("//")) lines[i] = "";
        }
        return String.join("\n", lines);
    }

    static ScriptableObject load(Context cx, String[] files, int from) throws Exception {
        cx.setClassShutter((name, type) -> KubeFilter.allowed(name));
        ScriptableObject scope = cx.initStandardObjects();
        for (int i = from; i < files.length; i++) {
            String src = new String(Files.readAllBytes(Paths.get(files[i])), StandardCharsets.UTF_8);
            cx.evaluateString(scope, preprocess(src), files[i], 1, null);
        }
        return scope;
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("usage: RhinoRun EXPR FILE...");
            System.exit(2);
        }
        Context cx = Context.enter();
        try {
            ScriptableObject scope = load(cx, args, 1);
            Object r = cx.evaluateString(scope, args[0], "expr", 1, null);
            System.out.println(cx.toString(r));
        } catch (RhinoException e) {
            System.out.println("FAIL " + e.sourceName() + ":" + e.lineNumber() + ": " + e.details());
            System.exit(1);
        } catch (Throwable t) {
            System.out.println("FAIL " + t);
            System.exit(1);
        }
    }
}
