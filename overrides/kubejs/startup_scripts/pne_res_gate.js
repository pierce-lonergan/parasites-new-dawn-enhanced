// Parasites New Dawn - Enhanced :: The Hive Remembers, natural-spawn gate (startup)
//
// docs/IMPLEMENTATION.md 3.4. Forge fires MobSpawnEvent$PositionCheck from NaturalSpawner and BaseSpawner;
// setResult(DENY) makes ForgeEventFactory.checkSpawnPosition return false, so the spawn never happens
// (verified in the Forge 47.4.10 bytecode, contract F18). EntityEvents.checkSpawn is NOT used: Architectury
// maps KubeJS's cancel() to "not cancelled" there (F17).
//
// For EPCA and Spore mobs (not the two beckons) the gate takes m = the lowest, over survival players within 48
// blocks, of: 0 for a player in mercy (tag pne_mercy, or health <= 30%) or live respawn grace (tag pne_grace
// with persistentData.pne_grace_until > now); else the director's persistentData.pne_m (0..1) while tag pne_gate
// is set and pne_m_t is 0..100 ticks old; else 1. The spawn is denied with probability 1 - m. This is exactly
// pneCoreNaturalMult / pneCoreNaturalMultAt in the server core, so mercy and grace gating keep working with the
// resonance pillar off, and a stale tag left by a stopped module expires on its own. Multipliers above 1 never
// add natural spawns. /pne config spawn_gate 0 switches the gate off (read from global.pneCfgSpawnGate).
//
// Startup scripts cannot see server-script names; this file reads only tags, persistent data and the global
// key pneCfgSpawnGate. Every value read from global is a wrapped Java object (contract F6), so it is converted
// with Number() after an undefined/null check and never compared strictly as it is.
// The game time is read with level.getTime(): KubeJS shows Level.getGameTime() to scripts only under that name
// (contract F37); getGameTime() stays as the fallback for mock levels. When neither reads, the check still runs
// with the time unknown: the mercy tag and health <= 30% still give m = 0, only live grace and pne_gate (which
// need the time) cannot count. That is logged once as a gate failure and counted once toward the error limit.
// Fails safe: errors are counted, the first three logged, and after 20 the gate turns itself off (no denies).
// ES5 only (Rhino); every var at the top of its function.

var $PneResGateResult = null
try { $PneResGateResult = Java.loadClass('net.minecraftforge.eventbus.api.Event$Result') } catch (e) { $PneResGateResult = null }

var PNE_RES_GATE_RADIUS = 48
var PNE_RES_GATE_FRESH = 100
var PNE_RES_GATE_GRACE = 2400
var PNE_RES_GATE_MERCY = 0.30
var pneResGateErrors = 0
var pneResGateOff = false
var pneResGateDenied = 0
var pneResGateTimeFails = 0   // checks that ran without a readable game time (grace and pne_gate could not count)

// Registry id of an entity ('epca:ripper') or ''. entity.type is KubeJS's id string in game; getEncodeId()
// and 'entity.<ns>.<path>' are the fallbacks (contract F28).
function pneResGateTypeId(entity) {
  var s = ''
  var k = null
  var parts
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

function pneResGateHasTag(entity, tag) {
  try { return entity.getTags().contains(tag) ? true : false } catch (e) { return false }
}

function pneResGatePD(entity) {
  try { return entity.persistentData } catch (e) { }
  try { return entity.getPersistentData() } catch (e2) { }
  return null
}

function pneResGateSurvival(player) {
  var spec = false
  var crea = false
  try { spec = player.isSpectator() ? true : false } catch (e) { spec = false }
  try { crea = player.isCreative() ? true : false } catch (e2) { crea = false }
  return !spec && !crea
}

// One player's multiplier (0..1), with the freshness rules of contract 3.4.
function pneResGatePlayerMult(p, now) {
  var pd = pneResGatePD(p)
  var h = NaN
  var mh = NaN
  var until = 0
  var t = 0
  var m = 1
  if (pneResGateHasTag(p, 'pne_mercy')) return 0
  if (pneResGateHasTag(p, 'pne_grace')) {
    try { until = Number(pd.getLong('pne_grace_until')) } catch (e) { until = 0 }
    if (until > now && until - now <= PNE_RES_GATE_GRACE) return 0
  }
  try { h = Number(p.getHealth()); mh = Number(p.getMaxHealth()) } catch (e2) { h = NaN }
  if (mh > 0 && isFinite(h) && h <= PNE_RES_GATE_MERCY * mh) return 0
  if (!pneResGateHasTag(p, 'pne_gate')) return 1
  try { t = Number(pd.getLong('pne_m_t')) } catch (e3) { t = 0 }
  if (!(t > 0 && now - t >= 0 && now - t <= PNE_RES_GATE_FRESH)) return 1
  try { m = Number(pd.getDouble('pne_m')) } catch (e4) { m = 1 }
  if (!isFinite(m)) return 1
  return m < 0 ? 0 : (m > 1 ? 1 : m)
}

// Game time of a ServerLevel, or NaN when it cannot be read (never throws). In game only getTime() exists
// (KubeJS's @RemapForJS("getTime") on Level.getGameTime(), merged by Mixin: contract F37); getGameTime() is
// tried second, for mock levels.
function pneResGateNow(level) {
  var t = NaN
  try { t = Number(level.getTime()) } catch (e) { t = NaN }
  if (!isFinite(t)) {
    try { t = Number(level.getGameTime()) } catch (e2) { t = NaN }
  }
  return isFinite(t) ? t : NaN
}

// The time could not be read: counted every time, logged and charged to the error limit once, so the TESTING.md
// log check sees it but a level without a readable clock never switches the mercy gating off.
function pneResGateTimeFail() {
  pneResGateTimeFails++
  if (pneResGateTimeFails !== 1) return
  pneResGateErrors++
  console.warn('[pne_res_gate] spawn gate failed (' + pneResGateErrors + '/20): the level game time is unreadable ' +
    '(getTime/getGameTime); mercy and low health still gate natural spawns, respawn grace and pne_gate cannot')
  if (pneResGateErrors >= 20) {
    pneResGateOff = true
    console.warn('[pne_res_gate] spawn gate disabled after repeated errors (spawns are no longer gated)')
  }
}

// Lowest multiplier among survival players within 48 blocks of x, y, z (1 when nobody is near).
function pneResGateMultAt(level, x, y, z, now) {
  var list = null
  var n = 0
  var best = 1
  var i
  var p
  var dx
  var dy
  var dz
  var m
  try { list = level.players() } catch (e) { list = null }
  if (!list) return 1
  try { n = Number(list.size()) } catch (e2) { n = 0 }
  for (i = 0; i < n; i++) {
    p = list.get(i)
    if (!pneResGateSurvival(p)) continue
    try { dx = Number(p.getX()) - x; dy = Number(p.getY()) - y; dz = Number(p.getZ()) - z } catch (e3) { continue }
    if (dx * dx + dy * dy + dz * dz > PNE_RES_GATE_RADIUS * PNE_RES_GATE_RADIUS) continue
    m = pneResGatePlayerMult(p, now)
    if (m < best) best = m
  }
  return best
}

// The whole gate for one event. Returns true when it denied the spawn.
function pneResGateCheck(event) {
  var g = global.pneCfgSpawnGate
  var mob
  var id
  var level = null
  var now
  var x
  var y
  var z
  var m
  if (g !== undefined && g !== null && Number(g) === 0) return false
  if (!$PneResGateResult) return false
  mob = event.getEntity()
  if (!mob) return false
  id = pneResGateTypeId(mob)
  if (id.indexOf('epca:') !== 0 && id.indexOf('spore:') !== 0) return false
  if (id === 'epca:stage_i_beckon' || id === 'epca:stage_ii_beckon') return false
  try { level = event.getLevel().getLevel() } catch (e) { level = null }
  if (!level) return false
  // never return early here: without the time, mercy (tag or health) must still gate (safety floor)
  now = pneResGateNow(level)
  if (!isFinite(now)) pneResGateTimeFail()
  try {
    x = Number(event.getX())
    y = Number(event.getY())
    z = Number(event.getZ())
  } catch (e3) {
    x = Number(mob.getX())
    y = Number(mob.getY())
    z = Number(mob.getZ())
  }
  m = pneResGateMultAt(level, x, y, z, now)
  if (Math.random() >= m) {
    event.setResult($PneResGateResult.DENY)
    pneResGateDenied++
    return true
  }
  return false
}

function pneResGateOnEvent(event) {
  if (pneResGateOff) return
  try {
    pneResGateCheck(event)
  } catch (err) {
    pneResGateErrors++
    if (pneResGateErrors <= 3) console.warn('[pne_res_gate] spawn gate failed (' + pneResGateErrors + '/20): ' + err)
    if (pneResGateErrors >= 20) {
      pneResGateOff = true
      console.warn('[pne_res_gate] spawn gate disabled after repeated errors (spawns are no longer gated)')
    }
  }
}

if (!$PneResGateResult) console.warn('[pne_res_gate] Event$Result is unavailable; the natural-spawn gate cannot deny spawns')
try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.living.MobSpawnEvent$PositionCheck', pneResGateOnEvent)
} catch (regErr) {
  console.warn('[pne_res_gate] could not register the natural-spawn gate: ' + regErr)
}
