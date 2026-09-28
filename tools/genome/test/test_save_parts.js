// ga-core-save-parts: the incremental save, the load epoch and the LRU list of the context baselines. ES5, Node and
// Rhino (python tools/genome/rhino/run.py saveparts runs both and compares their digests).
//
//  1. Incremental save (saveBegin / savePart / saveDone / saveEnd): for 6 seeds a state is driven past every limit (48
//     pool entries, 512 context baselines with evictions, 400 samples, a full log tail, dreams, tactic shifts), then 4
//     incremental saves run while a random legal driver keeps changing the state between every two pieces (breeds, joins
//     with and without a conversion link, outcomes on new and on recently used contexts, dawns, dream slices, governor
//     steps, new epochs). Each finished save must equal save() taken at its saveBegin (every field as text), its pieces
//     must reassemble into that result in the order pool, queue, state, samples..., base..., log (base slices of at most
//     64 contexts, samples chunks of at most 48,000 characters), load() of it must give hashAll() of the state at
//     saveBegin, and the copy on write must end with it. Coverage counters prove that snapshot baselines were changed and
//     evicted, samples overwritten, pool entries replaced, dawns and dream slices and epochs run while saves were open.
//  2. Edge cases: a newer saveBegin supersedes (the old context gives null), saveEnd right after saveBegin, save() in the
//     middle of an incremental save, an empty state, invalid contexts (null, never a throw).
//  3. LRU list: 1,500 outcomes over 700 contexts against a reference model (map of last use, evict the minimum at 512):
//     same keys in the same recency order after every 25 outcomes, list links consistent both ways, save().base ranks.
//  4. Epoch: ids carry '.<ep>' once declared (b, j and d ids), the E event, ep in the state string and through load(),
//     the epoch only grows, replay reproduces E (and a tampered E is caught at the next id), load() range checks; and
//     after a rollback to the same save two runs with different epochs share no GA-generated id (without the epoch they
//     share all of them).
// Node: node tools/genome/test/test_save_parts.js    Rhino: evaluate pne_hive_core.js + this file, read pneSpResult.

var pneSpGA = (typeof PNE_HIVE_GA !== 'undefined') ? PNE_HIVE_GA
  : require(require('path').join(__dirname, '..', '..', '..', 'overrides', 'kubejs', 'server_scripts', 'pne_hive_core.js'))
var pneSpFails = []
var pneSpCount = 0
var pneSpDigest = 0
var pneSpCov = { snapChanged: 0, snapEvicted: 0, samplesOver: 0, poolReplaced: 0, dawn: 0, dream: 0, epoch: 0, link: 0, shift: 0 }

function pneSpT(cond, msg) {
  pneSpCount++
  if (!cond) pneSpFails.push(msg)
}

function pneSpMix(s) {
  var P = pneSpGA.prim
  pneSpDigest = P.fmix32((pneSpDigest ^ P.fnv1a(s)) >>> 0)
}

function pneSpSer(sv) {
  var parts = [sv.pool, sv.queue, sv.state, sv.samples.join('/'), sv.log]
  var i
  for (i = 0; i < sv.base.length; i++) parts.push(sv.base[i].k + '=' + sv.base[i].v.join(','))
  return parts.join('#')
}

// ---------------------------------------------------------------------------------------------
// The random legal driver

function pneSpScenario(seed) {
  var GA = pneSpGA
  return { st: GA.newState(seed), seed: seed, drv: GA.prim.rngFor(seed, 'pne_sp_driver', 0), mk: GA.mask('epca:ripper'), alive: [], ctxN: 0, flip: 0 }
}

function pneSpRec(sc, m, fresh) {
  var GA = pneSpGA
  var d = sc.drv
  var ctx
  if (fresh || d.next() < 0.5) ctx = 'n' + (sc.ctxN++)
  else ctx = 'n' + Math.max(0, sc.ctxN - 1 - Math.floor(d.next() * 60))
  return {
    id: m.id, g: m.g, parents: m.parents, ctx: ctx, e: GA.express(m.g, sc.mk, 3 + d.next() * 3),
    tel: { dmg: d.next() * 14, engagedSec: d.next() * 60, located: d.next() < 0.7 ? 1 : 0, killShare: d.next() < 0.1 ? 1 : 0,
      teamPressure: d.next() * 5, fastKill: d.next() < 0.05, cheese: d.next() < 0.03 }
  }
}

// Tactic evidence around one profile; sc.flip switches to the opposite one, so the next dawns detect a shift (and clear
// the samples). The build keeps one profile, so the sample ring fills.
function pneSpTDay(sc) {
  var d = sc.drv
  var v = sc.flip ? [0.62, 0.12, 0.1, 0.08, 0.08] : [0.08, 0.08, 0.1, 0.12, 0.62]
  var i
  for (i = 0; i < 5; i++) v[i] += d.next() * 0.04
  return v
}

function pneSpJoin(sc, link) {
  var ch = pneSpGA.join(sc.st, link)
  sc.alive.push({ id: ch.id, g: ch.g, parents: ch.parents })
  if (sc.alive.length > 60) sc.alive.shift()
  return ch
}

function pneSpAct(sc) {
  var GA = pneSpGA
  var st = sc.st
  var d = sc.drv
  var x = d.next()
  var m
  var j
  var sh
  if (GA.dreamPending(st) && x < 0.25) {
    GA.dreamSlice(st, sc.mk, 4.2)
    return 'R'
  }
  if (x < 0.40) {
    GA.breed(st)
    return 'B'
  }
  if (x < 0.62) {
    if (sc.alive.length && d.next() < 0.15) {
      m = sc.alive[Math.floor(d.next() * sc.alive.length)]
      pneSpJoin(sc, { id: m.id, g: m.g })
      return 'L'
    }
    pneSpJoin(sc, null)
    return 'J'
  }
  if (x < 0.93) {
    if (!sc.alive.length) {
      pneSpJoin(sc, null)
      return 'J'
    }
    j = Math.floor(d.next() * sc.alive.length)
    m = sc.alive[j]
    sc.alive.splice(j, 1)
    GA.outcome(st, pneSpRec(sc, m, false))
    return 'I'
  }
  if (x < 0.965) {
    sh = st.lastShift
    GA.dawn(st, { deaths3d: Math.floor(d.next() * 4), target: 1 + Math.floor(d.next() * 3), tDay: pneSpTDay(sc), stage: Math.floor(d.next() * 11) })
    return st.lastShift !== sh ? 'S' : 'D'
  }
  if (x < 0.985) {
    GA.govStep(st)
    return 'G'
  }
  GA.epoch(st, GA.ep(st) + 1 + Math.floor(d.next() * 3))
  return 'E'
}

// Past every limit: 600 outcomes on fresh contexts (512 baselines, then evictions), dawns every 50 with their dreams
// partly sliced, then 300 random actions.
function pneSpBuild(seed) {
  var GA = pneSpGA
  var sc = pneSpScenario(seed)
  var i
  var m
  for (i = 0; i < 600; i++) {
    GA.breed(sc.st)
    m = pneSpJoin(sc, null)
    sc.alive.pop()
    GA.outcome(sc.st, pneSpRec(sc, { id: m.id, g: m.g, parents: m.parents }, true))
    if (i % 50 === 49) GA.dawn(sc.st, { deaths3d: 1, target: 1, tDay: pneSpTDay(sc), stage: 3 })
    if (GA.dreamPending(sc.st) && i % 2) GA.dreamSlice(sc.st, sc.mk, 4.2)
  }
  for (i = 0; i < 300; i++) pneSpAct(sc)
  return sc
}

// ---------------------------------------------------------------------------------------------
// 1. Incremental saves under a changing state

function pneSpOneSave(sc, label) {
  var GA = pneSpGA
  var st = sc.st
  var ref = pneSpSer(GA.save(st))
  var hA = GA.hashAll(st)
  var poolIds0 = st.pool.map(function (p) { return p.id }).join(',')
  var ring0 = st.se.length
  var c = GA.saveBegin(st)
  var pieces = []
  var order = []
  var p
  var n
  var a
  var res
  var ld
  var i
  var ok
  var base = []
  var chunks = []
  var guard = 0
  pneSpT(c !== null && st.cow === c, label + ': saveBegin registers the copy on write')
  while (!GA.saveDone(c) && guard++ < 200) {
    n = Math.floor(sc.drv.next() * 5)
    for (i = 0; i < n; i++) {
      a = pneSpAct(sc)
      if (a === 'D' || a === 'S') pneSpCov.dawn++
      if (a === 'S') pneSpCov.shift++
      if (a === 'R') pneSpCov.dream++
      if (a === 'E') pneSpCov.epoch++
      if (a === 'L') pneSpCov.link++
      if (a === 'I' && ring0 === 400) pneSpCov.samplesOver++
    }
    p = GA.savePart(c)
    if (p === null) break
    pieces.push(p)
    order.push(p.part)
  }
  for (i = 0; i < c.be.length; i++) {
    if (c.be[i].cw === c.id) pneSpCov.snapChanged++
    if (st.base[c.be[i].key] !== c.be[i]) pneSpCov.snapEvicted++
  }
  if (st.pool.map(function (x) { return x.id }).join(',') !== poolIds0) pneSpCov.poolReplaced++
  pneSpAct(sc)
  res = GA.saveEnd(c)
  pneSpT(res !== null && pneSpSer(res) === ref, label + ': the incremental save equals save() taken at saveBegin')
  pneSpT(st.cow === null, label + ': saveEnd ends the copy on write')
  pneSpT(GA.savePart(c) === null && GA.saveDone(c) && res !== null && pneSpSer(GA.saveEnd(c)) === ref, label + ': a finished context gives no more pieces and the same result again')
  // the pieces reassemble into the result, in the documented order
  ok = pieces.length >= 4 && order[0] === 'pool' && order[1] === 'queue' && order[2] === 'state' && order[order.length - 1] === 'log'
  for (i = 3; i < order.length - 1; i++) {
    if (order[i] === 'samples') {
      if (base.length) ok = false
      if (pieces[i].i !== chunks.length || pieces[i].value.length > 48000) ok = false
      chunks.push(pieces[i].value)
    } else if (order[i] === 'base') {
      if (pieces[i].i !== base.length || pieces[i].value.length > 64 || pieces[i].value.length < 1) ok = false
      base = base.concat(pieces[i].value)
    } else {
      ok = false
    }
  }
  ok = ok && res !== null && pieces[0].value === res.pool && pieces[1].value === res.queue && pieces[2].value === res.state &&
    pieces[pieces.length - 1].value === res.log && chunks.join('/') === res.samples.join('/') && base.length === res.base.length
  for (i = 0; ok && i < base.length; i++) {
    if (base[i].k !== res.base[i].k || base[i].v.join(',') !== res.base[i].v.join(',') || base[i].v[4] !== i) ok = false
  }
  pneSpT(ok, label + ': the pieces reassemble into the result (' + order.join(' ') + ')')
  ld = res ? GA.load(res, sc.seed) : null
  pneSpT(ld !== null && GA.hashAll(ld) === hA, label + ': load() of the incremental save gives hashAll() of the state at saveBegin')
  pneSpMix(ref)
  return res
}

function pneSpSaves() {
  var seeds = [11, 202, 3003, 40004, 500005, 6000006]
  var s
  var sc
  var k
  var GA = pneSpGA
  var maxed = 0
  for (s = 0; s < seeds.length; s++) {
    sc = pneSpBuild(seeds[s])
    if (GA.poolSize(sc.st) === 48 && sc.st.baseN === 512 && sc.st.se.length === 400 && sc.st.evc > 40000) maxed++
    // the players change their tactics now: a shift (hypermutation, samples cleared) may land inside one of the saves
    sc.flip = 1
    for (k = 0; k < 4; k++) pneSpOneSave(sc, 'seed ' + seeds[s] + ' save ' + k)
    pneSpMix(GA.hashAll(sc.st))
  }
  pneSpT(maxed === seeds.length, 'every scenario reached the limits (pool 48, 512 contexts, 400 samples, a full log): ' + maxed + '/' + seeds.length)
  for (k in pneSpCov) {
    if (pneSpCov.hasOwnProperty(k)) pneSpT(pneSpCov[k] > 0, 'coverage: ' + k + ' happened while a save was open (' + pneSpCov[k] + ')')
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Edge cases

function pneSpEdges() {
  var GA = pneSpGA
  var sc = pneSpBuild(777)
  var st = sc.st
  var c1
  var c2
  var ref
  var ref2
  var sv
  var i
  var res
  var e
  var p
  var parts = []
  // a newer saveBegin supersedes the running one
  c1 = GA.saveBegin(st)
  for (i = 0; i < 3; i++) {
    GA.savePart(c1)
    pneSpAct(sc)
  }
  ref2 = pneSpSer(GA.save(st))
  c2 = GA.saveBegin(st)
  pneSpT(GA.savePart(c1) === null && GA.saveEnd(c1) === null && GA.saveDone(c1) === true, 'a superseded context gives null from savePart and saveEnd')
  while (!GA.saveDone(c2)) {
    pneSpAct(sc)
    GA.savePart(c2)
  }
  res = GA.saveEnd(c2)
  pneSpT(res !== null && pneSpSer(res) === ref2 && st.cow === null, 'the superseding save completes and equals save() at its saveBegin')
  // saveEnd right after saveBegin runs every part
  ref = pneSpSer(GA.save(st))
  c1 = GA.saveBegin(st)
  res = GA.saveEnd(c1)
  pneSpT(res !== null && pneSpSer(res) === ref && st.cow === null, 'saveEnd right after saveBegin equals save()')
  // save() in the middle of an incremental save neither sees nor disturbs it
  ref = pneSpSer(GA.save(st))
  c1 = GA.saveBegin(st)
  for (i = 0; i < 5; i++) {
    GA.savePart(c1)
    pneSpAct(sc)
    pneSpAct(sc)
  }
  sv = GA.save(st)
  e = GA.load(sv, 777)
  pneSpT(e !== null && GA.hashAll(e) === GA.hashAll(st) && st.cow === c1, 'save() during an incremental save saves the live state and keeps the registration')
  while (!GA.saveDone(c1)) {
    pneSpAct(sc)
    GA.savePart(c1)
  }
  res = GA.saveEnd(c1)
  pneSpT(res !== null && pneSpSer(res) === ref, 'the incremental save still equals save() at its saveBegin')
  // an empty state
  st = GA.newState(5)
  c1 = GA.saveBegin(st)
  while ((p = GA.savePart(c1)) !== null) parts.push(p.part + ':' + (typeof p.value === 'string' ? p.value.length : p.value.length))
  res = GA.saveEnd(c1)
  pneSpT(parts.join(' ') === 'pool:0 queue:0 state:' + GA.save(st).state.length + ' log:0' && pneSpSer(res) === pneSpSer(GA.save(st)) &&
    res.samples.length === 0 && res.base.length === 0, 'an empty state: pool, queue, state and log pieces only (' + parts.join(' ') + ')')
  // invalid contexts never throw
  pneSpT(GA.savePart(null) === null && GA.savePart(undefined) === null && GA.savePart({}) === null && GA.savePart(7) === null,
    'savePart of an invalid context is null')
  pneSpT(GA.saveEnd(null) === null && GA.saveEnd({ k: 0 }) === null && GA.saveDone(null) === true && GA.saveDone('x') === true,
    'saveEnd of an invalid context is null, saveDone true')
  pneSpT(GA.saveBegin(null) === null && GA.saveBegin({}) === null && GA.saveBegin(5) === null && GA.saveBegin('st') === null,
    'saveBegin of something that is not a state is null')
}

// ---------------------------------------------------------------------------------------------
// 3. The LRU list against a reference model

function pneSpModelOrder(model) {
  var keys = []
  var k
  for (k in model) if (model.hasOwnProperty(k)) keys.push(k)
  keys.sort(function (a, b) { return (model[a] - model[b]) || (a < b ? -1 : (a > b ? 1 : 0)) })
  return keys
}

function pneSpListOrder(st) {
  var out = []
  var e
  for (e = st.bh; e !== null; e = e.nx) out.push(e.key.substring(1))
  return out
}

function pneSpListBack(st) {
  var out = []
  var e
  for (e = st.bt; e !== null; e = e.pv) out.push(e.key.substring(1))
  return out.reverse()
}

function pneSpLru() {
  var GA = pneSpGA
  var sc = pneSpScenario(99)
  var st = sc.st
  var model = {}
  var n = 0
  var tick = 0
  var i
  var ctx
  var m
  var rec
  var ord
  var lo
  var k
  var ok = true
  var okLinks = true
  var sv
  for (i = 0; i < 1500; i++) {
    // 600 fresh contexts first (past the cap), then skewed draws over 700 (low numbers often, the rest sometimes)
    ctx = 'q' + (i < 600 ? i : Math.floor(sc.drv.next() * sc.drv.next() * 700))
    m = pneSpJoin(sc, null)
    sc.alive.pop()
    rec = pneSpRec(sc, { id: m.id, g: m.g, parents: m.parents }, true)
    rec.ctx = ctx
    GA.outcome(st, rec)
    tick++
    if (!model.hasOwnProperty(ctx)) {
      if (n >= 512) {
        lo = null
        for (k in model) if (model.hasOwnProperty(k) && (lo === null || model[k] < model[lo])) lo = k
        delete model[lo]
        n--
      }
      n++
    }
    model[ctx] = tick
    if (i % 25 === 24 || i === 1499) {
      ord = pneSpModelOrder(model)
      if (pneSpListOrder(st).join(',') !== ord.join(',') || st.baseN !== n) ok = false
      if (pneSpListBack(st).join(',') !== ord.join(',') || st.bh.pv !== null || st.bt.nx !== null) okLinks = false
    }
  }
  pneSpT(n === 512 && ok, 'the LRU list holds the model\'s contexts in the model\'s recency order after every 25 outcomes (' + n + ' contexts)')
  pneSpT(okLinks, 'the list links agree both ways')
  sv = GA.save(st)
  ord = pneSpModelOrder(model)
  pneSpT(sv.base.map(function (b) { return b.k }).join(',') === ord.join(',') && sv.base.every(function (b, j) { return b.v[4] === j }),
    'save().base lists the contexts least recently used first with ranks 0..n-1')
  pneSpMix(pneSpSer(sv))
}

// ---------------------------------------------------------------------------------------------
// 4. The load epoch

function pneSpIds(st) {
  var out = {}
  var i
  for (i = 0; i < st.pool.length; i++) out[st.pool[i].id] = 1
  for (i = 0; i < st.queue.length; i++) out[st.queue[i].id] = 1
  return out
}

// One run after a load: n driver actions; returns every id the GA generated (joins, queue, pool) that the save did not have.
function pneSpRun(saved, seed, ep, n) {
  var GA = pneSpGA
  var sc = pneSpScenario(seed)
  var before
  var ids = {}
  var i
  var k
  var now
  sc.st = GA.load(saved, seed)
  sc.drv = GA.prim.rngFor(seed, 'pne_sp_rollback', 0)
  before = pneSpIds(sc.st)
  if (ep > 0) GA.epoch(sc.st, ep)
  for (i = 0; i < n; i++) {
    pneSpAct(sc)
    for (k = 0; k < sc.alive.length; k++) if (!before.hasOwnProperty(sc.alive[k].id)) ids[sc.alive[k].id] = 1
    now = pneSpIds(sc.st)
    for (k in now) if (now.hasOwnProperty(k) && !before.hasOwnProperty(k)) ids[k] = 1
  }
  GA.dawn(sc.st, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 5 })
  while (GA.dreamPending(sc.st)) GA.dreamSlice(sc.st, sc.mk, 4.2)
  now = pneSpIds(sc.st)
  for (k in now) if (now.hasOwnProperty(k) && !before.hasOwnProperty(k)) ids[k] = 1
  return ids
}

function pneSpShared(a, b) {
  var n = 0
  var k
  for (k in a) if (a.hasOwnProperty(k) && b.hasOwnProperty(k)) n++
  return n
}

function pneSpCountRx(ids, rx) {
  var n = 0
  var k
  for (k in ids) if (ids.hasOwnProperty(k) && rx.test(k)) n++
  return n
}

function pneSpEpoch() {
  var GA = pneSpGA
  var sc = pneSpScenario(4242)
  var st = sc.st
  var ev
  var r
  var sv
  var ld
  var all
  var snap
  var snapSeq
  var rp
  var i
  var tam
  var ch
  var a
  var b
  var c
  var d
  var saved
  var ids
  pneSpT(GA.ep(st) === 0, 'a new state has epoch 0')
  GA.breed(st)
  pneSpT(st.queue[0].id === 'b0', 'without an epoch ids are unchanged (b0)')
  r = GA.epoch(st, 3)
  ev = GA.events(st, GA.seq(st) - 1)[0]
  pneSpT(r === 3 && GA.ep(st) === 3 && ev === 'E|' + GA.seq(st) + '|3', 'epoch(st, 3) declares epoch 3 and logs E (' + ev + ')')
  GA.breed(st)
  pneSpT(st.queue[1].id === 'b1.3', 'a bred id carries the epoch (' + st.queue[1].id + ')')
  ch = GA.join(st, null)
  pneSpT(ch.id === 'b0', 'a queued genome keeps the id it was bred with (' + ch.id + ')')
  ch = GA.join(st, { id: 'x1', g: st.queue[0].g })
  pneSpT(ch.id === 'j1.3' && ch.parents === 'x1', 'a linked id carries the epoch (' + ch.id + ')')
  st.queue.length = 0
  ch = GA.join(st, null)
  pneSpT(ch.id === 'j2.3', 'a cloned id carries the epoch (' + ch.id + ')')
  pneSpT(GA.epoch(st, 2) === 4 && GA.epoch(st, 'junk') === 5 && GA.epoch(st, 1e12) === 6 && GA.epoch(st, 10) === 10,
    'the epoch only grows: max(ep, current + 1)')
  sv = GA.save(st)
  ld = GA.load(sv, 4242)
  pneSpT(/;ep=10(;|$)/.test(sv.state) && ld !== null && GA.ep(ld) === 10 && GA.hash(ld) === GA.hash(st), 'ep is saved in the state and restored by load()')
  pneSpT(!/ep=/.test(GA.save(GA.newState(1)).state), 'a state without an epoch saves no ep key (older saves load with epoch 0)')
  pneSpT(GA.load({ state: sv.state.replace(';ep=10', ';ep=-1'), pool: sv.pool, queue: sv.queue, samples: sv.samples, base: sv.base, log: sv.log }, 4242) === null &&
    GA.load({ state: sv.state.replace(';ep=10', ';ep=x'), pool: sv.pool, queue: sv.queue, samples: sv.samples, base: sv.base, log: sv.log }, 4242) === null &&
    GA.load({ state: sv.state.replace(';ep=10', ';ep=2147483648'), pool: sv.pool, queue: sv.queue, samples: sv.samples, base: sv.base, log: sv.log }, 4242) === null,
  'load() rejects a negative, non-integer or oversized epoch')
  // replay reproduces E events: from genesis, and from a snapshot taken before the later E events
  sc = pneSpScenario(515)
  snap = null
  for (i = 0; i < 250; i++) {
    pneSpAct(sc)
    if (i === 100) {
      snap = GA.save(sc.st)
      snapSeq = GA.seq(sc.st)
    }
    if (i % 60 === 30) GA.epoch(sc.st, GA.ep(sc.st) + 1)
  }
  all = GA.events(sc.st, 0)
  pneSpT(all.length && all[0].indexOf('|1|') > 0 && all.filter(function (x) { return x.charAt(0) === 'E' }).length >= 4, 'test setup: the whole log with several E events')
  rp = GA.replay(515, null, all)
  pneSpT(rp !== null && rp.rbad === 0 && GA.hashAll(rp) === GA.hashAll(sc.st), 'replay from genesis reproduces a log with E events' + (rp ? ' ' + rp.rmsg : ''))
  rp = GA.replay(515, snap, GA.events(sc.st, snapSeq))
  pneSpT(rp !== null && rp.rbad === 0 && GA.hashAll(rp) === GA.hashAll(sc.st), 'replay from a snapshot plus the later events (with E) reproduces the state' + (rp ? ' ' + rp.rmsg : ''))
  tam = all.slice(0)
  for (i = 0; i < tam.length; i++) {
    if (tam[i].charAt(0) === 'E') {
      tam[i] = tam[i].split('|')[0] + '|' + tam[i].split('|')[1] + '|' + (Number(tam[i].split('|')[2]) + 7)
      break
    }
  }
  rp = GA.replay(515, null, tam)
  pneSpT(rp !== null && rp.rbad === 1, 'a tampered E is caught at the next id it changes (' + (rp ? rp.rmsg.substring(0, 60) : 'null') + ')')
  pneSpMix(GA.hashAll(sc.st))
  // rollback: the same save loaded twice (a /reload after a lost save); HIVE declares a new epoch each time
  sc = pneSpBuild(8888)
  saved = GA.save(sc.st)
  a = pneSpRun(saved, 8888, 21, 300)
  b = pneSpRun(saved, 8888, 22, 300)
  c = pneSpRun(saved, 8888, 0, 300)
  d = pneSpRun(saved, 8888, 0, 300)
  ids = 0
  for (i in a) if (a.hasOwnProperty(i)) ids++
  pneSpT(ids > 50 && pneSpCountRx(a, /^[bjd]\d+\.\d+$/) === ids && pneSpCountRx(a, /^d/) > 0 && pneSpCountRx(a, /^b/) > 0 && pneSpCountRx(a, /^j/) > 0,
    'test setup: every id the first run generated carries an epoch, bred, joined and dreamed ones alike (' + ids + ' ids, dreamed ' + pneSpCountRx(a, /^d/) + ')')
  pneSpT(pneSpShared(a, b) === 0, 'two runs from the same save with epochs 21 and 22 share no generated id (' + pneSpShared(a, b) + ')')
  pneSpT(pneSpShared(c, d) === ids, 'without an epoch the two runs reuse every id (' + pneSpShared(c, d) + ' of ' + ids + '): the collision the epoch prevents')
}

// ---------------------------------------------------------------------------------------------

function pneSpRun0() {
  var sections = [pneSpSaves, pneSpEdges, pneSpLru, pneSpEpoch]
  var i
  for (i = 0; i < sections.length; i++) {
    try {
      sections[i]()
    } catch (err) {
      pneSpFails.push('section ' + i + ' threw ' + err + (err && err.stack ? ' ' + err.stack : ''))
    }
  }
  return (pneSpFails.length ? 'FAIL ' + pneSpFails.length + '/' + pneSpCount + ': ' + pneSpFails.slice(0, 6).join(' | ') : 'PASS ' + pneSpCount + ' checks') +
    ' digest=' + ((pneSpDigest >>> 0) + 0x100000000).toString(16).substring(1) +
    ' coverage ' + ['snapChanged', 'snapEvicted', 'samplesOver', 'poolReplaced', 'dawn', 'shift', 'dream', 'epoch', 'link'].map(function (k) { return k + '=' + pneSpCov[k] }).join(' ')
}

var pneSpResult = pneSpRun0()

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { result: pneSpResult }
  if (require.main === module) {
    console.log(pneSpResult)
    process.exitCode = pneSpResult.indexOf('PASS') === 0 ? 0 : 1
  }
}
