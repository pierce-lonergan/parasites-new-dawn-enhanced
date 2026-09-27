// Parasites New Dawn - Enhanced :: tags
// Lets Almost Unified and every tag-based machine treat duplicate materials as one.

ServerEvents.tags('item', event => {
  // Create: New Age ships its thorium with no tags at all
  event.add('forge:raw_materials/thorium', 'create_new_age:thorium')
  event.add('forge:ores/thorium', 'create_new_age:thorium_ore')

  // Alex's Caves uranium ore isn't in forge:ores/uranium, so Mekanism and Create ignored it
  event.add('forge:ores/uranium', 'alexscaves:radrock_uranium_ore')

  event.add('pne:parasite_biomatter', [
    'epca:infested_flesh', 'epca:weird_minced_flesh', 'epca:reshape_flesh', 'epca:diseased_heart'
  ])
  event.add('pne:biomass', ['pne:parasitic_biomass', 'pne:irradiated_biomass'])
})

ServerEvents.tags('block', event => {
  event.add('forge:ores/thorium', 'create_new_age:thorium_ore')
  event.add('forge:ores/uranium', 'alexscaves:radrock_uranium_ore')
})

// #pne:beckon_ground = natural ground a scripted reinforcement beckon may root on
// (server_scripts/pne_horror.js). EPCA's StageIBeckon converts and, when inside a wall, breaks
// the blocks around it, so it must never appear on planks, glass, bricks or machines.
// Vanilla 1.20.1 tag contents checked in the client jar: #minecraft:dirt = dirt, grass_block,
// podzol, coarse_dirt, mycelium, rooted_dirt, moss_block, mud, muddy_mangrove_roots;
// #minecraft:sand = sand, red_sand, suspicious_sand; #minecraft:base_stone_overworld = stone,
// granite, diorite, andesite, tuff, deepslate; #minecraft:base_stone_nether = netherrack,
// basalt, blackstone; #minecraft:nylium = crimson and warped nylium.
ServerEvents.tags('block', function (event) {
  try {
    event.add('pne:beckon_ground', [
      '#minecraft:dirt', '#minecraft:sand', '#minecraft:base_stone_overworld',
      '#minecraft:base_stone_nether', '#minecraft:nylium',
      'minecraft:gravel', 'minecraft:snow_block', 'minecraft:clay', 'minecraft:soul_sand',
      'minecraft:soul_soil', 'minecraft:end_stone'
    ])
  } catch (err) {
    console.warn('[pne_tags] pne:beckon_ground block tag failed: ' + err)
  }
})

// Entity-type tags for the horror layer (server_scripts/pne_horror.js selectors).
// Every id is a registry string read from the jars: EPCA ModEntities, Spore Sentities.
// A tag with an unknown id fails to load as a whole, so do not add unverified ids here.
// Keep these lists in step with PNE_H_HIVE_IDS / PNE_H_BECKON_IDS / PNE_H_SPORE_IDS.
ServerEvents.tags('entity_type', function (event) {
  try {
    // #pne:hive = EPCA creatures. No projectiles, spears, parts, fluids, eggs, easter eggs or beckons.
    event.add('pne:hive', [
      'epca:curbug', 'epca:ripper', 'epca:fins', 'epca:mozzie', 'epca:flying_carrier', 'epca:light_carrier',
      'epca:small_incomplete_form', 'epca:medium_incomplete_form', 'epca:large_incomplete_form',
      'epca:biomass_small', 'epca:biomass_medium',
      'epca:living_flesh_size0', 'epca:living_flesh_size1', 'epca:living_flesh_size2',
      'epca:living_flesh_size3', 'epca:living_flesh_size4',
      'epca:reshape_longarms', 'epca:reshape_yelloweye',
      'epca:infested_zombie', 'epca:infested_husk', 'epca:infested_drowned', 'epca:infested_pillager',
      'epca:infested_villager', 'epca:infested_vindicator', 'epca:infested_zombie_villager',
      'epca:infested_pig', 'epca:infested_sheep', 'epca:infested_cow', 'epca:infested_chicken',
      'epca:infested_wolf', 'epca:infested_fox', 'epca:infested_endermite', 'epca:infested_silverfish',
      'epca:infested_skeleton', 'epca:infested_pumpkin_head', 'epca:infested_slime_size0',
      'epca:infested_slime_size1', 'epca:infested_slime_size3', 'epca:infested_bat',
      'epca:infested_enderman',
      'epca:walking_zombie_head', 'epca:walking_husk_head', 'epca:walking_drowned_head',
      'epca:walking_pillager_head', 'epca:walking_villager_head', 'epca:walking_vindicator_head',
      'epca:walking_zombie_villager_head', 'epca:walking_pig_head', 'epca:walking_sheep_head',
      'epca:walking_cow_head', 'epca:walking_chicken_head', 'epca:walking_wolf_head',
      'epca:walking_skeleton_head', 'epca:walking_fox_head', 'epca:walking_enderman_head'
    ])

    // #pne:beckon = EPCA's reinforcement nodes (used for the 32-block spacing check).
    event.add('pne:beckon', ['epca:stage_i_beckon', 'epca:stage_ii_beckon'])

    // #pne:flesh = every living flesh size. EPCA merges size0 upward, and the merged flesh does
    // not carry the pne_burst tag, so the burst cap counts this tag as well.
    event.add('pne:flesh', [
      'epca:living_flesh_size0', 'epca:living_flesh_size1', 'epca:living_flesh_size2',
      'epca:living_flesh_size3', 'epca:living_flesh_size4'
    ])

    // #pne:spore = Spore creatures. No multipart segments/limbs or utility entities.
    event.add('pne:spore', [
      'spore:inf_human', 'spore:inf_husk', 'spore:inf_player', 'spore:inf_villager',
      'spore:inf_diseased_villager', 'spore:inf_wanderer', 'spore:inf_witch', 'spore:inf_pillager',
      'spore:inf_hazmat', 'spore:inf_drowned', 'spore:bairn',
      'spore:knight', 'spore:protector', 'spore:inebriater', 'spore:griefer', 'spore:braiomil',
      'spore:leaper', 'spore:slasher', 'spore:spitter', 'spore:thorn', 'spore:mephitic', 'spore:jagd',
      'spore:scavenger', 'spore:bloater', 'spore:nuclea', 'spore:scamper', 'spore:inf_vindicator',
      'spore:inf_evoker', 'spore:howler', 'spore:gorgon', 'spore:stalker', 'spore:busser',
      'spore:volatile', 'spore:chemist', 'spore:conductor', 'spore:gargoyle', 'spore:naiad',
      'spore:grober', 'spore:hevoker', 'spore:brot', 'spore:ogre', 'spore:brute', 'spore:hollen', 'spore:hvindicator',
      'spore:inquisitor', 'spore:wendigo',
      'spore:gazenbreacher', 'spore:kraken', 'spore:hindenburg', 'spore:verfall', 'spore:howitzer',
      'spore:stahl', 'spore:hohlfresser', 'spore:leviathan', 'spore:sieger',
      'spore:vigil', 'spore:delusioner', 'spore:umarmed', 'spore:braurei', 'spore:tentacle',
      'spore:mound', 'spore:reconstructor', 'spore:verva', 'spore:usurper', 'spore:proto',
      'spore:hivetumor',
      'spore:saugling', 'spore:plagued', 'spore:lacerator', 'spore:biobloob',
      'spore:inf_contruct', 'spore:reaper', 'spore:specter', 'spore:vanguard', 'spore:gastgaber'
    ])

    // #pne:spore_basic = Spore's BasicInfected tier only (night Speed I, no Strength).
    event.add('pne:spore_basic', [
      'spore:inf_human', 'spore:inf_husk', 'spore:inf_player', 'spore:inf_villager',
      'spore:inf_diseased_villager', 'spore:inf_wanderer', 'spore:inf_witch', 'spore:inf_pillager',
      'spore:inf_hazmat', 'spore:inf_drowned', 'spore:bairn'
    ])
  } catch (err) {
    console.warn('[pne_tags] entity_type tags failed: ' + err)
  }
})
