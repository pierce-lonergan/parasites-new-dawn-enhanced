// Parasites New Dawn - Enhanced :: scripted horror layer (server side)
//
// Owns: the doom clock, night aggression, gore, Mobs Inside bursts, reinforcement beckons,
// whispers, Hive Night atmosphere and the Call of the Hive inventory fix.
//
// Rules this file follows:
//  * World changes go through server.runCommandSilent(...). That source is the server at
//    permission 4 with output suppressed. entity.runCommandSilent is permission 0 for mobs.
//  * ES5 only for Rhino: var/function, no arrows, destructuring, spread or default params.
//  * Every handler body is wrapped in try/catch and fails safe (does nothing).
//  * The tick handler does real work at most once every 20 ticks.
//  * Numbers passed to /epca_evolution are plain integer strings (IntegerArgumentType,
//    range -100..2100000000, verified in EvolutionCommand bytecode).
//
// Verified against the jars in mods/ (EPCA 0.147i, Spore 2.2.0j, The Hordes 1.6.3i, KubeJS
// 2001.6.5, Architectury 9.2.14, Corpse 1.0.23). Nothing here has been run in game.

// ---------------------------------------------------------------------------------------------
// Java classes. EPCA's EvolutionManager is org.tdddd.*, which KubeJS's ClassFilter allows
// (default allow; only java.io/nio/net, fml, asm etc. are denied).
var $PneHForgeRegistries = null
var $PneHResourceLocation = null
var $PneHEvolutionManager = null
try { $PneHForgeRegistries = Java.loadClass('net.minecraftforge.registries.ForgeRegistries') } catch (e) { console.warn('[pne_horror] ForgeRegistries unavailable: ' + e) }
try { $PneHResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation') } catch (e) { console.warn('[pne_horror] ResourceLocation unavailable: ' + e) }
try { $PneHEvolutionManager = Java.loadClass('org.tdddd.epca.impl.overworld.data.EvolutionManager') } catch (e) { console.warn('[pne_horror] EPCA EvolutionManager unavailable, doom clock uses its stored floor: ' + e) }

// ---------------------------------------------------------------------------------------------
// Tunables

var PNE_H_OVERWORLD = 'minecraft:overworld'

// Doom clock: [day, points] as plain integer strings. Each value is exactly an EPCA stage
// threshold (EvolutionManager.STAGE_THRESHOLDS, index = stage + 2):
// stage 1=400, 2=800, 3=1800, 4=20000, 5=200000, 6=5000000, 7=25000000, 8=500000000,
// 9=1000000000, 10=1800000000. Stages 11-13 are only reachable by /epca_evolution setstage.
// Pacing side effect (EvolutionManager bytecode): setPoints calls checkForStageChange, which
// starts EPCA's 24,000-tick cooldown whenever the stage changes (below stage 11), and addPoints
// returns early while that cooldown runs. So each doom-clock step also freezes EPCA's natural
// point growth for one in-game day. That is intended: the clock, not kill farming, sets the pace.
// Note: /epca_evolution setstage pins the stage (setOverriddenStage) and later setpoints calls,
// including this clock, change the points but not the stage until that override is cleared.
var PNE_H_DOOM = [
  ['6', '400'], ['12', '800'], ['20', '1800'], ['32', '20000'], ['48', '200000'],
  ['62', '5000000'], ['76', '25000000'], ['88', '500000000'], ['96', '1000000000'],
  ['100', '1800000000']
]
// Same thresholds, highest first, for deriving a stage from the stored floor.
var PNE_H_STAGE_FROM_POINTS = [
  [1800000000, 10], [1000000000, 9], [500000000, 8], [25000000, 7], [5000000, 6],
  [200000, 5], [20000, 4], [1800, 3], [800, 2], [400, 1]
]

// EPCA creature ids (registry strings from ModEntities). Must match #pne:hive in pne_tags.js.
// Excluded on purpose: projectiles, spears, reshape_part, contaminated_water, biomass_egg,
// nullthing, yawning_nya (easter egg) and the two beckons (tracked separately).
var PNE_H_HIVE_IDS = [
  'curbug', 'ripper', 'fins', 'mozzie', 'flying_carrier', 'light_carrier',
  'small_incomplete_form', 'medium_incomplete_form', 'large_incomplete_form',
  'biomass_small', 'biomass_medium',
  'living_flesh_size0', 'living_flesh_size1', 'living_flesh_size2', 'living_flesh_size3', 'living_flesh_size4',
  'reshape_longarms', 'reshape_yelloweye',
  'infested_zombie', 'infested_husk', 'infested_drowned', 'infested_pillager', 'infested_villager',
  'infested_vindicator', 'infested_zombie_villager', 'infested_pig', 'infested_sheep', 'infested_cow',
  'infested_chicken', 'infested_wolf', 'infested_fox', 'infested_endermite', 'infested_silverfish',
  'infested_skeleton', 'infested_pumpkin_head', 'infested_slime_size0', 'infested_slime_size1',
  'infested_slime_size3', 'infested_bat', 'infested_enderman',
  'walking_zombie_head', 'walking_husk_head', 'walking_drowned_head', 'walking_pillager_head',
  'walking_villager_head', 'walking_vindicator_head', 'walking_zombie_villager_head',
  'walking_pig_head', 'walking_sheep_head', 'walking_cow_head', 'walking_chicken_head',
  'walking_wolf_head', 'walking_skeleton_head', 'walking_fox_head', 'walking_enderman_head'
]
var PNE_H_BECKON_IDS = ['stage_i_beckon', 'stage_ii_beckon']

// Spore creature ids (registry strings from com.Harbinger.Spore.Core.Sentities). Must match
// #pne:spore in pne_tags.js. Excluded: multipart segments/limbs (hohlfresser_seg, leviathan_seg,
// verfall_head, sieger_tail, stahl_arm, howit_arm, hevoker_arm, licker), utility entities
// (scent, wave, nuke, tumoroid_nuke, corpse_piece, tendril, arena_tendril, claw, illusion).
var PNE_H_SPORE_IDS = [
  'inf_human', 'inf_husk', 'inf_player', 'inf_villager', 'inf_diseased_villager', 'inf_wanderer',
  'inf_witch', 'inf_pillager', 'inf_hazmat', 'inf_drowned', 'bairn',
  'knight', 'protector', 'inebriater', 'griefer', 'braiomil', 'leaper', 'slasher', 'spitter', 'thorn',
  'mephitic', 'jagd', 'scavenger', 'bloater', 'nuclea', 'scamper', 'inf_vindicator', 'inf_evoker',
  'howler', 'gorgon', 'stalker', 'busser', 'volatile', 'chemist', 'conductor', 'gargoyle', 'naiad',
  'grober', 'hevoker', 'brot', 'ogre', 'brute', 'hollen', 'hvindicator', 'inquisitor', 'wendigo',
  'gazenbreacher', 'kraken', 'hindenburg', 'verfall', 'howitzer', 'stahl', 'hohlfresser', 'leviathan', 'sieger',
  'vigil', 'delusioner', 'umarmed', 'braurei', 'tentacle', 'mound', 'reconstructor', 'verva', 'usurper',
  'proto', 'hivetumor',
  'saugling', 'plagued', 'lacerator', 'biobloob',
  'inf_contruct', 'reaper', 'specter', 'vanguard', 'gastgaber'
]

// Mobs Inside: only real hosts burst (not bats, chickens, slimes, endermites, silverfish).
var PNE_H_HOST_IDS = [
  'infested_zombie', 'infested_husk', 'infested_drowned', 'infested_pillager', 'infested_villager',
  'infested_vindicator', 'infested_zombie_villager', 'infested_pig', 'infested_sheep', 'infested_cow',
  'infested_wolf', 'infested_fox', 'infested_skeleton', 'infested_enderman', 'infested_pumpkin_head'
]

var PNE_H_DEATH_LINES = [
  'Something is wearing what is left of %s.',
  '%s stopped screaming before they stopped moving.',
  'The hive has learned the shape of %s.',
  'They found %s. Most of %s.',
  '%s is still warm. The hive is patient.',
  'What was %s is being taken apart, carefully.',
  '%s heard the singing and answered.',
  'The flesh remembers %s. It will wear them well.',
  'Nothing of %s will be wasted.',
  '%s is part of something larger now.',
  'The ground drank what %s left behind.',
  'Somewhere a new voice joins the chorus. It sounds like %s.'
]

var PNE_H_HIVE_NIGHT_LINES = [
  'The ground is singing. Do not answer it.',
  'They are coming for you. All of them. Tonight.',
  'The hive has your scent. Find walls.',
  'Something vast is moving under the dark. It knows where you sleep.'
]

// Short, verified sound events: EPCA assets/epca/sounds.json, Spore assets/spore/sounds.json.
// spore:madness is the four short madness_whisper clips (not the long post_proto song).
var PNE_H_WHISPERS = [
  'epca:infested_villager_idle', 'epca:walking_head_say', 'epca:infested_wolf_whine',
  'epca:reshape_step', 'epca:incomplete_form_idle', 'spore:madness'
]

// ---------------------------------------------------------------------------------------------
// Lookups

function pneHSet(list, prefix) {
  var s = {}
  for (var i = 0; i < list.length; i++) s[prefix + list[i]] = true
  return s
}
var PNE_H_HIVE = pneHSet(PNE_H_HIVE_IDS, 'epca:')
var PNE_H_BECKON = pneHSet(PNE_H_BECKON_IDS, 'epca:')
var PNE_H_SPORE = pneHSet(PNE_H_SPORE_IDS, 'spore:')
var PNE_H_HOST = pneHSet(PNE_H_HOST_IDS, 'epca:')
// Living flesh of every size (#pne:flesh). Merged flesh loses the pne_burst tag, so flesh deaths
// never call reinforcements, whatever their tags.
var PNE_H_FLESH = pneHSet(['living_flesh_size0', 'living_flesh_size1', 'living_flesh_size2',
  'living_flesh_size3', 'living_flesh_size4'], 'epca:')

// KubeJS exposes entity.type as the registry id string. Accept the other shapes too
// ("entity.epca.ripper" from EntityType.toString) and fall back to the Forge registry.
function pneHTypeId(entity) {
  if (!entity) return ''
  var raw = null
  var s = ''
  try { raw = entity.type; s = String(raw) } catch (e) { s = '' }
  if (s.indexOf(':') > 0) return s
  if ($PneHForgeRegistries && raw) {
    try {
      var key = $PneHForgeRegistries.ENTITY_TYPES.getKey(raw)
      if (key) return String(key)
    } catch (e2) { }
  }
  if (s.indexOf('entity.') === 0) {
    var parts = s.split('.')
    if (parts.length >= 3) return parts[1] + ':' + parts.slice(2).join('.')
  }
  return ''
}

function pneHIsParasiteId(id) {
  return PNE_H_HIVE[id] === true || PNE_H_SPORE[id] === true || PNE_H_BECKON[id] === true
}

function pneHHasTag(entity, tag) {
  try { return entity.getTags().contains(tag) } catch (e) { return false }
}

function pneHFmt(n) {
  var v = Number(n)
  return (isFinite(v) ? v : 0).toFixed(2)
}

function pneHPos(entity, yOffset) {
  return pneHFmt(entity.getX()) + ' ' + pneHFmt(Number(entity.getY()) + yOffset) + ' ' + pneHFmt(entity.getZ())
}

function pneHDim(entity) {
  try { return String(entity.level.dimension) } catch (e) { return PNE_H_OVERWORLD }
}

function pneHText(text, color) {
  return JSON.stringify({ text: text, color: color, italic: true })
}

function pneHPick(list) {
  return list[Math.floor(Math.random() * list.length)]
}

// Damage types that are not real deaths: /kill (genericKill) and the void (outOfWorld).
// DamageSource.getType() is KubeJS's @RemapForJS name for getMsgId().
function pneHIsCleanupDeath(source) {
  var t = ''
  try { t = String(source.getType()) } catch (e) {
    try { t = String(source.getMsgId()) } catch (e2) { t = '' }
  }
  return t === 'genericKill' || t === 'outOfWorld'
}

function pneHPlayerName(player) {
  try { return String(player.getGameProfile().getName()) } catch (e) { }
  try { return String(player.username) } catch (e2) { }
  try { return String(player.getName().getString()) } catch (e3) { }
  return 'someone'
}

// ---------------------------------------------------------------------------------------------
// Erosion stage and doom clock

var pneHStageCache = {}  // dim -> { stage, at }
var pneHTick = 0

function pneHFloorForDay(day) {
  var floor = '0'
  for (var i = 0; i < PNE_H_DOOM.length; i++) {
    if (day >= Number(PNE_H_DOOM[i][0])) floor = PNE_H_DOOM[i][1]
  }
  return floor
}

function pneHStageFromPoints(points) {
  for (var i = 0; i < PNE_H_STAGE_FROM_POINTS.length; i++) {
    if (points >= PNE_H_STAGE_FROM_POINTS[i][0]) return PNE_H_STAGE_FROM_POINTS[i][1]
  }
  return 0
}

// Overworld points from EPCA's own counter, or null when it cannot be read.
function pneHReadPoints(server) {
  if (!$PneHEvolutionManager) return null
  try {
    var p = Number($PneHEvolutionManager.getPointsForDimension(server.getOverworld()))
    return isFinite(p) ? p : null
  } catch (e) { return null }
}

// Stage for the level an entity died in. EPCA stages are per dimension. Cached for 600 ticks.
// If EPCA cannot be read, the overworld falls back to the stage of the stored doom floor and
// every other dimension returns -99 (reinforcements then stay off there).
function pneHStage(server, level, dim) {
  var c = pneHStageCache[dim]
  if (c && pneHTick - c.at < 600) return c.stage
  var stage = -99
  if ($PneHEvolutionManager && level) {
    try { stage = Number($PneHEvolutionManager.getStageForDimension(level)) } catch (e) { stage = -99 }
  }
  if (!isFinite(stage)) stage = -99
  if (stage === -99 && dim === PNE_H_OVERWORLD) {
    try { stage = pneHStageFromPoints(Number(server.persistentData.getInt('pne_doom_floor'))) } catch (e2) { stage = -99 }
  }
  pneHStageCache[dim] = { stage: stage, at: pneHTick }
  return stage
}

// Raises overworld points to the floor for the current world day. Never lowers them.
// The day comes from /time query day (returns dayTime / 24000 as an int), so no Mojang-named
// members are needed. setpoints bypasses EPCA's 24,000-tick stage-change cooldown.
function pneHDoomClock(server) {
  var day = Number(server.runCommandSilent('time query day'))
  if (!isFinite(day) || day <= 0) return
  var floorStr = pneHFloorForDay(day)
  var floor = Number(floorStr)
  if (floor <= 0) return
  var data = server.persistentData
  var applied = Number(data.getInt('pne_doom_floor'))
  var points = pneHReadPoints(server)
  var raise
  if (points !== null) {
    raise = points < floor
  } else {
    // Points unreadable: only act when the floor itself rises, so natural progress past the
    // floor is overwritten at most once per step (and only by the kills since the last step).
    raise = floor > applied
  }
  if (raise) {
    var ok = Number(server.runCommandSilent('epca_evolution setpoints ' + floorStr + ' ' + PNE_H_OVERWORLD))
    if (ok > 0) {
      data.putInt('pne_doom_floor', floor)
      pneHStageCache = {}
      console.info('[pne_horror] doom clock: day ' + day + ', overworld evolution points raised to ' + floorStr)
    }
  } else if (floor > applied) {
    data.putInt('pne_doom_floor', floor)
  }
}

// ---------------------------------------------------------------------------------------------
// 1. Call of the Hive inventory fix (players only)
//
// Mechanism (EPCA bytecode):
//  - EvolutionStageEvents.onLivingDrops (LivingDropsEvent, NORMAL priority): if the dimension's
//    stage >= 3 and the entity hasEffect(epca:coth), it cancels the event. No player check.
//  - PlayerDeathEventHandler.onPlayerDeath (LivingDeathEvent, NORMAL priority): for a server-side
//    player whose COTH amplifier is != 0 (level II+), it spawns a MediumIncompleteForm at the
//    player's exact position and removes COTH. For amplifier 0 (level I) it returns early and
//    COTH stays on the corpse.
//  - Corpse (corelib DeathEvents) listens to LivingDropsEvent at LOWEST without receiveCanceled,
//    so a cancelled event never reaches it and the items are thrown away.
// So only COTH I deaths lose the inventory: levels II+ are cleared by EPCA before the drops.
//
// Ordering: ServerPlayer.die fires LivingDeathEvent first, then dropAllDeathLoot fires
// LivingDropsEvent. KubeJS's EntityEvents.death comes from Architectury's LivingDeathEvent
// listener at HIGH priority, so this runs before EPCA's NORMAL handler and sees the real
// amplifier. Level I: remove COTH here, so EPCA's death handler returns early (no COTH) and its
// drops handler finds no COTH and does not cancel; Corpse gets the items. Level II+: leave it
// alone; EPCA spawns its own form and clears COTH itself, and one tick later this names that
// form. The logic does not depend on the order, because each case touches only the amplifier
// range EPCA ignores. startup_scripts/pne_hive_rules.js adds a LivingDropsEvent safety net.

var pneHCothEffect = null
function pneHCoth() {
  if (pneHCothEffect) return pneHCothEffect
  try { pneHCothEffect = $PneHForgeRegistries.MOB_EFFECTS.getValue(new $PneHResourceLocation('epca', 'coth')) } catch (e) { pneHCothEffect = null }
  return pneHCothEffect
}

function pneHAmplifier(instance) {
  try { return Number(instance.getAmplifier()) } catch (e) { }
  // MobEffectInstance.toString(): "effect.epca.coth x 2, Duration: 400" when amplifier > 0.
  try {
    var m = String(instance.toString()).match(/ x (\d+),/)
    if (m) return Number(m[1]) - 1
    return 0
  } catch (e2) { }
  return 0
}

EntityEvents.death('minecraft:player', function (event) {
  try {
    var player = event.entity
    var server = player.server
    if (!server) return
    var coth = pneHCoth()
    var instance = null
    if (coth) {
      try { instance = player.getEffect(coth) } catch (e) {
        try { instance = player.potionEffects.getActive(coth) } catch (e2) { instance = null }
      }
    }
    if (!instance) return
    var amp = pneHAmplifier(instance)
    if (amp <= 0) {
      var removed = false
      try { player.removeEffect(coth); removed = true } catch (e3) { removed = false }
      if (!removed) {
        // Fallback without Mojang names: clear every effect. The player is dying, and a dead
        // player's effects are dropped on respawn anyway.
        try { player.potionEffects.clear() } catch (e4) { }
      }
      return
    }
    // Level II+: EPCA's form appears at the player's exact position during this same event.
    var name = pneHPlayerName(player)
    var at = 'execute in ' + pneHDim(player) + ' positioned ' + pneHPos(player, 0) + ' run '
    var nameNbt = "'" + JSON.stringify({ text: 'What was once ' + name, color: 'dark_red' }) + "'"
    server.scheduleInTicks(1, function () {
      try {
        server.runCommandSilent(at + 'data merge entity @e[type=epca:medium_incomplete_form,distance=..1.5,sort=nearest,limit=1] {CustomName:' + nameNbt + ',PersistenceRequired:1b}')
      } catch (e5) { }
    })
  } catch (err) {
    console.warn('[pne_horror] COTH death fix failed: ' + err)
  }
})

// ---------------------------------------------------------------------------------------------
// 2. Parasite deaths: gore, Mobs Inside, reinforcement beckons. Player deaths: death lines.

var pneHGoreBudget = 10    // gore bursts per second, refilled in the tick handler
var pneHBurstBudget = 2    // Mobs Inside bursts per second
var pneHBeckonReadyAt = 0  // global 100-tick cooldown for reinforcement beckons

function pneHGore(server, at) {
  if (pneHGoreBudget <= 0) return
  pneHGoreBudget--
  server.runCommandSilent(at + 'particle minecraft:block minecraft:redstone_block ~ ~ ~ 0.35 0.45 0.35 0 40 normal')
  server.runCommandSilent(at + 'particle minecraft:block minecraft:nether_wart_block ~ ~ ~ 0.3 0.3 0.3 0 18 normal')
  server.runCommandSilent(at + 'playsound epca:slam hostile @a[distance=..24] ~ ~ ~ 0.7 0.7')
}

function pneHCount(server, cmd) {
  var n = Number(server.runCommandSilent(cmd))
  return isFinite(n) ? n : 0
}

// 50%: 2-3 living_flesh_size0 (EPCA merges these upward itself, data/epca/entity_integrations/
// living_flesh.json). 15%: one Mozzie. Burst spawns carry the pne_burst tag; they never burst
// (none are hosts) and never call beckons.
// Cap: at most 8 burst products within 24 blocks, counting every living flesh (#pne:flesh, which
// covers merged flesh that lost the tag) plus tagged non-flesh products (Mozzies).
// Hordes: while a player within 64 blocks is in a Hive Night horde, half of the bursts that
// would happen are skipped, so a horde's many kills do not snowball into a pile-up.
function pneHMobsInside(server, at) {
  var roll = Math.random()
  if (roll >= 0.65) return
  if (pneHBurstBudget <= 0) return
  if (pneHCount(server, at + 'execute if entity @a[tag=pne_horde,distance=..64]') > 0 && Math.random() < 0.5) return
  var nearby = pneHCount(server, at + 'execute if entity @e[type=#pne:flesh,distance=..24]') +
    pneHCount(server, at + 'execute if entity @e[tag=pne_burst,type=!#pne:flesh,distance=..24]')
  if (nearby >= 8) return
  pneHBurstBudget--
  if (roll < 0.5) {
    var n = 2 + Math.floor(Math.random() * 2)
    for (var i = 0; i < n; i++) {
      var dx = (Math.random() - 0.5).toFixed(2)
      var dz = (Math.random() - 0.5).toFixed(2)
      server.runCommandSilent(at + 'summon epca:living_flesh_size0 ~' + dx + ' ~0.3 ~' + dz + ' {Tags:["pne_burst"]}')
    }
  } else {
    server.runCommandSilent(at + 'summon epca:mozzie ~ ~0.6 ~ {Tags:["pne_burst"]}')
  }
  server.runCommandSilent(at + 'playsound minecraft:entity.slime.squish_small hostile @a[distance=..20] ~ ~ ~ 1 0.5')
  server.runCommandSilent(at + 'particle minecraft:block minecraft:nether_wart_block ~ ~0.4 ~ 0.25 0.25 0.25 0 24 normal')
}

// From stage 3: chance 2% + 1% per stage above 3, capped at 9% (stage 10), at most once per
// 100 ticks server-wide. EPCA's StageIBeckon converts blocks by contact, converts ground and
// leaves around it, places a beckon_core block, and breaks every block of hardness 0-3 in a
// 3x3x3 cube when it is inside a wall, all without checking doMobGriefing. So the beckon is
// placed only where that cannot grief a base, and every condition sits in one execute chain
// (the chain returns 1 only when the summon ran):
//  - a non-creative, non-spectator player is within 64 blocks (someone is there to hear it),
//  - no player at all is within 24 blocks (never on the player's doorstep or inside the base),
//  - no player within 128 blocks is in a Hive Night horde (no reinforcements during hordes),
//  - no other beckon within 32 blocks,
//  - the feet and head blocks are #minecraft:replaceable (open air, so never inside a wall),
//  - the block below is #pne:beckon_ground (natural ground only; see pne_tags.js).
// A parasite that dies in the air, on a floor, or next to the player simply calls nothing.
function pneHReinforce(server, entity, dim, atGround) {
  if (pneHTick < pneHBeckonReadyAt) return
  var stage = pneHStage(server, entity.level, dim)
  if (stage < 3) return
  var chance = Math.min(0.09, 0.02 + 0.01 * (stage - 3))
  if (Math.random() >= chance) return
  pneHBeckonReadyAt = pneHTick + 100
  var ok = Number(server.runCommandSilent(atGround + 'execute' +
    ' if entity @a[distance=..64,gamemode=!spectator,gamemode=!creative]' +
    ' unless entity @a[distance=..24]' +
    ' unless entity @a[tag=pne_horde,distance=..128]' +
    ' unless entity @e[type=#pne:beckon,distance=..32]' +
    ' if block ~ ~ ~ #minecraft:replaceable' +
    ' if block ~ ~1 ~ #minecraft:replaceable' +
    ' if block ~ ~-1 ~ #pne:beckon_ground' +
    ' run summon epca:stage_i_beckon ~ ~ ~ {Tags:["pne_called"]}'))
  if (ok > 0) {
    server.runCommandSilent(atGround + 'playsound minecraft:block.bell.use hostile @a[distance=..96] ~ ~ ~ 4 0.5')
    server.runCommandSilent(atGround + 'playsound epca:beckon_stage1 hostile @a[distance=..48] ~ ~ ~ 1.5 0.8')
  }
}

EntityEvents.death(function (event) {
  try {
    var victim = event.entity
    if (!victim) return
    var server = victim.server
    if (!server) return
    var source = event.source

    // Player killed by a parasite (directly, or by its projectile): a grim line for everyone.
    var isPlayer = false
    try { isPlayer = victim.isPlayer() } catch (e0) { isPlayer = false }
    if (isPlayer) {
      var killer = null
      try { killer = source.getActual() } catch (e1) { killer = null }
      if (killer && pneHIsParasiteId(pneHTypeId(killer))) {
        var name = pneHPlayerName(victim)
        var line = pneHPick(PNE_H_DEATH_LINES).split('%s').join(name)
        server.runCommandSilent('tellraw @a ' + pneHText(line, 'dark_red'))
      }
      return
    }

    var id = pneHTypeId(victim)
    if (!pneHIsParasiteId(id)) return
    if (pneHIsCleanupDeath(source)) return

    var dim = pneHDim(victim)
    var at = 'execute in ' + dim + ' positioned ' + pneHPos(victim, 0.6) + ' run '
    pneHGore(server, at)

    if (pneHHasTag(victim, 'pne_burst')) return
    if (PNE_H_HOST[id] === true) pneHMobsInside(server, at)
    if (PNE_H_BECKON[id] !== true && PNE_H_FLESH[id] !== true) {
      pneHReinforce(server, victim, dim, 'execute in ' + dim + ' positioned ' + pneHPos(victim, 0) + ' run ')
    }
  } catch (err) {
    console.warn('[pne_horror] death handler failed: ' + err)
  }
})

// ---------------------------------------------------------------------------------------------
// 3. Tick loop: doom clock, night aggression, whispers, Hive Night atmosphere.

var pneHNextWhisperAt = 4800
var pneHBroken = 0

function pneHDaytime(server) {
  var t = Number(server.runCommandSilent('time query daytime'))
  return isFinite(t) ? t : -1
}

function pneHIsNight(t) {
  return t >= 13000 && t <= 23000
}

// Overworld survivors only: "execute in overworld as @a[distance=0..]" limits @a to players in
// the overworld (a distance filter makes the selector world-limited).
var PNE_H_SURVIVORS = 'execute in ' + PNE_H_OVERWORLD + ' as @a[distance=0..,gamemode=!spectator,gamemode=!creative] at @s run '

// Night aggression. Spore decision: only the basic infected (#pne:spore_basic) get Speed I, and
// no Spore mob gets Strength. Spore's evolved, hyper and calamity tiers already out-damage EPCA's
// roster, and Spore escalates on its own (evolution, Signal reinforcements). Strength on top of
// vanilla Hard would push those tiers past survivable. Faster basic infected make the night
// feel like a hunt without adding burst damage. EPCA mobs get Speed I and Strength I.
function pneHNightAggression(server) {
  server.runCommandSilent(PNE_H_SURVIVORS + 'effect give @e[type=#pne:hive,distance=..48] minecraft:speed 7 0 true')
  server.runCommandSilent(PNE_H_SURVIVORS + 'effect give @e[type=#pne:hive,distance=..48] minecraft:strength 7 0 true')
  server.runCommandSilent(PNE_H_SURVIVORS + 'effect give @e[type=#pne:spore_basic,distance=..48] minecraft:speed 7 0 true')
}

// One survivor hears something 8 blocks behind them (rotated ~ 0 levels the pitch so "behind"
// is behind, not above). Sound only. No camera or screen effect.
function pneHWhisper(server) {
  var sound = pneHPick(PNE_H_WHISPERS)
  var pitch = (0.7 + Math.random() * 0.2).toFixed(2)
  server.runCommandSilent('execute in ' + PNE_H_OVERWORLD + ' as @r[distance=0..,gamemode=!spectator,gamemode=!creative] at @s rotated ~ 0 run playsound ' + sound + ' hostile @s ^ ^1 ^-8 0.6 ' + pitch)
}

// Hive Night atmosphere only. The Hordes spawns the horde itself (another track points its spawn
// table at parasites); nothing here spawns or converts mobs. startup_scripts/pne_hive_rules.js
// tags a player pne_horde on each wave The Hordes really starts (HordeStartWaveEvent, cancelled
// waves skipped) and resets that player's pne_horde_age score to 0; HordeEndEvent untags. So
// this follows the real horde, not a guessed day and not world daytime.
// Leftover cleanup (a missed end event after a crash or reload): the age score counts up while
// the tag is set, and the tags are removed once no wave has started for PNE_H_HORDE_STALE ticks.
// The Hordes starts a wave at the start of the horde and every hordeSpawnInterval ticks after
// (HordeEvent.update: timer % spawnInterval == 0; config: hordeSpawnDuration 6000, interval 2000),
// so 12000 ticks without a wave means the horde is over.
var PNE_H_HORDE_STALE = 12000

function pneHHiveNight(server, tick, daytime) {
  var told = Number(server.runCommandSilent('execute if entity @a[tag=pne_horde,tag=!pne_horde_told]'))
  if (told > 0) {
    server.runCommandSilent('tellraw @a[tag=pne_horde,tag=!pne_horde_told] ' + pneHText(pneHPick(PNE_H_HIVE_NIGHT_LINES), 'dark_red'))
    server.runCommandSilent('execute as @a[tag=pne_horde,tag=!pne_horde_told] at @s run playsound epca:beckon_stage2 hostile @s ~ ~ ~ 1 0.6')
    server.runCommandSilent('tag @a[tag=pne_horde,tag=!pne_horde_told] add pne_horde_told')
  }
  if (tick % 300 === 0) {
    server.runCommandSilent('execute as @a[tag=pne_horde] at @s run playsound spore:heart_beat hostile @s ~ ~ ~ 0.45 0.9')
    if (Math.random() < 0.3) {
      server.runCommandSilent('execute as @a[tag=pne_horde] at @s rotated ~ 0 run playsound epca:infested_enderman_scream hostile @s ^ ^2 ^-24 2 0.6')
    }
  }
  // Age the tag (this runs every 20 ticks). A player whose score was never set starts at 0.
  server.runCommandSilent('scoreboard players add @a[tag=pne_horde] pne_horde_age 20')
  if (tick % 600 === 0) {
    var stale = 'scores={pne_horde_age=' + PNE_H_HORDE_STALE + '..}'
    server.runCommandSilent('tag @a[tag=pne_horde,' + stale + '] remove pne_horde_told')
    server.runCommandSilent('tag @a[tag=pne_horde,' + stale + '] remove pne_horde')
    server.runCommandSilent('tag @a[tag=!pne_horde,tag=pne_horde_told] remove pne_horde_told')
    server.runCommandSilent('scoreboard players reset @a[tag=!pne_horde] pne_horde_age')
  }
}

ServerEvents.tick(function (event) {
  pneHTick++
  if (pneHTick % 20 !== 0) return
  if (pneHBroken >= 5) return
  try {
    var server = event.server
    pneHGoreBudget = 10
    pneHBurstBudget = 2

    // Hive Night age objective. Adding an objective that already exists fails harmlessly.
    if (pneHTick === 20) server.runCommandSilent('scoreboard objectives add pne_horde_age dummy')

    // Doom clock: once shortly after load, then every 1200 ticks.
    if (pneHTick === 200 || pneHTick % 1200 === 0) pneHDoomClock(server)

    var daytime = -1
    if (pneHTick % 100 === 0) {
      daytime = pneHDaytime(server)
      if (pneHIsNight(daytime)) pneHNightAggression(server)
    }

    if (pneHTick >= pneHNextWhisperAt) {
      pneHNextWhisperAt = pneHTick + 4200 + Math.floor(Math.random() * 1200)
      if (daytime < 0) daytime = pneHDaytime(server)
      if (pneHIsNight(daytime)) pneHWhisper(server)
    }

    // Every 20 ticks: one cheap "execute if entity" check and the age tick; heartbeat every 300,
    // stale-tag cleanup every 600.
    pneHHiveNight(server, pneHTick, daytime)
    pneHBroken = 0
  } catch (err) {
    pneHBroken++
    console.warn('[pne_horror] tick failed (' + pneHBroken + '/5): ' + err)
    if (pneHBroken >= 5) console.warn('[pne_horror] tick loop disabled until the next reload')
  }
})
