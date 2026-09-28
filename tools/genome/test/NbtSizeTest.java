import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.ScriptableObject;
import dev.latvian.mods.rhino.Wrapper;

import java.io.ByteArrayOutputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Set;
import java.util.TreeSet;

/**
 * Suite hive-nbt-size (TDD 3.7 CI test, contract 4.1 and 9.4): the maximum-size hive state goes through the real
 * NbtIo of Minecraft 1.20.1 and every NBT string stays at or under 60,000 modified-UTF-8 bytes (StringTag.write uses
 * DataOutput.writeUTF, whose hard limit is 65,535).
 *
 *   NbtSizeTest TMPDIR FILE...
 *
 * The files (tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js, pne_00_core.js, pne_hive_core.js, pne_hive.js,
 * tools/hive/nbt_max.js) run inside the instance's own Rhino jar with KubeJS's class filter and the game's
 * MinecraftRemapper (both from tools/rhino/PneRhino.java), so pne_hive.js calls the Mojang names (putString, putIntArray,
 * getCompound, ...) on the SRG-named CompoundTag exactly as it does in game. Steps:
 *   1. pneNbtBuild(): the maximum state saved by the real pneHiveSave into a real CompoundTag (server persistentData).
 *   2. NbtIo.writeCompressed to TMPDIR, NbtIo.readCompressed back, equals() the original.
 *   3. Every StringTag at any depth: modified-UTF-8 length <= 60,000 (and writeUTF accepts it); pne_hive keeps < 64 tags;
 *      base holds IntArrays of 5 ints.
 *   4. pneNbtReload(readBack): the hive loads the read-back tag and reproduces the saved GA state bit for bit.
 *   5. The incremental save of that state (one step at a time, the state changing between every two GA pieces) stores
 *      exactly the one-call save's compound: CompoundTag.equals and identical NbtIo bytes (steps timed and printed).
 * Also prints the main-thread CompoundTag.copy() cost of this state (what KubeJS pays at each overworld save) and the
 * pneHiveSave cost in Rhino. Minecraft classes are reached by reflection with their SRG names (m_...), because this
 * file compiles against the Rhino classpath only; the SRG client jar, Guava, DataFixerUpper and Mojang logging are
 * added at run time by tools/hive/run_hive.py.
 */
public class NbtSizeTest {
    static final int LIMIT = 60000;

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.out.println("usage: NbtSizeTest TMPDIR FILE...");
            System.exit(2);
        }
        List<String> bad = new ArrayList<>();
        Context cx = Context.enter();
        cx.setClassShutter((name, type) -> PneRhino.KubeFilter.allowed(name));
        String remap = PneRhino.remapper(cx);
        ScriptableObject scope = cx.initStandardObjects();
        ScriptableObject.putProperty(scope, "__pneRemap", remap, cx);
        ScriptableObject.putProperty(scope, "__pneHiveOnlyNbt", Boolean.TRUE, cx);
        ScriptableObject.putProperty(scope, "global", Context.javaToJS(cx, new HashMap<String, Object>(), scope), cx);
        ScriptableObject.putProperty(scope, "console", Context.javaToJS(cx, new PneRhino.Console(), scope), cx);
        ScriptableObject.putProperty(scope, "Java", Context.javaToJS(cx, new PneRhino.JavaWrapper(cx, scope), scope), cx);
        if (!remap.equals("minecraft")) bad.add("the game's remapper is not installed (" + remap + ")");
        for (int i = 1; i < args.length; i++) {
            cx.evaluateString(scope, PneRhino.preprocess(PneRhino.read(args[i]), new HashMap<>()), args[i], 1, null);
        }
        Object root = unwrap(cx.evaluateString(scope, "pneNbtBuild()", "build", 1, null));
        System.out.println("state: " + cx.toString(cx.evaluateString(scope, "pneNbtDesc()", "desc", 1, null)));
        Class<?> ct = Class.forName("net.minecraft.nbt.CompoundTag");
        Class<?> io = Class.forName("net.minecraft.nbt.NbtIo");
        if (!ct.isInstance(root)) {
            System.out.println("FAIL pneNbtBuild did not return a CompoundTag: " + root);
            System.exit(1);
        }
        Method keys = ct.getMethod("m_128431_");
        Method get = ct.getMethod("m_128423_", String.class);
        Method copy = ct.getMethod("m_6426_");
        Method write = io.getMethod("m_128944_", ct, File.class);
        Method writeStream = io.getMethod("m_128947_", ct, OutputStream.class);
        Method read = io.getMethod("m_128937_", File.class);

        Object hive = get.invoke(root, "pne_hive");
        if (hive == null || !ct.isInstance(hive)) bad.add("persistentData has no pne_hive compound");
        File out = new File(args[0], "pne_hive_nbt_max.nbt");
        out.getParentFile().mkdirs();
        write.invoke(null, root, out);
        Object back = read.invoke(null, out);
        if (!root.equals(back)) bad.add("NbtIo round trip changed the tag");
        ByteArrayOutputStream gz = new ByteArrayOutputStream();
        writeStream.invoke(null, root, gz);

        // every string, at any depth
        List<String> rows = new ArrayList<>();
        int[] maxLen = {0};
        walk(back, "", keys, get, rows, maxLen, bad);
        Set<?> hk = (Set<?>) keys.invoke(get.invoke(back, "pne_hive"));
        if (hk.size() >= 64) bad.add("pne_hive holds " + hk.size() + " tags (keep it under about 64)");
        Object base = get.invoke(get.invoke(back, "pne_hive"), "base");
        int ctx = base == null ? 0 : ((Set<?>) keys.invoke(base)).size();
        if (ctx != 512) bad.add("base holds " + ctx + " contexts, expected the 512 maximum");
        if (base != null) {
            for (Object k : (Set<?>) keys.invoke(base)) {
                Object ia = get.invoke(base, k);
                int[] v = (int[]) ia.getClass().getMethod("m_128648_").invoke(ia);
                if (v.length != 5) {
                    bad.add("base entry " + k + " has " + v.length + " ints (expected 5)");
                    break;
                }
            }
        }
        for (String r : rows) System.out.println("  " + r);

        // main-thread copy cost (KubeJS copies server.persistentData at each overworld save) and pneHiveSave in Rhino
        double bestCopy = 1e9;
        for (int r = 0; r < 40; r++) {
            long t0 = System.nanoTime();
            copy.invoke(back);
            bestCopy = Math.min(bestCopy, (System.nanoTime() - t0) / 1e6);
        }
        // the periodic save is spread over ticks: GA save + runtime string, 32 base IntArrays per step, then the swap
        int R = 30;
        double[] save = new double[R];
        double[] begin = new double[R];
        double[] finish = new double[R];
        List<Double> chunks = new ArrayList<>();
        int steps = 0;
        for (int w = 0; w < 5; w++) cx.evaluateString(scope, "pneHiveSave(pneNbtSrv)", "warm", 1, null);
        for (int r = 0; r < R; r++) {
            long t0 = System.nanoTime();
            cx.evaluateString(scope, "pneHiveSave(pneNbtSrv)", "save", 1, null);
            save[r] = (System.nanoTime() - t0) / 1e6;
            t0 = System.nanoTime();
            cx.evaluateString(scope, "pneHiveSaveBegin(pneNbtSrv)", "begin", 1, null);
            begin[r] = (System.nanoTime() - t0) / 1e6;
            steps = 0;
            while (true) {
                t0 = System.nanoTime();
                Object done = cx.evaluateString(scope, "pneHiveSaveBase(PNE_HIVE_BASE_CHUNK)", "chunk", 1, null);
                chunks.add((System.nanoTime() - t0) / 1e6);
                steps++;
                if ("true".equals(cx.toString(done))) break;
            }
            t0 = System.nanoTime();
            cx.evaluateString(scope, "pneHiveSaveFinish()", "finish", 1, null);
            finish[r] = (System.nanoTime() - t0) / 1e6;
        }
        java.util.Arrays.sort(save);
        java.util.Arrays.sort(begin);
        java.util.Arrays.sort(finish);
        double[] ch = new double[chunks.size()];
        for (int i = 0; i < ch.length; i++) ch[i] = chunks.get(i);
        java.util.Arrays.sort(ch);
        System.out.printf("save steps (Rhino, max state): GA save + runtime p50 %.3f ms (p90 %.3f); base chunk of 32 p50 %.3f ms (p90 %.3f, %d chunks); finish p50 %.3f ms%n",
                begin[R / 2], begin[R * 9 / 10], ch[ch.length / 2], ch[ch.length * 9 / 10], steps, finish[R / 2]);

        ScriptableObject.putProperty(scope, "__pneNbtBack", Context.javaToJS(cx, back, scope), cx);
        String reload = cx.toString(cx.evaluateString(scope, "pneNbtReload(__pneNbtBack)", "reload", 1, null));
        if (!reload.startsWith("OK")) bad.add("reload: " + reload);

        // 5. the incremental save (PNE_HIVE_GA.saveBegin / savePart / saveEnd, then the write steps) of the maximum state,
        //    the state changing between every two GA pieces, stores exactly what the one-call save stored: the same
        //    CompoundTag (equals) and the same NbtIo bytes. Each step is timed (this JVM is barely warm: printed, not gated;
        //    hive-rhino-bench gates the pieces against gaSavePart on a warm JVM).
        String ph = cx.toString(cx.evaluateString(scope, "pneNbtIncBegin()", "incBegin", 1, null));
        List<Double> gaSteps = new ArrayList<>();
        List<Double> wrSteps = new ArrayList<>();
        int guard = 0;
        if (ph.startsWith("FAIL")) bad.add("incremental save: " + ph);
        while (ph.equals("ga") || ph.equals("nbt")) {
            if (guard++ > 2000) {
                bad.add("incremental save: no end after 2000 steps");
                break;
            }
            boolean ga = ph.equals("ga");
            if (ga) cx.evaluateString(scope, "pneNbtIncChurn(" + guard + ")", "churn", 1, null);
            long t0 = System.nanoTime();
            ph = cx.toString(cx.evaluateString(scope, "pneNbtIncStep()", "incStep", 1, null));
            (ga ? gaSteps : wrSteps).add((System.nanoTime() - t0) / 1e6);
        }
        String incCheck = cx.toString(cx.evaluateString(scope, "pneNbtIncCheck()", "incCheck", 1, null));
        if (!incCheck.startsWith("OK")) bad.add("incremental save: " + incCheck);
        Object incRef = unwrap(cx.evaluateString(scope, "pneNbtIncRef", "incRef", 1, null));
        Object incGot = unwrap(cx.evaluateString(scope, "pneNbtSrv.persistentData.getCompound('pne_hive')", "incGot", 1, null));
        boolean incEq = incRef != null && incRef.equals(incGot);
        ByteArrayOutputStream refBytes = new ByteArrayOutputStream();
        ByteArrayOutputStream gotBytes = new ByteArrayOutputStream();
        if (incEq) {
            writeStream.invoke(null, incRef, refBytes);
            writeStream.invoke(null, incGot, gotBytes);
        }
        boolean incBytes = incEq && java.util.Arrays.equals(refBytes.toByteArray(), gotBytes.toByteArray());
        if (!incEq) bad.add("incremental save: the stored pne_hive differs from the one-call save's (CompoundTag.equals)");
        else if (!incBytes) bad.add("incremental save: equal compounds but different NbtIo bytes");
        double[] gs = new double[gaSteps.size()];
        for (int i = 0; i < gs.length; i++) gs[i] = gaSteps.get(i);
        java.util.Arrays.sort(gs);
        double[] ws = new double[wrSteps.size()];
        for (int i = 0; i < ws.length; i++) ws[i] = wrSteps.get(i);
        java.util.Arrays.sort(ws);
        if (gs.length > 0 && ws.length > 0) {
            System.out.printf("incremental save (Rhino, max state, state changing between pieces): %d GA steps p50 %.3f max %.3f ms; %d write steps p50 %.3f max %.3f ms; %s; stored compound %s the one-call save's%n",
                    gs.length, gs[gs.length / 2], gs[gs.length - 1], ws.length, ws[ws.length / 2], ws[ws.length - 1], incCheck,
                    incBytes ? "equals (and NbtIo bytes identical to)" : "DIFFERS from");
        }

        System.out.printf("measured: max string %d bytes (limit %d); compressed file %d bytes; CompoundTag.copy %.3f ms; whole pneHiveSave p50 %.3f ms (server stop only)%n",
                maxLen[0], LIMIT, gz.size(), bestCopy, save[save.length / 2]);
        for (String b : bad) System.out.println("  problem: " + b);
        if (!bad.isEmpty()) {
            System.out.println("FAIL hive NBT size test (" + bad.size() + " problem(s))");
            System.exit(1);
        }
        System.out.println("PASS max-size hive state through NbtIo: " + rows.size() + " strings, largest " + maxLen[0] +
                " bytes <= " + LIMIT + ", round trip exact (" + reload + "), 512 contexts, " + hk.size() + " pne_hive tags; the incremental save stores the one-call save's compound byte for byte");
    }

    static Object unwrap(Object o) {
        while (o instanceof Wrapper) o = ((Wrapper) o).unwrap();
        return o;
    }

    static void walk(Object tag, String path, Method keys, Method get, List<String> rows, int[] maxLen, List<String> bad) throws Exception {
        TreeSet<String> ks = new TreeSet<>();
        for (Object k : (Set<?>) keys.invoke(tag)) ks.add(String.valueOf(k));
        for (String k : ks) {
            Object v = get.invoke(tag, k);
            String name = v.getClass().getSimpleName();
            String p = path.isEmpty() ? k : path + "." + k;
            int kl = mutf8(k);
            if (kl > LIMIT) bad.add("key " + p + " is " + kl + " bytes");
            if (name.equals("CompoundTag")) {
                walk(v, p, keys, get, rows, maxLen, bad);
            } else if (name.equals("StringTag")) {
                String s = (String) v.getClass().getMethod("m_7916_").invoke(v);
                int n = mutf8(s);
                maxLen[0] = Math.max(maxLen[0], n);
                if (n > LIMIT) bad.add("string " + p + " is " + n + " bytes (> " + LIMIT + ")");
                try {
                    new DataOutputStream(OutputStream.nullOutputStream()).writeUTF(s);
                } catch (java.io.UTFDataFormatException e) {
                    bad.add("string " + p + " cannot be written by writeUTF");
                }
                if (!p.startsWith("pne_hive.base")) rows.add(String.format("%-24s %6d bytes", p, n));
            }
        }
    }

    // Length of a string in Java's modified UTF-8 (what DataOutput.writeUTF writes after its 2-byte length).
    static int mutf8(String s) {
        int n = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= 1 && c <= 0x7f) n += 1;
            else if (c <= 0x7ff) n += 2;
            else n += 3;
        }
        return n;
    }
}
