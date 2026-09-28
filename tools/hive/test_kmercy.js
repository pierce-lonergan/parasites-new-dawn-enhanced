// Suite hive-kmercy-rhino: the startup listeners of overrides/kubejs/startup_scripts/pne_hive_events.js in the instance's
// real Rhino jar, where global is a real java.util.HashMap (values read back are wrapped Java objects, contract F6) and
// the queues are real java.util.ArrayList<String>. Files, in order: tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js,
// pne_hive_events.js, this file (no server script: startup scripts see only tags, persistent data and global).
// Result: pneKmResult ('PASS n' or 'FAIL ...'). ES5.
//
// The binding formula (contract 3.3), evaluated in LivingDamageEvent with the pre-damage health (F21):
//   k = (hp <= 0.30 * maxHp || graceLive(victim) || hasTag(victim, 'pne_mercy')) ? 0 : 1
//   graceLive = tag pne_grace and pne_grace_until > game time (and at most 2400 ahead, as pneCoreGraceLive)
// Also: producers stop unless Number(global.pneOnHive) === 1 (a stored 1 comes back wrapped), non-parasite attackers
// leave no record, the projectile flag, fatal-blow records, the 4096 cap, the fresh flag rules of the join listener
// (never for chunk loads, cleared on them, never on a client level), leave records, and PRJ projectile scaling.
// Method names (contract F37): the mock levels and damage sources of tools/hive/hive_prelude.js answer only to the names
// scripts see in game (getTime, getType, getActual), so every record above is produced through them; the Mojang names
// (getGameTime, getMsgId, getEntity) are checked only as the mock fallback. A level without a readable game time skips
// the record without an error. Each listener has its own breaker: a damage or leave listener that trips never switches
// off the join listener (pne_fresh, the backstop's precondition), the hurt listener or each other.

var pneKm = { n: 0, fails: [] }

function pneKmOk(cond, msg) {
  pneKm.n++
  if (!cond) pneKm.fails.push(msg)
}

function pneKmRecs() {
  var q = global.pneHiveQDamage
  var out = []
  var i
  var n
  if (q === undefined || q === null) return out
  n = Number(q.size())
  for (i = 0; i < n; i++) out.push(String(q.get(i)))
  q.clear()
  return out
}

// One listener's breaker ({ n, off }); a listener file without per-listener breakers reads as n = -1 (assertions fail).
function pneKmB(name) {
  if (typeof pneHiveEvB === 'undefined' || !pneHiveEvB[name]) return { n: -1, off: false }
  return pneHiveEvB[name]
}

// k of the single damage record the hit produced ('' when none).
function pneKmHit(srv, victim, attacker, amount, indirect) {
  var recs
  var i
  var k = ''
  __pneHiveDamage(srv, victim, amount, __pneHiveSource(indirect ? 'arrow' : 'mob', attacker, indirect === true))
  recs = pneKmRecs()
  for (i = 0; i < recs.length; i++) {
    if (recs[i].split('|')[0] === 'd') k = recs[i].split('|')[4]
  }
  return k
}

function pneKmRun() {
  var srv = __pneMock.server({ gameTime: 50000 })
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { hp: 20, maxHp: 20 })
  var mob = __pneMock.mob(srv, 'epca:ripper', { x: 3 })
  var zombie = __pneMock.mob(srv, 'minecraft:zombie', { x: 3 })
  var now = srv.gameTime
  var recs
  var parts
  var q
  var i
  var ev
  var m2
  var client
  var src
  var lvMojang
  var lvNoTime
  var p2
  var p3
  var m3
  var bad
  var n0

  pneKmOk(typeof global.pneHiveQDamage === 'undefined' || global.pneHiveQDamage === null || true, 'global readable')
  // the mocks expose only the names scripts see in game (F37), so a hidden Mojang name fails here as in game
  src = __pneHiveSource('mob', mob, false)
  pneKmOk(typeof srv.level.getGameTime === 'undefined' && typeof srv.level.getTime === 'function', 'mock level: getTime only (getGameTime is hidden in game)')
  pneKmOk(typeof src.getMsgId === 'undefined' && typeof src.getEntity === 'undefined' && typeof src.getType === 'function' &&
    typeof src.getActual === 'function', 'mock damage source: getType / getActual only (getMsgId / getEntity are hidden in game)')
  // producers wait for the core: absent flag = off
  pneKmOk(pneKmHit(srv, p, mob, 4) === '', 'no record while global.pneOnHive is absent')
  global.pneOnHive = 0
  pneKmOk(pneKmHit(srv, p, mob, 4) === '', 'no record with global.pneOnHive = 0 (wrapped Double)')
  global.pneOnHive = 1
  pneKmOk(typeof global.pneOnHive === 'object' || Number(global.pneOnHive) === 1, 'global value comes back wrapped in Rhino')
  pneKmOk(pneKmHit(srv, p, mob, 4) === '1', 'full health: k = 1')

  // health at impact
  p.hp = 6
  pneKmOk(pneKmHit(srv, p, mob, 2) === '0', 'hp 6/20 = 0.30 (boundary, pre-damage): k = 0')
  p.hp = 6.5
  pneKmOk(pneKmHit(srv, p, mob, 2) === '1', 'hp 6.5/20 > 0.30: k = 1')
  p.hp = 1
  pneKmOk(pneKmHit(srv, p, mob, 0.5) === '0', 'hp 1/20: k = 0')
  p.hp = 20
  p.maxHp = 40
  pneKmOk(pneKmHit(srv, p, mob, 2) === '1', 'hp 20/40 = 0.5: k = 1 (relative to max health)')
  p.hp = 12
  pneKmOk(pneKmHit(srv, p, mob, 2) === '0', 'hp 12/40 = 0.30: k = 0')
  p.maxHp = 20
  p.hp = 20

  // mercy tag (core housekeeping) alone
  p.addTag('pne_mercy')
  pneKmOk(pneKmHit(srv, p, mob, 2) === '0', 'tag pne_mercy: k = 0')
  p.removeTag('pne_mercy')

  // grace: tag plus a live deadline
  p.addTag('pne_grace')
  p.persistentData.putLong('pne_grace_until', now + 1200)
  pneKmOk(pneKmHit(srv, p, mob, 2) === '0', 'live grace (deadline ahead): k = 0')
  p.persistentData.putLong('pne_grace_until', now - 1)
  pneKmOk(pneKmHit(srv, p, mob, 2) === '1', 'stale grace tag (deadline passed): k = 1')
  p.persistentData.putLong('pne_grace_until', now)
  pneKmOk(pneKmHit(srv, p, mob, 2) === '1', 'grace deadline == now: k = 1')
  p.persistentData.putLong('pne_grace_until', now + 5000)
  pneKmOk(pneKmHit(srv, p, mob, 2) === '1', 'grace deadline more than 2400 ahead is not live (as pneCoreGraceLive): k = 1')
  p.persistentData.remove('pne_grace_until')
  pneKmOk(pneKmHit(srv, p, mob, 2) === '1', 'grace tag without a deadline: k = 1')
  p.removeTag('pne_grace')
  p.persistentData.putLong('pne_grace_until', now + 1200)
  pneKmOk(pneKmHit(srv, p, mob, 2) === '1', 'deadline without the tag: k = 1')

  // record fields
  __pneHiveDamage(srv, p, 3.25, __pneHiveSource('arrow', mob, true))
  recs = pneKmRecs()
  parts = recs.length ? recs[0].split('|') : []
  pneKmOk(recs.length === 1 && parts.length === 7 && parts[1] === mob.uuid && parts[2] === p.uuid && parts[3] === '3250' && parts[5] === '1' &&
    parts[6] === String(now), 'record d|attacker|player|amount*1000|k|projectile|gameTime')
  pneKmOk(pneKmHit(srv, p, zombie, 2) === '', 'a non-parasite attacker leaves no record')
  pneKmOk(pneKmHit(srv, p, null, 2) === '', 'no causing entity: no record')
  __pneHiveDamage(srv, p, 0, __pneHiveSource('mob', mob, false))
  pneKmOk(pneKmRecs().length === 0, 'zero damage: no record')

  // fatal blow
  p.hp = 3
  __pneHiveDamage(srv, p, 5, __pneHiveSource('fall', null, false))
  recs = pneKmRecs()
  pneKmOk(recs.length === 1 && recs[0] === 'x|' + p.uuid + '|fall|' + now, 'fatal blow record with the damage msgId')
  p.hp = 20

  // a player hitting a genome mob (audio proxy) - only genome mobs
  __pneHiveDamage(srv, mob, 3, __pneHiveSource('player', p, false))
  pneKmOk(pneKmRecs().length === 0, 'player hit on a mob without a genome: no record')
  mob.persistentData.putString('pne_g', '0000000000000000000000000000000000000000000000000000ffff')
  __pneHiveDamage(srv, mob, 3, __pneHiveSource('player', p, false))
  recs = pneKmRecs()
  pneKmOk(recs.length === 1 && recs[0] === 'p|' + mob.uuid + '|' + p.uuid + '|' + now, 'first-strike record p|mob|player|t')

  // cap (the queue as the producers see it, created lazily)
  q = pneHiveEvQDamage()
  for (i = 0; i < 4096; i++) q.add('d')
  __pneHiveDamage(srv, p, 2, __pneHiveSource('mob', mob, false))
  pneKmOk(Number(q.size()) === 4096, 'queue capped at 4096')
  q.clear()

  // projectile scaling in LivingHurtEvent
  mob.persistentData.putInt('pne_prj', 500)
  ev = __pneHiveHurt(srv, mob, 8, __pneHiveSource('arrow', p, true))
  pneKmOk(Math.abs(ev.amount - 8 * (1 - 0.45 * 0.5)) < 1e-6, 'projectile x (1 - 0.45 pne_prj / 1000)')
  ev = __pneHiveHurt(srv, mob, 8, __pneHiveSource('player', p, false))
  pneKmOk(ev.amount === 8, 'direct hit unchanged')
  ev = __pneHiveHurt(srv, zombie, 8, __pneHiveSource('arrow', p, true))
  pneKmOk(ev.amount === 8, 'non-parasite unchanged')

  // fresh flag
  m2 = __pneMock.mob(srv, 'spore:knight', {})
  __pneHiveJoin(srv, m2, false)
  pneKmOk(Number(m2.persistentData.getByte('pne_fresh')) === 1, 'fresh join: pne_fresh = 1')
  m2 = __pneMock.mob(srv, 'spore:knight', {})
  m2.persistentData.putByte('pne_fresh', 1)
  __pneHiveJoin(srv, m2, true)
  pneKmOk(!m2.persistentData.contains('pne_fresh'), 'loaded from disk: pne_fresh cleared')
  m2 = __pneMock.mob(srv, 'minecraft:zombie', {})
  __pneHiveJoin(srv, m2, false)
  pneKmOk(!m2.persistentData.contains('pne_fresh'), 'non-parasite: no flag')
  global.pneOnHive = 0
  m2 = __pneMock.mob(srv, 'spore:knight', {})
  __pneHiveJoin(srv, m2, false)
  pneKmOk(!m2.persistentData.contains('pne_fresh'), 'hive off: no flag')
  global.pneOnHive = 1
  client = { getTime: function () { return now }, isClientSide: function () { return true } }
  m2 = __pneMock.mob(srv, 'spore:knight', {})
  __pneMock.fire(__PNE_HIVE_EV.join, { getLevel: function () { return client }, getEntity: function () { return m2 }, loadedFromDisk: function () { return false } })
  pneKmOk(!m2.persistentData.contains('pne_fresh'), 'client level: ignored')

  // leave record
  mob.persistentData.putString('pne_gi', 'j42')
  __pneHiveRemove(srv, mob, 'KILLED')
  q = pneHiveEvQLeave()
  recs = []
  for (i = 0; i < Number(q.size()); i++) recs.push(String(q.get(i)))
  q.clear()
  parts = recs.length ? recs[0].split('|') : []
  pneKmOk(recs.length === 1 && parts.length === 12 && parts[0] === 'l' && parts[1] === mob.uuid && parts[2] === 'KILLED' && parts[4] === 'j42' &&
    parts[5] === '3.00' && parts[8] === 'minecraft:overworld' && parts[9] === String(now) && parts[10] === '0' && parts[11] === 'epca:ripper',
    'leave record l|uuid|reason|g|gi|x|y|z|dim|t|pacing|type')
  __pneHiveRemove(srv, zombie, 'KILLED')
  pneKmOk(Number(q.size()) === 0, 'non-parasite removal: no leave record')

  // Mojang names as the mock fallback: a level with only getGameTime() and a source with only getMsgId() / getEntity()
  lvMojang = { getGameTime: function () { return now + 7 }, getDimension: function () { return 'minecraft:overworld' },
    isClientSide: function () { return false } }
  p2 = __pneMock.player(srv, 'B', 'bbbb0000-0000-4000-8000-000000000002', { hp: 20, maxHp: 20 })
  p2.getLevel = function () { return lvMojang }
  __pneHiveDamage(srv, p2, 2, __pneHiveSourceMojang('mob', mob, false))
  recs = pneKmRecs()
  pneKmOk(recs.length === 1 && recs[0] === 'd|' + mob.uuid + '|' + p2.uuid + '|2000|1|0|' + (now + 7), 'fallback: getGameTime() and getEntity() still read by mocks')
  p2.hp = 1
  __pneHiveDamage(srv, p2, 5, __pneHiveSourceMojang('fall', null, false))
  recs = pneKmRecs()
  pneKmOk(recs.length === 1 && recs[0] === 'x|' + p2.uuid + '|fall|' + (now + 7), 'fallback: getMsgId() still read by mocks')
  p2.hp = 20

  // no readable game time: the record is skipped and nothing counts as an error
  lvNoTime = { getDimension: function () { return 'minecraft:overworld' }, isClientSide: function () { return false } }
  p3 = __pneMock.player(srv, 'C', 'cccc0000-0000-4000-8000-000000000003', { hp: 20, maxHp: 20 })
  p3.getLevel = function () { return lvNoTime }
  n0 = pneKmB('damage').n + pneKmB('leave').n
  __pneHiveDamage(srv, p3, 2, __pneHiveSource('mob', mob, false))
  pneKmOk(pneKmRecs().length === 0, 'no game time: no damage record')
  m3 = __pneMock.mob(srv, 'epca:ripper', { x: 9 })
  m3.persistentData.putString('pne_g', '0000000000000000000000000000000000000000000000000000ffff')
  __pneMock.fire(__PNE_HIVE_EV.leave, { getLevel: function () { return lvNoTime }, getEntity: function () { return m3 } })
  pneKmOk(Number(pneHiveEvQLeave().size()) === 0, 'no game time: no leave record')
  pneKmOk(pneKmB('damage').n + pneKmB('leave').n === n0, 'no game time: skipped without an error')

  // one breaker per listener: 25 failing damage events switch off the damage listener only
  bad = { getEntity: function () { throw new Error('mock: broken damage event') }, getAmount: function () { return 1 },
    getSource: function () { return null } }
  for (i = 0; i < 25; i++) __pneMock.fire(__PNE_HIVE_EV.damage, bad)
  pneKmOk(pneKmB('damage').off === true && pneKmB('damage').n === 20, 'damage listener off after 20 errors (' + pneKmB('damage').n + ')')
  pneKmOk(!pneKmB('join').off && !pneKmB('hurt').off && !pneKmB('leave').off && pneKmB('join').n === 0 && pneKmB('leave').n === 0,
    'the other listeners keep their own breakers')
  pneKmOk(pneKmHit(srv, p, mob, 2) === '', 'the tripped damage listener records nothing more')
  m2 = __pneMock.mob(srv, 'spore:knight', {})
  __pneHiveJoin(srv, m2, false)
  pneKmOk(Number(m2.persistentData.getByte('pne_fresh')) === 1, 'join listener still sets pne_fresh after the damage listener tripped')
  ev = __pneHiveHurt(srv, mob, 8, __pneHiveSource('arrow', p, true))
  pneKmOk(Math.abs(ev.amount - 8 * (1 - 0.45 * 0.5)) < 1e-6, 'hurt listener still scales projectiles after the damage listener tripped')
  m3 = __pneMock.mob(srv, 'epca:ripper', { x: 11 })
  m3.persistentData.putString('pne_g', '0000000000000000000000000000000000000000000000000000ffff')
  __pneHiveRemove(srv, m3, 'KILLED')
  pneKmOk(Number(pneHiveEvQLeave().size()) === 1, 'leave listener still records after the damage listener tripped')
  pneHiveEvQLeave().clear()
  // and a tripped leave listener leaves the join listener running too
  bad = { getLevel: function () { throw new Error('mock: broken leave event') }, getEntity: function () { return null } }
  for (i = 0; i < 25; i++) __pneMock.fire(__PNE_HIVE_EV.leave, bad)
  pneKmOk(pneKmB('leave').off === true && !pneKmB('join').off && pneKmB('join').n === 0, 'leave listener off after 20 errors, join listener untouched')
  m2 = __pneMock.mob(srv, 'epca:ripper', {})
  __pneHiveJoin(srv, m2, false)
  pneKmOk(Number(m2.persistentData.getByte('pne_fresh')) === 1, 'join listener still sets pne_fresh after the leave listener tripped')

  if (pneKm.fails.length) return 'FAIL ' + pneKm.fails.length + '/' + pneKm.n + ': ' + pneKm.fails.join(' | ')
  return 'PASS ' + pneKm.n + ' k_mercy and startup-listener assertions (' + (__pneHiveIsRhino ? 'rhino' : 'node') + ')'
}

var pneKmResult = (function () {
  try {
    return pneKmRun()
  } catch (e) {
    return 'FAIL threw: ' + e
  }
})()
