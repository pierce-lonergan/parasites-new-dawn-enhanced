// Hive Genome simulators on top of PNE_HIVE_GA (overrides/kubejs/server_scripts/pne_hive_core.js).
// ES5 with every var at the top of its function, so the same file runs in Node and in the Rhino fork.
//
// simulateBatch(opts): the generational simulator of docs/TDD.md 3.3.3 (population 48, 4 encounters per
//   genome per generation, tactic shift at generation 60 from a torch-lit melee turtler to a dark, sneaky
//   kiter). One generation is one in-game day: the batch fitness (lambda 0.15) goes through PNE_HIVE_GA.fitness,
//   the population is handed to the core (setPool) and PNE_HIVE_GA.dawn runs the governor, the tactic EMAs,
//   shift detection, hypermutation and sigma adaptation; PNE_HIVE_GA.nextGen breeds the next generation.
// simulateLive(opts): steady-state live mode through the runtime API only (breed, join, outcome, dawn,
//   dreamSlice): one encounter per spawn, 40% of spawns engage, one day = 60 spawns. opts.truth fixes the tactic
//   profile (no shift); rows also carry the pool's DMG and SPD cost shares at B = 4.05.
// Player vulnerability (the mercy test, both simulators): opts.mercyShare = share of encounters the player spends at
//   hp <= 30%; in those encounters DMG and SPD make kills and damage much easier, and opts.kMercy (default true) zeroes
//   every damage channel of that encounter at the source (dmg, killShare, teamPressure), as HIVE does. In the live
//   simulator the extra random draw happens only when mercyShare > 0, so the default streams (and goldens) are unchanged.

var pneSimGA = (typeof PNE_HIVE_GA !== 'undefined') ? PNE_HIVE_GA
  : require(require('path').join(__dirname, '..', '..', '..', 'overrides', 'kubejs', 'server_scripts', 'pne_hive_core.js'))

var PNE_SIM_PHASE1 = [0.05, 0.00, 0.40, 0.50, 0.05]
var PNE_SIM_PHASE2 = [0.35, 0.55, 0.00, 0.00, 0.10]
var PNE_SIM_UNIFORM = [0.2, 0.2, 0.2, 0.2, 0.2]
var PNE_SIM_SET1 = [2, 3]
var PNE_SIM_SET2 = [0, 1, 4]

function pneSimCounterShare(e, t) {
  var GA = pneSimGA
  var tot = 0
  var part = 0
  var i
  var j
  var row = [[1, 2], [0, 6, 7], [9, 11], [3, 4], [5]][t]
  var inRow
  for (i = 0; i < GA.G; i++) {
    tot += GA.COST_MC[i] * e[i]
    inRow = false
    for (j = 0; j < row.length; j++) if (row[j] === i) inRow = true
    if (inRow) part += GA.COST_MC[i] * e[i]
  }
  return tot > 0 ? part / tot : 0
}

function pneSimGeneShare(e, gi) {
  var GA = pneSimGA
  var tot = 0
  var i
  for (i = 0; i < GA.G; i++) tot += GA.COST_MC[i] * e[i]
  return tot > 0 ? GA.COST_MC[gi] * e[gi] / tot : 0
}

function pneSimEff(e, truth) {
  var GA = pneSimGA
  var s = 0
  var t
  for (t = 0; t < 5; t++) s += truth[t] * GA.counterScore(e, t)
  return 0.75 * s + 0.25 * (0.4 * e[10] + 0.3 * e[8] + 0.3 * e[11])
}

function pneSimAlign(e, truth) {
  var GA = pneSimGA
  var s = 0
  var t
  for (t = 0; t < 5; t++) s += truth[t] * GA.counterScore(e, t)
  return s
}

function pneSimDiversity(pop, radius) {
  var GA = pneSimGA
  var i
  var j
  var sum = 0
  var pairs = 0
  var leaders = []
  var found
  var d
  for (i = 0; i < pop.length; i++) {
    for (j = i + 1; j < pop.length; j++) {
      sum += GA.prim.sumAbs(pop[i], pop[j]) / (GA.G * GA.Q)
      pairs++
    }
  }
  for (i = 0; i < pop.length; i++) {
    found = false
    for (j = 0; j < leaders.length; j++) {
      d = GA.prim.sumAbs(pop[i], pop[leaders[j]]) / (GA.G * GA.Q)
      if (d < radius) {
        found = true
        break
      }
    }
    if (!found) leaders.push(i)
  }
  return { meanL1: pairs ? sum / pairs : 0, niches: leaders.length }
}

function pneSimPopHash(pop) {
  var GA = pneSimGA
  var s = ''
  var i
  for (i = 0; i < pop.length; i++) s += GA.hex(pop[i])
  return GA.prim.fnv1a(s)
}

// One encounter (TDD 3.3.3 player model) -> { tel, died }.
function pneSimEncounter(rng, e, eff, stage, lowHp, kMercy) {
  var night = rng.next() < 0.5 ? 1 : 0
  var E = eff * (night ? 1.15 : 1.0)
  var located = rng.next() < 0.25 + 0.7 * E ? 1 : 0
  var exploit = lowHp ? (e[11] + e[0]) : 0
  var dmg = located ? Math.max(0, 9 * E + 1.5 * rng.gauss() + 12 * exploit) : 0
  var eng = located ? Math.max(0, 4 + 30 * E + 3 * rng.gauss()) : 1
  var pd = located ? Math.min(1, 0.30 * E * E + 0.8 * exploit) : 0
  var died = rng.next() < pd ? 1 : 0
  var fast = died && rng.next() < 0.5 * E ? 1 : 0
  var team = dmg * (0.8 + 0.4 * rng.next())
  var k = (lowHp && kMercy) ? 0 : 1
  var band = stage < 3 ? 0 : (stage < 6 ? 1 : (stage < 9 ? 2 : 3))
  return {
    died: died,
    ctx: 'epca:ripper|' + night + '|' + band + '|surface',
    tel: { dmg: dmg * k, engagedSec: eng, located: located, killShare: died * k, teamPressure: team * k, fastKill: fast, cheese: 0 }
  }
}

function pneSimBatch(opts) {
  var GA = pneSimGA
  var gens = opts.gens || 120
  var shift = opts.shift === undefined ? 60 : opts.shift
  var enc = opts.enc || 4
  var lambda = opts.lambda === undefined ? GA.LAMBDA_BATCH : opts.lambda
  var seed = opts.seed >>> 0
  var targetRate = opts.targetRate === undefined ? 0.04 : opts.targetRate
  var mercyShare = opts.mercyShare || 0
  var kMercy = opts.kMercy === undefined ? true : opts.kMercy
  var st = GA.newState(seed)
  var mk = GA.mask('epca:ripper')
  var initRng = GA.prim.rngFor(seed, 'pne_sim_init', 0)
  var pop = []
  var rows = []
  var hashes = []
  var dHist = []
  var nHist = []
  var i
  var g
  var j
  var t
  var truth
  var simRng
  var obs
  var stage
  var B
  var raw
  var deaths
  var encs
  var sumE
  var s1
  var s2
  var sDmg
  var sSpd
  var e
  var eff
  var f
  var x
  var lowHp
  var dv
  var d3
  var n3
  var shiftFlag
  var hyperBefore
  for (i = 0; i < 48; i++) {
    x = []
    for (j = 0; j < GA.G; j++) x.push(initRng.u32() & 0xffff)
    pop.push(x)
  }
  for (g = 0; g < gens; g++) {
    truth = opts.truth ? opts.truth : (g < shift ? PNE_SIM_PHASE1 : PNE_SIM_PHASE2)
    simRng = GA.prim.rngFor(seed, 'pne_sim', g)
    obs = []
    for (t = 0; t < 5; t++) obs.push(truth[t] + 0.05 * simRng.next())
    stage = Math.min(10, Math.floor(g / 12))
    B = GA.budget(stage, GA.gov(st), false)
    raw = []
    deaths = 0
    encs = 0
    sumE = 0
    s1 = 0
    s2 = 0
    sDmg = 0
    sSpd = 0
    for (i = 0; i < pop.length; i++) {
      e = GA.express(pop[i], mk, B)
      eff = pneSimEff(e, truth)
      sumE += eff
      for (t = 0; t < PNE_SIM_SET1.length; t++) s1 += pneSimCounterShare(e, PNE_SIM_SET1[t])
      for (t = 0; t < PNE_SIM_SET2.length; t++) s2 += pneSimCounterShare(e, PNE_SIM_SET2[t])
      sDmg += pneSimGeneShare(e, 11)
      sSpd += pneSimGeneShare(e, 0)
      f = 0
      for (j = 0; j < enc; j++) {
        lowHp = simRng.next() < mercyShare
        x = pneSimEncounter(simRng, e, eff, stage, lowHp, kMercy)
        f += GA.fitness(st, { id: 'x', g: pop[i], parents: '', ctx: x.ctx, e: e, tel: x.tel }, lambda)
        GA.learn(st, { id: 'x', g: pop[i], parents: '', ctx: x.ctx, e: e, tel: x.tel })
        deaths += x.died
        encs++
      }
      raw.push(f / enc)
    }
    dv = pneSimDiversity(pop, 0.12)
    hashes.push(pneSimPopHash(pop))
    GA.setPool(st, pop, raw)
    dHist.push(deaths)
    nHist.push(encs)
    d3 = 0
    n3 = 0
    for (j = Math.max(0, dHist.length - 3); j < dHist.length; j++) {
      d3 += dHist[j]
      n3 += nHist[j]
    }
    hyperBefore = GA.hyper(st)
    GA.dawn(st, { deaths3d: d3, target: targetRate > 0 ? targetRate * n3 : 0, tDay: obs, stage: stage })
    shiftFlag = GA.hyper(st) === 6 && hyperBefore !== 6
    rows.push({
      gen: g, share1: s1 / pop.length, share2: s2 / pop.length, dmgShare: sDmg / pop.length, spdShare: sSpd / pop.length,
      meanL1: dv.meanL1, niches: dv.niches, sigma: GA.sigma(st), gov: GA.gov(st), deathRate: deaths / encs,
      meanEff: sumE / pop.length, shift: shiftFlag, hyper: GA.hyper(st)
    })
    pop = GA.nextGen(st, pop, raw, g)
  }
  return { rows: rows, hashes: hashes, finalPop: pop, st: st }
}

function pneSimLive(opts) {
  var GA = pneSimGA
  var births = opts.births || 6000
  var shift = opts.shift === undefined ? 3000 : opts.shift
  var day = opts.day || 60
  var engage = opts.engage === undefined ? 0.4 : opts.engage
  var every = opts.every || 250
  var dream = opts.dream === undefined ? true : opts.dream
  var linkRate = opts.linkRate === undefined ? 0.1 : opts.linkRate
  var slicesPerSpawn = opts.slicesPerSpawn || 28
  var mercyShare = opts.mercyShare || 0
  var kMercy = opts.kMercy === undefined ? true : opts.kMercy
  var seed = opts.seed >>> 0
  var st = GA.newState(seed)
  var mk = GA.mask('epca:ripper')
  var simRng = GA.prim.rngFor(seed, 'pne_sim_live', 0)
  var out = []
  var dead = []
  var b
  var t
  var i
  var truth
  var link
  var ch
  var B
  var e
  var eff
  var x
  var obs
  var pe
  var al
  var dv
  var pop
  var lowHp
  var sDmg
  var sSpd
  var dreams = 0
  var slices = 0
  for (b = 0; b < births; b++) {
    truth = opts.truth ? opts.truth : (b < shift ? PNE_SIM_PHASE1 : PNE_SIM_PHASE2)
    GA.breed(st)
    link = null
    if (dead.length && simRng.next() < linkRate) link = dead.pop()
    ch = GA.join(st, link)
    B = GA.budget(3, GA.gov(st), false)
    e = GA.express(ch.g, mk, B)
    eff = pneSimEff(e, truth)
    if (simRng.next() < engage) {
      lowHp = mercyShare > 0 && simRng.next() < mercyShare
      x = pneSimEncounter(simRng, e, eff, 3, lowHp, kMercy)
      GA.outcome(st, { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'ss', e: e, tel: x.tel })
      dead.push({ id: ch.id, g: ch.g })
      if (dead.length > 4) dead.shift()
    }
    for (i = 0; dream && i < slicesPerSpawn && GA.dreamPending(st); i++) {
      GA.dreamSlice(st, mk, B)
      slices++
    }
    if (b % day === day - 1) {
      obs = []
      for (t = 0; t < 5; t++) obs.push(truth[t] + 0.05 * simRng.next())
      if (GA.dawn(st, { deaths3d: 0, target: 0, tDay: obs, stage: 3 }).dream) dreams++
    }
    if (b % every === every - 1) {
      al = 0
      sDmg = 0
      sSpd = 0
      pop = []
      for (i = 0; i < GA.poolSize(st); i++) {
        pe = GA.express(st.pool[i].g, mk, 4.05)
        al += pneSimAlign(pe, truth)
        sDmg += pneSimGeneShare(pe, 11)
        sSpd += pneSimGeneShare(pe, 0)
        pop.push(st.pool[i].g)
      }
      dv = pneSimDiversity(pop, 0.12)
      out.push({ births: b + 1, align: al / Math.max(1, pop.length), dmgShare: sDmg / Math.max(1, pop.length), spdShare: sSpd / Math.max(1, pop.length),
        meanL1: dv.meanL1, niches: dv.niches, sigma: GA.sigma(st), gen: GA.gen(st), hash: GA.hash(st) })
    }
  }
  return { rows: out, st: st, dreams: dreams, slices: slices }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GA: pneSimGA, batch: pneSimBatch, live: pneSimLive, diversity: pneSimDiversity, popHash: pneSimPopHash,
    counterShare: pneSimCounterShare, geneShare: pneSimGeneShare, eff: pneSimEff, align: pneSimAlign,
    PHASE1: PNE_SIM_PHASE1, PHASE2: PNE_SIM_PHASE2, UNIFORM: PNE_SIM_UNIFORM
  }
}
