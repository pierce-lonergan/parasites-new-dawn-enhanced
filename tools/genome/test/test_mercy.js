// ga-core-mercy: mercy test (a) of TDD 3.3.3, and dawn with target 0 (IMPLEMENTATION.md 9.4).
//   node tools/genome/test/test_mercy.js        last line "PASS ..." or "FAIL ..."
//
// Test (a): a synthetic player who spends 40% of encounters at hp <= 30% must not raise the DMG or SPD
// allocation of the evolved population relative to a control player by more than 0.02. In those encounters the
// player is weak, so DMG and SPD make damage and kills much easier (sim_hive.js pneSimEncounter). The damage
// channels (dmg, killShare, teamPressure) are multiplied by k_mercy = 0 at the source, as HIVE does from the
// victim's health at impact. Allocation = cost share of the expressed budget (COST_MC * e / sum), averaged over
// generations 70-99 and 40 paired seeds (same seeds and random streams for both players; the governor is held
// still with target 0 so only selection differs). The ablation without k_mercy must show the effect the weighting
// removes (the test has teeth). Test (a) runs twice: in the generational batch simulator (lambda 0.15) and in the live
// steady-state path that ships (outcome with lambda 0.3, insertCrowding, lineage credit, per-outcome baselines, dawn
// dreams: sim_hive.js pneSimLive, 6000 spawns, allocation averaged over spawns 3000-6000).

var S = require('./sim_hive.js')
var GA = S.GA
var fails = []
var lines = []

function alloc(opts, n) {
  var dmg = 0
  var spd = 0
  var s
  var g
  var R
  var o
  var k
  for (s = 1; s <= n; s++) {
    o = { gens: 100, truth: S.UNIFORM, targetRate: 0, seed: s * 104729 }
    for (k in opts) o[k] = opts[k]
    R = S.batch(o).rows
    for (g = 70; g < 100; g++) {
      dmg += R[g].dmgShare / 30 / n
      spd += R[g].spdShare / 30 / n
    }
  }
  return { dmg: dmg, spd: spd }
}

function f4(x) {
  return (x >= 0 ? '+' : '') + x.toFixed(4)
}

var N = 40
var control = alloc({ mercyShare: 0 }, N)
var mercy = alloc({ mercyShare: 0.4, kMercy: true }, N)
var ablation = alloc({ mercyShare: 0.4, kMercy: false }, N)
var dD = mercy.dmg - control.dmg
var dS = mercy.spd - control.spd
var aD = ablation.dmg - control.dmg
var aS = ablation.spd - control.spd
lines.push('control  DMG ' + control.dmg.toFixed(4) + ' SPD ' + control.spd.toFixed(4))
lines.push('mercy    DMG ' + mercy.dmg.toFixed(4) + ' SPD ' + mercy.spd.toFixed(4) + '  (vs control ' + f4(dD) + ' / ' + f4(dS) + ', limit +0.02)')
lines.push('ablation DMG ' + ablation.dmg.toFixed(4) + ' SPD ' + ablation.spd.toFixed(4) + '  (no k_mercy: ' + f4(aD) + ' / ' + f4(aS) + ')')
if (dD > 0.02) fails.push('mercy player raised DMG allocation by ' + dD.toFixed(4))
if (dS > 0.02) fails.push('mercy player raised SPD allocation by ' + dS.toFixed(4))
if (!(aD + aS > dD + dS + 0.02)) fails.push('ablation does not show the exploit that k_mercy removes (test has no teeth)')

// Test (a) in the mode that ships: the live steady-state path (breed, join, outcome with lambda 0.3, insertCrowding with
// lineage credit and shrinkage, per-outcome baselines, dawn dreams), sim_hive.js pneSimLive with the same encounter
// model. 40 paired seeds, 6000 spawns, uniform tactics, governor held (target 0); allocation = the pool's DMG / SPD
// cost share at B = 4.05 averaged over spawns 3000-6000.
function allocLive(opts, n) {
  var dmg = 0
  var spd = 0
  var c = 0
  var s
  var i
  var R
  var o
  var k
  for (s = 1; s <= n; s++) {
    o = { seed: s * 104729, births: 6000, every: 250, truth: S.UNIFORM, shift: 1e9 }
    for (k in opts) o[k] = opts[k]
    R = S.live(o).rows
    for (i = 0; i < R.length; i++) {
      if (R[i].births <= 3000) continue
      dmg += R[i].dmgShare
      spd += R[i].spdShare
      c++
    }
  }
  return { dmg: dmg / c, spd: spd / c }
}

var lControl = allocLive({ mercyShare: 0 }, N)
var lMercy = allocLive({ mercyShare: 0.4, kMercy: true }, N)
var lAbl = allocLive({ mercyShare: 0.4, kMercy: false }, N)
var ldD = lMercy.dmg - lControl.dmg
var ldS = lMercy.spd - lControl.spd
var laD = lAbl.dmg - lControl.dmg
var laS = lAbl.spd - lControl.spd
lines.push('live: control DMG ' + lControl.dmg.toFixed(4) + ' SPD ' + lControl.spd.toFixed(4) + '; mercy vs control ' + f4(ldD) + ' / ' + f4(ldS) +
  ' (limit +0.02); ablation without k_mercy ' + f4(laD) + ' / ' + f4(laS))
if (ldD > 0.02) fails.push('live: mercy player raised DMG allocation by ' + ldD.toFixed(4))
if (ldS > 0.02) fails.push('live: mercy player raised SPD allocation by ' + ldS.toFixed(4))
if (!(laD + laS > ldD + ldS + 0.02)) fails.push('live: ablation does not show the exploit that k_mercy removes (test has no teeth)')

// dawn with target 0 (and non-finite targets) leaves gov finite and unchanged; deaths3d is then ignored.
;(function () {
  var st = GA.newState(77)
  var g0
  var i
  var targets = [0, -1, NaN, Infinity, undefined, null, '0']
  GA.dawn(st, { deaths3d: 50, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 1 })
  g0 = GA.gov(st)
  for (i = 0; i < targets.length; i++) {
    GA.dawn(st, { deaths3d: 50, target: targets[i], tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 1 })
    if (GA.gov(st) !== g0 || !(GA.gov(st) > 0)) fails.push('dawn with target ' + targets[i] + ' changed gov to ' + GA.gov(st))
  }
  lines.push('dawn target 0 / invalid: gov stays ' + g0 + ' over ' + targets.length + ' dawns')
})()

// Per-event k_mercy: an outcome whose damage happened entirely during mercy earns the same fitness as one that
// dealt no damage at all (the core cannot see health, only the weighted channels it is given: I2, I3).
;(function () {
  var st = GA.newState(78)
  var g = [30000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 20000, 0, 100]
  var e = GA.express(g, GA.mask('epca:ripper'), 4)
  var weighted = GA.fitness(st, { id: 'a', g: g, parents: '', ctx: 'c', e: e, tel: { dmg: 12 * 0, engagedSec: 20, located: 1, killShare: 1 * 0, teamPressure: 3 * 0 } }, 0.3)
  var none = GA.fitness(st, { id: 'b', g: g, parents: '', ctx: 'c', e: e, tel: { dmg: 0, engagedSec: 20, located: 1, killShare: 0, teamPressure: 0 } }, 0.3)
  if (weighted !== none) fails.push('k_mercy-weighted outcome differs from a no-damage outcome')
})()

lines.forEach(function (l) { console.log(l) })
console.log(fails.length ? 'FAIL ' + fails.join(' | ') : 'PASS mercy: batch DMG ' + f4(dD) + ' SPD ' + f4(dS) + ' (ablation ' + f4(aD) + ' / ' + f4(aS) +
  '), live DMG ' + f4(ldD) + ' SPD ' + f4(ldS) + ' (ablation ' + f4(laD) + ' / ' + f4(laS) + ') vs control, limit +0.02; dawn target 0 keeps gov')
process.exitCode = fails.length ? 1 : 0
