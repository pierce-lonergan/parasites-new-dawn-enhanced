// Parasites New Dawn - Enhanced :: integration recipes
// Ties the parasite mod (epca) into Create, Mekanism, Alex's Caves, NuclearCraft and Create: New Age.
// Raw JSON via event.custom mirrors each mod's own recipe files exactly.
// Written in conservative ES5-style JavaScript: KubeJS runs on Rhino, which lacks some modern syntax.

ServerEvents.recipes(event => {
  function id(path) { return 'pne:' + path }
  function times(n, ingredient) {
    var list = []
    for (var i = 0; i < n; i++) list.push(ingredient)
    return list
  }
  function shortName(itemId) { return itemId.split(':')[1] }

  // ------------------------------------------------------------------
  // 1. The biomass economy: parasite corpses become fuel
  // ------------------------------------------------------------------
  // [input, how many in, how much biomass out]
  var meats = [
    ['epca:infested_flesh',     4, 2],
    ['epca:weird_minced_flesh', 2, 1],
    ['epca:reshape_flesh',      2, 2],
    ['epca:parasite_viscera',   2, 2],
    ['epca:tight_tendons',      2, 1]
  ]
  meats.forEach(function (row) {
    event.custom({
      type: 'create:mixing',
      ingredients: times(row[1], { item: row[0] }),
      results: [{ item: 'pne:parasitic_biomass', count: row[2] }]
    }).id(id('mixing/biomass_from_' + shortName(row[0])))
  })

  // Early game, before Create: worse ratio, but it gets you going
  event.shapeless('pne:parasitic_biomass', [
    'epca:infested_flesh', 'epca:infested_flesh', 'epca:infested_flesh',
    'epca:infested_flesh', 'minecraft:bone_meal'
  ]).id(id('crafting/biomass_by_hand'))

  // Biomass -> plant oil, which Create Diesel Generators already turns into biodiesel
  event.custom({
    type: 'create:compacting',
    ingredients: times(4, { item: 'pne:parasitic_biomass' }),
    results: [{ fluid: 'createdieselgenerators:plant_oil', amount: 250 }]
  }).id(id('compacting/plant_oil_from_biomass'))

  // Biomass -> Mekanism bio fuel (seeds give 1-2; parasites are richer)
  event.custom({
    type: 'mekanism:crushing',
    input: { ingredient: { item: 'pne:parasitic_biomass' } },
    output: { item: 'mekanism:bio_fuel', count: 6 }
  }).id(id('crushing/bio_fuel_from_biomass'))

  var bones = ['epca:infested_bone', 'epca:twisted_bone']
  bones.forEach(function (bone) {
    event.custom({
      type: 'create:milling',
      ingredients: [{ item: bone }],
      processingTime: 100,
      results: [
        { item: 'minecraft:bone_meal', count: 3 },
        { item: 'minecraft:bone_meal', count: 2, chance: 0.5 },
        { item: 'pne:parasitic_biomass', chance: 0.25 }
      ]
    }).id(id('milling/' + shortName(bone)))
  })

  // ------------------------------------------------------------------
  // 2. Toxic Caves parasites bio-accumulate uranium
  // ------------------------------------------------------------------
  event.custom({
    type: 'mekanism:enriching',
    input: { ingredient: { item: 'pne:irradiated_biomass' }, amount: 2 },
    output: { item: 'mekanism:dust_uranium' }
  }).id(id('enriching/uranium_from_irradiated_biomass'))

  event.custom({
    type: 'create:crushing',
    ingredients: [{ item: 'pne:irradiated_biomass' }],
    processingTime: 200,
    results: [
      { item: 'alexscaves:uranium_shard', chance: 0.5 },
      { item: 'pne:parasitic_biomass' }
    ]
  }).id(id('crushing/irradiated_biomass'))

  // ------------------------------------------------------------------
  // 3a. What infested ores drop when mined normally (no Silk Touch)
  //     The base mod only smelts the three raw metals; the five gem drops had no use at all.
  // ------------------------------------------------------------------
  // raw drop: [Create crushed ore, Mekanism dust]
  var infestedRaws = {
    'epca:infested_raw_iron':   ['create:crushed_raw_iron',   'mekanism:dust_iron'],
    'epca:infested_raw_gold':   ['create:crushed_raw_gold',   'mekanism:dust_gold'],
    'epca:infested_raw_copper': ['create:crushed_raw_copper', 'mekanism:dust_copper']
  }
  Object.keys(infestedRaws).forEach(function (raw) {
    var crushed = infestedRaws[raw][0]
    var dust = infestedRaws[raw][1]
    // Vanilla raw ore through Create = 1 crushed. Infested = 1 + 50%, plus biomass.
    event.custom({
      type: 'create:crushing',
      ingredients: [{ item: raw }],
      processingTime: 250,
      results: [
        { item: crushed },
        { item: crushed, chance: 0.5 },
        { item: 'pne:parasitic_biomass', chance: 0.4 },
        { item: 'create:experience_nugget', chance: 0.75 }
      ]
    }).id(id('crushing/' + shortName(raw)))
    // Vanilla raw ore through Mekanism enriching = 4 dust per 3. Infested = 2 per 1.
    event.custom({
      type: 'mekanism:enriching',
      input: { ingredient: { item: raw } },
      output: { item: dust, count: 2 }
    }).id(id('enriching/' + shortName(raw)))
  })

  // gem drop: its clean vanilla counterpart
  var infestedGems = {
    'epca:infested_coal':         'minecraft:coal',
    'epca:infested_diamond':      'minecraft:diamond',
    'epca:infested_emerald':      'minecraft:emerald',
    'epca:infested_lapis_lazuli': 'minecraft:lapis_lazuli',
    'epca:infested_redstone':     'minecraft:redstone'
  }
  Object.keys(infestedGems).forEach(function (drop) {
    var clean = infestedGems[drop]
    // Cook the parasite out: 1:1, available from day one
    event.smelting(clean, drop).xp(0.7).id(id('smelting/sterilize_' + shortName(drop)))
    // Or crush it for a bonus and some biomass
    event.custom({
      type: 'create:crushing',
      ingredients: [{ item: drop }],
      processingTime: 200,
      results: [
        { item: clean },
        { item: clean, chance: 0.25 },
        { item: 'pne:parasitic_biomass', chance: 0.4 }
      ]
    }).id(id('crushing/' + shortName(drop)))
  })

  // ------------------------------------------------------------------
  // 3b. Silk Touch route: bring the ore block home for the big multiplier
  //     Infested ore = 2 + 50% crushed. Heavy infested ore = 4 + 50%.
  // ------------------------------------------------------------------
  var tiers = ['', 'heavy_']

  // metal: [Create crushed ore, Mekanism dust]
  var metals = {
    iron:   ['create:crushed_raw_iron',   'mekanism:dust_iron'],
    gold:   ['create:crushed_raw_gold',   'mekanism:dust_gold'],
    copper: ['create:crushed_raw_copper', 'mekanism:dust_copper']
  }
  Object.keys(metals).forEach(function (metal) {
    var crushed = metals[metal][0]
    var dust = metals[metal][1]
    tiers.forEach(function (heavy) {
      var ore = 'epca:infested_' + heavy + metal + '_ore'
      var mult = heavy ? 2 : 1
      event.custom({
        type: 'create:crushing',
        ingredients: [{ item: ore }],
        processingTime: 300,
        results: [
          { item: crushed, count: 2 * mult },
          { item: crushed, chance: 0.5 },
          { item: 'pne:parasitic_biomass', chance: 0.4 },
          { item: 'create:experience_nugget', chance: 0.75 }
        ]
      }).id(id('crushing/infested_' + heavy + metal + '_ore'))
      event.custom({
        type: 'mekanism:enriching',
        input: { ingredient: { item: ore } },
        output: { item: dust, count: 3 * mult }
      }).id(id('enriching/infested_' + heavy + metal + '_ore'))
    })
  })

  // kind: [product, base count]
  var gems = {
    coal:     ['minecraft:coal',         3],
    diamond:  ['minecraft:diamond',      2],
    emerald:  ['minecraft:emerald',      2],
    lapis:    ['minecraft:lapis_lazuli', 9],
    redstone: ['minecraft:redstone',     8]
  }
  Object.keys(gems).forEach(function (kind) {
    var product = gems[kind][0]
    var n = gems[kind][1]
    tiers.forEach(function (heavy) {
      var ore = 'epca:infested_' + heavy + kind + '_ore'
      var mult = heavy ? 2 : 1
      event.custom({
        type: 'create:crushing',
        ingredients: [{ item: ore }],
        processingTime: 300,
        results: [
          { item: product, count: n * mult },
          { item: product, chance: 0.5 },
          { item: 'pne:parasitic_biomass', chance: 0.4 }
        ]
      }).id(id('crushing/infested_' + heavy + kind + '_ore'))
    })
  })

  // ------------------------------------------------------------------
  // 4. Counter-infection: turn the hive against itself
  // ------------------------------------------------------------------
  event.smelting('pne:sterilized_membrane', 'epca:beckon_membrane')
    .xp(0.5).id(id('smelting/sterilized_membrane'))

  event.shapeless('2x pne:hive_serum', [
    'minecraft:glass_bottle', 'minecraft:glass_bottle',
    'epca:diseased_heart', 'pne:sterilized_membrane', 'mekanism:fluorite_gem'
  ]).id(id('crafting/hive_serum'))

  // The Beckon Core is the block a Stage I Beckon plants; it only drops with Silk Touch.
  event.shaped('pne:hive_catalyst', [
    'IUI',
    'UCU',
    'IUI'
  ], {
    I: 'pne:irradiated_biomass',
    U: 'alexscaves:uranium_shard',
    C: 'epca:beckon_core'
  }).id(id('crafting/hive_catalyst'))

  event.shaped('minecraft:totem_of_undying', [
    'GEG',
    'GCG',
    ' G '
  ], {
    G: 'minecraft:gold_ingot',
    E: 'minecraft:emerald',
    C: 'pne:hive_catalyst'
  }).id(id('crafting/totem_from_hive_catalyst'))

  // A second road to isotopes: hunt the hive instead of building a reactor
  event.shapeless('2x mekanism:pellet_polonium', [
    'pne:hive_catalyst', 'mekanism:dust_uranium', 'mekanism:dust_uranium'
  ]).id(id('crafting/polonium_from_hive_catalyst'))

  // ------------------------------------------------------------------
  // 5. Thorium: NuclearCraft is the single ore source; keep New Age's reactor fed
  // ------------------------------------------------------------------
  event.shapeless('create_new_age:thorium', ['nuclearcraft:thorium_chunk'])
    .id(id('crafting/new_age_thorium_from_nc'))
})
