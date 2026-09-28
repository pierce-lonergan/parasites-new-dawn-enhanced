// Interleaved replay golden (TDD 3.3.3 test (b); IMPLEMENTATION.md 9.4 ga-core-replay). ES5, Node and Rhino.
//
// For 24 seeds a driver picks random legal actions (breed B, join J with or without a conversion link and with P
// when it pops the queue, outcome I for a random living mob, dawn D, dream slice R while a dream is pending,
// intra-day governor step G) and records every log string. Then, for each scenario:
//  - replay(seed, null, allEvents) must reproduce the live state exactly (every save() field compared as text);
//  - replay from each snapshot taken along the way plus the events after it must reproduce the live state;
//  - replay from the newest snapshot inside the saved tail window plus save(live).log alone must reproduce it;
//  - a replay of a tampered log must report a divergence (rbad > 0), never a silent success.
// The digest (FNV over every final state) must be identical in Node and Rhino (golden_expected.json "replay").
// Node: node tools/genome/test/replay_golden.js   Rhino: evaluate pne_hive_core.js + this file, read pneRepResult.

var pneRepGA = (typeof PNE_HIVE_GA !== 'undefined') ? PNE_HIVE_GA
  : require(require('path').join(__dirname, '..', '..', '..', 'overrides', 'kubejs', 'server_scripts', 'pne_hive_core.js'))

function pneRepSer(sv) {
  var parts = [sv.pool, sv.queue, sv.state, sv.samples.join('/'), sv.log]
  var i
  for (i = 0; i < sv.base.length; i++) parts.push(sv.base[i].k + '=' + sv.base[i].v.join(','))
  return parts.join('#')
}

function pneRepScenario(seed, steps) {
  var GA = pneRepGA
  var st = GA.newState(seed)
  var drv = GA.prim.rngFor(seed, 'pne_rep_driver', 0)
  var mk = GA.mask('epca:ripper')
  var alive = []
  var dead = []
  var all = []
  var snaps = []
  var last = 0
  var i
  var j
  var r
  var ch
  var link
  var m
  var ev
  var td
  var counts = { B: 0, P: 0, J: 0, I: 0, D: 0, R: 0, G: 0 }
  for (i = 0; i < steps; i++) {
    r = drv.next()
    if (r < 0.30) {
      GA.breed(st)
    } else if (r < 0.55) {
      link = dead.length && drv.next() < 0.2 ? dead[Math.floor(drv.next() * dead.length)] : null
      ch = GA.join(st, link)
      alive.push({ id: ch.id, g: ch.g, parents: ch.parents, sp: drv.next() < 0.2 ? 'spore:mound' : 'epca:ripper' })
      if (alive.length > 40) alive.shift()
    } else if (r < 0.76) {
      if (alive.length) {
        j = Math.floor(drv.next() * alive.length)
        m = alive[j]
        alive.splice(j, 1)
        GA.outcome(st, {
          id: m.id, g: m.g, parents: m.parents, ctx: m.sp + '|' + (i % 2) + '|' + (Math.floor(i / 200) % 4) + '|cave',
          e: GA.express(m.g, GA.mask(m.sp), GA.budget(Math.floor(i / 100) % 11, GA.gov(st), drv.next() < 0.2)),
          tel: { dmg: 12 * drv.next(), engagedSec: 30 * drv.next(), located: drv.next() < 0.8, killShare: drv.next() < 0.15 ? drv.next() : 0,
            teamPressure: 2 * drv.next(), fastKill: drv.next() < 0.05, cheese: drv.next() < 0.03 }
        })
        dead.push({ id: m.id, g: m.g })
        if (dead.length > 6) dead.shift()
      }
    } else if (r < 0.785) {
      td = []
      for (j = 0; j < 5; j++) td.push(drv.next() < 0.2 ? 0 : drv.next())
      GA.dawn(st, { deaths3d: Math.floor(drv.next() * 5), target: drv.next() < 0.15 ? 0 : 2 * drv.next(), tDay: td, stage: Math.floor(drv.next() * 11) })
    } else if (r < 0.985) {
      if (GA.dreamPending(st)) GA.dreamSlice(st, drv.next() < 0.3 ? GA.mask('spore:spitter') : mk, GA.budget(Math.floor(drv.next() * 11), GA.gov(st), false))
    } else {
      GA.govStep(st)
    }
    ev = GA.events(st, last)
    for (j = 0; j < ev.length; j++) {
      all.push(ev[j])
      counts[ev[j].charAt(0)]++
    }
    last = GA.seq(st)
    if (drv.next() < 0.01) snaps.push({ sv: GA.save(st), seq: GA.seq(st), at: all.length })
  }
  return { st: st, all: all, snaps: snaps, counts: counts }
}

function pneRepCheck(seed, steps) {
  var GA = pneRepGA
  var sc = pneRepScenario(seed, steps)
  var finalSv = GA.save(sc.st)
  var fin = pneRepSer(finalSv)
  var fails = []
  var rp
  var i
  var k
  var tailFirst
  var best = -1
  var bad
  rp = GA.replay(seed, null, sc.all)
  if (!rp || rp.rbad || pneRepSer(GA.save(rp)) !== fin) fails.push('seed ' + seed + ' genesis replay ' + (rp ? rp.rmsg : 'null'))
  // At most 4 evenly spaced snapshots per scenario (keeps the Rhino run short; the digest does not depend on it).
  for (k = 0; k < 4 && k < sc.snaps.length; k++) {
    i = sc.snaps.length <= 4 ? k : Math.floor(k * (sc.snaps.length - 1) / 3)
    rp = GA.replay(seed, sc.snaps[i].sv, sc.all.slice(sc.snaps[i].at))
    if (!rp || rp.rbad || pneRepSer(GA.save(rp)) !== fin) fails.push('seed ' + seed + ' snapshot ' + i + ' replay ' + (rp ? rp.rmsg : 'null'))
  }
  tailFirst = finalSv.log.length ? Number(finalSv.log.split('\n')[0].split('|')[1]) : sc.st.seq + 1
  for (i = 0; i < sc.snaps.length; i++) if (sc.snaps[i].seq + 1 >= tailFirst) best = i
  if (best >= 0) {
    rp = GA.replay(seed, sc.snaps[best].sv, finalSv.log)
    if (!rp || rp.rbad || pneRepSer(GA.save(rp)) !== fin) fails.push('seed ' + seed + ' snapshot+tail replay ' + (rp ? rp.rmsg : 'null'))
  }
  // Tampering must be detected: change the fitness payload of one I event, or drop one event.
  bad = sc.all.slice(0)
  for (k = Math.floor(bad.length / 2); k < bad.length; k++) {
    if (bad[k].charAt(0) === 'I') {
      bad[k] = bad[k].replace(/\|([0-9]+)$/, '|9')
      break
    }
  }
  rp = GA.replay(seed, null, bad)
  if (!rp || !rp.rbad) fails.push('seed ' + seed + ' tampered I event not detected')
  bad = sc.all.slice(0)
  bad.splice(Math.floor(bad.length / 3), 1)
  rp = GA.replay(seed, null, bad)
  if (!rp || !rp.rbad) fails.push('seed ' + seed + ' dropped event not detected')
  return { fails: fails, hash: GA.prim.fnv1a(fin), counts: sc.counts, snaps: Math.min(4, sc.snaps.length), tail: best >= 0 }
}

function pneRepRun() {
  var GA = pneRepGA
  var fails = []
  var digest = 0x811c9dc5
  var tot = { B: 0, P: 0, J: 0, I: 0, D: 0, R: 0, G: 0 }
  var snaps = 0
  var tails = 0
  var seed
  var r
  var k
  for (seed = 1; seed <= 24; seed++) {
    r = pneRepCheck(seed * 2654435761 >>> 0, 900 + (seed % 5) * 150)
    fails = fails.concat(r.fails)
    digest = GA.prim.fmix32(digest ^ r.hash)
    for (k in tot) if (tot.hasOwnProperty(k)) tot[k] += r.counts[k]
    snaps += r.snaps
    if (r.tail) tails++
  }
  for (k in tot) if (tot.hasOwnProperty(k) && tot[k] === 0) fails.push('no ' + k + ' event was exercised')
  return (fails.length ? 'FAIL ' + fails.length + ': ' + fails.slice(0, 5).join(' | ') : 'PASS 24 scenarios') +
    ' digest=' + ((digest >>> 0) + 0x100000000).toString(16).substring(1) +
    ' events B' + tot.B + ' P' + tot.P + ' J' + tot.J + ' I' + tot.I + ' D' + tot.D + ' R' + tot.R + ' G' + tot.G +
    ' snapshotReplays=' + snaps + ' tailReplays=' + tails
}

var pneRepResult = pneRepRun()

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { result: pneRepResult }
  if (require.main === module) {
    console.log(pneRepResult)
    process.exitCode = pneRepResult.indexOf('PASS') === 0 ? 0 : 1
  }
}
