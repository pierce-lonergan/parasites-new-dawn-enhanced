import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.RhinoException;
import dev.latvian.mods.rhino.ScriptableObject;

import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/**
 * Suite hive-rhino-bench: the hive runtime (pne_hive.js with pne_00_core.js and pne_hive_core.js) in the instance's own
 * Rhino jar with KubeJS's class filter and the game's remapper (tools/rhino/PneRhino.java), against a mock world whose
 * mobs are Java objects (so every call pays Rhino's real reflection dispatch and argument conversion), whose persistent
 * data is the real SRG CompoundTag and whose attribute modifiers are the real AttributeModifier class.
 *
 *   HiveBench COSTS FILE...        COSTS = PNE_CORE_COST as 'key=value,...' (from pne_00_core.js)
 *
 * The clock is read here, in Java; the scripts never read one (contract F25). Two parts:
 *   1. unit costs: each case of pneHBCases() ('name:units:reps|...') is warmed, then timed batch by batch
 *      (pneHBRun(name, units)); printed as mean / p50 / p90 per unit, next to the cost constant it is charged with;
 *   2. tick simulation: pneHBPhase(name) sets up a phase, then every tick pneHBEvents() queues that tick's events
 *      (untimed: in game they happen in event handlers, outside the tick handler) and pneHBTick() runs one server tick
 *      (core + hive tick handlers), timed; it returns the milliseconds the token budget charged that tick.
 * Gates (the best of three trials per phase: the machine may be shared with other test suites):
 *   - the budget never charges more than 2.5 ms in a tick (every phase);
 *   - the measured mean stays within the charged mean + 0.1 ms (the constants, raised to the hive's measured floors,
 *     are true to the work) and the measured p90 within 2.75 ms (the typical tick fits the budget) in every phase;
 *   - the p99 stays within I9's 3 ms in the realistic phases (quiet, mixed, deep). The drain phase keeps every queue
 *     saturated on every tick for 2000 ticks, an artificial extreme whose p99 is GC pauses and machine jitter; it is printed;
 *   - every trial passes the workload's own phase check (pneHBPhaseCheck: for example breeds, dream slices and no dropped
 *     outcome in the quiet phase);
 *   - a unit case with a gate (5th field of its spec) has a median within gate x its charge, in the better of the two passes
 *     (the charge must cover the work the budget accounts for).
 * Unit costs are timed in two passes after a warm-up and the second pass is printed (the first timed case of a pass reads
 * high while the JVM settles). A case's charge is a cost key (pneHiveCost), 'f*key', a number, or '=js expression'.
 */
public class HiveBench {
    static final double BUDGET = 2.5;
    static final int TRIALS = 3;
    static final double I9 = 3.0;       // TDD I9: at most 3 ms of KubeJS work per tick (the 2.5 ms budget plans below it)

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.out.println("usage: HiveBench COSTS FILE...");
            System.exit(2);
        }
        Map<String, Double> cost = new LinkedHashMap<>();
        for (String kv : args[0].split(",")) {
            String[] p = kv.split("=");
            if (p.length == 2) cost.put(p[0], Double.parseDouble(p[1]));
        }
        List<String> bad = new ArrayList<>();
        Context cx = Context.enter();
        try {
            cx.setClassShutter((name, type) -> name.startsWith("HiveBench") || PneRhino.KubeFilter.allowed(name));
            String remap = PneRhino.remapper(cx);
            ScriptableObject scope = cx.initStandardObjects();
            ScriptableObject.putProperty(scope, "__pneRemap", remap, cx);
            ScriptableObject.putProperty(scope, "__pneHiveOnlyNbt", Boolean.TRUE, cx);
            ScriptableObject.putProperty(scope, "__pneHiveRealAttr", Boolean.TRUE, cx);
            ScriptableObject.putProperty(scope, "global", Context.javaToJS(cx, new HashMap<String, Object>(), scope), cx);
            ScriptableObject.putProperty(scope, "console", Context.javaToJS(cx, new PneRhino.Console(), scope), cx);
            ScriptableObject.putProperty(scope, "Java", Context.javaToJS(cx, new PneRhino.JavaWrapper(cx, scope), scope), cx);
            ScriptableObject.putProperty(scope, "__hb", Context.javaToJS(cx, new World(), scope), cx);
            for (int i = 1; i < args.length; i++) {
                cx.evaluateString(scope, PneRhino.preprocess(PneRhino.read(args[i]), new HashMap<>()), args[i], 1, null);
            }
            cx.evaluateString(scope, "pneHBSetup()", "setup", 1, null);

            // 1. unit costs
            String cases = cx.toString(cx.evaluateString(scope, "pneHBCases()", "cases", 1, null));
            // one warm-up pass over every case first (JVM warm-up of Rhino's interpreter and reflection paths)
            for (int round = 0; round < 3; round++) {
                for (String c : cases.split("[|]")) {
                    String[] p = c.split(":");
                    cx.evaluateString(scope, "pneHBPrep('" + p[0] + "')", "prep", 1, null);
                    cx.evaluateString(scope, "pneHBRun('" + p[0] + "', " + p[1] + ")", "warm", 1, null);
                }
            }
            System.out.println("unit costs (Rhino interpreter, JDK 17, Java stand-in mobs, real CompoundTag and AttributeModifier):");
            Map<String, Double> bestRatio = new LinkedHashMap<>();
            Map<String, Double> gateOf = new LinkedHashMap<>();
            for (int pass = 1; pass <= 2; pass++)
            for (String c : cases.split("\\|")) {
                String[] p = c.split(":");
                String name = p[0];
                int n = Integer.parseInt(p[1]);
                int reps = Integer.parseInt(p[2]);
                String key = p.length > 3 ? p[3] : "";
                if (p.length > 4) gateOf.put(name, Double.parseDouble(p[4]));
                String call = "pneHBRun('" + name + "', " + n + ")";
                String prep = "pneHBPrep('" + name + "')";
                for (int w = 0; w < 5; w++) {
                    cx.evaluateString(scope, prep, "prep", 1, null);
                    cx.evaluateString(scope, call, "warm", 1, null);
                }
                double[] ms = new double[reps];
                for (int r = 0; r < reps; r++) {
                    cx.evaluateString(scope, prep, "prep", 1, null);
                    long t0 = System.nanoTime();
                    cx.evaluateString(scope, call, "run", 1, null);
                    ms[r] = (System.nanoTime() - t0) / 1e6 / n;
                }
                double[] s = ms.clone();
                Arrays.sort(s);
                double mean = 0;
                for (double v : ms) mean += v;
                mean /= reps;
                String charged = "";
                if (!key.isEmpty()) {
                    double k = 0;
                    if (key.startsWith("=")) {
                        // a charge the workload computes (for example nearBase + nearRec per scanned record)
                        k = cx.toNumber(cx.evaluateString(scope, key.substring(1), "cost", 1, null));
                    } else {
                        for (String part : key.split("\\+")) {
                            String[] m = part.split("\\*");
                            double f = m.length == 2 ? Double.parseDouble(m[0]) : 1;
                            String ck = m.length == 2 ? m[1] : m[0];
                            // what the hive actually charges: the core constant, raised to the hive's measured value
                            k += f * cx.toNumber(cx.evaluateString(scope, "pneHiveCost('" + ck + "')", "cost", 1, null));
                        }
                    }
                    double ratio = s[reps / 2] / k;
                    bestRatio.merge(name, ratio, Math::min);
                    charged = String.format(" charged %.4f (%s; core %.4f) ratio p50/charged %.2f", k, key, cost.getOrDefault(key.replaceAll("^[0-9.]+\\*", ""), Double.NaN), ratio);
                }
                if (pass == 1) continue;
                System.out.printf("case %-14s mean %.4f p50 %.4f p90 %.4f min %.4f ms/unit%s%n", name, mean, s[reps / 2], s[reps * 9 / 10], s[0], charged);
            }

            for (Map.Entry<String, Double> g : gateOf.entrySet()) {
                Double r = bestRatio.get(g.getKey());
                if (r == null || r > g.getValue() + 1e-9) bad.add(String.format("case %s: median %.2f x its charge (gate %.2f): under-charged", g.getKey(), r == null ? Double.NaN : r, g.getValue()));
            }

            // 2. tick simulation
            String[] phases = cx.toString(cx.evaluateString(scope, "pneHBPhases()", "phases", 1, null)).split("\\|");
            for (String ph : phases) {
                String[] p = ph.split(":");
                String name = p[0];
                int ticks = Integer.parseInt(p[1]);
                double bestP99 = 1e9;
                double maxCharged = 0;
                double bestGap = 1e9;
                double bestP90 = 1e9;
                // three trials per phase: the machine may be shared (other test suites), so the gates use the best trial
                for (int trial = 1; trial <= TRIALS; trial++) {
                    cx.evaluateString(scope, "pneHBPhase('" + name + "')", "phase", 1, null);
                    for (int w = 0; w < 200; w++) {
                        cx.evaluateString(scope, "pneHBEvents()", "ev", 1, null);
                        cx.evaluateString(scope, "pneHBTick()", "tick", 1, null);
                    }
                    double[] ms = new double[ticks];
                    double[] ch = new double[ticks];
                    for (int t = 0; t < ticks; t++) {
                        cx.evaluateString(scope, "pneHBEvents()", "ev", 1, null);
                        long t0 = System.nanoTime();
                        Object r = cx.evaluateString(scope, "pneHBTick()", "tick", 1, null);
                        ms[t] = (System.nanoTime() - t0) / 1e6;
                        ch[t] = cx.toNumber(r);
                        maxCharged = Math.max(maxCharged, ch[t]);
                    }
                    double[] s = ms.clone();
                    Arrays.sort(s);
                    double mean = 0;
                    double chMean = 0;
                    for (int t = 0; t < ticks; t++) {
                        mean += ms[t];
                        chMean += ch[t];
                    }
                    mean /= ticks;
                    chMean /= ticks;
                    bestP99 = Math.min(bestP99, s[ticks * 99 / 100]);
                    bestP90 = Math.min(bestP90, s[ticks * 9 / 10]);
                    bestGap = Math.min(bestGap, mean - chMean);
                    String info = cx.toString(cx.evaluateString(scope, "pneHBInfo()", "info", 1, null));
                    System.out.printf("phase %-6s trial %d ticks %d: measured mean %.3f p50 %.3f p90 %.3f p99 %.3f max %.3f ms; charged mean %.3f max %.3f ms; %s%n",
                            name, trial, ticks, mean, s[ticks / 2], s[ticks * 9 / 10], s[ticks * 99 / 100], s[ticks - 1], chMean, maxCharged, info);
                    String pc = cx.toString(cx.evaluateString(scope, "pneHBPhaseCheck('" + name + "')", "phasecheck", 1, null));
                    if (!pc.startsWith("OK")) bad.add(name + " trial " + trial + ": " + pc);
                }
                if (maxCharged > BUDGET + 1e-6) bad.add(name + ": the budget charged " + maxCharged + " ms in one tick");
                if (bestP90 > BUDGET + 0.25) bad.add(String.format("%s: p90 tick %.3f ms (best trial) exceeds the %.1f ms budget + 0.25", name, bestP90, BUDGET));
                if (!name.equals("drain") && bestP99 > I9) bad.add(String.format("%s: p99 tick %.3f ms (best trial) exceeds I9's %.1f ms", name, bestP99, I9));
                System.out.printf("phase %-6s best trial: p90 %.3f, p99 %.3f ms%s%n", name, bestP90, bestP99, name.equals("drain") ? " (p99 printed, not gated: saturated extreme)" : "");
                if (bestGap > 0.1) bad.add(String.format("%s: measured mean exceeds the charged mean by %.3f ms in every trial (costs under-charged)", name, bestGap));
            }
            String check = cx.toString(cx.evaluateString(scope, "pneHBCheck()", "check", 1, null));
            if (!check.startsWith("OK")) bad.add(check);
        } catch (RhinoException e) {
            System.out.println("FAIL " + e.sourceName() + ":" + e.lineNumber() + ": " + e.details());
            String st = e.getScriptStackTrace();
            if (st != null) System.out.println(st);
            System.exit(1);
        }
        for (String b : bad) System.out.println("  problem: " + b);
        if (!bad.isEmpty()) {
            System.out.println("FAIL hive Rhino mock-world benchmark (" + bad.size() + " problem(s))");
            System.exit(1);
        }
        System.out.println("PASS hive Rhino mock-world benchmark: the budget never charged more than 2.5 ms in a tick; charged covers measured and p90 fits the budget in every phase; p99 within I9's 3 ms in the quiet, mixed and deep phases; every gated case fits its charge; breeds, dream slices and every outcome ran in the quiet phase");
    }

    /** Factory for Java stand-ins, bound as __hb. */
    public static class World {
        final Class<?> ct;

        public World() throws Exception {
            ct = Class.forName("net.minecraft.nbt.CompoundTag");
        }

        public Mob mob(String type, String uuid, double x, double y, double z, Object level, Object server, boolean dmg) throws Exception {
            Mob m = new Mob();
            m.type = type;
            m.uuid = uuid;
            m.x = x;
            m.y = y;
            m.z = z;
            m.level = level;
            m.server = server;
            m.pd = ct.getConstructor().newInstance();
            m.fd = ct.getConstructor().newInstance();
            m.bases.put("generic.movement_speed", 0.25);
            m.bases.put("generic.follow_range", 16.0);
            m.bases.put("generic.knockback_resistance", 0.0);
            m.bases.put("generic.armor", 0.0);
            m.bases.put("generic.attack_knockback", 0.0);
            m.bases.put("generic.max_health", 20.0);
            if (dmg) m.bases.put("generic.attack_damage", 7.0);
            return m;
        }
    }

    /** A mob as KubeJS shows it: Mojang or KubeJS method names only, never a Mojang name KubeJS hides (F37). */
    public static class Mob {
        public String type;
        public String uuid;
        public double x, y, z;
        public float hp = 20f;
        public boolean removed;
        public String reason;
        public Object pd, fd, level, server, target;
        public boolean silent, named, persist, handEmpty = true;
        public float yRot;
        public final Set<String> tags = new HashSet<>();
        public final Map<String, AttrInst> attrs = new HashMap<>();
        public final Map<String, Double> bases = new HashMap<>();

        public String getType() { return type; }
        public String getEncodeId() { return type; }
        public String getStringUuid() { return uuid; }
        public String getUuid() { return uuid; }
        public Object getPersistentData() { return pd; }
        public Object getForgePersistentData() { return fd; }
        public Object getEntityType() { return null; }
        public Set<String> getTags() { return tags; }
        public boolean addTag(String t) { return tags.add(t); }
        public boolean removeTag(String t) { return tags.remove(t); }
        public float getHealth() { return hp; }
        public float getMaxHealth() {
            AttrInst a = attrs.get("generic.max_health");
            return a == null ? 20f : (float) a.getValue();
        }
        public void setHealth(float h) { hp = h; }
        public boolean isPlayer() { return false; }
        public Object getServer() { return server; }
        public Object getLevel() { return level; }
        public double getX() { return x; }
        public double getY() { return y; }
        public double getZ() { return z; }
        public void discard() { removed = true; reason = "DISCARDED"; }
        public boolean isAlive() { return !removed && hp > 0; }
        public boolean isRemoved() { return removed; }
        public String getRemovalReason() { return reason; }
        public AttrInst getAttribute(Object a) {
            String id = String.valueOf(a);
            Double b = bases.get(id);
            if (b == null) return null;
            return attrs.computeIfAbsent(id, k -> new AttrInst(b));
        }
        public Object getTarget() { return target; }
        public void setSilent(boolean s) { silent = s; }
        public boolean isSilent() { return silent; }
        public boolean hasCustomName() { return named; }
        public boolean isPersistenceRequired() { return persist; }
        public Stack getMainHandItem() { return new Stack(handEmpty); }
        /** KubeJS's name for Entity.getYRot(), which scripts cannot see in game (contract F37). */
        public float getYaw() { return yRot; }
        public int[] blockPosition() { return new int[]{(int) Math.floor(x), (int) Math.floor(y), (int) Math.floor(z)}; }
    }

    public static class Stack {
        final boolean empty;
        Stack(boolean e) { empty = e; }
        public boolean isEmpty() { return empty; }
    }

    /** AttributeInstance semantics: a duplicate UUID throws; removeModifier(UUID) drops either kind. */
    public static class AttrInst {
        static Method idM, amountM;
        final double base;
        final Map<Object, Object> perm = new LinkedHashMap<>();
        final Map<Object, Object> trans = new LinkedHashMap<>();

        AttrInst(double b) { base = b; }

        static Object idOf(Object m) throws Exception {
            if (idM == null) idM = m.getClass().getMethod("m_22209_");
            return idM.invoke(m);
        }

        public double getBaseValue() { return base; }
        public Object getModifier(UUID u) {
            Object m = perm.get(u);
            return m != null ? m : trans.get(u);
        }
        public void addPermanentModifier(Object m) throws Exception {
            Object k = idOf(m);
            if (perm.containsKey(k) || trans.containsKey(k)) throw new IllegalArgumentException("Modifier is already applied on this attribute!");
            perm.put(k, m);
        }
        public void addTransientModifier(Object m) throws Exception {
            Object k = idOf(m);
            if (perm.containsKey(k) || trans.containsKey(k)) throw new IllegalArgumentException("Modifier is already applied on this attribute!");
            trans.put(k, m);
        }
        public void removeModifier(UUID u) {
            perm.remove(u);
            trans.remove(u);
        }
        public double getValue() {
            double v = base;
            try {
                for (Object m : perm.values()) {
                    if (amountM == null) amountM = m.getClass().getMethod("m_22218_");
                    v += base * (Double) amountM.invoke(m);
                }
            } catch (Exception e) {
                return base;
            }
            return v;
        }
    }
}
