// Parasites New Dawn - Enhanced :: custom items
// Textures reuse vanilla art, tinted, so the pack ships no binary assets.
// Effect-clearing for the Hive Serum lives in server_scripts/pne_serum.js, because
// item registration runs before any mod's mob effects exist.

StartupEvents.registry('item', event => {
  event.create('pne:parasitic_biomass')
    .displayName('Parasitic Biomass')
    .texture('minecraft:item/clay_ball')
    .color(0, 0x8A3344)
    .burnTime(800)
    .tooltip(Text.gray('Rendered parasite flesh.'))
    .tooltip(Text.gray('Burns like coal. Compacts into plant oil; crushes into bio fuel.'))

  event.create('pne:irradiated_biomass')
    .displayName('Irradiated Biomass')
    .texture('minecraft:item/clay_ball')
    .color(0, 0x9CFF3F)
    .glow(true)
    .rarity('uncommon')
    .burnTime(1600)
    .tooltip(Text.green('Harvested from parasites that fed in the Toxic Caves.'))
    .tooltip(Text.gray('Enrich it to recover the uranium they absorbed.'))

  event.create('pne:sterilized_membrane')
    .displayName('Sterilized Membrane')
    .texture('minecraft:item/phantom_membrane')
    .color(0, 0xE6E0CC)
    .tooltip(Text.gray('A beckon membrane, cooked clean of infection.'))

  event.create('pne:hive_serum')
    .displayName('Hive Serum')
    .maxStackSize(16)
    .modelJson({
      parent: 'minecraft:item/generated',
      textures: { layer0: 'minecraft:item/potion_overlay', layer1: 'minecraft:item/potion' }
    })
    .color(0, 0xC0143C)
    .rarity('uncommon')
    .tooltip(Text.red('Purges hive infections: Call of the Hive, Bleeding,'))
    .tooltip(Text.red('Corrosion, Fear, Viral and Ender Erosion.'))
    .tooltip(Text.gray('Also grants 30 seconds of Resistance.'))
    .food(food => food.hunger(0).saturation(0).alwaysEdible())

  event.create('pne:hive_catalyst')
    .displayName('Hive Catalyst')
    .texture('minecraft:item/nether_star')
    .color(0, 0x6CFF7A)
    .glow(true)
    .rarity('epic')
    .maxStackSize(16)
    .tooltip(Text.darkGreen('The crystallized will of a beckon, charged with radiation.'))
    .tooltip(Text.gray('Forges totems of undying and polonium pellets.'))
})
