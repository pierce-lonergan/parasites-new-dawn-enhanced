// Parasites New Dawn - Enhanced :: horde leftovers cleanup (server side)
//
// Why: The Hordes 1.6.3i HordeEvent.stopEvent clears its entitiesSpawned set at bytecode offset 0, before
// the loop that would remove HordeTrackPlayerGoal, the +75 follow-range modifier and the tracked player
// from each horde mob. So that cleanup never runs: every surviving horde mob keeps hunting after dawn with
// a ~91 block follow range. EPCA mobs never despawn (AbstractEpcaEntity.removeWhenFarAway is false), and
// hordeSpawnMax only counts the current event, so survivors would pile up over 14+ hordes.
//
// What: every horde mob carries the scoreboard tag pne_horde_mob (set through the nbt field of every entry in
// kubejs/data/hordes/horde_data/tables/*.json). In daylight (daytime 0-11999) and while no player has an
// active horde (players carry the tag pne_horde during a horde, see startup_scripts/pne_hive_rules.js), this
// removes tagged mobs with Entity.discard(). discard is not a death: no drops, no EPCA or KubeJS death burst,
// no conversion. Mobs within 24 blocks of a survival or adventure player are left alone for that pass so
// nothing vanishes in front of the player; they are removed on a later pass once the player moves away.
// Only loaded entities are seen; leftovers in unloaded chunks are removed on a later day when they load.
//
// Throttled to every 200 ticks, and the entity list is only walked when a cheap selector count finds
// tagged mobs. ES5 only (Rhino). Wrapped in try/catch; disables itself after repeated failures.

var PNE_CULL_TAG = 'pne_horde_mob'
var PNE_CULL_KEEP = 'pne_horde_keep'
var PNE_CULL_KEEP_RADIUS = 24
var PNE_CULL_MAX_PER_PASS = 200
var pneCullTick = 0
var pneCullBroken = 0

function pneCullHasTag(entity, tag) {
  try { return entity.getTags().contains(tag) ? true : false } catch (e) { }
  try { return entity['m_19880_']().contains(tag) ? true : false } catch (e2) { }
  return false
}

function pneCullDiscard(entity) {
  try { entity.discard(); return true } catch (e) { }
  // SRG name of Entity.discard() in 1.20.1 (confirmed by Clumps' mixin refmap: discard()V -> m_146870_()V).
  try { entity['m_146870_'](); return true } catch (e2) { }
  return false
}

function pneCullIsPlayer(entity) {
  try { return entity.isPlayer() ? true : false } catch (e) { return false }
}

function pneCullCull(server) {
  var tod = Number(server.runCommandSilent('time query daytime'))
  if (!isFinite(tod) || tod < 0 || tod >= 12000) return
  if (Number(server.runCommandSilent('execute if entity @a[tag=pne_horde]')) > 0) return
  var tagged = Number(server.runCommandSilent('execute if entity @e[type=!minecraft:player,tag=' + PNE_CULL_TAG + ']'))
  if (!(tagged > 0)) return

  server.runCommandSilent('execute as @a[gamemode=!spectator,gamemode=!creative] at @s run tag @e[type=!minecraft:player,tag=' +
    PNE_CULL_TAG + ',distance=..' + PNE_CULL_KEEP_RADIUS + '] add ' + PNE_CULL_KEEP)

  var removed = 0
  var failed = 0
  try {
    var list = server.getEntities()
    var n = list.size()
    for (var i = 0; i < n && removed < PNE_CULL_MAX_PER_PASS; i++) {
      var entity = list.get(i)
      if (!entity || pneCullIsPlayer(entity)) continue
      if (!pneCullHasTag(entity, PNE_CULL_TAG) || pneCullHasTag(entity, PNE_CULL_KEEP)) continue
      if (pneCullDiscard(entity)) removed++
      else failed++
    }
  } finally {
    server.runCommandSilent('tag @e[tag=' + PNE_CULL_KEEP + '] remove ' + PNE_CULL_KEEP)
  }
  if (removed > 0) console.info('[pne_horde_cull] removed ' + removed + ' horde leftovers after dawn')
  if (failed > 0) throw new Error('discard failed for ' + failed + ' horde mobs')
}

ServerEvents.tick(function (event) {
  pneCullTick++
  if (pneCullTick % 200 !== 0) return
  if (pneCullBroken >= 5) return
  try {
    pneCullCull(event.server)
    pneCullBroken = 0
  } catch (err) {
    pneCullBroken++
    console.warn('[pne_horde_cull] pass failed (' + pneCullBroken + '/5): ' + err)
    if (pneCullBroken >= 5) console.warn('[pne_horde_cull] disabled until the next reload')
  }
})
