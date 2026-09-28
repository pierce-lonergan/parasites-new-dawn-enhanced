// Guard test (TDD 3.3.3 test (c); IMPLEMENTATION.md 9.4 ga-core-guard). ES5, Node and Rhino.
// An all-zero or fully masked genome expresses to all zeros and nothing is ever NaN: expression, budget, fitness,
// dawn and the codecs under hostile input (NaN, Infinity, negative, missing, malformed, Java-like objects).
// Node: node tools/genome/test/test_guard.js   Rhino: evaluate pne_hive_core.js + this file, read pneGuardResult.

var pneGuardGA = (typeof PNE_HIVE_GA !== 'undefined') ? PNE_HIVE_GA
  : require(require('path').join(__dirname, '..', '..', '..', 'overrides', 'kubejs', 'server_scripts', 'pne_hive_core.js'))

var pneGuardFails = []
var pneGuardCount = 0

function pneGuardT(cond, msg) {
  pneGuardCount++
  if (!cond) pneGuardFails.push(msg)
}

function pneGuardFinite(a) {
  var i
  for (i = 0; i < a.length; i++) if (typeof a[i] !== 'number' || !(a[i] > -1e300 && a[i] < 1e300)) return false
  return true
}

function pneGuardAllZero(a) {
  var i
  for (i = 0; i < a.length; i++) if (a[i] !== 0) return false
  return true
}

function pneGuardRun() {
  var GA = pneGuardGA
  var zero = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  var full = [65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535, 65535]
  var noMask = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  var ones = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  var Bs = [0, -1, 3, 6.5, 1e-12, 1e9]
  var weird = [NaN, Infinity, -Infinity, undefined, null, 'x', -5, 1e300]
  var masks = [GA.mask('epca:ripper'), GA.mask('epca:curbug'), GA.mask('spore:reconstructor'), noMask, ones, null, [1, 0]]
  var rng = GA.prim.rngFor(7, 'pne_guard', 0)
  var st
  var e
  var g
  var i
  var j
  var k
  var f
  var b
  var sp
  var sv
  var gov
  var cost
  var raw
  var ratio0

  // (c) all-zero genome -> zeros, under every mask and budget
  for (i = 0; i < masks.length; i++) {
    for (j = 0; j < Bs.length; j++) {
      e = GA.express(zero, masks[i], Bs[j])
      pneGuardT(e.length === 14 && pneGuardAllZero(e), 'zero genome not all zeros (mask ' + i + ', B ' + Bs[j] + ')')
    }
  }
  // (c) fully masked genome -> zeros
  for (j = 0; j < Bs.length; j++) {
    e = GA.express(full, noMask, Bs[j])
    pneGuardT(pneGuardAllZero(e), 'fully masked genome not all zeros (B ' + Bs[j] + ')')
  }
  // hostile budgets and genomes never produce NaN
  for (i = 0; i < weird.length; i++) {
    e = GA.express(full, GA.mask('epca:ripper'), weird[i])
    pneGuardT(pneGuardFinite(e), 'express NaN with B=' + weird[i])
    b = GA.budget(weird[i], weird[i], weird[i])
    pneGuardT(b > 0 && b < 10, 'budget not finite for ' + weird[i] + ': ' + b)
    e = GA.express([weird[i], 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13], GA.mask(''), 4)
    pneGuardT(pneGuardFinite(e), 'express NaN with gene ' + weird[i])
  }
  pneGuardT(pneGuardAllZero(GA.express(null, null, 4)) && pneGuardAllZero(GA.express('zz', null, 4)) && pneGuardAllZero(GA.express([1, 2], null, 4)),
    'malformed genomes express to zeros')
  // random genomes: e in [0,1], masked genes 0, combo caps hold, spend within budget, uniform scaling
  for (k = 0; k < 400; k++) {
    g = []
    for (i = 0; i < 14; i++) g.push(rng.u32() & 0xffff)
    if (k % 7 === 0) g[11] = 65535
    if (k % 5 === 0) {
      g[5] = 65535
      g[0] = 65535
      g[8] = 65535
    }
    sp = masks[k % 5]
    b = GA.budget(k % 11, 0.6 + 0.55 * rng.next(), k % 3 === 0)
    e = GA.express(g, sp, k % 13 === 0 ? 1e9 : b)
    cost = 0
    ratio0 = -1
    for (i = 0; i < 14; i++) {
      pneGuardT(e[i] >= 0 && e[i] <= 1, 'expression out of [0,1] at gene ' + i)
      if (!sp[i]) pneGuardT(e[i] === 0, 'masked gene ' + i + ' expressed')
      cost += GA.COST_MC[i] * e[i]
    }
    pneGuardT(e[5] * e[11] <= 0.36 + 1e-12, 'SIL*DMG cap broken: ' + e[5] * e[11])
    pneGuardT(e[0] * e[8] <= 0.40 + 1e-12, 'SPD*ARM cap broken: ' + e[0] * e[8])
    if (k % 13 !== 0) pneGuardT(cost <= b + 1e-9, 'spend ' + cost + ' exceeds budget ' + b)
    for (i = 0; i < 14; i++) {
      raw = g[i] / 65535
      if (!sp[i] || raw === 0 || i === 0 || i === 5 || i === 8 || i === 11) continue
      if (ratio0 < 0) ratio0 = e[i] / raw
      else pneGuardT(Math.abs(e[i] / raw - ratio0) < 1e-12, 'budget scaling not uniform at gene ' + i)
    }
  }
  // fitness and outcome never NaN, whatever the telemetry says
  st = GA.newState(3)
  for (i = 0; i < weird.length; i++) {
    f = GA.outcome(st, { id: 'w' + i, g: full, parents: weird[i], ctx: weird[i], e: [weird[i], 0.5], tel: { dmg: weird[i], engagedSec: weird[i], located: weird[i], killShare: weird[i], teamPressure: weird[i], fastKill: weird[i], cheese: weird[i] } })
    pneGuardT(typeof f === 'number' && f >= 0 && f < 10, 'outcome not finite for ' + weird[i] + ': ' + f)
  }
  pneGuardT(GA.outcome(st, null) === 0 && GA.outcome(st, { g: 'nothex' }) === 0, 'malformed outcome records are ignored')
  // dmg is capped at 12 HP per encounter (TDD 3.2): a huge hit scores, logs and moves the baseline exactly like 12
  st = GA.newState(4)
  sv = GA.newState(4)
  f = GA.outcome(st, { id: 'h', g: full, parents: '', ctx: 'cap', e: ones, tel: { dmg: 1e6, engagedSec: 10, located: 1 } })
  b = GA.outcome(sv, { id: 'h', g: full, parents: '', ctx: 'cap', e: ones, tel: { dmg: 12, engagedSec: 10, located: 1 } })
  pneGuardT(f === b && GA.events(st, 0)[0] === GA.events(sv, 0)[0] && GA.events(st, 0)[0].split('|')[8].split(',')[0] === '12000000',
    'dmg above 12 HP is capped at 12 (' + f + ' vs ' + b + ')')
  f = GA.outcome(st, { id: 'e', g: full, parents: '', ctx: 'x', e: ones, tel: { dmg: 12, engagedSec: 2000, located: 1, killShare: 1, teamPressure: 1000 } })
  pneGuardT(f >= 0 && f <= 1, 'fitness stays in [0, 1] even for a maximal record with e all ones (' + f + ')')
  f = GA.outcome(st, { id: 'c', g: full, parents: '', ctx: 'x', e: ones, tel: { dmg: 12, engagedSec: 60, located: true, killShare: 1, teamPressure: 3, cheese: true } })
  pneGuardT(f === 0, 'cheese gives fitness 0')
  // dawn: target 0 / NaN / negative / Infinity leaves gov finite and unchanged
  st = GA.newState(5)
  gov = GA.gov(st)
  for (i = 0; i < weird.length; i++) {
    GA.dawn(st, { deaths3d: 3, target: weird[i], tDay: [weird[i], 1, 0, 0, 0], stage: weird[i] })
    pneGuardT(GA.gov(st) === gov, 'dawn with target ' + weird[i] + ' changed gov to ' + GA.gov(st))
  }
  GA.dawn(st, { deaths3d: 3, target: 0, tDay: null, stage: 2 })
  GA.dawn(st, null)
  GA.dawn(st, {})
  pneGuardT(GA.gov(st) === gov && GA.sigma(st) > 0 && GA.sigma(st) <= 0.25, 'dawn with missing inputs keeps gov and sigma sane')
  e = GA.tEst(st)
  pneGuardT(pneGuardFinite(e), 'T_est finite')
  // governor steps: floor 0.6, never NaN
  for (i = 0; i < 10; i++) GA.govStep(st)
  pneGuardT(GA.gov(st) === 0.6, 'govStep floor 0.6')
  // codecs under hostile input
  pneGuardT(GA.unhex(null) === null && GA.unhex('') === null && GA.unhex('zz') === null && GA.unhex(GA.hex(full) + '0') === null &&
    GA.unhex('g' + GA.hex(full).substring(1)) === null, 'unhex rejects malformed strings')
  pneGuardT(GA.hex(null).length === 56 && GA.clade(null) === 0 && GA.clade('bad') === 0, 'hex and clade tolerate malformed genomes')
  pneGuardT(GA.load(null, 1) === null && GA.load({}, 1) === null && GA.load({ state: 'v=2;seq=0' }, 1) === null &&
    GA.load({ state: 'v=1;seq=x' }, 1) === null, 'load rejects missing, torn and foreign-schema data')
  sv = GA.save(GA.newState(9))
  pneGuardT(GA.load({ pool: 'a|b', queue: sv.queue, state: sv.state, samples: sv.samples, base: sv.base, log: '' }, 9) === null, 'load rejects a torn pool')
  pneGuardT(GA.load(sv, 9) !== null, 'load accepts a fresh save')
  pneGuardT(GA.dreamSlice(GA.newState(1), null, NaN) === true, 'dreamSlice without a dream is a no-op')
  pneGuardT(GA.breed(GA.newState(NaN)) === true, 'NaN seed still breeds')
  return pneGuardFails.length ? 'FAIL ' + pneGuardFails.length + '/' + pneGuardCount + ': ' + pneGuardFails.slice(0, 8).join(' | ') : 'PASS ' + pneGuardCount
}

var pneGuardResult
try {
  pneGuardResult = pneGuardRun()
} catch (err) {
  pneGuardResult = 'FAIL exception: ' + err
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { result: pneGuardResult }
  if (require.main === module) {
    console.log(pneGuardResult)
    process.exitCode = pneGuardResult.indexOf('PASS') === 0 ? 0 : 1
  }
}
