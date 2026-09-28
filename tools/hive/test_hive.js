// Suites hive-node (Node) and hive-rhino (the instance's Rhino jar): the hive runtime on the shared mocks.
// Files, in order: tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js, pne_00_core.js, pne_hive_core.js,
// pne_hive.js, startup_scripts/pne_hive_events.js, this file. Result: pneHiveTestResult ('PASS n ...' or 'FAIL ...').
// ES5, so the same file runs in Rhino (where global is a real java.util.HashMap and the startup queues are real
// java.util.ArrayList<String>, contract F6).
//
// Covers contract 3.3 / 9.4 hive-node: queues and the next-tick newborn rule; spawned never cancelled; backstop before
// any RNG draw (no join, no J event) and never for mobs without pne_fresh (loaded from disk), named or persistent
// mobs, linked newborns, or with spawn_backstop 0; idempotent re-expression; permanent max health check-then-add
// with a single heal across a chunk reload; outcome and dawn inputs carry only buckets and telemetry (I2);
// k_mercy weighting of damage, kill share and team pressure (I3); removal classification; persistence round trip;
// light aversion; intra-day governor; dawn inputs; SIL tells, the 3-block rule, the 30% cap and fail-safe
// unsilencing; the PRC axe; PRJ projectile scaling; pneHiveInfo / pneHiveNear shapes; the hive switch.

var pneHT = { n: 0, fails: [] }
var pneHTTells = []
var pneHTTellOk = true
var pneHTTellRefuse = {}          // player uuid -> true: the director stand-in refuses that player's tells (its ledger)
var pneHTVis = []
var pneHTVerdict = null
var pneHTSpy = { out: [], dawn: [] }
var pneHTSrv = null

function pneHTok(cond, msg) {
  pneHT.n++
  if (!cond) pneHT.fails.push(msg)
}

// Director, oracle and visual stand-ins (the core wrappers find them by name at call time).
function pneResTell(mob, player) {
  var u = pneCoreUuid(player)
  pneHTTells.push({ m: pneCoreUuid(mob), p: u, t: pneCoreTick })
  return pneHTTellOk && pneHTTellRefuse[u] !== true
}
function pneOraVerdict(player) { return pneHTVerdict }
// Director pace stand-in: null means no director pace (the core's fallback); a test sets it to make a player tense.
var pneHTPace = null
function pneResPace(player) { return pneHTPace }
function pneVisApply(mob, info) { pneHTVis.push({ u: pneCoreUuid(mob), info: info }) }
function pneVisRemove(mob) { }

// Spies around the GA calls whose inputs must stay bucketed (I2).
var pneHTGaOutcome = PNE_HIVE_GA.outcome
var pneHTGaDawn = PNE_HIVE_GA.dawn
PNE_HIVE_GA.outcome = function (st, rec) {
  pneHTSpy.out.push(rec)
  return pneHTGaOutcome(st, rec)
}
PNE_HIVE_GA.dawn = function (st, inp) {
  pneHTSpy.dawn.push(inp)
  return pneHTGaDawn(st, inp)
}

// The load epoch's salt is random in game (and in Rhino, where java.util.UUID is the real class): the tests pin it to
// pneHTSalt (0, so epochs are exact) and pneHTEpochCrash runs the real function (pneHTSalt null).
var pneHTSaltReal = pneHiveEpochSalt
var pneHTSalt = 0
pneHiveEpochSalt = function () { return pneHTSalt === null ? pneHTSaltReal() : pneHTSalt }

function pneHTReset() {
  var q
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveWid = ''
  pneHiveTDay = [0, 0, 0, 0, 0]
  pneHiveDay = -1
  pneHiveDawnDue = false
  pneHiveBreedDue = false
  pneHiveDreamDue = false
  pneHiveSaveDue = false
  pneHiveSaving = null
  pneHiveLightDue = false
  pneHiveLightAt = 0
  pneHivePids = {}
  pneHiveDeathSeen = {}
  pneHivePlayerSt = {}
  pneHiveLedger = {}
  pneHiveTeamDmg = {}
  pneHiveFatal = {}
  pneHiveTorch = {}
  pneHiveApexAt = -1
  pneHiveSpRing = []
  pneHiveSpHead = 0
  pneHiveSilBroken = false
  pneHiveWasOff = false
  pneCoreCfgCache = null
  pneCoreStageCache = {}
  pneCorePlayersTick = -1
  pneCoreSeedCache = null
  pneHTTells = []
  pneHTTellOk = true
  pneHTTellRefuse = {}
  pneHTVis = []
  pneHTVerdict = null
  pneHTPace = null
  pneHivePrev = null
  pneHiveEpochDue = false
  pneHTSalt = 0
  pneHiveSteerOn = false
  pneHiveNav = -1
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHTSpy = { out: [], dawn: [] }
  for (q in pneHiveStats) {
    if (pneHiveStats.hasOwnProperty(q)) pneHiveStats[q] = 0
  }
  q = global.pneHiveQDamage
  if (q !== undefined && q !== null) q.clear()
  q = global.pneHiveQLeave
  if (q !== undefined && q !== null) q.clear()
  pneHTSrv = __pneMock.server({ tickCount: 1000, gameTime: 100000 })
  __pneMock.fire('ServerEvents.loaded', { server: pneHTSrv })
  // what the first hive tick after a load does first (pneHTEpochFirstTick covers the tick itself), so the tests below
  // start from a state whose load epoch is declared and count GA events from there
  pneHiveEpochApply()
  return pneHTSrv
}

function pneHTTick(srv, n) {
  __pneMock.tick(srv, n || 1)
}

// Ticks until the handler runs with pneCoreTick % mod === at (that tick included).
function pneHTTickTo(srv, mod, at) {
  var guard = 0
  while ((srv.tickCount + 1) % mod !== at && guard++ < 100000) __pneMock.tick(srv, 1)
  __pneMock.tick(srv, 1)
}

function pneHTPd(e) { return e.persistentData }
function pneHTG(e) { return String(e.persistentData.getString('pne_g')) }
function pneHTAttr(e, id) { return e.getAttribute(id) }

function pneHTHas(obj, keys) {
  var k
  for (k in obj) {
    if (obj.hasOwnProperty(k) && keys.indexOf(k) < 0) return k
  }
  return ''
}

// ---------------------------------------------------------------------------------------------

function pneHTShape() {
  var srv = pneHTReset()
  pneHTok(PNE_HIVE_API === 1 && typeof pneHiveInfo === 'function' && typeof pneHiveNear === 'function', 'API names defined')
  pneHTok(pneCoreLoaded('hive') === true, 'pneCoreLoaded(hive)')
  pneHTok(pneHiveReady === true, 'hive ready (core + GA core loaded)')
  pneHTok((__pneMock.handlers['EntityEvents.checkSpawn'] || []).length === 0, 'EntityEvents.checkSpawn not used')
  pneHTok((pneCoreCmds.hive || []).length === 3, '/pne hive has the core pillar spec, the hive status spec and the admin prev spec')
  pneHTok(pneHiveSt !== null, 'state loaded in ServerEvents.loaded')
  pneHTok(/^[0-9a-f-]{36}$/.test(pneHiveWid), 'world id created')
  pneHTok(Number(global.pneOnHive) === 1, 'core mirrored the hive switch into global')
}

function pneHTNewborn() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var m
  var joins0 = pneHiveSt.joins
  var seq0 = PNE_HIVE_GA.seq(pneHiveSt)
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 10 })
  pneHTok(m.lastSpawned.cancelled === false, 'spawned is never cancelled')
  pneHTok(Number(pneHTPd(m).getByte('pne_fresh')) === 1, 'startup join listener set pne_fresh')
  pneHTok(pneHiveNewQ.length === 1, 'newborn queued')
  pneHTTick(srv, 1)
  pneHTok(pneHTG(m) === '', 'a newborn is not drained in the tick it joined')
  pneHTTick(srv, 1)
  pneHTok(PNE_HIVE_HEX_RX.test(pneHTG(m)), 'newborn drained in the next tick: pne_g set')
  pneHTok(pneHiveSt.joins === joins0 + 1 && PNE_HIVE_GA.seq(pneHiveSt) > seq0, 'one GA join')
  pneHTok(String(pneHTPd(m).getString('pne_gi')).length > 0 && pneHTPd(m).contains('pne_gp') && pneHTPd(m).contains('pne_ctx') &&
    Number(pneHTPd(m).getInt('pne_gv')) === 1 && pneHTPd(m).contains('pne_t0'), 'pne_gi, pne_gp, pne_ctx, pne_gv, pne_t0 written')
  pneHTok(String(pneHTPd(m).getString('pne_ctx')).indexOf('epca:ripper/') === 0, 'context key starts with the species')
  pneHTok(!pneHTPd(m).contains('pne_fresh'), 'pne_fresh removed after expression')
  pneHTok(pneHiveMobs[m.uuid] && pneHiveMobs[m.uuid].e.length === 14, 'tracked with its expression')
  pneHTok(pneHTVis.length === 1 && pneHTVis[0].info.strain === 'epca' && pneHTVis[0].info.clade >= 0 && pneHTVis[0].info.clade <= 3,
    'pneCoreVisApply after the newborn expression')
  // at most 4 newborns per tick
  pneHiveNewQ = []
  var i
  for (i = 0; i < 7; i++) __pneHiveSpawn(srv, 'spore:knight', { x: 20 + i })
  pneHTTick(srv, 2)
  pneHTok(pneHiveNewQ.length === 3, 'at most 4 newborns drained per tick (3 left of 7)')
  pneHTTick(srv, 1)
  pneHTok(pneHiveNewQ.length === 0, 'the rest next tick')
}

function pneHTRejoin() {
  var srv = pneHTReset()
  var m = __pneHiveSaved(srv, 'epca:ripper', { SPD: 65535, ARM: 65535, HPX: 30000, DMG: 20000, KBR: 40000, ACU: 50000 })
  var sp
  var arm
  var hp
  var snap
  var ids = ['generic.movement_speed', 'generic.follow_range', 'generic.knockback_resistance', 'generic.armor', 'generic.max_health', 'generic.attack_damage']
  var i
  var same = true
  var joins0 = pneHiveSt.joins
  pneHTok(pneHiveRejoinQ.length === 1 && pneHiveNewQ.length === 0, 'a mob with pne_g goes to the rejoin queue')
  pneHTTick(srv, 1)
  pneHTok(pneHiveMobs[m.uuid] !== undefined, 'rejoin drained in the next tick handler (no wait)')
  pneHTok(pneHiveSt.joins === joins0, 'a rejoin draws no GA join')
  sp = pneHTAttr(m, 'generic.movement_speed')
  arm = pneHTAttr(m, 'generic.armor')
  pneHTok(sp.count() === 1 && sp.getValue() > 0.25 && sp.getValue() <= 0.25 * 1.125 + 1e-9, 'speed modifier within the +12.5% cap')
  pneHTok(arm.count() === 1 && arm.getValue() > 0 && arm.getValue() <= 4 + 1e-9, 'armour modifier within +4')
  pneHTok(pneHTAttr(m, 'generic.follow_range').getValue() <= 48 + 1e-9, 'follow range capped at 48')
  snap = []
  for (i = 0; i < ids.length; i++) snap.push(pneHTAttr(m, ids[i]).getValue())
  // re-expression is idempotent: same values, one modifier per attribute, nothing thrown
  pneHiveRejoin(srv, m, m.uuid)
  pneHiveRejoin(srv, m, m.uuid)
  for (i = 0; i < ids.length; i++) {
    if (Math.abs(pneHTAttr(m, ids[i]).getValue() - snap[i]) > 1e-9 || pneHTAttr(m, ids[i]).count() > 1) same = false
  }
  pneHTok(same, 'idempotent re-expression (same values, one modifier each)')
  hp = pneHTAttr(m, 'generic.max_health')
  pneHTok(hp.count() === 1 && String(hp.getModifier(pneHiveModUuid(10)).op) === 'MULTIPLY_BASE' && hp.perm[String(pneHiveModUuid(10))], 'max health modifier is permanent')
  pneHTok(sp.trans[String(pneHiveModUuid(0))] !== undefined, 'speed modifier is transient')
  pneHTok(String(pneHiveModUuid(10)) === '706e6500-4869-7665-0000-00000000000a' && String(sp.getModifier(pneHiveModUuid(0)).name) === 'pne.gene.SPD',
    'fixed modifier UUID and name per gene (contract 4.4)')
}

function pneHTHealth() {
  var srv = pneHTReset()
  var m = __pneHiveSaved(srv, 'epca:ripper', { HPX: 65535 }, { hp: 20, maxHp: 20 })
  var n
  var hp
  pneHTTick(srv, 1)
  hp = pneHTAttr(m, 'generic.max_health')
  pneHTok(Math.abs(m.getMaxHealth() - 30) < 1e-6, 'HPX at e = 1: max health x 1.5')
  pneHTok(Math.abs(m.hp - 30) < 1e-6 && Number(pneHTPd(m).getByte('pne_healed')) === 1, 'healed once to the new maximum (pne_healed)')
  m.hp = 12
  n = __pneHiveReload(srv, m)
  pneHTTick(srv, 1)
  hp = pneHTAttr(n, 'generic.max_health')
  pneHTok(hp.count() === 1 && Math.abs(n.getMaxHealth() - 30) < 1e-6, 'after a chunk reload: the saved permanent modifier is kept, not re-added')
  pneHTok(Math.abs(n.hp - 12) < 1e-6, 'after a chunk reload: health not clipped and not healed again')
  pneHTok(pneHiveMobs[n.uuid] && pneHiveMobs[n.uuid].mob === n, 'the reloaded object is the tracked one')
}

function pneHTBackstop() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, hp: 5 })
  var m
  var joins0
  var seq0
  var q
  p.addTag('pne_mercy')
  joins0 = pneHiveSt.joins
  seq0 = PNE_HIVE_GA.seq(pneHiveSt)
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 10 })
  pneHTTick(srv, 2)
  pneHTok(m.removed === true && m.removalReason === 'DISCARDED', 'backstop: fresh newborn near a player in mercy is discarded')
  pneHTok(Number(pneHTPd(m).getByte('pne_pacing_discard')) === 1, 'pne_pacing_discard set before discard()')
  pneHTok(pneHiveSt.joins === joins0 && PNE_HIVE_GA.seq(pneHiveSt) === seq0, 'backstop before any RNG draw: no join, no event')
  pneHTok(pneHTG(m) === '' && pneHiveStats.backstop >= 1, 'no genome written')
  q = global.pneHiveQLeave
  pneHTTick(srv, 1)
  pneHTok(pneHiveConv.length === 0 && pneHiveOutQ.length === 0, 'the pacing discard is ignored by the leave drain')
  // mobs the backstop must keep
  m = __pneMock.mob(srv, 'epca:ripper', { x: 12 })
  __pneHiveJoin(srv, m, true)
  pneHTTick(srv, 2)
  pneHTok(!m.removed && PNE_HIVE_HEX_RX.test(pneHTG(m)), 'loaded from disk (no pne_fresh): never discarded, gets a genome')
  m = __pneMock.mob(srv, 'epca:ripper', { x: 12 })
  m.persistentData.putByte('pne_fresh', 1)
  __pneHiveJoin(srv, m, true)
  pneHTok(!pneHTPd(m).contains('pne_fresh'), 'a mob saved with pne_fresh loses it when loaded from disk')
  pneHTTick(srv, 2)
  pneHTok(!m.removed, 'saved-with-fresh mob kept')
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 11, customName: 'Bob' })
  pneHTTick(srv, 2)
  pneHTok(!m.removed, 'named mob kept')
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 11, persist: true })
  pneHTTick(srv, 2)
  pneHTok(!m.removed, 'persistence-required mob kept')
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 60 })
  pneHTTick(srv, 2)
  pneHTok(!m.removed, 'mob beyond 48 blocks kept')
  pneCoreCfgSet(srv, 'spawn_backstop', 0)
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 10 })
  pneHTTick(srv, 2)
  pneHTok(!m.removed && PNE_HIVE_HEX_RX.test(pneHTG(m)), 'spawn_backstop 0 switches the backstop off')
  pneCoreCfgSet(srv, 'spawn_backstop', 1)
  // live grace also gates
  p.removeTag('pne_mercy')
  p.hp = 20
  p.addTag('pne_grace')
  p.persistentData.putLong('pne_grace_until', srv.gameTime + 1000)
  m = __pneHiveSpawn(srv, 'spore:knight', { x: 5 })
  pneHTTick(srv, 2)
  pneHTok(m.removed === true, 'backstop acts for a player in live grace')
  p.persistentData.putLong('pne_grace_until', srv.gameTime - 1)
  m = __pneHiveSpawn(srv, 'spore:knight', { x: 5 })
  pneHTTick(srv, 2)
  pneHTok(!m.removed, 'a stale grace tag does not gate')
}

function pneHTLink() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, hp: 5 })
  var carrier
  var child
  var ev
  p.addTag('pne_mercy')
  carrier = __pneHiveSaved(srv, 'epca:infested_villager', { SIL: 65535, PRC: 65535 }, { x: 8 })
  pneHTTick(srv, 1)
  // conversion: the new mob joins first, then the carrier is discarded (vanilla convertTo order)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 8.5 })
  carrier.discard()
  pneHTTick(srv, 2)
  pneHTok(!child.removed, 'a linked newborn is never discarded by the backstop')
  pneHTok(String(pneHTPd(child).getString('pne_gp')) === String(pneHTPd(carrier).getString('pne_gi')), 'linked newborn: pne_gp = carrier id')
  ev = PNE_HIVE_GA.events(pneHiveSt, 0)
  var lastJ = ''
  var i
  for (i = 0; i < ev.length; i++) {
    if (ev[i].split('|')[0] === 'J') lastJ = ev[i]
  }
  pneHTok(lastJ.split('|')[3] === 'L' && lastJ.split('|')[4] === String(pneHTPd(carrier).getString('pne_gi')), 'GA join logged with the carrier link (J ... L carrierId)')
  pneHTok(pneHiveStats.links === 1, 'link counted')
}

function pneHTSil() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 10, sil: true })
  var rec
  var t0
  pneHTTick(srv, 1)
  rec = pneHiveMobs[m.uuid]
  pneHTok(rec && rec.sil === true && m.silent === true && rec.inSil, 'saved silent mob stays silent while tells can play')
  pneHTTick(srv, 20)
  pneHTok(pneHTTells.length === 1 && pneHTTells[0].m === m.uuid && pneHTTells[0].p === p.uuid, 'L8 tell for the nearest player within 12 blocks')
  pneHTok(__pneHiveCmds(srv, 'particle minecraft:ash').length >= 1, 'ash-particle tell')
  pneHTTick(srv, 80)
  pneHTok(pneHTTells.length === 1, 'at most one tell per 100 ticks')
  pneHTTick(srv, 20)
  pneHTok(pneHTTells.length === 2, 'next tell after 100 ticks')
  pneHTTellOk = false
  pneHTTick(srv, 100)
  pneHTok(m.silent === false && !pneHTPd(m).contains('pne_sil') && rec.sil === false, 'a tell nobody heard drops Silent and pne_sil')
  // first attack drops Silent
  pneHTTellOk = true
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 11, sil: true })
  pneHTTick(srv, 1)
  __pneHiveDamage(srv, p, 2, __pneHiveSource('mob', m, false))
  pneHTTick(srv, 1)
  pneHTok(m.silent === false && pneHiveMobs[m.uuid].attacked, 'the first attack drops Silent')
  // within 3 blocks drops Silent
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 2, sil: true })
  pneHTTick(srv, 21)
  pneHTok(m.silent === false, 'within 3 blocks drops Silent')
  // resonance off: nobody can hear a tell, so a saved silent mob becomes audible on rejoin
  pneCoreCfgSet(srv, 'on_resonance', 0)
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 10, sil: true })
  pneHTTick(srv, 1)
  pneHTok(m.silent === false && !pneHTPd(m).contains('pne_sil'), 'no director: a saved silent mob is unsilenced on rejoin')
  pneCoreCfgSet(srv, 'on_resonance', 1)
}

// L8 tells for every survival player within 12 blocks (the open decision, now implemented): each is told through the core
// with that player's own ledger answer, at most once per 100 ticks per (mob, player) and at least every <= 5 s while in
// range; a refused tell drops Silent only when no nearby player could be told.
function pneHTTellsAll() {
  var srv = pneHTReset()
  var a = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var b = __pneMock.player(srv, 'B', 'bbbb0000-0000-4000-8000-000000000002', { x: 14 })
  var c = __pneMock.player(srv, 'C', 'cccc0000-0000-4000-8000-000000000003', { x: 10, creative: true })
  var d = __pneMock.player(srv, 'D', 'dddd0000-0000-4000-8000-000000000004', { x: 6, z: 14 })
  var m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 6, sil: true })
  var rec
  var times = {}
  var i
  var k
  var t
  var gapBad = ''
  var maxGapA = 0
  var left
  var fail0
  function collect(mob) {
    var out = {}
    var j
    for (j = 0; j < pneHTTells.length; j++) {
      if (pneHTTells[j].m !== mob.uuid) continue
      if (!out[pneHTTells[j].p]) out[pneHTTells[j].p] = []
      out[pneHTTells[j].p].push(pneHTTells[j].t)
    }
    return out
  }
  pneHTTick(srv, 1)
  rec = pneHiveMobs[m.uuid]
  pneHTTick(srv, 25)
  times = collect(m)
  pneHTok(times[a.uuid] && times[a.uuid].length === 1 && times[b.uuid] && times[b.uuid].length === 1 && times[a.uuid][0] === times[b.uuid][0],
    'both survival players within 12 blocks are told, each through its own pneCoreTell (A 6 blocks, B 8 blocks)')
  pneHTok(!times[c.uuid] && !times[d.uuid], 'no tell for a creative player (C) or a survival player beyond 12 blocks (D, 14 blocks)')
  // 400 ticks in range; B steps away (beyond 16 blocks) 10 ticks after its second tell and comes back 50 ticks after it:
  // its pair cadence still holds (no tell before 100 ticks since the last)
  t = times[b.uuid] ? times[b.uuid][0] : 0
  for (i = 0; i < 400; i++) {
    if (pneCoreTick === t + 110) b.x = 40
    if (pneCoreTick === t + 150) b.x = 14
    pneHTTick(srv, 1)
  }
  times = collect(m)
  for (k in times) {
    if (!times.hasOwnProperty(k)) continue
    for (i = 1; i < times[k].length; i++) {
      t = times[k][i] - times[k][i - 1]
      if (t < PNE_HIVE_TELL_EVERY) gapBad = k + ' told ' + t + ' ticks apart'
      if (k === a.uuid && t > maxGapA) maxGapA = t
    }
  }
  pneHTok(gapBad === '' && (times[a.uuid] || []).length >= 4 && (times[b.uuid] || []).length >= 3 && maxGapA <= 100,
    'per (mob, player): at most one tell per 100 ticks, also across leaving and coming back; A told every 5 s (' + (times[a.uuid] || []).length +
    ' tells, max gap ' + maxGapA + (gapBad ? '; ' + gapBad : '') + ')')
  pneHTok(m.silent === true && rec.sil === true, 'still silent while its tells are heard')
  // the charge: one silentVisit plus one emit per player told
  rec.tells = {}
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  left = pneCoreLeft()
  pneHiveSilentVisit(srv, rec, srv.gameTime)
  pneHTok(Math.abs(left - pneCoreLeft() - pneHiveCost('silentVisit') - 2 * PNE_CORE_COST.emit) < 1e-9, 'a visit telling two players is charged silentVisit + 2 x emit')
  // B's ledger refuses: A could still be told, so the mob stays silent
  pneHTTellRefuse[b.uuid] = true
  fail0 = pneHiveStats.tellFail
  pneHTTick(srv, 130)
  pneHTok(pneHiveStats.tellFail > fail0 && m.silent === true && rec.sil === true, 'a refused tell (B) with another player told (A): Silent stays')
  // A steps back beyond 12 blocks (within 16): nobody within 12 can be told any more, so Silent is dropped for good
  a.x = -8
  pneHTTick(srv, 110)
  pneHTok(m.silent === false && rec.sil === false && !m.persistentData.contains('pne_sil'), 'when no player within 12 blocks could be told, Silent is dropped')
  a.x = 0
  // every player within 12 refused in the same visit: dropped at once, after both were tried
  pneHTTellRefuse = {}
  pneHTTellOk = false
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 6, z: 1, sil: true })
  pneHTTick(srv, 26)
  times = collect(m)
  pneHTok(times[a.uuid] && times[b.uuid] && times[a.uuid].length === 1 && times[b.uuid].length === 1 && m.silent === false,
    'both refused in one visit: each was tried once, then Silent dropped')
  pneHTTellOk = true
}

function pneHTSilCap() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var ms = []
  var i
  var silent = 0
  for (i = 0; i < 3; i++) ms.push(__pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 10 + i, z: 5, sil: true }))
  for (i = 0; i < 3; i++) ms.push(__pneHiveSaved(srv, 'spore:knight', { SPD: 30000 }, { x: 10 + i, z: -5 }))
  pneHTTick(srv, 1)
  for (i = 0; i < ms.length; i++) ms[i].target = p
  // one tick samples all six (engaged), the silent pass at the start of the next tick applies the cap
  pneHTTick(srv, 2)
  for (i = 0; i < 3; i++) {
    if (ms[i].silent) silent++
  }
  pneHTok(pneHiveEngagedN === 6 && silent === 1, 'at most 30% of the engaged hive silent, enforced within a tick of the samples (6 engaged -> 1 silent, got ' + silent + ')')
}

function pneHTAxe() {
  var srv = pneHTReset()
  var carrier
  var child
  var cmds
  carrier = __pneHiveSaved(srv, 'spore:inf_human', { PRC: 65535 }, { x: 8 })
  pneHTTick(srv, 1)
  child = __pneHiveSpawn(srv, 'spore:knight', { x: 8.2 })
  carrier.discard()
  pneHTTick(srv, 3)
  cmds = __pneHiveCmds(srv, 'item replace entity ' + child.uuid + ' weapon.mainhand with minecraft:iron_axe')
  pneHTok(cmds.length === 1 && cmds[0].indexOf('AttributeModifiers:[]') > 0 && cmds[0].indexOf('CustomModelData:7301') > 0, 'Spore host: axe with AttributeModifiers:[] and CustomModelData 7301')
  pneHTok(cmds.length === 1 && /lvl:[12]s/.test(cmds[0]), 'Efficiency at most II')
  pneHTok(__pneHiveCmds(srv, 'data merge entity ' + child.uuid + ' {HandDropChances:[0.0f').length === 1, 'mainhand drop chance 0')
  carrier = __pneHiveSaved(srv, 'epca:infested_villager', { PRC: 65535 }, { x: 30 })
  pneHTTick(srv, 1)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 30.2 })
  carrier.discard()
  pneHTTick(srv, 3)
  cmds = __pneHiveCmds(srv, 'item replace entity ' + child.uuid)
  pneHTok(cmds.length === 1 && cmds[0].indexOf('CustomModelData') < 0, 'EPCA host: axe without CustomModelData')
  carrier = __pneHiveSaved(srv, 'epca:infested_villager', { PRC: 65535 }, { x: 50 })
  pneHTTick(srv, 1)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 50.2, mainHand: 'minecraft:crossbow' })
  carrier.discard()
  pneHTTick(srv, 3)
  pneHTok(__pneHiveCmds(srv, 'item replace entity ' + child.uuid).length === 0, 'a mob holding its own item keeps it')
}

function pneHTPrj() {
  var srv = pneHTReset()
  var m = __pneHiveSaved(srv, 'epca:ripper', { PRJ: 65535 }, { x: 8 })
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var ev
  pneHTTick(srv, 1)
  pneHTok(Number(pneHTPd(m).getInt('pne_prj')) === 1000, 'pne_prj = round(1000 e_PRJ)')
  ev = __pneHiveHurt(srv, m, 10, __pneHiveSource('arrow', p, true))
  pneHTok(Math.abs(ev.amount - 5.5) < 1e-6, 'projectile damage x (1 - 0.45 e_PRJ)')
  ev = __pneHiveHurt(srv, m, 10, __pneHiveSource('player', p, false))
  pneHTok(ev.amount === 10, 'melee damage unchanged')
}

function pneHTTelemetry() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 6 })
  var b = __pneHiveSaved(srv, 'spore:knight', { DMG: 20000 }, { x: -6 })
  var ra
  var rb
  var hd
  pneHTTick(srv, 1)
  ra = pneHiveMobs[a.uuid]
  rb = pneHiveMobs[b.uuid]
  a.target = p
  b.target = p
  pneHTTick(srv, 3)
  pneHTok(ra.tel.loc && rb.tel.loc && ra.targetU === p.uuid && pneHiveEngagedOn[p.uuid] === 2, 'located and engaged from the samples')
  pneHTTick(srv, 20)
  pneHTok(ra.tel.eng > 0.5 && ra.tel.engN > 0, 'engaged time accumulates')
  // damage at impact x k_mercy: full health counts, mercy does not (I3)
  __pneHiveDamage(srv, p, 6, __pneHiveSource('mob', a, false))
  pneHTTick(srv, 1)
  pneHTok(Math.abs(ra.tel.dmg - 6) < 1e-9, 'damage counted at k = 1')
  p.hp = 5
  __pneHiveDamage(srv, p, 3, __pneHiveSource('mob', b, false))
  pneHTTick(srv, 1)
  pneHTok(rb.tel.dmg === 0 && rb.attacked === true, 'damage at hp <= 30% counts 0 (k_mercy = 0), the attack still counts')
  p.hp = 20
  __pneHiveDamage(srv, p, 2, __pneHiveSource('mob', b, false))
  pneHTTick(srv, 22)
  pneHTok(ra.tel.team > 0 && rb.tel.team > 0, 'team pressure from k-weighted team damage')
  pneHTok(String(a.persistentData.getString('pne_tel')).split(',').length === 11, 'telemetry accumulator written to pne_tel')
  // capped at 12 HP per encounter
  __pneHiveDamage(srv, p, 30, __pneHiveSource('mob', a, false))
  pneHTTick(srv, 1)
  pneHTok(Math.abs(ra.tel.dmg - 12) < 1e-9, 'damage capped at 12 HP per encounter')
  // kill share: a's k-weighted damage 12 (6 + 30 -> the ledger keeps raw k-weighted amounts), b's 2 (the mercy hit is 0)
  hd = p.persistentData
  pneHTTickTo(srv, 20, 2)
  hd.putString('pne_hd', String(srv.gameTime))
  pneHTTickTo(srv, 20, 2)
  pneHTok(ra.tel.kill > 0.9 && rb.tel.kill > 0 && rb.tel.kill < 0.1, 'kill share from k-weighted damage in the 10 s before the death (a ' +
    pneCoreFmt(ra.tel.kill) + ', b ' + pneCoreFmt(rb.tel.kill) + ')')
  // a fall death gives no kill credit
  rb.tel.kill = 0
  __pneHiveDamage(srv, p, 2, __pneHiveSource('mob', b, false))
  __pneHiveDamage(srv, p, 25, __pneHiveSource('fall', null, false))
  pneHTTick(srv, 1)
  hd.putString('pne_hd', String(hd.getString('pne_hd')) + ',' + String(srv.gameTime))
  pneHTTickTo(srv, 20, 2)
  pneHTok(rb.tel.kill === 0, 'a fall death (fatal msgId fall) gives no kill credit')
}

function pneHTOutcome() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 6 })
  var idle = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 60 })
  var gen0
  var rec
  var bad = ''
  var i
  pneHTTick(srv, 1)
  a.target = p
  pneHTTick(srv, 25)
  __pneHiveDamage(srv, p, 4, __pneHiveSource('mob', a, false))
  pneHTTick(srv, 1)
  gen0 = PNE_HIVE_GA.gen(pneHiveSt)
  __pneHiveDeath(srv, a, 'player', p)
  __pneHiveRemove(srv, a, 'KILLED')
  pneHTTick(srv, 8)
  pneHTok(PNE_HIVE_GA.gen(pneHiveSt) === gen0 + 1 && pneHTSpy.out.length === 1, 'KILLED engaged mob: one outcome insert')
  rec = pneHTSpy.out[0] || {}
  bad = pneHTHas(rec, ['id', 'g', 'parents', 'ctx', 'e', 'tel']) || pneHTHas(rec.tel || {}, ['dmg', 'engagedSec', 'located', 'killShare', 'teamPressure', 'fastKill', 'cheese'])
  pneHTok(bad === '' && rec.tel.dmg === 4 && rec.tel.located === 1 && rec.tel.cheese === false && rec.e.length === 14, 'outcome record carries only genome, expression and telemetry (I2)' + (bad ? ': ' + bad : ''))
  pneHTok(!pneHiveMobs[a.uuid], 'untracked after the outcome')
  // never engaged: no evidence, no outcome
  __pneHiveRemove(srv, idle, 'KILLED')
  pneHTTick(srv, 8)
  pneHTok(pneHTSpy.out.length === 1, 'a mob that never engaged contributes no sample')
  // cheese: void death
  a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 5 })
  pneHTTick(srv, 1)
  a.target = p
  pneHTTick(srv, 21)
  __pneHiveDeath(srv, a, 'outOfWorld', null)
  __pneHiveRemove(srv, a, 'KILLED')
  pneHTTick(srv, 8)
  pneHTok(pneHTSpy.out.length === 2 && pneHTSpy.out[1].tel.cheese === true, 'void death is cheese (fitness 0)')
  // natural despawn: discarded with nobody within 32 and not engaged for 600 ticks
  a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 200 })
  pneHTTick(srv, 1)
  pneHiveMobs[a.uuid].tel.loc = true
  pneHiveMobs[a.uuid].lastEng = srv.gameTime - 700
  a.discard()
  pneHTTick(srv, 8)
  var buffered = false
  for (i = 0; i < pneHiveConv.length; i++) {
    if (pneHiveConv[i].x === 200) buffered = true
  }
  pneHTok(pneHTSpy.out.length === 2 && !buffered, 'natural despawn: no outcome, not buffered')
  // unloaded to chunk: no outcome; the accumulator survives on the mob
  a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 5 })
  pneHTTick(srv, 1)
  a.target = p
  pneHTTick(srv, 21)
  var n = __pneHiveReload(srv, a)
  pneHTTick(srv, 3)
  pneHTok(pneHTSpy.out.length === 2 && pneHiveMobs[n.uuid] && pneHiveMobs[n.uuid].tel.loc === true && pneHiveMobs[n.uuid].tel.eng > 0,
    'UNLOADED_TO_CHUNK is no outcome; telemetry restored from pne_tel on rejoin')
}

function pneHTPersist() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var i
  var m
  var h1
  var tag
  var keys
  var ok = true
  var wid
  for (i = 0; i < 30; i++) {
    m = __pneHiveSpawn(srv, i % 2 ? 'epca:ripper' : 'spore:knight', { x: 5 + (i % 7), z: i % 5 })
    pneHTTick(srv, 2)
    m.target = p
    pneHTTick(srv, 3)
    __pneHiveDamage(srv, p, 1 + (i % 3), __pneHiveSource('mob', m, false))
    pneHTTick(srv, 2)
    __pneHiveRemove(srv, m, 'KILLED')
    pneHTTick(srv, 6)
  }
  pneHTTick(srv, 40)
  pneHiveTDay = [1.5, 0, 2, 0.25, 0]
  pneHiveDay = 7
  pneHTok(PNE_HIVE_GA.gen(pneHiveSt) >= 20 && PNE_HIVE_GA.queueSize(pneHiveSt) > 0, 'outcomes and breeds happened (gen ' + PNE_HIVE_GA.gen(pneHiveSt) + ')')
  pneHTok(pneHiveSave(srv) === true, 'save')
  h1 = PNE_HIVE_GA.hashAll(pneHiveSt)
  wid = pneHiveWid
  tag = srv.persistentData.getCompound('pne_hive')
  keys = pneHiveKeys(tag)
  for (i = 0; i < keys.length; i++) {
    if (tag.m[keys[i]] && typeof tag.m[keys[i]] === 'string' && tag.m[keys[i]].length >= 60000) ok = false
  }
  pneHTok(ok && keys.indexOf('pool') >= 0 && keys.indexOf('state') >= 0 && keys.indexOf('base') >= 0 && keys.indexOf('samples.0') >= 0 &&
    keys.indexOf('wid') >= 0 && keys.indexOf('log') >= 0 && keys.indexOf('queue') >= 0 && keys.length < 64, 'pne_hive layout (contract 4.1), strings < 60,000')
  pneHTok(pneHiveKeys(tag.getCompound('base')).length > 0 && tag.getCompound('base').getIntArray(pneHiveKeys(tag.getCompound('base'))[0]).length === 5,
    'base is a compound of IntArrays [3 EMAs, count, LRU rank]')
  // simulate /reload: module state gone, reloaded from persistent data
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveWid = ''
  pneHiveTDay = [0, 0, 0, 0, 0]
  pneHiveDay = -1
  pneHiveEnsureLoaded(srv)
  pneHTok(pneHiveSt !== null && PNE_HIVE_GA.hashAll(pneHiveSt) === h1, 'load(save(st)) reproduces pool, queue, state, samples and baselines exactly')
  pneHTok(pneHiveWid === wid && pneHiveDay === 7 && Math.abs(pneHiveTDay[2] - 2) < 1e-9, 'world id, dawn day and tactic evidence restored')
}

function pneHTLight() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var m = __pneHiveSaved(srv, 'epca:ripper', { LUX: 0 }, { x: 8 })
  var weakless = __pneHiveSaved(srv, 'epca:biomass', { LUX: 0 }, { x: 9 })
  var immune = __pneHiveSaved(srv, 'epca:ripper', { LUX: 65535 }, { x: 10 })
  var c
  var all
  var i
  var bad = false
  pneHTTick(srv, 1)
  pneHTok(m.getTags().contains('pne_lux0') && m.getTags().contains('pne_wk') && !weakless.getTags().contains('pne_wk'), 'LUX tier tag; pne_wk only where base attack damage >= 6')
  pneHTok(!immune.getTags().contains('pne_lux0') && !immune.getTags().contains('pne_lux1') && !immune.getTags().contains('pne_lux2'), 'LUX tier 3 carries no tag (immune)')
  srv.light = 12
  srv.cmds = []
  pneHTTickTo(srv, 100, 42)
  c = __pneHiveCmds(srv, 'effect give')
  pneHTok(c.length === 4 && __pneHiveCmds(srv, 'tag=pne_lux0,distance=..48] minecraft:slowness 5 0 true').length === 1 &&
    __pneHiveCmds(srv, 'tag=pne_lux1,tag=pne_wk,distance=..48] minecraft:weakness 5 0 true').length === 1, 'block light 12: Slowness/Weakness for tiers 0-1 (4 commands)')
  srv.light = 15
  srv.cmds = []
  pneHTTickTo(srv, 100, 42)
  pneHTok(__pneHiveCmds(srv, 'effect give').length === 6, 'block light 15: tiers 0-2 (6 commands)')
  srv.light = 10
  srv.cmds = []
  pneHTTickTo(srv, 100, 42)
  pneHTok(__pneHiveCmds(srv, 'effect give').length === 0, 'block light 10: nothing')
  srv.light = 15
  pneCoreCfgSet(srv, 'light_aversion', 0)
  srv.cmds = []
  pneHTTickTo(srv, 100, 42)
  pneHTok(__pneHiveCmds(srv, 'effect give').length === 0, 'light_aversion 0 switches the rule off')
  pneCoreCfgSet(srv, 'light_aversion', 1)
  all = srv.cmds
  for (i = 0; i < all.length; i++) {
    if (/effect give @[apr]|nausea|blindness|darkness/i.test(all[i])) bad = true
  }
  pneHTok(!bad, 'no effect on players, no screen effect (I8)')
}

function pneHTGovernor() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var pd = p.persistentData
  pd.putString('pne_hd', String(srv.gameTime - 30000))
  pneHTTickTo(srv, 20, 2)
  pneHTok(PNE_HIVE_GA.gov(pneHiveSt) === 1, 'deaths before this run are history (first sight)')
  pd.putString('pne_hd', String(srv.gameTime - 30000) + ',' + String(srv.gameTime))
  pneHTTickTo(srv, 20, 2)
  pneHTok(PNE_HIVE_GA.gov(pneHiveSt) === 1, 'one hive death in 20 minutes: no step')
  pd.putString('pne_hd', String(pd.getString('pne_hd')) + ',' + String(srv.gameTime))
  pneHTTickTo(srv, 20, 2)
  pneHTok(Math.abs(PNE_HIVE_GA.gov(pneHiveSt) - 0.85) < 1e-9 && pneHiveStats.gov === 1, 'second hive death within 24000 ticks: gov x 0.85')
  pneHTTickTo(srv, 20, 2)
  pneHTok(Math.abs(PNE_HIVE_GA.gov(pneHiveSt) - 0.85) < 1e-9, 'the same death is not counted twice')
}

function pneHTDawn() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var q = __pneMock.player(srv, 'B', 'bbbb0000-0000-4000-8000-000000000002', { x: 5 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 6 })
  var inp
  var bad
  srv.dayTime = 23000
  pneHTTick(srv, 1)
  a.target = p
  pneHTVerdict = { fresh: true, style: 'kite', band: 2, EO: 0.9, arousal: [0, 0, 0, 1], conf: 1 }
  srv.light = 12
  pneHTTick(srv, 60)
  pneHTok(pneHiveTDay[1] > 0 && pneHiveTDay[3] > 0, 'tactic evidence: the style bucket (kite) and the light rule while engaged')
  p.hp = 5
  var before = pneHiveTDay[1]
  pneHTTick(srv, 40)
  pneHTok(pneHiveTDay[1] === before, 'no tactic evidence while the player is in mercy (GA weight 0)')
  p.hp = 20
  srv.dayTime = 24010
  pneHTTickTo(srv, 20, 5)
  pneHTTick(srv, 12)
  pneHTok(pneHTSpy.dawn.length === 1 && pneHiveStats.dawns === 1, 'dawn at the day boundary')
  pneHTok(pneHiveTDay[0] === 0 && pneHiveTDay[1] === 0 && (pneHiveSaveDue === true || pneHiveSaving !== null), 'evidence reset and a save due at dawn')
  pneHTTick(srv, 48)
  inp = pneHTSpy.dawn[0] || {}
  bad = pneHTHas(inp, ['deaths3d', 'target', 'tDay', 'stage'])
  pneHTok(bad === '' && inp.tDay.length === 5 && Math.abs(inp.tDay[0] + inp.tDay[1] + inp.tDay[2] + inp.tDay[3] + inp.tDay[4] - 1) < 1e-9,
    'dawn input carries only deaths, target, normalised tactic evidence and stage (I2)')
  pneHTok(Math.abs(inp.target - 2) < 1e-9, 'target = gov_deaths x players x 3 / gov_days (2 players seen)')
  pneHTok(pneHiveSaveDue === false && pneHiveSaving === null && pneHiveStats.saves >= 1 && pneHiveStats.saveParts >= 4 &&
    pneHTSrv.persistentData.contains('pne_hive'), 'state saved after the dawn (incremental save finished, ' + pneHiveStats.saveParts + ' GA pieces)')
}

function pneHTAudio() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 6 })
  pneHTTick(srv, 1)
  __pneHiveDamage(srv, a, 3, __pneHiveSource('player', p, false))
  pneHTTick(srv, 1)
  pneHTok(Math.abs(pneHiveTDay[4] - 1) < 1e-9, 'audio tactic: the player struck before the mob located anyone')
  __pneHiveDamage(srv, a, 3, __pneHiveSource('player', p, false))
  pneHTTick(srv, 1)
  pneHTok(Math.abs(pneHiveTDay[4] - 1) < 1e-9, 'counted once per mob')
}

function pneHTApi() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { MOR: 40000, SIL: 65535 }, { x: 6, sil: true })
  var b = __pneHiveSaved(srv, 'spore:knight', { MOR: 40000 }, { x: -6 })
  var info
  var near
  pneHTok(pneCoreHiveNear(p).clade === -1 && pneCoreHiveNear(p).silent === 0, 'pneHiveNear: the neutral answer before the first per-player step')
  pneHTTick(srv, 1)
  // b engaged (clade 2); a stays unengaged, so the 30% cap (floor(0.3 x 1) = 0 engaged silent) leaves it silent
  b.target = p
  pneHTTick(srv, 3)
  pneHTTickTo(srv, 20, pneCoreTelSlot(0))
  info = pneCoreHiveInfo(a)
  pneHTok(info && info.g.length === 56 && info.clade === 2 && info.sil === true && info.apex === false && info.e.length === 14 && info.strain === 'epca',
    'pneHiveInfo shape')
  pneHTok(pneCoreHiveInfo(p) === null, 'pneHiveInfo is null for a mob without a genome')
  near = pneCoreHiveNear(p)
  pneHTok(near.clade === 2 && near.apex === false && near.silent === 1, 'pneHiveNear: dominant clade, apex flag, silent-gene count')
  pneHTok(pneHiveStatusLine().indexOf('pool ') === 0, 'status line')
}

// HiveInfo.flk (for DIRECTOR's flank placement): the expressed FLK gene e[4] in [0, 1], through the core wrapper, next to the
// unchanged contract fields; the same value the hive applied (tag pne_flk at >= 0.5), 0 for a genome without FLK, and the
// same expression for a genome mob the hive does not track yet.
function pneHTInfoFlk() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var hi = __pneHiveSaved(srv, 'epca:ripper', { FLK: 65535 }, { x: 6 })
  var mid = __pneHiveSaved(srv, 'epca:ripper', { FLK: 20000, SPD: 65535, ARM: 65535, HPX: 65535, DMG: 65535 }, { x: 7 })
  var none = __pneHiveSaved(srv, 'spore:knight', { SPD: 30000 }, { x: 8 })
  var a
  var b
  var c
  var u
  var keys = ['g', 'clade', 'sil', 'apex', 'e', 'strain', 'flk']
  pneHTTick(srv, 1)
  a = pneCoreHiveInfo(hi)
  b = pneCoreHiveInfo(mid)
  c = pneCoreHiveInfo(none)
  pneHTok(a && pneHTHas(a, keys) === '' && a.g.length === 56 && a.e.length === 14 && a.strain === 'epca' && typeof a.sil === 'boolean' &&
    typeof a.apex === 'boolean' && a.clade >= 0 && a.clade <= 3, 'HiveInfo keeps every contract field and adds only flk')
  pneHTok(a && typeof a.flk === 'number' && a.flk === a.e[4] && a.flk > 0.5 && a.flk <= 1 && hi.getTags().contains('pne_flk'),
    'flk = the expressed FLK gene e[4] (' + (a ? pneCoreFmt(a.flk) : 'null') + '), tag pne_flk at >= 0.5')
  pneHTok(b && b.flk === b.e[4] && b.flk > 0 && b.flk < a.flk && b.flk === pneHiveMobs[mid.uuid].e[4] && (b.flk >= 0.5) === mid.getTags().contains('pne_flk'),
    'a budget-scaled FLK is reported as applied (' + (b ? pneCoreFmt(b.flk) : 'null') + ')')
  pneHTok(c && c.flk === 0, 'no FLK gene: flk 0')
  // a genome mob the hive has not tracked yet: the same expression from its genome
  u = hi.uuid
  delete pneHiveMobs[u]
  pneHTok(pneCoreHiveInfo(hi).flk === a.flk, 'an untracked genome mob: flk computed from its genome, equal to the applied value')
  pneCoreSetPillar(srv, 'hive', false)
  pneHTok(pneCoreHiveInfo(hi) === null, 'hive off: the core wrapper returns null (no flk)')
  pneCoreSetPillar(srv, 'hive', true)
}

function pneHTSwitch() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 10, sil: true })
  var m
  var q
  pneHTTick(srv, 1)
  pneHTok(a.silent === true, 'silent before the switch')
  pneCoreSetPillar(srv, 'hive', false)
  pneHTok(a.silent === false && !a.persistentData.contains('pne_sil'), 'hive off: Silent removed from tracked silent mobs')
  pneHTok(Number(global.pneOnHive) === 0, 'global.pneOnHive = 0')
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 12 })
  pneHTok(!m.persistentData.contains('pne_fresh') && pneHiveNewQ.length === 0, 'hive off: no fresh flag, nothing queued')
  __pneHiveDamage(srv, p, 2, __pneHiveSource('mob', m, false))
  q = global.pneHiveQDamage
  pneHTok(pneHiveQueueSize(q) === 0, 'hive off: startup producers stop')
  pneHTTick(srv, 3)
  pneHTok(pneHTG(m) === '', 'hive off: no expression')
  pneCoreSetPillar(srv, 'hive', true)
  pneHTTick(srv, 3)
  pneHTok(pneHiveMobs[a.uuid] !== undefined, 'hive on again: genome mobs in the world re-adopted (rediscovery)')
}

function pneHTQueues() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { SPD: 20000 }, { x: 6 })
  var q
  var i
  pneHTTick(srv, 1)
  for (i = 0; i < 70; i++) __pneHiveDamage(srv, p, 0.01, __pneHiveSource('mob', a, false))
  q = global.pneHiveQDamage
  pneHTok(pneHiveQueueSize(q) === 70, 'damage records queued in the startup list')
  pneHTTick(srv, 1)
  pneHTok(pneHiveQueueSize(q) === 70 - PNE_HIVE_REC_MAX, 'at most 32 records per queue per tick')
  pneHTTick(srv, 2)
  pneHTok(pneHiveQueueSize(q) === 0, 'queue drains (no growth)')
  for (i = 0; i < 4100; i++) q.add('d|x|y|1|1|0|1')
  __pneHiveDamage(srv, p, 1, __pneHiveSource('mob', a, false))
  pneHTok(pneHiveQueueSize(q) === 4100, 'producers drop new records at 4096')
  q.clear()
}

// ---------------------------------------------------------------------------------------------
// Review round 1 (hive fixer): each test below failed against the builder's version

// Backstop after a respawn or a portal: the core formula decides with live positions; the hive's own 1 Hz player
// state (fresh but at the old spot or in the old dimension) never overrules it (R-HIVE-R1 / S-HIVE-R2).
function pneHTBackstopMoved() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 500 })
  var m
  pneHTTick(srv, 45)
  pneHTok(pneHivePlayerSt[p.uuid] && pneHivePlayerSt[p.uuid].x === 500 && srv.gameTime - pneHivePlayerSt[p.uuid].t <= PNE_HIVE_PS_FRESH,
    'the hive player state is fresh, at the death spot x = 500')
  p.x = 0
  pneCoreStartGrace(p)
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 5 })
  pneHTTick(srv, 2)
  pneHTok(m.removed === true && pneHTG(m) === '', 'backstop right after a respawn: a fresh horde mob 5 blocks from the player in grace is discarded')
  pneHivePlayerSt[p.uuid].dim = 'minecraft:the_nether'
  pneHivePlayerSt[p.uuid].t = srv.gameTime
  m = __pneHiveSpawn(srv, 'spore:knight', { x: -4 })
  pneHTTick(srv, 2)
  pneHTok(m.removed === true, 'backstop after a dimension change: a stale dimension in the hive player state changes nothing')
}

// A queued rejoin whose chunk unloads and loads again (or two reloads) before the drain: the live object is the one
// tracked and re-expressed (R-HIVE-R2 / S-HIVE-R1).
function pneHTRejoinQueued() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var m
  var n
  var n2
  var t0
  var gone = { isRemoved: function () { return true }, isAlive: function () { return false } }
  pneHTTick(srv, 3)
  m = __pneHiveSaved(srv, 'epca:ripper', { SPD: 65535, HPX: 65535 }, { x: 10 })
  n = __pneHiveReload(srv, m)
  pneHTok(pneHiveRejoinQ.length === 1 && pneHiveRejoinQ[0].mob === n, 'the queued rejoin now holds the newest object of that UUID')
  pneHTTick(srv, 2)
  pneHTok(pneHiveMobs[n.uuid] && pneHiveMobs[n.uuid].mob === n && n.getAttribute('generic.movement_speed').count() === 1,
    'reload while the rejoin is queued: the live object is tracked and its transient modifiers are back')
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 8, sil: true })
  n = __pneHiveReload(srv, m)
  n2 = __pneHiveReload(srv, n)
  t0 = pneHTTells.length
  pneHTTick(srv, 120)
  pneHTok(pneHiveMobs[n2.uuid] && pneHiveMobs[n2.uuid].mob === n2 && n2.silent === true && pneHTTells.length - t0 >= 1,
    'two reloads before one drain: the live silent mob is tracked and keeps its L8 tells (' + (pneHTTells.length - t0) + ' in 120 ticks)')
  m = __pneHiveSaved(srv, 'spore:knight', { SPD: 30000 }, { x: 12 })
  pneHiveRejoinQ[pneHiveRejoinQ.length - 1].mob = gone
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveRediscStart(srv)
  pneHiveRediscJob()
  pneHTok(pneHiveRejoinQ[pneHiveRejoinQ.length - 1].mob === m, 'rediscovery: a queued entry whose object is gone takes the live object')
}

// Silent visits are charged, and whatever does not fit makes the mob audible (R-HIVE-R5); the 3-block rule also runs on
// the sample path and close mobs are revisited every 4 ticks (S-HIVE-R6).
function pneHTSilBudget() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 10, sil: true })
  var rec
  var left
  var v0
  pneHTTick(srv, 1)
  rec = pneHiveMobs[m.uuid]
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  left = pneCoreLeft()
  rec.tells = {}
  rec.ashT = -1000000
  pneHiveSilentVisit(srv, rec, srv.gameTime)
  pneHTok(rec.sil === true && Math.abs(left - pneCoreLeft() - pneHiveCost('silentVisit') - PNE_CORE_COST.emit) < 1e-9,
    'a visit with a tell is charged silentVisit + emit')
  pneCoreLeftMs = 0
  pneHiveSilentVisit(srv, rec, srv.gameTime + 1)
  pneHTok(rec.sil === false && m.silent === false && !pneHTPd(m).contains('pne_sil'), 'a visit that does not fit the budget drops Silent (never silent unseen)')
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 11, sil: true })
  pneHTTick(srv, 1)
  rec = pneHiveMobs[m.uuid]
  pneCoreLeftMs = pneHiveCost('silentVisit') + 0.001
  rec.tells = {}
  pneHiveSilentVisit(srv, rec, srv.gameTime)
  pneHTok(rec.sil === false && m.silent === false, 'a tell that does not fit the budget drops Silent')
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 30, sil: true })
  pneHTTick(srv, 1)
  rec = pneHiveMobs[m.uuid]
  rec.visitN = pneHiveTickNo + 100000
  m.x = 2
  m.target = p
  pneHTTick(srv, 1)
  pneHTok(m.silent === false && rec.sil === false, 'the 3-block rule on the sample path (no silent-pass visit needed)')
  m = __pneHiveSaved(srv, 'epca:ripper', { SIL: 65535 }, { x: 7, sil: true })
  pneHTTick(srv, 1)
  rec = pneHiveMobs[m.uuid]
  pneHTTick(srv, 21)
  v0 = rec.visitN - pneHiveTickNo
  pneHTok(m.silent === true && v0 >= 0 && v0 <= PNE_HIVE_SIL_FAST, 'a silent mob within 8 blocks is revisited every 4 ticks (next visit in ' + v0 + ')')
}

// A steady stream of outcomes starves neither the breed nor the dawn dream, and outcomes are charged their measured
// cost (R-HIVE-R6 / S-HIVE-R5).
function pneHTGaSlots() {
  var srv = pneHTReset()
  var GA = PNE_HIVE_GA
  var mk = GA.mask('epca:ripper')
  var i
  var ch
  var e
  var rec = null
  var b0
  var d0
  var o0
  var hs
  var busy = function (event) {
    if (pneCoreTick % 2 === 0) pneCoreTake(1.2)
  }
  for (i = 0; i < 80; i++) {
    GA.breed(pneHiveSt)
    ch = GA.join(pneHiveSt, null)
    e = GA.express(ch.g, mk, 4)
    rec = { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper/0/0/surface', e: e,
      tel: { dmg: i % 12, engagedSec: 5 + i % 40, located: 1, killShare: 0, teamPressure: 1, fastKill: false, cheese: false } }
    GA.outcome(pneHiveSt, rec)
  }
  GA.dawn(pneHiveSt, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 3 })
  while (GA.queueSize(pneHiveSt) > 4) GA.join(pneHiveSt, null)
  pneHTok(GA.dreamPending(pneHiveSt) && GA.queueSize(pneHiveSt) <= 4, 'setup: a dawn dream pending and room in the breed queue')
  b0 = pneHiveStats.breeds
  d0 = pneHiveStats.dream
  o0 = pneHiveStats.outcomes
  // other modules' per-player work on the even slots (1.2 ms charged before the hive runs, like the telemetry of the
  // first players), so the GA work has only its own odd ticks
  hs = __pneMock.handlers['ServerEvents.tick']
  hs.splice(1, 0, busy)
  for (i = 0; i < 40; i++) {
    while (pneHiveOutQ.length < 200) pneHiveOutQ.push({ rec: rec, sp: 'epca:ripper' })
    pneHTTick(srv, 1)
  }
  hs.splice(hs.indexOf(busy), 1)
  pneHTok(pneHiveStats.breeds - b0 >= 5 && pneHiveStats.dream - d0 >= 5, 'outcomes waiting and even ticks busy: breeds ' + (pneHiveStats.breeds - b0) +
    ' and dream slices ' + (pneHiveStats.dream - d0) + ' still run on their own ticks (40 ticks)')
  pneHTok(pneHiveStats.outcomes - o0 >= 15, 'outcomes run too, two per GA tick while the queue is over half full (' + (pneHiveStats.outcomes - o0) + ' in 40 ticks)')
  pneHTok(pneHiveCost('outcome') < PNE_CORE_COST.breed && pneHiveCost('outcome') >= 0.25, 'an outcome is charged its measured cost, not a breed')
  pneHiveOutQ = []
}

// The incremental pool save's schedule: one step (the start, or one PNE_HIVE_GA.savePart piece) per free save slot (even
// ticks outside slots 0 and 10), each charged PNE_CORE_COST.gaSavePart; a step that does not fit waits for the next free
// slot; no step claims the rest of a tick any more (the I9 save exception is gone). A save due while one runs follows it.
function pneHTSaveSlots() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var GA = PNE_HIVE_GA
  var realBegin = GA.saveBegin
  var realPart = GA.savePart
  var calls = []
  var perTick = {}
  var bad = ''
  var n0
  var s0
  var i
  var t
  pneHTok(PNE_CORE_COST.gaSavePart === 0.6 && pneHiveCost('gaSavePart') === PNE_CORE_COST.gaSavePart, 'a save step is charged the core constant gaSavePart (0.6)')
  pneHTok(pneHiveSaveSlot(2, 2) && pneHiveSaveSlot(12, 12) && pneHiveSaveSlot(6006, 6) && !pneHiveSaveSlot(3, 3) && !pneHiveSaveSlot(20, 0) &&
    !pneHiveSaveSlot(30, 10), 'free save slots: even ticks outside slots 0 and 10')
  pneHiveSaveDue = true
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(srv, 3, 3)
  pneHiveSaveGaJob(srv, 20, 0)
  pneHiveSaveGaJob(srv, 30, 10)
  pneHTok(pneHiveSaving === null && pneCoreLeft() === PNE_CORE_BUDGET_MS, 'no save step on an odd tick or on slots 0 and 10')
  pneCoreLeftMs = pneHiveCost('gaSavePart') + pneHiveCost('save') - 0.01
  pneHiveSaveGaJob(srv, 2, 2)
  pneHTok(pneHiveSaving === null && pneHiveSaveDue === true, 'a step that does not fit its charge waits for the next free slot')
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(srv, 2, 2)
  pneHTok(pneHiveSaving !== null && pneHiveSaving.ph === 'ga' && pneHiveSaveDue === false &&
    Math.abs(PNE_CORE_BUDGET_MS - pneCoreLeft() - pneHiveCost('gaSavePart') - pneHiveCost('save')) < 1e-9,
    'the start (saveBegin + runtime string) is one step charged gaSavePart + save (0.72), not the rest of the tick')
  n0 = pneHiveStats.saveParts
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(srv, 4, 4)
  pneHTok(pneHiveStats.saveParts === n0 + 1 && Math.abs(PNE_CORE_BUDGET_MS - pneCoreLeft() - pneHiveCost('gaSavePart')) < 1e-9,
    'one savePart piece per step, charged gaSavePart')
  // through the tick handler: pieces only on free slots, at most one GA step per tick; a save due meanwhile follows
  pneHiveSaving = null
  pneHiveSaveDue = true
  s0 = pneHiveStats.saves
  GA.saveBegin = function (st) {
    calls.push(pneCoreTick)
    return realBegin(st)
  }
  GA.savePart = function (c) {
    calls.push(pneCoreTick)
    return realPart(c)
  }
  try {
    pneHTTick(srv, 6)
    pneHiveSaveDue = true
    pneHTTick(srv, 120)
  } finally {
    GA.saveBegin = realBegin
    GA.savePart = realPart
  }
  for (i = 0; i < calls.length; i++) {
    t = calls[i]
    perTick[t] = (perTick[t] || 0) + 1
    if (!pneHiveSaveSlot(t, t % 20)) bad = 'a GA save step on tick ' + t + ' (slot ' + (t % 20) + ')'
    else if (perTick[t] > 1) bad = 'two GA save steps on tick ' + t
  }
  pneHTok(bad === '' && calls.length >= 8, 'every GA save step on a free save slot, at most one per tick (' + calls.length + ' steps' + (bad ? '; ' + bad : '') + ')')
  pneHTok(pneHiveSaving === null && pneHiveSaveDue === false && pneHiveStats.saves === s0 + 2 && srv.persistentData.contains('pne_hive'),
    'the save completes over the following ticks, and a save that became due meanwhile runs after it (' + (pneHiveStats.saves - s0) + ' saves)')
}

// Canonical text of a mock CompoundTag (sorted keys, typed values, IntArrays and nested compounds): two compounds with the
// same text hold the same bytes.
function pneHTCanon(tag) {
  var ks = []
  var out = []
  var k
  var v
  var i
  for (k in tag.m) {
    if (tag.m.hasOwnProperty(k)) ks.push(k)
  }
  ks.sort()
  for (i = 0; i < ks.length; i++) {
    v = tag.m[ks[i]]
    if (v && v.isMockNbt) out.push(ks[i] + '={' + pneHTCanon(v) + '}')
    else if (v && v.isIntArray) out.push(ks[i] + '=I[' + v.a.join(',') + ']')
    else out.push(ks[i] + '=' + (typeof v) + ':' + String(v))
  }
  return out.join(';')
}

// Drives the running incremental save to its end directly (GA steps as if on free slots, then the write phase).
function pneHTSaveDrive(srv, between) {
  var guard = 0
  while (pneHiveSaving && pneHiveSaving.ph === 'ga' && guard++ < 200) {
    if (between) between(guard)
    pneCoreLeftMs = PNE_CORE_BUDGET_MS
    pneHiveSaveGaJob(srv, 2, 2)
  }
  while (pneHiveSaving && pneHiveSaving.ph === 'nbt' && guard++ < 400) {
    pneCoreLeftMs = PNE_CORE_BUDGET_MS
    pneHiveSaveJob(srv)
  }
  return guard
}

// The incremental save stores exactly what the one-call save stores (the same persistentData, byte for byte), however the
// GA state and the runtime evidence change between its pieces; a superseded or failed incremental save never writes
// anything and starts over.
function pneHTSaveInc() {
  var srv = pneHTReset()
  var GA = PNE_HIVE_GA
  var st = pneHiveSt
  var mk = GA.mask('epca:ripper')
  var spd = srv.persistentData
  var i
  var ch
  var e
  var ref
  var got
  var steps
  var clean = true
  var sentinel
  var r0
  var old
  var real
  var sv
  var svOld
  var tag
  var b0
  function tel(i) {
    return { dmg: i % 12, engagedSec: 5 + i % 40, located: 1, killShare: i % 13 === 0 ? 1 : 0, teamPressure: (i % 9) / 3, fastKill: false, cheese: false }
  }
  function churn(k) {
    // between two pieces: outcomes that move listed baselines (copy on write) and add contexts, a join, breeds, dream
    // slices, a governor step, today's evidence; every so often a dawn
    ch = GA.join(st, null)
    GA.outcome(st, { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper/' + (k % 9) + '/1/surface', e: GA.express(ch.g, mk, 4), tel: tel(k) })
    GA.outcome(st, { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper/new' + k + '/1/surface', e: GA.express(ch.g, mk, 4), tel: tel(k + 3) })
    GA.breed(st)
    GA.breed(st)
    GA.dreamSlice(st, mk, 4)
    if (k % 5 === 0) GA.govStep(st)
    if (k % 7 === 0) GA.dawn(st, { deaths3d: k % 3, target: 1, tDay: [0.1, 0.3, 0.2, 0.2, 0.2], stage: 2 })
    pneHiveTDay[k % 5] += 1.5
    pneHiveDay++
  }
  // a state with every kind of piece: a full pool, samples, 150 contexts (three base slices), a queue, a pending dream
  for (i = 0; i < 150; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    e = GA.express(ch.g, mk, 4)
    GA.outcome(st, { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper/' + i + '/0/surface', e: e, tel: tel(i) })
  }
  GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 3 })
  for (i = 0; i < 6; i++) GA.breed(st)
  pneHiveTDay = [1, 2, 3, 0.5, 0]
  pneHiveDay = 4
  pneHTok(GA.dreamPending(st) && GA.poolSize(st) === GA.CAP && GA.queueSize(st) > 0, 'setup: full pool, queue, pending dream, 150 contexts')
  // the reference: the one-call save of this exact state
  pneHiveSave(srv)
  ref = pneHTCanon(spd.getCompound('pne_hive'))
  spd.remove('pne_hive')
  svOld = GA.save(st)
  // the incremental save begun at the same state, one piece per step, the state changing between every two pieces
  pneHiveSaveDue = true
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(srv, 2, 2)
  pneHTok(pneHiveSaving !== null && pneHiveSaving.ph === 'ga', 'incremental save begun')
  b0 = pneHiveStats.saveParts
  steps = pneHTSaveDrive(srv, function (k) {
    churn(k)
    if (spd.contains('pne_hive')) clean = false
  })
  pneHTok(clean && pneHiveStats.saveParts - b0 >= 8, 'nothing is written while the GA pieces run (' + (pneHiveStats.saveParts - b0) + ' pieces)')
  got = pneHTCanon(spd.getCompound('pne_hive'))
  pneHTok(pneHiveSaving === null && got === ref, 'the incremental save stores byte for byte what the one-call save stored at its start (' + got.length + ' characters)')
  sv = GA.save(st)
  pneHTok(sv.state !== svOld.state && sv.pool !== svOld.pool && sv.log !== svOld.log && pneHiveRuntimeStr() !== String(spd.getCompound('pne_hive').getString('hv')),
    'and the live state had moved on meanwhile (GA state, pool, log and runtime string all changed)')
  pneHTok(GA.hashAll(GA.load(pneHiveTagToSaved(spd.getCompound('pne_hive')), pneHiveSeed)) === GA.hashAll(GA.load(svOld, pneHiveSeed)),
    'the stored compound loads to the state as of the start')

  // superseded: a newer saveBegin (anyone's) while pieces run: the hive's save never writes and starts over
  sentinel = __pneMock.nbt()
  sentinel.putString('mark', 'old')
  spd.put('pne_hive', sentinel)
  pneHiveSaveDue = true
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(srv, 2, 2)
  pneHiveSaveGaJob(srv, 4, 4)
  pneHiveSaveGaJob(srv, 6, 6)
  svOld = pneHiveSaving ? GA.save(st) : null
  old = GA.saveBegin(st)
  churn(1)
  r0 = pneHiveStats.saveRestarts
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(srv, 8, 8)
  pneHTok(svOld !== null && pneHiveSaving === null && pneHiveSaveDue === true && pneHiveStats.saveRestarts === r0 + 1 &&
    spd.getCompound('pne_hive') === sentinel && pneHTCanon(sentinel) === 'mark=string:old', 'a superseded save writes nothing and starts over')
  sv = GA.save(st)
  pneHiveSaveGaJob(srv, 12, 12)
  pneHTSaveDrive(srv, null)
  tag = spd.getCompound('pne_hive')
  pneHTok(tag !== sentinel && String(tag.getString('state')) === sv.state && String(tag.getString('state')) !== svOld.state && GA.saveEnd(old) === null,
    'the restarted save stores the state of its own start, never the superseded snapshot')

  // failed: a piece throws: counted by the save breaker, nothing written, started over, and the next attempt completes
  spd.put('pne_hive', sentinel)
  real = GA.savePart
  pneHiveSaveDue = true
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveRun(PNE_HIVE_B_SAVE, pneHiveSaveGaJob, srv, 2, 2)
  GA.savePart = function (c) {
    GA.savePart = real
    throw new Error('test: a save piece failed')
  }
  r0 = PNE_HIVE_B_SAVE.total
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveRun(PNE_HIVE_B_SAVE, pneHiveSaveGaJob, srv, 4, 4)
  GA.savePart = real
  pneHTok(PNE_HIVE_B_SAVE.total === r0 + 1 && !PNE_HIVE_B_SAVE.off && pneHiveSaving === null && pneHiveSaveDue === true &&
    spd.getCompound('pne_hive') === sentinel, 'a failed piece: counted by the save breaker, nothing written, started over')
  sv = GA.save(st)
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveRun(PNE_HIVE_B_SAVE, pneHiveSaveGaJob, srv, 6, 6)
  pneHTSaveDrive(srv, null)
  pneHTok(spd.getCompound('pne_hive') !== sentinel && String(spd.getCompound('pne_hive').getString('state')) === sv.state && PNE_HIVE_B_SAVE.n === 0,
    'the next attempt completes (breaker back to 0 consecutive failures)')
}

// The dawn job is charged the dawn constant (contract 7.3), not a breed: with room for a breed but not for a dawn it waits
// (and retries on the following ticks), with room for a dawn it runs and draws exactly that.
function pneHTDawnCost() {
  var srv = pneHTReset()
  var d0
  pneHTok(typeof PNE_CORE_COST.dawn === 'number' && typeof PNE_CORE_COST.gaSave === 'number' && pneHiveCost('dawn') >= PNE_CORE_COST.dawn &&
    pneHiveCost('gaSave') >= PNE_CORE_COST.gaSave && pneHiveCost('dawn') > PNE_CORE_COST.breed && pneHiveCost('gaSave') > PNE_CORE_COST.breed,
    'dawn and gaSave are charged their own core constants (' + pneHiveCost('dawn') + ', ' + pneHiveCost('gaSave') + '), each above a breed')
  d0 = pneHiveStats.dawns
  pneHiveDawnDue = true
  pneCoreLeftMs = pneHiveCost('dawn') - 0.05
  pneHiveGaJob(srv, 5, 5, false)
  pneHTok(pneHiveDawnDue === true && pneHiveStats.dawns === d0 && pneCoreLeftMs > PNE_CORE_COST.breed,
    'room for a breed but not for the dawn: the dawn waits')
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveGaJob(srv, 6, 6, false)
  pneHTok(pneHiveDawnDue === false && pneHiveStats.dawns === d0 + 1 && Math.abs(PNE_CORE_BUDGET_MS - pneCoreLeft() - pneHiveCost('dawn')) < 1e-9,
    'the dawn runs on the next tick with room and draws exactly the dawn cost')
  pneHiveSaveDue = false
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
}

// Player yaw: KubeJS hides Entity.getYRot() (contract F37), so the hive reads getYaw(); the mock player answers only to
// getYaw(). Turning in place counts as movement for the AFK rule; standing still without turning does not.
function pneHTYaw() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var u = pneCoreUuid(p)
  var now = srv.gameTime
  pneHTok(typeof p.getYRot === 'undefined' && typeof p.getYaw === 'function', 'mock player: getYaw only, as in game')
  p.yaw = 10
  pneHivePlayerStep(srv, p, now)
  pneHTok(pneHivePlayerSt[u].yaw === 10 && pneHivePlayerSt[u].moveT === now, 'the yaw is read through getYaw()')
  pneHivePlayerStep(srv, p, now + 20)
  pneHTok(pneHivePlayerSt[u].moveT === now, 'standing still without turning: no movement')
  p.yaw = 95
  pneHivePlayerStep(srv, p, now + 40)
  pneHTok(pneHivePlayerSt[u].yaw === 95 && pneHivePlayerSt[u].moveT === now + 40, 'turning in place counts as movement')
  pneHTok(!pneHiveAfk(u, now + 40 + PNE_HIVE_AFK), 'a player who only turns is not AFK')
  p.getYaw = function () { throw new Error('mock: no getYaw') }
  p.getYRot = function () { return 200 }
  pneHivePlayerStep(srv, p, now + 60)
  pneHTok(pneHivePlayerSt[u].yaw === 200, 'getYRot() stays as the mock fallback')
}

// Switching the hive off, by /pne hive off or by /pne config on_hive 0, and a server stop with the hive off all keep the
// GA's progress since the last save (R-HIVE-R7). A switch-off saves incrementally over the following (off) ticks; the
// server stop is the one synchronous, one-call save.
function pneHTToggleSave() {
  var srv = pneHTReset()
  var h
  var GA = PNE_HIVE_GA
  function stored() {
    return GA.hashAll(GA.load(pneHiveTagToSaved(srv.persistentData.getCompound('pne_hive')), pneHiveSeed))
  }
  GA.breed(pneHiveSt)
  h = GA.hashAll(pneHiveSt)
  pneCoreSetPillar(srv, 'hive', false)
  pneHTok(pneHiveSaveDue === true && !srv.persistentData.contains('pne_hive'), '/pne hive off makes a save due (no one-call save in the command)')
  pneHTTick(srv, 60)
  pneHTok(srv.persistentData.contains('pne_hive') && stored() === h && pneHiveSaving === null && pneHiveStats.saveParts > 0,
    '/pne hive off: the incremental save completes over the off ticks and stores the GA state as it was at the switch')
  pneCoreSetPillar(srv, 'hive', true)
  pneHTTick(srv, 2)
  GA.breed(pneHiveSt)
  h = GA.hashAll(pneHiveSt)
  pneCoreCfgSet(srv, 'on_hive', 0)
  pneHTTick(srv, 60)
  pneHTok(stored() === h, '/pne config on_hive 0 (no toggle hook) saves over the next ticks')
  srv.persistentData.remove('pne_hive')
  pneHiveSaveDue = true
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(srv, 2, 2)
  pneHiveSaveGaJob(srv, 4, 4)
  pneHTok(pneHiveSaving !== null && !srv.persistentData.contains('pne_hive'), 'an incremental save is running when the server stops')
  __pneMock.fire('ServerEvents.unloaded', { server: srv })
  pneHTok(srv.persistentData.contains('pne_hive') && stored() === h && pneHiveSaving === null,
    'a server stop saves a loaded state at once (one call) even while the hive is off, and abandons the running incremental save')
  srv.persistentData.getCompound('pne_hive').putString('pne_ht_mark', 'stop')
  pneHTTick(srv, 60)
  pneHTok(String(srv.persistentData.getCompound('pne_hive').getString('pne_ht_mark')) === 'stop', 'the abandoned incremental save never writes afterwards')
  pneCoreCfgSet(srv, 'on_hive', 1)
}

// A saved state the GA core rejects is kept as pne_hive.prev, carried through later saves and loads, and dropped only by
// an admin (S-HIVE-R10).
function pneHTPrev() {
  var srv = pneHTReset()
  var bad = __pneMock.nbt()
  var tag
  var replies = []
  var ctx = { args: ['prev', 'drop'], admin: true, reply: function (t) { replies.push(String(t)) } }
  bad.putString('state', 'v=999;unreadable')
  bad.putString('pool', 'x')
  bad.putString('hv', 'day=3;ep=4')
  srv.persistentData.put('pne_hive', bad)
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveSaveDue = false
  pneHiveEnsureLoaded(srv)
  pneHTok(pneHiveSt !== null && PNE_HIVE_GA.gen(pneHiveSt) === 0 && pneHivePrev === bad && pneHiveEpoch === 5, 'unreadable state: a fresh pool, the old compound kept, epoch 5')
  pneHTok(String(bad.getString('hv')) === 'day=3;ep=4' && pneHiveSaveDue === true,
    'the kept compound is never written (its hv keeps epoch 4), so the new epoch is recorded by a save due at once')
  pneHiveSave(srv)
  tag = srv.persistentData.getCompound('pne_hive')
  pneHTok(tag.contains('prev') && String(tag.getCompound('prev').getString('state')) === 'v=999;unreadable' && tag.contains('pool'),
    'the next save writes the fresh pool and keeps the old state as pne_hive.prev')
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveEnsureLoaded(srv)
  pneHiveSave(srv)
  tag = srv.persistentData.getCompound('pne_hive')
  pneHTok(pneHivePrev !== null && tag.contains('prev') && String(tag.getCompound('prev').getString('state')) === 'v=999;unreadable',
    'prev survives a later load and save')
  pneHTok(pneHiveCmdPrev(ctx) === true && pneHivePrev === null && pneHiveSaveDue === true, '/pne hive prev drop (admin)')
  pneHiveSave(srv)
  pneHTok(!srv.persistentData.getCompound('pne_hive').contains('prev'), 'dropped at the next save')
}

// Genome ids carry the load epoch, so a child made after a /reload rolled the GA back never reuses the id of a mob that
// is still in the world (S-HIVE-R8).
function pneHTEpoch() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var m
  var n
  var gm
  var gn
  var j0
  pneHTok(pneHiveEpoch === 1, 'first load of a world: epoch 1')
  pneHiveSave(srv)
  j0 = pneHiveSt.joins
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 30 })
  pneHTTick(srv, 2)
  gm = String(m.persistentData.getString('pne_gi'))
  pneHTok(/\.1$/.test(gm), 'newborn ids carry the epoch (' + gm + ')')
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveEnsureLoaded(srv)
  pneHTok(pneHiveEpoch === 2 && String(srv.persistentData.getCompound('pne_hive').getString('hv')).indexOf('ep=2') >= 0 && pneHiveSt.joins === j0,
    'a reload rolls the GA counters back to the save, raises the epoch and records it in the stored state at once')
  n = __pneHiveSpawn(srv, 'epca:ripper', { x: 34 })
  pneHTTick(srv, 2)
  gn = String(n.persistentData.getString('pne_gi'))
  pneHTok(gn !== gm && /\.2$/.test(gn), 'a child made after the rollback never carries the id of the mob still in the world (' + gm + ', ' + gn + ')')
  pneHTok(PNE_HIVE_GA.ep(pneHiveSt) === 2 && gn.split('.').length === 2, 'the GA itself carries epoch 2, so its ids are used as they are (' + gn + ', no double suffix)')
  // a child bred into the queue in epoch 2 and saved there is handed out again after a rollback to that save: it gets
  // the new run's epoch appended, so it never repeats the id it had in the lost run
  while (PNE_HIVE_GA.queueSize(pneHiveSt) > 0) PNE_HIVE_GA.join(pneHiveSt, null)
  PNE_HIVE_GA.breed(pneHiveSt)
  pneHiveSave(srv)
  gm = 'b' + (pneHiveSt.births - 1) + '.2'
  m = __pneHiveSpawn(srv, 'epca:ripper', { x: 38 })
  pneHTTick(srv, 2)
  pneHTok(String(m.persistentData.getString('pne_gi')) === gm, 'in epoch 2 the queued child joins as ' + gm)
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveEnsureLoaded(srv)
  n = __pneHiveSpawn(srv, 'epca:ripper', { x: 42 })
  pneHTTick(srv, 2)
  gn = String(n.persistentData.getString('pne_gi'))
  pneHTok(pneHiveEpoch === 3 && gn === gm + '.3', 'after the rollback the same queued child joins as ' + gm + '.3 (got ' + gn + ')')
  pneHTok(pneHiveRunId('j7.3') === 'j7.3' && pneHiveRunId('b1.13') === 'b1.13.3' && pneHiveRunId('j12') === 'j12.3', 'run ids: the current epoch is kept, anything else gets it appended')
}

// The load epoch is declared to the GA on the first hive tick after a load: the load itself leaves the GA state as saved
// (a restart round-trips it), the tick logs E and raises the GA's epoch; the new epoch is recorded in the stored compound
// at the load, and it is above both the persisted counter and the GA state's own epoch.
function pneHTEpochFirstTick() {
  var srv = pneHTReset()
  var GA = PNE_HIVE_GA
  var h
  var ev
  var tag
  var j
  var lastE = ''
  pneHTTick(srv, 3)
  pneHiveSave(srv)
  h = GA.hashAll(pneHiveSt)
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  tag = srv.persistentData.getCompound('pne_hive')
  pneHTok(pneHiveSt !== null && pneHiveEpochDue === true && GA.hashAll(pneHiveSt) === h && GA.ep(pneHiveSt) === 1 && pneHiveEpoch === 2 &&
    String(tag.getString('hv')).indexOf(';ep=2;') > 0, 'right after a load: the GA state exactly as saved (epoch 1), the new epoch 2 already recorded in the stored hv')
  pneHTTick(srv, 1)
  ev = GA.events(pneHiveSt, 0)
  for (j = 0; j < ev.length; j++) {
    if (String(ev[j]).indexOf('E|') === 0) lastE = String(ev[j])
  }
  pneHTok(pneHiveEpochDue === false && GA.ep(pneHiveSt) === 2 && pneHiveEpoch === 2 && lastE.split('|')[2] === '2',
    'the first hive tick declares epoch 2 to the GA (' + lastE + ')')
  // an hv counter that lags the GA's own epoch (a save written by an older run): the new epoch is above both
  pneHiveSave(srv)
  srv.persistentData.getCompound('pne_hive').putString('hv', 'day=1;ep=0')
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  // the stored hv records the new epoch at the load itself (what a crash before the first hive tick starts from)
  pneHTok(pneHiveEpoch === 3 && String(srv.persistentData.getCompound('pne_hive').getString('hv')).indexOf(';ep=3;') > 0,
    'a lagging persisted counter: the stored hv records epoch 3 at the load itself')
  pneHTTick(srv, 1)
  pneHTok(pneHiveEpoch === 3 && GA.ep(pneHiveSt) === 3, 'a lagging persisted counter (0) still gives a new epoch above the GA state\'s own (2): 3')
}

// A crash before the first world save that follows a load (S-HIVE-R8): KubeJS writes server.persistentData to disk only
// when the overworld saves, while a mob's pne_gi reaches disk whenever its chunk unloads. The next start reads the older
// pne_hive, the counter the lost run started from, and the GA counters roll back to it too; the salt gives the new run
// another epoch, so the same counter makes a different id (unsalted, both runs declared the same epoch and the newborn
// below got the lost run's id). Then the real salt: 10 bits of a random UUID, the Math.random fallback, none at the
// GA's epoch limit.
function pneHTEpochCrash() {
  var srv = pneHTReset()
  var realU = $PneHiveUUID
  var tails = []
  var disk
  var tc
  var gt
  var j0
  var ea
  var eb
  var m
  var n
  var ga
  var gb
  var seen = {}
  var k = 0
  var bad = 0
  var i
  var v
  pneHTTick(srv, 3)
  pneHiveSave(srv)
  // the pne_hive the last world save wrote to disk, and the game time it saved
  disk = __pneHiveNbtCopy(srv.persistentData.getCompound('pne_hive'))
  tc = srv.tickCount
  gt = srv.gameTime
  j0 = pneHiveSt.joins
  $PneHiveUUID = {
    fromString: function (s) { return realU.fromString(s) },
    randomUUID: function () {
      var t = tails.length ? tails.shift() : '000'
      return { toString: function () { return 'abcdef00-0000-4000-8000-000000000' + t } }
    }
  }
  try {
    pneHTSalt = null
    tails = ['2bc', '0f1']
    // the lost run: its load, its epoch, a newborn with a genome id that its chunk writes to disk
    pneHiveClearRuntime()
    pneHiveSt = null
    pneHiveLoadTried = false
    __pneMock.fire('ServerEvents.loaded', { server: srv })
    ea = pneHiveEpoch
    pneHTTick(srv, 1)
    m = __pneHiveSpawn(srv, 'epca:ripper', { x: 30 })
    pneHTTick(srv, 2)
    ga = String(m.persistentData.getString('pne_gi'))
    // the crash: the next start reads the pne_hive and the game time on disk; the mob is still in the world
    srv.persistentData.put('pne_hive', __pneHiveNbtCopy(disk))
    srv.tickCount = tc
    srv.gameTime = gt
    pneHiveClearRuntime()
    pneHiveSt = null
    pneHiveLoadTried = false
    __pneMock.fire('ServerEvents.loaded', { server: srv })
    eb = pneHiveEpoch
    pneHTok(ea === 2 + 0x2bc && eb === 2 + 0x0f1 && pneHiveSt.joins === j0 &&
      String(srv.persistentData.getCompound('pne_hive').getString('hv')).indexOf(';ep=' + eb + ';') > 0,
      'both starts from the same stored counter (1) get salted epochs (' + ea + ', ' + eb + '), the GA counters rolled back')
    pneHTTick(srv, 1)
    n = __pneHiveSpawn(srv, 'epca:ripper', { x: 30 })
    pneHTTick(srv, 2)
    gb = String(n.persistentData.getString('pne_gi'))
    pneHTok(ga.length > 2 && gb !== ga && ga.substring(0, ga.lastIndexOf('.')) === gb.substring(0, gb.lastIndexOf('.')) &&
      /\.702$/.test(ga) && /\.243$/.test(gb), 'the rolled-back counters make the same genome id again, and the epoch keeps the two apart (' + ga + ', ' + gb + ')')
    // no salt where it could push the epoch past what PNE_HIVE_GA.load accepts (2^31 - 1)
    tails = ['3ff']
    srv.persistentData.getCompound('pne_hive').putString('hv', 'day=1;ep=' + (PNE_HIVE_EP_MAX - 1000))
    pneHiveClearRuntime()
    pneHiveSt = null
    pneHiveLoadTried = false
    __pneMock.fire('ServerEvents.loaded', { server: srv })
    pneHTok(pneHiveEpoch === PNE_HIVE_EP_MAX - 999, 'next to the GA epoch limit the epoch is the counter plus one, unsalted (' + pneHiveEpoch + ')')
    // the real function: the UUID's last three hex digits masked to 10 bits; anything else falls back to Math.random
    tails = ['7ff', 'abc']
    pneHTok(pneHTSaltReal() === 1023 && pneHTSaltReal() === 0x2bc, 'the salt is the UUID\'s last 10 bits')
    $PneHiveUUID = { randomUUID: function () { return { toString: function () { return 'no uuid' } } } }
    v = pneHTSaltReal()
    pneHTok(v === Math.floor(v) && v >= 0 && v <= 1023, 'a UUID without hex digits falls back to Math.random (' + v + ')')
    $PneHiveUUID = null
    v = pneHTSaltReal()
    pneHTok(v === Math.floor(v) && v >= 0 && v <= 1023, 'without the UUID class: Math.random (' + v + ')')
    $PneHiveUUID = realU
    for (i = 0; i < 64; i++) {
      v = pneHTSaltReal()
      if (!(v === Math.floor(v) && v >= 0 && v <= 1023)) bad++
      if (!seen[v]) k++
      seen[v] = true
    }
    pneHTok(bad === 0 && k > 1, 'the runtime\'s own UUID class: 64 salts in 0..1023, ' + k + ' distinct')
  } finally {
    $PneHiveUUID = realU
    pneHTSalt = 0
  }
}

// A load that finds no compound to record its epoch in (a fresh world; an unreadable state, see pneHTPrev) makes a save
// due at once, so a /reload shortly after already starts above its epoch.
function pneHTEpochFresh() {
  var srv = pneHTReset()
  var e1 = pneHiveEpoch
  var guard = 0
  pneHTok(!srv.persistentData.contains('pne_hive') && pneHiveSaveDue === true, 'a fresh world: nothing stored yet, a save is due at the load')
  while ((pneHiveSaveDue || pneHiveSaving) && guard++ < 200) pneHTTick(srv, 1)
  pneHTok(guard < 200 && srv.persistentData.contains('pne_hive') &&
    String(srv.persistentData.getCompound('pne_hive').getString('hv')).indexOf(';ep=' + e1 + ';') > 0,
    'the save completes within ' + guard + ' ticks and stores epoch ' + e1)
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneHTok(pneHiveEpoch === e1 + 1 && pneHiveSaveDue === false, '/reload after it: epoch ' + (e1 + 1) + ' (the stored counter plus one, salt 0 here), no extra save')
}

// pneHiveNear is an O(1) read of the per-player entry the hive's own step computes and charges (S-HIVE-R11).
function pneHTNearTable() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var a = __pneHiveSaved(srv, 'epca:ripper', { MOR: 40000 }, { x: 6 })
  var b
  var left
  var v
  pneHTTick(srv, 1)
  a.target = p
  pneHTTickTo(srv, 20, pneCoreTelSlot(0))
  pneHTok(pneCoreHiveNear(p).clade === 2, 'the entry from the per-player step')
  b = __pneHiveSaved(srv, 'epca:ripper', { MOR: 0 }, { x: -6 })
  pneHTTick(srv, 1)
  b.target = p
  pneHTTick(srv, 2)
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  left = pneCoreLeft()
  v = pneHiveNear(p)
  pneHTok(pneCoreLeft() === left && v.clade === 2, 'pneHiveNear charges nothing and scans nothing: it answers from the table (updated at the next step)')
  pneHiveNearCache[p.uuid].t = pneCoreTick - PNE_HIVE_NEAR_OLD - 1
  pneHTok(pneHiveNear(p).clade === -1, 'an entry older than 40 ticks is not used')
}

// Steering: FLK never steers live (tag only), SCT breadcrumbs only with config debug 1, at most one moveTo per tick,
// charged PNE_HIVE_MEASURED.steer (R-HIVE-R8 / S-HIVE-R9).
function pneHTSteer() {
  var srv = pneHTReset()
  var p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var calls = []
  var ms = []
  var i
  var dup = false
  function nav(m) {
    m.getNavigation = function () { return { moveTo: function (x, y, z, s) { calls.push(pneCoreTick); return true } } }
  }
  for (i = 0; i < 3; i++) {
    ms.push(__pneHiveSaved(srv, 'epca:ripper', { SCT: 65535, FLK: 65535 }, { x: 10 + i }))
    nav(ms[i])
  }
  pneHTTick(srv, 1)
  for (i = 0; i < 3; i++) ms[i].target = p
  pneHTTick(srv, 100)
  pneHTok(calls.length === 0 && ms[0].getTags().contains('pne_flk') && ms[0].getTags().contains('pne_sct3'), 'FLK engaged: no live steering, tags pne_flk and pne_sct3')
  for (i = 0; i < 3; i++) ms[i].target = null
  pneHTTick(srv, 60)
  pneHTok(calls.length === 0, 'SCT steering is off by default (config debug 0)')
  pneCoreCfgSet(srv, 'debug', 1)
  for (i = 0; i < 3; i++) pneHiveMobs[ms[i].uuid].lastEng = srv.gameTime
  pneHTTick(srv, 3)
  for (i = 1; i < calls.length; i++) {
    if (calls[i] === calls[i - 1]) dup = true
  }
  pneHTok(calls.length >= 1 && !dup && pneHiveCost('steer') >= 1.0, 'debug 1: SCT breadcrumbs, at most one moveTo per tick (' + calls.length + ' in 3 ticks), charged >= 1 ms')
  pneCoreCfgSet(srv, 'debug', 0)
}

// The conversion search over a deep newborn queue (binary search on the join time) and the newborn wait on leave records
// (S-HIVE-R3, R-HIVE-R3).
function pneHTConvSearch() {
  var srv = pneHTReset()
  var Q = []
  var i
  var q
  var ow = 'minecraft:overworld'
  for (i = 0; i < 4000; i++) Q.push({ mob: null, u: 'x' + i, n: 0, t: 1000 + Math.floor(i / 4), p: [5000 + i, 64, 0], dim: ow })
  Q[2001].p = [10, 64, 10]
  pneHiveNewQ = Q
  pneHTok(pneHiveConversionJoin(10.5, 64, 10, ow, 1500) === true && pneHiveConversionJoin(10.5, 64, 10, ow, 1502) === true &&
    pneHiveConversionJoin(10.5, 64, 10, ow, 1498) === true, 'deep queue: a join within 2 ticks and 2.5 blocks is found')
  pneHTok(pneHiveConversionJoin(10.5, 64, 10, ow, 1503) === false && pneHiveConversionJoin(10.5, 64, 10, ow, 1497) === false,
    'deep queue: 3 ticks apart is no conversion')
  pneHTok(pneHiveConversionJoin(10.5, 64, 10, 'minecraft:the_nether', 1500) === false && pneHiveConversionJoin(20, 64, 10, ow, 1500) === false,
    'deep queue: another dimension or more than 2.5 blocks is no conversion')
  pneHTok(pneHiveConvWindow(1500) === 20 && pneHiveConvWindow(500) === 0 && pneHiveConvWindow(1999) === 12, 'the window a removal walks: joins within 2 ticks (20 of 4000)')
  q = pneHiveQLeave()
  q.clear()
  q.add('l|u|DISCARDED|g|i|0|0|0|minecraft:overworld|1500|0|epca:ripper')
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveTakeLeave(q, 1)
  pneHTok(Math.abs(PNE_CORE_BUDGET_MS - pneCoreLeft() - pneHiveCost('leaveOut') - 20 * pneHiveCost('convRec')) < 1e-9,
    'a DISCARDED record is charged leaveOut plus convRec per newborn its conversion search walks')
  pneHiveNewQ = []
  q = pneHiveQLeave()
  q.clear()
  q.add('l|u|UNLOADED_TO_CHUNK|g|i|0|0|0|minecraft:overworld|1000|0|epca:ripper')
  pneHTok(pneHiveLeaveClear(q, 999, 1001) === false && pneHiveLeaveClear(q, 997, 1001) === true && pneHiveLeaveClear(q, 999, 999 + PNE_HIVE_CONV_KEEP + 1) === true,
    'a newborn waits while the head leave record may be its carrier record (at most 40 ticks)')
  q.clear()
}

function pneHTRun() {
  var tests = [pneHTShape, pneHTNewborn, pneHTRejoin, pneHTHealth, pneHTBackstop, pneHTLink, pneHTSil, pneHTSilCap, pneHTAxe, pneHTPrj,
    pneHTTelemetry, pneHTOutcome, pneHTPersist, pneHTLight, pneHTGovernor, pneHTDawn, pneHTAudio, pneHTApi, pneHTSwitch, pneHTQueues,
    pneHTBackstopMoved, pneHTRejoinQueued, pneHTSilBudget, pneHTGaSlots, pneHTSaveSlots, pneHTDawnCost, pneHTYaw, pneHTToggleSave, pneHTPrev,
    pneHTEpoch, pneHTNearTable, pneHTSteer, pneHTConvSearch, pneHTTellsAll, pneHTSaveInc, pneHTEpochFirstTick, pneHTInfoFlk,
    pneHTEpochCrash, pneHTEpochFresh]
  var i
  for (i = 0; i < tests.length; i++) {
    try {
      tests[i]()
    } catch (e) {
      pneHT.fails.push('test ' + i + ' threw: ' + e + (e && e.stack ? ' ' + String(e.stack).split('\n').slice(0, 3).join(' / ') : ''))
    }
  }
  if (pneHT.fails.length) return 'FAIL ' + pneHT.fails.length + '/' + pneHT.n + ': ' + pneHT.fails.join(' | ')
  return 'PASS ' + pneHT.n + ' hive runtime assertions (' + (__pneHiveIsRhino ? 'rhino' : 'node') + ')'
}

var pneHiveTestResult = pneHTRun()
