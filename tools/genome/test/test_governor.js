// ga-core-governor: the death-rate governor tracks its target within +-0.01 (TDD 3.6 and 6.3).
//   node tools/genome/test/test_governor.js        last line "PASS ..." or "FAIL ..."
//
// The dawn governor of PNE_HIVE_GA (gov = clamp(gov - 0.1 * clamp((deaths3d - target) / target, -1, 1), 0.6, 1.15))
// runs in the generational simulator: one generation = one in-game day, deaths3d = deaths of the last 3 days,
// target = rate x encounters of the last 3 days. Checked over 20 seeds:
//  - after the tactic shift (generations 60-119) the death rate per encounter is within +-0.01 of the target, for
//    targets 0.03, 0.04 and 0.05 (it has to track, not happen to land there);
//  - a 200-day run without a shift stays within +-0.01 of 0.04 (days 50-199);
//  - every dawn step is at most 0.1 and gov stays inside [0.6, 1.15];
//  - the intra-day step (2 hive deaths in 20 real minutes, called by HIVE) is gov x 0.85 with floor 0.6.

var S = require('./sim_hive.js')
var GA = S.GA
var fails = []
var lines = []

function rate(opts, from, to) {
  var n = 20
  var s
  var g
  var R
  var o
  var k
  var dr = 0
  var gv = 0
  var maxStep = 0
  var lo = 9
  var hi = 0
  for (s = 1; s <= n; s++) {
    o = { seed: s * 7919 }
    for (k in opts) o[k] = opts[k]
    R = S.batch(o).rows
    for (g = from; g < to; g++) {
      dr += R[g].deathRate / (to - from) / n
      gv += R[g].gov / (to - from) / n
    }
    for (g = 1; g < R.length; g++) {
      maxStep = Math.max(maxStep, Math.abs(R[g].gov - R[g - 1].gov))
      lo = Math.min(lo, R[g].gov)
      hi = Math.max(hi, R[g].gov)
    }
  }
  return { rate: dr, gov: gv, maxStep: maxStep, lo: lo, hi: hi }
}

;[0.03, 0.04, 0.05].forEach(function (target) {
  var r = rate({ targetRate: target }, 60, 120)
  lines.push('target ' + target.toFixed(2) + ': post-shift death rate ' + r.rate.toFixed(4) + ' (error ' + (r.rate - target).toFixed(4) + '), mean gov ' +
    r.gov.toFixed(3) + ', max dawn step ' + r.maxStep.toFixed(4) + ', gov range [' + r.lo + ', ' + r.hi + ']')
  if (Math.abs(r.rate - target) > 0.01) fails.push('target ' + target + ': rate ' + r.rate.toFixed(4))
  if (r.maxStep > 0.1 + 1e-9) fails.push('dawn step ' + r.maxStep + ' > 0.1')
  if (r.lo < 0.6 || r.hi > 1.15) fails.push('gov left [0.6, 1.15]')
})
;(function () {
  var r = rate({ targetRate: 0.04, gens: 200, shift: 1e9 }, 50, 200)
  lines.push('stationary 200 days, target 0.04: death rate ' + r.rate.toFixed(4) + ' (error ' + (r.rate - 0.04).toFixed(4) + ')')
  if (Math.abs(r.rate - 0.04) > 0.01) fails.push('stationary rate ' + r.rate.toFixed(4))
})()
// Small counts: in game the default target is 1 hive-caused death per player per 3 days, so deaths3d is a small
// integer and the dawn step is +-0.1 or 0 most days (a bang-bang controller with a dead zone at deaths3d == target).
// Daily deaths are Poisson with a mean that rises with the expressed budget: mean = (target / 3) * (B / B*)^2, with
// B = budget(stage 3, gov) and B* = budget(stage 3, 0.85), so the target is reachable inside [0.6, 1.15]. 20 seeds x
// 400 days, days 50-399. Required: mean deaths per 3 days within 25% of the target, and gov at the 0.6 or 1.15 bound on
// at most half of the dawns (it must settle, not oscillate between the bounds). A failure here is a TDD 3.6 formula
// issue to report, not something to tune in the simulator.
function poisson(rng, mean) {
  var L = Math.exp(-mean)
  var k = 0
  var p = rng.next()
  while (p > L && k < 50) {
    k++
    p *= rng.next()
  }
  return k
}

function smallCounts(target) {
  var n = 20
  var days = 400
  var Bstar = GA.budget(3, 0.85, false)
  var s
  var d
  var st
  var rng
  var hist
  var d3
  var sum = 0
  var cnt = 0
  var atBound = 0
  var gsum = 0
  var mean
  var j
  for (s = 1; s <= n; s++) {
    st = GA.newState(s * 31337)
    rng = GA.prim.rngFor(s * 31337, 'pne_gov_small', target)
    hist = []
    for (d = 0; d < days; d++) {
      mean = (target / 3) * Math.pow(GA.budget(3, GA.gov(st), false) / Bstar, 2)
      hist.push(poisson(rng, mean))
      d3 = 0
      for (j = Math.max(0, hist.length - 3); j < hist.length; j++) d3 += hist[j]
      GA.dawn(st, { deaths3d: d3, target: target, tDay: null, stage: 3 })
      if (d >= 50) {
        sum += hist[hist.length - 1] * 3
        cnt++
        gsum += GA.gov(st)
        if (GA.gov(st) <= 0.6 || GA.gov(st) >= 1.15) atBound++
      }
    }
  }
  return { per3: sum / cnt, bound: atBound / cnt, gov: gsum / cnt }
}

;[1, 3].forEach(function (target) {
  var r = smallCounts(target)
  lines.push('small counts, target ' + target + ' per 3 days: mean ' + r.per3.toFixed(3) + ' deaths per 3 days (' +
    ((r.per3 / target - 1) * 100).toFixed(1) + '%), mean gov ' + r.gov.toFixed(3) + ', dawns at a bound ' + (r.bound * 100).toFixed(1) + '%')
  if (Math.abs(r.per3 - target) > 0.25 * target) fails.push('small counts target ' + target + ': ' + r.per3.toFixed(3) + ' deaths per 3 days')
  if (r.bound > 0.5) fails.push('small counts target ' + target + ': gov at a bound on ' + (r.bound * 100).toFixed(1) + '% of dawns')
})

;(function () {
  var st = GA.newState(1)
  var seq = [GA.govStep(st), GA.govStep(st), GA.govStep(st), GA.govStep(st), GA.govStep(st)]
  lines.push('intra-day steps from 1.0: ' + seq.join(', '))
  if (seq.join(',') !== '0.85,0.7225,0.614125,0.6,0.6') fails.push('govStep sequence ' + seq.join(','))
})()

lines.forEach(function (l) { console.log(l) })
console.log(fails.length ? 'FAIL ' + fails.join(' | ') : 'PASS governor tracks 0.03 / 0.04 / 0.05 within +-0.01; small counts (1 and 3 per 3 days) ' +
  'within 25% without pinning at the bounds; steps <= 0.1; intra-day x0.85 floor 0.6')
process.exitCode = fails.length ? 1 : 0
