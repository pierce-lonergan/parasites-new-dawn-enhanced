# The Hive Remembers: implementation contract (M0-M5)

Version 1.4 · 2026-09-28 · companion to [TDD.md](TDD.md) v1.1 (1.1: review round 1 applied; 1.2: integration round,
verified corrections and the registry of what the modules added; 1.3: lead decisions of integration round 2 and the
test infrastructure that sees F37; 1.4: the polish round (beds out of the pack, the dream gate, the incremental save and
load epoch, tells for every nearby player, FLK placement of reinforcements); all are summarised at the end, with the
decisions still open)

Six builders work in parallel on this branch and never talk to each other. This document is the only thing
they share. **Names, file paths, keys, tags, priorities, return shapes and tick slots in this document are
binding.** A builder may add private names inside its own module prefix, but must not rename, reshape or
reinterpret anything listed here. If something here is wrong or missing, the builder reports it to the lead
instead of working around it in another module's file.

The shared core already exists and passes its tests:
`overrides/kubejs/server_scripts/pne_00_core.js`, `tools/run_tests.py`, `tools/rhino/*`, `tools/tests/*`,
`tools/ci/kjs_lint.py`, `tools/ci/no_kill.py`. Run `python tools/run_tests.py` before and after every change.

Contents: 1 verified platform facts · 2 module map and file ownership · 3 global API contract · 4 shared state
registry · 5 generated sound catalog · 6 config, kill switches and the `/pne` tree · 7 tick schedule and token
budget · 8 degradation matrix · 9 test conventions · 10 milestone exit criteria · Appendix A coding rules and the
handler template.

---

## 1. Verified platform facts

Status: **verified** = read from the bytecode of the exact installed jars, or run in the instance's own Rhino
jar (`rhino-forge-2001.2.3-build.10`) with JDK 17; **inferred** = follows from verified facts or from a harness
with mock classes, not run in game; **in-game** = only the game can confirm it (listed again in section 10).
Class names are KubeJS 2001.6.5 (`dev.latvian.mods.kubejs.*`), Architectury 9.2.14, Forge 47.4.10, Minecraft
1.20.1 (SRG runtime names).

| # | Fact | Status | Evidence |
| --- | --- | --- | --- |
| F1 | All files in `server_scripts/` form **one script pack with one scope**, so a top-level `var`/`function` in one file is visible to every other server script at call time. At load time only files loaded earlier have run. | verified | `ScriptManager.loadFromDirectory` makes one `ScriptPack` per script-type folder; `ScriptManager.load` gives each pack one `NativeObject` scope (parent = `topLevelScope`) and `ScriptFile.load` evaluates every file into `pack.scope`. |
| F2 | **Load order**: files are sorted by the `priority` property, **highest first**; ties keep discovery order (`Files.walk`, i.e. filesystem order, not a documented alphabetical sort). Default priority 0. | verified | `ScriptFile.compareTo` = `Integer.compare(other.priority, this.priority)`; `pack.scripts.sort(null)` (stable); `KubeJS.loadScripts` uses `Files.walk(path, 10, FOLLOW_LINKS)`. |
| F3 | **Header syntax**: every line whose trimmed text starts with `//` is matched against `^(\w+)\s*[:=]?\s*(-?\w+)$` (after the `//`) and becomes a file property; this applies to **every line of the file**, not only the header. `priority` goes through `Integer.parseInt` (a non-integer throws and the file fails to load). `ignored: true` / `ignore: true` skip the file, `packmode: x` gates it on the pack mode. `priority`, `ignored`, `ignore` and `packmode` take the **last** match; `requires` **collects every match** (each `// requires: x` line anywhere in the file adds a required mod). So the header is exactly `// priority: 100` on line 1, and no other two-word comment may start with `priority`, `ignored`, `ignore`, `packmode` or `requires`. | verified | `ScriptFileInfo.preload` (`getProperty` = last element for priority/ignored/ignore/packmode; `requiredMods.addAll(getProperties("requires"))`) and its static initialiser (`PROPERTY_PATTERN`); `ScriptFileInfo.skipLoading`. |
| F4 | KubeJS **deletes every line whose trimmed text starts with `import`** (for example a line starting with a variable called `importance`) and every `//` comment line before Rhino compiles the file. | verified | `ScriptFileInfo.preload` blanks those lines. `tools/ci/kjs_lint.py` rejects such lines. |
| F5 | Startup, server and client scripts are **separate script managers** (own `Context`, own scope). They share nothing except the `global` binding, which is one static `java.util.HashMap` (`BuiltinKubeJSPlugin.GLOBAL`) for all script types. It is not cleared by `/reload`. | verified | `BuiltinKubeJSPlugin.registerBindings`: `event.add("global", GLOBAL)`. |
| F6 | **Every value read back from `global` is a wrapped Java object**, in the context that wrote it and in every other: `HashMap.get` has static type `Object`, and the fork's `WrapFactory` keeps `javaPrimitiveWrap = true` (KubeJS never replaces it). A stored JS number comes back as a `NativeJavaObject` around `java.lang.Double`: `typeof` is `'object'`, **`=== 1` is always false and `!== 0` always true**, `== 0` works only by coercion (a wrapped 0 happens to be falsy in this fork). A string comes back as a `java.lang.String` object (`.split('\|')` runs Java's regex split: 3 parts for `'a\|b'`). A missing key reads as `undefined`. Always convert first: `var v = global.x; var n = (v === undefined \|\| v === null) ? DEFAULT : Number(v)`, and `String(global.x)` for strings. Functions and objects stay callable from the other context. | verified | real Rhino jar through `tools/rhino/pne_rhino.py run`: after `global.a = 0; global.b = 1`: `typeof global.a` = `object`, `global.a !== 0` = true, `global.a === 0` = false, `global.a == 0` = true, `global.b === 1` = false, `Number(global.a) === 0` = true; `String(global.s).split('\|').length` = 2, unwrapped 3. `core-rhino` asserts it; the Node harness now wraps the same way. |
| F7 | **Entity scoreboard tags** are a Java `Set<String>` on the entity: readable from startup and server scripts alike, saved with the entity, and **copied to the new player object on respawn**. | verified | `PlayerList.respawn` (`m_11236_`) iterates `old.getTags()` and calls `addTag` on the new `ServerPlayer`. |
| F8 | `entity.persistentData` (and `entity.getPersistentData()`) is **KubeJS's own `CompoundTag`** (field `kjs$persistentData`, saved in the entity NBT under `KubeJSPersistentData`), **not Forge's `ForgeData`**, so `pne_*` keys never collide with EPCA's 87 ForgeData call sites. The name is unambiguous only because KubeJS renames Forge's method: its forge `EntityMixin` declares `@Shadow(remap=false) @RemapForJS("getForgePersistentData") getPersistentData()`, and Mixin copies a `@Shadow` method's runtime annotations onto the target method, so JS sees Forge's tag only as `getForgePersistentData()`. Without that rename both zero-argument methods are named `getPersistentData` and **the winner changes from one JVM run to the next** (HotSpot's method order), which is what the first mock harness measured. `/pne status` shows `pd=kjs` once a player logged in and `getForgePersistentData` was present (`pd=AMBIGUOUS` plus one log warning otherwise). | verified (save/load; annotation merge; harness) · in-game (`pd=kjs`) | `EntityMixin.kjs$getPersistentData`, `saveKJS` (inject at `saveWithoutId` RETURN), `loadKJS` (at `load` RETURN); `kubejs.core.mixin.forge.EntityMixin` bytecode (the annotation above); `mixin-0.8.5` `MixinApplicatorStandard.applyShadowMethod` calls `Annotations.merge(MethodNode, MethodNode)`; `JavaMembers.getAccessibleMethods` reads `RemapForJS` before the remapper. Harness, 8 JVM runs: a mock with KubeJS's annotations (and a subclass that overrides without them) always gave `persistentData` = KubeJS, `getForgePersistentData()` = Forge; the same mock **without** the `@RemapForJS` gave KubeJS, Forge, KubeJS on three runs. |
| F9 | `player.persistentData` survives death: KubeJS copies it from the old to the new player before `PlayerEvents.respawned` fires (this rests on F8: Forge's own tag keeps only its `PlayerPersisted` child). | verified (copy) · in-game (with F8) | `KubeJSPlayerEventHandler.respawn`: `setRawPersistentData(old.getRawPersistentData())`, then posts `RESPAWNED`. |
| F10 | `server.persistentData` is a `CompoundTag` on `MinecraftServer`, loaded in `SERVER_BEFORE_START` from `<world>/kubejs_persistent_data.nbt` and written (as a `copy()`) when the overworld saves. On the first world load the server does not exist yet while server scripts load, so modules read it in `ServerEvents.loaded` or lazily on the first tick. | verified | `KubeJSServerEventHandler.serverBeforeStart` / `serverLevelSaved` (overworld only). |
| F11 | Each NBT **string** tag is limited to 65,535 modified-UTF-8 bytes (TDD 3.7). | verified (TDD) | `StringTag.write` uses `writeUTF`. |
| F12 | `ServerEvents.commandRegistry` fires **after every server script has loaded** (scripts load in `ServerScriptManager.wrapResourceManager` before `Commands` is constructed), so modules can register subcommands at load time and one handler can build the tree. | verified | `WorldLoaderPackConfigMixin` → `ServerScriptManager.wrapResourceManager` → `reload()`; `KubeJSServerEventHandler.registerCommands` posts `COMMAND_REGISTRY`. |
| F13 | Brigadier **merges** literals with the same name (`CommandNode.addChild`: children merged recursively, a later `executes` replaces the earlier one, the **first** node's `requires` is kept). Several modules could register `pne`, but permission and root-command collisions would be silent. Decision: **one hub** in the core. | verified | `brigadier-1.1.8.jar` `CommandNode.addChild`. |
| F14 | The Rhino fork adapts JS functions to Brigadier's `Command` interface and greedy string arguments arrive intact. | verified (harness) | `tools/tests/core/hub_brigadier.js` builds `/pne` with real Brigadier 1.1.8 and runs commands through a real `CommandDispatcher` (6/6 pass). In game, `event.commands` / `event.arguments` are `ClassWrapper`s whose static `literal`, `argument`, `GREEDY_STRING.create/getResult` the hub calls: **inferred**. |
| F15 | `ServerEvents.tick` fires at the **end** of every server tick (after all levels ticked and after KubeJS's scheduled events). `server.getTickCount()` gives the same value to every handler in one tick and does not reset on `/reload`. | verified | `MinecraftServerMixin` injects at `tickServer` RETURN; `MinecraftServer.m_129921_`. |
| F16 | Handlers of one KubeJS event run **in registration order**, i.e. file load order (F2). An uncaught exception or `event.cancel()` (an `EventExit`) **stops the remaining handlers** of that event. Hence every handler catches its own errors. | verified | `EventHandlerContainer.add` appends to the chain end; `handle()` walks it and rethrows `EventExit`. |
| F17 | **`EntityEvents.checkSpawn` cannot deny spawns reliably**: it maps to Forge `MobSpawnEvent.FinalizeSpawn`, and Architectury 9.2.14 calls `setSpawnCancelled(result.value())`. KubeJS `event.cancel()` produces `interruptFalse` (value `false`), so the spawn is **not** cancelled; `event.success()` would cancel it. That inversion is a bug that a mod update could flip. Decision: the natural-spawn gate uses Forge `MobSpawnEvent$PositionCheck` from a startup script instead (F18). | verified | `EventHandlerImplCommon.eventLivingSpawnEvent`; `EventResult$Type` (`INTERRUPT_FALSE` → `interruptFalse()`); `EventJS.cancel()`. |
| F18 | `MobSpawnEvent$PositionCheck` with `setResult(Event$Result.DENY)` makes `ForgeEventFactory.checkSpawnPosition` return false (DEFAULT → vanilla checks, ALLOW → true, DENY → false). `NaturalSpawner` and `BaseSpawner` call it. | verified | Forge universal jar `ForgeEventFactory.checkSpawnPosition`, patched `NaturalSpawner`. |
| F19 | `EntityEvents.spawned` = Forge `EntityJoinLevelEvent`, which also fires **when a chunk loads its entities**. `event.cancel()` sets the event cancelled, so the entity is never added: for a chunk-loaded entity that **deletes it**. Never cancel `spawned` for parasites; queue them instead. | verified | `EventHandlerImplCommon.event(EntityJoinLevelEvent)` → `setCanceled(true)` on `isFalse()`. |
| F20 | `EntityEvents.death` = `LivingDeathEvent`; `EntityEvents.hurt` = `LivingAttackEvent` (before armour, and fires again during invulnerability frames). Damage that actually landed is only visible to startup `ForgeEvents` (`LivingDamageEvent`). | verified | `EventHandlerImplCommon` (`LIVING_HURT` ← `LivingAttackEvent`). |
| F21 | `LivingDamageEvent` fires **before** `setHealth`, so `victim.getHealth()` inside it is the health at impact. `LivingHurtEvent` fires before armour (right place for projectile scaling). | verified | patched `LivingEntity.m_6475_`: `ForgeHooks.onLivingHurt` (offset 11), armour (`m_21161_`), `ForgeHooks.onLivingDamage` (121), then `getHealth`/`setHealth` (142/147). |
| F22 | `ForgeEvents` is bound only in startup scripts. `ForgeEvents.onEvent` registers at NORMAL priority without `receiveCanceled`; use `MinecraftForge.EVENT_BUS.addListener(priority, receiveCanceled, eventClass, fn)` for anything else (as `pne_hive_rules.js` does). | verified | `BuiltinKubeJSForgePlugin.registerBindings` (`isStartup`); existing `pne_hive_rules.js`. |
| F23 | `JsonIO.read(path)` returns a map, or **null when the file is missing**, and **throws on a torn file**; numbers, and strings that parse as numbers (a `boot_id`), come back as `com.google.gson.internal.LazilyParsedNumber` (`Number(v)` / `String(v)` convert; `===` is always false). `JsonIO.write(path, obj)` **truncates the file and rewrites it in place** (`Files.newBufferedWriter`, default options CREATE, TRUNCATE_EXISTING, WRITE; tab-indented); it deletes the file only for a null or JSON-null object. **Not atomic**: a reader can see an empty or partial file. Paths are strings resolved against the game directory; anything outside it becomes `null` (then `write` throws a `NullPointerException`). **No folder is created.** Numbers are written as doubles (`1.0`). | verified | `JsonIO.readJson/read/write` (javap of kubejs-forge-2001.6.5-build.26: `deleteIfExists` only on the null branch), `MapJS.of` → `JsonUtils.toObject`, `UtilsJS.getPath` → `KubeJS.verifyFilePath`; a Java run of that writer while a Python reader held the file (ORACLE). |
| F24 | **AttributeModifier from Rhino, remap-safe**: `new $AttributeModifier(uuid, 'pne.gene.spd', amount, $Operation.MULTIPLY_BASE)` (constructors are not remapped; enum constants `ADDITION`, `MULTIPLY_BASE`, `MULTIPLY_TOTAL` keep their names at runtime). The attribute comes remap-free from `ForgeRegistries.ATTRIBUTES.getValue(new $ResourceLocation('minecraft', 'generic.movement_speed'))`. Instance methods by **Mojang name only** (F34): `mob.getAttribute(attr)` (`m_21051_`), `inst.getModifier(uuid)` (`m_22111_`), `inst.addPermanentModifier(mod)` (`m_22125_`, **throws on a duplicate UUID**: check first), `inst.addTransientModifier(mod)` (`m_22118_`), `inst.removeModifier(uuid)` (`m_22120_`), `inst.removePermanentModifier(uuid)` (`m_22127_`), `inst.getBaseValue()` (`m_22115_`). UUIDs: `Java.loadClass('java.util.UUID').fromString(str)`. | verified (bytecode, mappings) · in-game (behaviour) | SRG client jar `AttributeModifier`, `AttributeModifier$Operation`, `AttributeInstance`, `LivingEntity`; all Mojang names above are present in the Rhino fork's `mm.jsmappings` (gzip). The existing scripts' `entity['m_...']()` second tries never fire in game (F34). |
| F25 | `Java.loadClass` goes through KubeJS's class filter: `java.lang.*` is denied except boxed types, `String`, `StringBuilder`, `Object`, `Iterable` and a few more (so **no `System.nanoTime`, no `Math` class, no threads**); `java.util.*` is allowed (`UUID`, `ArrayList`, `HashMap`); `java.io`, `java.nio`, `java.net` are denied; `net.minecraft`, `net.minecraftforge` (not `fml`), `com.mojang.brigadier`, `dev.architectury` are allowed. | verified | replica of `ClassFilter.isAllowed0` + plugin rules (`tools/rhino/PneRhino.java` `KubeFilter`, carried over from the measured prototype). |
| F26 | **Rhino quirks** (measured in the instance's jar): `var` is scoped to its block (a `var` declared in an `if`/`try`/loop body, or in a `for (var ...)` header, is invisible after the block and assigning it there throws "Assignment to undeclared variable"); `'x'.charCodeAt(0)` returns a `java.lang.Character`, and using it in any expression throws `InternalError: Invalid JavaScript value of type java.lang.Character`; `JSON.stringify({a: 1})` prints `{"a":1.0}`; `let`, `const`, arrow functions and template literals **parse** in this fork (so a compile check cannot catch them; the lint does); `sort` with a total comparator is correct; **`Math.PI`, `Math.E` and the other `Math` constants are `undefined`** (`180 / Math.PI` is NaN: write the literal). | verified | harness probes with `rhino-forge-2001.2.3-build.10.jar` (the Math constants: ORACLE's probe, and the pack smoke test, whose own mock world placed every spawn at NaN until it used a literal). |
| F27 | Rhino **skips a bean property when a method of the same name exists**: `server.overworld` is the Mojang method `overworld()`, not KubeJS's `getOverworld()`. Always call methods explicitly: `server.getOverworld()`, `server.getPlayers()`, `entity.getPersistentData()` or `entity.persistentData` (safe, no clash). | verified | harness with a mock class having both `overworld()` and `getOverworld()`: `typeof srv.overworld` = `function`. |
| F28 | `entity.type` is the registry id string (`'epca:ripper'`, KubeJS's `kjs$getType`), because KubeJS renames vanilla `Entity.getType()` (`m_6095_`) to **`getEntityType()`** with `@Shadow @RemapForJS("getEntityType")`, merged by Mixin exactly as in F8. The real `EntityType` is `entity.getEntityType()` (or `ForgeRegistries.ENTITY_TYPES.getValue(new ResourceLocation(id))`); `entity['m_6095_']()` does not exist in game (F34). `pneCoreTypeId` still accepts the other shapes (`getEncodeId()`, a registry key, `'entity.<ns>.<path>'`) like `pneHTypeId`. | verified (bytecode, annotation merge, harness) · in-game | `EntityKJS.kjs$getType`; `kubejs.core.mixin.common.EntityMixin` (`m_6095_` `@RemapForJS("getEntityType")`, also `m_20148_` → `getUuid`, `m_20149_` → `getStringUuid`); harness as in F8. |
| F29 | `server.runCommandSilent(cmd)` runs as the server (permission 4, output suppressed) and returns the command's int result (0 on failure). | verified | `MinecraftServerKJS.kjs$runCommandSilent` → `Commands.performPrefixedCommand`. |
| F30 | `PlayerEvents.respawned(event)` gives `event.player` (the new player). `PlayerEvents.loggedIn` gives `event.player`. `EntityEvents.death('minecraft:player', fn)` filters by type. | verified | `KubeJSPlayerEventHandler`, `EntityEvents` binding. |
| F31 | `player.sendData(channel, compoundTag)` and `server.sendData` exist (client scripts receive with `NetworkEvents.dataReceived`). `Platform` is a binding. `Date` and `Math.random` exist in Rhino (banned only in the GA core). `MinecraftServer.isSingleplayerOwner(GameProfile)` exists (`m_7779_`, in the mappings). | verified (signatures) · in-game (client delivery) | `PlayerKJS.kjs$sendData`, `MinecraftServerKJS.kjs$sendData`, `BuiltinKubeJSPlugin` bindings, SRG jar. |
| F32 | `EntityLeaveLevelEvent` carries no reason; `entity.getRemovalReason()` (`m_146911_`) gives it (TDD 3.2). | verified (TDD) | `Entity.m_146911_` in the SRG jar. |
| F33 | Mob navigation access from Rhino (`Mob#getNavigation`) for scent and flank pathing. | in-game | TDD open question 4. |
| F34 | **SRG names are invisible to scripts.** KubeJS installs the fork's `MinecraftRemapper` (`ScriptManager.load` → `Context.setRemapper`); `JavaMembers` then registers only the mapped Mojang name of a mapped method. `t.putInt('a', 1)` works on a real SRG `CompoundTag`, `t['m_128405_']` is `undefined`. So "Mojang name, SRG name as a fallback" is dead code: call Mojang names (or KubeJS's names) only. `tools/rhino/PneRhino` run mode installs the same remapper from the Rhino jar's `mm.jsmappings` (binding `__pneRemap` = `'minecraft'`). | verified | `ScriptManager.load` bytecode; real Rhino jar + `MinecraftRemapper.load(mm.jsmappings)` + the SRG client jar's `CompoundTag`. |
| F35 | Forge `EntityJoinLevelEvent` has `loadedFromDisk()` (true when a chunk loads a saved entity). KubeJS's `EntityEvents.spawned` does not expose it; a startup `ForgeEvents` listener can. | verified | Forge 47.4.10 universal jar, `EntityJoinLevelEvent` (field and accessor `loadedFromDisk`). |
| F36 | Death causes by the damage source's msgId: void `outOfWorld`, `/kill` `genericKill`, fall `fall`; the causing entity is a projectile's owner, the direct entity the projectile. In scripts these are **`source.getType()`, `source.getActual()` and `source.getImmediate()`** (KubeJS renames `getMsgId`, `getEntity` and `getDirectEntity`, F37). | inferred (1.20.1 damage types) · in-game | vanilla `DamageTypes`; used by `pneCoreDeathCause` / `pneCoreSourceEntity`. |
| F37 | **KubeJS hides some Mojang method names.** Its mixins put `@RemapForJS("newName")` on `@Shadow` methods and Mixin merges that annotation (the F8 mechanism), so scripts see the method **only under the new name**. The ones this pack touches: `Level.getGameTime()` → **`getTime()`**, `Level.dimension()` → `getDimensionKey()`, `DamageSource.getMsgId()` → `getType()`, `getEntity()` → `getActual()`, `getDirectEntity()` → `getImmediate()`, `Entity.getYRot()/getXRot()` → `getYaw()/getPitch()`, `hurt()` → `attack()`, `getUUID()/getStringUUID()` → `getUuid()/getStringUuid()`, `getType()` → `getEntityType()` (F28), `MinecraftServer.isDedicatedServer()` → `isDedicated()`, `ItemStack.getTag()` → `getNbt()`. Call the KubeJS name; a Mojang name may stay only as a fallback for mocks. | verified | `tools/visual/kjs_renames.py` (suite visual-kjs-renames) reads all 35 renames from the KubeJS jar and probes the instance's Rhino jar (`getGameTime` undefined, `getTime()` works). Guarded by: `kjs-lint` (a hidden name in a new script only as a fallback inside `try` after the same receiver's KubeJS name; `pack-lint-hidden-names`), the shared mocks (KubeJS names only, 9.3), and `pack-smoke-strict` / `pack-degradation-strict` (the whole pack with only these names). |

**What these facts force** (already reflected in the rest of this document): KubeJS's names wherever it renames a
Minecraft method (F37); one command hub (F12-F14); a
`// priority:` header on every new server script (F2-F3); mercy and grace carried by player tags plus the
victim's health at impact (F7, F21); the natural-spawn gate as a startup `PositionCheck` listener, not
`checkSpawn` (F17-F18); join events queued, never cancelled (F19); every value read from `global` converted
with `Number()` or `String()` before any comparison (F6); Mojang names only, no SRG fallbacks (F34); fixed cost
constants instead of a clock (F25).

---

## 2. Module map and file ownership

### 2.1 Modules

| Module | Milestone | Owns | Prefix (top-level names) |
| --- | --- | --- | --- |
| CORE (lead) | M0 | shared core script, test runner, Rhino harness, mocks, lint, this document | `pneCore`, `PNE_CORE_`, `$PneCore` |
| GA-CORE | M0 | pure ES5 GA core + its Node/Rhino tests | `PNE_HIVE_GA` (single object) |
| HIVE-RUNTIME | M3 | hive runtime, startup ForgeEvents, persistence, light aversion, governor, NBT size test | `pneHive`, `PNE_HIVE_`, `$PneHive`; startup `pneHiveEv`, `PNE_HIVE_EV_` |
| RESONANCE-PIPELINE | M1 | offline audio pipeline, verified OGGs, `sounds.json`, subtitles, generated catalog | `PNE_RES_CATALOG` (single object) |
| DIRECTOR | M2 | pacing FSM, audio controller, ledger, commands, spawn gate, `pne_horror.js` routing, parasite volume trims, AmbientSounds regions | `pneRes`, `PNE_RES_`, `$PneRes`; startup gate `pneResGate`, `PNE_RES_GATE_`; experimental client `pneResCe` / `pneResCl` |
| ORACLE | M5 (+ telemetry at M0/M2) | telemetry extractor, pid use, file bridge, logging commands, sidecar, TPU worker code, export check, telemetry benchmark | `pneOra`, `PNE_ORA_`, `$PneOra` |
| VISUAL | M4 | clade teams, display grafts, empty-model axe assets, local-only ETF generator, EMF notes | `pneVis`, `PNE_VIS_`, `$PneVis` |

The prefixes are enforced by `tools/ci/kjs_lint.py`. Existing prefixes stay reserved: `pneH`/`PNE_H_` (horror),
`pneR` (hive rules, startup), `pneA` (alliance), `pneCull`/`PNE_CULL_`, `pneBed`, `pneComfort`/`PNE_COMFORT_`.

### 2.2 Server-script load order (binding)

Each new server script's **line 1** is exactly `// priority: N`. The lint fails any other value.

| Priority | File | Why this position |
| --- | --- | --- |
| 100 | `pne_00_core.js` | everything uses it; its tick handler must run first (it resets the token budget) |
| 95 | `pne_hive_core.js` | pure library, no handlers |
| 90 | `pne_res_catalog.js` (generated) | pure data |
| 80 | `pne_oracle_bridge.js` | produces this tick's telemetry snapshots and does bridge I/O first on slots 0/10 |
| 70 | `pne_resonance.js` | consumes this tick's snapshots; runs pacing before the hive reads GA weights |
| 60 | `pne_hive.js` | breeding runs last, on whatever budget is left |
| 50 | `pne_visual.js` | cosmetic, lowest priority work |
| 0 | existing scripts (`pne_horror.js` and the rest) | unchanged headers; they call new code only at run time |

Startup scripts need no ordering among themselves (default 0). There is **no startup core**: the two new
startup files each implement the small formulas in section 3.4 themselves.

### 2.3 File ownership (disjoint)

Everything a module creates or edits is listed. A file not listed belongs to the lead. Builders never edit
another module's file; they report what they need.

**CORE (lead)**
- `overrides/kubejs/server_scripts/pne_00_core.js`
- `tools/run_tests.py`, `tools/suites/README.md`, `tools/suites/milestones.json`
- `tools/rhino/PneRhino.java`, `tools/rhino/PneRhinoBrig.java`, `tools/rhino/pne_rhino.py`
- `tools/tests/kjs_mocks.js`, `tools/tests/kjs_node.js`, `tools/tests/core/core_smoke.js`, `tools/tests/core/hub_brigadier.js`
- `tools/ci/kjs_lint.py`, `tools/ci/no_kill.py`
- `docs/IMPLEMENTATION.md`

**Lead / integration (builders report additions, never edit)**: `tools/validate.py`, `tools/apply.py`,
`tools/fix_instance.py`, `tools/gen_loot_overrides.py`, `.gitignore`, `README.md`, `CHANGELOG.md`, `LICENSE`,
`docs/TESTING.md`, `docs/DESIGN.md`, `docs/TDD.md`, `mods/manifest.json`, `overrides/config/**`,
`overrides/defaultconfigs/**`, `overrides/kubejs/data/**`, `overrides/kubejs/assets/epca/lang/en_us.json`, and
every existing script except `pne_horror.js` (`pne_tags.js`, `pne_comfort_guard.js`, `pne_horde_cull.js`,
`pne_recipes.js`, `pne_serum.js`, `pne_alliance.js`, `pne_hive_rules.js`, `pne_horde_rules.js`, `pne_items.js`,
`pne_radiation_comfort.js`).

**GA-CORE**
- `overrides/kubejs/server_scripts/pne_hive_core.js`
- `tools/genome/test/run_tests.js`, `golden.js`, `replay_golden.js`, `sim_hive.js`, `sweep_steady.js`,
  `test_mercy.js`, `test_guard.js`, `golden_expected.json` (and any other file under `tools/genome/test/` except
  `NbtSizeTest.java`)
- `tools/genome/rhino/RhinoGolden.java`, `RhinoRun.java`, `KubeFilter.java`, `run.py`, `run.sh`
- `tools/suites/ga-core.json`
- `docs/modules/ga-core.md` (optional)

**HIVE-RUNTIME**
- `overrides/kubejs/server_scripts/pne_hive.js`
- `overrides/kubejs/startup_scripts/pne_hive_events.js`
- `tools/genome/test/NbtSizeTest.java`
- `tools/hive/**` (Node tests against `tools/tests/kjs_mocks.js`, Rhino mock-world benchmarks, replay of the
  join-before-leave conversion order)
- `tools/suites/hive.json`
- `docs/modules/hive.md` (optional)

**RESONANCE-PIPELINE**
- `tools/resonance/**`: `spec/layers.json`, `render.py`, `pne_meter.py`, `verify.py` (V1-V16),
  `gen_sounds_json.py` (also writes the catalog and the subtitles), `declip_local.py` (optional local tool, output
  never committed), `tests/**`. Build output goes to `tools/resonance/out/` only if the lead adds it to
  `.gitignore`; until then use `%TEMP%` (`PNE_TMP` in tests).
- `overrides/kubejs/assets/pne/sounds/res/**/*.ogg`
- `overrides/kubejs/assets/pne/sounds.json`
- `overrides/kubejs/assets/pne/lang/en_us.json` (sole owner; other modules report keys they need)
- `overrides/kubejs/server_scripts/pne_res_catalog.js` (**generated**; never hand-edited)
- `tools/suites/resonance.json`
- `docs/modules/resonance-pipeline.md` (optional)

**DIRECTOR**
- `overrides/kubejs/server_scripts/pne_resonance.js`
- `overrides/kubejs/startup_scripts/pne_res_gate.js`
- `overrides/kubejs/server_scripts/pne_horror.js` (**sole editor** of this existing file; section 3.2.1)
- `overrides/kubejs/assets/spore/sounds.json`, `overrides/kubejs/assets/epca/sounds.json` (volume trims by
  reference only; no audio copied)
- `overrides/kubejs/assets/ambientsounds/**` (bed regions: **none ship**, lead decision 1.3, section 5; the path stays
  reserved for DIRECTOR should a later decision bring them back)
- `overrides/kubejs/startup_scripts/pne_resonance_client_events.js`, `overrides/kubejs/client_scripts/pne_resonance_client.js` (experimental, off by default; optional)
- `tools/director/**` (`test_director.js`, `director.py`, `closed_loop2.py`, `ledger_sim.js`, Rhino smoke)
- `tools/suites/director.json`
- `docs/modules/director.md` (optional)

**ORACLE**
- `overrides/kubejs/server_scripts/pne_oracle_bridge.js`
- `overrides/local/pne_oracle/.keep` (needs a `.gitignore` change by the lead: section 4.6)
- `oracle/**`: `sidecar.py` (supervisor), `tpu_worker.py`, `backends/{__init__,cpu_np,cpu_tfl}.py`,
  `launch_oracle.cmd`, `stop_oracle.cmd` (creates `stop.flag`, never kills), `models/oracle_manifest.json`,
  `models/oracle_mlp.npz`, `sim/sim.py`, `train/nn.py`, `train/wsl_train_export.py`, `train/s4b_check.py`,
  `eval/closed_loop.py`, `tools/usbports.ps1`, `tests/**`
- `tools/ci/check_overrides.py` (export exclusions check)
- `tools/oracle/**` (`test_features.js`, `TelemetryBench.java` MockWorld benchmark)
- `tools/suites/oracle.json`
- `docs/modules/oracle.md` (optional)

**VISUAL**
- `overrides/kubejs/server_scripts/pne_visual.js`
- `overrides/kubejs/assets/minecraft/models/item/iron_axe.json`, `overrides/kubejs/assets/pne/models/item/empty.json`
- `overrides/kubejs/assets/spore/emf/**` or `overrides/kubejs/assets/spore/optifine/cem/**` (EMF, only original work;
  **deferred** until the in-game model export, Open decisions)
- `overrides/kubejs/assets/epca/optifine/random/entity/**` (ETF properties and **original-art** textures only)
- `tools/visual/**` (`etf_variants_local.py`: writes only into the user's instance or `%TEMP%`, never the repo;
  EMF notes and tooling; tests)
- `tools/suites/visual.json`
- `docs/modules/visual.md` (optional)

**Shared files and who adds what**: `.gitignore` (lead; ORACLE and RESONANCE report entries), `docs/TESTING.md`
(lead; every module reports its in-game checks in its final message), `README.md` / `CHANGELOG.md` (lead),
`tools/validate.py` (lead), `tools/apply.py` (lead; ORACLE reports the sidecar install step). A builder that
needs a new entity/block tag reports it to the lead (tags live in `pne_tags.js`).

---

## 3. Global API contract

Rules for every cross-module call:

- **Callers use the core wrappers** in 3.1 (`pneCore*`). The wrappers test `typeof`, check the pillar switch,
  catch errors (20 errors from one module turn that module's wrapper off until `/reload`) and return the
  documented fallback. Only the module that implements a function calls it directly.
- Implementers define the functions in 3.2-3.6 as **top-level function declarations with exactly these names**
  and return exactly these shapes (extra fields are allowed; missing fields are not).
- All functions are synchronous, must not throw for ordinary input (return the fallback or null), and must fit
  their cost constant (section 7).
- "player" = a KubeJS-wrapped `ServerPlayer`; "mob"/"entity" = a KubeJS-wrapped entity.

### 3.1 CORE (`pne_00_core.js`) - available to every server script

Constants: `PNE_CORE_API` (1), `PNE_CORE_VERSION`, `PNE_CORE_PILLARS` (`['resonance','hive','oracle','visual']`),
`PNE_CORE_DEFAULTS`, `PNE_CORE_BOUNDS`, `PNE_CORE_BUDGET_MS` (2.5), `PNE_CORE_COST` (section 7),
`PNE_CORE_SLOT_WRITE` (0), `PNE_CORE_SLOT_READ` (10), `PNE_CORE_SLOT_HOUSE` (5), `PNE_CORE_TEL_SLOTS`,
`PNE_CORE_MERCY_HP` (0.30), `PNE_CORE_GRACE_TICKS` (2400), `PNE_CORE_GATE_RADIUS` (48), `PNE_CORE_AXE_CMD` (7301),
`PNE_CORE_GATE_FRESH` (100), `PNE_CORE_PACE_STALE` (40), `PNE_CORE_HIT_WINDOW` (200), `PNE_CORE_LF_COMFORT` (1400),
`PNE_CORE_TAG_MERCY`, `PNE_CORE_TAG_GRACE`, `PNE_CORE_TAG_COMFORT_OFF`, `PNE_CORE_TAG_GATE`, `PNE_CORE_TAG_PACE_SOFT`.

State (read-only for modules): `pneCoreTick` (server tick count; same value for every handler in a tick),
`pneCoreSlot` (`pneCoreTick % 20`), `pneCoreServer` (last seen server, may be null before the first tick).

| Function | Returns | Notes |
| --- | --- | --- |
| `pneCoreBreaker(name, limit, mode)` | breaker `{name, limit, mode, n, total, off}` | `mode` `'consecutive'` (tick loops; `pneCoreOk` resets) or `'total'` (event handlers). Existing pack limits: 5 for ticks, 20 for events. |
| `pneCoreOk(b)` / `pneCoreFail(b, err)` | - | Logs the first 3 failures and the trip; sets `b.off`. |
| `pneCoreLog(mod, msg)` / `pneCoreWarn(mod, key, msg, max)` | - | `pneCoreWarn` logs at most `max` (default 3) times per key. |
| `pneCoreCfg(key)` | int | Current value or default (section 6). |
| `pneCoreCfgSet(server, key, value)` | bool | Validates key and bounds; persists `pne_cfg_<key>`. |
| `pneCoreOn(pillar)` | bool | Pillar switch (`'resonance'`, `'hive'`, `'oracle'`, `'visual'`). |
| `pneCoreLoaded(pillar)` | bool | Whether that module's script loaded (tests its main function). |
| `pneCoreOnToggle(pillar, fn)` | - | `fn(on, server)` after `/pne <pillar> on\|off`. Register at load time. |
| `pneCoreSetPillar(server, pillar, on)` | bool | Used by the hub; modules do not call it. |
| `pneCoreTake(ms)` | bool | Deducts `ms` only if it fits in this tick's remaining budget. |
| `pneCoreTakeN(ms, maxN)` | int | Grants and deducts up to `maxN` units. |
| `pneCoreLeft()` | ms | Remaining budget this tick. |
| `pneCoreAllPlayers(server)` | JS array | Every online player. |
| `pneCorePlayers(server)` | JS array | Survival/adventure players sorted by UUID string; cached per tick. **The index in this list is the player's telemetry index for every module.** |
| `pneCoreTelSlot(index)` | slot | `PNE_CORE_TEL_SLOTS[index % 18]`; never 0 or 10. |
| `pneCorePlayersAtSlot(server)` | JS array | Players whose slot is this tick's slot (empty on 0 and 10). |
| `pneCorePid(player)` | 32 lowercase hex | Creates `player.persistentData.pne_pid` on first use. |
| `pneCorePidRotate(player)` | new pid | For `/pne oracle purge`. |
| `pneCoreSeed32(server)` | uint32 | `(int)/seed >>> 0`, cached per server run. |
| `pneCoreFnv1a(str)` | uint32 | FNV-1a over `ASCII.indexOf(ch) + 32` (TDD 3.3.1). |
| `pneCoreImul(a, b)` | uint32 | 16-bit split multiply. |
| `pneCoreHasTag(entity, tag)` / `pneCoreSetTag(entity, tag, on)` | bool / - | `getTags()` / `addTag` / `removeTag` (Mojang names; no SRG fallback, F34). |
| `pneCorePD(obj)` | CompoundTag or null | KubeJS persistent data of an entity or the server (F8). |
| `pneCoreUuid(entity)` | string | `getStringUuid()`, then `getStringUUID()`, `getUuid()`, `getUUID()`; a value is accepted only if it matches the UUID pattern, else `''` (never the string `'undefined'`). |
| `pneCoreNow(entity)` | number | Game time from the entity's level (all dimensions share it). |
| `pneCoreGraceLive(player, now)` / `pneCoreGateLive(player, now)` | bool | Tag **and** freshness: `pne_grace` counts only while `pne_grace_until > now` (and ≤ 2400 ahead); `pne_gate` only while `now - pne_m_t` is 0..100. |
| `pneCoreIsPlayer(entity)` / `pneCoreIsSurvival(player)` | bool | Unknown game mode counts as survival (safety applies). |
| `pneCoreHp(entity)` | 0..1 | Health fraction; 1 when unreadable. |
| `pneCoreGameTime(server)` | number | Overworld game time (for persisted deadlines). |
| `pneCoreComfort(player)` | bool | **true unless** the player has tag `pne_comfort_off`. |
| `pneCoreVuln(player)` | `{mercy, grace}` | mercy = health ≤ 30% now; grace = `pneCoreGraceLive`. |
| `pneCoreNaturalMult(player)` | 0..1 | The natural-spawn multiplier (3.4 formula, freshness rules included). |
| `pneCorePlayersNear(level, x, y, z, radius)` | JS array | Survival players within `radius` (default 48). |
| `pneCoreNaturalMultAt(level, x, y, z, radius)` | 0..1 | Lowest `pneCoreNaturalMult` among survival players within `radius` (default 48); 1 if none. |
| `pneCoreStartGrace(player)` | - | Core calls it on respawn. |
| `pneCoreIsParasite(entity)` | bool | `#pne:hive` (EPCA) or `#pne:spore` via the entity's `EntityType` (`getEntityType()`, else the Forge registry by id) and `type.is(tagKey)`, cached per type id; falls back to `pne_horror.js` id sets. |
| `pneCoreStrain(entity)` | `'epca'`, `'spore'` or `''` | |
| `pneCoreTypeId(entity)` | string | Registry id or `''`: `entity.type` if it contains `:`, else `getEncodeId()`, else the Forge registry key, else parsed from `'entity.<ns>.<path>'`. |
| `pneCoreEntityType(entity, id)` | EntityType or null | `entity.getEntityType()`, else `ForgeRegistries.ENTITY_TYPES.getValue(new ResourceLocation(id))`. |
| `pneCorePace(player)` | Pace (3.2) | The director's cached Pace while `pneCoreTick - pace.tick <= 40` and `resonance` is on; otherwise the fallback `{state:'CALM', spawn: vuln?0:1, aggro: vuln?0.8:1, beckon:!vuln, ga: vuln?0:1, tier:'QUIET', e:0, theta:0, mercy, grace, tick, fallback:true}`. **Whatever the source**, when `pneCoreVuln(player)` says mercy or grace, the returned copy has spawn 0, beckon false, ga 0, aggro ≤ 0.8 and mercy/grace set (vuln = mercy or grace). |
| `pneCoreSpawnMult(player)` / `pneCoreGaWeight(player)` | number | `pneCorePace(player).spawn` / `.ga`. Scripted spawns only (may be 1.25). |
| `pneCoreSpawnMultAt(level, x, y, z, radius)` | number | Lowest `pneCoreSpawnMult` among survival players within `radius` (default 48); 1 if none. The multiplier for positional scripted spawns (beckons, reinforcements, bursts). |
| `pneCoreBeckonAt(level, x, y, z, radius)` | bool | true only if every survival player within `radius` (default 48) has `beckon` true (true if none). |
| `pneCoreSpawnCount(count, m)` | int | `floor(count × m + Math.random())`: how many of `count` scripted spawns to make. |
| `pneCoreStage(level)` | int 0..10 | EPCA doom stage: wraps `pneHStage(server, level, dim)` (3.2.1) when defined; -99, NaN or negative → 0; cached per dimension for 600 ticks. |
| `pneCoreDim(level)` | string | Dimension id (`level.getDimension()`, else `dimension().location()`). |
| `pneCoreHiveDeaths(player, windowTicks)` / `pneCoreHiveDeathsAll(windowTicks)` | int | Hive-caused deaths of that player / of everyone within the last `windowTicks` of game time (rule below). |
| `pneCoreDeathCause(source)` | `'void'`, `'kill'`, `'fall'`, `'other'` | From `source.getType()` (the msgId, F36/F37), for cheese classification. |
| `pneCoreSnap(player)` | Snapshot (3.5) or null | Works whatever the oracle switch says (telemetry is shared). |
| `pneCoreVerdict(player)` | Verdict (3.5) or null | null when the oracle is off, absent or has nothing. |
| `pneCoreHiveInfo(entity)` | HiveInfo (3.3) or null | null when the hive is off/absent or the mob has no genome. |
| `pneCoreHiveNear(player)` | `{clade, apex, silent}` | Fallback `{clade:-1, apex:false, silent:0}`. |
| `pneCoreTell(mob, player)` | bool | L8 tell via the director; **false means nobody heard it** (the hive must then drop that mob's `Silent`). Cadence rules in 3.3. |
| `pneCoreVisApply(mob, info)` / `pneCoreVisRemove(mob)` | - | No-op when visual is off/absent (remove still runs when off, for cleanup). |
| `pneCoreEmit(player, event, category, pos, vol, meta)` | bool | Every horror sound for one player goes here (3.2). Fallback without the director (absent, or its API breaker tripped): plain `playsound` as before M2, except that for a comfort player `meta.stinger` is skipped and `meta.lf` sounds play at most once per 70 s (core-held map per player). |
| `pneCoreEmitAt(server, dim, x, y, z, radius, event, category, vol, meta)` | int | Positional sound for every player within `radius`; fallback is the old `@a[distance=..r]` command, treating everyone as comfort: 0 for `meta.stinger`, `meta.lf` at most once per 70 s per event. When the director's API breaker trips, the core logs one warning that the ledger is off until `/reload`. |
| `pneCoreCommand(word, spec)` | bool | Registers a `/pne <word>` handler (section 6.3). |
| `pneCoreStatus(name, fn)` | - | `fn(player or null)` returns one line for `/pne status`. |
| `pneCoreClamp(x, lo, hi)`, `pneCoreFmt(n)` | | `pneCoreFmt` = 2 decimals, NaN → `0.00` (command-safe numbers). |

**Core event handlers** (registered first, O(1), never cancel): `PlayerEvents.respawned` (grace), `PlayerEvents.loggedIn`
(pid; the F8 check behind `pd=` in `/pne status`), `EntityEvents.hurt('minecraft:player')` (a parasite hit sets
`pne_lph`), `EntityEvents.death('minecraft:player')` (hive-death rings), `EntityEvents.spawned` (saved silent mobs,
below).

**Hive-caused death (binding, the only source)**: a player death is hive-caused when the killer
(`source.getActual()`, which is the owner for projectiles; `getEntity()` in mocks only, F37) passes `pneCoreIsParasite`, or when a parasite hit that
player within 200 ticks (`pne_lph`) and the cause is neither void nor `/kill`. A fall counts only through that
200-tick rule. The core appends the game time to `player.persistentData.pne_hd` (last 16) and to
`server.persistentData.pne_core_hd` (last 64). Windows are in game time (20 real minutes = 24000 ticks at 20 TPS).
HIVE (dawn `deaths3d`, intra-day governor, cheese via `pneCoreDeathCause`) and DIRECTOR (hourly governor) read only
these functions; neither listens to player deaths itself.

**Saved silent mobs**: `Silent:1b` is saved in entity NBT. When a mob with `persistentData.pne_sil == 1` joins while
the hive is absent, off or cut off (`!pneCoreLoaded('hive') || !pneCoreOn('hive') || PNE_CORE_B_API.hive.off`), the
core clears `pne_sil` and queues its UUID; the core tick runs `data merge entity <uuid> {Silent:0b}` (≤ 8 per tick,
`COST.emit` each).

### 3.2 DIRECTOR (`pne_resonance.js`)

```
PNE_RES_API = 1

pneResPace(player) -> Pace | null
  Pace = { state: 'CALM'|'UNEASE'|'DREAD'|'PANIC'|'RELEASE',
           spawn:  number   // scripted-spawn multiplier, 0..1.25, already includes mercy, grace and the hourly governor
           aggro:  number   // 0.8..1.0
           beckon: boolean
           ga:     number   // GA weight 0..1 (PANIC 0.5; RELEASE, mercy, grace 0)
           tier:   'QUIET'|'UNEASE'|'DREAD'   // audio tier after ceilings and overrides
           e: number, theta: number,          // fused arousal estimate, threat context (0..1)
           mercy: boolean, grace: boolean, tick: int }   // tick = pneCoreTick of the last 1 Hz step
  Cached from the player's last 1 Hz step (never recomputed on call). null for an unknown player.

pneResEmit(player, event, category, pos, vol, meta) -> boolean   // true if a /playsound was issued
  Budget: charges PNE_CORE_COST.emit with pneCoreTake and proceeds even when that is refused (it is called from
  event handlers between tick resets and from pne_horror.js after other modules spent the tick; a budget refusal
  must never drop an existing pack sound). The ledger's own rules may still lower vol or refuse.
  event    'namespace:path' sound event id
  category vanilla source: 'ambient' | 'voice' | 'hostile' | 'neutral' | 'block' | 'player' | 'master' ...
  pos      position string, evaluated 'execute as <player> at @s [rotated ~ 0] run playsound ... @s <pos>':
           '~ ~12 ~', '^ ^1 ^-6', or absolute 'x y z' built with pneCoreFmt
  vol      >= 0 (vanilla semantics: above 1 only extends range)
  meta     optional { pitch: 1, rotated: false, layer: 'L0'..'L8'|'ext', cls: string, lf: bool, stinger: bool,
                      lufs, mmax, dur, att: numbers, src: 'res'|'horror'|'hive'|'visual', dist: blocks }
  For 'pne:res.*' events the catalog (section 5) supplies lufs/mmax/dur/att/lf/category. For other events the
  director's own table PNE_RES_EXTERNAL holds the measured values (TDD 2.5.5); unknown events get conservative
  defaults. Applies, in order: per-player switches, comfort, LF exclusivity and duty (A8), level-jump limit,
  bus ceiling, per-minute budget. May lower vol; may refuse.
  With the resonance pillar OFF: src 'res' is refused; every other source still goes through the ledger.

pneResEmitAt(server, dim, x, y, z, radius, event, category, vol, meta) -> int
  Issues one per-player /playsound at absolute x y z for every player within radius, each through the ledger.
  Returns how many were issued.

pneResTell(mob, player) -> boolean
  Plays an L8 tell ('pne:res.tell.a.vNN', hostile, attenuation 24) at the mob's position for that player.
  Ignores pne_res_off, every per-layer switch and comfort (fairness). false only when the pillar is off or no tell
  asset exists. The director never initiates tells; HIVE owns the cadence (3.3).
```

The director also writes, once per second per survival player (at the player's telemetry slot):
`player.persistentData.pne_m` (double, `min(1, pace.spawn)`), `pne_m_t` (long, `pneCoreNow(player)` of that write)
and tag `pne_gate` when `pne_m < 1` (removed otherwise). A `pne_gate` whose `pne_m_t` is more than 100 ticks old
does not count anywhere (3.4), so a stopped director cannot leave a stale gate. Tag `pne_pace_soft`: for aggro ≤ 0.8
always set; for aggro 0.9 set iff `floor(pneCoreTick / 100)` is odd; for aggro 1 removed (TDD 2.5.5 "alternate runs").
On the resonance toggle OFF it removes `pne_gate` and `pne_pace_soft` from every online player; core upkeep also
removes both while the director is absent, off or cut off.

#### 3.2.1 `pne_horror.js` routing (DIRECTOR edits; nothing else changes behaviour)

- Every `playsound` becomes `pneCoreEmit` (one player) or `pneCoreEmitAt` (positional, many players) with
  `meta.src = 'horror'` and the right flags: gore `epca:slam` (`lf: true`, `cls: 'slam'`), Hive Night
  `spore:heart_beat` (`lf: true`, `cls: 'hive_heartbeat'`, per horde player), `epca:infested_enderman_scream`
  (`stinger: true`, `rotated: true`, `cls: 'scream'`), bell/beckon (`cls: 'bell'` / `'beckon'`),
  slime squish, beckon stage 2. The old whisper pool (`pneHWhisper`) is retired.
- `PNE_H_SURVIVORS` gains `tag=!pne_pace_soft`.
- Beckon reinforcements, Mobs Inside bursts and Hive Night extras use the positional helpers at the spawn point:
  `m = pneCoreSpawnMultAt(level, x, y, z, 48)`, skip beckons unless `pneCoreBeckonAt(level, x, y, z, 48)`, and spawn
  `pneCoreSpawnCount(count, m)` mobs instead of `count` (0 means skip). A burst tied to one player uses
  `pneCoreSpawnMult(player)` instead.
- `pneHStage(server, level, dim)` keeps this name, signature and meaning (EPCA stage or -99, 600-tick cache):
  `pneCoreStage` wraps it.
- The `pneH` 20-tick gate should move to `pneCoreSlot === PNE_CORE_SLOT_HOUSE` when the core is loaded
  (keep its own counter as the fallback). No other behaviour changes, except the sanctioned FLK placement below.
- **FLK placement of reinforcement beckons (sanctioned in 1.4; TDD 3.1 gene 4)**: after every existing rule of the
  reinforcement beckon has passed at the dying mob (cooldown, stage, chance roll, `pneCoreBeckonAt`,
  `pneCoreSpawnCount(1, m) > 0`), `pne_horror.js` reads `pneCoreHiveInfo(mob).flk` (3.3). When `flk >= 0.5`, the nearest
  survival player within 64 blocks has block light ≤ 7 at their feet block and a readable facing (`getYaw()`, F37), and one
  `Math.random() < flk` draw succeeds, it issues **one test command** (the same execute chain as the beckon, ending in its
  last `if block` test, with no `run summon`) at the dying mob. Only when that test passes (today's chain would summon
  there) is the beckon moved: at most 8 probes 24-40 blocks away inside the player's rear 120° arc (from the facing, not
  the mob's bearing), ground found by block reads within 6 blocks of the player's feet level (`#pne:beckon_ground`
  through `BlockContainerJS.hasTag`, leaves passed through, no search under a roof), pacing checked at the spot
  (`pneCoreBeckonAt`, `pneCoreSpawnMultAt` > 0), then the unchanged chain run at the spot; the first summon wins,
  otherwise today's placement. FLK therefore changes where a beckon stands, never whether one appears. The bell and the
  stage-1 call sound where the beckon stands. Natural and ambient spawns are not placed (Open decisions, "FLK").

### 3.3 HIVE-RUNTIME (`pne_hive.js`, `pne_hive_events.js`)

```
PNE_HIVE_API = 1

pneHiveInfo(entity) -> HiveInfo | null        // null: not a genome mob (no pne_g)
  HiveInfo = { g: string (56 hex), clade: 0..3, sil: boolean (silent gene expressed and still silent),
               apex: boolean, e: number[14] (expressed values), strain: 'epca'|'spore',
               flk: number 0..1 }   // 1.4: the expressed FLK gene e[4] as applied at the mob's last expression
                                    // (0 when masked or absent; tag pne_flk marks >= 0.5); read by pne_horror.js (3.2.1)

pneHiveNear(player) -> { clade: -1..3, apex: boolean, silent: int }
  From the hive's own tracking tables (no entity query): dominant clade among engaged genome mobs within 24
  blocks (-1 none), whether an apex genome is within 24, and how many silent-gene mobs within 12 have not
  attacked yet.
```

HIVE calls: `pneCorePlayers`, `pneCorePace`/`pneCoreGaWeight`, `pneCoreVerdict` (style buckets only),
`pneCoreSnap` (optional fields only), `pneCoreTell` (drop `Silent` when it returns false), `pneCoreVisApply` after
every expression (newborn and rejoin), `pneCoreVisRemove` on KILLED/DISCARDED, `pneCoreNaturalMultAt` for the
backstop, `pneCoreStage` for stage inputs, `pneCoreHiveDeaths`/`pneCoreHiveDeathsAll`/`pneCoreDeathCause` for
dawn, governor and cheese.

**Silent gene and tells (HIVE owns all of it)**: HIVE keeps silent-gene mobs to ≤ 30% of the engaged genome mobs,
plays the 20-tick ash-particle tell, and schedules the L8 tell (1.4): **every survival player within 12 blocks** gets
`pneCoreTell(mob, player)` at most once per 100 ticks per (mob, player) pair, through that player's own ledger, while
that mob has not attacked (the per-pair window is kept while a player steps away, so leaving and returning never shortens
it). A refused tell (`false`) drops that mob's `Silent` (for everyone) and clears `pne_sil` **only when no player
within 12 blocks could be told** (none heard a tell from it within the last 100 ticks); a visit or tell that does not fit
the budget still drops it. `pneHiveNear(...).silent` is informational for the director, which never initiates tells.

**`located`** (TDD 3.2 channel): derived from HIVE's own round-robin samples: a mob counts as located from the first
sample (≤ 20 per tick) at which `mob.getTarget()` is a player. There is no startup target queue.

**Sensing without ORACLE**: HIVE reads block light at the player itself (for example
`level.getBlock(x, y, z).getBlockLight()`) and keeps its own `BlockEvents.placed` torch counter for the T_est light
rule and light aversion; `Snapshot.light` is combined light and is not used for those.

**Backstop (TDD 2.5.5), executed by HIVE, decided by the core formula**: in the newborn drain, **before** any
RNG draw (`st.joins` untouched, no `J` event), a newborn is discarded only when **all** hold: it has
`persistentData.pne_fresh == 1` (set below; a mob loaded from disk never has it), no `pne_g`, no conversion link,
no CustomName, is not persistence-required, `pneCoreCfg('spawn_backstop') === 1`, and
`pneCoreNaturalMultAt(level, x, y, z, 48) === 0`. Set `persistentData.pne_pacing_discard = 1b` before `discard()` so
the leave handler ignores it. HIVE removes `pne_fresh` after expression. Never cancel `EntityEvents.spawned` (F19).
With the hive off or absent there is no backstop (the startup gate still works).
`pne_hive_events.js` sets the flag: a startup listener for `net.minecraftforge.event.entity.EntityJoinLevelEvent`
(F35; O(1)) does `entity.persistentData.putByte('pne_fresh', 1)` when `!event.loadedFromDisk()` and the type id
starts with `epca:` or `spore:`. Order against KubeJS's own `spawned` handler does not matter: HIVE drains newborns
in a later tick. The Hordes waves (`addFreshEntity`) get the flag too, so the backstop is the only mitigation for
horde spawns near a player in mercy or grace (`pne_hive_rules.js` does not suspend waves; in-game check at M3).

**Startup queues** (`pne_hive_events.js` → `pne_hive.js`): `global.pneHiveQDamage` and `global.pneHiveQLeave`,
both `java.util.ArrayList<String>`, created lazily by whichever side needs them first (load
`java.util.ArrayList` once at the top level, then `if (!global.pneHiveQDamage) global.pneHiveQDamage = new $PneHiveEvArrayList()`).
A Java list, not a JS array, so neither side depends on the other context's objects. Record formats are HIVE-internal (both ends are HIVE files).
Producers enqueue only while `Number(global.pneOnHive) === 1` (never `global.pneOnHive === 1`, which is always
false: F6), drop new records once a queue holds 4096, and never do more than O(1) work per event. The core writes
`pneOnHive` = 1 only while `on_hive` is 1 **and** the hive runtime (`pne_hive.js` with the GA core) has loaded, so a
missing consumer never leaves the producers filling queues nobody drains (4.5). The consumer wraps
every element in `String()` (F6).

**k_mercy at impact** (binding formula, in `LivingDamageEvent`, victim is a player):
`k = (victim.getHealth() <= 0.30 * victim.getMaxHealth() || graceLive(victim) || hasTag(victim,'pne_mercy')) ? 0 : 1`,
where `graceLive` = tag `pne_grace` and `persistentData.pne_grace_until > level.getTime()` (the game time; `getGameTime()`
does not exist in game, F37), at most 2400 ahead (the same rule as `pneCoreGraceLive`). The health read is pre-damage (F21). Tags are core-maintained (4.2). HIVE suite
`hive-kmercy-rhino` tests this formula in Rhino.

**Projectile scaling** (`LivingHurtEvent`, before armour): when the victim's `persistentData.pne_prj` (int,
round(1000·e_PRJ)) is > 0 and the source is a projectile, `amount *= 1 - 0.45 * pne_prj / 1000`.

### 3.4 Startup natural-spawn gate (DIRECTOR, `pne_res_gate.js`)

`ForgeEvents.onEvent('net.minecraftforge.event.entity.living.MobSpawnEvent$PositionCheck', fn)`:
1. `var g = global.pneCfgSpawnGate; if (g !== undefined && g !== null && Number(g) === 0) return` (absent counts
   as on; the stored value is a wrapped `Double`, so `global.pneCfgSpawnGate !== 0` would always be true: F6).
2. Return unless the mob's type id starts with `epca:` or `spore:` and is not `epca:stage_i_beckon` /
   `epca:stage_ii_beckon`.
3. Get the `ServerLevel` (`event.getLevel().getLevel()`); if that fails (world generation) return.
4. `now = level.getTime()` (the game time; `getGameTime()` does not exist in game, F37). `m` = the lowest, over survival
   players within 48 blocks, of: 0 if the player has
   tag `pne_mercy`, or tag `pne_grace` with `persistentData.pne_grace_until > now`, or health ≤ 30%; else
   `persistentData.pne_m` clamped to 0..1 if the player has tag `pne_gate` and `0 <= now - persistentData.pne_m_t <= 100`;
   else 1. This is exactly `pneCoreNaturalMult` / `pneCoreNaturalMultAt`; a stale tag left by a broken or absent
   module expires on its own.
5. If `Math.random() >= m`: `event.setResult(Java.loadClass('net.minecraftforge.eventbus.api.Event$Result').DENY)`.

Mercy and grace gating therefore work with the resonance pillar off (safety floor), and multipliers above 1
never add natural spawns.

### 3.5 ORACLE (`pne_oracle_bridge.js`)

```
PNE_ORA_API = 1

pneOraSnap(player) -> Snapshot | null     // null until the first sample for that player
  Snapshot = { tick: int (pneCoreTick when sampled), f: number[31] (TDD 4.3 order),
               nearest: blocks to the nearest parasite (32 if none within 32), n16: int, n32: int,
               light: 0..15, sky: boolean, hp: 0..1, hostileSeen: boolean (parasite within 24 with line of sight),
               tSinceDmg: s, tSinceSight: s, dealt: number, sneak: boolean, sprint: boolean,
               y: number, dim: string, enclosure: 0..1 }
  One entity query per player per second at the player's slot, shared by everyone. Runs whenever any of
  resonance, hive or oracle is on (it does not stop with /pne oracle off).

pneOraVerdict(player) -> Verdict | null   // null: oracle off, no sidecar yet, or unknown player
  Verdict = { fresh: boolean (accepted, <= 60 ticks old, backend present), age: ticks,
              EO: 0..1 (= (p1 + 2 p2 + 3 p3) / 3), conf: max(arousal), band: 0..3 (= min(3, floor(4 EO))),
              arousal: [4], fe: [3], pFlee: fe[1], pEngage: fe[2],
              style: 'hide'|'kite'|'turtle'|'explore'|'none', styleP: [4], backend: string }
  style = argmax(styleP) when max(styleP) >= 0.5, else 'none'. Only style and band are ever logged or given to
  the GA (determinism boundary, TDD 4.4.2).
```

ORACLE also owns: `/pne oracle status|log on|log off|purge`, the per-player opt-in `player.persistentData.pne_log`
(absent = 0; only `/pne oracle log on` **by that player** sets it; there is no config default and no operator
override), the login notice for logging players, the bridge directory `local/pne_oracle/` (never created by
KubeJS: F23), and `pneCoreStatus('oracle', ...)`.
**Purge**: ORACLE reads the old pid (`pneCorePid`), then calls `pneCorePidRotate`, and keeps the old pid in its own
`server.persistentData.pne_ora` list; `telemetry.json` carries `purge: [old pid, ...]` until `status.json` lists
those pids in `purged`, then ORACLE drops them. The sidecar deletes the logs and creates `worlds/<wid>/` itself;
KubeJS never writes there.

### 3.6 VISUAL (`pne_visual.js`)

```
PNE_VIS_API = 1

pneVisApply(mob, info) -> void      // idempotent; called by the hive after every expression (newborn and rejoin)
  info = { clade: 0..3, apex: boolean, graft: int (0 none, 1..k occupancy index), stage: int, strain: 'epca'|'spore' }
pneVisRemove(mob) -> void           // team leave + graft discard; hive calls it on KILLED/DISCARDED
pneVisSweep(server) -> int          // orphan grafts and stale team entries removed; VISUAL schedules it itself
```

Teams `pne_clade_0`..`pne_clade_3` (nametag never) and their siblings `pne_clade_0_named`..`pne_clade_3_named` (nametag
always, for hosts with a CustomName) are created by VISUAL on server load, all with **collision `always`**
(`pushOtherTeams` would stop players and parasites pushing each other: 1.20.1 bug MC-87984, `EntitySelector.m_20426_`).
Grafts are `item_display` passengers tagged `pne_graft` (and `pne_gv<k>`, the graft variant) with
`persistentData.pne_host` = host UUID. A graft exists **only while its host targets a player** (40-tick linger), on at
most 15% of the live engaged genome hosts; only VISUAL's own scan summons them, `pneVisApply` sets team, name and removal
only. A passenger makes vanilla `RandomStrollGoal`/`LeapAtTargetGoal` refuse to run and a vehicle is not pushed by other
entities, so the 20 combat-sensitive species in `PNE_VIS_NO_GRAFT` never carry one; config `vis_grafts` 0 turns grafts off.
The axe item for PRC hosts is `minecraft:iron_axe`; on Spore hosts HIVE gives it `CustomModelData:7301`
(`PNE_CORE_AXE_CMD`), which VISUAL's model override maps to `pne:item/empty`.

### 3.7 GA-CORE (`pne_hive_core.js`) - consumed only by HIVE

One top-level object, pure ES5, no KubeJS globals, no `Date`, no `Math.random`/`exp`/`log`/`pow`/`sin`/`cos`/`sqrt`/`imul`,
and `if (typeof module !== 'undefined' && module.exports) module.exports = PNE_HIVE_GA` at the end (Node tests).

```
PNE_HIVE_GA = {
  // constants
  G: 14, Q: 65535, CAP: 48, QUEUE_MAX: 16, SCHEMA: 1,
  GENE_IDS: ['SPD','ACU','SCT','LUX','FLK','SIL','KBR','PRJ','ARM','PRC','HPX','DMG','TEL','MOR'],
  COST_MC:  [1.4,.8,.8,.6,.6,.7,.8,.9,1.2,1.0,1.3,1.5,0,0],     // sum 11.6
  COST_GEN: [1.4,.8,.8,.6,.6,.7,.8,.9,1.2,1.0,1.3,1.5,.9,0],    // sum 12.5
  TACTICS: ['hide','kite','turtle','light','audio'],          // T_est order; 'explore' has no counter genes

  // codec
  hex(g) -> string (56 lowercase hex)          unhex(s) -> number[14] (u16) or null if malformed
  clade(g) -> 0..3                             // floor(g[MOR] * 4 / 65536)

  // engine state (everything replay needs lives in st)
  newState(seed32) -> st
  save(st) -> { pool: string, queue: string, state: string, samples: [string...] (each <= 48 KB),
                base: [{ k: ctxKey, v: [int...] }...], log: string }     // integers and hex only
  load(saved, seed32) -> st | null                                         // null on schema mismatch
  // 1.4, binding: the incremental save (copy on write) and the load epoch
  saveBegin(st) -> ctx | null                   // snapshot; a newer saveBegin supersedes a running one
  savePart(ctx) -> { part, i, value } | null    // next piece; null when none is left or the save was superseded
  saveDone(ctx) -> boolean                      // no piece left
  saveEnd(ctx) -> same shape as save(st) at saveBegin | null   // null when superseded
  epoch(st, ep) -> int                          // E; declares the load epoch max(ep, current + 1); every generated id
                                                //   (b, j, d) then carries '.<ep>'; the state saves ep

  // runtime (each logs its replay event; counters live in st)
  breed(st) -> boolean                          // one child into the queue (B); false when full
  join(st, link) -> { g: number[14], hex: string, id: string, parents: string }   // J (+P when popped)
                                                // link: null or { id: string, g: number[14] }
  mask(speciesId) -> number[14] of 0/1          // species availability (TDD 3.1)
  budget(stage, gov, graceNear) -> B            // (3.0 + 0.35 stage) * gov * (graceNear ? 0.7 : 1)
  express(g, mask, B) -> number[14] in [0,1]    // guarded scaling + combo caps; all-zero/masked -> zeros, never NaN
  outcome(st, rec) -> f (number)                // I; rec = { id, g, parents, ctx, e, tel: { dmg, engagedSec,
                                                //   located, killShare, teamPressure, fastKill, cheese } }
                                                //   damage channels already multiplied by k_mercy
  dawn(st, inp) -> { dream: boolean }           // D; inp = { deaths3d, target, tDay: number[5], stage }
  govStep(st) -> gov                            // G; intra-day x0.85, floor 0.6
  dreamSlice(st, mask, B) -> boolean            // R per insert; true when the dream is finished

  // introspection and tests
  gov(st), sigma(st), gen(st), poolSize(st), queueSize(st) -> numbers
  apexSet(st) -> { hex: true }                  // top 5% by shrunk estimate with n >= 6
  hash(st) -> string (8 hex)                    // pool hash for goldens
  replay(seed32, saved, events) -> st           // events = the log strings, in order
}
```

`target` for `dawn` is computed by HIVE from config: `gov_deaths * players * 3 / gov_days` hive-caused deaths
per 3 in-game days (default 1 per player per 3 days), with `players = max(1, distinct pne_pid values seen
survival-online during the last 72000 ticks)` (tracked by HIVE); `deaths3d = pneCoreHiveDeathsAll(72000)`. GA-CORE
treats `target <= 0` or a non-finite `target` as "no update" (gov unchanged, never NaN). GA-CORE may add functions;
these names and shapes are fixed. Rhino and Node must produce identical `hash(st)` for the goldens.

**Replay log grammar**: `I` events carry the full `rec` as integers (tel channels × 1e6, `g` as hex, parents, ctx,
e × 1e6); `D` carries `inp` (deaths3d, target × 1e6, tDay × 1e6, stage); `G` carries nothing else. GA-CORE writes the
grammar in `docs/modules/ga-core.md`; HIVE logs exactly the strings GA-CORE returns, so `replay` reproduces live
logs, not only synthetic ones.

**Incremental save and load epoch (HIVE's use, 1.4)**: every pool save during play (the 6000-tick cadence, dawn, a
switch-off, `/pne hive prev drop`, and a load that found no readable stored state) is `saveBegin` plus the runtime string
`hv` taken at the same moment, then one `savePart` per free save slot (7.2), then `saveEnd`; the result is written
through the same detached compound, base-array and swap steps as the one-call save, so both store identical compounds.
A superseded save (`savePart`/`saveEnd` return null), a failed step (the error goes on to the `hive.save`
breaker) or a save for a state that is no longer live starts over at the next free slot and never writes. The one-call
`save(st)` runs only at `ServerEvents.unloaded` (server stop, outside the budget) and abandons a running incremental save.
The **load epoch** is `max(hv ep, GA ep) + 1 + salt`, the salt 0..1023 from 10 random bits of a `java.util.UUID`
(`Math.random` as the fallback; no salt within 1024 of 2^31 - 1); it is written into the stored `hv` at the load and
declared with `epoch(st, ep)` on the **first hive tick after every load** (not inside `ServerEvents.loaded`, so a
load-then-save round trip with no tick between is unchanged), before any drain or GA work. `pne_gi` is the GA id as it is
when it carries the current epoch; an older-epoch queued id gets the run epoch appended (`b17.2.3`). Ids never repeat after
a `/reload` or a clean restart once the epoch is stored; after a crash before the next overworld save they can repeat
only by chance (about 1 in 1000; Open decisions).

---

## 4. Shared state registry

Every key, tag and name below starts with `pne`. Only the listed owner writes it; anyone may read it.

### 4.1 `server.persistentData` (flat keys and one compound per module)

| Key | Type | Owner | Content |
| --- | --- | --- | --- |
| `pne_cfg_<key>` | int | CORE | config value (section 6); absent = default |
| `pne_core_hd` | string | CORE | game times of the last 64 hive-caused player deaths (3.1) |
| `pne_doom_floor` | int | existing `pne_horror.js` | doom clock floor (unchanged) |
| `pne_hive` | CompoundTag | HIVE | `pool`, `queue`, `state` (strings), `base` (CompoundTag ctxKey → IntArray), `samples.0..n` (strings ≤ 48 KB), `wid` (world id), `log` (replay tail), `v`, `hv` (runtime string; its `ep` is the salted load epoch written at every load, 3.7) and `prev` (1.2). Every string < 60,000 bytes (CI NbtIo test). Keep the whole thing under ~64 tags. |
| `pne_res` | CompoundTag | DIRECTOR | reserved (director state that must survive restarts, if any) |
| `pne_ora` | CompoundTag | ORACLE | reserved (for example `boot` counters) |
| `pne_vis` | CompoundTag | VISUAL | reserved (for example known graft hosts) |

### 4.2 Player tags (scoreboard tags; visible to startup scripts and command selectors; kept on respawn)

| Tag | Owner | Meaning |
| --- | --- | --- |
| `pne_mercy` | CORE | health ≤ 30% at the last housekeeping pass (slot 5, 1 Hz) |
| `pne_grace` | CORE | respawn grace: set on respawn, removed when game time ≥ `pne_grace_until` (2400 ticks). Counts only while `pne_grace_until` is live, wherever it is read (3.4). |
| `pne_comfort_off` | DIRECTOR (`/pne comfort off`) | comfort opted out. **Absent = comfort on** (fail-safe default for every player) |
| `pne_res_no_whispers`, `pne_res_no_throb`, `pne_res_no_approach`, `pne_res_no_stingers` | DIRECTOR | per-layer switches (TDD 2.7) |
| `pne_res_off` | DIRECTOR (`/pne resonance self off`) | all Resonance audio off for this player |
| `pne_gate` | DIRECTOR | `pne_m` < 1; counts only while `pne_m_t` is ≤ 100 ticks old. Core upkeep removes it while the director is absent, off or cut off |
| `pne_pace_soft` | DIRECTOR | aggression < 1; excluded from `PNE_H_SURVIVORS` |
| `pne_horde`, `pne_horde_told` | existing (`pne_hive_rules.js`, `pne_horror.js`) | unchanged |

Note: the TDD's `pne_audio_comfort` (opt-in) is replaced by the opt-out `pne_comfort_off`, so a player whose
tag was never set, or whose first-join handler failed, still gets comfort mode.

### 4.3 `player.persistentData` (KubeJS compound; survives death, F8-F9)

| Key | Type | Owner | Content |
| --- | --- | --- | --- |
| `pne_pid` | string (32 hex) | CORE | random pseudonym; rotated by `/pne oracle purge` |
| `pne_grace_until` | long (game time) | CORE | grace deadline |
| `pne_lph` | long (game time) | CORE | last parasite hit on this player |
| `pne_hd` | string | CORE | game times of this player's last 16 hive-caused deaths |
| `pne_m` | double | DIRECTOR | natural-spawn multiplier (0..1) |
| `pne_m_t` | long (game time) | DIRECTOR | when `pne_m` was written (freshness for `pne_gate`) |
| `pne_notice_v` | int | DIRECTOR | version of the first-run notice already shown |
| `pne_log` | byte | ORACLE | this player's own logging opt-in (default 0) |

### 4.4 Mob `persistentData` (KubeJS compound, F8)

HIVE: `pne_g` (56 hex), `pne_gv` (int schema), `pne_gp` (parent ids), `pne_ctx` (ctxKey), `pne_t0` (birth tick),
`pne_healed` (byte), `pne_prj` (int, round(1000·e_PRJ), read by the startup hurt listener), `pne_sil` (byte),
`pne_tel` (telemetry accumulator string), `pne_pacing_discard` (byte), `pne_fresh` (byte, set by the startup
`EntityJoinLevelEvent` listener for mobs not loaded from disk, removed after expression). CORE clears `pne_sil` when
it unsilences a saved mob while the hive is not running (3.1). VISUAL (on the display entity):
`pne_host` (host UUID string). Nobody else writes mob data.

Mob tags: existing `pne_burst`, `pne_called`, `pne_horde_mob`, `pne_horde_keep` (unchanged); VISUAL `pne_graft`
(on display entities). Attribute modifier UUIDs: HIVE derives one fixed UUID per gene
(`'706e6500-4869-7665-0000-0000000000NN'`, NN = gene index as two hex digits); names `pne.gene.<ID>`.

### 4.5 `global.*` (shared HashMap, F5-F6)

| Key | Type | Writer | Readers |
| --- | --- | --- | --- |
| `pneCoreApi` | number | CORE | startup scripts (core loaded: `Number(global.pneCoreApi) >= 1`) |
| `pneOnResonance`, `pneOnOracle`, `pneOnVisual` | number 1/0 | CORE (at load, on server start, on toggle) | startup scripts |
| `pneOnHive` | number 1/0 | CORE: `on_hive` AND the hive runtime loaded (`pneCoreLoaded('hive')` and `PNE_HIVE_GA`); written once every server script has loaded (`ServerEvents.loaded`, or the first tick after a load or `/reload`), then on toggle; never at the core's own load time (a `/reload` keeps the old value until then) | `pne_hive_events.js` (enqueue only while 1) |
| `pneCfgSpawnGate` | number 1/0 | CORE | `pne_res_gate.js` |
| `pneHiveQDamage`, `pneHiveQLeave` | `java.util.ArrayList<String>` | `pne_hive_events.js` | `pne_hive.js` |

Nothing else goes into `global`. Never store functions there (they would survive `/reload` pointing at a dead scope).
**Every read converts first** (F6): numbers with `Number(v)` after an `undefined`/`null` check, strings with
`String(v)`; never `===`/`!==` against the raw value (the lint rejects `global.x ===` in new files). Flags:
`Number(global.pneOnHive) === 1`; the spawn gate: 3.4 step 1.

### 4.6 Files, teams, sounds, commands

- Scoreboard teams: `pne_clade_0`..`pne_clade_3` (VISUAL). Objective `pne_horde_age` (existing).
- Bridge folder `<instance>/local/pne_oracle/` (ORACLE): `telemetry.json`, `verdict.json`, `status.json`,
  `stop.flag`, `sidecar.lock`, `logs/`, `worlds/<wid>/`. Only `.keep` ships. **Lead action**: `.gitignore`
  currently ignores `local/` at any depth, which would also hide `overrides/local/pne_oracle/.keep`; change it
  to `/local/` plus `overrides/local/pne_oracle/*` and `!overrides/local/pne_oracle/.keep`.
- Sound events: `pne:res.<layer>.<cls>.v<NN>` (section 5). Subtitle keys `subtitles.pne.res.<layer>`.
- Command root `/pne` (section 6.3).

---

## 5. Generated sound catalog

**File**: `overrides/kubejs/server_scripts/pne_res_catalog.js`, written only by
`tools/resonance/gen_sounds_json.py` from the verify manifest, in the same run that writes `sounds.json`.
**Variable**: `PNE_RES_CATALOG`. Layout (so both KubeJS and Python can read it):

```
// priority: 90
// Generated by tools/resonance/gen_sounds_json.py from the verified manifest. Do not edit by hand.
var PNE_RES_CATALOG = {"v": 1, "gen": "<manifest sha256, 12 hex>", "events": {...}, "pools": {...}}
```

Line 3 is `var PNE_RES_CATALOG = ` followed by **one strict JSON object** (Python reads it with
`json.loads(line[len('var PNE_RES_CATALOG = '):])`). Keys sorted, numbers with at most 2 decimals, no NaN.

`events` maps the full event id to:

| Field | Type | Meaning |
| --- | --- | --- |
| `layer` | string | `L1`..`L8` |
| `cls` | string | class slug (table below) |
| `lufs` | number | measured integrated loudness of the decoded OGG |
| `mmax` | number | measured maximum momentary loudness |
| `dur` | number | seconds |
| `cat` | string | vanilla category (`ambient`, `voice`, `hostile`) |
| `comfort` | boolean | may play in comfort mode |
| `normal` | boolean | may play in normal mode |
| `att` | int | `attenuation_distance` in `sounds.json` (whispers 32, director layers 128, tells 24) |
| `stream` | boolean | `stream: true` in `sounds.json` (files > 10 s) |
| `lf` | boolean | LF-periodic (counts toward A8 duty and exclusivity) |
| `reserve` | boolean | novelty reserve (A9): withheld for the first 30 min |
| `amb` | boolean | stereo AmbientSounds bed: referenced by regions, never issued by the director |

`pools` maps `'<layer>.<cls>'` to the sorted list of event ids of that class.

**Event naming**: `pne:res.<layer>.<cls>.v<NN>`, NN = 01..99; `sounds.json` key `res.<layer>.<cls>.vNN`, file
`assets/pne/sounds/res/<layer>/<cls>_vNN.ogg` (sound name `pne:res/<layer>/<cls>_vNN`). Layer slugs and the
classes the director uses:

| Layer | Slug | Classes | Mode |
| --- | --- | --- | --- |
| L1 Hollow | `hollow` | `dry`, `dread`, `muffled`, `t_dry_dread`, `t_dread_muffled`, `t_dry_muffled` | both |
| L2 Undertone | `undertone` | `a` | normal only |
| L3 Pulse | `pulse` | `heartbeat` (normal, m ≤ 0.6, -32), `heartbeat_c` (comfort, m ≤ 0.3, -34, ≤ 8 s), `flutter`, `rough` | as stated |
| L4 Beat | `beat` | `slow` (both, -34), `tense` (normal) | as stated |
| L5 Susurrus | `whisper` | `amb`, `near`; optional clade sub-pools `amb_c0`..`amb_c3`, `near_c0`..`near_c3` | both |
| L6 Approach | `approach` | `n` (normal), `c` (comfort) | as stated |
| L7 Spike | `spike` | `a` | normal only |
| L8 Tell | `tell` | `a` | both |

**Clade sub-pools** (TDD cross-feed 5): the director picks `<cls>_c<clade>` when `pneCoreHiveNear(player).clade`
is 0..3 and that pool has ≥ 3 events; otherwise (clade -1, hive absent, or a thin pool) it uses `amb` / `near`.
RESONANCE may render the sub-pools at M1 or later; nothing requires them.

**Stereo beds (AmbientSounds path, TDD L1 primary route): not shipped (lead decision 1.3).** A client-side
AmbientSounds region cannot follow the server's pacing state (PANIC drain, vacuum, RELEASE silence), comfort mode or
the ledger, so a region-played bed would break I5 (every horror sound through the ledger) and the comfort rules. The
director's positional mono `dry`/`dread`/`muffled`/`t_*` segments above are **the** L1 bed. RESONANCE may keep
rendering the stereo beds (`pne:res.hollow.bed_<dry|dread|muffled>.vNN`, 2 channels, 45-90 s loops, `stream: true`,
catalog field `amb: true`) into `tools/resonance/out/` for a later client-side route, but ships none of them: no
`bed_*` OGG, `sounds.json` entry or catalog event under `overrides/`. The catalog keeps the `amb` field in its format,
the director keeps skipping `amb` events, and no `assets/ambientsounds/**` file ships. Since 1.4 this is enforced: the
spec keeps the three bed classes with `"ship": false`, `verify.py --install` copies only shipped classes (126 of the 144
built assets, 5.87 MB of OGG; every shipped event has `amb: false` and `stream: false`, so nothing shipped streams),
the committed `tools/resonance/manifest.json` carries a spec-derived `not_shipped` list pinned by
`tools/resonance/tdd_pins.py` `NOT_SHIPPED`, `gen_sounds_json.py` refuses a manifest that lists an `amb` or not-shipped
asset, `verify.py --committed` and `resonance-consistency` fail on any `bed_*` file under `assets/pne/sounds` or any text
under `overrides/` naming one, and `tools/validate.py` fails on a catalog event with `amb: true`.

The pipeline may add classes; the director ignores classes it does not know. **The director must work with an
empty or missing catalog**: `typeof PNE_RES_CATALOG === 'undefined'`, or `events` empty, means no Resonance
layers are issued (external sounds still go through the ledger with PNE_RES_EXTERNAL values), and
`pneResTell` returns false. The pipeline keeps an empty catalog committed until assets exist:
`var PNE_RES_CATALOG = {"events": {}, "gen": "empty", "pools": {}, "v": 1}`.

---

## 6. Config and kill switches

### 6.1 One mechanism for defaults

`PNE_CORE_DEFAULTS` in the core is the only place defaults live. Values are ints stored as
`server.persistentData.pne_cfg_<key>` per world; absent means the default. Read with `pneCoreCfg(key)`; set only
through `/pne config` or `/pne <pillar> on|off`. Modules never keep their own copy of these defaults.

| Key | Default | Bounds | Meaning / owner of the behaviour |
| --- | --- | --- | --- |
| `on_resonance` | 1 | 0-1 | Resonance pillar (director layers and pacing) - DIRECTOR |
| `on_hive` | 1 | 0-1 | Hive Genome pillar - HIVE |
| `on_oracle` | 1 | 0-1 | Oracle bridge and logging - ORACLE |
| `on_visual` | 1 | 0-1 | visual phenotype - VISUAL |
| `light_aversion` | 1 | 0-1 | light aversion rule (lead decision: on, switchable) - HIVE |
| `gov_deaths` | 1 | 1-20 | governor target deaths ... - HIVE |
| `gov_days` | 3 | 1-30 | ... per player per this many in-game days - HIVE |
| `bridge_dedicated` | 0 | 0-1 | allow the bridge on a dedicated server (off by default, TDD 4.4.2) - ORACLE |
| `spawn_gate` | 1 | 0-1 | natural-spawn gate (startup) - DIRECTOR |
| `spawn_backstop` | 1 | 0-1 | spawned-discard backstop - HIVE |
| `vis_grafts` | 1 | 0-1 | display grafts (0: no grafts; teams, names and particles stay) - VISUAL |
| `debug` | 0 | 0-1 | extra logging, any module |

A module that needs a new key reports it to the lead; the core adds it (with bounds) in one place.
There is deliberately **no logging key**: telemetry logging is off unless a player opts in for themselves (3.5,
TDD 4.4.2, I11), so no operator setting can turn it on for others.

### 6.2 Pillar switches

`/pne <pillar> on|off` (admin) sets `on_<pillar>`, mirrors it to `global.pneOn<Pillar>` and runs the
`pneCoreOnToggle` hooks. What each module must do when its pillar is OFF:

| Pillar OFF | Required behaviour |
| --- | --- |
| resonance | No Resonance layers or tells; pacing FSM stops (`pneCorePace` falls back to mercy/grace-only pacing); `pne_gate`/`pne_pace_soft` removed; **the ledger still filters existing pack sounds** (`pneCoreEmit` always goes through `pneResEmit` when loaded); the startup gate keeps gating mercy and grace. |
| hive | No breeding, joins, expression, telemetry, light aversion, backstop or governor; startup producers stop enqueuing (`pneOnHive` 0; also while the hive runtime is absent); mobs keep the modifiers they have (removing a permanent max-health modifier would clip health); `Silent` is removed from tracked silent mobs, and saved silent mobs that rejoin later are unsilenced by the core (3.1). |
| oracle | No bridge writes or reads (one last `telemetry.json` with `want_oracle: false`), verdicts null, no logging. Telemetry extraction continues while resonance or hive is on. |
| visual | No new teams entries or grafts; existing grafts are removed by the next sweep; `pneVisRemove` still works. |

### 6.3 The `/pne` command tree

One Brigadier tree, built by the core hub. `/pne` alone prints help. Every word takes an optional greedy
argument string, split on whitespace into `ctx.args`. Several specs can share a word: the core's spec runs
first, then the modules' in load order, until one returns `true`. `admin` = permission level 2, or the
single-player owner (a comfort switch must never need cheats); the console is admin.

```
spec = { run: function (ctx) { ... return true if handled, false to pass }, help: 'one line', admin: false }
ctx  = { word, args: [strings], argStr, server, player (null for console), source, admin, reply(text, color) }
```

| Command | Owner | Who | Effect |
| --- | --- | --- | --- |
| `/pne` | CORE | anyone | help (lists every spec's help line the caller may use) |
| `/pne status` | CORE | anyone | pillar switches, loaded modules, tick-budget peak, then every `pneCoreStatus` line |
| `/pne config [key value]` | CORE | admin | list or set config (6.1) |
| `/pne resonance [on\|off]`, `/pne hive [on\|off]`, `/pne oracle [on\|off]`, `/pne visual [on\|off]` | CORE | anyone to read, admin to switch | pillar switch for this world |
| `/pne comfort [on\|off]` | DIRECTOR | anyone | own comfort mode (tag `pne_comfort_off` when off) |
| `/pne audio` | DIRECTOR | anyone | shows the first-run notice again |
| `/pne resonance whispers\|throb\|approach\|stingers on\|off` | DIRECTOR | anyone | own per-layer switches |
| `/pne resonance self on\|off` | DIRECTOR | anyone | all Resonance audio on/off for the caller only |
| `/pne resonance status` | DIRECTOR | anyone | caller's state, tier, e, θ, m |
| `/pne hive status` | HIVE | anyone | pool size, generation, governor, σ, queue |
| `/pne oracle status` | ORACLE | anyone | bridge state, whether a sidecar answers, caller's logging flag |
| `/pne oracle log on\|off` | ORACLE | anyone | **the caller's own** logging opt-in; never for others |
| `/pne oracle purge` | ORACLE | anyone | deletes the caller's logs (request to the sidecar) and rotates the caller's pid |
| `/pne visual status` | VISUAL | anyone | team entries, grafts |
| `/pne visual sweep` | VISUAL | admin | runs the sweep now |

Words are `[a-z][a-z0-9_]{0,23}`. Registration happens at load time (`pneCoreCommand`); the tree is built once
per command registration (server start and `/reload`, F12). A module registers the specs for its own word
only (`hive`, `oracle`, `visual`, `resonance`, `comfort`, `audio`).

---

## 7. Tick schedule and the shared token budget

### 7.1 Order inside one tick

All work runs in `ServerEvents.tick` (end of tick, F15), in load order: core → oracle → director → hive →
visual → existing scripts. Event handlers (`spawned`, `death`, `hurt`, `placed`, Forge events) only
**enqueue** (O(1)); the queues are drained in the tick handlers under the budget. One sanctioned exception (1.4):
`pne_horror.js`'s reinforcement chain has always run in its `EntityEvents.death` handler, and its FLK placement (3.2.1)
runs there with it, bounded to one HiveInfo read, one light read, 1 test command, ≤ 8 chain commands, ≤ 112 block reads
and ≤ 112 tag reads, at most once per 100 ticks server-wide (the beckon cooldown).

### 7.2 Slots (`s = pneCoreTick % 20`, `t = pneCoreTick`)

| When | CORE | ORACLE | DIRECTOR | HIVE | VISUAL |
| --- | --- | --- | --- | --- | --- |
| every tick | reset budget to 2.5 ms | - | cheap ledger bookkeeping | drains: ≤ 12 rejoins, ≤ 4 newborns (joined in an earlier tick), ≤ 20 mob telemetry samples, damage/leave queues | graft yaw sync every 3 ticks (`t % 3 === 0`) |
| `s === 0` | - | **bridge write** (`telemetry.json`) | - | no breed, no dream slice | - |
| `s === 10` | - | **bridge read** (`verdict.json`) | - | no breed, no dream slice | - |
| `s` in `PNE_CORE_TEL_SLOTS` | - | telemetry for `pneCorePlayersAtSlot(server)` | 1 Hz step for the same players (reads this tick's snapshot) | - | - |
| `s === 5` | housekeeping (mercy/grace tags) | - | global 1 Hz work (`pne_horror.js` jobs) | - | - |
| `t % 4 === 3` | - | - | - | **breed** (≤ 1) if no drain is pending and `pneCoreTake(COST.breed)` | - |
| `t % 4 === 1` | - | - | - | dream slice if no breed, no drain, dream pending | - |
| `t % 100 === 42` | - | - | - | light aversion pass (if `light_aversion`) | - |
| `t % 200 === 106` | - | - | - | - | sweep |
| `t % 6000 === 6` | - | - | - | pool save becomes due (also at dawn, at a switch-off, after `/pne hive prev drop` and after a load without a readable state): **incremental** (1.4), one `saveBegin`/`savePart` step per **free save slot** (an even tick outside slots 0 and 10), run before the drains; then the write steps. The one-call save runs only at `ServerEvents.unloaded` | - |

Slots 0 and 10 carry no per-player work by construction (`PNE_CORE_TEL_SLOTS` skips them). Breed ticks
(`t % 4 === 3` → slots 3, 7, 11, 15, 19) and dream ticks (`t % 4 === 1` → slots 1, 5, 9, 13, 17) never fall on 0 or
10. `PNE_CORE_TEL_SLOTS = [2,4,6,8,12,14,16,18,1,5,9,13,17,3,7,11,15,19]`: the first 8 players get even slots, so
their telemetry (1.0 ms) never shares a tick with a breed (2.26 ms) or a dream slice. The light pass, the sweep and
the pool save sit on even ticks for the same reason. **A fixed-schedule job whose `pneCoreTake` is refused retries
on each following tick until it runs** (then waits for its next scheduled tick); a refused save step retries at the
next free save slot. The pool save may share a tick with drains (the TDD's "no drain" wording is relaxed: drains run
every tick). Since 1.4 no save step claims a tick of its own, waits for DREAD/PANIC to pass or takes the rest of the
budget: **the I9 save exception is removed** (each step is charged and measured within its constant at the maximum
state, 7.3).

### 7.3 Token budget

`PNE_CORE_BUDGET_MS = 2.5` per tick, reset by the core's tick handler (the first handler of the tick). Every
costed item draws its fixed constant before running; if `pneCoreTake` refuses, the item is skipped (per-player
work waits for the player's next slot; drains and breeds try again next tick; fixed-schedule jobs retry, 7.2). No
clock is read (F25).

Who charges what: `pneCoreTake` is called only from `ServerEvents.tick` handlers (event handlers only enqueue).
Two exceptions never refuse: `pneResEmit`/`pneResEmitAt` charge `emit` per issued sound with `pneCoreTake` and
proceed even when it is refused (a pack sound is never dropped for budget), and the core's no-director emit
fallback charges nothing. `pneVisApply` charges `visApply` itself; when refused it defers the apply to VISUAL's own
queue, drained in `pne_visual.js`'s tick. HIVE does not charge `visApply`.

| `PNE_CORE_COST` key | ms | Used for | Source |
| --- | --- | --- | --- |
| `rejoin` | 0.12 | re-expression of a rejoining mob | hive-rhino-bench p50 0.094 x 1.3 |
| `newborn` | 0.32 | newborn expression incl. mutantClone | hive-rhino-bench p50 0.257 x 1.25 |
| `mobSample` | 0.0096 | one tracked-mob telemetry sample | measured |
| `playerTel` | 0.35 | one player's telemetry (entity query + ≤ 4 raycasts) | oracle-telemetry-bench p90 0.29 (150 entities), plus headroom |
| `breed` | 0.7 | `breed()` alone (breedOne + queue push); the insert is charged per outcome | ga-core-breed-bench warm p95 0.09-0.12, cold ~0.58; lead decision 1.5 charges the cold level with margin and keeps `outcome` below `breed` |
| `dreamSlice` | 1.5 | one dawn-dream slice | ga-core-breed-bench heaviest step p95 0.42-0.56 |
| `dawn` | 1.2 | `PNE_HIVE_GA.dawn()` on the dawn tick | ga-core-breed-bench p95 0.52-0.64 (HIVE still charges `breed` there: module follow-up) |
| `gaSave` | 2.0 | the one-call `PNE_HIVE_GA.save()`: since 1.4 only at server stop (`ServerEvents.unloaded`), **outside the budget** | ga-core-breed-bench p95 0.89-0.93 (bench state); 4.6-12 ms p50 at the maximum state (NbtSizeTest, barely warm JVM), which no longer matters for I9 |
| `gaSavePart` | 0.6 | one step of the incremental pool save, one per free save slot: each `savePart` piece, and the last piece together with `saveEnd`; HIVE charges the start (`saveBegin` + the runtime string `hv`) `gaSavePart` + `save` = 0.72 | ga-core-breed-bench: samples piece p95 0.27-0.29 on one timing level and 0.40-0.41 on the other; lead decision 1.5 charges the slower level with margin (the bench recommends 0.6) |
| `save` | 0.12 | one pool-save step (16 base IntArrays; the swap counts 2) | hive-rhino-bench |
| `bridgeWrite` / `bridgeRead` | 0.41 / 0.39 | JsonIO p50 | measured |
| `director` | 0.15 | one player's director step + ledger | director Rhino harness 0.14-0.15 (warm) |
| `emit` | 0.04 | one ledger decision + command (also one core unsilence command, one sensing probe) | director Rhino harness 0.034 |
| `lightPass` | 0.3 | one light-aversion pass | estimate |
| `graftSync` / `visApply` / `sweep` | 0.02 / 0.05 / 0.3 | visual work (one graftSync token covers 2 scan records) | visual-rhino-bench (script side; commands need spark) |
| `upkeep` | 0.01 | core housekeeping per player | estimate (HIVE charges its own per-player step at its measured 0.03) |
| `leaveOut` / `convRec` | 0.03 / 0.0007 | one KILLED/DISCARDED leave record / each newborn the conversion search walks | hive-rhino-bench |
| `silentVisit` | 0.06 | one silent-mob visit incl. its ash particle | hive-rhino-bench |
| `nearBase` / `nearRec` | 0.015 / 0.0007 | the per-player `pneHiveNear` table: fixed part / each tracked mob in the grid cells | hive-rhino-bench |
| `outcome` | 0.6 | one GA outcome insert (`PNE_HIVE_GA.outcome`) | ga-core-breed-bench p95 0.28-0.29 on one timing level and 0.45 on the other, reproduced on an idle machine; lead decision 1.5 charges the slower level with margin (the bench recommends 0.6). Stays below `breed`, which `hive-node` asserts |
| `steer` | 1.0 | one `Mob#getNavigation().moveTo` for SCT steering (config `debug` 1 only) | **placeholder**, never measured offline; replaced by the spark measurement of TESTING.md M3 |

HIVE charges `PNE_CORE_COST.outcome` and `PNE_CORE_COST.steer` (it may keep charging the higher of the core key and its
own measured value, as for every key).

Only the core changes these constants (modules report measured values). The long-run average target is ≤ 1.0
ms/tick; I9's hard limit (≤ 3 ms of KubeJS work per tick, excluding OS file stalls) is checked with spark in game.

---

## 8. Degradation matrix

"Absent" = the file is missing or failed to load; "off" = its pillar switch; "broken" = its handlers tripped
their breakers. The core wrappers make absent, off and broken look the same to callers.

| Missing or broken | Director | Hive | Oracle | Visual | Existing horror |
| --- | --- | --- | --- | --- | --- |
| **CORE** | no module can run (each module checks `typeof PNE_CORE_API === 'number'` at load, logs one error and registers nothing) | same | same | same | horror sounds skipped (they need the core's emit or the ledger); gore particles, bursts, beckons, doom clock and messages unchanged, bursts and beckons without pacing multipliers |
| **GA-CORE** | unaffected | HIVE logs one error and stays off (no expression, no telemetry, no backstop) | unaffected | no calls (hive off) | unaffected |
| **HIVE** | no tells needed: saved silent mobs are unsilenced by the core when they rejoin (3.1); whispers use the `amb`/`near` pools (clade -1); no apex novelty | - | style buckets are not consumed; bridge unaffected | no calls | unaffected, except that reinforcement beckons stay at the dying mob (no `HiveInfo.flk`, 3.2.1) |
| **DIRECTOR** | - | `pneCorePace` falls back (mercy/grace only: spawn 0, GA weight 0); `pneCoreTell` false → hive keeps SIL mobs audible by dropping `Silent`; backstop still works (core tags) | unaffected | unaffected | sounds play as before M2 through the `pneCoreEmit` fallback (comfort skips stingers); no natural-spawn gate beyond what the startup gate does |
| **startup gate** (`pne_res_gate.js`) | natural spawns ungated; director spawn multipliers still act on scripted spawns | backstop (if on) still discards newborns near mercy/grace players | - | - | - |
| **ORACLE** | heuristic only: S_H and θ from its own light-weight sensing (coarse `execute if entity` distance bands, light, health) at the same slot; pacing never stops (I6) | T_est from rule tactics only, sensed by HIVE itself (block light at the player, its own torch counter: 3.3); no style buckets | - | - | - |
| **Oracle sidecar** (not running / stale) | verdict `fresh:false` or null → w = 0 → S_H (I6) | no style buckets logged that second | writes `want_oracle`; status shows no answer | - | - |
| **RESONANCE assets / catalog** | ledger still runs for existing sounds; no layers; `pneResTell` false | SIL falls back to dropping `Silent` | - | - | through the ledger |
| **VISUAL** | - | expression unaffected (`pneCoreVisApply` no-op) | - | - | - |
| **`pne_hive_events.js`** (startup) | - | no damage/leave queues: fitness gets no dmg/killShare samples, removals are not scored, PRJ scaling off; **no backstop** (nothing sets `pne_fresh`, so no newborn qualifies); hive keeps breeding from mutantClone | - | - | - |

VISUAL absent or broken: `item_display` grafts never despawn, so existing grafts stay as orphans until VISUAL runs
again. The uninstall commands (`kill @e[type=minecraft:item_display,tag=pne_graft]` and the rest) are in
`docs/TESTING.md`, "Removing The Hive Remembers from a world" (the core itself never kills or discards anything).

Every row and every pillar switch is exercised by the suites `pack-smoke` and `pack-degradation`
(`tools/tests/pack/run_pack.py`: all scripts in one Rhino scope, startup scripts in their own, one shared global), and
again by `pack-smoke-strict` / `pack-degradation-strict` with only the method names KubeJS leaves visible in game
(F37). "Absent" is each file removed in turn, "off" each pillar switched off and on through `/pne`, and "broken" the
variants `broken-director` (`pneResEmit` and `pneResPace` throw) and `broken-hive` (`pneHiveInfo` and `pneHiveNear`
throw): they run until the core's API breaker for that pillar trips and then assert the core's fallbacks (comfort
players get no stinger through the no-director emit fallback, the one "ledger off until /reload" warning, pacing
spawn 0 / GA 0 under mercy, no tell so HIVE drops Silent; `pneCoreHiveNear` clade -1 and `pneCoreHiveInfo` null). The
`pne_hive_events.js` row is asserted as written (no backstop discard, no projectile scaling, which the full run shows
working), and without the hive runtime (`no-hive`, `no-ga-core`) `pneOnHive` stays 0 and the startup queues stay empty.

Invariants that must survive every row: I1 (arousal never raises pressure), I3 (no credit during mercy/grace),
I5 (every horror sound through the ledger whenever the director is loaded), I6, I8 (no camera or screen
effects anywhere), I10 (nothing kills a process), I11 (pseudonyms only).

---

## 9. Test conventions

### 9.1 One runner

`python tools/run_tests.py` runs everything and exits non-zero on any failure. Built-in suites:

| Suite | What it checks |
| --- | --- |
| `kjs-lint` | `tools/ci/kjs_lint.py`: KubeJS preprocessing traps (F3, F4) on every script; for new scripts ES5 bans, the Rhino var rule (F26), the priorities of section 2.2 (on line 1) and the name prefixes, strict comparisons on `global` values (F6), comfort bans (nausea, blindness, darkness, confusion; tp/teleport at `@a`/`@p`/`@r`), hidden Mojang names (F37: a fully hidden name only as a fallback inside `try` after the same receiver's KubeJS name in the same function; `EntityEvents.hurt(...)` excluded; the table equals `tools/visual/kjs_renames.py`); duplicate top-level names across one script folder (F1; fails when a new file is involved); GA-core purity |
| `validate` | `tools/validate.py` (node syntax, JSON, TOML, SNBT) |
| `rhino-compile` | every `overrides/kubejs/**/*.js`, KubeJS-preprocessed exactly like `ScriptFileInfo.preload`, compiled by the instance's Rhino jar under JDK 17 |
| `core-node` / `core-rhino` | the core smoke test (72+ assertions) in Node and in real Rhino |
| `core-hub-brigadier` | the `/pne` hub against real Brigadier 1.1.8 in real Rhino |
| `no-process-kill` | `tools/ci/no_kill.py`: no process-kill call forms under `oracle/**` and `tools/**` (I10), and no `subprocess.run`/`call`/`check_call`/`check_output` with `timeout=` (which ends its child on expiry) outside the listed harness files (Appendix A rule 12) |

`python tools/run_tests.py --list` shows every suite and whether its tools are present; `--only NAME` runs a
suite or a whole module. A plain run passes when nothing FAILs; SKIPs (exit 77, missing tools) do not fail it.
**Milestones are checked with `python tools/run_tests.py --milestone M0`** (M0..M5, comma-separated for several):
it runs the suites `tools/suites/milestones.json` lists for that milestone and fails if any is not registered,
SKIPs or FAILs.

### 9.2 How a module adds its suites

Add `tools/suites/<module>.json` (format at the top of `tools/run_tests.py`). Placeholders `{python}`,
`{node}`, `{java}`, `{javac}` (JDK 17), `{rhino_cp}`, `{root}`, `{tmp}`, `{ffmpeg}`; `needs` from `node`,
`rhino`, `jdk17`, `brigadier`, `kubejs`, `mcjar`, `ffmpeg`, `numpy`, `scipy`, `soundfile`. Exit 0 passes, 77
skips; `"expect": "PASS"` also requires the last output line to start with `PASS`. Tests write only to
`PNE_TMP` (outside the repo), never to the instance or `overrides/`.

### 9.3 Testing a KubeJS server module

1. Node: `node tools/tests/kjs_node.js EXPR tools/tests/kjs_mocks.js overrides/kubejs/server_scripts/pne_00_core.js <your files...> <your test.js>`
   evaluates everything in one context (like one script pack) and passes when EXPR evaluates to a string
   starting with `PASS`. Write tests in ES5 so the same file runs in Rhino.
2. Rhino: `python tools/rhino/pne_rhino.py run EXPR <same files>` does the same inside the instance's Rhino jar
   with the KubeJS class filter replica, `global` as a Java `HashMap`, `console`, `Java.loadClass` and the
   game's `MinecraftRemapper` (F34; net.minecraft classes are not on the classpath: guard every `Java.loadClass`).
   The Node harness's `global` also returns wrapper objects for numbers and strings (F6), but only Rhino is the
   real thing: **every test of code that reads `global` or touches the startup queues must also run in Rhino.**
3. `tools/tests/kjs_mocks.js` provides the event groups, a mock server/player/mob, persistent data (with
   Java-like `getCompound`/`put`), `getForgePersistentData`/`getEntityType`/`getEncodeId` on entities, damage
   sources (`__pneMock.damage(msgId, causer, direct)`), a small Brigadier, `__pneMock.tick(server, n)`, a Node shim for
   `Java.loadClass('java.util.ArrayList')`, and switches in `__pneMock.opts` (`typeAsObject`, `noEncodeId`,
   `mojangNames`) for the other platform shapes. **It has the in-game shape of F37**: the level answers `getTime()` and
   `getDimensionKey()`, damage sources `getType()`/`getActual()`/`getImmediate()`, entities `getYaw()`/`getPitch()`, the
   server `isDedicated()`; the hidden Mojang names (`getGameTime`, `getMsgId`, `getEntity`, `getDirectEntity`, `getYRot`,
   `getXRot`, `isDedicatedServer`) exist only under the opt-in `__pneMock.opts.mojangNames`, for a test of a mock-fallback
   path, never to make module code pass. Extend it in your own prelude file; ask the lead for shared additions.
4. Java benchmarks and goldens: compile with `{javac}` against `{rhino_cp}` (see `tools/rhino/pne_rhino.py`
   `build()`); JDK 17 only, never the `javac` on PATH.
5. Python suites: Python 3.13 with numpy/scipy/soundfile only; no network, no installs.

### 9.4 Required suites per module

Suite **names are binding** (they are what `tools/suites/milestones.json` requires). A module may add more suites.

| Module | Required suite names and what each covers |
| --- | --- |
| GA-CORE | `ga-core-node` (Node unit + determinism + goldens), `ga-core-golden-rhino` (Rhino golden parity, same hashes), `ga-core-replay` (interleaved replay golden B, P, J, I, D, G, R, using the log grammar of 3.7), `ga-core-mercy` (mercy test (a), and `dawn` with target 0 leaves gov finite and unchanged), `ga-core-guard` (guard test (c)), `ga-core-adaptation` (adaptation and diversity, TDD 6.3), `ga-core-governor` (governor tracks its target within ±0.01), `ga-core-dream-align` (live-mode dream alignment ≥ 0.5 within the first 6000-spawn phase, lead decision 1.3; the TDD's 3000-spawn point and the post-shift phase are printed; the dream adds ≥ 0.05 over the same runs without it at 3000 and 6000 spawns and at the end of the post-shift phase; the live run is deterministic), `ga-core-breed-bench` (Rhino: breed incl. the sharing-denominator cache, prints ms per breed; the lead updates `PNE_CORE_COST.breed`, and HIVE raises the breed rate only when the lead changes the 7.2 row: the M3 entry criterion; 1.4: every timed call gated against the `PNE_CORE_COST` key HIVE charges for it, the incremental save steps and the last piece + `saveEnd` against `gaSavePart`, the gate wiring self-checked first; each timing gate judged on the best of up to 3 fresh-JVM trials, while every trial must pass the state check), `ga-core-save-parts` (1.4: every incremental save equals `save()` at its `saveBegin` while the state changes between pieces; the load epoch) |
| HIVE | `hive-node` (Node runtime tests on the mocks: queues, next-tick newborn rule, backstop before RNG, **backstop skips mobs without `pne_fresh` (loaded from disk)**, idempotent re-expression, permanent-HP check-then-add, outcome and dawn inputs carry only buckets (no arousal, no hp: I2); 1.4: the incremental save's slots and byte-identity with the one-call save, superseded and failed saves never writing, the load epoch incl. the crash and fresh-world cases, tells for every survival player within 12 blocks, `HiveInfo.flk`), `hive-rhino-bench` (Rhino mock-world benchmark within section 7 costs; 1.4: at the maximum state the save start against `gaSavePart` + `save` and every piece against `gaSavePart`), `hive-kmercy-rhino` (the startup k_mercy formula in Rhino: pre-damage hp ≤ 30%, live grace or the mercy tag give k = 0; a stale grace tag gives k = 1), `hive-nbt-size` (`NbtSizeTest.java`: max state, every string ≤ 60,000 bytes, uses `mcjar`), `hive-conversion-replay` (join-before-leave conversion replay) |
| RESONANCE-PIPELINE | `resonance-meter-selftest`, `resonance-verify` (V1-V16 on every decoded asset; manifest diff), `resonance-consistency` (`sounds.json` / catalog / lang: every catalog event has a `sounds.json` entry and an OGG; catalog parses as JSON; no `amb` / `bed_*` event, pool, `sounds.json` entry or OGG ships, and no text under `overrides/` names one, lead decision 1.3), `resonance-determinism` (re-renders the shipped classes bit for bit; 1.4: the re-render changes nothing under `overrides/` or `tools/resonance/`, a size and mtime guard proven on a probe tree), `resonance-tdd-pins` (1.4: the spec's `ship: false` set equals `tdd_pins.NOT_SHIPPED`) |
| DIRECTOR | `director-node` (FSM invariants, audio ceiling never raises the tier; the ported prototype tests at M0), `director-parity` (JS/Python parity), `director-ledger-sim` (1 h per mode: 0 immediate repeats, bus ≤ -18 LU, A8, level-jump for every source incl. the existing-sound table, comfort envelope rule, no early stopsound), `director-closed-loop`, `director-routing` (no `playsound` string left in `pne_horror.js`), `director-gate` (the `pne_res_gate.js` formula in **Rhino**, including `spawn_gate` 0 in `global` switching it off and stale `pne_gate`/`pne_grace` tags not gating), `director-rhino` (Rhino smoke of `pne_resonance.js` with an empty catalog), `director-flank` (1.4: the FLK placement of 3.2.1 on the mocks with a terrain model: rear arc from the facing, 24-40 blocks, the light and FLK boundaries, identical command streams and beckon counts without FLK, every chain rule, bounded probes), `director-horror-rhino` (1.4: also one flank placement in real Rhino) |
| ORACLE | `oracle-features-node` (feature extractor), `oracle-bridge` (parse/staleness, tolerant of `1.0` integers and torn files; `purge` hand-shake), `oracle-sidecar` (`cpu_np` inference parity, stop.flag shutdown), `oracle-stale-lock` (a lock naming a live non-sidecar PID is stale; nothing is killed), `oracle-check-overrides` (`check_overrides.py`), `oracle-telemetry-bench` (MockWorld per-player telemetry benchmark, 150 entities, reports the value for `PNE_CORE_COST.playerTel`) |
| VISUAL | `visual-node` (team/graft bookkeeping on the mocks, deferred `visApply` queue), `visual-json` (model overrides), `visual-art-check` (no PNG under `overrides/` derived from EPCA/Spore art) |
| Lead / integration | `pack-smoke` (every server script in one scope in KubeJS load order, the startup scripts in their own scope, one shared global, 2+ in-game days with deaths, respawns, a Hive Night, dawns, /reload and a restart; fails on any uncaught error, module breaker failure, NaN, budget overrun, comfort or mercy violation), `pack-degradation` (each new file removed in turn, section 8; each pillar off and on again, 6.2; the broken variants), `pack-smoke-strict` and `pack-degradation-strict` (the same with only the names KubeJS leaves visible in game, F37), `pack-lint-duplicates` (the lint catches duplicate top-level names across one script pack), `pack-lint-hidden-names` (the lint catches unguarded hidden Mojang names, F37), `pack-apply` (tools/apply.py install steps on a throw-away instance) |

The core's `no-process-kill` suite covers I10 for ORACLE's code, and `kjs-lint` covers I8 (comfort) for every new
script.

---

## 10. Milestone exit criteria

Automated = `python tools/run_tests.py --milestone Mn` reports MET (every required suite of 9.4 registered and
passing; a SKIP does not count). Items no suite can decide (a user decision, deferred scope) are listed per milestone
under `pending` in `tools/suites/milestones.json`; while any is open the runner prints them and reports "MET for the
automated criteria", never plain MET. In-game = needs the user's hands; each module lists its in-game checks in its final
report so the lead can add them to `docs/TESTING.md`. M0 needs suites from builders of later milestones
(`director-node`, `oracle-*`, `hive-nbt-size`); those builders deliver them at M0.

| M | Automated | In-game |
| --- | --- | --- |
| M0 | core suites green; GA goldens identical in Node and Rhino; interleaved replay, mercy and NaN-guard tests pass; director/ledger and feature cores ported with their prototype tests passing; MockWorld per-player telemetry cost measured (150 entities) and `playerTel` updated or the cadence changed; NbtIo size test passes | `/pne status` shows `pd=kjs` after a login (F8/F9); a player keeps the same pid after dying |
| M1 | 100% of assets pass V1-V16; ≥ 6 variants per layer, 12 + 12 whispers, L8 tells; `sounds.json` with `attenuation_distance`; catalog and lang generated and consistent; no stereo bed ships (1.4) | a stereo bed event is unknown in game and the mono L1 segments play (docs/TESTING.md M1; loudness in game is checked at M2) |
| M2 | director suites green (FSM, ceiling, ledger simulation incl. existing sounds, parity, closed loop); a DIRECTOR suite confirms no `playsound` command string is left in `pne_horror.js` (every sound goes through `pneCoreEmit`/`pneCoreEmitAt`); the strict pack runs pass (F37); the FLK placement suite passes (`director-flank`, 1.4). Pending: the comfort-envelope assets await the user's sign-off | spark ≤ 0.2 ms/tick for the director; one L_eff capture within ±3 dB (a whisper and a director layer); hive spawns near a player in mercy over 10 min ≈ 0 (startup gate); `/pne config spawn_gate 0` really lets natural spawns through; comfort listening sign-off by the user; bell and beckon levels measured; `/pne` tree works for a non-op single-player owner; first-run notice appears once (no AmbientSounds regions ship: section 5) |
| M3 | Node/Rhino golden parity; runtime tests; mock-world benchmarks within the token table; sharing cache implemented and benchmarked (`ga-core-breed-bench`, the M3 entry); live dream alignment ≥ 0.5 within the 6000-spawn phase; the incremental save equals the one-call save (`ga-core-save-parts`, `hive-node`, `hive-nbt-size`) and every save step fits its charge (1.4); FLK placement (`director-flank`); the strict pack runs pass (F37) | L8 tells heard by every survival player within 12 blocks; the incremental save completes (saves counter rises, no spike on the save tick) and the load epoch rises across `/reload` and a restart; FLK places reinforcement beckons behind the player at low light (docs/TESTING.md M3); modifiers survive a chunk reload (HP not clipped); saved parasites near a respawned player are **not** discarded on chunk load (backstop `pne_fresh` rule); horde spawns near a player in grace or mercy are discarded by the backstop and nothing else breaks; `pne_gp` set after infecting a villager; effect immunity (light aversion) checked; spark budget met during Hive Night; backstop does not break EPCA phase spawns (else set `spawn_backstop` 0); `global` queues drain (no growth); `Mob#getNavigation` callable from Rhino (F33), else SCT expresses as tag-only (FLK never steers; it places reinforcement beckons, 3.2.1); hive-caused death classification matches a parasite kill, an arrow from a parasite, a fall after a hit, void and `/kill` (F36) |
| M4 | visual tests; JSON/model validity; no closed-source art in the repo. MET for these automated criteria only: Spore EMF is deferred (pending, Open decisions) | ETF on GeckoLib EPCA confirmed or a fallback chosen (the variants come from the local install-time generator); no orphan displays after 2 h; no visible axe on Spore hosts; 2-3 Spore models exported with EMF and compared with `emf_spore_parts.py` before any `.jem` is authored |
| M5 | sidecar and bridge tests; `check_overrides.py` passes; `no-process-kill` passes; stale-lock test (a lock naming a live non-sidecar PID is stale and nothing is killed); the pack smoke and degradation runs, plain and strict | 20/20 verdicts within 1 s; staleness fallback verified by stopping the sidecar with `stop.flag` or `--exit-after 120` (never by PID); logging opt-in affects only the caller; spark p99 on bridge-write ticks < 50 ms over 30 min (else set the bridge cadence to 40 ticks); per-player telemetry within `playerTel` in spark |

---

## Appendix A. Coding rules and the handler template

Rules (the lint enforces the mechanical ones):

1. ES5 only: no `let`/`const`, arrow functions, classes, template literals, destructuring, spread, `for...of`,
   default parameters, `Object.entries/values/assign`, `Array.from`. (The existing legacy scripts are exempt.)
2. Every `var` at the top of its function, including loop counters (`var i` ... `for (i = 0; ...)`). Never
   `var` inside `if`/`try`/loop bodies or `for (var ...)` (F26). Top-level `var`s sit outside any block too.
3. No `charCodeAt` in hashing (F26): use `pneCoreFnv1a` or an `indexOf` table.
4. Comparators are total orders with an index tie-break.
5. Convert Java values before use (F6): `String(x)` for strings before `split`, `===`, `indexOf`, object keys, or
   JSON; **every value read from `global`** goes through `Number(v)` (after an `undefined`/`null` check) or
   `String(v)`, never `===`/`!==` or truthiness on the raw value.
6. Call Java methods explicitly (`getX()`, `getOverworld()`) by their Mojang or KubeJS names only. SRG names
   (`entity['m_...']()`) are invisible in game (F34); do not write SRG fallbacks. The `EntityType` is
   `entity.getEntityType()` (F28); the UUID is `pneCoreUuid(entity)`.
7. `Java.loadClass` only at the top level, each in its own `try`, result `null` on failure, every use guarded.
8. Only commands through `server.runCommandSilent(...)` change the world from scripts (existing pack rule).
9. Never cancel `EntityEvents.spawned` for parasites (F19); never use `EntityEvents.checkSpawn` to deny (F17).
10. Comfort: nothing moves the camera or applies nausea, blindness, darkness, or any screen effect. Comfort mode
    is on unless the player opted out. `pne_radiation_comfort.js` and `pne_comfort_guard.js` stay authoritative.
11. No personal data in files: no usernames, home paths or emails; write `%USERPROFILE%` or `<instance>` in docs.
    One exception (lead decision 1.4): `LICENSE` keeps its copyright line naming the account the public repository is
    published under. That is a standard licence attribution, not extra personal data. No other file names the account,
    and nothing else about the user (home paths, emails, real names) is allowed anywhere.
12. Never kill a process; the sidecar stops only through `stop.flag`. The one exception (I10 forbids kills by PID or
    by name of the user's processes, which this is not): a test harness or local tool may let a child process **it
    started itself** be ended through that child's own handle when the child exceeds its timeout
    (`subprocess.run(..., timeout=...)` does this); never any other process, never by PID or name, and a sidecar child
    gets `stop.flag` first. `tools/ci/no_kill.py` lists the harness files allowed to do so and fails anywhere else.
13. `/reload` re-runs every server script: module-level state starts fresh, handlers are re-registered, the
    command tree is rebuilt. Anything that must survive lives in persistent data. `global` survives (F5), so
    consumers of the startup queues must accept records left from before the reload.
14. Startup scripts run once per game launch and cannot see server-script names; they read only tags,
    persistent data and the `global` keys of section 4.5 (converted with `Number()`/`String()`, rule 5), and apply
    the freshness rules of 3.4 to `pne_grace` and `pne_gate`.

Module skeleton (server script):

```
// priority: 70
// Parasites New Dawn - Enhanced :: The Hive Remembers, <module> (server side)
// ...

var PNE_RES_API = 1
var pneResReady = typeof PNE_CORE_API === 'number' && PNE_CORE_API >= 1
var PNE_RES_B_TICK = pneResReady ? pneCoreBreaker('resonance.tick', 5, 'consecutive') : null

function pneResOnTick(event) {
  var players
  var i
  if (PNE_RES_B_TICK.off || !pneCoreOn('resonance')) return
  try {
    players = pneCorePlayersAtSlot(event.server)
    for (i = 0; i < players.length; i++) {
      if (!pneCoreTake(PNE_CORE_COST.director)) break
      pneResStep(players[i])
    }
    pneCoreOk(PNE_RES_B_TICK)
  } catch (err) {
    pneCoreFail(PNE_RES_B_TICK, err)
  }
}

if (!pneResReady) console.error('[pne_resonance] pne_00_core.js did not load; this module stays off')
if (pneResReady) {
  ServerEvents.tick(pneResOnTick)
  pneCoreCommand('comfort', { run: pneResCmdComfort, help: 'comfort [on|off]: your comfort mode' })
  pneCoreStatus('resonance', pneResStatusLine)
}
```

Handler registrations are expression statements inside the `if`; all `var`s and `function`s stay at the top
level outside it. Startup scripts use the same breaker pattern locally (they cannot see the core): count
errors, log the first few, then disable quietly (as `pne_alliance.js` does).

---

## Changes in 1.1 (review round 1)

- F6 corrected: numbers read from `global` are wrapped objects too; 3.4 step 1, 3.3 producers, 4.5 and rule 5 now
  convert with `Number()`/`String()`. `core-rhino` asserts `spawn_gate 0` turns the reference gate off; the Node
  harness wraps `global` values the same way; the lint rejects strict comparisons on `global`.
- F8/F28 evidence corrected (KubeJS renames Forge's `getPersistentData` and vanilla `getType` through Mixin-merged
  `@RemapForJS`; without it the choice flips between JVM runs); `pd=` in `/pne status` confirms it in game. F9 depends
  on it. F34 (SRG names invisible; no SRG fallbacks), F35 (`loadedFromDisk`), F36 (death msgIds) added; F3, F24, F26
  corrected. `PneRhino` installs the game's remapper.
- Core: `pneCoreTypeId` fallbacks and `getEntityType()`-based tag check; validated `pneCoreUuid`; freshness rules for
  `pne_grace` / `pne_gate` (`pne_m_t`); `pneCorePace` staleness and mercy/grace override; `pneCoreStage`;
  hive-caused death tracking (`pneCoreHiveDeaths*`, `pneCoreDeathCause`); `pneCoreSpawnMultAt`, `pneCoreBeckonAt`,
  `pneCoreSpawnCount`; comfort rules in the no-director emit fallback; saved silent mobs unsilenced while the hive
  is not running; `log_default` removed; telemetry slots reordered; upkeep clears director tags when it is gone.
- Contract: backstop `pne_fresh` rule; tell cadence, `located`, sensing and horde mitigation owned by HIVE; dawn
  `players`/`target` defined; replay log grammar; stereo beds and optional clade whisper pools; purge hand-shake;
  `pne_pace_soft` alternation; budget charging rules; slot moves and retry rule; binding suite names,
  `tools/suites/milestones.json` and `run_tests.py --milestone`; `no-process-kill` suite; lint duplicate-name,
  line-1 priority and comfort checks; more in-game checks in section 10.

## Changes in 1.2 (integration round)

Verified corrections, applied in place above: F23 (JsonIO truncates in place, LazilyParsedNumber on read), F26 (Math
constants undefined), F36 and the new **F37** (KubeJS-renamed methods; 3.1 `pneCoreDeathCause`, 3.3 k_mercy and 3.4 step 4
now name `getType()` / `getTime()`), 3.6 (collision `always`, `_named` sibling teams, grafts only on engaged hosts),
6.1 (`vis_grafts`), 7.3 (cost constants set from the benchmarks), 8 (CORE row: horror sounds are skipped without the core;
the startup listener row: no backstop), 9.4 (the lead's pack suites). The core follows F37 (KubeJS names first, the Mojang
names only as mock fallbacks) and `tools/tests/core/core_smoke.js` asserts it.

Registry additions the modules made inside their prefixes, now binding (names and shapes):
- **4.1 `pne_hive`**: also `v` (int schema), `hv` (runtime string: dawn day, the day's tactic evidence, `pid:lastSeen` for
  the dawn player count, the outcome-species ring, the load epoch) and `prev` (an unreadable saved state kept as is, never
  overwritten; `/pne hive prev drop` discards it). `base` IntArrays are `[3 x EMA*1e6, count, lruRank]`: HIVE stores
  `save().base[i].v` exactly as returned and hands it back (CompoundTag loses key order; the rank keeps eviction exact).
- **4.4 mob data**: HIVE `pne_gi` (the genome's own id plus `.epoch`, at most 40 characters; lineage credit and
  conversions link on it; `pne_gp` = the carrier's `pne_gi`); HIVE mob tags `pne_sct1`..`pne_sct3`, `pne_flk`,
  `pne_lux0`..`pne_lux2`, `pne_wk` (the tier and eligibility tags light aversion selects on); VISUAL display tags
  `pne_gv<k>` and the transient `pne_graft_chk` (orphan sweep), host tag `pne_vis_apex`.
- **4.6**: teams `pne_clade_<c>_named`; bridge folder file `sidecar.lock.guard` (the sidecar's OS-level single-instance
  lock; while it is held Windows refuses to rename or delete the folder, so stop the sidecar before an update).
- **3.2** `pneResTell`: false when the pillar is off, no tell asset exists, or the ledger cannot make it audible (even 0.3
  of its volume would break the level-jump limit or the bus ceiling); HIVE then drops Silent.
- **3.3 HIVE**: startup listeners return on a client level; the join listener clears `pne_fresh` for a mob loaded from
  disk; tells and silent visits are charged but never skipped (a visit or tell that does not fit makes the mob audible);
  the L8 tell plays for every survival player within 12 blocks (1.4; it was the nearest only); `pneHiveNear` is a table
  read (O(1)); FLK never steers (1.4: `HiveInfo.flk` feeds the reinforcement placement of 3.2.1) and SCT steering runs only
  with config `debug` 1; the graft index is `min(4, floor(5 e_PRJ))`;
  `outcome()` enforces the 12 HP per-encounter cap, so HIVE passes the raw k_mercy-weighted sum.
- **3.5 ORACLE** and 6.3: `/pne oracle log on` only sends the caller a one-time confirmation link (60 s, shown only to that
  player); `/pne oracle log confirm <code>` by the same player is the only thing that sets `pne_log` = 1 (`/execute as`
  cannot enable someone else's logging). `pneOraSnap` returns the shared snapshot by reference (read-only);
  `pneOraVerdict` returns a copy. A verdict's age counts from the tick the telemetry it answers was written.
- **3.7 GA-CORE**: `R` is logged once per dream slice; `save().log` is a bounded tail (at most 45,000 characters), so
  `replay(previousSave, tail)` works only when the tail overlaps the older snapshot, and `events(st, afterSeq)` / `seq(st)`
  give HIVE the event strings; `replay` accepts a `java.lang.String`, an array or a Java List (`rbad` 1 on an unparseable
  line, `rskip` counts events already applied, `rn` counts a P and its J as one step); the queue is FIFO; a full-pool
  dream is 107 slices; `load()` (15-27 ms once; it also rebuilds the sharing cache and the mid-dream data) runs in
  `ServerEvents.loaded` or on the first tick, outside the budget.
- **5**: pools are keyed `'<slug>.<cls>'` (for example `'tell.a'`, `'whisper.amb'`); attenuation 128 for L6 and L7;
  whisper files sit near -38.5 (amb) and -32.2 (near) LUFS, so the director uses the catalog's `lufs`, never -28; for
  files too short for an in-file rise the catalog's `mmax` is the onset step; reserve = the last 2 variants of each
  director pool (none for tells, transitions or beds); beds carry 4 s equal-power baked fades.
- **6.3**: `/pne oracle log confirm <code>` (the caller only), `/pne hive prev [drop]` (admin).
- **7.2**: HIVE runs its silent pass first, then GA work before the mob samples; outcomes use the odd ticks after the
  breed/dream slot (two while the outcome queue is over half full); the pool save is incremental, one step per free save
  slot (superseded in 1.4: the earlier one-call save that claimed a whole tick, the I9 exception, is removed); the leave drain is boosted to 128 records while a newborn waits on them. VISUAL: every tick a scan of
  8 host records (one `graftSync` token per 2 records); the sweep phases run at `t % 200` = 106, 108 and 110 (even ticks
  only); a summon draws 2 x `visApply`.

## Changes in 1.3 (integration round 2: lead decisions)

- **Dream alignment gate** (TDD 3.3.3, 6.3; 9.4 `ga-core-dream-align`): decided to keep the binding `insertDreamed`
  eligibility rule (a dream prediction never displaces a well-measured entry: the surrogate-exploitation mitigation of TDD
  7.1) and read the gate as "live dream alignment ≥ 0.5 within the 6000-spawn phase" (measured from a fresh pool: 0.542
  at 6000 spawns, 0.461 at 3000; the dream still has to add ≥ 0.05 at both points, and at the end of the post-shift
  phase, where the re-adaptation reaches 0.463 against 0.387 without the dream: the 0.5 level is a first-phase figure,
  and the adaptation after a tactic shift is covered by `ga-core-adaptation`). Relaxing the rule would have reached about 0.535 at
  1,200 evaluations but removes that mitigation and changes every golden. GA-CORE's `sweep_steady.js` reports PASS when
  the 6000-spawn alignment reaches 0.5 (FAIL below it), instead of exit 77; until that change lands the suite still
  SKIPs and `--milestone M3` stays NOT MET. (Landed in 1.4: the suite gates as decided, with no SKIP branch left.)
- **AmbientSounds bed regions** (section 5, TDD 6.1 M2, 2.3 L1): not shipped. A client-side region cannot follow the
  pacing state, comfort or the ledger (I5); the director's positional segments are the L1 bed. The stereo beds stay
  local build output of the pipeline; the M2 in-game row about regions is dropped.
- **Cost keys** (7.3): `outcome` 0.33 (HIVE's measurement) and `steer` 1.0 (explicit placeholder until spark) join
  `PNE_CORE_COST`.
- **I10 and harness timeouts** (Appendix A rule 12): a harness may end its own child on timeout through the child's
  handle; `no_kill.py` now scans all of `tools/**` and `oracle/**` and fails `subprocess.run(timeout=...)` outside the
  listed harness files.
- **F37 test infrastructure**: the shared mocks have the in-game shape (KubeJS names only; Mojang names under
  `opts.mojangNames`), `kjs-lint` fails unguarded hidden names in new scripts, and the strict pack runs are suites that
  M2, M3 and M5 require.
- **`global.pneOnHive`** (3.3, 4.5, 6.2): 1 only with `on_hive` 1 and the hive runtime loaded, mirrored once every server
  script has loaded; the degradation suite asserts the queues stay empty without it, and gained the broken variants and
  the `pne_hive_events.js` row's "no backstop, no projectile scaling" (section 8).
- **Milestone reporting**: `tools/suites/milestones.json` `pending` lists what no suite can decide; `--milestone`
  reports "MET for the automated criteria" while any is open (M1/M2: the comfort sign-off; M4: Spore EMF).
- Contract text: 3.1 names `source.getActual()`; the section 8 matrix row for `pne_hive_events.js` is back inside the
  table.

## Changes in 1.4 (polish)

- **Stereo beds out of the pack** (lead decision 1.3 enforced; section 5, 9.4): the spec keeps `bed_dry`, `bed_dread` and
  `bed_muffled` with `"ship": false`; `render.py` still builds all 144 assets into `tools/resonance/out/` (git-ignored), and
  `verify.py --install` verifies all of them but copies only the 126 shipped files. `overrides/kubejs/assets/pne` now holds
  129 files, 5.90 MB (126 OGGs, 5.87 MB; before: 147 files, 25.3 MB). Every shipped event has `amb: false` and
  `stream: false`. The committed manifest carries `not_shipped`, pinned by `tdd_pins.NOT_SHIPPED`; `gen_sounds_json.py`,
  `verify.py --committed`, `resonance-consistency`, `resonance-catalog-rhino`, `resonance-determinism` and `validate.py`
  each refuse a shipped bed. Every non-bed OGG, manifest entry, catalog event, `sounds.json` entry and the lang file are
  unchanged. `resonance-determinism` also proves the re-render writes nothing under `overrides/` or `tools/resonance/`.
- **Dream gate implemented** (decision 1.3; 9.4 `ga-core-dream-align`): `sweep_steady.js` fails below alignment 0.5 at the
  end of the 6000-spawn phase and below a dream gain of 0.05 at 3000, 6000 and 12000 spawns; the SKIP branch is gone
  (measured 0.542; gains 0.070 / 0.131 / 0.076). `ga-core-breed-bench` judges each timing gate on the best of up to 3
  fresh-JVM trials (20 s / 40 s pauses; every trial must pass the state check), gates every incremental save step against
  `gaSavePart` (the key HIVE charges; it had been gated against `gaSave`), has no proposed-value fallback any more, and
  checks its gate wiring before the trials (`run.py gates`). No cost key changed.
- **Incremental save and load epoch adopted by HIVE** (3.7, 4.1, 7.2, 7.3): the 6000-tick, dawn, switch-off and
  `prev drop` saves use `saveBegin`/`savePart`/`saveEnd`, one step per free save slot, and store byte for byte what the
  one-call save stores (`hive-node` on the mocks, `hive-nbt-size` with real `CompoundTag`s and NbtIo at the maximum state);
  the one-call save runs only at server stop. **The I9 save exception is removed**: at the maximum state the start
  measures 0.37-0.38 ms p50 against its 0.52 charge and the heaviest piece 0.27-0.28 against 0.4 (hive-rhino-bench, also
  in the lead's run); the GA steps measured 0.18-0.29 ms p95 against 0.4 in GA-CORE's runs (ga-core-breed-bench; see the
  timing note below for the lead's run); `PNE_HIVE_SAVE_WAIT`, `PNE_HIVE_SAVE_DEFER` and the rule that the
  save claims the whole tick are gone. The salted load epoch (3.7) is declared on the first hive tick after every load; a
  load without a readable state makes a save due at once so the epoch is recorded. `/pne hive status` shows save restarts,
  a save in progress and the epoch.
- **L8 tells for every survival player within 12 blocks** (3.3): per (mob, player) cadence of 100 ticks through each
  player's own ledger; Silent is dropped only when no player within 12 blocks could be told. Resolves the 1.3 open
  decision.
- **FLK flank placement of scripted reinforcements** (3.2.1, 3.3 `HiveInfo.flk`, 7.1): `pneHiveInfo` returns `flk`, and
  `pne_horror.js` moves a reinforcement beckon into the player's rear 120° arc, 24-40 blocks away, at block light ≤ 7 with
  probability FLK, only when today's chain would summon one at the dying mob (so the reinforcement rate is unchanged).
  **Natural and ambient spawns are not placed** (decided; Open decisions below keep only the record of why).
  New suite `director-flank`; `director-horror-rhino` places one flank in real Rhino.
- **Lint**: the F37 hidden-name rule no longer reports `getBlock(...).hasTag(...)` (KubeJS's own
  `BlockContainerJS.hasTag`; only `ItemStack.hasTag` is hidden, as `hasNBT`).
- **Milestones**: `director-flank` joins M2 and M3, `ga-core-save-parts` joins M3.
- **LICENSE attribution resolved**: see Appendix A rule 11 and the Open decisions.
- Known timing margins (no constant changed; spark decides in game, docs/TESTING.md M3): GA-CORE measured `outcome()`
  at a warm p95 of 0.278-0.295 ms against `outcome` 0.33 (about 15% headroom), but the lead's runs of this round (an idle
  machine, three runs of 3 fresh-JVM trials each) measured 0.445-0.458 in every trial and the samples save piece at 0.399-0.414
  against `gaSavePart` 0.4, so `ga-core-breed-bench` FAILs there, as it did in DIRECTOR's runs; HIVE's own bench in the
  same session reproduced its documented costs (outcome insert p50 0.22, save start 0.38, samples piece 0.28). The GA
  bench's timings therefore swing between two levels on unchanged inputs (Open decisions). `hive-rhino-bench`'s
  `saveFinish` case (the swap, charged 2 x `save` = 0.24) has twice measured about 0.27 under load while passing at
  0.10-0.14 when the machine is quiet.

## Open decisions (lead or user)

- **Comfort envelope rule for L5 bursts and L8 click trains (RESONANCE, TDD 2.3.2) - needs the user**: the whisper burst
  rhythm (0.65-1.44 at 2.0-3.5 Hz) and the tell click trains (1.62-1.81 at 8.5-10.9 Hz) break the rule as written; 30
  comfort assets (whisper.amb x12, whisper.near x12, tell.a x6) are measured and reported PENDING, and they play by
  default (comfort is on by default and both classes are comfort-eligible). Comfort is a hard constraint for the user,
  so the decision is theirs, after the comfort-mode listening step of docs/TESTING.md M2. If approved: an explicit
  exemption with its reason in TDD 2.3.2 (phrase-level gating and the L8 click train), `tdd_pins.PENDING_CE` becomes a
  graded EXEMPT table and verify.py counts them as passes. If not: RESONANCE re-renders whisper.amb/near with an
  inter-burst breath floor of about 0.5 of burst level and a slower tell click train. Either way DIRECTOR's
  `ledger_sim.js` applies the same rule and uses the catalog's `mmax` as the onset step where V15 does not apply (tell.a
  v01 and v04, whisper.near v06). M1 and M2 report "MET for the automated criteria" until then.
- **Spore EMF (VISUAL, TDD 6.1 M4 / 6.2 / 3.5.2) - deferred**: no `.jem` ships. Which file names EMF loads for each Spore
  layer, and whether a scale-only `.jem` keeps Spore's geometry, can only be seen in game: export 2-3 Spore models with
  EMF, compare names and part trees with `python tools/visual/emf_spore_parts.py --instance "<instance>" --summary`
  (docs/TESTING.md M4), then VISUAL authors scale-only `.jem` files. The ETF clade variants are generated locally at
  install time by `tools/visual/etf_variants_local.py` (tools/apply.py step 8) from the user's own jars; no art is in the
  repo. M4 is MET for its automated criteria only.
- **`hive_steer` and `horror_spawns` config keys**: not added (HIVE's SCT steering still keys off `debug`; pre-M2 parity
  for scripted spawns is DIRECTOR's call).
- **Grafted hosts are not pushed and do not stroll** (VISUAL): accepted by design; `vis_grafts` 0 is the off switch.
- **Load epoch after a crash (HIVE, 3.7, 4.1)**: a crash before the first overworld save that follows a load can still
  reuse the lost run's epoch, with probability about 1 in 1000, because KubeJS writes `server.persistentData` only in
  `serverLevelSaved` while a mob's `pne_gi` reaches disk whenever its chunk unloads. Closing it fully needs a write that
  reaches disk at the load (for example a JsonIO file of HIVE's own, or a forced world save), which 4.1 does not allow
  today. Accepted for now.


Resolved in 1.5:
- **GA bench timing levels - RESOLVED (lead decision 1.5)**: the bench measures `outcome()` and the samples save piece on
  two timing levels on unchanged inputs (p95 about 0.28 or about 0.45 ms). The token budget protects I9, so the constants charge
  the slower level with margin: `outcome` 0.6, `gaSavePart` 0.6, and `breed` 0.7 (cold ~0.58) to keep `outcome` below `breed`.
  Over-charging only slows GA bookkeeping; the in-game spark check of docs/TESTING.md M3 may lower them later.

Resolved in 1.4:
- **LICENSE attribution - RESOLVED (lead)**: `LICENSE` line 3 keeps its copyright line naming the account the public
  repository is published under. It is a standard licence attribution, not extra personal data; the exception is
  recorded in Appendix A rule 11 and covers that one line only.
- **L8 tells for every player within 12 blocks - RESOLVED** (3.3): implemented by HIVE.
- **FLK spawn placement - RESOLVED** (3.2.1): scripted reinforcement beckons are placed in the rear arc by
  `pne_horror.js`. Natural and ambient spawns are not placed: the hooks this pack uses can only deny a spawn (the
  `PositionCheck` gate, F18), discard a fresh newborn (the backstop) or must never cancel it (`spawned`, F19); the only
  pre-join hook where a script could move one, Forge `MobSpawnEvent$FinalizeSpawn` (F17), fires after the spawn rules,
  the light check, the gate and pacing were evaluated at the original position, so a move there would skip all of them.
  That is outside the pack's rules, so the TDD's "and ambient spawns" half is not implemented (TDD integration notes).
