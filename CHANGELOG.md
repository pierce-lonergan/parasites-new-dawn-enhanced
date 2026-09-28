# Changelog

## Unreleased: The Hive Remembers (milestones M0-M5, tested offline, not yet run in game)

### Difficulty (contract 1.5, after the first in-game test)
- Difficulty now follows the vanilla setting (Peaceful/Easy/Normal/Hard profiles, EPCA tier synced on pack-default
  worlds). Hard plays exactly as before. Easy: Speed only at night within 32 blocks, a third of host kills burst,
  reinforcements from stage 4, gentler hive genes, Spore hits at 70%, day-7 hordes of about 9. Normal sits between.
  Peaceful: no night buffs, bursts, reinforcements, natural parasite spawns near players or hive genes. The doom clock
  keeps its 100-day arc on Easy and Normal. A login line and `/pne difficulty` show the active profile;
  `/pne config diff_profile` pins one. Parasites that already exist keep their stats: test a profile in a fresh world.
- Peaceful skips hordes without blocking beds (the horde schedule moves on as if the horde had run); dedicated servers
  keep EPCA's own NORMAL baseline, so Hard never writes a tier there.
- Fixed: 25 startup command failures; clade teams never created; hive seed 0 for the whole session; Recruits turning
  clade teams into factions. Nothing issues a command before the server's first tick any more, clade teams are made
  through the scoreboard's Java API, and no command the pack sends names a team (Recruits takes those over).
- The Hordes' wave-size comment in `hordes-common.toml` now matches the real formula (15 on day 7 at Hard, not 12).

### The Resonance
- 126 rendered and verified sound assets under `assets/pne` (8 layers; 5.87 MB of OGG). The 18 stereo AmbientSounds
  beds (19.4 MB) are rendered into tools/resonance/out/ only and never ship: no AmbientSounds bed regions ship, because
  a client-side region cannot follow the director's pacing, comfort mode or the sound ledger; the director's positional
  segments are the bed. `sounds.json` with attenuation distances, subtitles and a generated catalog. Build: `python
  tools/resonance/render.py`, then `python tools/resonance/verify.py --install`; `verify.py --committed` re-checks the
  committed files (loudness, true peak, sub-20 Hz energy, modulation depth, comfort rules).
- A per-player pacing director (CALM, UNEASE, DREAD, PANIC, RELEASE) with a sound ledger that every horror sound now goes
  through, including the pack's existing ones; EPCA and Spore sounds trimmed to at most -20 LUFS.
- A startup natural-spawn gate: no parasite spawns near a player at 30% health or less or in respawn grace.
- Comfort mode on by default for every player; `/pne comfort`, `/pne audio`, per-layer switches.
- Optional, local only: `tools/resonance/declip_local.py` writes a de-clipped Spore sound pack into your instance.

### The Hive Genome
- A deterministic genetic algorithm (`pne_hive_core.js`) and its runtime (`pne_hive.js`): 14 genes expressed as
  attribute modifiers, silence with fair tells (every survival player within 12 blocks hears a silent parasite's tell), a
  hidden axe for shield-breakers, projectile resistance, light aversion, conversions that inherit genomes, a dawn dream,
  a survivability governor, persistence in the world's KubeJS data (saved a small piece per tick, so a save never
  causes a lag spike; genome ids carry a load epoch so a `/reload` never reuses one).
- Flankers: at low light, reinforcement beckons rooted by parasites with a strong FLK gene appear behind you (24-40
  blocks, in your rear 120 degrees) instead of where the parasite died; never more of them than before.
- A spawn discard backstop for fresh parasites near players in mercy or grace (Hordes waves included).
- Visual phenotype (`pne_visual.js`): clade teams, display grafts on engaged hosts, apex names; clade texture variants
  generated locally from your own jars (`tools/visual/etf_variants_local.py`, run by `apply.py`).

### The Oracle
- Telemetry features and a file bridge (`pne_oracle_bridge.js`); an optional sidecar (`oracle/`, installed by `apply.py`
  into `<instance>/local/pne_oracle`, started with `launch_oracle.cmd`, stopped only through `stop_oracle.cmd`).
- Per-player opt-in logging with a chat confirmation; pseudonymous ids; purge on request; 7-day retention.

### Shared
- `/pne` command hub, pillar switches, a shared 2.5 ms per-tick budget (constants set from Rhino benchmarks), the module
  contract `docs/IMPLEMENTATION.md`, and `python tools/run_tests.py` with 77 suites, including a pack-level smoke test
  that runs every script together in the instance's own Rhino jar over two in-game days, with each module removed,
  switched off or broken, and again with only the method names KubeJS leaves visible in game (the test mocks now have
  that shape and the lint rejects hidden Minecraft names such as `getGameTime`).
- `python tools/run_tests.py --milestone Mn` lists what no suite can decide (the comfort listening sign-off for M1/M2,
  Spore EMF for M4) and then reports "MET for the automated criteria".
- `validate.py` now also checks the pack's sound assets, the generated catalog and the EPCA/Spore volume trims.

## 1.0.0 — 2026-09-27

First public release. Built on *parasites new dawn - 100 days with parasites* (CurseForge project
1549512), Minecraft 1.20.1, Forge 47.4.10.

### Horror
- Fungal Infection: Spore joins as an allied second strain. The alliance holds in EPCA's config,
  in Spore's config and in a targeting script. Spore's four block-manipulating mobs are blocked.
- Doom clock paces EPCA erosion to stage 10 on day 100.
- Hive Nights: The Hordes every 7th night, with the spawn table replaced by parasites and beds refused
  on horde days. Leftover horde mobs are culled at dawn.
- Night aggression, gore bursts, grim death lines, Mobs Inside corpse bursts, Beckon reinforcements
  on natural ground, and positional whispers.
- Mob Dismemberment, Cave Dweller Evolved, and The Lost Cities + Lost Souls (haunted buildings spawn
  parasites).
- EPCA: Call of the Hive level IV enabled; *Expert* is the default for new worlds; erosion-stage
  messages rewritten to state each stage's real consequence.
- New quest chapter: Hive Nights (7 quests).

### Comfort
- Denied for players: nausea from every source, EPCA Fear (camera jitter), Spore Madness, Blindness
  near Spore mobs, and NuclearCraft's 12.5-hour radiation blindness.
- Spore overlays off; the Spore Cleaver's camera spin is blocked; Spore nukes and Hohlfressers
  (camera shake) are blocked.
- Alex's Caves screen shake and Watcher camera possession off; New Age radiation nausea off;
  NuclearCraft distortion shaders off; Mob Dismemberment gib pushing off.
- options.txt: distortion, damage tilt, FOV effects and darkness pulse all 0.

### Radioactive mining and industry
- Added Alex's Caves, Mekanism (+ Generators, Tools), NuclearCraft Neoteric, Create: New Age,
  Almost Unified, Jade, Patchouli, and KubeJS (+ Rhino, KubeJS Create).
- NuclearCraft duplicate tin, lead, uranium and zinc ores off; New Age thorium ore off (NuclearCraft
  thorium converts into it).
- Radiation fades faster: Mekanism decay rates 4-6x, and NuclearCraft player decay 50x.
- Almost Unified priorities: Mekanism, then Create, then NuclearCraft, then the rest; custom items
  are protected from unification.

### Integration
- Five new items: Parasitic Biomass, Irradiated Biomass, Sterilized Membrane, Hive Serum, Hive Catalyst.
- 56 recipes: the biomass fuel economy, infested-ore processing, Toxic Caves uranium, counter-infection.
- Toxic Caves loot on all 26 EPCA entity tables (generated locally; see tools/gen_loot_overrides.py).
- Six quest chapters: Biomass, Infested Veins, New Ground, The Toxic Caves, Isotopes, Counter-Infection.

### Fixes to the base pack
- "Survive 100 days" checked 10 days; it now checks 100.
- Infested coal, diamond, emerald, lapis and redstone had no use; they now smelt and crush.
- Dying with Call of the Hive level I deleted the player's inventory; items now reach Corpse.
- Redirected disabled (conflicting patches, nothing depends on it).
- Flywheel pinned to the backend it always fell back to.

### Tools
- `apply.py` (install), `fix_instance.py` (stop CurseForge reverting changes), `gen_loot_overrides.py`,
  `validate.py` (syntax, plus every referenced ID resolves against the installed jars).
