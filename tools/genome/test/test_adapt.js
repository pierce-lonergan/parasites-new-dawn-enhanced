// ga-core-adaptation: adaptation and diversity (TDD 3.3.3 and 6.3; IMPLEMENTATION.md 9.4).
//   node tools/genome/test/test_adapt.js        last line "PASS ..." or "FAIL ..."
//
// Generational simulator (sim_hive.js pneSimBatch; population 48, 4 encounters per genome, 120 generations, tactic
// shift at generation 60 from a torch-lit melee turtler to a dark, sneaky kiter) over 20 seeds:
//  - adaptation: counter set 2 (kite + hide + audio counters) overtakes set 1 (light + turtle) within <= 3
//    generations of the shift in >= 18 of 20 seeds;
//  - the core's own dawn detects the shift (hypermutation starts) within 3 generations of it in every seed;
//  - diversity: mean normalised L1 over all generations and seeds >= 0.15.

var S = require('./sim_hive.js')
var fails = []
var n = 20
var ok = 0
var lags = []
var detect = []
var divSum = 0
var divMin = 1
var niches = 0
var nichesMin = 99
var s
var g
var R
var lag
var det
var pre1 = 0
var pre2 = 0
var post1 = 0
var post2 = 0

for (s = 1; s <= n; s++) {
  R = S.batch({ seed: s * 7919 }).rows
  lag = -1
  det = -1
  for (g = 60; g < 120; g++) {
    if (lag < 0 && R[g].share2 > R[g].share1) lag = g - 60
    if (det < 0 && R[g].shift) det = g - 60
  }
  lags.push(lag)
  detect.push(det)
  if (lag >= 0 && lag <= 3) ok++
  if (det < 0 || det > 3) fails.push('seed ' + s + ': shift detected at +' + det)
  for (g = 0; g < 120; g++) {
    divSum += R[g].meanL1 / 120 / n
    niches += R[g].niches / 120 / n
    if (R[g].meanL1 < divMin) divMin = R[g].meanL1
    if (R[g].niches < nichesMin) nichesMin = R[g].niches
  }
  for (g = 50; g < 60; g++) {
    pre1 += R[g].share1 / 10 / n
    pre2 += R[g].share2 / 10 / n
  }
  for (g = 110; g < 120; g++) {
    post1 += R[g].share1 / 10 / n
    post2 += R[g].share2 / 10 / n
  }
}

var meanLag = 0
var found = 0
for (s = 0; s < n; s++) {
  if (lags[s] >= 0) {
    meanLag += lags[s]
    found++
  }
}
meanLag = found ? meanLag / found : -1
console.log('crossover lag per seed (generations after the shift): ' + lags.join(','))
console.log('shift detection per seed: ' + detect.join(','))
console.log('counter share pre-shift (gens 50-59) set1 ' + pre1.toFixed(3) + ' set2 ' + pre2.toFixed(3) + '; post-shift (110-119) set1 ' + post1.toFixed(3) + ' set2 ' + post2.toFixed(3))
console.log('diversity: mean L1 ' + divSum.toFixed(3) + ' (min ' + divMin.toFixed(3) + '); niches at r = 0.12 mean ' + niches.toFixed(1) + ' (min ' + nichesMin + ')')
if (ok < 18) fails.push('crossover within 3 generations in only ' + ok + '/20 seeds')
if (divSum < 0.15) fails.push('mean L1 diversity ' + divSum.toFixed(3) + ' < 0.15')
if (!(post2 > post1 && pre1 > pre2)) fails.push('counter sets did not swap')
console.log(fails.length ? 'FAIL ' + fails.join(' | ')
  : 'PASS adaptation: crossover <= 3 generations in ' + ok + '/20 seeds (mean ' + meanLag.toFixed(2) + '); diversity mean L1 ' + divSum.toFixed(3))
process.exitCode = fails.length ? 1 : 0
