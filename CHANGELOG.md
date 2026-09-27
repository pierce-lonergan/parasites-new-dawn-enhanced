# Changelog

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
