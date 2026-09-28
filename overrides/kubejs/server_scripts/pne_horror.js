// Parasites New Dawn - Enhanced :: scripted horror layer (server side)
//
// Owns: the doom clock, night aggression, gore, Mobs Inside bursts, reinforcement beckons,
// Hive Night atmosphere and the Call of the Hive inventory fix.
//
// Rules this file follows:
//  * World changes go through server.runCommandSilent(...). That source is the server at
//    permission 4 with output suppressed. entity.runCommandSilent is permission 0 for mobs.
//  * ES5 only for Rhino: var/function, no arrows, destructuring, spread or default params.
//  * Every handler body is wrapped in try/catch and fails safe (does nothing).
//  * The tick handler does real work at most once every 20 ticks (at the shared core's housekeeping
//    slot when pne_00_core.js is loaded, else on its own counter).
//  * The Hive Remembers (docs/IMPLEMENTATION.md 3.2.1): every sound goes through the director's
//    per-player sound ledger with pneCoreEmit (one player) or pneCoreEmitAt (positional, many
//    players), so comfort mode, the per-layer switches, the LF duty caps and the level-jump limits
//    bind these sounds too. Without the core (it failed to load) these sounds are skipped; all
//    other behaviour here is unchanged. The old whisper pool is retired (replaced by the director's
//    Susurrus layer). Scripted spawns (Mobs Inside bursts, reinforcement beckons) use the pacing
//    multipliers at the spawn point, and night aggression skips players tagged pne_pace_soft.
//    A reinforcement beckon rooted by a genome mob with an expressed FLK of at least 0.5 may be placed in the
//    nearest survival player's rear 120-degree arc at low block light (TDD 3.1 gene 4; pneHFlkPlan), under
//    the same rules as every other beckon. FLK changes only where such a beckon stands, never whether one
//    appears.
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

// Sound routing through the director's ledger (pne_00_core.js wrappers). meta.src 'horror' marks
// these as existing pack sounds; cls names the ledger rule that applies (TDD 2.5.5 table).
function pneHEmitPlayer(player, event, category, pos, vol, meta) {
  if (typeof pneCoreEmit !== 'function') return false
  return pneCoreEmit(player, event, category, pos, vol, meta)
}

function pneHEmitAt(server, where, radius, event, category, vol, meta) {
  if (typeof pneCoreEmitAt !== 'function' || !where) return 0
  return pneCoreEmitAt(server, where.dim, where.x, where.y, where.z, radius, event, category, vol, meta)
}

// Players carrying a tag (and optionally missing another), as a JS array.
function pneHTagged(server, tag, notTag) {
  var out = []
  var list = null
  var n = 0
  var i
  var p
  if (typeof pneCoreAllPlayers === 'function') {
    list = pneCoreAllPlayers(server)
    for (i = 0; i < list.length; i++) {
      p = list[i]
      if (pneHHasTag(p, tag) && (!notTag || !pneHHasTag(p, notTag))) out.push(p)
    }
    return out
  }
  try { list = server.getPlayers() } catch (e) { list = null }
  if (!list) return out
  try { n = Number(list.size()) } catch (e2) { n = 0 }
  for (i = 0; i < n; i++) {
    p = list.get(i)
    if (pneHHasTag(p, tag) && (!notTag || !pneHHasTag(p, notTag))) out.push(p)
  }
  return out
}

// Pacing multiplier for positional scripted spawns (1 when the core is absent: unchanged behaviour).
function pneHSpawnCount(level, where, count) {
  var m
  if (typeof pneCoreSpawnMultAt !== 'function' || typeof pneCoreSpawnCount !== 'function' || !where) return count
  m = pneCoreSpawnMultAt(level, where.x, where.y, where.z, 48)
  return pneCoreSpawnCount(count, m)
}

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

// The entity's level. In 1.20.1 Entity has a Mojang method level(), and Rhino prefers a method over a
// bean property of the same name (contract F27), so entity.level is that method, not KubeJS's
// getLevel(). Call the methods explicitly.
function pneHLevel(entity) {
  var l = null
  try { l = entity.getLevel() } catch (e) { l = null }
  if (l) return l
  try { l = entity.level() } catch (e2) { l = null }
  return l
}

function pneHDim(entity) {
  var lvl = pneHLevel(entity)
  var d = ''
  if (!lvl) return PNE_H_OVERWORLD
  if (typeof pneCoreDim === 'function') return pneCoreDim(lvl)
  try { d = String(lvl.getDimension()) } catch (e) { d = '' }
  if (d.indexOf(':') > 0) return d
  try { d = String(lvl.dimension().location()) } catch (e2) { d = '' }
  return d.indexOf(':') > 0 ? d : PNE_H_OVERWORLD
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

// The slam is low-frequency heavy (66-77% of its power below 100 Hz): the ledger treats it as an LF
// source (one at a time, duty caps, comfort volume 0.35 and a 10 s gap to other LF sounds).
function pneHGore(server, at, where) {
  if (pneHGoreBudget <= 0) return
  pneHGoreBudget--
  server.runCommandSilent(at + 'particle minecraft:block minecraft:redstone_block ~ ~ ~ 0.35 0.45 0.35 0 40 normal')
  server.runCommandSilent(at + 'particle minecraft:block minecraft:nether_wart_block ~ ~ ~ 0.3 0.3 0.3 0 18 normal')
  pneHEmitAt(server, where, 24, 'epca:slam', 'hostile', 0.7, { pitch: 0.7, lf: true, cls: 'slam', src: 'horror' })
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
// Pacing (The Hive Remembers): the burst makes pneCoreSpawnCount(n, m) products instead of n, with m
// the lowest scripted-spawn multiplier of the survival players within 48 blocks (0 near a player in
// mercy or respawn grace, so the burst is skipped there).
function pneHMobsInside(server, at, where, level) {
  var roll = Math.random()
  var n
  var k
  var i
  var dx
  var dz
  var nearby
  if (roll >= 0.65) return
  if (pneHBurstBudget <= 0) return
  if (pneHCount(server, at + 'execute if entity @a[tag=pne_horde,distance=..64]') > 0 && Math.random() < 0.5) return
  nearby = pneHCount(server, at + 'execute if entity @e[type=#pne:flesh,distance=..24]') +
    pneHCount(server, at + 'execute if entity @e[tag=pne_burst,type=!#pne:flesh,distance=..24]')
  if (nearby >= 8) return
  n = roll < 0.5 ? 2 + Math.floor(Math.random() * 2) : 1
  k = pneHSpawnCount(level, where, n)
  if (k <= 0) return
  pneHBurstBudget--
  for (i = 0; i < k; i++) {
    if (roll < 0.5) {
      dx = (Math.random() - 0.5).toFixed(2)
      dz = (Math.random() - 0.5).toFixed(2)
      server.runCommandSilent(at + 'summon epca:living_flesh_size0 ~' + dx + ' ~0.3 ~' + dz + ' {Tags:["pne_burst"]}')
    } else {
      server.runCommandSilent(at + 'summon epca:mozzie ~ ~0.6 ~ {Tags:["pne_burst"]}')
    }
  }
  pneHEmitAt(server, where, 20, 'minecraft:entity.slime.squish_small', 'hostile', 1, { pitch: 0.5, cls: 'squish', src: 'horror' })
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
// Pacing (The Hive Remembers): no beckon unless every survival player within 48 blocks of the spot may
// have one (pneCoreBeckonAt: CALM or UNEASE, not in mercy or grace), and the chain runs
// pneCoreSpawnCount(1, m) times (0 skips; a second run is stopped by the chain's own 32-block beckon
// check, so at most one beckon still appears).
// FLK (TDD 3.1 gene 4): after every rule above has passed, a dying genome mob with an expressed FLK of
// at least 0.5 may move the first run into the rear arc of the nearest survival player (pneHFlkPlan and
// pneHFlank below); the moved run is the same chain at the new spot, and when no probe summons the run
// falls back to the dying mob's position. A run is moved only when the same chain without its summon
// passes at the dying mob (pneHBeckonTest), so FLK changes where a beckon stands, never whether one
// appears: a kill next to the player still calls nothing. The bell and the call then sound where the
// beckon stands.
function pneHReinforce(server, entity, dim, atGround, where) {
  var stage
  var chance
  var lvl
  var k
  var i
  var plan = null
  var placed
  var ok = 0
  if (pneHTick < pneHBeckonReadyAt) return
  lvl = pneHLevel(entity)
  stage = pneHStage(server, lvl, dim)
  if (stage < 3) return
  chance = Math.min(0.09, 0.02 + 0.01 * (stage - 3))
  if (Math.random() >= chance) return
  pneHBeckonReadyAt = pneHTick + 100
  if (typeof pneCoreBeckonAt === 'function' && where && !pneCoreBeckonAt(lvl, where.x, where.y, where.z, 48)) return
  k = pneHSpawnCount(lvl, where, 1)
  if (k > 0) plan = pneHFlkPlan(server, entity, lvl, where, atGround)
  for (i = 0; i < k; i++) {
    if (i === 0 && plan) {
      placed = pneHFlank(server, lvl, dim, plan)
      if (placed) {
        atGround = placed.at
        where = placed.where
        ok++
        continue
      }
    }
    ok += Number(server.runCommandSilent(pneHBeckonCmd(atGround))) || 0
  }
  if (ok > 0) {
    pneHEmitAt(server, where, 96, 'minecraft:block.bell.use', 'hostile', 4, { pitch: 0.5, cls: 'bell', src: 'horror' })
    pneHEmitAt(server, where, 48, 'epca:beckon_stage1', 'hostile', 1.5, { pitch: 0.8, cls: 'beckon', src: 'horror' })
  }
}

// The chain of the rules above for one position (at = 'execute in <dim> positioned <x y z> run ').
function pneHBeckonCmd(at) {
  return at + 'execute' +
    ' if entity @a[distance=..64,gamemode=!spectator,gamemode=!creative]' +
    ' unless entity @a[distance=..24]' +
    ' unless entity @a[tag=pne_horde,distance=..128]' +
    ' unless entity @e[type=#pne:beckon,distance=..32]' +
    ' if block ~ ~ ~ #minecraft:replaceable' +
    ' if block ~ ~1 ~ #minecraft:replaceable' +
    ' if block ~ ~-1 ~ #pne:beckon_ground' +
    ' run summon epca:stage_i_beckon ~ ~ ~ {Tags:["pne_called"]}'
}

// The same chain without its summon: an execute whose last test passes returns 1 and changes nothing, so this
// asks whether today's placement at `at` would summon (used before a flank moves the beckon).
function pneHBeckonTest(at) {
  var c = pneHBeckonCmd(at)
  return c.substring(0, c.lastIndexOf(' run summon '))
}

// ---------------------------------------------------------------------------------------------
// FLK flank placement (The Hive Remembers, TDD 3.1 gene 4: reinforcements biased to the player's rear
// 120-degree arc at low block light). Only the scripted reinforcement beckon is placed this way; natural and
// ambient spawns are not moved by this change (docs/modules/director.md says why).
// When pneHReinforce has passed all of its rules (cooldown, stage, chance, pacing at the dying mob, k > 0):
//  - the dying mob's expressed FLK is pneCoreHiveInfo(mob).flk (HIVE's HiveInfo field, 0..1; null or no
//    genome keeps today's placement), and it must be at least PNE_H_FLK_MIN;
//  - the player is the nearest survival player within PNE_H_FLK_NEAR blocks of the dying mob, and the block
//    light at that player's feet (getBlock(...).getBlockLight()) must be at most PNE_H_FLK_LIGHT;
//  - the facing is the player's getYaw() (KubeJS's name, F37; getYRot() only as the mock fallback);
//  - then, with probability FLK, and only when today's chain would summon at the dying mob (pneHBeckonTest
//    there, one command: so FLK moves a beckon that would appear anyway and never adds one, and a kill within
//    24 blocks of a player still calls nothing), up to PNE_H_FLK_PROBES probes each draw an angle within
//    PNE_H_FLK_HALF degrees of straight behind the player and a horizontal distance PNE_H_FLK_R0..PNE_H_FLK_R1,
//    take the centre of that block column (so the spot lies 24-40 blocks away and inside the rear 120 degrees),
//    find natural ground within PNE_H_FLK_DY blocks of the player's feet level by block reads (no command: the
//    highest non-solid block standing on a solid #pne:beckon_ground block; a tree canopy is passed through to
//    the ground below it, a roof or a floor ends the column; 2 x PNE_H_FLK_DY + 2 block reads and at most
//    2 x (PNE_H_FLK_DY + 1) tag reads), check pacing at the spot (pneCoreBeckonAt and a scripted-spawn
//    multiplier above 0) and run pneHBeckonCmd there. The first chain that summons wins; the chain keeps every
//    rule of today's placement at the new spot. If no probe summons, the run falls back to the dying mob's
//    position, where the test passed.
// Cost: at most once per 100 ticks server-wide (the beckon cooldown): one HiveInfo, one light read, one test
// command, at most 8 x 14 block reads, 8 x 14 tag reads and 8 chain commands. A failure inside falls back to
// today's placement.
var PNE_H_FLK_MIN = 0.5
var PNE_H_FLK_LIGHT = 7
var PNE_H_FLK_NEAR = 64
var PNE_H_FLK_PROBES = 8
var PNE_H_FLK_R0 = 25
var PNE_H_FLK_R1 = 39
var PNE_H_FLK_HALF = 58
var PNE_H_FLK_DY = 6
var PNE_H_DEG = 0.017453292519943295   // pi / 180 as a literal: Math.PI is undefined in Rhino (F26)
var PNE_H_FLK_GROUND = 'pne:beckon_ground'   // BlockContainerJS.hasTag(ResourceLocation): KubeJS wraps the string
var PNE_H_FLK_CANOPY = 'minecraft:leaves'
var pneHFlkStats = { tests: 0, refused: 0, plans: 0, probes: 0, reads: 0, tags: 0, untagged: 0, commands: 0, placed: 0,
  fallbacks: 0, errors: 0 }

// Yaw in degrees (Minecraft: 0 faces +Z, 90 faces -X), NaN when unreadable.
function pneHYaw(entity) {
  var yaw = NaN
  try { yaw = Number(entity.getYaw()) } catch (e) { yaw = NaN }
  if (!isFinite(yaw)) {
    try { yaw = Number(entity.getYRot()) } catch (e2) { yaw = NaN }
  }
  return yaw
}

// Block light (0..15) of the block at x y z, NaN when unreadable.
function pneHBlockLight(level, x, y, z) {
  var v = NaN
  try { v = Number(level.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)).getBlockLight()) } catch (e) { v = NaN }
  return isFinite(v) ? v : NaN
}

// true / false for a solid block, null when the block cannot be read.
function pneHSolid(level, x, y, z) {
  var st = null
  pneHFlkStats.reads++
  try { st = level.getBlock(x, y, z).getBlockState() } catch (e) { st = null }
  if (!st) return null
  try { return st.isSolid() ? true : false } catch (e2) { }
  try { return st.isAir() ? false : true } catch (e3) { }
  return null
}

// true / false for a block in block tag `tag` ('ns:path'), null when the tag cannot be read.
function pneHBlockTag(level, x, y, z, tag) {
  var v
  pneHFlkStats.tags++
  try { v = level.getBlock(x, y, z).hasTag(tag) } catch (e) { return null }
  if (v === undefined || v === null) return null
  return v ? true : false
}

// Feet level of the highest non-solid block standing on a solid #pne:beckon_ground block in column bx, bz,
// within PNE_H_FLK_DY of the player's feet level fy; null when there is none or a block cannot be read.
// A tree canopy (#minecraft:leaves) is passed through and the scan goes on below it; any other solid surface
// that is not natural ground (a roof, a floor, planks) ends the search in this column, so no spot is looked for
// under a roof. When the ground tag cannot be read the surface is taken and the chain's own #pne:beckon_ground
// test decides. At most 2 x PNE_H_FLK_DY + 2 block reads and 2 x (PNE_H_FLK_DY + 1) tag reads (a surface needs a
// non-solid block above it, so at most every second level of the window is one).
function pneHFlkGround(level, bx, bz, fy) {
  var y
  var here
  var g
  var above = pneHSolid(level, bx, fy + PNE_H_FLK_DY, bz)
  if (above === null) return null
  for (y = fy + PNE_H_FLK_DY - 1; y >= fy - PNE_H_FLK_DY - 1; y--) {
    here = pneHSolid(level, bx, y, bz)
    if (here === null) return null
    if (here && !above) {
      g = pneHBlockTag(level, bx, y, bz, PNE_H_FLK_GROUND)
      if (g === null) {
        pneHFlkStats.untagged++
        return y + 1
      }
      if (g) return y + 1
      if (pneHBlockTag(level, bx, y, bz, PNE_H_FLK_CANOPY) !== true) return null
    }
    above = here
  }
  return null
}

// The nearest survival player within PNE_H_FLK_NEAR blocks of where, or null.
function pneHFlkNearest(level, where) {
  var ps
  var best = null
  var bd = 0
  var d
  var i
  if (typeof pneCorePlayersNear !== 'function') return null
  ps = pneCorePlayersNear(level, where.x, where.y, where.z, PNE_H_FLK_NEAR)
  for (i = 0; i < ps.length; i++) {
    try {
      d = Math.pow(Number(ps[i].getX()) - where.x, 2) + Math.pow(Number(ps[i].getY()) - where.y, 2) +
        Math.pow(Number(ps[i].getZ()) - where.z, 2)
    } catch (e) { d = NaN }
    if (isFinite(d) && (best === null || d < bd)) {
      best = ps[i]
      bd = d
    }
  }
  return best
}

// The flank plan for this reinforcement ({x, y, z, yaw} of the player), or null for today's placement. Draws
// Math.random() only when FLK, the player, the light and the yaw all qualify; after the draw, runs today's chain
// without its summon at the dying mob (atGround) and plans only when it passes.
function pneHFlkPlan(server, entity, level, where, atGround) {
  var info
  var flk
  var p
  var px
  var py
  var pz
  var yaw
  try {
    if (typeof pneCoreHiveInfo !== 'function' || !server || !level || !where || !atGround) return null
    info = pneCoreHiveInfo(entity)
    if (!info) return null
    flk = Number(info.flk)
    if (!(flk >= PNE_H_FLK_MIN)) return null
    p = pneHFlkNearest(level, where)
    if (!p) return null
    px = Number(p.getX())
    py = Number(p.getY())
    pz = Number(p.getZ())
    if (!isFinite(px) || !isFinite(py) || !isFinite(pz)) return null
    if (!(pneHBlockLight(level, px, py, pz) <= PNE_H_FLK_LIGHT)) return null
    yaw = pneHYaw(p)
    if (!isFinite(yaw)) return null
    if (Math.random() >= flk) return null
    pneHFlkStats.tests++
    if (!((Number(server.runCommandSilent(pneHBeckonTest(atGround))) || 0) > 0)) {
      pneHFlkStats.refused++
      return null
    }
    return { x: px, y: py, z: pz, yaw: yaw }
  } catch (err) {
    pneHFlkStats.errors++
    if (pneHFlkStats.errors <= 3) console.warn('[pne_horror] flank plan failed, beckon keeps its place: ' + err)
    return null
  }
}

// Probes the rear arc of plan. Returns { at, where } of the spot where the chain summoned, or null.
function pneHFlank(server, level, dim, plan) {
  var n
  var a
  var d
  var bx
  var bz
  var y
  var sx
  var sz
  var at
  var fy = Math.floor(plan.y)
  try {
    pneHFlkStats.plans++
    for (n = 0; n < PNE_H_FLK_PROBES; n++) {
      pneHFlkStats.probes++
      a = (plan.yaw + 180 + (2 * Math.random() - 1) * PNE_H_FLK_HALF) * PNE_H_DEG
      d = PNE_H_FLK_R0 + Math.random() * (PNE_H_FLK_R1 - PNE_H_FLK_R0)
      bx = Math.floor(plan.x - Math.sin(a) * d)
      bz = Math.floor(plan.z + Math.cos(a) * d)
      if (!isFinite(bx) || !isFinite(bz)) continue
      y = pneHFlkGround(level, bx, bz, fy)
      if (y === null) continue
      sx = bx + 0.5
      sz = bz + 0.5
      if (typeof pneCoreBeckonAt === 'function' && !pneCoreBeckonAt(level, sx, y, sz, 48)) continue
      if (typeof pneCoreSpawnMultAt === 'function' && !(Number(pneCoreSpawnMultAt(level, sx, y, sz, 48)) > 0)) continue
      at = 'execute in ' + dim + ' positioned ' + pneHFmt(sx) + ' ' + pneHFmt(y) + ' ' + pneHFmt(sz) + ' run '
      pneHFlkStats.commands++
      if ((Number(server.runCommandSilent(pneHBeckonCmd(at))) || 0) > 0) {
        pneHFlkStats.placed++
        return { at: at, where: { dim: dim, x: sx, y: y, z: sz } }
      }
    }
  } catch (err) {
    pneHFlkStats.errors++
    if (pneHFlkStats.errors <= 3) console.warn('[pne_horror] flank probe failed, beckon keeps its place: ' + err)
  }
  pneHFlkStats.fallbacks++
  return null
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
    var vx = Number(victim.getX())
    var vy = Number(victim.getY())
    var vz = Number(victim.getZ())
    var burstAt = { dim: dim, x: vx, y: vy + 0.6, z: vz }
    pneHGore(server, at, burstAt)

    if (pneHHasTag(victim, 'pne_burst')) return
    if (PNE_H_HOST[id] === true) pneHMobsInside(server, at, burstAt, pneHLevel(victim))
    if (PNE_H_BECKON[id] !== true && PNE_H_FLESH[id] !== true) {
      pneHReinforce(server, victim, dim, 'execute in ' + dim + ' positioned ' + pneHPos(victim, 0) + ' run ',
        { dim: dim, x: vx, y: vy, z: vz })
    }
  } catch (err) {
    console.warn('[pne_horror] death handler failed: ' + err)
  }
})

// ---------------------------------------------------------------------------------------------
// 3. Tick loop: doom clock, night aggression, Hive Night atmosphere.
// The old whisper pool (six EPCA/Spore clips spanning 29.8 LU) is retired: the director's Susurrus
// layer (pne_resonance.js, L5) replaces it, with its own switch (/pne resonance whispers off).

var pneHBroken = 0
var pneHRuns = 0      // 1 Hz runs done since load
var pneHClock = 0     // pneHRuns * 20: the job cadence below counts in ticks of 1 Hz runs

function pneHDaytime(server) {
  var t = Number(server.runCommandSilent('time query daytime'))
  return isFinite(t) ? t : -1
}

function pneHIsNight(t) {
  return t >= 13000 && t <= 23000
}

// Overworld survivors only: "execute in overworld as @a[distance=0..]" limits @a to players in
// the overworld (a distance filter makes the selector world-limited). Players the director tags
// pne_pace_soft (aggression below 1: RELEASE, mercy, grace, and PANIC on alternate runs) are left
// out, so mobs near them lose the 7 s buff when it runs out (TDD 2.5.5).
var PNE_H_SURVIVORS = 'execute in ' + PNE_H_OVERWORLD + ' as @a[distance=0..,gamemode=!spectator,gamemode=!creative,tag=!pne_pace_soft] at @s run '

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
// Sounds, per horde player through the ledger: the horde call (beckon stage 2), the Spore heartbeat
// every 300 ticks (an LF source: the ledger spaces it at least 35 s apart, 70 s in comfort mode, and
// never over another LF sound), and the distant scream (a stinger: never in comfort mode).
var PNE_H_HORDE_STALE = 12000

function pneHHiveNight(server, tick, daytime) {
  var fresh
  var horde
  var i
  var told = Number(server.runCommandSilent('execute if entity @a[tag=pne_horde,tag=!pne_horde_told]'))
  if (told > 0) {
    fresh = pneHTagged(server, 'pne_horde', 'pne_horde_told')
    server.runCommandSilent('tellraw @a[tag=pne_horde,tag=!pne_horde_told] ' + pneHText(pneHPick(PNE_H_HIVE_NIGHT_LINES), 'dark_red'))
    for (i = 0; i < fresh.length; i++) {
      pneHEmitPlayer(fresh[i], 'epca:beckon_stage2', 'hostile', '~ ~ ~', 1, { pitch: 0.6, cls: 'beckon2', src: 'horror' })
    }
    server.runCommandSilent('tag @a[tag=pne_horde,tag=!pne_horde_told] add pne_horde_told')
  }
  if (tick % 300 === 0) {
    horde = pneHTagged(server, 'pne_horde', null)
    for (i = 0; i < horde.length; i++) {
      pneHEmitPlayer(horde[i], 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' })
    }
    if (Math.random() < 0.3) {
      for (i = 0; i < horde.length; i++) {
        pneHEmitPlayer(horde[i], 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 2,
          { pitch: 0.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' })
      }
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

// Once per second: at the core's housekeeping slot (tick % 20 === 5) when pne_00_core.js is loaded,
// else on this file's own counter. Jobs keep their cadence in ticks through pneHClock.
function pneHDue() {
  if (typeof PNE_CORE_API === 'number' && typeof pneCoreSlot === 'number' && typeof PNE_CORE_SLOT_HOUSE === 'number') {
    return pneCoreSlot === PNE_CORE_SLOT_HOUSE
  }
  return pneHTick % 20 === 0
}

ServerEvents.tick(function (event) {
  pneHTick++
  if (!pneHDue()) return
  if (pneHBroken >= 5) return
  try {
    var server = event.server
    pneHRuns++
    pneHClock = pneHRuns * 20
    pneHGoreBudget = 10
    pneHBurstBudget = 2

    // Hive Night age objective. Adding an objective that already exists fails harmlessly.
    if (pneHClock === 20) server.runCommandSilent('scoreboard objectives add pne_horde_age dummy')

    // Doom clock: once shortly after load, then every 1200 ticks.
    if (pneHClock === 200 || pneHClock % 1200 === 0) pneHDoomClock(server)

    var daytime = -1
    if (pneHClock % 100 === 0) {
      daytime = pneHDaytime(server)
      if (pneHIsNight(daytime)) pneHNightAggression(server)
    }

    // Every run: one cheap "execute if entity" check and the age tick; heartbeat every 300 ticks,
    // stale-tag cleanup every 600.
    pneHHiveNight(server, pneHClock, daytime)
    pneHBroken = 0
  } catch (err) {
    pneHBroken++
    console.warn('[pne_horror] tick failed (' + pneHBroken + '/5): ' + err)
    if (pneHBroken >= 5) console.warn('[pne_horror] tick loop disabled until the next reload')
  }
})
