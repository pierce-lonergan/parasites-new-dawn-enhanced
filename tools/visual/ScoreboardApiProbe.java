import dev.latvian.mods.rhino.mod.util.MinecraftRemapper;

import java.io.BufferedInputStream;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.zip.GZIPInputStream;

/**
 * The names scripts see for the ServerScoreboard team API that pne_visual.js calls (contract 1.5, spec D), read the way
 * KubeJS reads them: the SRG-named Minecraft client jar on the classpath (the runtime names under Forge), and the Rhino
 * fork's own MinecraftRemapper loaded from the Rhino jar's mm.jsmappings (what ScriptManager.load installs, fact F34).
 * For every row: the class loads (without initialising it), the SRG method exists with the given parameter count, and the
 * remapper maps it to the Mojang name the script calls. It also lists every public method that maps to that name, so an
 * overload that Rhino could pick instead shows up. Arguments: none. Prints one line per row and "PASS n" or "FAIL ...".
 * Built and run by tools/visual/scoreboard_api.py (JDK 17).
 */
public class ScoreboardApiProbe {
    // class, SRG name, Mojang name the script uses, parameter count
    static final String[][] ROWS = {
        {"net.minecraft.server.MinecraftServer", "m_129896_", "getScoreboard", "0"},
        {"net.minecraft.server.ServerScoreboard", "m_83489_", "getPlayerTeam", "1"},
        {"net.minecraft.server.ServerScoreboard", "m_83492_", "addPlayerTeam", "1"},
        {"net.minecraft.server.ServerScoreboard", "m_83500_", "getPlayersTeam", "1"},
        {"net.minecraft.server.ServerScoreboard", "m_6546_", "addPlayerToTeam", "2"},
        {"net.minecraft.server.ServerScoreboard", "m_83495_", "removePlayerFromTeam", "1"},
        {"net.minecraft.server.ServerScoreboard", "m_6519_", "removePlayerFromTeam", "2"},
        {"net.minecraft.world.scores.PlayerTeam", "m_5758_", "getName", "0"},
        {"net.minecraft.world.scores.PlayerTeam", "m_6809_", "getPlayers", "0"},
        {"net.minecraft.world.scores.PlayerTeam", "m_83346_", "setNameTagVisibility", "1"},
        {"net.minecraft.world.scores.PlayerTeam", "m_7470_", "getNameTagVisibility", "0"},
        {"net.minecraft.world.scores.PlayerTeam", "m_83344_", "setCollisionRule", "1"},
        {"net.minecraft.world.scores.PlayerTeam", "m_7156_", "getCollisionRule", "0"},
        {"net.minecraft.world.scores.PlayerTeam", "m_83355_", "setAllowFriendlyFire", "1"},
        {"net.minecraft.world.scores.PlayerTeam", "m_6260_", "isAllowFriendlyFire", "0"},
        {"net.minecraft.world.scores.PlayerTeam", "m_83362_", "setSeeFriendlyInvisibles", "1"},
        {"net.minecraft.world.scores.PlayerTeam", "m_6259_", "canSeeFriendlyInvisibles", "0"},
    };

    public static void main(String[] args) throws Exception {
        List<String> fails = new ArrayList<>();
        InputStream in = dev.latvian.mods.rhino.Context.class.getResourceAsStream("/mm.jsmappings");
        if (in == null) {
            System.out.println("FAIL no mm.jsmappings in the Rhino jar");
            System.exit(1);
        }
        java.io.PrintStream err = System.err;
        MinecraftRemapper r;
        try {
            System.setErr(new java.io.PrintStream(java.io.OutputStream.nullOutputStream()));
            r = MinecraftRemapper.load(new BufferedInputStream(new GZIPInputStream(in)), false);
        } finally {
            System.setErr(err);
        }
        ClassLoader cl = ScoreboardApiProbe.class.getClassLoader();
        int n = 0;
        for (String[] row : ROWS) {
            Class<?> c;
            try {
                c = Class.forName(row[0], false, cl);
            } catch (Throwable t) {
                fails.add(row[0] + ": " + t);
                continue;
            }
            Method found = null;
            TreeSet<String> sameName = new TreeSet<>();
            Method[] ms;
            try {
                ms = c.getMethods();
            } catch (Throwable t) {
                fails.add(row[0] + ".getMethods(): " + t);
                continue;
            }
            for (Method m : ms) {
                // Rhino's JavaMembers.getAccessibleMethods walks the class, its interfaces and superclasses and asks the
                // remapper about each method with the class that DECLARES it (an override is met first, in the subclass).
                String mapped = r.getMappedMethod(m.getDeclaringClass(), m);
                String name = (mapped == null || mapped.isEmpty()) ? m.getName() : mapped;
                if (m.getName().equals(row[1]) && m.getParameterCount() == Integer.parseInt(row[3])) found = m;
                if (name.equals(row[2])) sameName.add(m.getName() + "/" + m.getParameterCount());
            }
            if (found == null) {
                fails.add(row[0] + "." + row[1] + " with " + row[3] + " parameter(s) is missing");
                continue;
            }
            String mapped = r.getMappedMethod(found.getDeclaringClass(), found);
            System.out.println("  " + row[0].substring(row[0].lastIndexOf('.') + 1) + "." + row[1] + "/" + row[3] + " -> " + mapped +
                " (declared in " + found.getDeclaringClass().getSimpleName() + "; every public method named " + row[2] + ": " + sameName + ")");
            if (!row[2].equals(mapped)) fails.add(row[0] + "." + row[1] + " maps to " + mapped + ", not " + row[2]);
            n++;
        }
        // the enum constants the script reads, by their names (enum constants are not obfuscated)
        for (String[] e : new String[][]{{"net.minecraft.world.scores.Team$Visibility", "NEVER", "ALWAYS"},
                {"net.minecraft.world.scores.Team$CollisionRule", "ALWAYS", "ALWAYS"}}) {
            try {
                Class<?> c = Class.forName(e[0], false, cl);
                c.getField(e[1]);
                c.getField(e[2]);
                System.out.println("  " + e[0].substring(e[0].lastIndexOf('.') + 1) + " has " + e[1] + " and " + e[2]);
                n++;
            } catch (Throwable t) {
                fails.add(e[0] + ": " + t);
            }
        }
        if (!fails.isEmpty()) {
            System.out.println("FAIL " + String.join("; ", fails));
            System.exit(1);
        }
        System.out.println("PASS " + n + " scoreboard names resolve under the KubeJS remapper");
    }
}
