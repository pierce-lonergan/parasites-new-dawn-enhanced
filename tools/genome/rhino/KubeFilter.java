import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Replica of dev.latvian.mods.kubejs.util.ClassFilter.isAllowed0 plus the rules registered by
 * BuiltinKubeJSPlugin.registerClasses and BuiltinKubeJSForgePlugin.registerClasses (read from the KubeJS
 * 2001.6.5 bytecode; carried over from the measured prototype):
 *   1) exact match in denyStrong  -> deny
 *   2) exact match in allowStrong -> allow
 *   3) any denyWeak prefix (String.startsWith) -> deny
 *   4) otherwise allow
 * The GA core must not need any Java class at all; the harness installs this filter as the class shutter so a
 * stray Java access fails exactly as it would in game.
 */
public class KubeFilter {
    static final Set<String> denyStrong = new HashSet<>();
    static final List<String> denyWeak = new ArrayList<>();
    static final Set<String> allowStrong = new HashSet<>();

    static void deny(String s) {
        denyStrong.add(s);
        if (!denyWeak.contains(s)) denyWeak.add(s);
    }

    static void allow(String s) {
        allowStrong.add(s);
    }

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
        if (denyStrong.contains(name)) return false;
        if (allowStrong.contains(name)) return true;
        for (String p : denyWeak) if (name.startsWith(p)) return false;
        return true;
    }
}
