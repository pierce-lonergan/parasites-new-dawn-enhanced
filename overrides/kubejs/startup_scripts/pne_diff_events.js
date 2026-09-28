// Parasites New Dawn - Enhanced :: The Hive Remembers, difficulty profile Forge listeners (startup)
//
// docs/IMPLEMENTATION.md 1.5 (difficulty profiles, table A rows 16 and 17). Owner: CORE. The core
// (server_scripts/pne_00_core.js) reads the vanilla difficulty (or the /pne config diff_profile pin) and mirrors the
// active profile id to global.pneDiffProfile: 0 Peaceful, 1 Easy, 2 Normal, 3 Hard. Every value read from global is a
// wrapped Java object (F6), so it is converted with Number() after an undefined/null check; absent means 3 (Hard), which
// is exactly the behaviour of release 1.4. Startup scripts cannot see server-script names, so the two factor tables
// below repeat PNE_CORE_DIFF[i].spore and .horde (suite diff-events-rhino asserts they are equal).
//
//   1. LivingHurtEvent (before armour, F21): a player hurt by a Spore mob (the damage source's causing entity, which is
//      the owner for projectiles; KubeJS names it getActual(), F37) takes amount x PNE_DIFF_SPORE_K[profile]. Spore
//      builds its damage sources with the attacking mob as the causing entity (SdamageTypes.damageSource(Entity, key),
//      javap of spore_1.20.1_2.2.0j) and most of its damage types are "scaling": "never", so vanilla Easy never softens
//      them. Damage without a causing entity (ownerless hazards) is not scaled.
//   2. HordeBuildSpawnDataEvent (The Hordes 1.6.3i, @Cancelable; javap: getSpawnData() returns HordeSpawnData with
//      getSpawnAmount()/setSpawnAmount(int)), heard at LOWEST so the amount is final after every other listener: the
//      wave size becomes max(1, floor(amount x PNE_DIFF_HORDE_K[profile])); on Peaceful the event is cancelled. The
//      Hordes posts it once per horde (HordeEvent.tryStartEvent, when spawnData is still null) and keeps the result in
//      its saved data, so a wave is never scaled twice, not even across a restart.
//      Peaceful also moves the player's horde schedule on (pneDiffSkipHorde). A cancel alone leaves The Hordes on the
//      overdue day: tryStartEvent returns right after a cancelled HordeBuildSpawnDataEvent, before setNextDay(player)
//      (javap, offsets 158-178 against 302-308), so the attempt repeats on every tick of the 1200-tick start buffer
//      each day, and from the next day on HordeEvent.isHordeDay (now >= (nextDay + 1) x dayLength) makes The Hordes'
//      own canSleepDuringHorde = false refuse every bed, which would defeat row 18 on Peaceful. So the listener sets
//      nextDay the way a horde that ran would have (HordeSavedData.getNextDay(nextDay), the same seeded step), until it
//      is past today, marks The Hordes' saved data dirty and cancels. The horde's own 'day' (its size count) is not
//      advanced: a skipped horde does not make later ones bigger. If the schedule cannot be moved (an API change), the
//      horde runs with a spawn amount of 0 instead of being cancelled, which lets The Hordes move the schedule itself.
//
// Hard (and, for Spore damage, Normal) returns before touching the event: those profiles are bit for bit release 1.4.
// Fails safe, per listener: each counts its own errors, logs the first three and stops after 20 (the damage or wave
// then stays unscaled). ES5 only (Rhino); every var at the top of its function.

var $PneDiffForge = null
var $PneDiffPriority = null
var $PneDiffHordeEvent = null
try { $PneDiffForge = Java.loadClass('net.minecraftforge.common.MinecraftForge') } catch (e) { $PneDiffForge = null }
try { $PneDiffPriority = Java.loadClass('net.minecraftforge.eventbus.api.EventPriority') } catch (e) { $PneDiffPriority = null }
try { $PneDiffHordeEvent = Java.loadClass('net.smileycorp.hordes.common.event.HordeBuildSpawnDataEvent') } catch (e) { $PneDiffHordeEvent = null }
var $PneDiffHordeData = null
try { $PneDiffHordeData = Java.loadClass('net.smileycorp.hordes.hordeevent.capability.HordeSavedData') } catch (e) { $PneDiffHordeData = null }

// Index = profile id (0 Peaceful, 1 Easy, 2 Normal, 3 Hard); equal to PNE_CORE_DIFF[i].spore / .horde in the core.
var PNE_DIFF_SPORE_K = [0.5, 0.70, 1.0, 1.0]
var PNE_DIFF_HORDE_K = [0, 0.6, 0.8, 1.0]
// hordes-common.toml hordeSpawnDays: the schedule step when HordeSavedData.getNextDay cannot be called.
var PNE_DIFF_HORDE_DAYS = 7
var PNE_DIFF_LIMIT = 20
var pneDiffHordeEmptyWarned = false
var pneDiffB = {
  spore: { n: 0, off: false, what: 'Spore damage to players is no longer scaled by the difficulty profile' },
  horde: { n: 0, off: false, what: 'Hordes waves are no longer scaled by the difficulty profile' }
}
var pneDiffHordeHooked = false

function pneDiffFail(where, err) {
  var b = pneDiffB[where]
  if (!b) return
  b.n++
  if (b.n <= 3) console.warn('[pne_diff_events] ' + where + ' listener error (' + b.n + '/' + PNE_DIFF_LIMIT + '): ' + err)
  if (b.n >= PNE_DIFF_LIMIT && !b.off) {
    b.off = true
    console.warn('[pne_diff_events] ' + where + ' listener stopped after repeated errors (' + b.what + ')')
  }
}

// The active profile id 0..3 from global.pneDiffProfile (a wrapped Double, F6); 3 when absent or unreadable.
function pneDiffProfile() {
  var v = global.pneDiffProfile
  var p = (v === undefined || v === null) ? 3 : Number(v)
  if (!(p >= 0 && p <= 3)) return 3
  return Math.floor(p)
}

// Registry id ('spore:knight') or ''. entity.type is KubeJS's id string in game (F28); getEncodeId() and
// 'entity.<ns>.<path>' are the fallbacks.
function pneDiffTypeId(entity) {
  var s = ''
  var k = null
  var parts
  if (!entity) return ''
  try { s = String(entity.type) } catch (e) { s = '' }
  if (s.indexOf(':') > 0) return s
  try { k = entity.getEncodeId(); s = (k === null || k === undefined) ? '' : String(k) } catch (e2) { s = '' }
  if (s.indexOf(':') > 0) return s
  try { s = String(entity.type) } catch (e3) { s = '' }
  if (s.indexOf('entity.') === 0) {
    parts = s.split('.')
    if (parts.length >= 3) return parts[1] + ':' + parts.slice(2).join('.')
  }
  return ''
}

function pneDiffIsPlayer(entity) {
  try { return entity.isPlayer() ? true : false } catch (e) { return false }
}

// The causing entity (the owner for projectiles) or null: DamageSource.getEntity() is visible to scripts only as
// getActual() (F37); getEntity() stays as the fallback for mocks.
function pneDiffAttacker(src) {
  var a = null
  if (!src) return null
  try { a = src.getActual() } catch (e) { a = null }
  if (a === null || a === undefined) {
    try { a = src.getEntity() } catch (e2) { a = null }
  }
  return (a === null || a === undefined) ? null : a
}

// 1. Spore-to-player damage
function pneDiffOnHurt(event) {
  var k
  var victim
  var att
  var amt
  if (pneDiffB.spore.off) return
  try {
    k = PNE_DIFF_SPORE_K[pneDiffProfile()]
    if (!(k >= 0) || k === 1) return
    victim = event.getEntity()
    if (!victim || !pneDiffIsPlayer(victim)) return
    att = pneDiffAttacker(event.getSource())
    if (!att || pneDiffTypeId(att).indexOf('spore:') !== 0) return
    amt = Number(event.getAmount())
    if (!(amt > 0)) return
    event.setAmount(amt * k)
  } catch (err) {
    pneDiffFail('spore', err)
  }
}

// Peaceful: moves the player's horde schedule past today, as a horde that ran would have (see the header). Returns true
// when HordeEvent.getNextDay() reads back later than today (then the cancel cannot leave the horde overdue), false when
// the schedule cannot be read or moved. Called for the build event of tryStartEvent (the scheduled start) and of
// spawnWave (the /hordes command); when the next day is already past today nothing is changed.
function pneDiffSkipHorde(event) {
  var h = null
  var pl = null
  var sd = null
  var today = NaN
  var cur = NaN
  var nd
  var nx
  var n = 0
  try { h = event.getHorde() } catch (e) { h = null }
  if (!h) return false
  try { pl = event.getPlayer() } catch (e1) { pl = null }
  // the day The Hordes compares with nextDay (HordeEventHandler.playerTick: HordeEvent.getCurrentDay(player))
  try { today = Number(h.getCurrentDay(pl)) } catch (e2) { today = NaN }
  if (!(today >= 0)) {
    try { today = Number(event.getDay()) } catch (e3) { today = NaN }
  }
  try { cur = Number(h.getNextDay()) } catch (e4) { cur = NaN }
  if (!(today >= 0) || !isFinite(cur)) return false
  nd = Math.floor(cur)
  if (nd <= today) {
    try { sd = $PneDiffHordeData ? $PneDiffHordeData.getData(event.getEntityWorld()) : null } catch (e5) { sd = null }
    while (nd <= today && n < 64) {
      nx = NaN
      try { nx = sd ? Number(sd.getNextDay(nd)) : NaN } catch (e6) { nx = NaN }
      nd = (nx > nd && isFinite(nx)) ? Math.floor(nx) : nd + PNE_DIFF_HORDE_DAYS
      n++
    }
    if (nd <= today) nd += Math.ceil((today + 1 - nd) / PNE_DIFF_HORDE_DAYS) * PNE_DIFF_HORDE_DAYS
    try { h.setNextDay(nd) } catch (e7) { return false }
    // HordeEvent.setNextDay(int) does not mark The Hordes' SavedData dirty; without it a restart before anything else
    // dirties it would load the overdue day again (the next start window would then skip it again)
    try { if (sd) sd.setDirty() } catch (e8) { }
  }
  try { return Number(h.getNextDay()) > today } catch (e9) { return false }
}

// 2. Hordes wave size
function pneDiffOnHorde(event) {
  var p
  var k
  var d
  var n
  if (pneDiffB.horde.off) return
  try {
    p = pneDiffProfile()
    k = PNE_DIFF_HORDE_K[p]
    if (!(k >= 0) || k === 1) return
    if (p === 0) {
      if (pneDiffSkipHorde(event)) {
        event.setCanceled(true)
        return
      }
      // the schedule could not be moved: a cancel would leave this player's horde overdue for good, so the horde runs
      // with no mobs instead (The Hordes then moves its schedule on by itself)
      d = event.getSpawnData()
      if (d) d.setSpawnAmount(0)
      if (!pneDiffHordeEmptyWarned) {
        pneDiffHordeEmptyWarned = true
        console.warn('[pne_diff_events] Peaceful: the Hordes schedule could not be moved, so the horde runs with no mobs instead of being cancelled')
      }
      return
    }
    d = event.getSpawnData()
    if (!d) return
    n = Number(d.getSpawnAmount())
    if (!(n >= 0)) return
    d.setSpawnAmount(Math.max(1, Math.floor(n * k)))
  } catch (err) {
    pneDiffFail('horde', err)
  }
}

try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.living.LivingHurtEvent', pneDiffOnHurt)
} catch (regErr) {
  console.warn('[pne_diff_events] could not register LivingHurtEvent (Spore damage stays unscaled): ' + regErr)
}
try {
  if ($PneDiffForge && $PneDiffPriority && $PneDiffHordeEvent) {
    $PneDiffForge.EVENT_BUS.addListener($PneDiffPriority.LOWEST, false, $PneDiffHordeEvent, pneDiffOnHorde)
    pneDiffHordeHooked = true
  }
} catch (regErr2) {
  pneDiffHordeHooked = false
}
if (!pneDiffHordeHooked) console.warn('[pne_diff_events] The Hordes wave-size listener is unavailable (HordeBuildSpawnDataEvent not hooked): waves keep their size')
