# VISUAL (M4): the visual phenotype

Owner files: `overrides/kubejs/server_scripts/pne_visual.js` (priority 50), `overrides/kubejs/assets/minecraft/models/item/iron_axe.json`,
`overrides/kubejs/assets/pne/models/item/empty.json`, `tools/visual/**`, `tools/suites/visual.json`. Contract: `docs/IMPLEMENTATION.md`
3.6, 4.4, 4.6, 6.2, 7.2 and 7.3; design: `docs/TDD.md` 3.5.2 and 2.7.

Nothing here moves a camera or applies an effect, and nothing pulses or blinks.

## What runs in game

| Piece | Behaviour |
| --- | --- |
| Clade teams | `pne_clade_0`..`pne_clade_3`: `nametagVisibility never`, `collisionRule always`. **Since contract 1.5** they are made through the ServerScoreboard Java API only (IMPLEMENTATION.md F42; no console command names a team, rule 15 (b), because Recruits takes such commands over), on VISUAL's first tick after the start (`pneCoreStarted`), never on server load: `getPlayerTeam(n)`, else `addPlayerTeam(n)`; only the options that differ are written (`setNameTagVisibility`, `setCollisionRule` ALWAYS, `setAllowFriendlyFire(true)`, `setSeeFriendlyInvisibles(true)`: Recruits resets the last two at every start, so they are re-applied after every start; an old rule is repaired the same way), and every option is read back through `String()`. The teams count as ready only when all 8 pass; a failed setup retries after 20, 40, 80, 160, 320, 640, then every 1200 ticks, with one warning (`'visual', 'teams'`) at the third failure in a row; switching the pillar on resets the backoff. Membership: `addPlayerToTeam` / `removePlayerFromTeam(entry)` (they also reach unloaded stale entries); a join, leave or empty counts only when the read-back shows it, the record's team is the one read back, a join to a missing team clears the ready flag so the next tick recreates the teams. The hive's `pneCoreVisApply` puts each genome mob on the team of its clade (one entry per mob, as its UUID string); before the start applies and removals only queue. A mob that another mod or an operator put on a team of their own keeps it (the record's `foreign` flag; VISUAL never touches it). |
| Why `collisionRule always` | The TDD and contract 3.6 ask for `pushOtherTeams`, but in 1.20.1 that rule means "push only my own team" (vanilla bug MC-87984): `EntitySelector.pushableBy` (`m_20426_`, offsets 114-135) returns "allied" when either side has `PUSH_OTHER_TEAMS`, and a team-less player is never allied. With it, players and team members would stop pushing each other, and so would members of different clades and untracked mobs; entity cramming would stop counting across teams. `always` takes the same path as a mob with no team. |
| Named hosts | A team with `nametagVisibility never` also hides a CustomName (`LivingEntityRenderer.shouldShowName` returns false for NEVER; GeckoLib's `GeoEntityRenderer` does the same). Hosts that carry a name (an apex name, a name they already had such as EPCA's "What was once ...", or a name tag used later) therefore join the sibling team `pne_clade_<c>_named` (`nametagVisibility always`, same collision rule). The scan moves a host between the two teams when its name appears or goes. ETF rules list both names. Team names have no length limit in 1.20.1 (`TeamCommand` has no length check; `ClientboundSetPlayerTeamPacket` reads the name with the unbounded `readUtf()`). |
| Grafts | One `minecraft:item_display` passenger per host (a display, never a Mob, so no goal selector hands MOVE/LOOK to it), tagged `pne_graft` and `pne_gv<k>` (its variant), `persistentData.pne_host` = host UUID, deterministic UUID derived from the host UUID (a rejoining host finds its graft again without stored state). **Only while the host is engaged** (its target is a live player, the hive's meaning of "engaged"): summoned by the scan when the host targets a player, removed `PNE_VIS_LINGER` (40) ticks after it stops. Also: doom stage 4 or higher, never on the species in `PNE_VIS_NO_GRAFT`, never on a host that carries another passenger, and at most `floor(15% of the engaged hosts)` (TDD 3.5.2), so a fight needs 7 engaged genome mobs before one of them carries a graft. Four variants (`PNE_VIS_GRAFTS`: item, quaternion, translation, scale; scaled by the host's bounding-box width). A changed occupancy index removes the display at the apply and the scan summons the new variant; after a dimension change the graft left behind in the old dimension is removed before the new one is summoned (a UUID selector takes the first level that has the UUID). |
| The scan | Every tick, 8 host records round robin (200 hosts in 25 ticks), over a snapshot of the record keys: a record whose host is gone (removed, unloaded, dead) is dropped, so the engaged count is live; engagement is refreshed with `mob.getTarget()`; the team follows the name; the graft follows engagement. Records added during a cycle are first checked in the next one, after every older record, so a host's first grant never counts hosts that unloaded before it joined. Every host is revisited each cycle, so hosts that were refused (cap, another rider, budget) cannot starve one another; a failed summon is retried after 100 ticks, doubling per failure up to 800. At most 2 summons and 4 removals per tick. `pneVisApply` itself never summons: it sets team and name, adopts a graft that rode back with an engaged host, and removes a graft that is not wanted. |
| Cap trim | Sweep phase 2 re-checks up to 64 engaged records for removal, then, while grafts exceed the cap, removes grafts (hosts no longer engaged first, then the newest), at most 16 per sweep, and recounts. So the cap also holds when the engaged hive shrinks (hosts die, unload or lose their target). |
| Yaw sync | Every 3 ticks (`t % 3 === 0`), for each graft whose host's body yaw moved by 2 degrees or more: `execute as <graft> at @s run tp @s ~ ~ ~ <yaw> 0`. A same-level tp keeps a passenger riding (`Entity.teleportTo`: `moveTo` + `teleportPassengers`, no `unRide`) and only turns it; `data merge` would reload the display's NBT and re-send its item stack every time. The yaw comes from `getVisualRotationYInDegrees()` (the body yaw), falling back to `getYaw()`: KubeJS renames `Entity.getYRot` to `getYaw`, so `getYRot()` does not exist in game. The client applies a display's rotation as it arrives (`Display` has no `lerpTo` override; `Display.setYRot` recomputes the orientation from the current yaw and `DisplayRenderer` reads it with no partial-tick lerp), so a graft turns in 3-tick steps while its host turns smoothly; TDD 3.5.2 accepts a 2-5 tick sync. Smoother turning would need the transformation interpolation (`data merge ... interpolation_duration`, a much heavier command) or a per-tick sync. |
| Sweep | Starts at `t % 200 === 106` and runs one phase per **even** tick (106, 108, 110), so it never shares a tick with a breed (`t % 4 === 3`) or a dream slice (`t % 4 === 1`), contract 7.2. Each phase is charged `PNE_CORE_COST.sweep`; a refused take retries on the next even tick. 1) the `vis_grafts` switch and orphan grafts (displays with no vehicle: `tag` / `execute ... on vehicle on passengers` / `kill`); 2) the cap trim and an exact recount; 3) a stale-entry window over one team at a time (32 entries, 8 lookups): entries whose entity is not loaded leave the team. Vanilla already drops a destroyed entity's entry (`ServerLevel` `onDestroyed` -> `Scoreboard.entityRemoved`); an unloaded host gets its entry back when the hive re-applies on rejoin. `/pne visual sweep` runs a full pass (it summons nothing). |
| Apex readability | CustomName only on apex genomes (`info.apex`), naming the dominant counter-trait (largest expressed counter gene, ties to the lower index; TEL and MOR never name one): a translatable component `pne.vis.apex.<gene>` with the English fallback, for example "Hive Apex: Tracker". A name the mob already had is never overwritten. Hosts named here carry the tag `pne_vis_apex`; it goes when the name goes or a player renames the mob. A few dim trait particles (3, `normal` mode) every 40 ticks (0.5 Hz) for apex hosts within 32 blocks of a survival player. |
| Budget | `pneVisApply` charges `visApply` (name and team); when refused, the apply waits in VISUAL's queue (drained next tick with a copy of the info). Removals likewise, and removals drain even with the pillar off. The scan charges `graftSync` per 2 records; a summon (with its ride) draws `2 x visApply` more and waits for the next visit when refused; removing a graft of a host that is no longer engaged charges `graftSync`. Yaw sync and particles charge `graftSync` per command. |
| Pillar off | No new entries or grafts; the next sweep kills every graft, removes our apex names from every loaded host tagged `pne_vis_apex` (`execute as @e[tag=pne_vis_apex] run data remove entity @s CustomName`, then the tag), empties the eight teams and forgets the records. Later off sweeps keep removing grafts and apex names that load from disk. `pneVisRemove` still works. |
| `vis_grafts` 0 | Only when the core defines the key (lead request). Grafts only: the next sweep removes every graft (and keeps removing grafts that load from disk); teams, names and particles stay. Back to 1: hosts that should carry a graft get it from the scan while engaged. Without the key grafts are on. |
| After `/reload` | Module state starts fresh; one incremental pass over a snapshot of `server.getEntities()` (256 per even tick) re-adopts grafts that ride their hosts (variant from the `pne_gv<k>` tag), so yaw sync, the scan and the cap see them; an idle host's rediscovered graft goes after the linger. |

Commands: `/pne visual` (pillar switch, core), `/pne visual status` (anyone), `/pne visual sweep` (admin). `/pne status` carries a
`visual:` line: `teams N/8` (1.5: the teams passing the read-back right now; `?` when the scoreboard is unreadable,
`(setting up)` while not ready), team entries, grafts / cap on engaged of hosts, queues, swept. Reply texts say "clade"
where they used to say "team", and no reply pairs `team` with add/remove/join/leave; the core's `pneCoreTellraw` also
escapes `team` in the tellraw JSON (1.5, VIS-1), because Recruits scans the whole command text, a player's UUID included.

## What a passenger changes (and how VISUAL keeps it out of the hive's behaviour)

The TDD assumed a display passenger leaves the host's AI untouched. It does not hand control to the display, but every check of
`Entity.isVehicle()` sees it. From the 1.20.1 client jar (suite `visual-passenger-scan` recomputes these):

- goals whose `canUse()` is false for a vehicle: **LeapAtTargetGoal** and **PathfindToRaidGoal** (combat), and the idle strolls
  **RandomStrollGoal** (with `WaterAvoidingRandomStrollGoal`, `WaterAvoidingRandomFlyingGoal`, `RandomSwimmingGoal`,
  `GolemRandomStrollInVillageGoal`, `MoveBackToVillageGoal`), `StrollThroughVillageGoal` and `RunAroundLikeCrazyGoal`;
- `Entity.push(Entity)` (`m_7334_`) tests `isVehicle` for each side: a vehicle is not pushed by other entities (it still pushes them).

What VISUAL does about it:

| Effect | Handling |
| --- | --- |
| Idle strolls stop for a vehicle | Grafts exist only while the host targets a player (plus a 40-tick linger), so an idle host is never a vehicle. Without this, the hive's high-PRJ genomes (the graft index is `floor(5 x e_PRJ)`) would stand still whenever they had no target, which could bias the GA against PRJ. A host that has a target but cannot reach it may also stroll; that narrow case still sees the pause while grafted. |
| Combat goals and Spore's passenger code | `tools/visual/passenger_scan.py` reads the user's own EPCA and Spore jars and pairs every registered entity id with what its class, superclasses, inner classes and goal classes do. The 20 ids that fight differently with a passenger are `PNE_VIS_NO_GRAFT` and never get a graft (table below); the suite fails when a pack update adds one that is missing. |
| Not pushed while grafted | Accepted and reported: during a fight a grafted host (at most 15% of the engaged hive) is not moved by players or other mobs walking into it. `vis_grafts 0` (once the core defines it) removes grafts and keeps everything else, if that reads badly in play. |

| Jar | Entity ids | Fight differently with a passenger (never grafted) | Would stop idle strolling (never grafted while idle) |
| --- | --- | --- | --- |
| EPCA 0.147i | 64 | 1: `large_incomplete_form` (LeapAtTargetGoal) | 40 |
| Spore 2.2.0j | 104 | 19: `busser`, `brute`, `leaper`, `umarmed`, `ogre`, `kraken` (carriers and grabbers: `isVehicle`, `getFirstPassenger`, `ejectPassengers`, `positionRider`, Spore's `TransportInfected` / `PhayerGrabAndDropTargets` goals), `hevoker_arm` (positions riders), and `bairn`, `brot`, `inf_player`, `inquisitor`, `jagd`, `lacerator`, `leviathan`, `plagued`, `saugling`, `sieger`, `stalker`, `wendigo` (leap goals) | 39 |

The idle column counts only goals the mod registers itself; goals inherited from vanilla superclasses are not scanned, which is
why VISUAL gates every graft on engagement instead of keeping an idle list.

## KubeJS renames (affects other modules too)

KubeJS puts `@RemapForJS` on some `@Shadow` methods of its mixins, and Mixin copies those annotations onto the Minecraft method
(the F8 mechanism), so scripts see the method only under the KubeJS name. Suite `visual-kjs-renames` reads all 35 renames from
the KubeJS 2001.6.5 jar and proves the effect in the instance's Rhino jar (a class with `@RemapForJS("getTime") getGameTime()`:
`typeof x.getGameTime` is `undefined`, `x.getTime()` works). The ones that matter here: `Level.getGameTime` -> `getTime`,
`Level.dimension` -> `getDimensionKey`, `Entity.getYRot` -> `getYaw`, `getXRot` -> `getPitch`, `getUUID` -> `getUuid`,
`getStringUUID` -> `getStringUuid`, `hurt` -> `attack`, `getType` -> `getEntityType`, `isAlliedTo` -> `isOnSameTeam`,
`DamageSource.getMsgId` -> `getType`, `DamageSource.getEntity` -> `getActual`, `getDirectEntity` -> `getImmediate`,
`MinecraftServer.isDedicatedServer` -> `isDedicated`, `ItemStack.getTag/setTag/hasTag` -> `getNbt/setNbt/hasNBT`. `pne_visual.js`
uses none of them (`Mob.getTarget()`, `getPassengers()`, `hasCustomName()` keep their Mojang names); the suite prints the calls it
finds in other scripts as notes for the lead.

## Local-only ETF variants (install step)

EPCA's and Spore's art is all rights reserved, so the repository ships no texture of theirs and no ETF properties that would point
at missing files. `tools/visual/etf_variants_local.py` generates the clade variants on the user's machine from the user's own jars,
for both mods by default:

```
python tools/visual/etf_variants_local.py --instance "<instance>"            # writes <instance>/kubejs/assets/{epca,spore}/optifine/random/entity/
python tools/visual/etf_variants_local.py --instance "<instance>" --list     # dry run
python tools/visual/etf_variants_local.py --instance "<instance>" --clean    # removes exactly what it wrote (pne_etf_variants.json per folder)
```

- `--namespace all` (default), `epca` or `spore`; `--jar` and `--out` need a single namespace. A namespace whose jar is missing is
  skipped with a note.
- Output only inside the instance or the system temp folder; the tool refuses the repository. Files it did not make are never
  overwritten (unless `--force`); files from an earlier run that are no longer produced are removed.
- ETF 7.2.4 syntax, confirmed in the jar's bytecode (and re-checked by the `visual-etf-local` suite when the jar is present):
  properties `teams.N` / `team.N` (`TeamProperty.getPropertyIds()` = `teams`, `team`; the value is `Team.getName()`, matched as a
  space-separated list), `skins.N` / `textures.N`; the OPTIFINE directory maps `<ns>:textures/entity/x.png` to
  `<ns>:optifine/random/entity/x.png`; variant N of `x.png` is `xN.png`, or `x.N.png` when the whole id matches `\D+\d+\.png`
  (`ETFUtils2.addVariantNumberSuffix`, so `infested_slime_size0.png` -> `infested_slime_size0.2.png`, `kraken/kraken_t1.png` ->
  `kraken/kraken_t1.2.png`). The team property is not spawn-locked, so a mob that joins its team after it first rendered still switches.
- Rules: clade c -> variant file c + 2; rule 5 is the unconditional default (the original texture). Skipped: effect layers
  (`_glow`, `_afterimage`, `_blink`, `_e`), projectiles and props, textures whose variant names would collide, and on Spore the
  glowing eye layers (`eyes/`, kept as the mod made them so eyes stay readable in the dark), light and pulse overlays
  (`*_light*`, `hindie_light/`, `howitzer_lights/`, `*pulsation*`) and `...round` shells.
- Each clade keeps every pixel's alpha, shifts hue by at most 25 degrees and adds a faint deterministic vein pattern: ashen
  (desaturated), rust, bile, abyssal (darker). Static textures only: no `_e` emissive layer, no blink, no `.mcmeta`.
- Measured on the user's jars (writing to `%TEMP%`, cleaned afterwards): EPCA 0.147i 70 textures -> 350 files (13 skipped) in
  2.3-6 s; Spore 2.2.0j 240 textures -> 1200 files (122 skipped, 34 MB) in 55 s (pure Python, no imaging library).
- Spore uses vanilla renderers, where ETF applies natively; EPCA (GeckoLib) is supported by code-path analysis only and needs the
  in-game check.

Lead request: run `python tools/visual/etf_variants_local.py --instance "<instance>"` (both namespaces) from `tools/apply.py` after
the overrides are copied, and add the same command with `--clean` to the uninstall notes.

## EMF for Spore (open M4 item: notes and tooling only)

Spore uses vanilla EntityModels (no GeckoLib), so EMF can animate it; EPCA (GeckoLib) cannot be rescaled. What is known offline:

- `tools/visual/emf_spore_parts.py --instance "<instance>" --summary` reads the user's Spore jar and lists every model layer
  (`ModelLayerLocation`, for example `spore:bairnmodel#main`) with its part names from `addOrReplaceChild` (SRG `m_171599_`), and which
  renderer uses which layer and textures. On Spore 2.2.0j: 238 layers, 88 renderers, every layer with its part tree.
- EMF 3.3.9's string constants show the lookup roots `<ns>:emf/cem/<name>` and `optifine/cem/modded/<ns>/<name>` plus automated
  fallbacks, so the report lists `assets/spore/emf/cem/<layer>.jem` and `assets/minecraft/optifine/cem/modded/spore/<layer>.jem` as
  candidates only.

Not known offline, so no `.jem` ships yet: which of those names EMF actually loads for each Spore layer, and whether a `.jem` that
only scales existing parts (with `attach`) keeps Spore's geometry. Next step in game: use EMF's model export for two or three Spore
mobs, confirm the file name and part tree against the report, then author original `.jem` files that only scale existing parts (TDD
3.5.2: visual scale at most +-15%, for example `"body.sx": "1 + clamp((max_health - 20)/100, -0.15, 0.15)"`), never Spore's geometry
or textures.

## Tests (`python tools/run_tests.py --only visual`)

| Suite | Covers |
| --- | --- |
| `visual-node` / `visual-rhino` | `tools/visual/test_visual.js` on `tools/visual/vis_prelude.js` (a command interpreter, scoreboard, passengers, targets, levels and dimension changes on top of `kjs_mocks.js`), in Node and in the instance's Rhino jar: 242 assertions (1.5: no command and no scoreboard write before the start; applies and removals only queued before it; all team writes on the first tick; the options Recruits resets repaired after a restart; the backoff 20, 40 ... 1200 with one warning on the third failure; options that do not stick not trusted; a setup with 7 of 8 teams not accepted; a team deleted while ready recreated; joins and leaves counted only when read back, the stale sweep counting only read-back removals, an off sweep whose leaves do not stick not counted clean; an unreadable scoreboard never throwing; no console command containing `team`; no reply pairing `team` with add/remove/join/leave; `teams N/8`; the status replies for a UUID containing `add`. Before: teams incl. `collisionRule always` and repair of an old rule; grafts only on engaged hosts, the linger, re-engagement, non-player targets; the cap over the live engaged hive, after deaths and after a mass unload; fair retries behind hosts with other riders; failed-summon backoff; summon tokens; yaw cadence and the `getYaw` fallback; sweep phases on even ticks only; apex names and the `pne_vis_apex` tag, name removal after the pillar switch for a host unloaded at the time; name tags moving hosts to the `_named` team; particles; queues; rejoin engaged and idle; rediscovery; dimensions; no-graft species; variant swaps; `vis_grafts`; exact counters; no camera, effect or collision command) |
| `visual-json` | `iron_axe.json` = the vanilla model from the client jar plus one override `custom_model_data` = `PNE_CORE_AXE_CMD` (read from the core) -> `pne:item/empty`; the empty model renders nothing; the graft items have item models in their jars; repo ETF properties have no broken references |
| `visual-art-check` | no PNG under `overrides/` is EPCA or Spore art or derived from it (policy list `tools/visual/original_art.json`; comparison with the user's jars: alpha mask plus luminance or HSV-value correlation; self-test flags a generated EPCA variant) |
| `visual-etf-local` | the generator on synthetic EPCA and Spore jars, output only under `PNE_TMP` (346 checks, incl. Spore naming, Spore skips, `--namespace all` and `--clean` of both) |
| `visual-emf-tools` | the EMF extractor on classes compiled with JDK 17 and on the real Spore jar |
| `visual-passenger-scan` | the passenger scanner on classes compiled with JDK 17; on the real jars, `PNE_VIS_NO_GRAFT` covers every combat-sensitive id and lists only registered ids; on the client jar, the vanilla goal lists and that `Entity.push(Entity)` tests `isVehicle` |
| `visual-kjs-renames` | the KubeJS jar's `@RemapForJS` renames equal the table; the Rhino probe; `pne_visual.js` calls no hidden name |
| `visual-rhino-bench` | script-side costs in Rhino (command execution excluded); fails if one scan token covers more than `graftSync`, and (1.5) if a full apply exceeds `visApply` |
| `visual-scoreboard-api` | (1.5) `tools/visual/scoreboard_api.py`: the ServerScoreboard descriptors in the SRG client jar (18/18), their names through the Rhino fork's MinecraftRemapper by declaring class (19/19), no KubeJS mixin or rename on them, and `pne_visual.js` run in the real Rhino jar against the real `Scoreboard`, `PlayerTeam` and `Team` enum classes (`ScoreboardApiProbe.java`, `scoreboard_real_prelude.js`, `scoreboard_real.js`), including the missing-team recreation path |

## Measured script-side costs (Rhino, mock world, 200 engaged hosts, 30 grafts, 250 entries; min of 5 trials)

apply no-op 6-12 us; full apply (name, team, graft checks) 45-46 us in 1.4, **17-19 us since 1.5** (one scoreboard fetch and
at most two reads per apply; the graft UUID, an FNV-1a hash of about 33 us, is computed once per record and only when needed,
kept as the record's `gu`); yaw sync 4.0 us per graft; scan 5.4-5.8 us per record (8
records per tick: 43-46 us per tick, charged 4 x `graftSync` = 0.08 ms); sweep phase 1 under 1 us with commands stubbed; phase 2
(trim check of 64 engaged records, recount of 200) 170-175 us; phase 3 60-65 us; apex particle pass 52.5 us; full
`/pne visual sweep` 1.85-1.95 ms (admin command only; it re-checks every record). Command execution (Brigadier parse and run,
selector scans) comes on top and needs spark in game; mock objects are plain JS, so in-game Java calls add to these figures.

## In-game checks

1. ETF on GeckoLib EPCA: after the install step, `/team join pne_clade_1 <uuid of an EPCA mob>` changes its texture to the rust
   variant within a few seconds; `/team leave` restores it. If it does not, the fallback is names, particles and grafts only. Same
   check on a Spore mob (vanilla renderer; expected to work). Recruits lets a player's `team join`/`team leave` run but takes over
   any command holding `team` and `add`: pick a mob whose UUID does not contain `add`.
2. Spore hosts with PRC hold the axe with `CustomModelData:7301` and no axe is visible; EPCA hosts show nothing either.
3. A fight with 7 or more engaged genome mobs at doom stage 4+: grafts appear on at most 15% of them within about a second of
   them targeting you, sit on the host's back, and turn with the host's body in 3-tick steps (expected; the graft does not turn as
   smoothly as the body). The hosts still chase and attack normally.
4. A grafted host that loses its target drops its graft within about 3-4 s; idle hosts never carry one and keep wandering.
5. Players and parasites push each other as without the pack (clade teams use `collisionRule always`); a grafted host is not
   pushed while it carries its graft (expected, vanilla `Entity.push`). Decide whether that reads well, else request `vis_grafts` 0.
6. Spore carriers and grabbers (Busser, Brute, Umarmer, Ogre, Leaper) and leaping mobs never carry a graft and still grab, carry
   and leap.
7. No orphan displays after 2 h of play, including after grafted mobs go through a portal: `execute if entity
   @e[type=minecraft:item_display,tag=pne_graft]` returns at most the number of grafted hosts nearby; `/pne visual status` shows the
   counts (grafts never exceed the cap after a sweep).
8. Apex name visible only when looking at the mob; nametags of other parasites never shown; "What was once <name>" forms keep their
   name; a parasite named with a name tag shows its name within a second or two.
9. Team side effects: no parasite infighting change; EPCA infection and conversion still work for team members.
10. `/pne visual off` removes every graft and every "Hive Apex" name within 10 s and empties the teams, also for apex mobs in chunks
    loaded later; `/pne visual on` restores them as mobs rejoin.
11. spark: the visual work stays in the noise (target: the scan, sweep phases and yaw sync together well under 0.3 ms per tick,
    including command execution).
12. (1.5) The clade teams with Recruits installed: docs/TESTING.md M4 "Clade teams" (`teams 8/8` right after joining, the 8
    teams in `/team list`, no `pne_` Recruits faction, friendly fire restored after a restart, plain chat text, `/pne visual
    sweep` and the help lines not swallowed).

## Uninstall

`/pne visual off` (the next sweep removes grafts, team entries and apex names), then for chunks loaded later:
`kill @e[type=minecraft:item_display,tag=pne_graft]`, `execute as @e[tag=pne_vis_apex] run data remove entity @s CustomName`,
`tag @e[tag=pne_vis_apex] remove pne_vis_apex`; and `python tools/visual/etf_variants_local.py --instance "<instance>" --clean`
(both namespaces). The teams: `/pne visual off` empties them. With Recruits installed `team remove ...` does not work (Recruits
takes over any command holding `team` and `remove`, from a player or the console), so the 8 empty teams stay, harmlessly;
without Recruits, `team remove pne_clade_0` ... `pne_clade_3` and the `_named` siblings.
