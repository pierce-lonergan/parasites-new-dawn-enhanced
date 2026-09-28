import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.Function;
import dev.latvian.mods.rhino.RhinoException;
import dev.latvian.mods.rhino.ScriptableObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * MockWorld benchmark of the Oracle telemetry extractor (pne_oracle_bridge.js pneOraSample) in the instance's real
 * Rhino fork, with the KubeJS class filter and the game's remapper (tools/rhino/PneRhino). The player, level,
 * blocks and 150 entities are Java objects shaped like the KubeJS/Minecraft API the extractor calls, so the Rhino
 * interop cost (reflection dispatch, argument conversion, object wrapping) is real. Java-side work that the game
 * does inside those calls is modelled, not measured: the entity query filters 150 entities by the AABB in Java,
 * each line-of-sight check walks the voxels between the eyes (DDA over a block array, like Level.clip), and every
 * getBlock allocates a new container object as KubeJS does.
 *
 * Usage: TelemetryBench FILE... -- ENTITIES PARASITES_IN_RANGE ROUNDS CALLS
 * Prints one line per scenario and "RESULT p50 p90 p99 mean" (ms per player sample) for the main scenario, from the
 * least disturbed of ROUNDS rounds (lowest p90).
 */
public class TelemetryBench {
    // ---- the mock world (Java side, trivial but shaped like the game) ----
    public static class TState {
        final boolean solid;
        TState(boolean s) { solid = s; }
        public boolean isSolid() { return solid; }
        public boolean isAir() { return !solid; }
        public int getLightEmission() { return 0; }
    }

    public static class TBlock {
        final TLevel lv; final int x, y, z;
        TBlock(TLevel lv, int x, int y, int z) { this.lv = lv; this.x = x; this.y = y; this.z = z; }
        public int getLight() { return (x ^ z) & 15; }
        public boolean getCanSeeSky() { return y > 70; }
        public TState getBlockState() { return new TState(lv.solid(x, y, z)); }
        public String getId() { return lv.solid(x, y, z) ? "minecraft:stone" : "minecraft:air"; }
    }

    public static class TItem {
        final String id;
        TItem(String id) { this.id = id; }
        public String getId() { return id; }
        public boolean isEmpty() { return false; }
        public boolean isEdible() { return false; }
        public boolean isBlock() { return false; }
    }

    public static class TMob {
        public final String uuid = UUID.randomUUID().toString();
        final String type; public double x, y, z;
        TMob(String type, double x, double y, double z) { this.type = type; this.x = x; this.y = y; this.z = z; }
        public String getType() { return type; }
        public double getX() { return x; }
        public double getY() { return y; }
        public double getZ() { return z; }
        public String getStringUuid() { return uuid; }
        public boolean isPlayer() { return false; }
        public boolean isAlive() { return true; }
    }

    public static class TPlayer extends TMob {
        final TLevel lv; final TItem item = new TItem("minecraft:iron_sword");
        public float yaw = 10f; public int casts = 0;
        TPlayer(TLevel lv) { super("minecraft:player", 0.5, 64, 0.5); this.lv = lv; }
        @Override public boolean isPlayer() { return true; }
        public TLevel getLevel() { return lv; }
        public double getEyeY() { return y + 1.62; }
        /** KubeJS shows Entity.getYRot() to scripts only as getYaw() (IMPLEMENTATION F37), so the mock has only that name. */
        public float getYaw() { yaw += 7f; return yaw; }
        public float getHealth() { return 17f; }
        public float getMaxHealth() { return 20f; }
        public int getFoodLevel() { return 18; }
        public boolean isCrouching() { return false; }
        public boolean isSprinting() { return true; }
        public boolean isSpectator() { return false; }
        public boolean isCreative() { return false; }
        public TItem getMainHandItem() { return item; }
        public double distanceToSqr(Object o) {
            TMob e = (TMob) o;
            double dx = e.x - x, dy = e.y - y, dz = e.z - z;
            return dx * dx + dy * dy + dz * dz;
        }
        /** Line of sight: a voxel walk (DDA) from the eyes to the target's eyes, stopping at the first solid block. */
        public boolean canEntityBeSeen(Object o) {
            casts++;
            TMob e = (TMob) o;
            double sx = x, sy = getEyeY(), sz = z, ex = e.x, ey = e.y + 1.5, ez = e.z;
            double dx = ex - sx, dy = ey - sy, dz = ez - sz;
            int n = (int) Math.ceil(Math.max(Math.abs(dx), Math.max(Math.abs(dy), Math.abs(dz))) * 2) + 1;
            for (int i = 1; i < n; i++) {
                double t = (double) i / n;
                if (lv.solid((int) Math.floor(sx + dx * t), (int) Math.floor(sy + dy * t), (int) Math.floor(sz + dz * t))) return false;
            }
            return true;
        }
    }

    public static class TLevel {
        final byte[] blocks = new byte[128 * 64 * 128];
        public final List<TMob> mobs = new ArrayList<>();
        TPlayer player;
        TLevel() {
            for (int x = 0; x < 128; x++) for (int z = 0; z < 128; z++) for (int y = 0; y < 64; y++) {
                // terrain below y 64, a few pillars above it (so some sight lines are blocked)
                boolean s = y + 32 < 64 || ((x * 7 + z * 13) % 23 == 0 && y + 32 < 70);
                blocks[(x * 64 + y) * 128 + z] = (byte) (s ? 1 : 0);
            }
        }
        boolean solid(int x, int y, int z) {
            int ix = x + 64, iy = y - 32, iz = z + 64;
            if (ix < 0 || iy < 0 || iz < 0 || ix >= 128 || iy >= 64 || iz >= 128) return false;
            return blocks[(ix * 64 + iy) * 128 + iz] != 0;
        }
        public TBlock getBlock(int x, int y, int z) { return new TBlock(this, x, y, z); }
        public long getDayTime() { return 18000L; }
        public String getDimension() { return "minecraft:overworld"; }
        /** The entity query: every entity whose position is inside +-32 / +-16 / +-32 of the player (Java-side filter). */
        public ArrayList<Object> getEntitiesWithin(Object box) {
            ArrayList<Object> out = new ArrayList<>();
            double px = player.x, py = player.y, pz = player.z;
            out.add(player);
            for (TMob m : mobs) {
                if (Math.abs(m.x - px) <= 32 && Math.abs(m.y - py) <= 16 && Math.abs(m.z - pz) <= 32) out.add(m);
            }
            return out;
        }
    }

    static TLevel world(int entities, int parasitesInRange, boolean visible) {
        TLevel lv = new TLevel();
        lv.player = new TPlayer(lv);
        String[] other = {"minecraft:item", "minecraft:experience_orb", "minecraft:zombie", "minecraft:arrow", "minecraft:cow"};
        String[] para = {"epca:ripper", "spore:inf_human", "epca:curbug", "spore:brute"};
        for (int i = 0; i < entities; i++) {
            boolean p = i < parasitesInRange;
            double ang = i * 2.399963, r = p ? 3 + (i % 28) : 2 + (i % 30);
            double y = visible ? 64 : 52;  // hidden: inside the terrain below the player, still within the +-16 box
            lv.mobs.add(new TMob(p ? para[i % para.length] : other[i % other.length], 0.5 + Math.cos(ang) * r, y, 0.5 + Math.sin(ang) * r));
        }
        return lv;
    }

    static double[] run(Context cx, ScriptableObject scope, Function sample, TLevel lv, int rounds, int calls) {
        Object[] args = {Context.javaToJS(cx, lv.player, scope)};
        for (int i = 0; i < 3000; i++) sample.call(cx, scope, scope, args);  // warm-up
        double bestP90 = Double.MAX_VALUE, p50 = 0, p99 = 0, mean = 0;
        double[] t = new double[calls];
        for (int r = 0; r < rounds; r++) {
            double sum = 0;
            for (int i = 0; i < calls; i++) {
                long t0 = System.nanoTime();
                sample.call(cx, scope, scope, args);
                t[i] = (System.nanoTime() - t0) / 1e6;
                sum += t[i];
            }
            Arrays.sort(t);
            double p90 = t[(int) (calls * 0.90)];
            // the least disturbed round: other processes and GC pauses only lengthen the tail
            if (p90 < bestP90) { bestP90 = p90; p50 = t[calls / 2]; p99 = t[(int) (calls * 0.99)]; mean = sum / calls; }
        }
        return new double[]{p50, bestP90, p99, mean};
    }

    public static void main(String[] a) throws Exception {
        int sep = Arrays.asList(a).indexOf("--");
        String[] files = Arrays.copyOfRange(a, 0, sep);
        int entities = Integer.parseInt(a[sep + 1]), inRange = Integer.parseInt(a[sep + 2]);
        int rounds = Integer.parseInt(a[sep + 3]), calls = Integer.parseInt(a[sep + 4]);
        Context cx = Context.enter();
        cx.setClassShutter((name, type) -> PneRhino.KubeFilter.allowed(name) || name.startsWith("TelemetryBench"));
        String remap = PneRhino.remapper(cx);
        ScriptableObject scope = cx.initStandardObjects();
        HashMap<String, Object> global = new HashMap<>();
        ScriptableObject.putProperty(scope, "global", Context.javaToJS(cx, global, scope), cx);
        ScriptableObject.putProperty(scope, "console", Context.javaToJS(cx, new PneRhino.Console(), scope), cx);
        ScriptableObject.putProperty(scope, "Java", Context.javaToJS(cx, new PneRhino.JavaWrapper(cx, scope), scope), cx);
        try {
            for (String f : files) {
                Map<String, List<String>> props = new HashMap<>();
                cx.evaluateString(scope, PneRhino.preprocess(PneRhino.read(f), props), f, 1, null);
            }
            Function sample = (Function) ScriptableObject.getProperty(scope, "pneOraSample", cx);
            System.out.println("remapper: " + remap);
            Object[][] scenarios = {
                {"0 entities", 0, 0, false},
                {"150 entities, 75 parasites in range, all hidden (4 casts)", entities, inRange, false},
                {"150 entities, 75 parasites in range, visible (1 cast)", entities, inRange, true},
                {"300 entities, 150 parasites in range, hidden (4 casts)", entities * 2, inRange * 2, false},
            };
            double[] main = null;
            for (Object[] s : scenarios) {
                TLevel lv = world((Integer) s[1], (Integer) s[2], (Boolean) s[3]);
                double[] r = run(cx, scope, sample, lv, rounds, calls);
                int casts = lv.player.casts;
                System.out.printf("%-62s p50 %.4f ms  p90 %.4f ms  p99 %.4f ms  mean %.4f ms  (casts/sample %.2f)%n", s[0], r[0], r[1], r[2], r[3],
                        (double) casts / (3000 + (double) rounds * calls));
                if (s == scenarios[1]) main = r;
            }
            // The benchmark must time the in-game path: the yaw read through getYaw() gives a non-zero look_rate
            // (the mock turns 7 degrees per read), not the exception-and-fallback path of a hidden name.
            TLevel chk = world(0, 0, false);
            Object[] chkArgs = {Context.javaToJS(cx, chk.player, scope)};
            sample.call(cx, scope, scope, chkArgs);
            Object snap = sample.call(cx, scope, scope, chkArgs);
            double look = Double.NaN;
            if (snap instanceof dev.latvian.mods.rhino.Scriptable) {
                Object f = ScriptableObject.getProperty((dev.latvian.mods.rhino.Scriptable) snap, "f", cx);
                if (f instanceof dev.latvian.mods.rhino.Scriptable) {
                    Object v = ScriptableObject.getProperty((dev.latvian.mods.rhino.Scriptable) f, 3, cx);
                    if (v instanceof Number) look = ((Number) v).doubleValue();
                }
            }
            if (!(Math.abs(look - 7.0 / 180) < 1e-6)) {
                System.out.println("FAIL look_rate from the benchmark player is " + look + " (want 7/180: the yaw is not read through getYaw())");
                System.exit(1);
            }
            System.out.printf("look_rate check: %.6f (7/180 from getYaw)%n", look);
            System.out.printf("RESULT %.4f %.4f %.4f %.4f%n", main[0], main[1], main[2], main[3]);
        } catch (RhinoException e) {
            System.out.println("FAIL " + e.sourceName() + ":" + e.lineNumber() + ": " + e.details());
            System.exit(1);
        }
    }
}
