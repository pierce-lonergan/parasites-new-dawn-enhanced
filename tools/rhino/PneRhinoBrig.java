import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.ArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.builder.LiteralArgumentBuilder;
import com.mojang.brigadier.builder.RequiredArgumentBuilder;
import com.mojang.brigadier.context.CommandContext;
import com.mojang.brigadier.exceptions.CommandSyntaxException;

/**
 * Thin facade over real Brigadier for tools/rhino/PneRhino "run" mode (bound as __brig).
 * The source type is Object, so a test can pass a plain JS object as the command source.
 * Compiled only when the Brigadier jar is on the classpath (tools/rhino/pne_rhino.py handles that).
 */
public class PneRhinoBrig {
    public CommandDispatcher<Object> dispatcher() { return new CommandDispatcher<>(); }
    public LiteralArgumentBuilder<Object> literal(String name) { return LiteralArgumentBuilder.literal(name); }
    public RequiredArgumentBuilder<Object, ?> argument(String name, ArgumentType<?> type) { return RequiredArgumentBuilder.argument(name, type); }
    public ArgumentType<String> greedy() { return StringArgumentType.greedyString(); }
    public String getString(CommandContext<Object> ctx, String name) { return StringArgumentType.getString(ctx, name); }
    /** Returns the command result, or -1 with the parse error printed when the input does not parse. */
    public int execute(CommandDispatcher<Object> d, String input, Object source) {
        try {
            return d.execute(input, source);
        } catch (CommandSyntaxException e) {
            System.out.println("[brig] " + e.getMessage());
            return -1;
        }
    }
}
