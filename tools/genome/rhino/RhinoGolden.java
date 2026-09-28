import dev.latvian.mods.rhino.Context;
import dev.latvian.mods.rhino.RhinoException;
import dev.latvian.mods.rhino.ScriptableObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Rhino benchmark driver for the GA core (the ga-core-breed-bench suite). The clock is read here, in Java, never
 * from the scripts (KubeJS scripts have no clock: IMPLEMENTATION.md F25).
 *
 *   RhinoGolden bench FILE...
 *
 * The files must define pneBenchSetup(), pneBenchCases() (a '|'-separated list of name:units:reps) and
 * pneBenchRun(name, n) (runs n units of that case). For every case the driver warms up (3 calls), then times reps
 * calls and prints "case name mean_ms p50_ms p95_ms max_ms" per unit. Cases whose name ends in "_one" run one unit
 * per call, so their percentiles are per call (what a token-budget constant has to cover). For those, if the files
 * define pneBenchLabel(name), it is called after every timed call (outside the timing) and the calls are also
 * grouped by the returned label ("step name label ..." lines; for example one line per dream step type). If the files
 * define pneBenchPrep(name), it is called before every warm-up and timed call, outside the timing (untimed preparation:
 * for example changing the GA state between two steps of an incremental save, as the game does between two ticks).
 */
public class RhinoGolden {
    static double pct(double[] sorted, double q) {
        int i = (int) Math.ceil(q * sorted.length) - 1;
        if (i < 0) i = 0;
        if (i >= sorted.length) i = sorted.length - 1;
        return sorted[i];
    }

    static void print(String prefix, double[] ms, int n) {
        double[] sorted = ms.clone();
        Arrays.sort(sorted);
        double sum = 0;
        for (double v : ms) sum += v;
        System.out.printf("%s mean_ms=%.4f p50_ms=%.4f p95_ms=%.4f max_ms=%.4f units=%d reps=%d%n",
                prefix, sum / ms.length, pct(sorted, 0.5), pct(sorted, 0.95), sorted[sorted.length - 1], n, ms.length);
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 2 || !args[0].equals("bench")) {
            System.err.println("usage: RhinoGolden bench FILE...");
            System.exit(2);
        }
        Context cx = Context.enter();
        try {
            ScriptableObject scope = RhinoRun.load(cx, args, 1);
            cx.evaluateString(scope, "pneBenchSetup()", "setup", 1, null);
            String cases = cx.toString(cx.evaluateString(scope, "pneBenchCases()", "cases", 1, null));
            boolean labels = "function".equals(cx.toString(cx.evaluateString(scope, "typeof pneBenchLabel", "labels", 1, null)));
            boolean preps = "function".equals(cx.toString(cx.evaluateString(scope, "typeof pneBenchPrep", "preps", 1, null)));
            for (String c : cases.split("\\|")) {
                String[] p = c.split(":");
                String name = p[0];
                int n = Integer.parseInt(p[1]);
                int reps = Integer.parseInt(p[2]);
                String call = "pneBenchRun('" + name + "', " + n + ")";
                boolean grouped = labels && name.endsWith("_one");
                String labelCall = "pneBenchLabel('" + name + "')";
                String prepCall = "pneBenchPrep('" + name + "')";
                Map<String, List<Double>> groups = new LinkedHashMap<>();
                for (int w = 0; w < 3; w++) {
                    if (preps) cx.evaluateString(scope, prepCall, "prep", 1, null);
                    cx.evaluateString(scope, call, "warm", 1, null);
                }
                double[] ms = new double[reps];
                for (int r = 0; r < reps; r++) {
                    if (preps) cx.evaluateString(scope, prepCall, "prep", 1, null);
                    long t0 = System.nanoTime();
                    cx.evaluateString(scope, call, "run", 1, null);
                    long t1 = System.nanoTime();
                    ms[r] = (t1 - t0) / 1e6 / n;
                    if (grouped) {
                        String lb = cx.toString(cx.evaluateString(scope, labelCall, "label", 1, null));
                        if (!lb.isEmpty()) groups.computeIfAbsent(lb, k -> new ArrayList<>()).add(ms[r]);
                    }
                }
                print("case " + name, ms, n);
                for (Map.Entry<String, List<Double>> g : groups.entrySet()) {
                    double[] v = new double[g.getValue().size()];
                    for (int i = 0; i < v.length; i++) v[i] = g.getValue().get(i);
                    print("step " + name + " " + g.getKey(), v, n);
                }
            }
            System.out.println(cx.toString(cx.evaluateString(scope, "pneBenchCheck()", "check", 1, null)));
        } catch (RhinoException e) {
            System.out.println("FAIL " + e.sourceName() + ":" + e.lineNumber() + ": " + e.details());
            System.exit(1);
        } catch (Throwable t) {
            System.out.println("FAIL " + t);
            System.exit(1);
        }
    }
}
