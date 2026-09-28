// ga-core-breed-bench workload (ES5). Timed from Java by tools/genome/rhino/RhinoGolden.java inside the instance's
// Rhino jar (interpreter, like KubeJS); the scripts themselves never read a clock.
// Every runtime call that HIVE charges against the token budget is timed on its own, one call per timing where the
// name ends in "_one" (per-call p50 / p95 / max: a budget constant has to cover the p95, not the mean):
//   breed_one            one PNE_HIVE_GA.breed on a full pool (breedOne with the sharing cache + queue push + log)
//   outcome_one          one outcome on a full pool (fitness, baseline, sample ring + Gram, insertCrowding, cache row,
//                        log): HIVE calls it from the leave drain, not on the breed tick
//   breed_first_one      the first breed after load() (the sharing cache must already be built by load)
//   dream_one            one dream slice, grouped by step type (score, elite, pairs, share, kids, insert)
//   dream_first_one      the first dream slice after loading a save taken mid-dream (derived data rebuilt by load)
//   dawn_one             one dawn with a full sample ring (ridge solve, diversity, dream scheduling)
//   save_one / load_one  one full persistence round (the string build; HIVE's NBT copy is separate)
//   savemax_one          save() in one call at the maximum state (pool 48 with 40-character ids, queue 16, 400 samples,
//                        512 baselines with 64-character keys, the 45,000-character log tail, a dream pending in its
//                        children phase: the state tools/hive/nbt_max.js builds); HIVE uses it only at server stop
//   savepart_one         one step of the incremental save at the maximum state, grouped by step (begin, pool, queue,
//                        state, samples, base, log, end); between two steps the untimed pneBenchPrep changes the state
//                        as the game does between ticks (an outcome on a new or a recently used context, a breed or a
//                        join), and every finished save is compared with save() taken at its saveBegin
//   outcome_max_one      one outcome() at the maximum state (the record, its join and its expression are prepared
//                        untimed), alternately on a new context (evicting the least recently used) and a recent one
//   outcome_saving_one   the same while an incremental save is registered (copy on write of the baselines it changes)
// Batch means (units per timed call > 1) for the summary and the cache criterion:
//   breed, outcome, breed_insert (breed + the outcome of that child), breed_insert_nocache (the same with the sharing
//   cache dropped before every breed: the uncached heavy core), join_pop / join_clone, express.

var pneBenchGA = (typeof PNE_HIVE_GA !== 'undefined') ? PNE_HIVE_GA
  : require(require('path').join(__dirname, '..', '..', '..', 'overrides', 'kubejs', 'server_scripts', 'pne_hive_core.js'))
var pneBenchSt = null
var pneBenchDreams = []
var pneBenchDreamAt = 0
var pneBenchSaved = null
var pneBenchSavedMid = null
var pneBenchLoaded = []
var pneBenchLoadedAt = 0
var pneBenchMid = []
var pneBenchMidAt = 0
var pneBenchK = 0
var pneBenchMk = null
var pneBenchLastLabel = ''
var pneBenchFirstOk = true
var pneBenchMax = null
var pneBenchMax2 = null
var pneBenchMaxMk = null
var pneBenchMaxK = 0
var pneBenchSv = null
var pneBenchSvRef = ''
var pneBenchSvLast = null
var pneBenchSvStep = ''
var pneBenchSvDone = 0
var pneBenchSvBad = 0
var pneBenchSvPieces = 0
var pneBenchSaving = null
var pneBenchSavingN = 0
var pneBenchOutRec = null

function pneBenchRec(ch, i) {
  var GA = pneBenchGA
  return {
    id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper|' + (i % 2) + '|' + (i % 4) + '|surface',
    e: GA.express(ch.g, pneBenchMk, 4.05),
    tel: { dmg: (i * 7) % 12, engagedSec: 5 + (i * 13) % 40, located: i % 5 !== 0, killShare: i % 17 === 0 ? 1 : 0, teamPressure: (i % 9) / 3, fastKill: false, cheese: i % 41 === 0 }
  }
}

function pneBenchBuild(seed, spawns) {
  var GA = pneBenchGA
  var st = GA.newState(seed)
  var i
  var ch
  for (i = 0; i < spawns; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    GA.outcome(st, pneBenchRec(ch, i))
    if (i % 60 === 59) GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.1, 0.2, 0.3, 0.3, 0.1], stage: 3 })
    while (GA.dreamPending(st)) GA.dreamSlice(st, pneBenchMk, 4.05)
  }
  return st
}

// The maximum state (tools/hive/nbt_max.js, GA part): 700 outcomes with 40-character ids, two 40-character parents and
// 64-character contexts, all distinct (512 baselines, with evictions), maximal telemetry (ten-digit EMAs); then a full
// queue and a dawn dream stopped in its children phase (dnext partly filled).
function pneBenchMaxId(prefix, i) {
  var s = prefix + i + '_'
  while (s.length < 40) s += 'x'
  return s.substring(0, 40)
}

function pneBenchMaxCtx(i) {
  var s = 'spore:a_very_long_species_identifier_' + i + '/1/3/surface/'
  while (s.length < 64) s += 'y'
  return s.substring(0, 64)
}

function pneBenchMaxRec(st, i, ctxI) {
  var GA = pneBenchGA
  var ch = GA.join(st, null)
  return {
    id: pneBenchMaxId('outcome_', i), g: ch.g, parents: [pneBenchMaxId('parent_a', i), pneBenchMaxId('parent_b', i)], ctx: pneBenchMaxCtx(ctxI),
    e: GA.express(ch.g, pneBenchMaxMk, 6.5),
    tel: { dmg: 999.999999, engagedSec: 1999.999999, located: 1, killShare: 0.999999, teamPressure: 999.999999, fastKill: false, cheese: false }
  }
}

function pneBenchMaxOutcome(st, i, ctxI) {
  pneBenchGA.outcome(st, pneBenchMaxRec(st, i, ctxI))
}

// Odd calls use a new context (an eviction), even calls one of the last ~100 used (an entry an incremental save lists).
function pneBenchMaxCtxOf(k, base) {
  return k % 2 ? base + k : base + k - 1 - (k % 97)
}

function pneBenchBuildMax(seed) {
  var GA = pneBenchGA
  var st = GA.newState(seed)
  var i
  var guard = 0
  for (i = 0; i < 700; i++) {
    GA.breed(st)
    pneBenchMaxOutcome(st, i, i)
  }
  for (i = 0; i < 20; i++) GA.breed(st)
  GA.dawn(st, { deaths3d: 99, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 10 })
  while (st.dream && (st.dream.ph !== 0 || st.dream.gen < 4 || st.dream.next.length < 40) && guard++ < 2000) GA.dreamSlice(st, pneBenchMaxMk, 6.5)
  return st
}

function pneBenchMaxOk(st) {
  var GA = pneBenchGA
  return GA.poolSize(st) === 48 && GA.queueSize(st) >= 15 && st.se.length === 400 && st.baseN === 512 && st.evc > 44000 &&
    st.dream !== null && st.dream.next.length >= 40
}

// Between two steps of an incremental save the game goes on: an outcome (alternately on a new context, which evicts the
// least recently used one, and on a recently used one, which changes an entry the save still lists), then breeds that
// refill the queue. The maximum state stays at its limits.
function pneBenchMaxTick(st) {
  var GA = pneBenchGA
  pneBenchMaxK++
  pneBenchMaxOutcome(st, 5000 + pneBenchMaxK, pneBenchMaxCtxOf(pneBenchMaxK, 5000))
  GA.breed(st)
  GA.breed(st)
}

// Step type of the next slice of a pending dream (the slicing plan of pne_hive_core.js dreamPlan).
function pneBenchStepType(st) {
  var dr = st.dream
  var P
  var nS
  var nP
  var sS
  if (!dr) return ''
  if (dr.ph === 1) return 'insert'
  P = dr.pop.length
  nS = Math.ceil(P / 16)
  nP = Math.ceil(P * (P - 1) / 2 / 150)
  sS = nS + 1 + nP
  if (dr.sub < nS) return 'score'
  if (dr.sub === nS) return 'elite'
  if (dr.sub < sS) return 'pairs'
  if (dr.sub === sS) return 'share'
  return 'kids'
}

function pneBenchSetup() {
  var GA = pneBenchGA
  var i
  var st
  var P
  var sS
  pneBenchMk = GA.mask('epca:ripper')
  // JVM warm-up: HotSpot compiles Rhino's interpreter loop only after a while, and a case timed before that runs
  // several times slower than a long-running server ever does (measured: breed 0.58 ms cold against 0.08 ms warm).
  // A discarded 2500-spawn run (breeds, joins, outcomes, 40 dawns and their dreams, saves and loads) comes first.
  st = pneBenchBuild(424242, 2500)
  for (i = 0; i < 3; i++) GA.load(GA.save(st), 424242)
  pneBenchMaxMk = GA.mask('spore:knight')
  pneBenchMax = pneBenchBuildMax(2890182371)
  pneBenchMax2 = GA.load(GA.save(pneBenchMax), 2890182371)
  // warm the incremental save path too (5 complete saves with the game going on between steps)
  for (i = 0; i < 5; i++) {
    st = GA.saveBegin(pneBenchMax2)
    while (!GA.saveDone(st)) {
      pneBenchMaxTick(pneBenchMax2)
      GA.savePart(st)
    }
    GA.saveEnd(st)
    GA.save(pneBenchMax2)
  }
  pneBenchSt = pneBenchBuild(20260927, 500)
  pneBenchSaved = GA.save(pneBenchSt)
  // 7 dreams: 3 warm-up slices + 642 timed slices (6 full dreams of 107 slices).
  for (i = 0; i < 7; i++) {
    st = GA.load(pneBenchSaved, 20260927)
    GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.1, 0.2, 0.3, 0.3, 0.1], stage: 3 })
    pneBenchDreams.push(st)
  }
  // A save taken in the children steps of dream generation 2, after every score, elite, pair and sharing step of that
  // generation: the most derived data a reload has to rebuild.
  st = GA.load(pneBenchSaved, 20260927)
  GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.1, 0.2, 0.3, 0.3, 0.1], stage: 3 })
  P = st.dream.pop.length
  sS = Math.ceil(P / 16) + 1 + Math.ceil(P * (P - 1) / 2 / 150)
  while (GA.dreamPending(st) && !(st.dream.ph === 0 && st.dream.gen === 1 && st.dream.sub === sS + 2)) GA.dreamSlice(st, pneBenchMk, 4.05)
  pneBenchSavedMid = GA.save(st)
  // 23 loaded copies each (3 warm-up + 20 timed first calls).
  for (i = 0; i < 23; i++) {
    st = GA.load(pneBenchSaved, 20260927)
    st.queue.length = 0
    if (!st.C || st.C.n !== st.pool.length) pneBenchFirstOk = false
    pneBenchLoaded.push(st)
    st = GA.load(pneBenchSavedMid, 20260927)
    if (!st.dream || !st.dream.x || !st.dream.x.sel) pneBenchFirstOk = false
    pneBenchMid.push(st)
  }
  return 'ok'
}

function pneBenchCases() {
  return 'breed:200:15|outcome:200:15|breed_insert:200:15|breed_insert_nocache:40:10|join_pop:400:10|join_clone:200:10|express:2000:10|' +
    'breed_one:1:400|outcome_one:1:400|breed_first_one:1:20|dream_one:1:642|dream_first_one:1:20|dawn_one:1:30|save_one:1:30|load_one:1:10|' +
    'savemax_one:1:60|savepart_one:1:900|outcome_max_one:1:400|outcome_saving_one:1:400'
}

function pneBenchLabel(name) {
  if (name === 'savepart_one') return pneBenchSvStep
  return name === 'dream_one' ? pneBenchLastLabel : ''
}

// A finished incremental save must equal save() taken at its saveBegin, whatever happened in between.
function pneBenchSvCompare() {
  if (pneBenchSvLast === null) return
  pneBenchSvDone++
  if (JSON.stringify(pneBenchSvLast) !== pneBenchSvRef) pneBenchSvBad++
  pneBenchSvLast = null
}

// Untimed preparation before every call (RhinoGolden calls it when defined).
function pneBenchPrep(name) {
  var GA = pneBenchGA
  if (name === 'savepart_one') {
    pneBenchSvCompare()
    if (pneBenchSv === null) pneBenchSvRef = JSON.stringify(GA.save(pneBenchMax))
    else pneBenchMaxTick(pneBenchMax)
  } else if (name === 'outcome_max_one' || name === 'outcome_saving_one') {
    // a fresh registration every 16 outcomes, so the first-change copies keep being measured
    if (name === 'outcome_saving_one' && pneBenchSavingN++ % 16 === 0) pneBenchSaving = GA.saveBegin(pneBenchMax2)
    GA.breed(pneBenchMax2)
    pneBenchMaxK++
    pneBenchOutRec = pneBenchMaxRec(pneBenchMax2, 9000 + pneBenchMaxK, pneBenchMaxCtxOf(pneBenchMaxK, 9000))
  }
}

function pneBenchRun(name, n) {
  var GA = pneBenchGA
  var st = pneBenchSt
  var i
  var ch
  var d
  for (i = 0; i < n; i++) {
    pneBenchK++
    if (name === 'breed' || name === 'breed_one') {
      if (st.queue.length >= 16) st.queue.length = 0
      GA.breed(st)
    } else if (name === 'outcome' || name === 'outcome_one') {
      GA.outcome(st, pneBenchRec({ id: 'o' + pneBenchK, g: st.pool[pneBenchK % 48].g, parents: st.pool[(pneBenchK * 7) % 48].id }, pneBenchK))
    } else if (name === 'breed_first_one') {
      d = pneBenchLoaded[pneBenchLoadedAt++]
      if (d) GA.breed(d)
    } else if (name === 'breed_insert' || name === 'breed_insert_nocache') {
      if (st.queue.length >= 16) st.queue.length = 0
      if (name === 'breed_insert_nocache') GA.prim.dropCache(st)
      GA.breed(st)
      ch = st.queue.pop()
      GA.outcome(st, pneBenchRec({ id: ch.id, g: ch.g, parents: ch.parents.join(',') }, pneBenchK))
    } else if (name === 'join_pop') {
      if (!st.queue.length) GA.breed(st)
      GA.join(st, null)
    } else if (name === 'join_clone') {
      st.queue.length = 0
      GA.join(st, null)
    } else if (name === 'express') {
      GA.express(st.pool[pneBenchK % 48].g, pneBenchMk, 4.05)
    } else if (name === 'dream_one') {
      while (pneBenchDreamAt < pneBenchDreams.length && !GA.dreamPending(pneBenchDreams[pneBenchDreamAt])) pneBenchDreamAt++
      d = pneBenchDreams[pneBenchDreamAt]
      pneBenchLastLabel = d ? pneBenchStepType(d) : ''
      if (d) GA.dreamSlice(d, pneBenchMk, 4.05)
    } else if (name === 'dream_first_one') {
      d = pneBenchMid[pneBenchMidAt++]
      if (d) GA.dreamSlice(d, pneBenchMk, 4.05)
    } else if (name === 'dawn_one') {
      GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.1, 0.2, 0.3, 0.3, 0.1], stage: 3 })
    } else if (name === 'save_one') {
      GA.save(st)
    } else if (name === 'savemax_one') {
      GA.save(pneBenchMax)
    } else if (name === 'savepart_one') {
      if (pneBenchSv === null) {
        pneBenchSv = GA.saveBegin(pneBenchMax)
        pneBenchSvStep = 'begin'
      } else if (!GA.saveDone(pneBenchSv)) {
        d = GA.savePart(pneBenchSv)
        pneBenchSvStep = d ? d.part : 'none'
        pneBenchSvPieces++
      } else {
        pneBenchSvLast = GA.saveEnd(pneBenchSv)
        pneBenchSv = null
        pneBenchSvStep = 'end'
      }
    } else if (name === 'outcome_max_one' || name === 'outcome_saving_one') {
      GA.outcome(pneBenchMax2, pneBenchOutRec)
    } else if (name === 'load_one') {
      GA.load(pneBenchSaved, 20260927)
    }
  }
  return n
}

function pneBenchCheck() {
  var GA = pneBenchGA
  var maxOk
  var ok
  pneBenchSvCompare()
  maxOk = pneBenchMaxOk(pneBenchMax) && pneBenchMaxOk(pneBenchMax2)
  ok = GA.prim.cacheCheck(pneBenchSt) && GA.poolSize(pneBenchSt) === 48 && pneBenchFirstOk && pneBenchDreamAt >= 6 &&
    pneBenchLoadedAt >= 23 && pneBenchMidAt >= 23 && maxOk && pneBenchSvDone >= 50 && pneBenchSvBad === 0
  return (ok ? 'PASS' : 'FAIL') + ' bench state: pool ' + GA.poolSize(pneBenchSt) + ', cache consistent ' + GA.prim.cacheCheck(pneBenchSt) +
    ', load builds the cache and the dream data ' + pneBenchFirstOk + ', dreams used ' + pneBenchDreamAt + ', first calls ' + pneBenchLoadedAt + '/' + pneBenchMidAt +
    '; maximum state kept ' + maxOk + ' (pool ' + GA.poolSize(pneBenchMax) + ', queue ' + GA.queueSize(pneBenchMax) + ', samples ' + pneBenchMax.se.length +
    ', contexts ' + pneBenchMax.baseN + ', log ' + pneBenchMax.evc + ' chars, dream next ' + (pneBenchMax.dream ? pneBenchMax.dream.next.length : -1) +
    '); incremental saves ' + pneBenchSvDone + ' (' + pneBenchSvPieces + ' pieces), ' + pneBenchSvBad + ' differing from save() at their saveBegin'
}
