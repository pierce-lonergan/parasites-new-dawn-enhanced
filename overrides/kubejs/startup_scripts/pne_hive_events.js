// Parasites New Dawn - Enhanced :: The Hive Remembers, hive Forge listeners (startup)
//
// docs/IMPLEMENTATION.md 3.3. ForgeEvents is bound only in startup scripts (contract F22), so the four Forge
// events the hive runtime (server_scripts/pne_hive.js) needs are heard here. Every listener does O(1) work:
//
//   1. EntityJoinLevelEvent (F35): an EPCA/Spore mob that was NOT loaded from disk gets
//      persistentData.pne_fresh = 1b while the hive is on (the spawned-discard backstop only ever acts on such
//      mobs, so parasites saved in a chunk are never discarded when the chunk loads). A mob that IS loaded from
//      disk loses any pne_fresh it was saved with (it joined fresh and was unloaded before the hive drained it).
//   2. LivingDamageEvent (F20, F21): fires before setHealth, so the victim's health is the health at impact.
//      Player victim hit by a parasite (the causing entity, which is the owner for projectiles): one damage
//      record with the post-mitigation amount and k_mercy (binding formula, contract 3.3):
//        k = (hp <= 0.30 * maxHp || live grace || tag pne_mercy) ? 0 : 1
//      where live grace = tag pne_grace and pne_grace_until > game time (and at most 2400 ahead, exactly
//      pneCoreGraceLive). A blow that kills a player also leaves a fatal record with the damage msgId (the hive
//      gives no kill credit for fall, void or /kill deaths). A genome mob hit by a player leaves a first-strike
//      record (the audio tactic proxy: the player struck before the mob had located anyone).
//   3. LivingHurtEvent (before armour): projectile damage to a mob with persistentData.pne_prj > 0 (the PRJ
//      gene, round(1000 * e)) is scaled by 1 - 0.45 * pne_prj / 1000.
//   4. EntityLeaveLevelEvent: a genome mob (pne_g) leaving the level leaves one record with
//      entity.getRemovalReason() (the event carries no reason, F32), its genome, genome id, position,
//      dimension, game time and the pacing-discard flag.
//
// Queues: global.pneHiveQDamage and global.pneHiveQLeave, both java.util.ArrayList<String>, created lazily by
// whichever side needs them first. Records are enqueued only while Number(global.pneOnHive) === 1 (the core
// mirrors the pillar switch there; every value read from global is a wrapped Java object, F6) and dropped once a
// queue holds 4096. Record formats (both ends are hive files; fields separated by '|'):
//   d|attackerUuid|playerUuid|amount*1000|k|projectile(0/1)|gameTime     parasite damage to a player
//   x|playerUuid|damageMsgId|gameTime                                     fatal blow to a player
//   p|mobUuid|playerUuid|gameTime                                         a player hit a genome mob
//   l|uuid|reason|genomeHex|genomeId|x|y|z|dimension|gameTime|pacing(0/1)|typeId   genome mob left the level
// The client thread also fires join/leave events in single player, so every listener returns on a client level.
//
// KubeJS hides some Mojang method names from scripts (contract F37): the game time is Level.getTime() (getGameTime()
// does not exist in game), a damage source's msgId is getType() (not getMsgId()) and its causing entity getActual()
// (not getEntity()). This file calls the KubeJS names first; the Mojang names are only fallbacks for test mocks. When
// no game time can be read, the damage or leave record is skipped (never an error).
//
// Startup scripts cannot see server-script names: this file reads only tags, persistent data and the global keys
// of contract 4.5. Fails safe, per listener: each of the four listeners counts its own errors, logs the first three
// and stops after 20, so a failing damage or leave listener can never switch off the join listener (pne_fresh, which
// the backstop depends on). ES5 only (Rhino); every var at the top of its function.

var $PneHiveEvArrayList = null
var $PneHiveEvDamageTags = null
try { $PneHiveEvArrayList = Java.loadClass('java.util.ArrayList') } catch (e) { $PneHiveEvArrayList = null }
try { $PneHiveEvDamageTags = Java.loadClass('net.minecraft.tags.DamageTypeTags') } catch (e) { $PneHiveEvDamageTags = null }

var PNE_HIVE_EV_QMAX = 4096
var PNE_HIVE_EV_MERCY = 0.30
var PNE_HIVE_EV_GRACE = 2400
var PNE_HIVE_EV_PRJ = 0.45
var PNE_HIVE_EV_LIMIT = 20
var pneHiveEvDropped = 0
var pneHiveEvProjKey = null
// One breaker per listener: n errors so far, off once n reaches PNE_HIVE_EV_LIMIT (until the game restarts),
// what = what stops working when it trips.
var pneHiveEvB = {
  join: { n: 0, off: false, what: 'no pne_fresh flags: the spawned-discard backstop never acts' },
  damage: { n: 0, off: false, what: 'no damage records: no hive damage, kill share or first-strike telemetry' },
  hurt: { n: 0, off: false, what: 'no projectile scaling for the PRJ gene' },
  leave: { n: 0, off: false, what: 'no leave records: removals are not scored and conversions do not link' }
}

function pneHiveEvFail(where, err) {
  var b = pneHiveEvB[where]
  if (!b) return
  b.n++
  if (b.n <= 3) console.warn('[pne_hive_events] ' + where + ' failed (' + b.n + '/' + PNE_HIVE_EV_LIMIT + '): ' + err)
  if (b.n >= PNE_HIVE_EV_LIMIT && !b.off) {
    b.off = true
    console.warn('[pne_hive_events] ' + where + ' listener disabled after repeated errors (' + b.what + '); the other listeners keep running')
  }
}

// The hive pillar as the core mirrors it into global (absent = off: the producers wait for the core).
function pneHiveEvOn() {
  var v = global.pneOnHive
  return v !== undefined && v !== null && Number(v) === 1
}

function pneHiveEvQDamage() {
  var q = global.pneHiveQDamage
  if (q === undefined || q === null) {
    if (!$PneHiveEvArrayList) return null
    q = new $PneHiveEvArrayList()
    global.pneHiveQDamage = q
  }
  return q
}

function pneHiveEvQLeave() {
  var q = global.pneHiveQLeave
  if (q === undefined || q === null) {
    if (!$PneHiveEvArrayList) return null
    q = new $PneHiveEvArrayList()
    global.pneHiveQLeave = q
  }
  return q
}

function pneHiveEvPush(q, rec) {
  if (!q) return
  if (Number(q.size()) >= PNE_HIVE_EV_QMAX) {
    pneHiveEvDropped++
    return
  }
  q.add(rec)
}

// Registry id ('epca:ripper') or ''. entity.type is KubeJS's id string in game (contract F28); getEncodeId()
// and 'entity.<ns>.<path>' are the fallbacks.
function pneHiveEvTypeId(entity) {
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

function pneHiveEvParasiteId(id) {
  return id.indexOf('epca:') === 0 || id.indexOf('spore:') === 0
}

function pneHiveEvPD(entity) {
  try { return entity.persistentData } catch (e) { }
  try { return entity.getPersistentData() } catch (e2) { }
  return null
}

function pneHiveEvHasTag(entity, tag) {
  try { return entity.getTags().contains(tag) ? true : false } catch (e) { return false }
}

function pneHiveEvIsPlayer(entity) {
  try { return entity.isPlayer() ? true : false } catch (e) { return false }
}

// UUID string ('' when unreadable). KubeJS renames Entity.getStringUUID to getStringUuid (F28).
function pneHiveEvUuid(entity) {
  var s = ''
  try { s = String(entity.getStringUuid()) } catch (e) { s = '' }
  if (s.length === 36) return s
  try { s = String(entity.getUuid()) } catch (e2) { s = '' }
  return s.length === 36 ? s : ''
}

function pneHiveEvLevel(entity) {
  try { return entity.getLevel() } catch (e) { }
  try { return entity.level() } catch (e2) { }
  return null
}

// Level.isClientSide is both a public field and a method; either form answers.
function pneHiveEvClient(level) {
  var v = null
  if (!level) return false
  try { v = level.isClientSide() } catch (e) { v = null }
  if (v === null || v === undefined) {
    try { v = level.isClientSide } catch (e2) { v = null }
  }
  return v === true || String(v) === 'true'
}

// Dimension id: KubeJS's getDimension(), then getDimensionKey() (KubeJS's name for Level.dimension(), F37);
// dimension() is only a fallback for mocks.
function pneHiveEvDim(level) {
  var d = ''
  try { d = String(level.getDimension()) } catch (e) { d = '' }
  if (d.indexOf(':') > 0) return d
  try { d = String(level.getDimensionKey().location()) } catch (e2) { d = '' }
  if (d.indexOf(':') > 0) return d
  try { d = String(level.dimension().location()) } catch (e3) { d = '' }
  return d.indexOf(':') > 0 ? d : 'minecraft:overworld'
}

// Game time of the level, NaN when unreadable. Level.getGameTime() is visible to scripts only as getTime() (KubeJS's
// @RemapForJS rename, F37); getGameTime() stays as the fallback for mocks.
function pneHiveEvNow(level) {
  var t = NaN
  try { t = Number(level.getTime()) } catch (e) { t = NaN }
  if (!isFinite(t)) {
    try { t = Number(level.getGameTime()) } catch (e2) { t = NaN }
  }
  return t
}

function pneHiveEvFmt(n) {
  var v = Number(n)
  return (isFinite(v) ? v : 0).toFixed(2)
}

// k_mercy at impact (binding formula, contract 3.3). health is the pre-damage value (F21).
function pneHiveEvK(victim, now) {
  var h = NaN
  var mh = NaN
  var pd
  var until = 0
  try { h = Number(victim.getHealth()); mh = Number(victim.getMaxHealth()) } catch (e) { h = NaN }
  if (mh > 0 && isFinite(h) && h <= PNE_HIVE_EV_MERCY * mh) return 0
  if (pneHiveEvHasTag(victim, 'pne_grace')) {
    pd = pneHiveEvPD(victim)
    try { until = Number(pd.getLong('pne_grace_until')) } catch (e2) { until = 0 }
    if (until > now && until - now <= PNE_HIVE_EV_GRACE) return 0
  }
  if (pneHiveEvHasTag(victim, 'pne_mercy')) return 0
  return 1
}

// 1 when the damage came from a projectile: the #minecraft:is_projectile damage-type tag, else an indirect
// source (the causing entity differs from the direct one, e.g. an arrow and its shooter).
function pneHiveEvProj(src) {
  if (pneHiveEvProjKey === null) {
    pneHiveEvProjKey = false
    if ($PneHiveEvDamageTags) {
      try { pneHiveEvProjKey = $PneHiveEvDamageTags.IS_PROJECTILE || false } catch (e) { pneHiveEvProjKey = false }
    }
  }
  if (pneHiveEvProjKey) {
    try { return src.is(pneHiveEvProjKey) ? 1 : 0 } catch (e2) { }
  }
  try { return src.isIndirect() ? 1 : 0 } catch (e3) { }
  return 0
}

// The damage msgId ('mob', 'arrow', 'fall', 'outOfWorld', ...): DamageSource.getMsgId() is visible to scripts only as
// getType() (F37); getMsgId() stays as the fallback for mocks.
function pneHiveEvMsgId(src) {
  var v = null
  var s = ''
  try { v = src.getType() } catch (e) { v = null }
  if (v === null || v === undefined) {
    try { v = src.getMsgId() } catch (e2) { v = null }
  }
  if (v !== null && v !== undefined) s = String(v)
  return s.replace(/\|/g, '_')
}

// The causing entity (the owner for projectiles) or null: DamageSource.getEntity() is visible to scripts only as
// getActual() (F37); getEntity() stays as the fallback for mocks.
function pneHiveEvAttacker(src) {
  var a = null
  try { a = src.getActual() } catch (e) { a = null }
  if (a === null || a === undefined) {
    try { a = src.getEntity() } catch (e2) { a = null }
  }
  return (a === null || a === undefined) ? null : a
}

// 1. fresh flag
function pneHiveEvOnJoin(event) {
  var ent
  var level
  var pd
  if (pneHiveEvB.join.off) return
  try {
    level = event.getLevel()
    if (pneHiveEvClient(level)) return
    ent = event.getEntity()
    if (!pneHiveEvParasiteId(pneHiveEvTypeId(ent))) return
    pd = pneHiveEvPD(ent)
    if (!pd) return
    if (event.loadedFromDisk()) {
      if (pd.contains('pne_fresh')) pd.remove('pne_fresh')
      return
    }
    if (pneHiveEvOn()) pd.putByte('pne_fresh', 1)
  } catch (err) {
    pneHiveEvFail('join', err)
  }
}

// 2. damage records
function pneHiveEvOnDamage(event) {
  var victim
  var level
  var src
  var att
  var amt
  var now
  var vu
  var au
  var pd
  if (pneHiveEvB.damage.off) return
  try {
    if (!pneHiveEvOn()) return
    victim = event.getEntity()
    if (!victim) return
    level = pneHiveEvLevel(victim)
    if (!level || pneHiveEvClient(level)) return
    amt = Number(event.getAmount())
    if (!(amt > 0)) return
    src = event.getSource()
    now = pneHiveEvNow(level)
    // no readable game time: skip this event's records (k_mercy's grace test and every record need it)
    if (!isFinite(now)) return
    if (pneHiveEvIsPlayer(victim)) {
      vu = pneHiveEvUuid(victim)
      if (!vu) return
      att = pneHiveEvAttacker(src)
      if (att && pneHiveEvParasiteId(pneHiveEvTypeId(att))) {
        au = pneHiveEvUuid(att)
        if (au) {
          pneHiveEvPush(pneHiveEvQDamage(), 'd|' + au + '|' + vu + '|' + Math.round(amt * 1000) + '|' + pneHiveEvK(victim, now) + '|' +
            pneHiveEvProj(src) + '|' + Math.floor(now))
        }
      }
      if (amt >= Number(victim.getHealth())) pneHiveEvPush(pneHiveEvQDamage(), 'x|' + vu + '|' + pneHiveEvMsgId(src) + '|' + Math.floor(now))
      return
    }
    if (!pneHiveEvParasiteId(pneHiveEvTypeId(victim))) return
    att = pneHiveEvAttacker(src)
    if (!att || !pneHiveEvIsPlayer(att)) return
    pd = pneHiveEvPD(victim)
    if (!pd || !pd.contains('pne_g')) return
    vu = pneHiveEvUuid(victim)
    au = pneHiveEvUuid(att)
    if (vu && au) pneHiveEvPush(pneHiveEvQDamage(), 'p|' + vu + '|' + au + '|' + Math.floor(now))
  } catch (err) {
    pneHiveEvFail('damage', err)
  }
}

// 3. projectile scaling (PRJ gene)
function pneHiveEvOnHurt(event) {
  var victim
  var pd
  var prj
  var amt
  if (pneHiveEvB.hurt.off) return
  try {
    victim = event.getEntity()
    if (!victim || !pneHiveEvParasiteId(pneHiveEvTypeId(victim))) return
    pd = pneHiveEvPD(victim)
    if (!pd || !pd.contains('pne_prj')) return
    prj = Number(pd.getInt('pne_prj'))
    if (!(prj > 0)) return
    if (!pneHiveEvProj(event.getSource())) return
    if (prj > 1000) prj = 1000
    amt = Number(event.getAmount())
    if (!(amt > 0)) return
    event.setAmount(amt * (1 - PNE_HIVE_EV_PRJ * prj / 1000))
  } catch (err) {
    pneHiveEvFail('hurt', err)
  }
}

// 4. leave records
function pneHiveEvOnLeave(event) {
  var ent
  var level
  var id
  var pd
  var g
  var gi = ''
  var reason = ''
  var u
  var now
  var pacing = 0
  if (pneHiveEvB.leave.off) return
  try {
    if (!pneHiveEvOn()) return
    level = event.getLevel()
    if (!level || pneHiveEvClient(level)) return
    ent = event.getEntity()
    id = pneHiveEvTypeId(ent)
    if (!pneHiveEvParasiteId(id)) return
    pd = pneHiveEvPD(ent)
    if (!pd || !pd.contains('pne_g')) return
    g = String(pd.getString('pne_g'))
    if (g.length !== 56) return
    u = pneHiveEvUuid(ent)
    if (!u) return
    now = pneHiveEvNow(level)
    // no readable game time: skip this record (the consumer needs it for conversion links and scoring)
    if (!isFinite(now)) return
    if (pd.contains('pne_gi')) gi = String(pd.getString('pne_gi')).replace(/\|/g, '_')
    if (pd.contains('pne_pacing_discard') && Number(pd.getByte('pne_pacing_discard')) === 1) pacing = 1
    try { reason = String(ent.getRemovalReason()) } catch (e) { reason = '' }
    pneHiveEvPush(pneHiveEvQLeave(), 'l|' + u + '|' + reason + '|' + g + '|' + gi + '|' + pneHiveEvFmt(ent.getX()) + '|' +
      pneHiveEvFmt(ent.getY()) + '|' + pneHiveEvFmt(ent.getZ()) + '|' + pneHiveEvDim(level) + '|' +
      Math.floor(now) + '|' + pacing + '|' + id)
  } catch (err) {
    pneHiveEvFail('leave', err)
  }
}

try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.EntityJoinLevelEvent', pneHiveEvOnJoin)
} catch (regErr) {
  console.warn('[pne_hive_events] could not register EntityJoinLevelEvent (no pne_fresh flags: the backstop never acts): ' + regErr)
}
try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.living.LivingDamageEvent', pneHiveEvOnDamage)
} catch (regErr2) {
  console.warn('[pne_hive_events] could not register LivingDamageEvent (no damage telemetry): ' + regErr2)
}
try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.living.LivingHurtEvent', pneHiveEvOnHurt)
} catch (regErr3) {
  console.warn('[pne_hive_events] could not register LivingHurtEvent (no projectile scaling): ' + regErr3)
}
try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.EntityLeaveLevelEvent', pneHiveEvOnLeave)
} catch (regErr4) {
  console.warn('[pne_hive_events] could not register EntityLeaveLevelEvent (removals are not scored): ' + regErr4)
}
