# Testing

Nothing in this pack could be run in-game while it was being built: the build environment's
sandbox blocks the local sockets Minecraft needs. Every script passed syntax checks and every ID
was checked against the mod jars, but runtime behaviour has to be confirmed in the game.

Use a **throwaway world with cheats on**. Never test in a world you care about.

## In-game checklist

- **LOGS FIRST**: logs/kubejs/startup.log 'Loaded 8/8 KubeJS startup scripts ... 0 errors'; logs/kubejs/server.log 'Loaded 13/13 KubeJS server scripts ... 0 errors' (with The Hive Remembers files, 1.5 included; 5/5 and 6/6 without them) and a '[minecraft:entity_type] Found N tags, added ...' line; no '[pne' warning lines anywhere; logs/hordes.log loads hordes:default and hordes:drowned.
- **Setup**: make a THROWAWAY world with cheats on. Never test in 'New World'. Several tests need a separate world, as noted.
- **Difficulty first (1.5)**: the pack now follows Options > Difficulty (Peaceful, Easy, Normal, Hard; see "Difficulty profiles and the Recruits-safe start" below). The numbers in this list are the **Hard** profile's (vanilla Hard, or '/pne config diff_profile 4'); on the other profiles night buffs, bursts, beckons and hordes are gentler as that section lists. The login line and '/pne difficulty' show which profile is active.
- **Comfort (creative)**: '/effect give @s epca:fear 20', '/effect give @s minecraft:nausea 10' and '/effect give @s spore:madness 30' should not apply (no icon, no camera jitter). '/effect give @s minecraft:blindness 10' applies. After '/summon spore:bloater ~6 ~ ~', blindness is refused. '/effect give @s minecraft:blindness 45000' (900000 ticks) is refused. '/summon spore:nuke ~ ~ ~' spawns nothing and the screen does not shake. Holding right-click with spore:cleaver does not spin the camera. Options should show FOV Effects 0%, Darkness Pulsing 0% and View Bobbing ON.
- **BadMobs**: '/summon spore:gargoyle', 'spore:grober', 'spore:howitzer' and 'spore:hohlfresser' should each vanish at once, while '/summon spore:inf_human' still works.
- **Alliance (survival, stand about 15 blocks away)**: '/summon epca:infested_zombie' next to '/summon spore:inf_human'. They should ignore each other, not keep switching targets, and both come for you. Give a Spore mob '/effect give @e[type=spore:inf_human,limit=1,sort=nearest] epca:coth 60 2': it must never convert.
- Doom clock (FRESH separate world, before any setstage, because setstage pins the stage): '/epca_evolution status' shows stage 0. '/time add 600000' (day 25). Within about 60 s, status shows 1800 points (stage 3), a new stage chat line appears in the lore wording, and server.log shows '[pne_horror] doom clock: day 25, overworld evolution points raised to 1800'. Then '/epca_evolution setpoints 5000' and wait a minute: the points stay at 5000. Expect The Hordes to treat the horde as overdue and fire it that night and on following nights; that is expected after a time jump.
- **Night aggression**: '/time set 18000', then summon epca:infested_zombie and spore:inf_human. Within 5 s, '/data get entity @e[type=epca:infested_zombie,limit=1,sort=nearest] ActiveEffects' lists speed and strength, and inf_human shows speed only.
- **Gore and Mobs Inside**: kill about 10 epca:infested_zombie with a sword. You should see red block particles and hear the slam sound each time, get living_flesh or a Mozzie about 65% of the time ('/tag @e[type=epca:living_flesh_size0,limit=1,sort=nearest] list' shows pne_burst), and get no more bursts once 8 or more flesh are within 24 blocks. '/kill @e[type=epca:infested_zombie]' produces no particles or bursts.
- **Reinforcements (separate world)**: '/epca_evolution setstage 10'. Melee kills on grass should never produce a beckon (you are within 24 blocks). Bow kills 30 or more blocks away on natural grass or stone should occasionally ring a bell and produce epca:stage_i_beckon. Targets on planks or inside a brick room should never produce one.
- **COTH inventory (survival, stage 3 or higher)**: '/effect give @s epca:coth 60 0', then die to a parasite with a full inventory. The Corpse holds everything and no form spawns. Repeat with '/effect give @s epca:coth 60 2': a Medium Incomplete Form named 'What was once <name>' appears and the Corpse still holds everything. The line '[pne_hive_rules] restored a player drop list' should normally NOT appear; if it does, the primary fix failed and the backstop caught it.
- **Mycelium death**: '/effect give @s spore:mycelium_ef 60', then die in survival. A Spore Infected Player wearing a copy of your gear rises, and the Corpse still holds all items. Killing the Infected Player drops no copied gear.
- **Death line**: die to any parasite, for example '/summon spore:brute'. Exactly one dark-red italic line appears after the vanilla death message.
- **Horde and Hive Night**: at night, '/hordes start @s 6000' (or '/hordes start 6000 hordes:drowned' in an ocean). When the first wave spawns about 75 blocks out, expect one dark-red Hive Night line and the beckon stinger, then a heartbeat every 15 s. '/tag @s list' shows pne_horde, and 'execute if entity @e[tag=pne_horde_mob]' returns the mob count. No scripted beckons appear during the horde. Command hordes test the mob mix, not the scaled horde size.
- **Leftover cleanup**: after the horde ends, the pne_horde tag is gone. Run '/time set 1000' and walk more than 24 blocks from any survivors. Within about 10 s they vanish with no drops, bursts or conversions, and server.log shows '[pne_horde_cull] removed N horde leftovers after dawn'.
- **Bed rule**: '/time set 181000' (night of day 7), then use a bed. Sleep is refused with a dark action-bar line and no screen or camera effect. '/time set 157000' (night of day 6): the bed works unless a horde is running or overdue. On the Peaceful profile (1.5) the day-7 refusal is off and no horde runs (see the Peaceful checks below).
- **Spore griefing**: '/summon spore:griefer' next to a stone wall and let it explode. It deals damage but breaks no blocks.
- **Lore and quests**: '/epca_evolution setstage 5' shows the new stage-5 chat line; set the stage back afterwards. A Stage I Beckon egg used below stage 3 shows 'Erosion is below stage 3...' on the action bar. The effect list reads 'Call of the Hive'. The 'Hive Nights' chapter appears after 'Counter-Infection'. Looking at and killing spore:inf_human, spore:mound, epca:reshape_longarms and cave_dweller:cave_dweller completes the matching quests.
- **Lost Cities (new world made with the Cities button)**: haunted building1-3 and other buildings spawn EPCA or Spore infected with no armour or weapons, no Speed IV or Regeneration IV, and at most about 1.5x base health.
- **Existing 'New World'**: log in and any old Fear or Madness icon is gone; new chunks have no cities; a bed on diamond blocks does not teleport you. The doom clock starts from day 0.

## After the first launch

Spore, The Hordes, Cave Dweller, Lost Cities and Patchouli write their full config files on first
launch. Check that the pre-seeded values survived Forge's correction pass:

- Spore (config/sporeconfig.toml, COMMON, rewritten with every key on first launch): check that [Effects] 'Should the effect overlays be active ?' = false, that ["Targeting Tasks"] 'Mobs Not Targeted' still ends with "epca:", that [Mobs.Griefer] and [Mobs.Chemist] 'Should explosion break blocks ?' = false, and that the three ["Griefing Parameters"] hardness values are 0. Forge resets wrong-typed or rejected values, so re-apply any that reverted. Also check that no Spore conversion list (for example inf_human_conv) contains an epca: entry, and leave inf_player = true (dead Mycelium-infected players rise, which matches the user's 'corpses burst' request).
- Spore: optional user decision whether to add spore:brute, spore:ogre, spore:busser and spore:inf_contruct to BadMobs [spore] (they throw world blocks as falling blocks, a possible Dynamic Trees crash path). If hardness 0 leaves calamities toothless, raise the calamity hardness to 1.
- EPCA-side alliance: config/E-PCA/epca_main_config.toml should still read parasiteModPeacefulPairs=["epca:spore"], parasiteConversionModImmunityWhitelist=["spore"], allowCothLevel4=true and defaultExtraDifficulty="expert". 'New World' stays EPCA Normal (data/epca_world_difficulty.dat difficulty=1). Moving it to Expert means an offline NBT edit to 2 with the world closed and a backup made first; that is the user's call.
- BadMobs: config/badmobs-common.toml must still show the six spore.* entries with all four flags false after Forge's correction pass.
- The Hordes: config/hordes-common.toml values unchanged (hordeSpawnDays 7, variation 0, hordeEventByPlayerTime false, interval 2000, duration 6000, start 18000, infection off). config/hordes/ is generated by the mod, and the kubejs/data tables take priority over it. In logs/hordes.log, look for the hordes:default and hordes:drowned table loads with no 'Failed to parse table'. In config/hordes-client.toml (generated): optionally set eventNotifyMode to 1 (chat) or 2 (action bar) instead of a title, and set playerInfectionVisuals=false (moot while infection is off). hordeEventTintsSky only tints fog and moon, with no motion; leave it unless the user objects. If hordeSpawnInterval is ever raised above about 10000, raise PNE_H_HORDE_STALE in pne_horror.js to match.
- Cave Dweller (SERVER config, per world: saves/<world>/serverconfig/cave_dweller-server.toml): it has no comfort toggles. Read allow_surface_spawn. If it is true, change the 'It Knows You Are Looking' quest text ('lives in the deep caves' / 'hunts only in the dark') to 'hunts in the dark places'. To apply any tuning to every new world, copy the tuned file into defaultconfigs/.
- Lost Cities: config/lostcities/common.toml needs no change (optimizedHeightmap already false). For 'New World', confirm serverconfig/lostcities-server.toml kept selectedProfile="" and specialBedBlock="minecraft:barrier" (check latest.log for a rejection). New Lost Cities worlds are made with the 'Cities' button on Create World.
- Lost Souls: after creating a Lost Cities world, confirm saves/<world>/serverconfig/lostsouls-server.toml was copied from defaultconfigs (parasite mob list, randomEffects=[], bonuses 1.0-1.5 and 1.0-1.2). Check latest.log for no codec error on lostsouls:buildings/zombiesonly.
- Patchouli: no settings required (library only). Check that it loads without errors. The nuclearcraft:patchouli_book recipe that failed before Patchouli was installed should now parse; the KubeJS server.log failed-recipe count should drop by one.
- KubeJS: confirm logs/kubejs/startup.log reads 'Loaded 8/8 KubeJS startup scripts ... with 0 errors' and logs/kubejs/server.log reads 'Loaded 13/13 KubeJS server scripts ... with 0 errors' (5/5 and 6/6 before The Hive Remembers; 7/7 startup scripts before 1.5 added pne_diff_events.js). Confirm there are no lines starting '[pne', '[pne_alliance]', '[pne_hive_rules] could not', '[pne_horde_rules] could not', '[pne_horror] ... failed' or '[pne_horde_cull] pass failed', and no tag 'missing references' error for pne:hive, pne:beckon, pne:flesh, pne:spore, pne:spore_basic or pne:beckon_ground in latest.log.
- User decisions still open (from the comfort track): whether epca:ender_erosion's pulsing edge vignette is acceptable (if not, add it to PNE_COMFORT_ALWAYS_DENY); whether Spore-sourced Blindness should stay denied (currently denied within 40 blocks of any spore mob); whether being carried by grabbing Spore mobs (Umarmer, Ogre and similar) counts as camera movement (if so, block them in BadMobs after checking their IDs); and tell the user that the Spore Infected Cleaver's hold-right-click ability is disabled (melee still works).

## The Hive Remembers: in-game checks

These checks cover what the offline suites cannot: the real game, the real mods and your ears. The automated side
runs with `python tools/run_tests.py` (every suite) and `python tools/run_tests.py --milestone M0` up to `M5` (the exit
criteria in docs/IMPLEMENTATION.md section 10; a milestone with open user decisions or deferred scope reports "MET for
the automated criteria" and lists them as PENDING). Each item below is a step and the result to expect, grouped by the
milestone it signs off. Items marked **F37** check, in the real game, call sites that were broken offline by a method
name KubeJS hides (see "Known blockers").

Before you start:
- Use a **throwaway world with cheats on**, in single player unless a step says otherwise. Keep spark installed for the
  timing checks (`/spark profiler start`, play, `/spark profiler stop`, then read the KubeJS share of the tick).
- Read logs/kubejs/startup.log and logs/kubejs/server.log first: 0 errors, and no `[pne] ... failed`,
  `disabled until the next reload`, `[pne_hive_events] ... failed` or `[pne_res_gate] spawn gate failed` line. A clean log
  is not enough on its own: several call sites catch their errors without logging, so the F37 items below check the
  behaviour itself.
- `/pne status` lists the four pillars (`resonance=on hive=on oracle=on visual=on`), the tick-budget peak (at most
  `2.50/2.50 ms`) and one line per module. `/pne` alone prints the command list.
- **Check Options > Difficulty** (1.5). The pack follows it: Peaceful, Easy, Normal and Hard each have their own profile
  (docs/IMPLEMENTATION.md 3.8); Hard is exactly the 1.4 behaviour. The first-test world that felt "aggressively hard" was
  saved on Normal, and 1.4 ignored the setting entirely. The login line and `/pne difficulty` now show which profile is
  active; `/pne config diff_profile 2` pins Easy whatever the menu says (`0` follows the menu again).

### Switching things off if something misbehaves

Every pillar has a switch for the current world (operator, or the single-player owner; the console counts as operator):

| Command | What stops | What keeps working |
| --- | --- | --- |
| `/pne resonance off` | the pacing director, every Resonance layer and L8 tell | the sound ledger still filters the pack's existing horror sounds; the startup spawn gate still protects players in mercy or grace |
| `/pne hive off` | breeding, new genomes, telemetry, light aversion, the backstop, the governor; silent mobs become audible | mobs keep the modifiers they have (health is never clipped); the state is saved while it is off (within about 2 s) |
| `/pne oracle off` | the file bridge (one last telemetry.json with `want_oracle: false`), verdicts, logging | telemetry for the director and the hive |
| `/pne visual off` | new team entries and grafts; every graft and every "Hive Apex" name goes within 10 s | nothing else depends on it |

`/pne <pillar> on` switches it back. Finer switches (operator): `/pne config spawn_gate 0` (natural-spawn gate),
`/pne config spawn_backstop 0` (the hive's spawn discard), `/pne config light_aversion 0`, `/pne config vis_grafts 0`
(grafts off, teams and names kept), `/pne config debug 1` (extra logging; also enables SCT steering). Per player, no
operator needed: `/pne comfort on|off`, `/pne resonance self off`, `/pne resonance whispers|throb|approach|stingers off`,
`/pne oracle log off`, `/pne oracle purge`. The optional Oracle sidecar stops with `stop_oracle.cmd` in
`<instance>/local/pne_oracle` (it only writes stop.flag; never end it by PID or from Task Manager).

### Known blockers (found offline; fixed in module code, to confirm in game)

KubeJS hides some Minecraft method names in game (contract F37: `Level.getGameTime()` is only `getTime()`,
`DamageSource.getMsgId()`/`getEntity()` only `getType()`/`getActual()`, `Entity.getYRot()` only `getYaw()`,
`MinecraftServer.isDedicatedServer()` only `isDedicated()`). The offline pass found these call sites using the hidden
names; each module has moved them to the KubeJS name with the Mojang name only as a mock fallback, and the suites
`pack-smoke-strict` / `pack-degradation-strict` (the whole pack with only the names visible in game) and the kjs-lint
hidden-name rule now guard them. Confirm the behaviour in game with the **F37** items:
- **DIRECTOR, `startup_scripts/pne_res_gate.js`**: the natural-spawn gate read the game time with `getGameTime()`, returned
  before its check and never denied a spawn near a player in mercy or grace (M2, "Safety floor").
- **HIVE, `startup_scripts/pne_hive_events.js`**: the damage and leave listeners read `getGameTime()`, `getMsgId()` and
  `getEntity()`; after 20 failures every listener disabled itself, including the join listener that sets `pne_fresh`,
  so the backstop, damage telemetry and projectile scaling stopped (M3, "Backstop").
- ORACLE (`pne_oracle_bridge.js`: `getYRot`, `getEntity`, `isDedicatedServer`) and HIVE (`pne_hive.js`: `getYRot`) lost
  one telemetry field each (yaw, damage attribution) without any log line (M0, look_rate).
- **1.5, found in the first in-game test (Recruits)**: every command the 1.4 scripts issued in `ServerEvents.loaded` (25
  per start: the seed read and VISUAL's team setup) failed on a Recruits NullPointerException, so the hive ran the whole
  session with seed 0, the clade teams were never created, and after the start Recruits turned `team add pne_clade_N`
  into factions and swallowed every team join. Fixed by the Recruits-safe start (docs/IMPLEMENTATION.md Appendix A rule
  15); confirm with "Difficulty profiles and the Recruits-safe start" below and M4 "Clade teams".

### Difficulty profiles and the Recruits-safe start (contract 1.5; signs off M0, with the module items under M2-M4)

Test a profile in a **fresh world**: parasites that already exist keep the EPCA stats they got when they first joined
(EPCA applies them once), and New World (2) from the first test also keeps two empty Recruits factions (`pne_clade_2`,
`pne_clade_3`) that nothing cleans up. Discard that world rather than clean it.

Start and logs
- latest.log after a world start: no `FactionEvents.onTypeCommandEvent` NullPointerException (1.4 logged 25 of them per
  start), no `[pne_core] seed read before start` warning, no `[pne] hive.load failed` line.
- The log shows one `[pne_core] difficulty: vanilla X, profile Y (follows vanilla)` line on the first tick.
- The login chat line `[PNE] Difficulty ... (pack profile ..., EPCA tier ...). /pne difficulty shows the details.`
  appears once per player and not again at the next login (unless the profile or the overworld tier changed meanwhile).
- `/team list` shows the 8 teams `pne_clade_0`..`pne_clade_3` and `pne_clade_0_named`..`pne_clade_3_named`, and the
  Recruits faction list shows no `pne_` faction (M4 has the team details).
- The runtime names resolve: `getAllLevels()`, `Level.getDifficulty().getId()`, `getWorldData().getDifficulty().getId()`,
  `isHardcore()`, EPCA's `WorldDifficultyData.get/getDifficulty/setDifficulty` and `DifficultyLevel.fromId`, and the
  scoreboard team enums. A failure shows as `EPCA tier unavailable` with one warning (`epca.api` or `epca.read`), a
  profile stuck at Hard, or the `[pne_visual] clade teams not ready` warning.

The profile and EPCA's tier
- `/pne difficulty` (anyone) prints 4 lines: the vanilla value and the profile (`follows vanilla` or pinned), the EPCA
  tier per dimension with its state (overworld Expert, `pack-managed`, on a default-button world at Hard), then the night,
  burst, beckon, doom, spawn, gene, Spore and horde numbers of the profile. `/pne status` has the line
  `difficulty: Easy (vanilla Easy, auto); EPCA overworld Normal (managed)` (with the real values). Without EPCA's classes
  both show `EPCA tier unavailable` and the log has one warning.
- Switching the difficulty in the pause menu gives exactly one gray chat line within about 2 s. On a default-button world
  Easy flips the overworld EPCA tier from Expert to Normal (the line ends `... use EPCA tier Normal (was Expert).`), and
  Hard flips it back.
- After a switch to Easy, `/summon epca:infested_zombie`, then
  `/data get entity @e[type=epca:infested_zombie,limit=1,sort=nearest] Attributes`: `minecraft:generic.max_health` has
  base 15 on Easy, against 22.5 on Normal or Hard (EPCA Expert x1.5).
- `/pne config diff_profile 2` pins Easy whatever the pause menu says; `/pne config diff_profile 0` follows the menu
  again. `/pne difficulty epca master` (operator) sets Master everywhere and marks each dimension deliberate (the pack
  leaves them alone); `/pne difficulty epca auto` hands them back, and the next sync writes the profile's tier.
- A world created with the EPCA button on Normal while vanilla is Hard: the log reports once that the overworld tier was
  chosen outside the pack, and the pack never writes it.
- Dedicated server, new world on Hard: latest.log has no `EPCA tier Normal in minecraft:overworld was chosen outside the
  pack` warning, `/pne difficulty` shows the overworld Normal (pack-managed), and switching to Easy and back to Hard, or
  `/pne difficulty epca auto` followed by Hard, never writes Expert (a dedicated server's EPCA baseline is Normal).

Damage and hordes
- On Easy, a Spore mob's hit on a player lands at about 70% of the Hard value (on Peaceful about 50%). EPCA hits are not
  scaled by the script (vanilla's difficulty scales them).
- The day-7 Hordes wave is about 9 mobs on Easy and 12 on Normal (15 on Hard).
- Peaceful, single player: on day 7 at midnight no horde starts and no Hordes start message appears; latest.log shows one
  Hordes start attempt for day 7 per player, not one per tick; no `the Hordes schedule could not be moved` warning. A bed
  works on the evening of day 7, after midnight on day 7, and on nights 8, 13 and 14. No player gets the `pne_horde` tag
  (pne_hive_rules.js tags only a horde that starts), and no `pne_horde_mob` appears.
- Peaceful persistence: on day 8 save and quit, rejoin, then sleep at dusk: the bed works (the moved schedule was saved).
- Leaving Peaceful: switch to Easy on day 18. No catch-up horde happens; the next horde is on day 21 with about 9 mobs
  (the size of a first horde at x0.6).

### M0: core, telemetry, genome core

- `/pne status` after you log in shows `pd=kjs` (F8/F9: persistent data is KubeJS's own tag).
- Your pseudonym survives death: with the Oracle bridge on, note the `pid` of your entry in
  `<instance>/local/pne_oracle/telemetry.json`, die, respawn, and check the same pid is there.
- `/pne status` shows `telemetry for N player(s)` with N = survival players online; the log has no `entity query failed`
  warning (level.getEntitiesWithin with Minecraft's AABB works).
- spark: the oracle bridge's per-player telemetry (its tick handler at the player slots) stays within
  `PNE_CORE_COST.playerTel` (0.35 ms; 0.26-0.29 ms measured in the mock world).
- **F37** look_rate follows your view: with the Oracle bridge on, stand still and note the 4th number (look_rate) of your
  entry's `f` array in `<instance>/local/pne_oracle/telemetry.json`; turn on the spot for a few seconds and read it again:
  it changes (it stays at 0 when the yaw read is broken).

### M1: Resonance assets

- `/playsound pne:res.tell.a.v01 hostile @s` is audible and, with subtitles on, shows "Something skitters nearby". Also
  `/playsound pne:res.whisper.amb.v01 voice @s` and `/playsound pne:res.hollow.dry.v01 ambient @s`.
- No stereo bed ships (lead decision 1.3, enforced in contract 1.4): `/playsound pne:res.hollow.bed_dry.v01 ambient @s`
  plays nothing (the client log reports an unknown sound event), while `/playsound pne:res.hollow.dry.v01 ambient @s` and
  `/playsound pne:res.hollow.t_dry_muffled.v01 ambient @s` still play the mono L1 director segments.
- Optional (only if you want it): `python tools/resonance/declip_local.py --instance "<instance>" --write`, then enable
  `pne_spore_declipped` in Options > Resource Packs. The 84 rewritten Spore sounds stop crackling and are not noticeably
  quieter (at most 3 LU); the other 121 clipped files are unchanged.

### M2: pacing director and sound ledger

Levels and cost
- spark: the director (pne_resonance.js) averages at most 0.2 ms per tick; one player's step against
  `PNE_CORE_COST.director` (0.15 ms), one ledger decision against `emit` (0.04 ms).
- One L_eff capture within +-3 dB: a whisper at `^ ^1 ^-6`, volume 0.55, attenuation 32, and a director layer at
  `~ ~12 ~`, attenuation 128, against the V10 reference (-12 dB ambiguous / -6 dB near in 300-3400 Hz relative to the bed).
- Bell and beckon levels: beckon stage 1 at volume 1.5 with the 0.69 trim reaches only about 16.6 blocks, so at the
  pack's beckon distance (no player within 24 blocks) the ledger refuses it as inaudible.
- L2 undertone A/B (TDD M5b): variants at f0 17.0-19.5 Hz against 8 Hz and 30 Hz; playback pitch stays at 1.00 +-0.03.
- The L7 stinger (preloaded) starts instantly the first time. No Resonance file streams (the stereo beds do not ship,
  lead decision 1.3), so there is no streamed-file check.

Safety floor (mercy and grace)
- **F37** Natural spawns near a player in mercy: in survival at night, bring yourself to 30% health or less (3 hearts or
  fewer with 20 max health) and stay there 10 minutes without killing anything. Count the natural EPCA or Spore mobs
  that appear within 48 blocks (`execute if entity @e[type=#pne:hive,distance=..48]` and `#pne:spore` every minute,
  ignoring mobs that walked in from farther away): about 0. Repeat at full health for comparison: several.
- `/pne config spawn_gate 0` lets natural spawns through again; `/pne config spawn_gate 1` gates again.
- Near a player in RELEASE, mercy or grace (tag `pne_pace_soft`), the night Speed/Strength buff on parasites runs out.

Comfort (the user signs this off by ear)
- Default comfort mode: no stingers and no scream, heartbeat only (Hive Night heartbeat at least 70 s apart), the slam at
  volume 0.35, a softer approach with no payoff, the slow beats at 1.34-1.5 Hz (worst in-file rise 5.90 LU per 2 s).
- Pending decision, listen specifically: the whisper burst rhythm and the L8 tell click trains (the comfort envelope rule
  flags them; see TDD "Integration notes"), and the re-rendered whispers (amb v01/v02/v09, near v02/v04/v05/v09).
- Whispers sit behind you at ear level (`rotated ~ 0`, `^ ^1 ^-6`); no sound source ever moves.
- PANIC drain: beds and layers end on their baked fades; a stopsound never sounds like a hard cut.

Pacing and audio behaviour
- PANIC at low health (30% or less, normal mode): no bed or whispers during PANIC, no heartbeat or stinger; the first
  10 s of RELEASE are silent; after that only the muffled bed, in runs with silences between.
- Mercy or grace while calm: the muffled bed plays in short runs separated by clear silences for the 120 s grace.
- PANIC stinger (comfort off, Oracle sidecar running): at most one per PANIC, only once a parasite is actually in view.
  With no sidecar: no PANIC stinger at all.
- Hive Night (`/hordes start @s 6000` at night): heartbeat at least 35 s apart in normal mode and never over a slam or
  L2/L3; the scream only for players with comfort off, rotated ~ 0, 24 blocks behind.
- Without the Oracle (no sidecar, or `/pne oracle off`): `/pne resonance status` shows `sensing probe` (it may show
  `probe-stale` briefly with many players), and pacing never drops to CALM next to a parasite because a probe was refused.
- pne_horror.js features are live for the first time: gore particles and the slam on parasite deaths, Mobs Inside bursts,
  and reinforcement beckons only when no player is within 24 blocks and every player within 48 is CALM or UNEASE. Burst
  and beckon counts stay acceptable at the CALM multiplier (x1.25).
- Parasite volume trims: EPCA and Spore sounds are quieter but keep their subtitles and variants (222 events re-listed
  with `replace: true`; `python tools/validate.py --instance "<instance>"` checks they all exist).
- Feature sanity (Oracle telemetry): `hostileSeen` turns true when a visible EPCA or Spore mob is within 24 blocks
  (line of sight on GeckoLib mobs); n16/n32 count only #pne:hive / #pne:spore mobs; light drops at night and in rain; a
  few modded EPCA/Spore weapons show a sensible held-item class (many fall back to `other`).

Difficulty profiles (1.5; Options > Difficulty, or `/pne config diff_profile 1`..`4`)
- Easy: at night, EPCA parasites within 32 blocks get Speed I and never Strength, and Spore basic infected get nothing
  (`/data get entity @e[type=epca:infested_zombie,limit=1,sort=nearest] ActiveEffects`).
- Normal: Strength I on EPCA at night appears only once the overworld doom stage is at least 1 (the day-6 floor); Speed I
  on `#pne:spore_basic` within 48 blocks.
- `/pne resonance status` in CALM shows spawn 1.25 on Hard, 1.10 on Normal, 1.00 on Easy and 0.00 on Peaceful, and follows
  a pause-menu change within about 2 s. On Peaceful no parasites spawn naturally near the player (`pne_m` 0).
- Easy: about 1 in 3 host kills bursts, with 1-2 flesh, and at most 4 burst products within 24 blocks. Reinforcement
  beckons appear only from overworld stage 4 (the day-32 floor), at most one per 400 ticks.
- The doom clock on Easy and Normal raises the same floors on the same days as Hard (400 points on day 6, and so on:
  lead decision L1). On Peaceful the points never rise (no `/epca_evolution setpoints` line in the log).
- Hard plays exactly as before: the same night buffs, burst rates and beckon rates. The only new output is the core's
  login line.
- latest.log after loading a world and after `/reload`: no NullPointerException from FactionEvents caused by
  pne_horror.js or pne_resonance.js commands, and the first-run audio notice arrives once after joining.

Commands and notice
- `/pne comfort`, `/pne audio`, `/pne resonance whispers|throb|approach|stingers|self on|off` work for a non-op
  single-player owner; `/pne resonance status` shows state, tier, e, theta and m.
- The first-run notice (5 lines) appears once per player and not again after relog or death.
- No AmbientSounds bed regions ship (lead decision, IMPLEMENTATION.md section 5): the bed you hear is the director's
  positional mono dry/dread/muffled/t_* segments, which follow pacing, comfort and the ledger, and nothing in the client
  log mentions a missing `pne:res.hollow.bed_*` sound.

### M3: the Hive Genome

Load, save, cost
- The KubeJS server log shows no error from pne_hive_core.js (priority 95) or pne_hive.js, and pne_hive_core.js loads first.
- `/pne status` shows `hive=on` and a `hive: pool ...` line; `/pne hive status` works for a non-op single-player owner
  and shows pool, generation, governor, sigma, queue, T_est and the queue sizes.
- Persistence: note pool, gen, gov and sigma in `/pne hive status`, restart the server: identical values;
  `<world>/kubejs_persistent_data.nbt` holds `pne_hive` with about 10 tags, every IntArray under `pne_hive.base` holds
  5 ints, and every string stays under 60,000 bytes (an NBT viewer shows it).
- Switch-off saves: note the values and the `saves` counter in `/pne hive status`, `/pne hive off` (or
  `/pne config on_hive 0`): within about 2 s the saves counter rises while the hive stays off (the off ticks complete the
  incremental save). Restart, `/pne hive on`: pool, gen and gov unchanged, and the hive resumes normally.
- Save cadence: `/pne hive status` shows `saves N`; N rises about every 5 minutes and after each dawn, and the line never
  shows `(restarted ...)` in normal play (`one in progress` may show for a second or two).
- Load epoch across `/reload`: note `epoch` in `/pne hive status`, run `/reload`, read it again: it rose by between 1 and
  1024 (not necessarily 1). A parasite that spawns afterwards has KubeJS persistent data `pne_gi` ending in
  `.<new epoch>` (`/data get entity <mob> KubeJSPersistentData.pne_gi`).
- Load epoch across a restart: stop the server cleanly and start it again: the epoch is higher and pool, generation and
  governor are unchanged.
- Fresh world: in a newly created world, within a few seconds of the first start `/pne hive status` shows `saves 1` or
  more (a load with no stored state makes a save due at once); a `/reload` after that shows a higher epoch.
- World load with a full pool (48 entries, 400 samples), ideally mid-dream: the one-off load (15-27 ms) causes no
  "Can't keep up"; in spark the first breed tick and the first dream slice after the restart are near 0.1 ms and 0.4 ms.
- After a dawn with 42 or more samples the dream finishes (107 slices, about 21 s) and "dreaming" leaves `/pne hive status`.
- spark over 15 minutes including a Hive Night: the hive's KubeJS time stays near or below 2.5 ms per tick and the
  `/pne status` budget peak is at most 2.50. The pool save is incremental (the old I9 save exception is gone): on the
  save tick (`t % 6000 == 6`, and after each dawn) spark shows no hive spike, only pieces of at most about 0.4 ms spread
  over about 2 s (the start is charged 0.52 ms, each piece 0.4 ms; offline warm p95: the samples piece 0.28-0.29 ms,
  `saveBegin` 0.18-0.21 ms). A tick where several parasites die at once (explosion, horde) stays at or below 3 ms.
- spark during Hive Night: the GA outcome insert stays within `PNE_CORE_COST.outcome` 0.33 ms. Offline its warm p95 is
  0.28-0.29 ms in some runs and about 0.45 ms in others (docs/IMPLEMENTATION.md Open decisions), so this is the constant
  most likely to need raising: report the spark value. Do the same for the incremental save's samples piece against
  `gaSavePart` 0.4 ms.
- `/reload` with genome mobs nearby: no errors, and `tracked` in `/pne hive status` recovers within a few seconds.

Difficulty profiles and the first-tick load (1.5)
- After the world loads, `/pne hive status` shows a pool (not `not loaded yet`) within about a second, and the status
  line ends with `diff x1.00` on Hard, `x0.85` on Normal, `x0.65` on Easy (`x0.00` on Peaceful). latest.log has no
  `[pne_core] seed read before start` and no `[pne] hive.load failed` line.
- Load epoch: note `epoch` in `/pne hive status`, run `/reload`, then quit to title and reopen the world: the epoch rises
  each time, and pool and gen are kept.
- Easy (`/pne config diff_profile 2`): spawn several parasites at once (for example 5 x `/summon epca:infested_zombie`,
  so one drain call expresses them together). On each, `/data get entity <uuid> Attributes` shows the `pne.gene.HPX`
  amount at most 0.30 and `pne.gene.DMG` at most 0.24. On Hard (`/pne config diff_profile 4`) newly spawned ones stay
  at most 0.5 and 0.4, as in 1.4. Undo with `/pne config diff_profile 0`.
- Peaceful pin (`/pne config diff_profile 1`): a newly spawned parasite gets a genome (`pne_g`) but no `pne.gene.*`
  attribute modifier, is not silent and has no axe. Undo with `/pne config diff_profile 0`.
- Light aversion on Easy: standing at block light 10, nearby LUX-tier-0 parasites get Slowness (particles hidden,
  nothing on your screen). On Hard nothing happens until block light 11.
- Governor on Easy: after one hive-caused death, `governor steps` in `/pne hive status` rises by 1. On Normal and Hard
  it rises only after the second hive death within 20 minutes.
- Profile switch between ticks: switch Options > Difficulty from Hard to Easy, wait 2 s, then reload a chunk that has
  genome parasites in it: the rejoined mobs' transient `pne.gene.*` modifiers drop to the Easy amounts, and the permanent
  HPX modifier stays.
- spark during a chunk-load burst of parasites: the hive's drain stays within its budget share, with no tick spike above
  3 ms of KubeJS work.

Expression and phenotype
- Modifiers survive a chunk reload: note a genome mob's max health (`/data get entity <mob> Attributes`), leave and come
  back: unchanged, health neither clipped nor re-healed, the `pne.gene.*` max-health modifier present once.
- Light aversion: at block light 11 or more with hive mobs within 48 blocks, every 5 s they get Slowness I (Weakness I
  only on species with base attack damage 6 or more); LUX tier-3 mobs are unaffected; you get no effect. Note whether
  EPCA/Spore mobs are immune to these effects. `/pne config light_aversion 0` stops it.
- SIL with two players (multiplayer or LAN): two survival players both within 12 blocks of a silent-gene parasite that
  has not attacked both hear its L8 tell (subtitle) about every 5 s; a creative player nearby hears none; the ash
  particles still show. When one of the two steps beyond 12 blocks while the other stays, the mob keeps Silent only while
  someone within 12 blocks can be told; within 3 blocks of anyone, or after its first attack, it becomes audible for good.
- SIL: a silent-gene mob approaching shows ash particles and plays the L8 tell every 5 s within 12 blocks; it becomes
  audible within 3 blocks or after its first attack. With `/pne resonance off` silent mobs become audible, and
  `/pne hive off` unsilences every tracked silent mob. In a big fight where the budget runs out, silent mobs become
  audible rather than silent without tells.
- PRC: no axe is visible on EPCA hosts or on Spore hosts (CustomModelData 7301, empty model); PRC mobs disable shields at
  about 25-35% per hit; the axe never drops on death.
- PRJ: arrows do visibly less damage to high-PRJ hive mobs than melee does.
- Steering (F33): by default `/pne hive status` says `SCT steering off (debug 0: SCT tag-only; FLK is never steered)`.
  With `/pne config debug 1`, SCT mobs that lost you path to where you were 3 s earlier (`steering on (N moves)`); if it
  says `unavailable (tags only)` (one log warning), SCT stays tag-only. Measure Mob#getNavigation().moveTo in spark and
  report it so the steer cost can be set. FLK mobs never get flank moves; FLK only places reinforcement beckons (below).

FLK flank placement of reinforcement beckons (pne_horror.js with the hive's FLK gene)
- Setup: a separate world, `/epca_evolution setstage 3` or higher, open natural ground (grass, dirt, stone), no light
  source near your feet (block light 7 or less). Genome mobs with FLK 0.5 or more carry the tag `pne_flk`
  (`/execute if entity @e[tag=pne_flk,distance=..32]`). Nothing here moves the camera or the player.
- Kill `pne_flk` mobs from MORE than 24 blocks away (a bow) until a reinforcement beckon appears (at most 9% per kill,
  at most one per 100 ticks). It stands 24-40 blocks behind you, relative to where you face, and its bell comes from
  behind. Seeing any flank at all also confirms that the test command (an `execute ... if block ...` without `run`)
  returns 1 through runCommandSilent and that `block.hasTag('pne:beckon_ground')` works.
- Facing: repeat facing north, east, south and west, and once with the mob dying off to your side. The beckon is always
  behind where you face, never simply on the far side from the mob (this confirms `getYaw()` 0 = +Z in game).
- Rate unchanged: melee kills of `pne_flk` mobs (within 24 blocks) root no beckon anywhere, the same as mobs without the
  tag.
- Next to a torch (block light 8 or more at your feet), or with a mob without `pne_flk`, the beckon appears where the
  mob died, as before.
- A second player at low health (30% or less) or in respawn grace standing behind you: no beckon near them; it falls back
  to the dying mob's position.
- Terrain: at the edge of a dark forest the beckon may stand on the ground under the canopy, never on the leaves; behind
  a building with a roof it never stands under the roof; it never lands on planks, glass, a base floor, in water or
  inside a hill behind you (in those cases it falls back to the mob's position).
- spark: no chunk load and no measurable spike on the death tick of a flanking beckon (that the block reads 24-40 blocks
  away hit loaded chunks is inferred, not measured).

Backstop, conversions, deaths
- **F37** Backstop: note the `backstop` count in `/pne hive status`, die, respawn and, within the 120 s grace, start a
  wave next to you (`/hordes start @s 6000` at night): the wave's mobs within 48 blocks vanish and the `backstop` count is
  above the noted value. Saved parasites near a respawned player are NOT discarded when their chunk loads; EPCA phase
  spawns and conversions keep working (otherwise `/pne config spawn_backstop 0`); The Hordes logs no error.
- Backstop after respawn: die far from your spawn point, respawn, and let a Hordes wave or an EPCA phase spawn appear
  within 48 blocks in the first seconds: discarded. Saved parasites whose chunk loads near you are kept.
- Conversion order: after an EPCA infection converts a villager, or a form converts into another, the new mob has
  KubeJSPersistentData `pne_g`, `pne_gi` and `pne_gp`; for hive-to-hive conversions `pne_gp` is the carrier's `pne_gi`
  and `linked` goes up in `/pne hive status`. Also while pne_horde_cull.js discards a horde next to a player in mercy.
- Hive-caused deaths: two within 20 real minutes lower gov by x0.85 (`/pne hive status`). A parasite kill, an arrow
  from a parasite and a fall after a parasite hit count; the void and `/kill` do not; no kill credit for fall, void or
  kill deaths. An encounter where one mob deals more than 12 HP logs at most 12000000 in its I event (debug replay log).
- The global queues drain: during and after a big fight the damage and leave queue sizes in `/pne hive status` return to 0.
- Single player: walking around causes no errors or duplicated records from client-thread join/leave events; walking
  quickly back and forth across a chunk border near genome mobs (one of them silent) keeps `tracked` stable and the
  silent mob keeps its ash particles and tells.
- `/pne hive prev`: as a non-op it answers that operator rights are needed; as operator or the single-player owner it
  reports that no unreadable old state is kept.
- Hordes waves near a player in mercy or grace are handled only by the hive backstop; the director's multipliers act only
  on pne_horror.js's scripted spawns.

### M4: the visual phenotype

Clade teams (1.5: the ServerScoreboard Java API, made on the first tick after the start)
- Fresh world with Recruits installed: latest.log has no `FactionEvents.onTypeCommandEvent` NullPointerException, no
  `[pne_visual] clade teams not ready` warning and no `[pne_visual] refused a console command naming a scoreboard team`.
- Right after joining, `/pne visual status` starts with `visual: teams 8/8`. `/team list` shows `pne_clade_0`..`3` and
  `pne_clade_0_named`..`3_named`, and the Recruits faction list shows no `pne_` faction.
- Once genome mobs have spawned, `/team list pne_clade_<c>` lists mob UUIDs and the entries count in `/pne visual status`
  grows. A mob given a name tag moves to `pne_clade_<c>_named` within about 25 s and its name shows; when the name is
  removed (kill and respawn, or `data remove` as an operator) it moves back to `pne_clade_<c>`.
- Save and quit, then reload the same world: `/pne visual status` again shows `teams 8/8` (Recruits resets friendly fire
  and seeing invisibles at every start; VISUAL restores them on the first tick).
- `/pne visual status` and `/pne status` show `visual: teams 8/8, ...` in chat as plain text; the chat never shows an
  escape sequence such as a backslash-u. latest.log has no Recruits `team.notFound` reply and no new faction whose name
  starts with `{"text"`.
- `/pne visual sweep` (operator) replies `visual sweep cleared N orphan grafts or stale clade entries`, and the `/pne`
  help lists both visual lines (1.4's texts said "team" and would have been swallowed by Recruits).
- `/pne visual off`, then wait about 10 s: `/team list pne_clade_0` ... `_3_named` show no members. `/pne visual on`
  brings back `teams 8/8` and the entries as mobs are re-applied.
- In a fight with many genome mobs at stage 4 or higher, `/spark profiler --timeout 60` shows the pne_visual apply path
  well under the tick budget (the Rhino bench predicts about 17 us of script time per full apply before Java call costs).

Phenotype
- After the install step (tools/apply.py step 8 generates the clade variants from your own jars),
  `/team join pne_clade_1 <uuid of an EPCA mob>` switches it to the rust variant within seconds and `/team leave <uuid>`
  restores it; the same for a Spore mob. If GeckoLib EPCA does not switch, the fallback is names, particles and grafts.
  (Recruits lets a player's `team join` / `team leave` run, but takes over any command holding `team` and `add`: pick a
  mob whose UUID does not contain `add`.)
- No axe is visible on Spore mobs holding iron_axe with CustomModelData 7301, nor on EPCA hosts.
- Players and parasites push each other as without the pack (teams use `collisionRule always`).
- A grafted mob is not pushed while it carries its graft and does not stroll when idle (vanilla Entity.push and
  RandomStrollGoal skip vehicles). Decide whether that is acceptable; if not, `/pne config vis_grafts 0`.
- In a fight with 7 or more engaged genome mobs at doom stage 4+, grafts appear on at most 15% of them within about 1 s
  of them targeting you; a graft turns with its host's body in 3-tick steps and hosts chase and attack normally. A grafted
  mob that loses its target drops the graft within about 3-4 s; idle mobs never carry one.
- Spore Busser, Brute, Umarmer, Ogre and Leaper, and all leaping mobs, never carry a graft and still grab, carry and leap.
- EMF for Spore (deferred, no `.jem` ships yet): with EMF's model export (its config screen), export two or three Spore
  models (for example spore:inf_human, spore:knight and spore:leaper), then run
  `python tools/visual/emf_spore_parts.py --instance "<instance>" --summary` and compare its file names and part trees with
  the exported ones. Report which names EMF used; VISUAL then authors scale-only `.jem` files for those.
- No orphan displays after 2 h of play, including portal trips: `execute if entity @e[type=minecraft:item_display,tag=pne_graft]`
  stays at or below the grafted mobs nearby, and `/pne visual status` shows grafts at or below the cap.
- Apex names show only when you look at the mob; other parasites never show nametags; EPCA "What was once <name>" forms
  keep their names; a parasite named with a name tag shows its name within 1-2 s.
- Team membership changes no parasite infighting; EPCA infection and conversion still work for team members.
- `/pne visual off` removes every graft and every "Hive Apex" name within 10 s, including apex mobs in chunks loaded
  later, and empties the teams; `/pne visual on` restores them as mobs rejoin.
- Players and parasites still push each other (collision rule always), and the ETF clade texture variant appears on team
  members.
- spark: the visual scan, sweep phases and yaw sync together stay well under 0.3 ms per tick, commands included.

### M5: the Oracle

- 20/20 verdicts within 1 s: with launch_oracle.cmd running, `/pne oracle status` shows `sidecar answering (cpu_np, ...)`
  and the written/applied seq pair goes up by 1 per second for 20 seconds in a row.
- Staleness fallback: run stop_oracle.cmd (it writes stop.flag), or start `launch_oracle.cmd --exit-after 120`. Within
  about 3 s `/pne oracle status` shows `silent`, the director runs on heuristics (verdict fresh false), and the log shows
  no errors. Never stop the sidecar by PID.
- Logging opt-in affects only the caller: player A runs `/pne oracle log on`; nothing is logged yet and A gets a gold
  prompt with a green `[Yes, log my samples]` link. After A clicks it within 60 s only `logs/<pidA>-YYYYMMDD.ndjson`
  appears; clicking it again says it is not valid. An operator's `/execute as A run pne oracle log on` does not enable it
  (A only sees the prompt, the operator sees no code); the console and command blocks cannot enable it. A sees the login
  notice at every login, B does not. `/pne oracle log off` stops new lines at once.
- Purge: `/pne oracle purge` rotates the caller's pid (telemetry.json shows the new one); the running sidecar deletes the
  old pid's logs, and the `purge` list leaves telemetry.json once status.json lists the pid in `purged` (PURGE_PENDING
  while another program holds a log file open).
- spark over 30 min: p99 on bridge-write ticks (slot 0) under 50 ms (otherwise the bridge cadence has to move to 40
  ticks, which needs a code change: there is no switch yet).
- Missing bridge folder: stop the sidecar first (while it runs Windows refuses to rename local/pne_oracle, which is
  intended), rename the folder: `/pne oracle status` shows `bridge failing`, writes back off to one try per 30 s and no
  breaker trips; restoring the folder resumes the writes.
- Single instance: double-click launch_oracle.cmd twice quickly: the second window prints "Another Oracle sidecar is
  already running for this instance" and exits (code 3); the first keeps answering.
- Leftover stop flag: with no sidecar running, run stop_oracle.cmd, then launch_oracle.cmd: the console prints "removed a
  stop.flag left from an earlier stop request" and the sidecar keeps running.
- Dedicated server: the bridge is off by default (`dedicated server (config bridge_dedicated 0)`);
  `/pne config bridge_dedicated 1` turns it on.
- `/reload` gives a new boot_id: the sidecar console prints "game restarted or reloaded ... windows reset" and verdicts
  resume within about 2 s; after a death and respawn the player's verdict shows window_fill 1.
- telemetry.json holds v, boot_id, seq, tick, ts_ms, want_oracle and players[pid, f(31), dim, comfort, log, ev], and no
  UUID, name or x/z.

### Removing The Hive Remembers from a world

Display grafts never despawn and apex names persist, so clean up before removing the scripts:
- `/pne visual off`, wait 10 s, then `kill @e[type=minecraft:item_display,tag=pne_graft]`
- `execute as @e[tag=pne_vis_apex] run data remove entity @s CustomName` and `tag @e[tag=pne_vis_apex] remove pne_vis_apex`
  (repeat after visiting areas where apex mobs were saved)
- the clade teams: `/pne visual off` empties all 8 within about 10 s. With Recruits installed, `team remove pne_clade_0`
  and the rest do **not** work, from a player or from the console: Recruits takes over any command holding `team` and
  `remove` (it cancels it and runs its own faction-leave logic), so the 8 empty teams stay in the scoreboard, where they
  are harmless. Without Recruits: `team remove pne_clade_0` ... `team remove pne_clade_3` and `team remove
  pne_clade_0_named` ... `team remove pne_clade_3_named`
- `python tools/visual/etf_variants_local.py --instance "<instance>" --clean` (removes exactly the generated textures)
- run stop_oracle.cmd, then delete `<instance>/local/pne_oracle` if you do not want the sidecar or its logs
- genome mobs keep their modifiers (`pne.gene.*`); silent ones are unsilenced by `/pne hive off` before removal
