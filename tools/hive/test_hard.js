// Part of the suites hive-node (Node) and hive-rhino (the instance's Rhino jar): the Hard difficulty profile reproduces
// release 1.4 bit for bit (contract 1.5, lead decision L5: any change to a Hard number or command stream is a failure).
// Files, in order: tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js, pne_00_core.js, pne_hive_core.js, <pne_hive.js>,
// startup_scripts/pne_hive_events.js, this file. Result: pneHardResult ('PASS hard digest=<hash> b=.. ev=.. ..' or 'FAIL ...').
// ES5, so the same file runs in Rhino.
//
// One deterministic Hard scenario (vanilla difficulty 3, no pin) through every place the profile touches: newborn and
// rejoin expression at stages 0, 5 and 10 (the budget site, with and without the grace factor near a player with a recent
// hive death), HPX and DMG amounts (phen), the intra-day governor step (govDeaths), light aversion at block light 10, 11 and
// 12 (luxMin), HiveInfo for a genome mob the hive does not track (the third budget site), a dawn with its death target
// (targetK) and the full dawn dream (the dream's budget site), outcomes, the incremental and the one-call save, and a
// restart. It records every budget B handed to PNE_HIVE_GA.express and dreamSlice (as String(B), which round-trips the
// double exactly), the dawn inputs, the governor steps, the GA event log and hashAll, every mob's attribute modifiers, tags,
// Silent flag and genome data, and every command the scripts issued (except the core's own /seed read).
//
// tools/hive/run_hive.py compares the digests with tools/hive/fixtures/hive_hard_baseline.json, which was recorded ONCE from
// the release 1.4 pne_hive.js (git HEAD before the contract 1.5 change) with this same core, mocks and scenario, and must
// never be regenerated from a later pne_hive.js. The scenario reads the world seed as 0 (the mock server answers /seed with
// 0): release 1.4 read it inside ServerEvents.loaded, where the seed read now answers 0 (pneCoreSeed32 before the start),
// while 1.5 reads it after the start, so both runs seed the GA the same way and nothing but the change under test differs.
// Every load, start and restart happens before the scenario's hive work, so the load's move to the first tick changes no
// GA event either.

var pneHH = { log: [], vis: [] }
var pneHHVerdict = null

// Director, oracle and visual stand-ins (the core wrappers find them by name at call time).
function pneResTell(mob, player) { return true }
function pneOraVerdict(player) { return pneHHVerdict }
function pneResPace(player) { return null }
function pneVisApply(mob, info) { pneHH.vis.push(pneCoreUuid(mob) + ':' + info.clade + ':' + info.apex + ':' + info.graft + ':' + info.stage + ':' + info.strain) }
function pneVisRemove(mob) { }

// Spies on the GA calls whose inputs the profile scales. The hive calls them through PNE_HIVE_GA at call time.
var pneHHGaExpress = PNE_HIVE_GA.express
var pneHHGaDream = PNE_HIVE_GA.dreamSlice
var pneHHGaDawn = PNE_HIVE_GA.dawn
var pneHHGaGov = PNE_HIVE_GA.govStep
PNE_HIVE_GA.express = function (g, m, B) {
  pneHH.log.push('X' + String(B))
  return pneHHGaExpress(g, m, B)
}
PNE_HIVE_GA.dreamSlice = function (st, m, B) {
  pneHH.log.push('R' + String(B))
  return pneHHGaDream(st, m, B)
}
PNE_HIVE_GA.dawn = function (st, inp) {
  pneHH.log.push('D' + String(inp.deaths3d) + '/' + String(inp.target) + '/' + String(inp.stage) + '/' + inp.tDay.join(','))
  return pneHHGaDawn(st, inp)
}
PNE_HIVE_GA.govStep = function (st) {
  var g = pneHHGaGov(st)
  pneHH.log.push('G' + String(g))
  return g
}
// the load epoch's salt is random in game (and in Rhino): pinned, so the ids are exact
pneHiveEpochSalt = function () { return 0 }

function pneHHTickTo(srv, mod, at) {
  var guard = 0
  while ((srv.tickCount + 1) % mod !== at && guard++ < 100000) __pneMock.tick(srv, 1)
  __pneMock.tick(srv, 1)
}

function pneHHKeys(o) {
  var out = []
  var k
  for (k in o) {
    if (o.hasOwnProperty(k)) out.push(k)
  }
  out.sort()
  return out
}

function pneHHMod(m) {
  return String(m.id) + '~' + String(m.name) + '~' + String(m.amount) + '~' + String(m.op)
}

// One line per entity: uuid, type, removed, silent, health, tags, every attribute's modifiers, the hive's genome data.
function pneHHEntity(e) {
  var s = [e.uuid, e.typeId, e.removed ? 'R' : '-', e.silent ? 'S' : '-', String(e.hp), pneHHKeys(e.tagSet || {}).join('+')]
  var ids
  var i
  var j
  var inst
  var ks
  var pd = e.persistentData
  var dk = ['pne_g', 'pne_gi', 'pne_gp', 'pne_ctx', 'pne_prj', 'pne_sil', 'pne_healed', 'pne_fresh', 'pne_pacing_discard', 'pne_tel']
  ids = pneHHKeys(e.attrInst || {})
  for (i = 0; i < ids.length; i++) {
    inst = e.attrInst[ids[i]]
    ks = pneHHKeys(inst.perm)
    for (j = 0; j < ks.length; j++) s.push(ids[i] + ':P:' + pneHHMod(inst.perm[ks[j]]))
    ks = pneHHKeys(inst.trans)
    for (j = 0; j < ks.length; j++) s.push(ids[i] + ':T:' + pneHHMod(inst.trans[ks[j]]))
  }
  for (i = 0; i < dk.length; i++) {
    if (pd.contains(dk[i])) s.push(dk[i] + '=' + String(pd.getString(dk[i])))
  }
  return s.join('|')
}

function pneHHStored(srv) {
  var tag = srv.persistentData.getCompound('pne_hive')
  var ks = pneHiveKeys(tag)
  var out = []
  var i
  var bt
  var bk
  var j
  for (i = 0; i < ks.length; i++) {
    // wid and hv carry the world id and the players' random pids (real UUIDs in Rhino): not part of the comparison
    if (ks[i] === 'wid' || ks[i] === 'hv') continue
    if (ks[i] === 'base') {
      bt = tag.getCompound('base')
      bk = pneHiveKeys(bt)
      for (j = 0; j < bk.length; j++) out.push('base.' + bk[j] + '=' + pneHiveJsInts(bt.getIntArray(bk[j])).join(','))
    } else {
      out.push(ks[i] + '=' + String(tag.getString(ks[i])))
    }
  }
  return out.join('\n')
}

function pneHHHash(s) {
  return ('0000000' + pneCoreFnv1a(s).toString(16)).slice(-8)
}

function pneHHRun() {
  var GA = PNE_HIVE_GA
  var srv = __pneMock.server({ tickCount: 2000, gameTime: 300000, cmdResults: { seed: 0 } })
  var mk = GA.mask('epca:ripper')
  var a
  var b
  var i
  var ch
  var ms = []
  var m
  var info
  var guard = 0
  var ents
  var lines = []
  var cmds = []
  var ev
  var day
  var r = {}
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  __pneMock.tick(srv, 1)
  if (!pneHiveSt) return 'FAIL the hive state is not loaded after the first tick'
  // history straight into the GA: a pool and 60 samples, so the dawn below dreams
  for (i = 0; i < 60; i++) {
    GA.breed(pneHiveSt)
    ch = GA.join(pneHiveSt, null)
    GA.outcome(pneHiveSt, { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper/' + (i % 2) + '/' + (i % 4) + '/surface', e: GA.express(ch.g, mk, 4),
      tel: { dmg: i % 12, engagedSec: 5 + i % 40, located: 1, killShare: i % 17 === 0 ? 1 : 0, teamPressure: (i % 9) / 3, fastKill: false, cheese: false } })
  }
  a = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  b = __pneMock.player(srv, 'B', 'bbbb0000-0000-4000-8000-000000000002', { x: 300 })
  // stage 0: rejoins with chosen genomes (HPX and DMG among them) and newborns
  __pneHiveStage = 0
  pneCoreStageCache = {}
  ms.push(__pneHiveSaved(srv, 'epca:ripper', { SPD: 65535, ARM: 65535, HPX: 30000, DMG: 20000, KBR: 40000, ACU: 50000 }, { x: 6 }))
  ms.push(__pneHiveSaved(srv, 'spore:knight', { HPX: 65535, DMG: 65535, PRC: 60000 }, { x: 8 }))
  ms.push(__pneHiveSaved(srv, 'epca:biomass', { LUX: 0, DMG: 50000, SIL: 65535 }, { x: 10, sil: true }))
  ms.push(__pneHiveSaved(srv, 'epca:infested_bat', { SPD: 40000, FLK: 65535, HPX: 20000 }, { x: 12 }))
  for (i = 0; i < 6; i++) ms.push(__pneHiveSpawn(srv, i % 2 ? 'epca:ripper' : 'spore:inf_human', { x: 14 + i, z: i }))
  __pneMock.tick(srv, 3)
  // stage 5, and a recent hive death of A: the grace factor (x 0.7) near A
  __pneHiveStage = 5
  pneCoreStageCache = {}
  a.persistentData.putString('pne_hd', String(srv.gameTime - 100))
  __pneMock.tick(srv, 21)
  for (i = 0; i < 4; i++) ms.push(__pneHiveSpawn(srv, 'epca:ripper', { x: 3 + i, z: -3 }))
  ms.push(__pneHiveSaved(srv, 'epca:ripper', { HPX: 65535, DMG: 65535, SPD: 65535 }, { x: 2, z: 2 }))
  __pneMock.tick(srv, 3)
  // stage 10 near B (no grace there)
  __pneHiveStage = 10
  pneCoreStageCache = {}
  for (i = 0; i < 4; i++) ms.push(__pneHiveSpawn(srv, 'spore:knight', { x: 300 + i, z: 4 }))
  ms.push(__pneHiveSaved(srv, 'spore:inf_human', { HPX: 50000, DMG: 50000, ARM: 30000 }, { x: 305 }))
  __pneMock.tick(srv, 3)
  // engagement, damage, kills (outcomes)
  for (i = 0; i < ms.length; i++) {
    if (!ms[i].removed) ms[i].target = ms[i].x > 150 ? b : a
  }
  __pneMock.tick(srv, 25)
  for (i = 0; i < 6; i++) __pneHiveDamage(srv, a, 1 + (i % 3), __pneHiveSource('mob', ms[i], false))
  __pneMock.tick(srv, 5)
  for (i = 4; i < 10; i++) __pneHiveDeath(srv, ms[i], 'player', a)
  __pneMock.tick(srv, 2)
  for (i = 4; i < 10; i++) __pneHiveRemove(srv, ms[i], 'KILLED')
  __pneMock.tick(srv, 20)
  // a second hive death of A within 24000 ticks: the intra-day governor step (exactly 2 in the window)
  a.persistentData.putString('pne_hd', String(a.persistentData.getString('pne_hd')) + ',' + String(srv.gameTime))
  __pneMock.tick(srv, 21)
  // after the step: a chunk reload re-expresses at the new governor, and new newborns
  ms[1] = __pneHiveReload(srv, ms[1])
  for (i = 0; i < 3; i++) ms.push(__pneHiveSpawn(srv, 'epca:ripper', { x: 20 + i, z: 8 }))
  __pneMock.tick(srv, 3)
  // light aversion at block light 10, 11 and 12
  srv.light = 10
  pneHHTickTo(srv, 100, 42)
  srv.light = 11
  pneHHTickTo(srv, 100, 42)
  srv.light = 12
  pneHHTickTo(srv, 100, 42)
  srv.light = 0
  // HiveInfo for a genome mob the hive does not track
  m = __pneMock.mob(srv, 'epca:ripper', { x: 40 })
  m.persistentData.putString('pne_g', __pneHiveGenome({ FLK: 50000, SPD: 65535, HPX: 65535, DMG: 65535, ARM: 65535 }))
  info = pneHiveInfo(m)
  pneHH.log.push('I' + (info ? info.e.join(',') + '/' + String(info.flk) : 'null'))
  // the dawn (target, the dream and its slices), then the save it makes due
  __pneMock.tick(srv, 20)
  day = Math.floor(srv.gameTime / 24000)
  srv.dayTime = (day + 1) * 24000 + 10
  while ((pneHiveSt.dawns === 0 || GA.dreamPending(pneHiveSt) || pneHiveSaveDue || pneHiveSaving) && guard++ < 3000) __pneMock.tick(srv, 1)
  // a restart: the server stops (the one-call save), the next run loads on its first tick
  __pneMock.fire('ServerEvents.unloaded', { server: srv })
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveDay = -1
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  __pneMock.tick(srv, 1)
  for (i = 0; i < 3; i++) ms.push(__pneHiveSpawn(srv, 'spore:knight', { x: 30 + i, z: -8 }))
  __pneMock.tick(srv, 3)
  // the governor at the GA's upper bound (1.15, where Hard's govCap sits) and just below it: expressions and HiveInfo
  pneHiveSt.gov = 1.15
  for (i = 0; i < 3; i++) ms.push(__pneHiveSpawn(srv, 'epca:ripper', { x: 34 + i, z: -8 }))
  ms[2] = __pneHiveReload(srv, ms[2])
  __pneMock.tick(srv, 3)
  info = pneHiveInfo(m)
  pneHH.log.push('I' + (info ? info.e.join(',') + '/' + String(info.flk) : 'null'))
  pneHiveSt.gov = 1.12
  for (i = 0; i < 2; i++) ms.push(__pneHiveSpawn(srv, 'spore:inf_human', { x: 38 + i, z: -8 }))
  __pneMock.tick(srv, 60)
  __pneMock.fire('ServerEvents.unloaded', { server: srv })

  // by UUID, then creation order (a chunk reload makes a second object with the same UUID): a total order, rule 4
  ents = []
  for (i = 0; i < srv.entities.length; i++) ents.push({ e: srv.entities[i], i: i })
  ents.sort(function (x, y) {
    if (x.e.uuid !== y.e.uuid) return x.e.uuid < y.e.uuid ? -1 : 1
    return x.i - y.i
  })
  for (i = 0; i < ents.length; i++) lines.push(pneHHEntity(ents[i].e))
  for (i = 0; i < srv.cmds.length; i++) {
    if (srv.cmds[i] !== 'seed') cmds.push(srv.cmds[i])
  }
  ev = GA.events(pneHiveSt, 0)
  r.b = pneHHHash(pneHH.log.join('\n'))
  r.ev = pneHHHash(ev.join('\n'))
  r.ga = GA.hashAll(pneHiveSt)
  r.mobs = pneHHHash(lines.join('\n'))
  r.vis = pneHHHash(pneHH.vis.join('\n'))
  r.cmds = pneHHHash(cmds.join('\n'))
  r.stored = pneHHHash(pneHHStored(srv))
  r.digest = pneHHHash([r.b, r.ev, r.ga, r.mobs, r.vis, r.cmds, r.stored].join('/'))
  return 'PASS hard digest=' + r.digest + ' b=' + r.b + ' ev=' + r.ev + ' ga=' + r.ga + ' mobs=' + r.mobs + ' vis=' + r.vis + ' cmds=' + r.cmds +
    ' stored=' + r.stored + ' n_b=' + pneHH.log.length + ' n_ev=' + ev.length + ' n_cmds=' + cmds.length + ' n_mobs=' + lines.length +
    ' dawns=' + pneHiveSt.dawns + ' gov=' + String(GA.gov(pneHiveSt)) + ' dream=' + pneHiveStats.dream + ' light=' + pneHiveStats.light +
    ' govSteps=' + pneHiveStats.gov + ' guard=' + guard
}

var pneHardResult = (function () {
  try {
    return pneHHRun()
  } catch (e) {
    return 'FAIL hard scenario threw: ' + e + (e && e.stack ? ' ' + String(e.stack).split('\n').slice(0, 3).join(' / ') : '')
  }
})()
