// hive-rhino-bench workload (ES5), timed from Java by tools/hive/HiveBench.java in the instance's Rhino jar. Loaded after
// tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js, pne_00_core.js, pne_hive_core.js, pne_hive.js, pne_hive_events.js.
// Mobs are Java stand-ins (__hb.mob: real reflection dispatch, real CompoundTag persistent data, real AttributeModifier);
// the server, level and 8 survival players are the shared JS mocks. The scripts never read a clock.
//
// Unit cases (name:units:reps:charged-as[:max p50/charged]) and four tick phases (name:ticks). charged-as is a cost key
// (pneHiveCost: the core constant raised to the hive's measured value), 'f*key', a number, or '=js expression'; the
// optional last field gates the case (the median must fit the charge).
// Phases:
//   drain  - every drain saturated every tick: >= 8 newborns and >= 16 rejoins waiting, >= 40 damage and >= 40 leave records
//            (real kills with outcomes among them), 400+ tracked mobs sampled, silent mobs with tells, light passes;
//            GA work yields to the drains (contract 7.2), so this is the worst case for the drain half of the table
//   quiet  - a trickle of joins: outcomes waiting, a pending dawn dream, breeding, a periodic save every 400 ticks, a dawn
//            every 1000 ticks, light passes, samples and tells: the worst case for the GA half of the table; gated: breeds,
//            dream slices and every outcome (none dropped) in every trial
//   mixed  - moderate joins and records with GA work in between (a Hive Night mix); gated: no outcome dropped
//   deep   - a newborn queue about 4000 deep (a chunk-load burst of parasites without genomes) with bursts of joins in one
//            tick, and 32 DISCARDED genome records per tick: the conversion search must stay O(log n + window)

var pneHB = { srv: null, players: [], n: 0, phase: '', fresh: [], tells: 0, kills: 0, t0: {}, cyc: 0, lastSave: 0, killed: [], deepQ: null,
  keepQ: null, sil: [], drop0: 0, phaseTicks: 0, dawnKeep: null }

// Director stand-in: every tell is heard (the ledger's own cost is the director's, not the hive's).
function pneResTell(mob, player) {
  pneHB.tells++
  return true
}

function pneHBUuid(i) {
  return 'bbbb0000-0000-4000-8000-' + ('000000000000' + i).slice(-12)
}

function pneHBLcg(i, j) {
  var h = (i * 2654435761 + j * 40503 + 12345) >>> 0
  h = (h ^ (h >>> 13)) >>> 0
  return (h * 1103515245 + 12345) >>> 0
}

function pneHBGenome(i) {
  var g = []
  var j
  for (j = 0; j < 14; j++) g.push(pneHBLcg(i, j) % 65536)
  if (i % 10 === 0) g[5] = 62000
  return PNE_HIVE_GA.hex(g)
}

function pneHBNewMob(type, p, k) {
  var i = ++pneHB.n
  var x = Number(p.x) + (k % 17) - 8
  var z = Number(p.z) + ((k * 7) % 15) - 7
  return __hb.mob(type, pneHBUuid(i), x, 64, z, pneHB.srv.level, pneHB.srv, type !== 'epca:curbug')
}

function pneHBSpawned(m) {
  __pneMock.fire('EntityEvents.spawned', { entity: m, level: pneHB.srv.level, cancel: function () { } })
}

// A genome mob saved in an earlier session, near player p (joins as a rejoin).
function pneHBSaved(p, k) {
  var types = ['epca:ripper', 'spore:knight', 'epca:infested_villager', 'spore:inf_human', 'epca:curbug']
  var m = pneHBNewMob(types[k % types.length], p, k)
  var pd = m.getPersistentData()
  pd.putString('pne_g', pneHBGenome(pneHB.n))
  pd.putInt('pne_gv', 1)
  pd.putString('pne_gi', 'p' + pneHB.n)
  pd.putString('pne_gp', 'p1,p2')
  pd.putString('pne_ctx', m.getType() + '/1/1/surface')
  pd.putLong('pne_t0', 1)
  if (pneHB.n % 10 === 0) {
    pd.putByte('pne_sil', 1)
    m.setSilent(true)
  }
  if (k % 5 < 2) m.target = p
  return m
}

function pneHBFresh(p, k) {
  var types = ['epca:ripper', 'spore:knight', 'epca:infested_villager', 'spore:inf_human']
  var m = pneHBNewMob(types[k % types.length], p, k)
  m.getPersistentData().putByte('pne_fresh', 1)
  return m
}

function pneHBTracked() {
  var out = []
  var k
  for (k in pneHiveMobs) {
    if (pneHiveMobs.hasOwnProperty(k)) out.push(pneHiveMobs[k])
  }
  out.sort(function (a, b) { return a.u < b.u ? -1 : (a.u > b.u ? 1 : 0) })
  return out
}

function pneHBSetup() {
  var srv = __pneMock.server({ tickCount: 0, gameTime: 1000000 })
  var i
  var j
  var ch
  var e
  var mk = PNE_HIVE_GA.mask('epca:ripper')
  var guard = 0
  pneHB.srv = srv
  srv.lightAt = function (x, y, z) { return z < 0 ? 12 : 4 }
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  for (i = 0; i < 8; i++) {
    pneHB.players.push(__pneMock.player(srv, 'P' + i, 'aaaa0000-0000-4000-8000-00000000000' + i, { x: i * 64 - 224, z: i % 2 ? -12 : 12 }))
  }
  // a pool with history (48 entries, samples, baselines)
  for (i = 0; i < 300; i++) {
    PNE_HIVE_GA.breed(pneHiveSt)
    ch = PNE_HIVE_GA.join(pneHiveSt, null)
    e = PNE_HIVE_GA.express(ch.g, mk, 4)
    PNE_HIVE_GA.outcome(pneHiveSt, { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper/' + (i % 2) + '/' + (i % 4) + '/surface', e: e,
      tel: { dmg: i % 12, engagedSec: 5 + i % 40, located: 1, killShare: i % 17 === 0 ? 1 : 0, teamPressure: (i % 9) / 3, fastKill: false, cheese: false } })
  }
  // 400 genome mobs in the world, joining as rejoins
  for (i = 0; i < 400; i++) pneHBSpawned(pneHBSaved(pneHB.players[i % 8], i))
  while (pneHiveRejoinQ.length && guard++ < 1000) __pneMock.tick(srv, 1)
  // fresh mobs for the newborn unit case
  for (i = 0; i < 1200; i++) pneHB.fresh.push(pneHBFresh(pneHB.players[i % 8], i))
  for (j = 0; j < 60; j++) __pneMock.tick(srv, 1)
  srv.cmds = []
  return 'ok'
}

// Save cases: saveStart (PNE_HIVE_GA.saveBegin + the runtime string, gated against gaSavePart + save), savePiece (one
// incremental-save step: one PNE_HIVE_GA.savePart, the last one with saveEnd, exactly what the hive runs per free save
// slot, cycling through every piece kind) and saveSamples (the heaviest piece, the samples chunk), both gated against
// gaSavePart; all on a maximum-size GA state and maximum runtime tables (pneHBMaxState); the state changes between pieces
// (an outcome on a listed baseline, so copy on write is paid). saveOneCall is the one-call PNE_HIVE_GA.save + runtime string at the bench state
// (server stop only, outside the budget; printed). saveChunk / saveFinish are the write phase every save shares.
function pneHBCases() {
  return ['rejoin:40:20:rejoin:1', 'newborn:20:20:newborn:1', 'sample:200:20:mobSample', 'damage:200:20:mobSample', 'leaveKill:20:20:leaveOut:1',
    'leaveDisc:32:20:leaveOut:1', 'leaveDeep:32:20:=pneHBDeepCharge():1', 'leaveOther:200:20:mobSample', 'player:8:40:upkeep:1',
    'nearScan:8:40:=pneHBNearCharge():1',
    'silentVisit:20:30:silentVisit:1', 'light:1:40:lightPass', 'outcome:1:40:outcome:1', 'breed:1:40:breed', 'dream:1:60:dreamSlice',
    'dawn:1:40:dawn:1', 'saveStart:1:40:gaSavePart+save:1', 'savePiece:1:90:gaSavePart:1', 'saveSamples:1:40:gaSavePart:1',
    'saveOneCall:1:20:gaSave', 'saveChunk:1:60:save:1', 'saveFinish:1:20:2*save:1', 'hiveInfo:50:20', 'hiveNear:8:20'].join('|')
}

function pneHBMaxId(prefix, i) {
  var s = prefix + i + '_'
  while (s.length < 40) s += 'x'
  return s.substring(0, 40)
}

function pneHBMaxCtx(i) {
  var s = 'spore:a_very_long_species_identifier_' + i + '/1/3/surface/'
  while (s.length < 64) s += 'y'
  return s.substring(0, 64)
}

// The maximum-size GA state (as tools/hive/nbt_max.js builds it: pool 48 with 40-character ids, a full queue, 400 samples,
// 512 baselines with 64-character keys, the full log tail, a dream pending in its children phase) and maximum runtime
// tables (64 players seen, a 400-entry species ring of long ids), built once.
function pneHBMaxState() {
  var GA = PNE_HIVE_GA
  var st
  var i
  var k
  var ch
  var mk = GA.mask('spore:knight')
  var guard = 0
  if (pneHB.max) return pneHB.max
  st = GA.newState(2890182371)
  GA.epoch(st, 7)
  for (i = 0; i < 700; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    GA.outcome(st, { id: pneHBMaxId('outcome_', i), g: ch.g, parents: [pneHBMaxId('parent_a', i), pneHBMaxId('parent_b', i)], ctx: pneHBMaxCtx(i),
      e: GA.express(ch.g, mk, 6.5), tel: { dmg: 11.999999, engagedSec: 1999.999999, located: 1, killShare: 0.999999, teamPressure: 999.999999, fastKill: false, cheese: false } })
  }
  for (i = 0; i < 20; i++) GA.breed(st)
  GA.dawn(st, { deaths3d: 99, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 10 })
  while (st.dream && (st.dream.ph !== 0 || st.dream.gen < 4 || st.dream.next.length < 40) && guard++ < 2000) GA.dreamSlice(st, mk, 6.5)
  pneHB.max = { st: st, pids: {}, ring: [], n: 0, mk: mk }
  for (i = 0; i < 64; i++) {
    k = ('00000000' + (i * 2654435761 >>> 0).toString(16)).slice(-8)
    pneHB.max.pids[k + k + k + k] = pneHB.srv.gameTime - i
  }
  for (i = 0; i < 400; i++) pneHB.max.ring.push('spore:a_very_long_species_identifier_number_' + (i % 60))
  return pneHB.max
}

// Runs fn with the maximum state and runtime tables in place of the live ones (two assignments each way).
function pneHBWithMax(fn) {
  var mx = pneHBMaxState()
  var st = pneHiveSt
  var pids = pneHivePids
  var ring = pneHiveSpRing
  var head = pneHiveSpHead
  pneHiveSt = mx.st
  pneHivePids = mx.pids
  pneHiveSpRing = mx.ring
  pneHiveSpHead = 0
  try {
    fn()
  } finally {
    pneHiveSt = st
    pneHivePids = pids
    pneHiveSpRing = ring
    pneHiveSpHead = head
  }
}

// Untimed: the state changes between two pieces (an outcome on one of the 512 listed baselines: copy on write).
function pneHBMaxChurn() {
  var mx = pneHBMaxState()
  var GA = PNE_HIVE_GA
  var ch
  mx.n++
  ch = GA.join(mx.st, null)
  GA.breed(mx.st)
  GA.outcome(mx.st, { id: pneHBMaxId('churn_', mx.n), g: ch.g, parents: ch.parents, ctx: pneHBMaxCtx(700 - 512 + (mx.n * 37) % 512), e: GA.express(ch.g, mx.mk, 6.5),
    tel: { dmg: 5, engagedSec: 30, located: 1, killShare: 0, teamPressure: 3, fastKill: false, cheese: false } })
}

// Untimed: a maximum-state incremental save in its GA phase with `skip` pieces already done (a new one when the last is
// finished or none runs).
function pneHBMaxSaving(fresh, skip) {
  var i
  pneHBWithMax(function () {
    if (fresh || !pneHiveSaving || pneHiveSaving.ph !== 'ga' || pneHiveSaving.st !== pneHiveSt) {
      pneHiveSaving = null
      pneHiveSaveStart(pneHB.srv)
      for (i = 0; i < skip; i++) pneHiveSavePart()
    }
  })
}

// A maximum-state save left behind by the save cases must not reach the tick phases (it would only start over there).
function pneHBDropMaxSave() {
  if (pneHB.max && pneHiveSaving && pneHiveSaving.st === pneHB.max.st) pneHiveSaving = null
}

// What one leaveDeep record is charged: leaveOut plus convRec per newborn of the burst tick's window (pneHiveTakeLeave).
function pneHBDeepCharge() {
  var keep = pneHiveNewQ
  var c
  if (!pneHB.deepQ) pneHB.deepQ = pneHBDeepQ(pneHB.srv.gameTime)
  pneHiveNewQ = pneHB.deepQ
  c = pneHiveCost('leaveOut') + pneHiveConvWindow(pneHB.deepQ[pneHB.deepQ.length - 1].t) * pneHiveCost('convRec')
  pneHiveNewQ = keep
  return c
}

// Mean charge of one per-player pneHiveNear table entry (nearBase + nearRec per record in the player's 3x3 grid cells).
function pneHBNearCharge() {
  var i
  var ps
  var sum = 0
  for (i = 0; i < 8; i++) {
    ps = pneHivePlayerSt[pneCoreUuid(pneHB.players[i])]
    sum += pneHiveCost('nearBase') + (ps ? pneHiveNearCount(ps.dim, ps.x, ps.z) : 0) * pneHiveCost('nearRec')
  }
  return sum / 8
}

// A newborn queue 4096 deep, sorted by join time like the live one: 3996 joins over 999 ticks, then a burst of 100 joins
// in the newest tick (a chunk loading many parasites at once), none near the removals.
function pneHBDeepQ(now) {
  var q = []
  var i
  for (i = 0; i < 3996; i++) q.push({ mob: null, u: pneHBUuid(900000 + i), n: 0, t: now - 999 + Math.floor(i / 4), p: [3000 + i, 64, 0], dim: 'minecraft:overworld' })
  for (i = 0; i < 100; i++) q.push({ mob: null, u: pneHBUuid(990000 + i), n: 0, t: now, p: [2000 + i, 64, 90], dim: 'minecraft:overworld' })
  return q
}

// 40 silent records for the silentVisit case (the first tracked mobs by UUID, silenced for the case; silenced again when
// an earlier visit dropped Silent).
function pneHBSilentRecs() {
  var all = pneHBTracked()
  var out = []
  var i
  var r
  for (i = 0; i < all.length && out.length < 40; i++) {
    r = all[i]
    if (r.dead || r.mob.removed) continue
    r.silGene = true
    r.attacked = false
    if (!r.sil) pneHiveSilence(pneHB.srv, r, r.mob.getPersistentData())
    if (r.sil) out.push(r)
  }
  return out
}

var pneHBRecs = null

function pneHBRun(name, n) {
  var srv = pneHB.srv
  var now = srv.gameTime
  var i
  var r
  var q
  var p
  if (!pneHBRecs || pneHBRecs.length < 50) pneHBRecs = pneHBTracked()
  for (i = 0; i < n; i++) {
    pneHB.cyc++
    r = pneHBRecs[pneHB.cyc % pneHBRecs.length]
    if (pneHiveMobs.hasOwnProperty(r.u)) r = pneHiveMobs[r.u]
    p = pneHB.players[pneHB.cyc % 8]
    if (name === 'rejoin') {
      pneHiveRejoin(srv, r.mob, r.u)
    } else if (name === 'newborn') {
      q = pneHB.fresh.length ? pneHB.fresh.pop() : pneHBFresh(p, pneHB.cyc)
      pneHiveNewborn(srv, { mob: q, u: String(q.getStringUuid()), n: 0, t: now })
    } else if (name === 'sample') {
      pneHiveSample(srv, r, now + i)
    } else if (name === 'damage') {
      pneHiveOnDamage(srv, 'd|' + r.u + '|' + pneCoreUuid(p) + '|1500|1|0|' + now)
    } else if (name === 'leaveKill') {
      // the record alone: the mob is tracked again untimed (pneHBPrep)
      if (r.dead) continue
      r.mob.removed = true
      pneHiveOnLeave(srv, 'l|' + r.u + '|KILLED|' + r.g + '|' + r.id + '|' + r.x + '|64|' + r.z + '|minecraft:overworld|' + now + '|0|' + r.type)
      r.mob.removed = false
      pneHB.killed.push(r)
    } else if (name === 'leaveDisc') {
      // a DISCARDED genome record far from every player with no newborn waiting (despawn check only)
      pneHiveOnLeave(srv, 'l|' + pneHBUuid(800000 + (pneHB.cyc % 1000)) + '|DISCARDED|' + r.g + '|z' + pneHB.cyc + '|' + (2000 + (pneHB.cyc % 100)) +
        '.00|64.00|50.00|minecraft:overworld|' + now + '|0|epca:ripper')
    } else if (name === 'leaveDeep') {
      // a DISCARDED genome record far from every player, removed in the tick of the burst (conversion search over the deep
      // queue walks the 100 joins of that tick; then the despawn check)
      pneHiveOnLeave(srv, 'l|' + pneHBUuid(800000 + (pneHB.cyc % 1000)) + '|DISCARDED|' + r.g + '|z' + pneHB.cyc + '|' + (2000 + (pneHB.cyc % 100)) +
        '.00|64.00|50.00|minecraft:overworld|' + pneHB.deepQ[pneHB.deepQ.length - 1].t + '|0|epca:ripper')
    } else if (name === 'leaveOther') {
      pneHiveOnLeave(srv, 'l|' + r.u + '|UNLOADED_TO_CHUNK|' + r.g + '|' + r.id + '|' + r.x + '|64|' + r.z + '|minecraft:overworld|' + now + '|0|' + r.type)
    } else if (name === 'player') {
      pneHivePlayerStep(srv, p, now)
    } else if (name === 'nearScan') {
      pneHivePlayerSt[pneCoreUuid(p)].t = now
      pneHiveNearUpdate(p, now)
    } else if (name === 'silentVisit') {
      q = pneHB.sil[pneHB.cyc % pneHB.sil.length]
      q.ashT = -1000000
      pneHiveSilentVisit(srv, q, now + pneHB.cyc * 200)
    } else if (name === 'light') {
      pneHiveLightAt = 0
      pneHiveLightJob(srv)
      srv.cmds = []
    } else if (name === 'outcome') {
      PNE_HIVE_GA.outcome(pneHiveSt, pneHiveOutcomeRec(r) || { id: r.id, g: r.g, parents: r.parents, ctx: r.ctx, e: r.e,
        tel: { dmg: 3, engagedSec: 12, located: 1, killShare: 0, teamPressure: 1, fastKill: false, cheese: false } })
    } else if (name === 'breed') {
      if (PNE_HIVE_GA.queueSize(pneHiveSt) >= 16) PNE_HIVE_GA.join(pneHiveSt, null)
      PNE_HIVE_GA.breed(pneHiveSt)
    } else if (name === 'dream') {
      if (!PNE_HIVE_GA.dreamPending(pneHiveSt)) PNE_HIVE_GA.dawn(pneHiveSt, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 3 })
      PNE_HIVE_GA.dreamSlice(pneHiveSt, PNE_HIVE_GA.mask('epca:ripper'), 4)
    } else if (name === 'dawn') {
      // exactly what the GA job's dawn charge covers: the inputs (hive-death ring, players seen, config, stage), then
      // PNE_HIVE_GA.dawn (governor, tactic profile, diversity, dream schedule) and the dawn bookkeeping
      pneHiveDawn(srv)
    } else if (name === 'saveStart') {
      pneHBWithMax(function () { pneHiveSaveStart(srv) })
    } else if (name === 'savePiece' || name === 'saveSamples') {
      // exactly the hive's step on a free save slot: the gaSavePart charge, then one savePart (saveEnd after the last)
      pneHBWithMax(function () { pneHiveSaveGaJob(srv, 2, 2) })
    } else if (name === 'saveOneCall') {
      pneHiveSaveBegin(srv)
    } else if (name === 'saveChunk') {
      pneHiveSaveBase(PNE_HIVE_BASE_CHUNK)
    } else if (name === 'saveFinish') {
      pneHiveSaveFinish()
    } else if (name === 'hiveInfo') {
      pneHiveInfo(r.mob)
    } else if (name === 'hiveNear') {
      pneHiveNear(p)
    }
  }
  srv.cmds = []
  return n
}

// Untimed preparation before each timed repetition (HiveBench calls it when defined).
function pneHBPrep(name) {
  var i
  var base = []
  var r
  // unit cases are timed outside the tick handler: nothing is refused for budget there
  pneCoreLeftMs = 1000000
  // the dawn case's side effects (evidence reset, save flag, dawn counter) are undone before anything else runs, so the
  // tick phases see the state the other cases leave
  if (pneHB.dawnKeep) {
    pneHiveTDay = pneHB.dawnKeep.tday
    pneHiveSaveDue = pneHB.dawnKeep.save
    pneHiveApexAt = pneHB.dawnKeep.apex
    pneHiveStats.dawns = pneHB.dawnKeep.dawns
    pneHB.dawnKeep = null
  }
  if (name === 'dawn') {
    pneHB.dawnKeep = { tday: pneHiveTDay.slice(0), save: pneHiveSaveDue, apex: pneHiveApexAt, dawns: pneHiveStats.dawns }
    // a day's tactic evidence, so every timed dawn runs the tactic-profile update as well
    pneHiveTDay = [40, 25, 10, 30, 5]
  }
  for (i = 0; i < pneHB.killed.length; i++) {
    r = pneHB.killed[i]
    if (!pneHiveMobs.hasOwnProperty(r.u)) pneHiveRejoin(pneHB.srv, r.mob, r.u)
  }
  pneHB.killed = []
  pneHiveOutQ = []
  pneHiveConv = []
  pneHBRecs = pneHBTracked()
  if (name === 'leaveDisc') {
    if (!pneHB.keepQ) pneHB.keepQ = pneHiveNewQ
    pneHiveNewQ = []
  } else if (name === 'leaveDeep') {
    if (!pneHB.deepQ) pneHB.deepQ = pneHBDeepQ(pneHB.srv.gameTime)
    if (!pneHB.keepQ) pneHB.keepQ = pneHiveNewQ
    pneHiveNewQ = pneHB.deepQ
  } else if (pneHB.keepQ) {
    pneHiveNewQ = pneHB.keepQ
    pneHB.keepQ = null
  }
  if (name === 'silentVisit') pneHB.sil = pneHBSilentRecs()
  if (name === 'saveStart') {
    pneHiveSaving = null
  } else if (name === 'savePiece') {
    pneHBMaxChurn()
    pneHBMaxSaving(false, 0)
  } else if (name === 'saveSamples') {
    // pool, queue and state done: the next piece is samples.0
    pneHBMaxChurn()
    pneHBMaxSaving(true, 3)
  } else {
    pneHBDropMaxSave()
  }
  if (name === 'saveChunk' || name === 'saveFinish') {
    pneHiveSaveBegin(pneHB.srv)
    if (name === 'saveChunk') {
      for (i = 0; i < 512; i++) base.push({ k: 'spore:a_long_context_key_for_the_benchmark_' + i + '/1/2/surface', v: [123456789, 987654321, 55555555, 999, 0] })
      pneHiveSaving.sv.base = base
    } else {
      pneHiveSaveBase(100000)
    }
  }
  return name
}

function pneHBPhases() {
  return 'drain:2000|quiet:2000|mixed:2000|deep:1000'
}

function pneHBPhase(name) {
  var k
  pneHBDropMaxSave()
  pneHB.phase = name
  pneHB.t0 = {}
  for (k in pneHiveStats) {
    if (pneHiveStats.hasOwnProperty(k)) pneHB.t0[k] = pneHiveStats[k]
  }
  pneHB.tells0 = pneHB.tells
  pneHB.kills0 = pneHB.kills
  pneHBRecs = null
  pneHB.drop0 = pneHiveStats.outDropped
  pneHB.phaseTicks = 0
  if (pneHB.keepQ) {
    pneHiveNewQ = pneHB.keepQ
    pneHB.keepQ = null
  }
  if (name === 'deep') {
    pneHiveQDamage().clear()
    pneHiveQLeave().clear()
    pneHiveRejoinQ = []
    pneHiveRejoinSet = {}
    pneHiveNewQ = []
    for (k = 0; k < 4000; k++) pneHBSpawned(pneHBFresh(pneHB.players[k % 8], pneHB.cyc++))
  }
  if (name === 'quiet') {
    pneHiveNewQ = []
    pneHiveRejoinQ = []
    pneHiveRejoinSet = {}
    pneHiveQDamage().clear()
    pneHiveQLeave().clear()
  }
  return name
}

function pneHBKill(r) {
  var srv = pneHB.srv
  r.mob.removed = true
  r.mob.reason = 'KILLED'
  pneHiveQLeave().add('l|' + r.u + '|KILLED|' + r.g + '|' + r.id + '|' + pneCoreFmt(r.x) + '|64.00|' + pneCoreFmt(r.z) + '|minecraft:overworld|' + srv.gameTime + '|0|' + r.type)
  pneHB.kills++
}

// Newborns keep joining in the drain phase; the oldest extra mobs leave (unloaded) so the tracked population stays
// about 400-600 (the table size a Hive Night produces).
function pneHBCull(n) {
  var k
  var r
  var c = 0
  if (pneHiveMobN <= 500) return
  for (k in pneHiveMobs) {
    if (!pneHiveMobs.hasOwnProperty(k) || c >= n) continue
    r = pneHiveMobs[k]
    r.mob.removed = true
    r.mob.reason = 'UNLOADED_TO_CHUNK'
    pneHiveQLeave().add('l|' + r.u + '|UNLOADED_TO_CHUNK|' + r.g + '|' + r.id + '|' + pneCoreFmt(r.x) + '|64.00|' + pneCoreFmt(r.z) + '|minecraft:overworld|' +
      pneHB.srv.gameTime + '|0|' + r.type)
    c++
  }
}

// One tick's events (untimed: in game they arrive through event handlers, outside the tick handler).
function pneHBEvents() {
  var srv = pneHB.srv
  var t = srv.tickCount
  var qd = pneHiveQDamage()
  var ql = pneHiveQLeave()
  var recs
  var i
  var p
  var r
  var wantNew = 0
  var wantRe = 0
  var wantRec = 0
  var kills = 0
  srv.cmds = []
  // outcome drops are gated from the end of the 200 warm-up ticks (a phase may inherit a full queue from the last one)
  if (++pneHB.phaseTicks === 200) pneHB.drop0 = pneHiveStats.outDropped
  if (pneHB.phase === 'drain') {
    wantNew = 8
    wantRe = 16
    wantRec = 40
    kills = 4
    pneHBCull(5)
  } else if (pneHB.phase === 'mixed') {
    pneHBCull(2)
    wantNew = t % 2 === 0 ? 2 : 0
    wantRe = t % 3 === 0 ? 4 : 0
    wantRec = t % 2 === 0 ? 8 : 0
    kills = t % 4 === 0 ? 2 : 0
  } else if (pneHB.phase === 'deep') {
    kills = t % 4 === 0 ? 1 : 0
    pneHBCull(5)
    // 4 joins a tick keep the queue about 4000 deep; every 100 ticks a burst of 100 joins in one tick
    for (i = 0; i < (t % 100 === 0 ? 100 : 4); i++) pneHBSpawned(pneHBFresh(pneHB.players[pneHB.cyc++ % 8], pneHB.cyc))
  } else {
    kills = t % 2 === 0 ? 1 : 0
    // a trickle of newborns (one every 50 ticks) takes children from the breed queue, so breeding keeps running
    if (t % 50 === 13) pneHBSpawned(pneHBFresh(pneHB.players[pneHB.cyc++ % 8], pneHB.cyc))
    if (t % 400 === 17) pneHiveSaveDue = true
    if (t % 1000 === 501) pneHiveDawnDue = true
    if (!PNE_HIVE_GA.dreamPending(pneHiveSt) && t % 300 === 5) PNE_HIVE_GA.dawn(pneHiveSt, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 3 })
  }
  if (!pneHBRecs || pneHBRecs.length < 100 || t % 200 === 0) pneHBRecs = pneHBTracked()
  recs = pneHBRecs
  if (!recs.length) return 0
  for (i = 0; i < recs.length; i++) {
    if (recs[i].dead && pneHiveMobs.hasOwnProperty(recs[i].u)) recs[i] = pneHiveMobs[recs[i].u]
  }
  // real kills (outcomes) replaced by saved mobs joining, so the tracked population stays about 400
  for (i = 0; i < kills; i++) {
    r = recs[(pneHB.cyc++) % recs.length]
    if (r.dead || r.mob.removed) continue
    pneHBKill(r)
    pneHBSpawned(pneHBSaved(pneHB.players[pneHB.cyc % 8], pneHB.cyc))
  }
  i = 0
  while (pneHiveNewQ.length < wantNew && i++ < 64) pneHBSpawned(pneHBFresh(pneHB.players[pneHB.cyc++ % 8], pneHB.cyc))
  i = 0
  while (pneHiveRejoinQ.length < wantRe && i++ < 64) {
    r = recs[(pneHB.cyc++) % recs.length]
    if (!r.dead && !r.mob.removed) pneHBSpawned(r.mob)
  }
  i = 0
  while (Number(qd.size()) < wantRec && i++ < 200) {
    r = recs[(pneHB.cyc++) % recs.length]
    p = pneHB.players[pneHB.cyc % 8]
    qd.add(pneHB.cyc % 9 === 0 ? 'p|' + r.u + '|' + pneCoreUuid(p) + '|' + srv.gameTime : 'd|' + r.u + '|' + pneCoreUuid(p) + '|' + (500 + pneHB.cyc % 3000) + '|' + (pneHB.cyc % 7 === 0 ? 0 : 1) + '|0|' + srv.gameTime)
  }
  if (pneHB.phase === 'deep') {
    // 32 DISCARDED genome removals far from every player (natural despawns) each tick
    for (i = 0; i < 32; i++) {
      r = recs[(pneHB.cyc++) % recs.length]
      ql.add('l|' + pneHBUuid(700000 + (pneHB.cyc % 50000)) + '|DISCARDED|' + r.g + '|z' + pneHB.cyc + '|' + (2000 + (pneHB.cyc % 100)) + '.00|64.00|' +
        (90 + (pneHB.cyc % 7)) + '.00|minecraft:overworld|' + srv.gameTime + '|0|epca:ripper')
    }
  }
  i = 0
  while (Number(ql.size()) < wantRec && i++ < 200) {
    r = recs[(pneHB.cyc++) % recs.length]
    ql.add('l|' + r.u + '|UNLOADED_TO_CHUNK|' + r.g + '|' + r.id + '|' + pneCoreFmt(r.x) + '|64.00|' + pneCoreFmt(r.z) + '|minecraft:overworld|' + srv.gameTime + '|0|' + r.type)
  }
  return 1
}

function pneHBTick() {
  __pneMock.tick(pneHB.srv, 1)
  return pneCoreSpentMs
}

function pneHBInfo() {
  var s = pneHiveStats
  var d = pneHB.t0
  return 'tracked ' + pneHiveMobN + ', newborns ' + (s.joins - d.joins) + ', rejoins ' + (s.rejoins - d.rejoins) + ', outcomes ' +
    (s.outcomes - d.outcomes) + ' (dropped ' + (s.outDropped - d.outDropped) + '), breeds ' + (s.breeds - d.breeds) + ', dream slices ' +
    (s.dream - d.dream) + ', saves ' + (s.saves - d.saves) + ', dawns ' + (s.dawns - d.dawns) + ', light passes ' + (s.light - d.light) +
    ', tells ' + (pneHB.tells - pneHB.tells0) + ', queues new ' + pneHiveNewQ.length + ' rejoin ' + pneHiveRejoinQ.length + ' out ' +
    pneHiveOutQ.length
}

// Per-trial gates of a phase (HiveBench calls it after each trial): 'OK' or 'FAIL reason'.
function pneHBPhaseCheck(name) {
  var s = pneHiveStats
  var d = pneHB.t0
  var dropped = s.outDropped - pneHB.drop0
  if (name === 'quiet') {
    if (!(s.breeds - d.breeds > 0 && s.dream - d.dream > 0)) return 'FAIL breeds ' + (s.breeds - d.breeds) + ', dream slices ' + (s.dream - d.dream) + ' (outcomes starved them)'
    if (dropped > 0) return 'FAIL ' + dropped + ' outcome(s) dropped after the warm-up'
  }
  if (name === 'mixed' && dropped > 0) return 'FAIL ' + dropped + ' outcome(s) dropped after the warm-up'
  return 'OK'
}

function pneHBCheck() {
  var bs = [PNE_HIVE_B_LOAD, PNE_HIVE_B_DRAIN, PNE_HIVE_B_SAMPLE, PNE_HIVE_B_SIL, PNE_HIVE_B_PLAYER, PNE_HIVE_B_LIGHT, PNE_HIVE_B_GA, PNE_HIVE_B_SAVE, PNE_HIVE_B_HOUSE, PNE_HIVE_B_EVENTS]
  var i
  var s = pneHiveStats
  for (i = 0; i < bs.length; i++) {
    if (bs[i].total > 0) return 'FAIL breaker ' + bs[i].name + ' counted ' + bs[i].total + ' failure(s)'
  }
  if (!(s.joins > 0 && s.rejoins > 0 && s.outcomes > 0 && s.breeds > 0 && s.dream > 0 && s.saves > 0 && s.dawns > 0 && s.light > 0 && pneHB.tells > 0)) {
    return 'FAIL some work never ran: ' + JSON.stringify(s) + ' tells ' + pneHB.tells
  }
  return 'OK'
}
