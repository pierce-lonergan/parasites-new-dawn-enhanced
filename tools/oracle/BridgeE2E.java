import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.google.gson.internal.Streams;
import com.google.gson.stream.JsonWriter;
import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.Function;
import dev.latvian.mods.rhino.RhinoException;
import dev.latvian.mods.rhino.ScriptableObject;
import dev.latvian.mods.rhino.mod.util.JsonUtils;

import java.io.BufferedReader;
import java.io.Writer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * End-to-end bridge test: the real pne_oracle_bridge.js in the instance's Rhino fork (class filter, remapper) talks
 * to a real, separately started sidecar through real files, with a JsonIO stand-in that copies KubeJS 2001.6.5's
 * JsonIO exactly: read = Files.isRegularFile ? JsonParser.parseReader -> JsonUtils.toObject (LinkedHashMap,
 * ArrayList, LazilyParsedNumber, String) : null, throwing on a torn file; write = the JsonObject type wrapper
 * (MapJS.json: map values through JsonIO.of, integral doubles in a map written as longs; lists through ListJS.json)
 * -> Files.newBufferedWriter(path) with the default options CREATE, TRUNCATE_EXISTING, WRITE (the file is truncated
 * and rewritten in place; KubeJS 2001.6.5's JsonIO.write deletes the file only for a null object) and a tab-indented,
 * lenient, null-serialising JsonWriter: not atomic, so a reader can see an empty or partial file.
 * With SLOW_MS > 0 every second write stops halfway (flushed) for that long, so the sidecar's torn-read path is
 * exercised the way it happens in game, only more often.
 *
 * Usage: BridgeE2E GAME_DIR TICK_MS SECONDS_RUNNING SECONDS_AFTER_STOP SLOW_MS FILE...
 * Phase 1 ticks the mock server in real time while the sidecar answers; then it creates stop.flag (the only way the
 * sidecar is ever stopped) and keeps ticking. Prints "E2E key=value" lines; the Python runner judges them.
 */
public class BridgeE2E {
    public static class E2EJsonIO {
        final Path game;
        final long slowMs;
        public int reads, torn, writes, slowWrites;
        E2EJsonIO(Path game, long slowMs) { this.game = game; this.slowMs = slowMs; }
        public Object read(String path) throws Exception {
            reads++;
            Path p = game.resolve(path);
            if (!Files.isRegularFile(p)) return null;
            try (BufferedReader r = Files.newBufferedReader(p)) {
                JsonElement e = JsonParser.parseReader(r);
                return JsonUtils.toObject(e);
            } catch (Exception ex) {
                torn++;
                throw ex;
            }
        }
        /** KubeJS JsonIO.of: Map -> MapJS.json, Collection -> ListJS.json, else JsonUtils.of (JsonNull -> null). */
        static JsonElement of(Object o) {
            if (o instanceof JsonElement) return (JsonElement) o;
            if (o instanceof Map) return mapJson((Map<?, ?>) o);
            if (o instanceof Collection) return listJson((Collection<?>) o);
            JsonElement e = JsonUtils.of(o);
            return e == JsonNull.INSTANCE ? null : e;
        }
        static JsonObject mapJson(Map<?, ?> m) {
            JsonObject out = new JsonObject();
            for (Map.Entry<?, ?> en : m.entrySet()) {
                JsonElement v = of(en.getValue());
                if (v instanceof JsonPrimitive && ((JsonPrimitive) v).isNumber() && ((JsonPrimitive) v).getAsNumber() instanceof Double) {
                    double d = ((JsonPrimitive) v).getAsDouble();
                    if (d <= 9.223372036854776E18 && d >= -9.223372036854776E18 && d == (double) (long) d) v = new JsonPrimitive((long) d);
                }
                out.add(String.valueOf(en.getKey()), v);
            }
            return out;
        }
        static JsonArray listJson(Collection<?> c) {
            JsonArray out = new JsonArray();
            for (Object o : c) out.add(of(o));
            return out;
        }
        public void write(String path, Object obj) throws Exception {
            JsonElement e = obj instanceof Map ? mapJson((Map<?, ?>) obj) : null;
            if (e == null) throw new IllegalArgumentException("JsonIO.write needs an object");
            Path p = game.resolve(path);
            if (slowMs > 0 && writes % 2 == 1) {
                java.io.StringWriter sw = new java.io.StringWriter();
                JsonWriter sj = new JsonWriter(sw);
                sj.setIndent("\t");
                sj.setSerializeNulls(true);
                sj.setLenient(true);
                Streams.write(e, sj);
                String text = sw.toString();
                try (Writer w = Files.newBufferedWriter(p)) {       // truncates in place, like JsonIO.write
                    w.write(text, 0, text.length() / 2);
                    w.flush();
                    Thread.sleep(slowMs);
                    w.write(text, text.length() / 2, text.length() - text.length() / 2);
                }
                slowWrites++;
                writes++;
                return;
            }
            try (Writer w = Files.newBufferedWriter(p)) {           // exactly JsonIO.write for a non-null object
                JsonWriter jw = new JsonWriter(w);
                jw.setIndent("\t");
                jw.setSerializeNulls(true);
                jw.setLenient(true);
                Streams.write(e, jw);
            }
            writes++;
        }
    }

    public static void main(String[] a) throws Exception {
        Path game = Paths.get(a[0]);
        long tickMs = Long.parseLong(a[1]);
        int runS = Integer.parseInt(a[2]), afterS = Integer.parseInt(a[3]);
        long slowMs = Long.parseLong(a[4]);
        String[] files = Arrays.copyOfRange(a, 5, a.length);
        Context cx = Context.enter();
        cx.setClassShutter((name, type) -> PneRhino.KubeFilter.allowed(name) || name.startsWith("BridgeE2E"));
        System.out.println("E2E remapper=" + PneRhino.remapper(cx));
        ScriptableObject scope = cx.initStandardObjects();
        ScriptableObject.putProperty(scope, "global", Context.javaToJS(cx, new HashMap<String, Object>(), scope), cx);
        ScriptableObject.putProperty(scope, "console", Context.javaToJS(cx, new PneRhino.Console(), scope), cx);
        ScriptableObject.putProperty(scope, "Java", Context.javaToJS(cx, new PneRhino.JavaWrapper(cx, scope), scope), cx);
        E2EJsonIO io = new E2EJsonIO(game, slowMs);
        try {
            for (String f : files) {
                Map<String, List<String>> props = new HashMap<>();
                cx.evaluateString(scope, PneRhino.preprocess(PneRhino.read(f), props), f, 1, null);
                if (f.replace('\\', '/').endsWith("tools/oracle/ora_mocks.js")) {
                    // the file-map JsonIO of the unit tests is replaced by the real-file one
                    ScriptableObject.putProperty(scope, "JsonIO", Context.javaToJS(cx, io, scope), cx);
                }
            }
            Function tick = (Function) ScriptableObject.getProperty(scope, "pneOraE2eTick", cx);
            Function state = (Function) ScriptableObject.getProperty(scope, "pneOraE2eState", cx);
            ((Function) ScriptableObject.getProperty(scope, "pneOraE2eInit", cx)).call(cx, scope, scope, new Object[0]);
            long next = System.nanoTime();
            int total = (runS + afterS) * 20;
            int stopAt = runS * 20;
            int staleTick = -1, stopTick = -1, freshReads = 0, reads = 0;
            for (int t = 0; t < total; t++) {
                if (t == stopAt) {
                    Files.write(game.resolve("local/pne_oracle/stop.flag"), new byte[0]);
                    stopTick = t;
                }
                Object r = tick.call(cx, scope, scope, new Object[0]);
                String s = cx.toString(r);  // "slot fresh age"
                String[] parts = s.split(" ");
                int slot = Integer.parseInt(parts[0]);
                boolean fresh = parts[1].equals("true");
                if (slot == 10 && t < stopAt) {
                    reads++;
                    if (fresh) freshReads++;
                }
                if (t >= stopAt && !fresh && staleTick < 0) staleTick = t;
                next += tickMs * 1_000_000L;
                long d = next - System.nanoTime();
                if (d > 0) Thread.sleep(d / 1_000_000L, (int) (d % 1_000_000L));
            }
            System.out.println("E2E " + cx.toString(state.call(cx, scope, scope, new Object[0])));
            System.out.println("E2E reads_while_running=" + reads + " fresh_reads=" + freshReads);
            System.out.println("E2E stop_tick=" + stopTick + " stale_after_ticks=" + (staleTick < 0 ? -1 : staleTick - stopTick));
            System.out.println("E2E jsonio_reads=" + io.reads + " jsonio_torn=" + io.torn + " jsonio_writes=" + io.writes + " slow_writes=" + io.slowWrites);
        } catch (RhinoException e) {
            System.out.println("FAIL " + e.sourceName() + ":" + e.lineNumber() + ": " + e.details());
            System.exit(1);
        }
    }
}
