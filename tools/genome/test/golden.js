// Cross-engine golden digest for the GA core. ES5, every var at the top of its function.
// Node:  node tools/genome/test/golden.js          prints the digest (one line per key) as JSON
// Rhino: evaluate pne_hive_core.js, sim_hive.js, golden.js in one scope, then read pneGoldDigestStr.
// The expected values live in golden_expected.json; ga-core-node and ga-core-golden-rhino compare against it.
// JSON text is never hashed (Rhino prints 1.0); every string that is hashed is built from integers and hex.

var pneGoldGA = (typeof PNE_HIVE_GA !== 'undefined') ? PNE_HIVE_GA
  : require(require('path').join(__dirname, '..', '..', '..', 'overrides', 'kubejs', 'server_scripts', 'pne_hive_core.js'))
var pneGoldSim = (typeof pneSimBatch !== 'undefined') ? { batch: pneSimBatch, live: pneSimLive, popHash: pneSimPopHash }
  : require(require('path').join(__dirname, 'sim_hive.js'))

function pneGoldHex(h) {
  return ((h >>> 0) + 0x100000000).toString(16).substring(1)
}

// Primitive-level probes (imul, FNV, seed mixing, the mulberry32 stream, Irwin-Hall, float formatting).
function pneGoldPrim() {
  var P = pneGoldGA.prim
  var out = []
  var r = new P.Rng(12345)
  var acc = 0
  var x = 0
  var i
  out.push(P.imul32(0x85ebca6b, 0xc2b2ae35) + ',' + P.imul32(-7, 123456789) + ',' + P.imul32(0xffffffff, 0xffffffff))
  out.push(P.fnv1a('pne_hive') + ',' + P.fnv1a('pne_join') + ',' + P.fnv1a('epca:ripper'))
  out.push(P.mixSeed([12345, P.fnv1a('pne_hive'), 0]) + ',' + P.fmix32(1))
  for (i = 0; i < 1000; i++) acc = P.fmix32(acc ^ r.u32())
  out.push(String(acc))
  r = new P.Rng(7)
  for (i = 0; i < 1000; i++) x += r.gauss()
  out.push(String(Math.floor(x * 1e12)))
  out.push(String(0.1 + 0.2) + ',' + String(1 / 3) + ',' + String(5e-7) + ',' + String(P.kern(1000)) + ',' + String(P.kern(165148)))
  return pneGoldHex(P.fnv1a(out.join('/')))
}

// A scripted live run through the runtime API: breeds, joins (some linked), outcomes, dawns with dreams,
// intra-day governor steps. Returns the hash chain over hash(st) at every dawn plus the final full hash.
function pneGoldLive(seed, steps) {
  var GA = pneGoldGA
  var st = GA.newState(seed)
  var mk = GA.mask('epca:ripper')
  var drv = GA.prim.rngFor(seed, 'pne_gold_driver', 0)
  var chain = 0x811c9dc5
  var dead = []
  var i
  var j
  var ch
  var link
  var e
  var B
  var tel
  var td
  for (i = 0; i < steps; i++) {
    GA.breed(st)
    link = dead.length && drv.next() < 0.15 ? dead[Math.floor(drv.next() * dead.length)] : null
    ch = GA.join(st, link)
    B = GA.budget(Math.floor(i / 150) % 11, GA.gov(st), drv.next() < 0.1)
    e = GA.express(ch.g, i % 5 === 0 ? GA.mask('spore:spitter') : mk, B)
    if (drv.next() < 0.45) {
      tel = {
        dmg: 12 * drv.next(), engagedSec: 40 * drv.next(), located: drv.next() < 0.7, killShare: drv.next() < 0.1 ? drv.next() : 0,
        teamPressure: 3 * drv.next(), fastKill: drv.next() < 0.05, cheese: drv.next() < 0.03
      }
      GA.outcome(st, { id: ch.id, g: ch.g, parents: ch.parents, ctx: 'epca:ripper|' + (i % 2) + '|' + (Math.floor(i / 300) % 4) + '|surface', e: e, tel: tel })
      dead.push({ id: ch.id, g: ch.g })
      if (dead.length > 8) dead.shift()
    }
    if (GA.dreamPending(st)) GA.dreamSlice(st, mk, B)
    if (drv.next() < 0.004) GA.govStep(st)
    if (i % 90 === 89) {
      td = []
      for (j = 0; j < 5; j++) td.push(drv.next())
      GA.dawn(st, { deaths3d: Math.floor(drv.next() * 4), target: 1.5, tDay: td, stage: Math.floor(i / 150) % 11 })
      chain = GA.prim.fmix32(chain ^ GA.prim.fnv1a(GA.hash(st)))
    }
  }
  return { chain: pneGoldHex(chain), final: GA.hashAll(st), hash: GA.hash(st), gov: String(GA.gov(st)), sigma: String(GA.sigma(st)), st: st }
}

function pneGoldBatch(seed) {
  var A = pneGoldSim.batch({ seed: seed })
  var chain = 0x811c9dc5
  var last = A.rows[A.rows.length - 1]
  var i
  for (i = 0; i < A.hashes.length; i++) chain = pneGoldGA.prim.fmix32(chain ^ A.hashes[i])
  return {
    chain: pneGoldHex(chain), finalPop: pneGoldHex(pneGoldSim.popHash(A.finalPop)), elite: pneGoldGA.hex(A.finalPop[0]),
    probe: Math.floor(last.meanL1 * 1e15) + '/' + Math.floor(last.gov * 1e15) + '/' + Math.floor(last.meanEff * 1e15)
  }
}

function pneGoldLiveSim(seed) {
  var A = pneGoldSim.live({ seed: seed, births: 1500, shift: 750, every: 250 })
  var chain = 0
  var i
  for (i = 0; i < A.rows.length; i++) chain = pneGoldGA.prim.fmix32(chain ^ pneGoldGA.prim.fnv1a(A.rows[i].hash))
  return { chain: pneGoldHex(chain), probe: String(Math.floor(A.rows[A.rows.length - 1].align * 1e15)) }
}

function pneGoldDigest() {
  var live = pneGoldLive(12345, 1800)
  var batch = pneGoldBatch(12345)
  var ls = pneGoldLiveSim(99)
  return {
    prim: pneGoldPrim(),
    liveChain: live.chain, liveFinal: live.final, liveHash: live.hash, liveGov: live.gov, liveSigma: live.sigma,
    batchChain: batch.chain, batchFinalPop: batch.finalPop, batchElite: batch.elite, batchProbe: batch.probe,
    steadyChain: ls.chain, steadyProbe: ls.probe
  }
}

function pneGoldDigestString(d) {
  var keys = ['prim', 'liveChain', 'liveFinal', 'liveHash', 'liveGov', 'liveSigma', 'batchChain', 'batchFinalPop', 'batchElite', 'batchProbe', 'steadyChain', 'steadyProbe']
  var out = []
  var i
  for (i = 0; i < keys.length; i++) out.push(keys[i] + '=' + d[keys[i]])
  return out.join(';')
}

var pneGoldDigestStr = pneGoldDigestString(pneGoldDigest())

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { digest: pneGoldDigest, digestString: pneGoldDigestString, live: pneGoldLive, str: pneGoldDigestStr }
  if (require.main === module) console.log(pneGoldDigestStr)
}
