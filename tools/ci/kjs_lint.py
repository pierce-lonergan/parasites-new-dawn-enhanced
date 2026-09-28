"""
Lint for the pack's KubeJS scripts (overrides/kubejs/**/*.js). Pure Python, no dependencies.

Every file (legacy files included), because KubeJS 2001.6.5 preprocesses each line (ScriptFileInfo.preload):
  - a line whose trimmed text starts with "import" is deleted before Rhino sees it;
  - a comment line "// key: value" (or "// key value") becomes a file property: "priority" must be an
    integer (KubeJS calls Integer.parseInt), and "ignored", "ignore", "packmode" or "requires" would silently
    skip the file or gate it on a mod.
  - Hive Remembers files must carry the exact priority from docs/IMPLEMENTATION.md (load order contract).

New (non-legacy) files, the Rhino ES5 rules from docs/IMPLEMENTATION.md:
  - no let/const, arrow functions, classes, template literals, spread/rest, destructuring, for-of,
    Object.entries/values/assign, Array.from, exponent operator, charCodeAt;
  - every var at function level: no var inside a block or a for(...) header (Rhino scopes var to its block
    and throws "Assignment to undeclared variable" outside it; measured with the instance's Rhino jar);
  - top-level var/function names carry the module prefix;
  - a file with a load-order priority has "// priority: N" on line 1;
  - no strict comparison on a value read from `global` (it comes back as a wrapped Java object, so
    `global.x === 1` and `global.x !== 0` are always false/true; use Number(global.x) or String(global.x));
  - comfort (I8): no nausea, blindness, darkness or confusion anywhere in code or command strings, and no
    tp/teleport aimed at a player selector (@a, @p, @r).
  - pne_hive_core.js must stay pure: no KubeJS globals, Date, Math.random or transcendental Math.
  - hidden Mojang names (contract F37): KubeJS hides some Minecraft methods behind its own names (@RemapForJS on its
    mixins' @Shadow methods, merged by Mixin), so e.g. level.getGameTime() does not exist in game, only getTime().
    A call of a fully hidden name (HIDDEN below) fails unless it is a guarded fallback: inside a try block, AND the same
    receiver's KubeJS name is called earlier in the same function (so the Mojang name runs only when the KubeJS name
    gave nothing, as in a catch block after it or an `if (!isFinite(t))` after it: mocks only). getEntity counts only on
    a damage source (source, damageSource, dmgSource, dmgSrc, x.source, x.getSource()); EntityEvents.hurt(...) is the
    KubeJS event, not Entity.hurt. The table is checked against tools/visual/kjs_renames.py (read from the KubeJS jar)
    when that file is present.

Every script folder (server_scripts, startup_scripts, client_scripts) is one script pack with one scope, so a
top-level var or function defined in two files of the same folder silently replaces the earlier one: the lint
fails on such duplicates when at least one of the files is new.

Usage: python tools/ci/kjs_lint.py [FILE...]      (default: every script under overrides/kubejs)
Exit 1 on any error.
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
KJS = os.path.join(ROOT, "overrides", "kubejs")

# Scripts that existed before The Hive Remembers. They keep their style (some use arrow functions, which
# the Rhino fork accepts). Only the KubeJS preprocessing traps are checked for them.
LEGACY = {
    "server_scripts/pne_comfort_guard.js", "server_scripts/pne_horde_cull.js", "server_scripts/pne_horror.js",
    "server_scripts/pne_recipes.js", "server_scripts/pne_serum.js", "server_scripts/pne_tags.js",
    "startup_scripts/pne_alliance.js", "startup_scripts/pne_hive_rules.js", "startup_scripts/pne_horde_rules.js",
    "startup_scripts/pne_items.js", "startup_scripts/pne_radiation_comfort.js",
}

# Load-order contract (docs/IMPLEMENTATION.md section 2). Higher loads first.
PRIORITY = {
    "server_scripts/pne_00_core.js": 100,
    "server_scripts/pne_hive_core.js": 95,
    "server_scripts/pne_res_catalog.js": 90,
    "server_scripts/pne_oracle_bridge.js": 80,
    "server_scripts/pne_resonance.js": 70,
    "server_scripts/pne_hive.js": 60,
    "server_scripts/pne_visual.js": 50,
}

# Top-level name prefixes per file (docs/IMPLEMENTATION.md section 4).
PREFIX = {
    "server_scripts/pne_00_core.js": ("pneCore", "PNE_CORE_", "$PneCore"),
    "server_scripts/pne_hive_core.js": ("PNE_HIVE_GA",),
    "server_scripts/pne_res_catalog.js": ("PNE_RES_CATALOG",),
    "server_scripts/pne_oracle_bridge.js": ("pneOra", "PNE_ORA_", "$PneOra"),
    "server_scripts/pne_resonance.js": ("pneRes", "PNE_RES_", "$PneRes"),
    "server_scripts/pne_hive.js": ("pneHive", "PNE_HIVE_", "$PneHive"),
    "server_scripts/pne_visual.js": ("pneVis", "PNE_VIS_", "$PneVis"),
    "startup_scripts/pne_hive_events.js": ("pneHiveEv", "PNE_HIVE_EV_", "$PneHiveEv"),
    "startup_scripts/pne_res_gate.js": ("pneResGate", "PNE_RES_GATE_", "$PneResGate"),
    "startup_scripts/pne_resonance_client_events.js": ("pneResCe", "PNE_RES_CE_", "$PneResCe"),
    "client_scripts/pne_resonance_client.js": ("pneResCl", "PNE_RES_CL_", "$PneResCl"),
}
DEFAULT_PREFIX = ("pne", "PNE_", "$Pne")

PROPERTY = re.compile(r"^(\w+)\s*[:=]?\s*(-?\w+)$")
SPECIAL = {"ignored", "ignore", "packmode", "requires"}

BANNED = [
    (re.compile(r"\blet\s+[A-Za-z_$\[{]"), "let"),
    (re.compile(r"\bconst\s+[A-Za-z_$\[{]"), "const"),
    (re.compile(r"=>"), "arrow function"),
    (re.compile(r"\bclass\s+[A-Za-z_$]"), "class"),
    (re.compile(r"\.\.\."), "spread/rest"),
    (re.compile(r"\bfor\s*\([^;)]*\bof\b"), "for-of"),
    (re.compile(r"\bObject\.(entries|values|assign|fromEntries)\b"), "ES2015+ Object method"),
    (re.compile(r"\bArray\.(from|of)\b"), "ES2015+ Array method"),
    (re.compile(r"\*\*"), "exponent operator"),
    (re.compile(r"\.charCodeAt\s*\("), "charCodeAt (Rhino returns a java.lang.Character)"),
    (re.compile(r"\bvar\s*[\[{]"), "destructuring"),
    (re.compile(r"\b(Symbol|Promise|Map|Set|WeakMap|Proxy|Reflect)\s*\("), "ES2015+ builtin"),
    (re.compile(r"\bnew\s+(Map|Set|WeakMap|Promise|Proxy)\b"), "ES2015+ builtin"),
]
PURE_BANNED = [
    (re.compile(r"\b(ServerEvents|PlayerEvents|EntityEvents|BlockEvents|LevelEvents|ForgeEvents|StartupEvents|Java|global|Utils|JsonIO|NBT)\b\s*[.\[(]"), "KubeJS global in the pure GA core"),
    (re.compile(r"\bDate\b"), "Date in the GA core"),
    (re.compile(r"\bMath\.(random|exp|log|pow|sin|cos|tan|sqrt|atan2|imul|cbrt|hypot)\b"), "non-deterministic or transcendental Math in the GA core"),
]

GLOBAL_STRICT = [
    (re.compile(r"\bglobal\s*\.\s*[A-Za-z_$][\w$]*\s*[!=]=="), "strict comparison on a global value (use Number(global.x) / String(global.x))"),
    (re.compile(r"[!=]==\s*global\s*\.\s*[A-Za-z_$]"), "strict comparison on a global value (use Number(global.x) / String(global.x))"),
]
COMFORT = [
    (re.compile(r"\b(nausea|blindness|darkness|confusion)\b", re.I), "comfort (I8): screen effect"),
    (re.compile(r"\b(tp|teleport)\s+@[apr]\b"), "comfort (I8): teleport aimed at players"),
]

# F37: fully hidden Mojang name -> the name scripts must call (no other overload keeps the Mojang name visible).
# Entity.getType -> getEntityType is left out: getType is also KubeJS's name for DamageSource.getMsgId.
HIDDEN = {
    "getUUID": "getUuid", "getStringUUID": "getStringUuid", "getScoreboardName": "getUsername",
    "isCurrentlyGlowing": "isGlowing", "setGlowingTag": "setGlowing", "getYRot": "getYaw", "setYRot": "setYaw",
    "getXRot": "getPitch", "setXRot": "setPitch", "getDirection": "getHorizontalFacing", "clearFire": "extinguish",
    "hurt": "attack", "distanceTo": "distanceToEntity", "getGameTime": "getTime", "dimension": "getDimensionKey",
    "isDedicatedServer": "isDedicated", "stopServer": "stop", "getStats": "getStatsCounter",
    "closeContainer": "closeMenu", "getMsgId": "getType", "getEntity": "getActual", "getDirectEntity": "getImmediate",
    "enchant": "enchantStack", "setTag": "setNbt", "hasTag": "hasNBT", "getTag": "getNbt",
}
DAMAGE_SOURCE_RECEIVER = re.compile(r"(^|\.)(source|damageSource|dmgSource|dmgSrc)$|\.getSource\(\)$")
# hasTag is hidden only on ItemStack (-> hasNBT); BlockContainerJS.hasTag(ResourceLocation) is KubeJS's own method
# (contract 3.2.1, the FLK ground test), so a call on level.getBlock(...) is not a hidden name.
BLOCK_RECEIVER = re.compile(r"(^|\.)getBlock\(.*\)$")
RENAMES_FILE = os.path.join(ROOT, "tools", "visual", "kjs_renames.py")
RENAMES_ROW = re.compile(r'\(\s*\w+\s*,\s*"[^"]+"\s*,\s*"(\w+)"\s*,\s*"(\w+)"\s*,\s*(True|False)\s*\)')

REGEX_PREV = set("(,=:[!&|?{};+-*%<>~^")
REGEX_KW = {"return", "typeof", "case", "in", "of", "delete", "void", "throw", "new", "else", "do"}


def strip(src, keep_strings=False):
    """Blank out comments, string/regex contents and template literals; keep newlines and quotes.
    With keep_strings, string and template contents are kept (only comments are blanked).
    Returns (code, template_lines)."""
    out = []
    i, n = 0, len(src)
    templates = []
    prev_sig = ""
    prev_word = ""
    line = 1
    while i < n:
        ch = src[i]
        nx = src[i + 1] if i + 1 < n else ""
        if ch == "\n":
            line += 1
            out.append(ch)
            i += 1
            continue
        if ch == "/" and nx == "/":
            while i < n and src[i] != "\n":
                out.append(" ")
                i += 1
            continue
        if ch == "/" and nx == "*":
            while i < n and not (src[i] == "*" and i + 1 < n and src[i + 1] == "/"):
                out.append("\n" if src[i] == "\n" else " ")
                if src[i] == "\n":
                    line += 1
                i += 1
            out.append("  ")
            i += 2
            continue
        if ch in "'\"":
            q = ch
            out.append(q)
            i += 1
            while i < n and src[i] != q and src[i] != "\n":
                if src[i] == "\\":
                    out.append(src[i:i + 2] if keep_strings else "  ")
                    i += 2
                    continue
                out.append(src[i] if keep_strings else " ")
                i += 1
            out.append(q)
            i += 1
            prev_sig, prev_word = q, ""
            continue
        if ch == "`":
            templates.append(line)
            out.append(" ")
            i += 1
            while i < n and src[i] != "`":
                out.append("\n" if src[i] == "\n" else (src[i] if keep_strings else " "))
                if src[i] == "\n":
                    line += 1
                i += 1
            out.append(" ")
            i += 1
            continue
        if ch == "/" and (prev_sig == "" or prev_sig in REGEX_PREV or prev_word in REGEX_KW):
            out.append("/")
            i += 1
            in_class = False
            while i < n and src[i] != "\n":
                c = src[i]
                if c == "\\":
                    out.append("  ")
                    i += 2
                    continue
                if c == "[":
                    in_class = True
                elif c == "]":
                    in_class = False
                elif c == "/" and not in_class:
                    break
                out.append(" ")
                i += 1
            out.append("/")
            i += 1
            while i < n and src[i].isalpha():
                out.append(src[i])
                i += 1
            prev_sig, prev_word = "/", ""
            continue
        out.append(ch)
        if not ch.isspace():
            if ch.isalnum() or ch in "_$":
                j = i
                while j < n and (src[j].isalnum() or src[j] in "_$"):
                    j += 1
                word = src[i:j]
                out.extend(src[i + 1:j])
                i = j
                prev_sig, prev_word = word[-1], word
                continue
            prev_sig, prev_word = ch, ""
        i += 1
    return "".join(out), templates


def header_checks(rel, src, errors):
    prio = []
    for ln, raw in enumerate(src.split("\n"), 1):
        t = raw.strip()
        if t.startswith("import"):
            errors.append(f"{rel}:{ln}: line starts with 'import'; KubeJS deletes it before running the file")
        if t.startswith("//"):
            m = PROPERTY.match(t[2:].strip())
            if m:
                key = m.group(1)
                if key == "priority":
                    prio.append((ln, m.group(2)))
                elif key in SPECIAL:
                    errors.append(f"{rel}:{ln}: comment '{t}' is read by KubeJS as the file property '{key}'")
    for ln, v in prio:
        if not re.fullmatch(r"-?\d+", v):
            errors.append(f"{rel}:{ln}: priority '{v}' is not an integer; KubeJS would fail to load the file")
    if len(prio) > 1:
        errors.append(f"{rel}: {len(prio)} priority comment lines; KubeJS uses the last one. Keep exactly one, on line 1")
    want = PRIORITY.get(rel)
    got = int(prio[-1][1]) if prio and re.fullmatch(r"-?\d+", prio[-1][1]) else 0
    if want is not None and got != want:
        errors.append(f"{rel}: priority is {got}, the load-order contract says '// priority: {want}' on line 1")
    if want is not None and rel not in LEGACY and src.split("\n", 1)[0].strip() != f"// priority: {want}":
        errors.append(f"{rel}:1: line 1 must be exactly '// priority: {want}'")


def es5_checks(rel, src, errors):
    code, templates = strip(src)
    for ln in templates:
        errors.append(f"{rel}:{ln}: template literal")
    lines = code.split("\n")
    for ln, text in enumerate(lines, 1):
        for rx, what in BANNED + GLOBAL_STRICT:
            if rx.search(text):
                errors.append(f"{rel}:{ln}: {what}")
    with_strings, _ = strip(src, keep_strings=True)
    for ln, text in enumerate(with_strings.split("\n"), 1):
        for rx, what in COMFORT:
            if rx.search(text):
                errors.append(f"{rel}:{ln}: {what}")
        if rel.endswith("pne_hive_core.js"):
            for rx, what in PURE_BANNED:
                if rx.search(text):
                    errors.append(f"{rel}:{ln}: {what}")
    # var placement and top-level names
    stack = []
    pending_fn = False
    paren = 0
    for_paren = []
    prefixes = PREFIX.get(rel, DEFAULT_PREFIX)
    tok = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*|[{}()]")
    for ln, text in enumerate(lines, 1):
        words = tok.findall(text)
        for k, w in enumerate(words):
            if w == "function":
                pending_fn = True
                if not stack and k + 1 < len(words) and words[k + 1] not in "({":
                    name = words[k + 1]
                    if not name.startswith(prefixes):
                        errors.append(f"{rel}:{ln}: top-level function '{name}' lacks the module prefix {prefixes}")
            elif w == "{":
                stack.append("F" if pending_fn else "B")
                pending_fn = False
            elif w == "}":
                if stack:
                    stack.pop()
            elif w == "(":
                paren += 1
                if k > 0 and words[k - 1] == "for":
                    for_paren.append(paren)
            elif w == ")":
                if for_paren and for_paren[-1] == paren:
                    for_paren.pop()
                paren -= 1
            elif w == "var":
                if for_paren:
                    errors.append(f"{rel}:{ln}: 'for (var ...)' - declare the counter at the top of the function")
                elif stack and stack[-1] == "B":
                    errors.append(f"{rel}:{ln}: var inside a block - Rhino scopes it to the block; declare it at the top of the function")
                elif not stack and k + 1 < len(words):
                    name = words[k + 1]
                    if not name.startswith(prefixes):
                        errors.append(f"{rel}:{ln}: top-level var '{name}' lacks the module prefix {prefixes}")


def receiver_of(code, dot):
    """The receiver expression before code[dot] == '.': identifiers, dots and balanced (...)/[...] groups, without
    whitespace (string contents are already blanked, so equal receivers compare equal)."""
    j = dot - 1
    depth = 0
    while j >= 0:
        c = code[j]
        if c in ")]":
            depth += 1
        elif c in "([":
            if depth == 0:
                break
            depth -= 1
        elif depth == 0 and c.isspace():
            k = j
            while k >= 0 and code[k].isspace():
                k -= 1
            if k < 0 or code[k] != ".":
                break
        elif depth == 0 and not (c.isalnum() or c in "_$."):
            break
        j -= 1
    return re.sub(r"\s+", "", code[j + 1:dot])


def hidden_name_checks(rel, src, errors):
    """F37: a fully hidden Mojang name only as a guarded fallback after the same receiver's KubeJS name."""
    code, _ = strip(src)
    tok = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*|[{}()]")
    stack = []          # entries (kind, start): F function body, T try body, C catch body, B other block
    parens = []         # the word before each open '('
    pending_fn = False
    last = ""           # previous token
    last_closed = ""    # the word before the '(' that the last ')' closed
    for m in tok.finditer(code):
        w = m.group(0)
        pos = m.start()
        if w == "function":
            pending_fn = True
        elif w == "(":
            parens.append(last if re.match(r"[A-Za-z_$]", last or " ") else "")
        elif w == ")":
            last_closed = parens.pop() if parens else ""
        elif w == "{":
            if pending_fn:
                kind = "F"
                pending_fn = False
            elif last == "try":
                kind = "T"
            elif last == ")" and last_closed == "catch":
                kind = "C"
            else:
                kind = "B"
            stack.append((kind, pos))
        elif w == "}":
            if stack:
                stack.pop()
        elif w in HIDDEN:
            before = code[:pos].rstrip()
            after = code[m.end():].lstrip()
            if before.endswith(".") and after.startswith("("):
                recv = receiver_of(code, len(before) - 1)
                new = HIDDEN[w]
                skip = ((w == "getEntity" and not DAMAGE_SOURCE_RECEIVER.search(recv)) or (w == "hurt" and recv == "EntityEvents")
                        or (w == "hasTag" and BLOCK_RECEIVER.search(recv)))
                if not skip:
                    fn_start = 0
                    in_try = False
                    for kind, start in reversed(stack):
                        if kind == "F":
                            fn_start = start
                            break
                        if kind == "T":
                            in_try = True
                    seg = re.sub(r"\s+", "", code[fn_start:pos])
                    first = (recv + "." + new + "(") in seg
                    if not (in_try and first):
                        ln = code.count("\n", 0, pos) + 1
                        why = []
                        if not first:
                            why.append("no %s.%s() before it in this function" % (recv, new))
                        if not in_try:
                            why.append("not inside a try block")
                        errors.append(f"{rel}:{ln}: {recv}.{w}() does not exist in game (F37: KubeJS shows it only as "
                                      f"{new}()); call {recv}.{new}() first and keep {w}() only as a guarded fallback for "
                                      f"mocks ({'; '.join(why)})")
        last = w


def renames_table_check(errors):
    """HIDDEN must equal the fully hidden names of tools/visual/kjs_renames.py (checked against the KubeJS jar there)."""
    if not os.path.isfile(RENAMES_FILE):
        return
    rows = RENAMES_ROW.findall(open(RENAMES_FILE, encoding="utf-8").read())
    if not rows:
        errors.append("tools/visual/kjs_renames.py: no RENAMES rows found (the lint's F37 table cannot be checked)")
        return
    new_names = {r[1] for r in rows}
    want = {r[0]: r[1] for r in rows if r[2] == "True" and r[0] not in new_names}
    if want != HIDDEN:
        errors.append("tools/ci/kjs_lint.py HIDDEN differs from tools/visual/kjs_renames.py: only in the lint %s; only in "
                      "kjs_renames %s" % (sorted(set(HIDDEN.items()) - set(want.items())),
                                          sorted(set(want.items()) - set(HIDDEN.items()))))


def top_names(src):
    """Top-level var/let/const/function names of a file (brace depth 0), with line numbers."""
    code, _ = strip(src)
    out = []
    depth = 0
    tok = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*|[{}()]")
    for ln, text in enumerate(code.split("\n"), 1):
        words = tok.findall(text)
        for k, w in enumerate(words):
            if w == "{":
                depth += 1
            elif w == "}":
                depth = max(0, depth - 1)
            elif depth == 0 and w in ("var", "let", "const", "function") and k + 1 < len(words) and words[k + 1] not in ("{", "}", "(", ")"):
                out.append((words[k + 1], ln))
    return out


def duplicate_checks(entries, errors):
    """entries: [(rel, src)]. One scope per script folder (F1): a name defined twice replaces the first."""
    seen = {}
    for rel, src in entries:
        folder = rel.split("/", 1)[0]
        for name, ln in top_names(src):
            key = (folder, name)
            if key in seen and seen[key][0] != rel:
                first, fln = seen[key]
                if first not in LEGACY or rel not in LEGACY:
                    errors.append(f"{rel}:{ln}: top-level '{name}' is also defined in {first}:{fln}; one scope per "
                                  f"{folder} folder, so the later file silently replaces it")
            else:
                seen.setdefault(key, (rel, ln))


def rel_of(p):
    full = os.path.realpath(p).replace(os.sep, "/")
    cut = full.rfind("overrides/kubejs/")
    return full[cut + len("overrides/kubejs/"):] if cut >= 0 else os.path.basename(full)


def lint(paths, all_paths=None):
    errors = []
    for p in paths:
        rel = rel_of(p)
        src = open(p, encoding="utf-8").read()
        header_checks(rel, src, errors)
        if rel not in LEGACY:
            es5_checks(rel, src, errors)
            hidden_name_checks(rel, src, errors)
    renames_table_check(errors)
    # The duplicate check sees the whole pack: the repo's scripts, with the linted files in place of the
    # repo copies of the same name (so a builder can lint a draft against everything else).
    pack = {}
    for p in list(all_paths or []) + list(paths):
        pack[rel_of(p)] = p
    duplicate_checks([(rel, open(pack[rel], encoding="utf-8").read()) for rel in sorted(pack)], errors)
    return errors


def main(argv):
    every = sorted(glob.glob(os.path.join(KJS, "**", "*.js"), recursive=True))
    paths = argv[1:] or every
    errors = lint(paths, every)
    for e in errors:
        print("  FAIL  " + e)
    print(f"kjs_lint: {len(paths)} file(s), {len(errors)} problem(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
