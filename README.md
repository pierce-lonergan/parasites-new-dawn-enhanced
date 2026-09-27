# Parasites: New Dawn — Enhanced

A horror-first enhancement layer for the CurseForge modpack
**parasites new dawn - 100 days with parasites** (Minecraft 1.20.1, Forge 47.4.10).

The base pack is a 100-day survival run against the EPCA parasite mod. This layer adds radioactive
mining and a real industrial tech tree, and turns the parasites into a resource. It also brings in a
second infection strain as their ally, horde nights and a doom clock that paces the apocalypse
toward day 100, plus six new quest chapters. It fixes bugs in the base pack, and it's built so that
none of the horror relies on nausea, screen shake or camera movement.

> Built for one player's machine, then generalised. Every script passed syntax checks and every
> ID was checked against the mod jars, but the runtime systems were never run in-game while being
> built. See [docs/TESTING.md](docs/TESTING.md) for the checklist.

## What it adds

**Radioactive mining and industry**
- Alex's Caves: the Toxic Caves (uranium, radon, radiation) and four more cave biomes.
- Mekanism: five new ores, 5x ore processing, fission, plutonium and polonium.
- NuclearCraft Neoteric: the full isotope table, from boron to californium.
- Create: New Age: Create-powered electricity and a thorium reactor.
- Almost Unified merges the duplicates, so there's one uranium instead of three. NuclearCraft's
  duplicate tin, lead, uranium and zinc ores are switched off, and so is New Age's thorium ore.

**Parasites as a resource** (`kubejs/`)
- Parasite flesh renders into biomass, which becomes Create biodiesel or Mekanism bio fuel.
- Infested ores pay out: infested raw metal crushes to 1.5x, and Silk-Touched infested ore to 2.5x
  (heavy ore to 4.5x).
- Parasites killed inside the Toxic Caves drop Irradiated Biomass, which you enrich into uranium.
- Hive Serum clears Call of the Hive, Bleeding, Corrosion, Fear, Viral and Ender Erosion.
- Hive Catalyst, forged from a Beckon Core, makes a Totem of Undying or polonium.

**Horror systems**
- **Doom clock.** Erosion stages normally need 20,000 points by stage 4 at +1 per kill, so a world
  barely escalates. The clock raises the floor on schedule and reaches stage 10 on day 100.
- **Spore as an allied second strain.** Flesh constructs, a hivemind and evolution. The two strains
  ignore each other and both hunt you.
- **Hive Nights.** Every 7th night a horde of parasites marches on you, with beds refused all that day.
- **The hive grows stronger at night.** Parasites near you get Speed and Strength.
- **Gore.** Blood bursts and grim death lines, plus Mob Dismemberment.
- **Mobs Inside.** Host corpses split open into new parasites.
- **Reinforcements.** From stage 3, dying parasites can root a Beckon on natural ground nearby.
- **Whispers** placed behind you in the dark, and a stalker in the caves (Cave Dweller Evolved).
- **Lost Cities** as a world type: ruined cities whose haunted buildings spawn parasites.

**Quests.** Seven chapters and 48 quests in a new *New Dawn: Enhanced* group: Biomass, Infested
Veins, New Ground, The Toxic Caves, Isotopes, Counter-Infection and Hive Nights. Descriptions state
the real recipes and numbers.

## Comfort by design

The horror never relies on motion. Nausea, the parasite Fear effect's camera jitter, and Spore's
hallucinations are denied for players. Spore's vision overlays are off. Alex's Caves screen shake
and camera possession are off, as is New Age's radiation nausea, and so are NuclearCraft's
distortion shaders. FOV-effect, darkness-pulse, distortion and damage-tilt scaling are all zero.
Radiation still hurts; it just doesn't move your screen. Details in [docs/DESIGN.md](docs/DESIGN.md).

## Fixes to the base pack

- **"Survive 100 days" completed after 10 days.** The quest checked `play_time >= 240000`, which is
  10 days; it now checks 2,400,000.
- **Infested diamonds, emeralds, coal, lapis and redstone were dead items.** They now smelt or crush
  into the real thing.
- **Dying with Call of the Hive level I wiped your inventory.** EPCA cancelled the drops, so Corpse
  got nothing. The items now reach your corpse.
- **CurseForge silently undid changes.** A linked modpack instance gets "repaired" back to the
  modpack at launch, and its memory setting is ignored unless `isMemoryOverride` is set.
  `tools/fix_instance.py` handles both.

## Install

You need Python 3.11+ and, for the syntax checks, Node.js.

1. In CurseForge, install **parasites new dawn - 100 days with parasites**, then make a copy of the
   instance folder (for example `parasites new dawn - enhanced`). Don't apply this to an instance
   whose worlds you care about without a backup.
2. Launch the copy once, reach the main menu, and quit. That generates `options.txt` and the configs.
3. Apply the layer, downloading the added mods from Modrinth with SHA-512 verification:
   ```bash
   python tools/apply.py --instance "<path to your instance copy>" --download
   ```
4. **Quit CurseForge fully** (tray icon too), then stop it restoring the original modpack:
   ```bash
   python tools/fix_instance.py --instance "<path to your instance copy>"
   ```
5. Reopen CurseForge, launch, and create a **new** world so the ore changes apply from the first
   chunk. EPCA *Expert* on vanilla *Hard* is the intended difficulty. Pick the **Cities** world type
   for Lost Cities.

To check the overrides at any time: `python tools/validate.py --instance "<path>"`.

## What is not in this repository, and why

- **No mod jars.** They belong to their authors, and many are all-rights-reserved.
  [mods/manifest.json](mods/manifest.json) lists all 19 added mods, each with its Modrinth page,
  version, download URL and SHA-512 hash. `apply.py --download` installs exactly those files.
- **No copies of EPCA's data.** The Toxic Caves drops are pools appended to EPCA's own loot tables.
  EPCA is closed source, so `tools/gen_loot_overrides.py` builds them from the jar in your instance
  instead of this repo shipping copies.
- **No base-pack files** beyond the configs this layer changes.

## Mods added

| Mod | Version | Role |
|---|---|---|
| [Alex's Caves](https://modrinth.com/mod/alexs-caves) | 2.0.2 | Toxic Caves, radiation |
| [Mekanism](https://modrinth.com/mod/mekanism) + Generators + Tools | 10.4.16.80 | Ores, processing, fission |
| [NuclearCraft Neoteric](https://modrinth.com/mod/nuclearcraft-neoteric) | 1.2.36 | Isotopes |
| [Create: New Age](https://modrinth.com/mod/create-new-age) | 1.2.0 | Electricity, thorium reactor |
| [KubeJS](https://modrinth.com/mod/kubejs) + Rhino + KubeJS Create | 2001.6.5 | Scripting |
| [Almost Unified](https://modrinth.com/mod/almostunified) | 0.11.0 | Material unification |
| [Jade](https://modrinth.com/mod/jade) | 11.13.3 | Look-at info |
| [Patchouli](https://modrinth.com/mod/patchouli) | 1.20.1-85 | NuclearCraft's guidebook |
| [Fungal Infection: Spore](https://modrinth.com/mod/fungal-infectionspore) | 2.2.0j | Second infection strain |
| [The Hordes](https://modrinth.com/mod/the-hordes) + Atlas Lib | 1.6.3i | Horde nights |
| [Mob Dismemberment](https://modrinth.com/mod/mob-dismemberment-unofficial-modern-port) | 8.0.0 | Gibs |
| [Cave Dweller Evolved](https://modrinth.com/mod/cave-dweller-evolved) | 1.7.0 | Cave stalker |
| [The Lost Cities](https://modrinth.com/mod/the-lost-cities) + Lost Souls | 7.5.5 / 4.1.7 | Ruined cities |

Disabled: **Redirected**. Two of its patches were skipped due to conflicts, and nothing depends on it.

## Repository layout

```
overrides/   files copied into the instance: kubejs/, config/, defaultconfigs/
mods/        manifest.json: the added mods, with hashes
tools/       apply.py, fix_instance.py, gen_loot_overrides.py, validate.py
docs/        DESIGN.md (systems and decisions), TESTING.md (in-game checklist)
```

## Credits

The base modpack belongs to its author, and every mod above belongs to its authors: this layer
only configures and connects them. Special thanks to the authors of EPCA (End-Parasitize and
Convert All), Spore, Alex's Caves, Mekanism, NuclearCraft Neoteric, Create and The Hordes.

## License

MIT for the original work here (scripts, quests, configuration choices, tools). See [LICENSE](LICENSE).
