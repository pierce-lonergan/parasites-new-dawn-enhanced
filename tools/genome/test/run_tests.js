// ga-core-node: unit tests, determinism and goldens for overrides/kubejs/server_scripts/pne_hive_core.js (Node).
//   node tools/genome/test/run_tests.js        last line "PASS n" or "FAIL ..."
// Node-only helpers (reference implementations with charCodeAt and Math.imul) are allowed here; the ES5 test
// files that also run in Rhino are golden.js, replay_golden.js, test_guard.js and sim_hive.js.
'use strict'
var path = require('path')
var fs = require('fs')
var ROOT = path.join(__dirname, '..', '..', '..')
var CORE_PATH = path.join(ROOT, 'overrides', 'kubejs', 'server_scripts', 'pne_hive_core.js')
var GA = require(CORE_PATH)
var S = require('./sim_hive.js')
var P = GA.prim

var fails = []
var count = 0
function t(cond, msg) {
  count++
  if (!cond) fails.push(msg)
}
function near(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-12)
}

// ---------------------------------------------------------------------------------------------
// 1. API shape (IMPLEMENTATION.md 3.7) and source purity
function testApi() {
  var fnNames = ['hex', 'unhex', 'clade', 'newState', 'save', 'load', 'breed', 'join', 'mask', 'budget', 'express', 'outcome',
    'dawn', 'govStep', 'dreamSlice', 'gov', 'sigma', 'gen', 'poolSize', 'queueSize', 'apexSet', 'hash', 'replay']
  var src = fs.readFileSync(CORE_PATH, 'utf8')
  var code = src.replace(/\/\/.*$/gm, '')
  var sum = 0
  var i
  fnNames.forEach(function (n) { t(typeof GA[n] === 'function', 'PNE_HIVE_GA.' + n + ' is a function') })
  // additions: the incremental save and the load epoch (tools/genome/test/test_save_parts.js tests them)
  ;['saveBegin', 'savePart', 'saveDone', 'saveEnd', 'epoch', 'ep', 'events', 'seq', 'hashAll'].forEach(function (n) {
    t(typeof GA[n] === 'function', 'PNE_HIVE_GA.' + n + ' is a function')
  })
  t(GA.G === 14 && GA.Q === 65535 && GA.CAP === 48 && GA.QUEUE_MAX === 16 && GA.SCHEMA === 1, 'constants G Q CAP QUEUE_MAX SCHEMA')
  t(GA.GENE_IDS.join(',') === 'SPD,ACU,SCT,LUX,FLK,SIL,KBR,PRJ,ARM,PRC,HPX,DMG,TEL,MOR', 'GENE_IDS order')
  t(GA.TACTICS.join(',') === 'hide,kite,turtle,light,audio', 'TACTICS order')
  for (i = 0; i < 14; i++) sum += GA.COST_MC[i]
  t(near(sum, 11.6, 1e-9), 'COST_MC sums to 11.6')
  sum = 0
  for (i = 0; i < 14; i++) sum += GA.COST_GEN[i]
  t(near(sum, 12.5, 1e-9), 'COST_GEN sums to 12.5')
  t(src.split('\n')[0] === '// priority: 95', 'line 1 is the priority header')
  t(/if \(typeof module !== 'undefined' && module\.exports\) module\.exports = PNE_HIVE_GA\s*$/.test(src), 'module.exports guard at the end')
  t(!/\b(Math\.(random|exp|log|pow|sin|cos|tan|sqrt|imul|atan2|cbrt|hypot)|Date|charCodeAt|ServerEvents|EntityEvents|PlayerEvents|Java\.|global\.)/.test(code), 'pure: no banned calls')
  t((code.match(/^var /gm) || []).length === 1, 'exactly one top-level var (PNE_HIVE_GA)')
}

// ---------------------------------------------------------------------------------------------
// 2. Primitives against reference implementations (Node only: Math.imul and charCodeAt)
function refFnv(s) {
  var h = 0x811c9dc5
  var i
  for (i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h >>> 0
}
function refMulberry(seed) {
  var a = seed >>> 0
  return function () {
    var x
    a = (a + 0x6D2B79F5) >>> 0
    x = Math.imul(a ^ (a >>> 15), a | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0)
  }
}
function testPrimitives() {
  var r = new P.Rng(99)
  var ref = refMulberry(99)
  var i
  var a
  var b
  var ok = true
  var z
  var maxz = 0
  var rr = new P.Rng(1)
  for (i = 0; i < 5000; i++) {
    a = rr.u32()
    b = rr.u32() | 0
    if (P.imul32(a, b) !== (Math.imul(a, b) >>> 0)) ok = false
  }
  t(ok, 'imul32 equals Math.imul on 5000 random pairs')
  ok = true
  for (i = 0; i < 5000; i++) if (r.u32() !== ref()) ok = false
  t(ok, 'mulberry32 stream equals the reference implementation')
  t(P.fnv1a('pne_hive') === refFnv('pne_hive') && P.fnv1a('epca:ripper|1|2|surface') === refFnv('epca:ripper|1|2|surface'), 'FNV-1a over the ASCII table equals byte FNV-1a for ASCII')
  t(P.fnv1a('') === 0x811c9dc5, 'FNV-1a of the empty string')
  for (i = 0; i < 20000; i++) {
    z = Math.abs(rr.gauss())
    if (z > maxz) maxz = z
  }
  t(maxz <= 3.4642, 'Irwin-Hall gauss bounded by 3.4641')
  t(P.kern(0) === 1048576 && P.kern(165149) === 0 && P.kern(82574) > 786000 && P.kern(82574) < 787000, 'sharing kernel values')
  t(P.mixSeed([1, 2, 3]) !== P.mixSeed([3, 2, 1]), 'mixSeed is order-sensitive')
}

// ---------------------------------------------------------------------------------------------
// 3. Codec, mask, budget, express
function testCodec() {
  var g = [0, 1, 255, 256, 4095, 4096, 65535, 32768, 12345, 54321, 1, 2, 3, 16384]
  var h = GA.hex(g)
  var m
  t(h.length === 56 && /^[0-9a-f]{56}$/.test(h), 'hex is 56 lowercase hex')
  t(GA.unhex(h).join(',') === g.join(','), 'unhex(hex(g)) round trip')
  t(GA.unhex(h.toUpperCase()).join(',') === g.join(','), 'unhex accepts uppercase')
  t(GA.hex(h) === h, 'hex accepts a hex string')
  t(GA.clade([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16383]) === 0 && GA.clade([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 16384]) === 1 &&
    GA.clade([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 49152]) === 3 && GA.clade([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 65535]) === 3, 'clade = floor(MOR * 4 / 65536)')
  m = GA.mask('epca:ripper')
  t(m.join('') === '11111111111101', 'mask for a species with every attribute (TEL has no Minecraft phenotype)')
  ;['epca:curbug', 'epca:living_flesh_size0', 'epca:living_flesh_size4', 'epca:infested_slime_size3', 'spore:spitter', 'spore:howit_arm',
    'spore:licker', 'spore:sieger_tail', 'spore:stahl_arm', 'spore:braurei', 'spore:delusioner', 'spore:mound', 'spore:usurper',
    'spore:verva', 'spore:vigil', 'spore:reconstructor', 'spore:tendril', 'spore:scent', 'spore:tumoroid_nuke'].forEach(function (id) {
    t(GA.mask(id)[11] === 0 && GA.mask(id)[0] === 1, 'no attack_damage on ' + id)
  })
  t(GA.mask('epca:infested_slime_size2')[11] === 1 && GA.mask('spore:knight')[11] === 1 && GA.mask('constructor')[11] === 1, 'DMG available elsewhere')
  t(near(GA.budget(0, 1, false), 3) && near(GA.budget(10, 1, false), 6.5) && near(GA.budget(4, 1, true), (3 + 1.4) * 0.7) &&
    near(GA.budget(2, 0.6, false), 3.7 * 0.6), 'budget = (3 + 0.35 stage) * gov * (grace ? 0.7 : 1)')
  t(near(GA.budget(0, 1, false) / 11.6, 0.2586, 1e-4) && near(GA.budget(10, 1, false) / 11.6, 0.5603, 1e-4), 'budget covers 26% / 56% of a full genome')
}

function testExpress() {
  var full = [65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535]
  var half = [32768, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  var e = GA.express(half, GA.mask(''), 3)
  var cost = 0
  var i
  t(near(e[0], 32768 / 65535), 'an affordable genome is expressed in full')
  e = GA.express(full, GA.mask('epca:ripper'), 3)
  for (i = 0; i < 14; i++) cost += GA.COST_MC[i] * e[i]
  t(cost <= 3 + 1e-9 && e[12] === 0, 'an over-budget genome is scaled to the budget; TEL masked')
  t(near(e[5] * e[11], Math.min(0.36, e[5] * e[11])) && e[0] * e[8] <= 0.40 + 1e-12, 'combo caps')
  e = GA.express([0, 0, 0, 0, 0, 65535, 0, 0, 0, 0, 0, 65535, 0, 0], GA.mask(''), 100)
  t(near(e[5] * e[11], 0.36) && (e[5] === 1 || e[11] === 1), 'SIL*DMG capped at 0.36 by lowering the smaller gene')
  e = GA.express([65535, 0, 0, 0, 0, 0, 0, 0, 65535, 0, 0, 0, 0, 0], GA.mask(''), 100)
  t(near(e[0] * e[8], 0.40), 'SPD*ARM capped at 0.40')
  e = GA.express(full, GA.mask('epca:curbug'), 4)
  t(e[11] === 0, 'masked DMG expresses 0')
  cost = 0
  for (i = 0; i < 14; i++) cost += GA.COST_MC[i] * e[i]
  t(near(cost, 4, 1e-9), 'masked cost is not charged: the budget flows to the other genes')
}

// ---------------------------------------------------------------------------------------------
// 4. Runtime semantics
function mkRec(ch, e, over) {
  var tel = { dmg: 4, engagedSec: 12, located: 1, killShare: 0, teamPressure: 1, fastKill: false, cheese: false }
  var k
  for (k in (over || {})) tel[k] = over[k]
  return { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper|1|0|surface', e: e, tel: tel }
}

function testBreedJoin() {
  var st = GA.newState(42)
  var i
  var n = 0
  var ch
  var ev
  var q
  for (i = 0; i < 20; i++) if (GA.breed(st)) n++
  t(n === 16 && GA.queueSize(st) === 16 && st.births === 16, 'breed fills the queue to 16, then returns false')
  ev = GA.events(st, 0)
  t(ev.length === 16 && ev[0] === 'B|1|1' && ev[15] === 'B|16|16', 'B events carry seq and births')
  q = st.queue[0]
  ch = GA.join(st, null)
  t(ch.id === q.id && GA.queueSize(st) === 15 && ch.hex === GA.hex(q.g) && typeof ch.parents === 'string', 'join pops the oldest queued genome')
  ev = GA.events(st, 16)
  t(ev.length === 2 && ev[0].indexOf('P|17|16|') === 0 && ev[1].indexOf('J|18|1|P|-|-|') === 0, 'P then J events')
  ch = GA.join(st, { id: 'carrier7', g: q.g })
  t(ch.id === 'j1' && ch.parents === 'carrier7' && P.sumAbs(ch.g, q.g) / 917490 < 0.2 && GA.queueSize(st) === 15, 'a conversion link inherits the carrier genome with one mutation pass')
  st = GA.newState(42)
  ch = GA.join(st, null)
  t(ch.id === 'j0' && ch.parents === '' && GA.unhex(ch.hex) !== null, 'empty queue and empty pool: random mutant')
  GA.outcome(st, mkRec(ch, GA.express(ch.g, GA.mask(''), 3)))
  ch = GA.join(st, null)
  t(ch.parents === 'j0', 'mutantClone names its tournament parent')
}

function testOutcome() {
  var st = GA.newState(5)
  var ch
  var e
  var f1
  var f2
  var f3
  var fm
  var i
  var pool
  var par
  ch = GA.join(st, null)
  e = GA.express(ch.g, GA.mask(''), 3)
  f1 = GA.fitness(st, mkRec(ch, e), 0.3)
  f2 = GA.fitness(st, mkRec(ch, e, { killShare: 1 }), 0.3)
  f3 = GA.fitness(st, mkRec(ch, e, { killShare: 1, fastKill: true }), 0.3)
  fm = GA.fitness(st, mkRec(ch, e, { dmg: 0, teamPressure: 0 }), 0.3)
  t(f2 > f1 && near(f2 - f3, (f2 - f1) / 2, 2e-6), 'fast kill halves the kill credit')
  t(fm < f1, 'zeroed damage channels (k_mercy = 0) lower fitness')
  t(GA.fitness(st, mkRec(ch, e, { cheese: true }), 0.3) === 0, 'cheese gives 0')
  f1 = GA.outcome(st, mkRec(ch, e))
  t(GA.gen(st) === 1 && GA.poolSize(st) === 1 && GA.events(st, 0).pop().indexOf('I|') === 0, 'outcome inserts, counts a generation, logs I')
  for (i = 0; i < 80; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    GA.outcome(st, mkRec(ch, GA.express(ch.g, GA.mask(''), 3), { dmg: i % 7 }))
  }
  t(GA.poolSize(st) === 48, 'the pool grows to CAP and stays there')
  t(P.cacheCheck(st), 'incremental sharing cache equals a rebuild')
  // lineage credit: a parent's n rises and its f moves toward the child's outcome
  pool = st.pool
  par = pool[3]
  f1 = par.f
  i = par.n
  GA.outcome(st, { id: 'kid', g: pool[10].g, parents: [par.id], ctx: 'epca:ripper|1|0|surface', e: GA.express(pool[10].g, GA.mask(''), 3),
    tel: { dmg: 12, engagedSec: 60, located: 1, killShare: 1, teamPressure: 3 } })
  t(par.n === Math.min(12, i + 1) && par.f !== f1, 'lineage credit on the parent')
  // apex set: top 5% by shrunk estimate with n >= 6
  pool[0].n = 12
  pool[0].f = 5
  t(GA.apexSet(st)[GA.hex(pool[0].g)] === true, 'apexSet contains a strong well-measured entry')
  pool[0].n = 3
  t(!GA.apexSet(st)[GA.hex(pool[0].g)], 'apexSet needs n >= 6')
}

function testInsertDreamed() {
  var st = GA.newState(8)
  var i
  var mk = GA.mask('')
  var ch
  var before
  var after
  for (i = 0; i < 300; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    GA.outcome(st, mkRec(ch, GA.express(ch.g, mk, 3), { dmg: (i * 7) % 11, killShare: i % 13 === 0 ? 1 : 0 }))
    if (i % 60 === 59) {
      GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 2 })
      while (GA.dreamPending(st)) GA.dreamSlice(st, mk, 3)
    }
  }
  // make every entry well measured and undreamed: a dream must then replace nothing
  for (i = 0; i < st.pool.length; i++) {
    st.pool[i].n = 2
    st.pool[i].dr = 0
  }
  before = GA.save(st).pool
  GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 2 })
  i = 0
  while (GA.dreamPending(st)) {
    GA.dreamSlice(st, mk, 3)
    i++
  }
  after = GA.save(st).pool
  t(i === 107, 'a dream over a full pool takes 107 slices (5 x 19 + 12), got ' + i)
  t(before.replace(/\|\d+\|/g, '|') === after.replace(/\|\d+\|/g, '|') || before === after, 'insertDreamed never displaces well-measured entries')
  t(P.cacheCheck(st), 'cache consistent after dreams')
  // dreamed entries carry n = 0.5 and dr = 1
  st.pool[5].n = 1
  GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 2 })
  while (GA.dreamPending(st)) GA.dreamSlice(st, mk, 3)
  after = st.pool.filter(function (x) { return x.dr === 1 })
  t(after.every(function (x) { return x.n === 0.5 && x.id.charAt(0) === 'd' }), 'dreamed entries: n 0.5, id d<births>')
}

function testDawn() {
  var st = GA.newState(11)
  var i
  var hyperDays
  var td1 = [0.05, 0, 0.4, 0.5, 0.05]
  var td2 = [0.35, 0.55, 0, 0, 0.1]
  var shifts = []
  var tprev
  var ok
  var s
  var d
  GA.dawn(st, { deaths3d: 30, target: 1, tDay: td1, stage: 0 })
  t(near(GA.gov(st), 0.9), 'deaths far above target: gov falls by exactly 0.1')
  for (i = 0; i < 5; i++) GA.dawn(st, { deaths3d: 30, target: 1, tDay: td1, stage: 0 })
  t(GA.gov(st) === 0.6, 'gov floor 0.6')
  for (i = 0; i < 9; i++) GA.dawn(st, { deaths3d: 0, target: 1, tDay: td1, stage: 0 })
  t(GA.gov(st) === 1.15, 'gov ceiling 1.15 (steps of +0.1 when no deaths)')
  st.gov = 1
  GA.dawn(st, { deaths3d: 1.6, target: 3, tDay: td1, stage: 0 })
  t(GA.gov(st) === 1.033333, 'proportional step: deaths 1.6 rounds to 2, (2 - 3) / 3 gives +0.0333 (canonical 1.033333)')
  st.gov = 1
  GA.dawn(st, { deaths3d: 4, target: 3, tDay: td1, stage: 0 })
  t(GA.gov(st) === 0.966667, 'proportional step down: (4 - 3) / 3 gives -0.0333')
  d = GA.gov(st)
  GA.dawn(st, { deaths3d: 9, target: 0, tDay: td1, stage: 0 })
  t(GA.gov(st) === d, 'target 0 means no update')
  // T_est: floor 0.10 per tactic, sums to 1, moves at most 0.10 (L1) per dawn
  st = GA.newState(12)
  ok = true
  for (i = 0; i < 40; i++) {
    tprev = GA.tEst(st)
    GA.dawn(st, { deaths3d: 0, target: 0, tDay: i < 20 ? td1 : td2, stage: 0 })
    s = GA.tEst(st)
    d = 0
    for (var k = 0; k < 5; k++) {
      d += Math.abs(s[k] - tprev[k])
      if (s[k] < 0.1 - 1e-6) ok = false
    }
    if (d > 0.1 + 1e-5 || Math.abs(s[0] + s[1] + s[2] + s[3] + s[4] - 1) > 1e-5) ok = false
  }
  t(ok, 'T_est floor, sum and step cap')
  // shift detection and exactly 6 hypermutation dawns
  st = GA.newState(13)
  hyperDays = 0
  for (i = 0; i < 60; i++) {
    GA.dawn(st, { deaths3d: 0, target: 0, tDay: i < 30 ? td1 : td2, stage: 0 })
    if (GA.hyper(st) === 6) shifts.push(i)
    if (i >= 30 && GA.hyper(st) > 0) {
      hyperDays++
      if (!near(GA.pm(st), 0.142857)) ok = false
    }
  }
  t(shifts.length === 1 && shifts[0] >= 30 && shifts[0] <= 32, 'one tactic shift detected right after the change, at ' + shifts.join(','))
  t(hyperDays === 6 && near(GA.pm(st), 0.071429) && ok, 'exactly 6 hypermutation dawns with pm 2/14, then pm 1/14 (' + hyperDays + ')')
  t(GA.sigma(st) >= 0.02 && GA.sigma(st) <= 0.25, 'sigma clamped')
  // decrement-before-set: a shift on a dawn where hyper is 1 leaves hyper at 6, not 5
  st = GA.newState(14)
  GA.dawn(st, { deaths3d: 0, target: 0, tDay: td1, stage: 0 })
  st.hyper = 1
  st.fast = [0.35, 0.55, 0, 0, 0.1]
  st.slow = [0.05, 0, 0.4, 0.5, 0.05]
  GA.dawn(st, { deaths3d: 0, target: 0, tDay: td2, stage: 0 })
  t(GA.hyper(st) === 6 && near(GA.pm(st), 0.142857) && GA.sigma(st) >= 0.18, 'decrement before a new shift sets hyper (6, pm 2/14, sigma >= 0.18)')
  t(st.se.length === 0, 'a shift clears the samples')
  // sigma adaptation: an identical pool (diversity 0) raises sigma by 1.25
  st = GA.newState(15)
  GA.setPool(st, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]], [0.1, 0.2])
  GA.dawn(st, { deaths3d: 0, target: 0, tDay: null, stage: 0 })
  t(near(GA.sigma(st), 0.1), 'low diversity: sigma x 1.25')
}

function testGovStep() {
  var st = GA.newState(1)
  t(near(GA.govStep(st), 0.85) && near(GA.govStep(st), 0.7225) && near(GA.govStep(st), 0.614125) && GA.govStep(st) === 0.6, 'govStep x0.85 with floor 0.6')
  t(GA.events(st, 0).length === 4 && GA.events(st, 0)[0] === 'G|1|1|850000', 'G events')
}

function testRidge() {
  var st = GA.newState(3)
  var rng = P.rngFor(3, 'ridge', 0)
  var wTrue = [0.2, -0.1, 0.3, 0, 0, 0.5, 0, 0, -0.2, 0, 0.1, 0, 0, 0, 0.1]
  var i
  var j
  var e
  var f
  var fq
  var w
  var err = 0
  for (i = 0; i < 400; i++) {
    e = []
    f = wTrue[14]
    for (j = 0; j < 14; j++) {
      e.push(rng.u32() & 0xffff)
      f += wTrue[j] * e[j] / 65535
    }
    GA.outcome(st, { id: 'r' + i, g: e, parents: '', ctx: 'c', e: [], tel: {} })
    st.se[st.se.length - 1] = e
    fq = Math.floor(f * 1e6 + 0.5)
    st.sf[st.sf.length - 1] = fq
  }
  st.gram = st.gram.map(function () { return 0 })
  st.gy = st.gy.map(function () { return 0 })
  for (i = 0; i < 400; i++) {
    var x = st.se[i].concat([1])
    var p = 0
    for (j = 0; j < 15; j++) {
      for (var k = j; k < 15; k++) st.gram[p++] += x[j] * x[k]
      st.gy[j] += x[j] * st.sf[i]
    }
  }
  w = P.ridge(st)
  for (j = 0; j < 15; j++) err = Math.max(err, Math.abs(w[j] - wTrue[j]))
  t(err < 0.05, 'ridge (lambda 1) recovers noiseless weights within 0.05 (max error ' + err.toFixed(4) + ')')
}

// ---------------------------------------------------------------------------------------------
// 5. Persistence, replay and determinism
function testPersistence() {
  var run = require('./golden.js').live(777, 700)
  var st = run.st
  var sv = GA.save(st)
  var st2 = GA.load(sv, 777)
  var i
  var max = 0
  var bytes
  t(st2 !== null && JSON.stringify(GA.save(st2)) === JSON.stringify(sv), 'save -> load -> save is exact')
  t(GA.hash(st2) === GA.hash(st) && GA.hashAll(st2) === GA.hashAll(st), 'hash survives a reload')
  // mid-dream round trip: the reloaded state continues exactly like the live one
  st = GA.load(sv, 777)
  GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.3, 0.2, 0.1, 0.3, 0.1], stage: 4 })
  for (i = 0; i < 17; i++) GA.dreamSlice(st, GA.mask('epca:ripper'), 4)
  st2 = GA.load(GA.save(st), 777)
  t(GA.dreamPending(st2) && GA.save(st2).state === GA.save(st).state, 'mid-dream state reloads')
  while (GA.dreamPending(st)) GA.dreamSlice(st, GA.mask('epca:ripper'), 4)
  while (GA.dreamPending(st2)) GA.dreamSlice(st2, GA.mask('epca:ripper'), 4)
  t(JSON.stringify(GA.save(st)) === JSON.stringify(GA.save(st2)), 'a dream resumed after a reload ends in the same state')
  sv = GA.save(st)
  t(sv.samples.every(function (c) { return c.length <= 48000 }) && sv.pool.length < 60000 && sv.state.length < 60000 &&
    sv.queue.length < 60000 && sv.log.length <= 45000, 'every string under the NBT limits')
  t(/^[0-9|;a-zdjbp_:.\/-]*$/i.test(sv.pool) && !/[.]\d*e/i.test(sv.state), 'integers and hex only')
  bytes = sv.pool.length + sv.queue.length + sv.state.length + sv.samples.join('').length + sv.log.length
  for (i = 0; i < sv.base.length; i++) max = Math.max(max, sv.base[i].v.length)
  t(max === 5 && sv.base.every(function (b, k) { return b.v[4] === k }), 'base IntArrays hold [dmg, eng, team EMA x 1e6, count, LRU rank]')
  t(bytes < 200000, 'saved state size ' + bytes)
  // a Java-like List for samples and base (size/get) loads too
  st2 = GA.load({ pool: sv.pool, queue: sv.queue, state: sv.state, log: sv.log,
    samples: { size: function () { return sv.samples.length }, get: function (k) { return sv.samples[k] } },
    base: sv.base.map(function (b) { return { k: b.k, v: { size: function () { return 5 }, get: function (k) { return b.v[k] } } } }) }, 777)
  t(st2 !== null && JSON.stringify(GA.save(st2)) === JSON.stringify(sv), 'load accepts Java-style lists')
}

// Context-baseline LRU order survives a reload whatever order the base list comes back in (a CompoundTag returns its
// keys in hash order), with more contexts than the 512 cap so eviction really happens.
function lruRec(st, i, ctx) {
  var r = GA.join(st, null)
  return { id: r.id, g: r.g, parents: r.parents, ctx: ctx, e: GA.express(r.g, GA.mask('epca:ripper'), 4),
    tel: { dmg: (i * 7) % 11, engagedSec: 5 + i % 9, located: i % 2, killShare: 0.2, teamPressure: i % 4 } }
}
// replay's rn counts applied steps; a P event is applied together with its J, so it does not count on its own.
function stepsOf(evs) {
  return evs.filter(function (x) { return x.charAt(0) !== 'P' }).length
}
function lruMore(s) {
  var j
  for (j = 0; j < 60; j++) {
    GA.breed(s)
    GA.outcome(s, lruRec(s, 1000 + j, 'n' + j))
  }
  for (j = 0; j < 60; j++) {
    GA.breed(s)
    GA.outcome(s, lruRec(s, 2000 + j, 'c' + (j % 40)))
  }
  return GA.hashAll(s) + '/' + GA.hash(s)
}
function testLruPersistence() {
  var st = GA.newState(777)
  var i
  var sv
  var orders
  var ref
  var seq0
  var evs
  var live
  var k
  var ld
  var rp
  var old
  for (i = 0; i < 530; i++) {
    GA.breed(st)
    GA.outcome(st, lruRec(st, i, 'c' + i))
  }
  for (i = 0; i < 40; i++) {
    GA.breed(st)
    GA.outcome(st, lruRec(st, i, 'c' + i))
  }
  sv = GA.save(st)
  t(sv.base.length === 512 && st.baseN === 512, 'the baseline table is capped at 512 contexts (' + sv.base.length + ')')
  t(sv.base[sv.base.length - 1].k === 'c39' && sv.base[0].k !== 'c0', 'recently used contexts are the newest in the LRU order')
  orders = {
    byKey: sv.base.slice(0).sort(function (a, b) { return a.k < b.k ? -1 : (a.k > b.k ? 1 : 0) }),
    reversed: sv.base.slice(0).reverse(),
    shuffled: sv.base.map(function (b, j) { return { b: b, h: P.fmix32(j + 1) } }).sort(function (a, b) { return a.h - b.h }).map(function (x) { return x.b })
  }
  seq0 = GA.seq(st)
  ref = GA.load(JSON.parse(JSON.stringify(sv)), 777)
  live = lruMore(ref)
  evs = GA.events(ref, seq0)
  for (k in orders) {
    ld = GA.load({ pool: sv.pool, queue: sv.queue, state: sv.state, samples: sv.samples, base: orders[k], log: sv.log }, 777)
    t(ld !== null && JSON.stringify(GA.save(ld)) === JSON.stringify(sv), 'save -> load (base in ' + k + ' order) -> save is exact')
    t(ld !== null && lruMore(ld) === live, 'a state loaded with base in ' + k + ' order evicts exactly like the live one')
    rp = GA.replay(777, { pool: sv.pool, queue: sv.queue, state: sv.state, samples: sv.samples, base: orders[k], log: sv.log }, evs)
    t(rp && rp.rbad === 0 && rp.rn === stepsOf(evs) && GA.hashAll(rp) === GA.hashAll(ref), 'replay from a save with base in ' + k + ' order: rbad ' +
      (rp ? rp.rbad + ' ' + rp.rmsg : 'null'))
  }
  t(lruMore(st) === live, 'the live state and the reloaded state agree')
  // A 4-element base value (no rank) still loads, in list order.
  old = sv.base.map(function (b) { return { k: b.k, v: b.v.slice(0, 4) } })
  ld = GA.load({ pool: sv.pool, queue: sv.queue, state: sv.state, samples: sv.samples, base: old, log: sv.log }, 777)
  t(ld !== null && JSON.stringify(GA.save(ld).base) === JSON.stringify(sv.base), 'rank-less base values load in list order')
}

// load() rejects values the runtime can never produce (a corrupt or edited save), instead of running on them.
function testLoadRanges() {
  var run = require('./golden.js').live(606, 500)
  var sv = GA.save(run.st)
  var ok = GA.load(sv, 606)
  var cases = []
  function poolField(k, v) {
    var p = sv.pool.split(';')
    var f = p[0].split('|')
    f[k] = v
    p[0] = f.join('|')
    return { pool: p.join(';') }
  }
  function stateKey(key, v) {
    return { state: sv.state.split(';').map(function (kv) { return kv.indexOf(key + '=') === 0 ? key + '=' + v : kv }).join(';') }
  }
  function baseVal(j, v) {
    return { base: sv.base.map(function (b, k) { var c = b.v.slice(0); if (k === 0) c[j] = v; return { k: b.k, v: c } }) }
  }
  function over(o) {
    var x = { pool: sv.pool, queue: sv.queue, state: sv.state, samples: sv.samples, base: sv.base, log: sv.log }
    var k
    for (k in o) x[k] = o[k]
    return x
  }
  t(ok !== null, 'the unmodified save loads')
  cases.push(['pool n = -2', poolField(3, '-4')], ['pool n = 0', poolField(3, '0')], ['pool n = 12.5', poolField(3, '25')],
    ['pool age < 0', poolField(4, '-1')], ['pool f < 0', poolField(2, '-1')], ['pool f > 1', poolField(2, '1000001')],
    ['pool dreamed = 2', poolField(5, '2')], ['gov 0', stateKey('gov', '0')], ['gov 2', stateKey('gov', '2000000')],
    ['sigma 0', stateKey('sigma', '0')], ['hyper 7', stateKey('hyper', '7')], ['negative births', stateKey('births', '-1')],
    ['T_est entry < 0', stateKey('test', '-1,300000,300000,200000,200000')], ['base count 0', baseVal(3, 0)],
    ['base dmg < 0', baseVal(0, -5)], ['base rank < 0', baseVal(4, -1)],
    ['sample f < 0', { samples: [sv.samples[0].replace(/\|(\d+)(;|$)/, '|-3$2')].concat(sv.samples.slice(1)) }],
    ['duplicate baseline', { base: sv.base.concat([sv.base[0]]) }])
  cases.forEach(function (c) { t(GA.load(over(c[1]), 606) === null, 'load rejects ' + c[0]) })
}

// load() rebuilds the derived data (sharing cache, and the current dream generation's scores, elites, kernels and
// sharing) so the first budgeted call after a restart is not an O(n^2) rebuild.
function testLoadRebuildsDerived() {
  var run = require('./golden.js').live(515, 600)
  var st = GA.load(GA.save(run.st), 515)
  var P
  var sS
  var a
  var b
  t(st.C !== null && st.C.n === st.pool.length, 'load builds the sharing cache')
  t(GA.prim.cacheCheck(st), 'the cache built by load equals a rebuild')
  GA.dawn(st, { deaths3d: 1, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 3 })
  t(GA.dreamPending(st), 'test setup: a dream is pending')
  P = st.dream.pop.length
  sS = Math.ceil(P / 16) + 1 + Math.ceil(P * (P - 1) / 2 / 150)
  while (!(st.dream.ph === 0 && st.dream.gen === 1 && st.dream.sub === sS + 2)) GA.dreamSlice(st, GA.mask('epca:ripper'), 4)
  a = GA.load(GA.save(st), 515)
  t(a.dream.x && a.dream.x.sc.length === P && a.dream.x.el && a.dream.x.done === P * (P - 1) / 2 && a.dream.x.sel,
    'load rebuilds the dream generation data (scores, elites, all pairs, sharing)')
  b = GA.load(GA.save(st), 515)
  while (GA.dreamPending(a)) GA.dreamSlice(a, GA.mask('epca:ripper'), 4)
  while (GA.dreamPending(st)) GA.dreamSlice(st, GA.mask('epca:ripper'), 4)
  b.dream.x = null
  while (GA.dreamPending(b)) GA.dreamSlice(b, GA.mask('epca:ripper'), 4)
  t(JSON.stringify(GA.save(a)) === JSON.stringify(GA.save(st)) && JSON.stringify(GA.save(b)) === JSON.stringify(GA.save(st)),
    'the prebuilt dream data gives the same dream as the live run and as a lazy rebuild')
}

// dmg is capped at 12 HP per encounter (TDD 3.2): an outlier cannot drag the context baseline up.
function testDmgCap() {
  var st = GA.newState(21)
  var st2 = GA.newState(21)
  var g = [30000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 0, 100]
  var e = GA.express(g, GA.mask(''), 4)
  var i
  var f1
  var f2
  for (i = 0; i < 25; i++) {
    GA.outcome(st, { id: 'a' + i, g: g, parents: '', ctx: 'c', e: e, tel: { dmg: 4, engagedSec: 10, located: 1 } })
    GA.outcome(st2, { id: 'a' + i, g: g, parents: '', ctx: 'c', e: e, tel: { dmg: 4, engagedSec: 10, located: 1 } })
  }
  f1 = GA.outcome(st, { id: 'x', g: g, parents: '', ctx: 'c', e: e, tel: { dmg: 1000, engagedSec: 10, located: 1 } })
  f2 = GA.outcome(st2, { id: 'x', g: g, parents: '', ctx: 'c', e: e, tel: { dmg: 12, engagedSec: 10, located: 1 } })
  t(f1 === f2 && GA.events(st, GA.seq(st) - 1)[0] === GA.events(st2, GA.seq(st2) - 1)[0], 'dmg 1000 scores and logs exactly like dmg 12')
  t(GA.events(st, GA.seq(st) - 1)[0].split('|')[8].split(',')[0] === '12000000', 'the I event carries the capped dmg')
  t(st.base.kc.dmg <= 4 + 0.05 * 8 + 1e-9, 'one outlier moves the baseline by at most 0.05 x (12 - 4) (' + st.base.kc.dmg + ')')
}

// replay() takes the log as any kind of string (a java.lang.String is typeof 'object' in Rhino; java_values.js covers
// the real thing), as an array or List, and reports input that is not a log instead of replaying nothing.
function testReplayStringKinds() {
  var run = require('./golden.js').live(8080, 300)
  var st = run.st
  var sv0 = GA.save(st)
  var seq0 = GA.seq(st)
  var i
  var ch
  var sv1
  var r
  var fake
  var n
  for (i = 0; i < 25; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    GA.outcome(st, mkRec(ch, GA.express(ch.g, GA.mask(''), 3), { dmg: i % 7 }))
  }
  sv1 = GA.save(st)
  n = stepsOf(GA.events(st, seq0))
  t(GA.events(st, seq0).length === GA.seq(st) - seq0 && n > 50, 'test setup: the saved tail covers every event since the snapshot')
  r = GA.replay(8080, sv0, sv1.log)
  t(r && r.rbad === 0 && r.rn === n && GA.hashAll(r) === GA.hashAll(st), 'replay(save, JS string log)')
  r = GA.replay(8080, sv0, new String(sv1.log)) // eslint-disable-line no-new-wrappers
  t(r && r.rbad === 0 && r.rn === n && GA.hashAll(r) === GA.hashAll(st), 'replay(save, String object log)')
  fake = { split: function (sep) { return sv1.log.split(sep) }, toString: function () { return sv1.log } }
  r = GA.replay(8080, sv0, fake)
  t(r && r.rbad === 0 && r.rn === n && GA.hashAll(r) === GA.hashAll(st), 'replay(save, a string-like object without a numeric length, like java.lang.String)')
  r = GA.replay(8080, sv0, 'hello world')
  t(r && r.rbad === 1 && /unparseable/.test(r.rmsg), 'a string that is not a log is reported')
  r = GA.replay(8080, sv0, 42)
  t(r && r.rbad === 1, 'a number as the log is reported')
  r = GA.replay(8080, sv1, sv1.log)
  t(r && r.rbad === 0 && r.rn === 0 && r.rskip > 0, 'events already in the state are skipped and counted (rskip ' + (r ? r.rskip : '') + ')')
}

function testCacheParity() {
  var run = require('./golden.js').live(4242, 500)
  var st = run.st
  var a = GA.load(GA.save(st), 4242)
  var b = GA.load(GA.save(st), 4242)
  var i
  var same = true
  GA.breed(a)
  for (i = 0; i < 30; i++) {
    P.dropCache(b)
    GA.breed(b)
    if (b.queue.length >= 16) b.queue.shift()
    if (a.queue.length >= 16) a.queue.shift()
    GA.breed(a)
  }
  P.dropCache(b)
  GA.breed(b)
  same = JSON.stringify(GA.save(a).queue) === JSON.stringify(GA.save(b).queue)
  t(same, 'breeding with the incremental sharing cache equals breeding with a fresh rebuild every time')
}

function testDeterminism() {
  var A = S.batch({ seed: 12345, gens: 40 })
  var B = S.batch({ seed: 12345, gens: 40 })
  var C = S.batch({ seed: 12346, gens: 40 })
  var L1 = require('./golden.js').live(12345, 600)
  var L2 = require('./golden.js').live(12345, 600)
  var L3 = require('./golden.js').live(12346, 600)
  t(A.hashes.join(',') === B.hashes.join(',') && JSON.stringify(A.rows) === JSON.stringify(B.rows), 'batch: same seed, identical hashes and statistics')
  t(A.hashes.slice(1).join(',') !== C.hashes.slice(1).join(','), 'batch: seed + 1 diverges')
  t(L1.final === L2.final && L1.chain === L2.chain, 'live: same seed identical')
  t(L1.final !== L3.final, 'live: seed + 1 diverges')
}

function testGoldens() {
  var exp = JSON.parse(fs.readFileSync(path.join(__dirname, 'golden_expected.json'), 'utf8'))
  var got = require('./golden.js').str
  var g = {}
  got.split(';').forEach(function (kv) { var i = kv.indexOf('='); g[kv.substring(0, i)] = kv.substring(i + 1) })
  Object.keys(exp.golden).forEach(function (k) { t(g[k] === exp.golden[k], 'golden ' + k + ' = ' + g[k] + ', expected ' + exp.golden[k]) })
}

function testReplayBasics() {
  var run = require('./golden.js').live(31337, 400)
  var st = run.st
  var sv = GA.save(st)
  var ev = GA.events(st, 0)
  var firstSeq = Number(ev[0].split('|')[1])
  var rp
  t(GA.events(st, st.seq - 3).length === 3, 'events(st, afterSeq) returns the newer events')
  t(firstSeq > 1 && sv.log.length <= 45000, 'the log is a bounded tail')
  rp = GA.replay(31337, null, ev)
  t(rp && rp.rbad === 1 && /gap/.test(rp.rmsg), 'replay from genesis with a tail that misses the start reports a gap')
  t(GA.replay(31337, { state: 'v=9' }, []) === null, 'replay from a foreign schema returns null')
}

var sections = [testApi, testPrimitives, testCodec, testExpress, testBreedJoin, testOutcome, testInsertDreamed, testDawn, testGovStep,
  testRidge, testPersistence, testLruPersistence, testLoadRanges, testLoadRebuildsDerived, testDmgCap, testReplayStringKinds,
  testCacheParity, testDeterminism, testGoldens, testReplayBasics]
sections.forEach(function (fn) {
  try {
    fn()
  } catch (err) {
    fails.push(fn.name + ' threw ' + (err && err.stack ? err.stack : err))
  }
})
fails.forEach(function (f) { console.log('  FAIL ' + f) })
console.log(fails.length ? 'FAIL ' + fails.length + '/' + count : 'PASS ' + count)
process.exitCode = fails.length ? 1 : 0
