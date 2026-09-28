// ga-core-dream-align: live (steady-state) mode with the dawn dream (TDD 3.3.3 and 6.3, Appendix E; IMPLEMENTATION.md 9.4
// and lead decision 1.3, "Changes in 1.3").
//   node tools/genome/test/sweep_steady.js        last line "PASS ..." (exit 0) or "FAIL ..." (exit 1)
//
// Runs sim_hive.js pneSimLive through the runtime API only (breed, join with 10% conversion links, outcome,
// dawn every 60 spawns, dream slices paced like the game: ~28 slices between two spawns), 40% of spawns engage,
// lambda 0.3 (the live value inside the core), T_est fed by noisy daily tactic profiles, with and without the
// dream, 10 seeds, pool 48 (IMPLEMENTATION.md 3.7 CAP), from a fresh pool; the tactic profile shifts at 6000 spawns and
// the run goes on for 6000 more (the post-shift phase). Alignment = mean over the pool of sum_t truth_t *
// counterScore_t(e) at B = 4.05 (the prototype's metric).
// Gates (lead decision 1.3: the binding insertDreamed eligibility rule of TDD 3.3.1 stays, so the 0.5 target is read
// "within the 6000-spawn phase"; there is no SKIP any more):
//   - live alignment with the dream >= 0.5 at the end of the first 6000-spawn phase (FAIL below it);
//   - the dream adds >= 0.05 over the same runs without it at 3000 spawns (the TDD's old measuring point, ~1,200
//     evaluations), at 6000 spawns and at the end of the post-shift phase (12000 spawns);
//   - the live run is deterministic (same seed twice gives the same state hash, seed + 1 differs).
// The 3000-spawn alignment and the post-shift trajectory are printed as information (0.5 is a first-phase figure; the
// adaptation after a tactic shift is gated by ga-core-adaptation).
// Measured with the shipped core: 0.542 at 6000 spawns (0.461 at 3000); gains 0.070 / 0.131 / 0.076.

var S = require('./sim_hive.js')
var fails = []
var ALIGN_MIN = 0.5
var GAIN_MIN = 0.05
// row index of each measuring point in traj() (one row per 1000 spawns)
var AT_3000 = 2
var AT_6000 = 5
var AT_END = 11

function f3(x) {
  return x.toFixed(3)
}

function traj(dream) {
  var n = 10
  var a = []
  var s
  var i
  var R
  for (i = 0; i < 12; i++) a.push(0)
  for (s = 1; s <= n; s++) {
    R = S.live({ seed: s * 104729, every: 500, births: 12000, shift: 6000, dream: dream }).rows
    for (i = 0; i < 12; i++) a[i] += R[i * 2 + 1].align / n
  }
  return a
}

function gain(on, off, at, label) {
  var d = on[at] - off[at]
  if (!(d >= GAIN_MIN)) fails.push('dream gain at ' + label + ' only ' + f3(d) + ' (' + f3(on[at]) + ' vs ' + f3(off[at]) + ' without; need >= ' + GAIN_MIN + ')')
  return d
}

var on = traj(true)
var off = traj(false)
console.log('spawns        ' + [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000].join('   '))
console.log('with dream    ' + on.map(f3).join('  '))
console.log('without dream ' + off.map(f3).join('  '))
console.log('info: TDD 3000-spawn point (~1,200 evaluations): dream ' + f3(on[AT_3000]) + ' vs ' + f3(off[AT_3000]) + ' without')
console.log('info: post-shift phase (6000 -> 12000 spawns): dream ' + f3(on[AT_6000 + 1]) + ' -> ' + f3(on[AT_END]) +
  ', without ' + f3(off[AT_6000 + 1]) + ' -> ' + f3(off[AT_END]))
var g3 = gain(on, off, AT_3000, '3000 spawns')
var g6 = gain(on, off, AT_6000, '6000 spawns')
var gE = gain(on, off, AT_END, 'the end of the post-shift phase (12000 spawns)')
if (!(on[AT_6000] >= ALIGN_MIN)) {
  fails.push('dream alignment ' + f3(on[AT_6000]) + ' at the end of the 6000-spawn phase < ' + ALIGN_MIN + ' (lead decision 1.3)')
}
;(function () {
  var a = S.live({ seed: 5, births: 1200, every: 600 })
  var b = S.live({ seed: 5, births: 1200, every: 600 })
  var c = S.live({ seed: 6, births: 1200, every: 600 })
  if (a.rows[1].hash !== b.rows[1].hash) fails.push('live run not deterministic')
  if (a.rows[1].hash === c.rows[1].hash) fails.push('live run does not depend on the seed')
  console.log('dreams per run ' + a.dreams + ', slices ' + a.slices + ' (1200 spawns)')
})()
if (fails.length) {
  console.log('FAIL ' + fails.join(' | '))
  process.exitCode = 1
} else {
  console.log('PASS dream alignment ' + f3(on[AT_6000]) + ' at 6000 spawns (>= ' + ALIGN_MIN + ', lead decision 1.3; no dream ' + f3(off[AT_6000]) +
    '); dream gain ' + f3(g3) + ' at 3000, ' + f3(g6) + ' at 6000, ' + f3(gE) + ' at the end of the post-shift phase (each >= ' + GAIN_MIN +
    '); info: ' + f3(on[AT_3000]) + ' at 3000 spawns, post-shift ' + f3(on[AT_END]) + ' vs ' + f3(off[AT_END]) + ' without; deterministic')
  process.exitCode = 0
}
