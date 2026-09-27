# Design

How the systems work and why each decision was made. Numbers come from the mods' own bytecode and
data files, which were read while building. Nothing here was measured in-game.

## Principles

1. **Parasites are the centerpiece.** Every added system feeds the parasites or feeds on them.
2. **Horror without motion.** The player who commissioned this dislikes nausea and screen movement,
   so dread comes from sound, pacing, scarcity, gore and darkness. Nothing moves the camera.
3. **Stable over maximal.** Every mod earns its place. Where a mod couldn't be verified as
   compatible, it wasn't added.
4. **Verify, don't assume.** IDs, config keys and command syntax were read from the jars, and an
   adversarial reviewer checked each subsystem.

## The doom clock

EPCA's erosion clock is the pacing spine, but its points come in far too slowly (+1 per parasite
kill; stage 4 alone needs 20,000). Left alone, a 100-day world barely escalates.

`pne_horror.js` reads the day every 1200 ticks with `time query day`, whose integer result is
remap-free. It raises the overworld's points to a floor that climbs through EPCA's hard-coded
thresholds, and it never lowers them:

| Day | Points | Stage |
|---|---|---|
| 6 | 400 | 1 |
| 12 | 800 | 2 |
| 20 | 1,800 | 3 |
| 32 | 20,000 | 4 |
| 48 | 200,000 | 5 |
| 62 | 5,000,000 | 6 |
| 76 | 25,000,000 | 7 |
| 88 | 500,000,000 | 8 |
| 96 | 1,000,000,000 | 9 |
| 100 | 1,800,000,000 | 10 |

It uses `epca_evolution setpoints <int> minecraft:overworld`. The numbers must be plain integers,
since the command takes an IntegerArgumentType from -100 to 2,100,000,000.

## Two strains, one enemy

EPCA and Spore are **allies**, not rivals. Mobs that fight each other aren't hunting the player,
and horror needs every hostile eye on you. The alliance holds at three layers:

- EPCA: `parasiteModPeacefulPairs = ["epca:spore"]`, and Spore is immune to EPCA conversion.
- Spore: `"epca:"` is in its *Mobs Not Targeted* list.
- `pne_alliance.js` cancels any `LivingChangeTargetEvent` between the two namespaces.

Spore's four block-manipulating mobs (Gargoyle, Groberfub, Howitzer, Hohlfresser) are blocked with
BadMobs, and their spawns are cancelled as a backstop. They crash alongside Dynamic Trees, and they'd
grief Create and Mekanism builds. Spore's explosions don't break blocks, and its calamity-tier
block-breaking hardness is 0.

## Nightly and weekly pressure

- **Night aggression.** Every 100 ticks from time 13000 to 23000, EPCA parasites within 48 blocks of
  a survival player get Speed I and Strength I. Spore's basic infected get Speed I only, because its
  evolved tiers already out-damage EPCA.
- **Hive Nights.** The Hordes runs every 7th day at 18000: three waves of 2000 ticks, 12 mobs scaling
  by 1.31x per horde up to 70. Its infection mode is off. The spawn table is replaced so the horde
  *is* parasites, keeping The Hordes' pursuit AI intact; converting mobs mid-march would lose that
  AI. Beds are refused for all of every 7th day. Leftover horde mobs more than 24 blocks from a
  player are culled at dawn.

## On every death

- **Gore.** Block particles (redstone and nether wart) and EPCA's slam sound, capped at 10 per second,
  and skipped for `/kill` and void deaths.
- **Death lines.** A player killed by a parasite gets one of 12 grim lines after the vanilla message.
- **Mobs Inside.** When one of 15 host types dies: 50% chance of 2-3 small living flesh (which EPCA
  merges upward), 15% chance of a Mozzie. At most 8 burst mobs within 24 blocks, 2 bursts per second;
  burst products never burst again.
- **Reinforcements.** From stage 3, each parasite death has a 2% chance, plus 1% per stage above 3,
  capped at 9%, to root a Stage I Beckon. It needs a player within 64 blocks but none within 24, and
  no beckon within 32. It only roots on natural ground (dirt, sand, stone, nylium), never on player
  builds. There's a 100-tick cooldown, and a low bell tolls when it roots.
- **Call of the Hive at death.** EPCA cancels drops for infected entities, so at COTH level I a player
  lost everything. COTH I is now cleared at death so items reach Corpse. At level II and above, EPCA
  spawns its own form (renamed "What was once *name*"), and a LivingDropsEvent safety net keeps
  the player's drops.

## Sound

Whispers play roughly every 4-5 in-game minutes at night, 8 blocks behind a random player at 0.6
volume, using EPCA's and Spore's own sounds. Hive Nights add a stinger, a heartbeat every 15 seconds
and distant screams. Sound only; no camera effect.

## Comfort

| Source | Treatment |
|---|---|
| Nausea (any source) | Denied for players (`pne_radiation_comfort.js`) |
| EPCA Fear | Denied. Its client handler jitters yaw and pitch every 2 ticks, and screenEffectScale doesn't affect it |
| Spore Madness | Denied (hallucination entities that inflict blindness and nausea) |
| Spore overlays (bile, corrosion, tar, mycelium) | Turned off in Spore's config. If that config is ever switched back on, the script still denies Bile, the only overlay that covers the centre of the screen; the others are edge vignettes |
| Blindness from Spore attacks (Bloater, Howler, Gorgon, Umarmer, Specter) | Denied while any Spore mob is within 40 blocks: the effect event carries no source, and 40 blocks covers the longest attack |
| Spore Infected Cleaver (right-click spins the camera 10° per tick) | Its right-click use is cancelled; melee hits still work |
| Spore nukes and burrowing Hohlfressers (camera shake) | Those entities are blocked from spawning |
| NuclearCraft stage-3 radiation blindness (12.5 hours) | Denied, identified by its 900000-tick duration |
| Alex's Caves screen shake, Watcher camera possession | Off in config |
| Create: New Age radiation nausea | Off in config |
| NuclearCraft anomaly and black-hole shaders | Off in config |
| Mob Dismemberment gibs pushing the player | Off in config |
| FOV effects, darkness pulse, distortion, damage tilt | 0 in options.txt |

Kept deliberately, because they darken or tint without moving anything: blindness from non-Spore
sources, EPCA Ender Erosion's pulsing purple edge vignette (it carries delayed damage, so denying it
would weaken Enderman parasites), and Spore Frostbite's vanilla frost vignette. Alex's Caves' nuke
flash is kept too. Radiation still damages you.

## What SRP had that this can't replicate

The original Forge Labs parasite packs run Scape and Run: Parasites on Minecraft 1.12.2. It can't
load on 1.20.1, and it's closed, all-rights-reserved work, so none of its code or art was copied.
Its *mechanics* were mapped instead:

| SRP feature | Here |
|---|---|
| Evolution phases and phase broadcasts | EPCA erosion stages, paced by the doom clock, with rewritten stage messages |
| Assimilation, walking heads, merging forms | EPCA, native |
| Buglins bursting from corpses | Mobs Inside |
| Reinforcement calls | Scripted Beckon reinforcements |
| Adapted and Pure elite tiers | Partly: Spore's evolved flesh constructs fill the role |
| Preeminent bombers, Ancient bosses | **Not replicated.** There are no suitable bodies, and faking them would mean griefing hacks |
| Horde nights | The Hordes, spawning parasites |
| Gibs | Mob Dismemberment |
| Haunted ruins | Lost Cities + Lost Souls |

## Rejected, and why

- **HBM's Nuclear Tech**, the radioactive mod Forge Labs used: both 1.20.1 ports are alpha, one
  with empty world generation.
- **Sculk Horde**: an alien aesthetic, and a second world-spreading infection competing with EPCA.
- **Sanity: Descent Into Madness, Dawn of the Flood**: forced screen distortion and camera animation.
- **Enhanced Visuals**: duplicates the installed blood overlay, and its blur and heartbeat each need
  disabling.
- **Sound Physics Remastered**: Dynamic Surroundings already does reverb, and only an alpha exists.
- **A parasite-themed Cave Dweller port**: its metadata claims one jar covers 1.20.1-1.20.6 and
  depends on a 1.21.1 NeoForge build, so it may not load. The original Cave Dweller is used instead.
