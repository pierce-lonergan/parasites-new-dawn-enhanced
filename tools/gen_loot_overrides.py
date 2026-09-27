"""
Generate the Toxic Caves loot overrides from YOUR copy of the EPCA jar.

The parasite mod (End-Parasitize and Convert All) is closed source, so this repository does not
ship copies of its loot tables. Instead this script reads each of EPCA's entity loot tables from
the jar in your instance, appends two pools, and writes the result to
kubejs/data/epca/loot_tables/entities/. The original pools are kept exactly as they are.

Added pools (both require a player kill inside alexscaves:toxic_caves):
  - 1-2 pne:irradiated_biomass (+0-1 per Looting level)
  - 20% chance of alexscaves:uranium_shard (+5% per Looting level)

Usage:
    python tools/gen_loot_overrides.py --instance "<path to the CurseForge instance>"
"""
import argparse
import glob
import json
import os
import re
import sys
import zipfile

TOXIC = [
    {"condition": "minecraft:killed_by_player"},
    {"condition": "minecraft:location_check", "predicate": {"biome": "alexscaves:toxic_caves"}},
]
BIOMASS_POOL = {
    "rolls": 1,
    "bonus_rolls": 0,
    "entries": [{
        "type": "minecraft:item",
        "name": "pne:irradiated_biomass",
        "functions": [
            {"function": "minecraft:set_count", "count": {"type": "minecraft:uniform", "min": 1, "max": 2}},
            {"function": "minecraft:looting_enchant", "count": {"type": "minecraft:uniform", "min": 0, "max": 1}},
        ],
    }],
    "conditions": TOXIC,
}
SHARD_POOL = {
    "rolls": 1,
    "bonus_rolls": 0,
    "entries": [{"type": "minecraft:item", "name": "alexscaves:uranium_shard"}],
    "conditions": TOXIC + [
        {"condition": "minecraft:random_chance_with_looting", "chance": 0.2, "looting_multiplier": 0.05},
    ],
}


def find_epca_jar(instance):
    hits = glob.glob(os.path.join(instance, "mods", "End-Parasitize and Convert All-*.jar"))
    return hits[0] if hits else None


def generate(instance):
    jar = find_epca_jar(instance)
    if not jar:
        print("EPCA jar not found in", os.path.join(instance, "mods"))
        return 0
    out_dir = os.path.join(instance, "kubejs", "data", "epca", "loot_tables", "entities")
    os.makedirs(out_dir, exist_ok=True)
    z = zipfile.ZipFile(jar)
    count = 0
    for name in sorted(n for n in z.namelist() if re.match(r"data/epca/loot_tables/entities/[a-z0-9_]+\.json$", n)):
        table = json.loads(z.read(name))
        table.setdefault("type", "minecraft:entity")
        table.setdefault("pools", []).extend([json.loads(json.dumps(BIOMASS_POOL)), json.loads(json.dumps(SHARD_POOL))])
        with open(os.path.join(out_dir, os.path.basename(name)), "w", encoding="utf-8") as f:
            json.dump(table, f, indent=2)
        count += 1
    print(f"Wrote {count} Toxic Caves loot overrides from {os.path.basename(jar)}")
    return count


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--instance", required=True, help="path to the CurseForge instance folder")
    args = ap.parse_args()
    return 0 if generate(args.instance) else 1


if __name__ == "__main__":
    sys.exit(main())
