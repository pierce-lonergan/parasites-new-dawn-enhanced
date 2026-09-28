// Suite director-diff: the difficulty profiles of contract 1.5 in pne_horror.js and pne_resonance.js (DIRECTOR's part of
// docs/IMPLEMENTATION.md 3.2 / 3.2.1; spec rows 2-9; lead decisions L1 and L5).
//
//  A. Hard is release 1.4 bit for bit (L5): the scripted world of tools/director/diff_world.js on vanilla Hard gives,
//     text for text, the command stream, the director's Pace at every 1 Hz step, pneResPaceOut over its whole grid and
//     pneResPureStep over 8 traces recorded from the 1.4 scripts before editing
//     (tools/director/fixtures/horror_hard_baseline.json, never regenerated). Also through the diff_profile pin on an
//     Easy world, on a hardcore Peaceful world, with the Hard row passed explicitly (pneResPaceOut's P, the pure step's
//     inp.diff 3), and the local Hard copy of pne_horror.js equals the core's Hard row. Two planted one-character
//     mutations (a Hard burst cap, the Hard governor) must break the comparison, so the oracle can see a change.
//  B. Mobs Inside per profile over 4 x 10^5 host kills at CALM (the director's CALM multiplier): burst, flesh-burst and
//     product rates within +-1% (relative) of the row's values, the flesh count range, the cap, Peaceful none at all.
//  C. Reinforcement beckons per profile and stage 0..13: no draw below the row's stage; a draw just under
//     min(cap, c0 + c1 x (stage - stage0)) passes and one at it fails; the cooldown (100 / 200 / 400 ticks).
//  D. Night aggression command strings per profile (Normal's Strength from overworld stage 1; Peaceful issues nothing).
//  E. Doom floors per day: the Hard days on Easy, Normal and Hard (L1), nothing on Peaceful; the rounding of other
//     day factors.
//  F. Director pacing per profile: spawn / aggression / beckon / GA per state and the hourly governor against the spec
//     table, mercy and grace in every profile, the live step following a pause-menu change and the pin, pne_m.
//  G. Start gating (rule 15): no horror or director command before the first tick, nor after a /reload until the next.
//  H. The other profiles in the scripted world: they differ from Hard where the rows differ (Peaceful: no summon, no
//     effect, no doom raise; Easy: Speed within 32 only; Normal: Strength after the first floor) and the doom clock
//     raises the same floors in the same order on Easy, Normal and Hard.
//  I. The module doc, docs/modules/director.md (DIRECTOR's, IMPLEMENTATION.md 2.3): its Difficulty profiles table
//     states the numbers of PNE_CORE_DIFF and the horror doom days, the API it names exists, every suite of
//     tools/suites/director.json has a Tests row, and the director-diff row quotes the fixture's counts. Planted edits
//     (the profile section removed, as in the release 1.4 file; the director-diff row removed; one number changed) must
//     fail it. PNE_DIFF_DOC=<file> checks another copy of the doc.
//
//   node tools/director/test_diff.js          (PNE_TEST_VERBOSE=1 prints every check)
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const D = require('./diff_world.js')
const P = require('./pack.js')

const T0 = P.checker('director-diff')
const VERBOSE = process.env.PNE_TEST_VERBOSE === '1'
const T = {
  ok (c, m) { if (VERBOSE) console.log((c ? '  ok   ' : '  FAIL ') + m); T0.ok(c, m) },
  eq (a, b, m) { if (VERBOSE) console.log((a === b ? '  ok   ' : '  FAIL ') + m + ' (' + JSON.stringify(a) + ')'); T0.eq(a, b, m) },
  done (x) { T0.done(x) }
}
const notes = []
const FIXTURE = path.join(__dirname, 'fixtures', 'horror_hard_baseline.json')
const TMP = process.env.PNE_TMP || path.join(os.tmpdir(), 'pne_tests')
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const unz = (b64) => zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')
const NAMES = ['Peaceful', 'Easy', 'Normal', 'Hard']

// The spec's numbers (difficulty_spec.md A rows 2-9 with lead decision L1), typed here independently of the core table.
const SPEC = {
  night: [null, { r: 32, spd: true, str: false, spore: false }, { r: 48, spd: true, str: true, strStage: 1, spore: true },
    { r: 48, spd: true, str: true, strStage: 0, spore: true }],
  burst: [{ p: 0, flesh: 0, fmin: 0, fspan: 0, cap: 0 }, { p: 0.35, flesh: 0.27, fmin: 1, fspan: 2, cap: 4 },
    { p: 0.50, flesh: 0.38, fmin: 2, fspan: 2, cap: 6 }, { p: 0.65, flesh: 0.5, fmin: 2, fspan: 2, cap: 8 }],
  beckon: [null, { stage: 4, c0: 0.01, c1: 0.005, cap: 0.04, cd: 400 }, { stage: 3, c0: 0.015, c1: 0.0075, cap: 0.06, cd: 200 },
    { stage: 3, c0: 0.02, c1: 0.01, cap: 0.09, cd: 100 }],
  spawn: [[0, 0, 0, 0, 0], [1.00, 0.95, 0.65, 0, 0.10], [1.10, 1.00, 0.75, 0, 0.15], [1.25, 1.10, 0.80, 0, 0.20]],
  aggro: [[0.8, 0.8, 0.8, 0.8, 0.8], [1, 1, 0.9, 0.9, 0.8], [1, 1, 1, 0.9, 0.8], [1, 1, 1, 0.9, 0.8]],
  beck: [[false, false, false, false, false], [true, true, false, false, false], [true, true, false, false, false], [true, true, false, false, false]],
  ga: [[0, 0, 0, 0, 0], [1, 1, 1, 0.5, 0], [1, 1, 1, 0.5, 0], [1, 1, 1, 0.5, 0]],
  gov: [null, { floor: 0.40, slope: 0.25, free: 0 }, { floor: 0.45, slope: 0.20, free: 1 }, { floor: 0.50, slope: 0.15, free: 1 }],
  doomDays: [6, 12, 20, 32, 48, 62, 76, 88, 96, 100],
  doomPts: ['400', '800', '1800', '20000', '200000', '5000000', '25000000', '500000000', '1000000000', '1800000000']
}
const HARD_NIGHT = [
  'execute in minecraft:overworld as @a[distance=0..,gamemode=!spectator,gamemode=!creative,tag=!pne_pace_soft] at @s run effect give @e[type=#pne:hive,distance=..48] minecraft:speed 7 0 true',
  'execute in minecraft:overworld as @a[distance=0..,gamemode=!spectator,gamemode=!creative,tag=!pne_pace_soft] at @s run effect give @e[type=#pne:hive,distance=..48] minecraft:strength 7 0 true',
  'execute in minecraft:overworld as @a[distance=0..,gamemode=!spectator,gamemode=!creative,tag=!pne_pace_soft] at @s run effect give @e[type=#pne:spore_basic,distance=..48] minecraft:speed 7 0 true'
]

// ------------------------------------------------------------------------------------------------ A. Hard = 1.4

function firstDiff (a, b) {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (JSON.stringify(a[i]) !== JSON.stringify(b[i])) return { i, a: a[i], b: b[i] }
  }
  return null
}

function same (what, base, now) {
  const a = JSON.stringify(base)
  const b = JSON.stringify(now)
  const ok = a === b
  let why = ''
  if (!ok) {
    const d = firstDiff(base, now)
    why = d ? ' first difference at ' + d.i + ': baseline ' + JSON.stringify(d.a) + ' | now ' + JSON.stringify(d.b) : ''
  }
  T.ok(ok, what + (ok ? ' (' + base.length + ' entries, sha256 ' + sha(a).slice(0, 12) + ')' : ':' + why))
  return ok
}

const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'))
const BASE = {
  cmds: JSON.parse(unz(fx.cmdsGz)),
  pace: JSON.parse(unz(fx.paceGz)),
  pure: JSON.parse(unz(fx.pureGz)),
  paceOut: fx.paceOut
}
T.ok(sha(JSON.stringify(BASE.cmds)) === fx.sha256.cmds && sha(JSON.stringify(BASE.pace)) === fx.sha256.pace &&
  sha(JSON.stringify(BASE.pure)) === fx.sha256.pure && sha(JSON.stringify(BASE.paceOut)) === fx.sha256.paceOut,
'the baseline fixture is intact (every section matches its recorded SHA-256)')
T.ok(BASE.cmds.length > 10000 && BASE.pace.length >= 3600 && fx.counts.flankPlaced > 0 && fx.counts.beckons > 0,
  'the baseline covers bursts, beckons, flank placements, doom raises, nights, Hive Night and the director (' + BASE.cmds.length + ' commands)')

function hardRun (label, opts) {
  const r = D.run(opts || {})
  same(label + ': the command stream of pne_horror.js and pne_resonance.js is the 1.4 stream', BASE.cmds, r.W.stream)
  same(label + ': the director\'s Pace at every 1 Hz step is the 1.4 Pace', BASE.pace, r.W.pace)
  return r
}
const hard = hardRun('vanilla Hard', {})
T.eq(hard.c.pneCoreDiffId(), 3, 'vanilla Hard: profile 3')
{
  const p1 = D.pacing(hard.c)
  same('pneResPaceOut(state, mercy, grace, deaths) without a row: the 1.4 grid', BASE.paceOut, p1.paceOut)
  same('pneResPureStep without inp.diff (default 3): the 1.4 outputs', BASE.pure, p1.pure)
  const p2 = D.pacing(hard.c, { diff: 3 })
  same('pneResPureStep with inp.diff 3: the 1.4 outputs', BASE.pure, p2.pure)
  const row = hard.c.PNE_CORE_DIFF[3]
  const grid = []
  for (const g of BASE.paceOut) {
    const o = hard.c.pneResPaceOut(g[0], g[1] === 1, g[2] === 1, g[3], row)
    grid.push([g[0], g[1], g[2], g[3], o.spawn, o.aggro, o.beckon ? 1 : 0, o.ga, o.gov])
  }
  same('pneResPaceOut with P = PNE_CORE_DIFF[3] (the Hard row): the 1.4 grid', BASE.paceOut, grid)
}
hardRun('diff_profile 4 (Hard) pinned on a vanilla Easy world', { difficulty: 1, pin: 4 })
hardRun('hardcore on a vanilla Peaceful world', { difficulty: 0, hardcore: true })

// the local Hard copy of pne_horror.js equals the core's Hard row (the fallback without the core is release 1.4)
{
  const c = hard.c
  const core = c.PNE_CORE_DIFF[3]
  const loc = c.PNE_H_DIFF_HARD
  const pick = (r) => JSON.stringify({ night: r.night, burst: r.burst, beckon: r.beckon, doomK: r.doomK })
  T.eq(pick(loc), pick(core), 'PNE_H_DIFF_HARD equals the night, burst, beckon and doomK of PNE_CORE_DIFF[3]')
  T.eq(JSON.stringify({ pace: c.PNE_RES_PACING, gov1h: c.PNE_RES_GOV1H }), JSON.stringify({ pace: core.pace, gov1h: core.gov1h }),
    'PNE_RES_PACING and PNE_RES_GOV1H (the director\'s fallback without the core) equal the pace and gov1h of PNE_CORE_DIFF[3]')
  T.ok(c.pneHDiff() === core, 'with the core loaded pne_horror.js reads the core\'s own row (no copy)')
  const alone = D.load([D.FILES.mocks, D.FILES.horror], 7)
  T.ok(alone.pneHDiff() === alone.PNE_H_DIFF_HARD, 'without the core pneHDiff() is the local Hard copy')
  const srv = alone.__pneMock.server({})
  alone.pneHNightAggression(srv)
  T.eq(JSON.stringify(srv.cmds), JSON.stringify(HARD_NIGHT), 'without the core: the three 1.4 night commands')
}

// the oracle sees a change: two one-character mutations of the scripts must break the comparison
function mutant (file, from, to) {
  const src = fs.readFileSync(path.resolve(D.ROOT, file), 'utf8')
  if (src.indexOf(from) < 0) return null
  fs.mkdirSync(TMP, { recursive: true })
  const out = path.join(TMP, 'director_diff_mutant_' + path.basename(file))
  fs.writeFileSync(out, src.replace(from, to))
  return out
}
{
  const mh = mutant(D.FILES.horror, 'if (nearby >= B.cap) return', 'if (nearby >= B.cap - 1) return')
  const mr = mutant(D.FILES.res, 'Math.max(0, deaths1h - g.free)', 'Math.max(0, deaths1h - g.free - 1)')
  T.ok(mh && mr, 'mutants written to PNE_TMP')
  if (mh) {
    const r = D.run({ files: { horror: mh } })
    T.ok(JSON.stringify(r.W.stream) !== JSON.stringify(BASE.cmds), 'mutant: a burst cap one lower on Hard changes the command stream (the oracle notices)')
    fs.unlinkSync(mh)
  }
  if (mr) {
    const r = D.run({ files: { res: mr } })
    T.ok(JSON.stringify(r.W.pace) !== JSON.stringify(BASE.pace), 'mutant: one more free death in the Hard governor changes the Pace stream (the oracle notices)')
    fs.unlinkSync(mr)
  }
}

// ------------------------------------------------------------------------------------------------ shared unit world

const PRE_EPCA = '__pneMock.classes["org.tdddd.epca.impl.overworld.data.EvolutionManager"] = {' +
  ' getPointsForDimension: function (l) { return __u.points }, getStageForDimension: function (l) { return __u.stage } }'

// A world with the core, the director (test catalog) and pne_horror.js; the profile follows srv.difficulty.
function unit (id, opts) {
  const o = opts || {}
  const U = { points: 0, stage: 0, cmds: [], answer: null }
  const items = [D.FILES.mocks, { name: 'pre.js', code: PRE_EPCA }, D.FILES.core, D.FILES.cat]
  if (!o.noDirector) items.push(D.FILES.res)
  items.push(D.FILES.horror)
  items.push({ name: 'stubs.js', code: 'var __rq = []; var __rnd = Math.random; Math.random = function () { return __rq.length ? __rq.shift() : __rnd() }\n' +
    'function pneOraSnap(p) { return __u.snap ? __u.snap(p, pneCoreTick) : null }' })
  const c = D.load(items, o.seed || 99991, { __u: U })
  const M = c.__pneMock
  const srv = M.server({ difficulty: id })
  srv.level.getDayTime = () => 18000
  srv.runCommandSilent = function (cmd) {
    const s = String(cmd)
    if (!o.quiet) U.cmds.push(s)
    const a = U.answer ? U.answer(s) : undefined
    if (a !== undefined) return a
    if (s === 'time query daytime') return 18000
    return 1
  }
  if (!o.noStart) {
    M.fire('ServerEvents.loaded', { server: srv })
    M.tick(srv, 20)
  }
  return { c, M, srv, U }
}

// ------------------------------------------------------------------------------------------------ B. Mobs Inside

{
  const N = 400000
  const stats = []
  // PNE_TEST_SEED=<n> draws the trials from another seed (the tolerance was checked over a sweep of seeds)
  const seed0 = (Number(process.env.PNE_TEST_SEED) >>> 0) || 4242
  for (let id = 0; id <= 3; id++) {
    const W = unit(id, { quiet: true, seed: seed0 + id })
    const { c, M, srv, U } = W
    // a survival player in CALM with the director's own Pace (a quiet telemetry snapshot), so pneCoreSpawnMultAt is
    // the row's CALM multiplier
    const p = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
    U.snap = (pl, tick) => ({ tick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600, hostileSeen: false })
    M.tick(srv, 60)
    const pace = c.pneResPace(p)
    const m = c.pneCoreSpawnMultAt(srv.level, 3, 64, 3, 48)
    T.ok(pace && pace.state === 'CALM' && pace.diff === id && m === SPEC.spawn[id][0],
      NAMES[id] + ': the player is in CALM with the row\'s CALM multiplier ' + m)
    let bursts = 0
    let flesh = 0
    let products = 0
    let kmin = 99
    let kmax = 0
    let fk = 0
    let summons = 0
    let fleshNow = false
    srv.runCommandSilent = function (cmd) {
      const s = String(cmd)
      if (s.indexOf('summon epca:living_flesh_size0') > 0) { summons++; fleshNow = true; return 1 }
      if (s.indexOf('summon epca:mozzie') > 0) { summons++; return 1 }
      if (s.indexOf('execute if entity') > 0) return 0
      return 1
    }
    const where = { dim: 'minecraft:overworld', x: 3, y: 64.6, z: 3 }
    const at = 'execute in minecraft:overworld positioned 3.00 64.60 3.00 run '
    for (let i = 0; i < N; i++) {
      c.pneHBurstBudget = 2
      summons = 0
      fleshNow = false
      c.pneHMobsInside(srv, at, where, srv.level)
      if (summons > 0) {
        bursts++
        products += summons
        if (fleshNow) {
          flesh++
          fk += summons
          kmin = Math.min(kmin, summons)
          kmax = Math.max(kmax, summons)
        }
      }
    }
    const B = SPEC.burst[id]
    const mu = SPEC.spawn[id][0]
    const expProducts = (B.flesh * (B.fmin + (B.fspan - 1) / 2) + (B.p - B.flesh)) * mu
    const rel = (x, e) => (e === 0 ? (x === 0 ? 0 : Infinity) : Math.abs(x / e - 1))
    const r = { id, burst: bursts / N, flesh: flesh / N, products: products / N, perFlesh: flesh ? fk / flesh : 0, kmin, kmax }
    stats.push(r)
    if (id === 0) {
      T.ok(bursts === 0 && products === 0, 'Peaceful: no Mobs Inside burst in ' + N + ' host kills')
      continue
    }
    T.ok(rel(r.burst, B.p) <= 0.01, NAMES[id] + ': burst rate ' + r.burst.toFixed(5) + ' within 1% of ' + B.p)
    T.ok(rel(r.flesh, B.flesh) <= 0.01, NAMES[id] + ': flesh-burst rate ' + r.flesh.toFixed(5) + ' within 1% of ' + B.flesh)
    T.ok(rel(r.products, expProducts) <= 0.01, NAMES[id] + ': products per host kill at CALM ' + r.products.toFixed(5) +
      ' within 1% of ' + expProducts.toFixed(5))
    // flesh count: fmin .. fmin + fspan - 1 before pacing, then floor(n x m + rand)
    const lo = Math.floor(B.fmin * mu)
    const hi = Math.floor((B.fmin + B.fspan - 1) * mu) + 1
    T.ok(kmin >= lo && kmax <= hi && kmin <= Math.ceil(B.fmin * mu) && kmax >= B.fmin + B.fspan - 1,
      NAMES[id] + ': flesh per flesh burst ' + kmin + '-' + kmax + ' (row ' + B.fmin + '-' + (B.fmin + B.fspan - 1) + ' x ' + mu + ')')
    notes.push(NAMES[id] + ' bursts ' + r.burst.toFixed(4) + ' flesh ' + r.flesh.toFixed(4) + ' products/kill ' + r.products.toFixed(4) +
      ' (expected ' + expProducts.toFixed(4) + ')')
  }
  // spec row 4a: expected products per host kill at CALM 0 / 0.49 / 1.18 / 1.75
  const want = [0, 0.49, 1.18, 1.75]
  T.ok(stats.every((s, i) => Math.abs(s.products - want[i]) <= 0.01), 'products per host kill at CALM match spec row 4a (0, 0.49, 1.18, 1.75) to 0.01: ' +
    stats.map(s => s.products.toFixed(3)).join(', '))
  // the cap: cap - 1 products nearby still bursts, cap does not (queued draws: a flesh roll, then the count and pacing)
  for (let id = 1; id <= 3; id++) {
    const { c, srv } = unit(id, { quiet: true })
    const B = SPEC.burst[id]
    let near = 0
    let summ = 0
    srv.runCommandSilent = function (cmd) {
      const s = String(cmd)
      if (s.indexOf('@e[type=#pne:flesh,distance=..24]') > 0) return near
      if (s.indexOf('summon ') > 0) { summ++; return 1 }
      if (s.indexOf('execute if entity') > 0) return 0
      return 1
    }
    const at = 'execute in minecraft:overworld positioned 0.00 64.00 0.00 run '
    const where = { dim: 'minecraft:overworld', x: 0, y: 64, z: 0 }
    near = B.cap - 1
    c.pneHBurstBudget = 2
    c.__rq.push(0, 0.5, 0.5)
    c.pneHMobsInside(srv, at, where, srv.level)
    const a = summ
    near = B.cap
    summ = 0
    c.pneHBurstBudget = 2
    c.__rq.length = 0
    c.__rq.push(0, 0.5, 0.5)
    c.pneHMobsInside(srv, at, where, srv.level)
    T.ok(a > 0 && summ === 0, NAMES[id] + ': ' + (B.cap - 1) + ' products nearby still burst, ' + B.cap + ' (the cap) stop it')
    c.__rq.length = 0
    // the roll boundary: just under p bursts, p does not
    summ = 0
    near = 0
    c.pneHBurstBudget = 2
    c.__rq.push(B.p - 1e-9, 0.5, 0.5)
    c.pneHMobsInside(srv, at, where, srv.level)
    const under = summ
    summ = 0
    c.pneHBurstBudget = 2
    c.__rq.length = 0
    c.__rq.push(B.p, 0.5, 0.5)
    c.pneHMobsInside(srv, at, where, srv.level)
    T.ok(under > 0 && summ === 0, NAMES[id] + ': roll just under ' + B.p + ' bursts, a roll of ' + B.p + ' does not')
    c.__rq.length = 0
  }
}

// ------------------------------------------------------------------------------------------------ C. beckons

{
  for (let id = 0; id <= 3; id++) {
    const { c, M, srv, U } = unit(id, { quiet: true })
    const B = SPEC.beckon[id]
    const mob = M.mob(srv, 'epca:ripper', { x: 0, y: 64, z: 0 })
    const atG = 'execute in minecraft:overworld positioned 0.00 64.00 0.00 run '
    const where = { dim: 'minecraft:overworld', x: 0, y: 64, z: 0 }
    let bad = []
    for (let s = 0; s <= 13; s++) {
      U.stage = s
      c.pneHStageCache = {}
      c.pneHTick = 100000
      c.pneHBeckonReadyAt = 0
      if (!B || s < B.stage) {
        c.__rq.length = 0
        c.__rq.push(0)
        c.pneHReinforce(srv, mob, 'minecraft:overworld', atG, where)
        if (c.__rq.length !== 1 || c.pneHBeckonReadyAt !== 0) bad.push('stage ' + s + ': a draw was taken below the row\'s stage')
        continue
      }
      const ch = Math.min(B.cap, B.c0 + B.c1 * (s - B.stage))
      c.__rq.length = 0
      c.__rq.push(ch - 1e-12, 0.5)
      c.pneHReinforce(srv, mob, 'minecraft:overworld', atG, where)
      if (c.pneHBeckonReadyAt !== 100000 + B.cd) bad.push('stage ' + s + ': draw just under ' + ch + ' did not pass (cooldown ' + c.pneHBeckonReadyAt + ')')
      c.pneHBeckonReadyAt = 0
      c.__rq.length = 0
      c.__rq.push(ch, 0.5)
      c.pneHReinforce(srv, mob, 'minecraft:overworld', atG, where)
      if (c.pneHBeckonReadyAt !== 0) bad.push('stage ' + s + ': a draw of ' + ch + ' passed')
      c.__rq.length = 0
    }
    T.ok(bad.length === 0, NAMES[id] + ': beckon chance per stage 0-13 ' + (B ? 'from stage ' + B.stage + ', min(' + B.cap + ', ' + B.c0 + ' + ' + B.c1 +
      ' x (stage - ' + B.stage + '))' : 'never (no draw at any stage)') + (bad.length ? ': ' + bad.slice(0, 3).join('; ') : ''))
    if (!B) continue
    // cooldown: a pass at tick T blocks every death until T + cd, then the next one draws again
    U.stage = 10
    c.pneHStageCache = {}
    c.pneHTick = 200000
    c.pneHBeckonReadyAt = 0
    c.__rq.length = 0
    c.__rq.push(0, 0.5)
    c.pneHReinforce(srv, mob, 'minecraft:overworld', atG, where)
    c.pneHTick = 200000 + B.cd - 1
    c.__rq.length = 0
    c.__rq.push(0, 0.5)
    c.pneHReinforce(srv, mob, 'minecraft:overworld', atG, where)
    const blocked = c.__rq.length === 2
    c.pneHTick = 200000 + B.cd
    c.pneHReinforce(srv, mob, 'minecraft:overworld', atG, where)
    T.ok(blocked && c.__rq.length === 0 && c.pneHBeckonReadyAt === 200000 + 2 * B.cd, NAMES[id] + ': cooldown ' + B.cd + ' ticks (blocked at +' + (B.cd - 1) + ', open at +' + B.cd + ')')
    c.__rq.length = 0
  }
  // Easy stage 13 caps at 4%, Normal stage 11 at 6%, Hard stage 10 at 9% (spec row 5)
  T.ok(Math.min(0.04, 0.01 + 0.005 * 9) === 0.04 && Math.min(0.06, 0.015 + 0.0075 * 8) === 0.06, 'spec caps reached (Easy 4% from stage 10, Normal 6% from stage 9)')
}

// ------------------------------------------------------------------------------------------------ D. night commands

{
  const want = [
    [],
    ['execute in minecraft:overworld as @a[distance=0..,gamemode=!spectator,gamemode=!creative,tag=!pne_pace_soft] at @s run effect give @e[type=#pne:hive,distance=..32] minecraft:speed 7 0 true'],
    [HARD_NIGHT[0], HARD_NIGHT[2]],
    HARD_NIGHT
  ]
  for (let id = 0; id <= 3; id++) {
    const { c, srv, U } = unit(id)
    U.points = 0
    U.stage = 0
    c.pneHStageCache = {}
    U.cmds.length = 0
    c.pneHNightAggression(srv)
    T.eq(JSON.stringify(U.cmds), JSON.stringify(want[id]), NAMES[id] + ': night commands at overworld stage 0')
    U.stage = 1
    c.pneHStageCache = {}
    U.cmds.length = 0
    c.pneHNightAggression(srv)
    T.eq(JSON.stringify(U.cmds), JSON.stringify(id === 2 ? HARD_NIGHT : want[id]), NAMES[id] + ': night commands at overworld stage 1' +
      (id === 2 ? ' (Strength from the first Hive Night floor)' : ''))
    // a whole night of ticks: Peaceful issues no night query and no effect at all
    U.cmds.length = 0
    c.__pneMock.tick(srv, 400)
    const q = U.cmds.filter(x => x === 'time query daytime').length
    const eff = U.cmds.filter(x => x.indexOf(' effect give ') > 0).length
    T.ok(id === 0 ? q === 0 && eff === 0 : q === 4 && eff === 4 * (id === 2 ? 3 : want[id].length),
      NAMES[id] + ': 20 s of night: ' + q + ' time queries, ' + eff + ' effect commands')
    T.eq(c.pneHNightOn(), id !== 0, NAMES[id] + ': pneHNightOn')
  }
}

// ------------------------------------------------------------------------------------------------ E. doom floors

{
  const expect = (day, k) => {
    let f = '0'
    if (!(k > 0)) return f
    for (let i = 0; i < SPEC.doomDays.length; i++) if (day >= Math.round(SPEC.doomDays[i] * k)) f = SPEC.doomPts[i]
    return f
  }
  for (let id = 0; id <= 3; id++) {
    const { c, srv, U } = unit(id)
    const k = id === 0 ? 0 : 1
    let bad = 0
    for (let day = 0; day <= 200; day++) if (c.pneHFloorForDay(day) !== expect(day, k)) bad++
    T.ok(bad === 0 && c.pneHDoomK() === k, NAMES[id] + ': doom floors per day 0-200 ' + (k ? 'on the Hard days (L1)' : 'all 0 (no raises)') + ', doomK ' + c.pneHDoomK())
    U.cmds.length = 0
    U.answer = (s) => (s === 'time query day' ? 50 : undefined)
    srv.persistentData.putInt('pne_doom_floor', 0)
    c.pneHDoomClock(srv)
    const sp = U.cmds.filter(x => x.indexOf('epca_evolution setpoints') === 0)
    T.ok(id === 0 ? U.cmds.length === 0 : (sp.length === 1 && sp[0] === 'epca_evolution setpoints 200000 minecraft:overworld'),
      NAMES[id] + ': the doom clock on day 50 ' + (id === 0 ? 'issues no command' : 'raises to the day-48 floor (200000)'))
    U.answer = null
  }
  // the day factor itself: the pre-L1 spec's Easy (1.5) and Normal (1.25) days, to prove the rounding
  const { c } = unit(3)
  const daysFor = (k) => SPEC.doomPts.map(pt => { for (let d = 0; d < 400; d++) if (c.pneHFloorForDay(d, k) === pt) return d; return -1 })
  T.eq(daysFor(1.5).join(','), '9,18,30,48,72,93,114,132,144,150', 'day factor 1.5: round(day x k) gives 9, 18, 30, 48, 72, 93, 114, 132, 144, 150')
  T.eq(daysFor(1.25).join(','), '8,15,25,40,60,78,95,110,120,125', 'day factor 1.25: 8, 15, 25, 40, 60, 78, 95, 110, 120, 125')
  T.eq(daysFor(1).join(','), SPEC.doomDays.join(','), 'day factor 1: the 1.4 days')
}

// ------------------------------------------------------------------------------------------------ F. director pacing

{
  const { c } = unit(3)
  const bad = []
  for (let id = 0; id <= 3; id++) {
    const row = c.PNE_CORE_DIFF[id]
    for (let si = 0; si < 5; si++) {
      const st = D.STATES[si]
      for (let d = 0; d <= 10; d++) {
        for (const vul of [0, 1, 2]) {
          const o = c.pneResPaceOut(st, vul === 1, vul === 2, d, row)
          const G = SPEC.gov[id]
          const gov = G ? Math.max(G.floor, Math.min(1, 1 - G.slope * Math.max(0, d - G.free))) : 1
          const soft = vul > 0
          const wantSpawn = (soft ? 0 : SPEC.spawn[id][si]) * gov
          const wantAggro = soft ? Math.min(SPEC.aggro[id][si], 0.8) : SPEC.aggro[id][si]
          const w = [wantSpawn, wantAggro, soft ? false : SPEC.beck[id][si], soft ? 0 : SPEC.ga[id][si], gov]
          const g = [o.spawn, o.aggro, o.beckon, o.ga, o.gov]
          if (JSON.stringify(w) !== JSON.stringify(g)) bad.push(NAMES[id] + ' ' + st + ' d' + d + ' v' + vul + ': ' + JSON.stringify(g) + ' want ' + JSON.stringify(w))
        }
      }
    }
    // the pure step with inp.diff uses that row
    const s1 = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
    const o = c.pneResPureStep(s1, { eo: 0, conf: 0.9, fresh: true, sh: 0, theta: 0, nearest: 32, tsd: 600, pflee: 0, mercy: false, grace: false, deaths1h: 3, diff: id })
    const G = SPEC.gov[id]
    const gov = G ? Math.max(G.floor, Math.min(1, 1 - G.slope * Math.max(0, 3 - G.free))) : 1
    T.ok(o.state === 'CALM' && o.spawn === SPEC.spawn[id][0] * gov && o.gov === gov, NAMES[id] + ': pneResPureStep with inp.diff ' + id +
      ' uses its row (CALM spawn ' + o.spawn + ', governor ' + gov + ' at 3 deaths)')
  }
  T.ok(bad.length === 0, 'pneResPaceOut per profile, state, 0-10 hourly deaths, mercy and grace equals the spec table (rows 7-9)' +
    (bad.length ? ': ' + bad.slice(0, 3).join(' | ') : ''))
  // spec row 9 worked values: Easy at 1 death 0.75, Normal at 2 deaths 0.80, Hard at 2 deaths 0.85; floors
  const gv = (id, d) => c.pneResPaceOut('CALM', false, false, d, c.PNE_CORE_DIFF[id]).gov
  T.ok(gv(1, 1) === 0.75 && gv(1, 9) === 0.4 && gv(2, 2) === 0.8 && gv(2, 9) === 0.45 && gv(3, 2) === 0.85 && gv(3, 9) === 0.5 && gv(0, 9) === 1,
    'hourly governor: Easy 0.75 at 1 death (floor 0.40), Normal 0.80 at 2 (floor 0.45), Hard 0.85 at 2 (floor 0.50), Peaceful 1')
  T.ok(c.pneResDiffIn(undefined) === 3 && c.pneResDiffIn(null) === 3 && c.pneResDiffIn(7) === 3 && c.pneResDiffIn(-1) === 3 && c.pneResDiffIn(1) === 1 &&
    c.pneResDiffIn(new Number(2)) === 2, 'inp.diff: absent, invalid or out of range is 3; a wrapped number converts') // eslint-disable-line no-new-wrappers
}
{
  // the live step: the Pace follows the profile within one second of a pause-menu change and the pin; pne_m and pne_gate
  const { c, M, srv, U } = unit(3)
  const p = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  U.snap = (pl, tick) => ({ tick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600, hostileSeen: false })
  M.tick(srv, 40)
  const look = () => { const r = c.pneResPace(p); return r ? [r.diff, r.state, r.spawn, r.beckon] : null }
  T.eq(JSON.stringify(look()), JSON.stringify([3, 'CALM', 1.25, true]), 'live Pace on vanilla Hard: CALM spawn 1.25')
  srv.difficulty = 1
  M.tick(srv, 40)
  T.eq(JSON.stringify(look()), JSON.stringify([1, 'CALM', 1, true]), 'pause menu to Easy: the next steps use the Easy row (CALM spawn 1.00)')
  T.ok(Number(p.getPersistentData().getDouble('pne_m')) === 1 && !c.pneCoreHasTag(p, 'pne_gate'), 'Easy CALM: pne_m 1, no natural-spawn gate')
  srv.difficulty = 0
  M.tick(srv, 40)
  T.eq(JSON.stringify(look()), JSON.stringify([0, 'CALM', 0, false]), 'pause menu to Peaceful: spawn 0, no beckons')
  T.ok(Number(p.getPersistentData().getDouble('pne_m')) === 0 && c.pneCoreHasTag(p, 'pne_gate') && c.pneCoreHasTag(p, 'pne_pace_soft'),
    'Peaceful: pne_m 0 with pne_gate (natural parasite spawns denied near the player), pne_pace_soft (no night buff near them)')
  c.pneCoreCfgSet(srv, 'diff_profile', 3)
  M.tick(srv, 40)
  T.eq(JSON.stringify(look()), JSON.stringify([2, 'CALM', 1.1, true]), '/pne config diff_profile 3 pins Normal on a Peaceful world (CALM spawn 1.10)')
}

// ------------------------------------------------------------------------------------------------ G. start gating

{
  const W = unit(3, { noStart: true })
  const { c, M, srv, U } = W
  M.fire('ServerEvents.loaded', { server: srv })
  const p = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const kz = M.mob(srv, 'epca:infested_zombie', { x: 30, y: 64, z: 0 })
  const fire = () => {
    M.fire('EntityEvents.death', { entity: M.mob(srv, 'epca:infested_zombie', { x: 30, y: 64, z: 0 }), source: M.damage('mob', p) })
    const ev = { entity: p, source: M.damage('mob', kz) }
    M.fire('EntityEvents.death:minecraft:player', ev)
    M.fire('EntityEvents.death', ev)
  }
  U.cmds.length = 0
  fire()
  T.eq(U.cmds.length, 0, 'before the first tick: a parasite death and a player killed by a parasite issue no command')
  T.ok(c.pneResEmit(p, 'epca:slam', 'hostile', '~ ~ ~', 1, { src: 'horror' }) === false && c.pneResTellraw(srv, 'x', 'hi') === false &&
    c.pneResShowNotice(srv, p) === false && U.cmds.length === 0, 'before the first tick: the ledger refuses and tellraw is not issued')
  M.tick(srv, 1)
  U.cmds.length = 0
  fire()
  T.ok(U.cmds.some(x => x.indexOf('particle minecraft:block') > 0) && U.cmds.some(x => x.indexOf('tellraw @a ') === 0),
    'after the first tick: gore and the death line run (' + U.cmds.length + ' commands)')
  T.ok(c.pneResTellraw(srv, 'x', 'hi') === true, 'after the first tick: pneResTellraw issues and says so')
  // /reload: loaded again, nothing until the next tick
  M.fire('ServerEvents.loaded', { server: srv })
  U.cmds.length = 0
  fire()
  T.eq(U.cmds.length, 0, 'after /reload (loaded) and before the next tick: no command')
  // a login notice queued before the start is shown once it can be, and only then marked as seen
  const q = M.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: 0, y: 64, z: 0 })
  M.fire('PlayerEvents.loggedIn', { player: q })
  M.tick(srv, 100)
  const told = U.cmds.filter(x => x.indexOf('tellraw bbbb0000') === 0 && x.indexOf('[PNE] Difficulty') < 0)
  T.ok(told.length === 5 && Number(q.getPersistentData().getInt('pne_notice_v')) === 1, 'the first-run notice goes out after the start (5 lines) and is then remembered')
}

// ------------------------------------------------------------------------------------------------ H. the other profiles

{
  const runs = [0, 1, 2].map(id => D.run({ difficulty: id }))
  const setp = (r) => r.W.stream.filter(x => x.indexOf('epca_evolution setpoints') === 0)
  const hardSet = setp(hard)
  for (let id = 0; id <= 2; id++) {
    const r = runs[id]
    const s = r.W.stream
    T.ok(JSON.stringify(s) !== JSON.stringify(BASE.cmds), NAMES[id] + ' world: the stream differs from Hard (' + s.length + ' commands)')
    const summ = s.filter(x => / run summon epca:(living_flesh_size0|mozzie|stage_i_beckon) /.test(x) || / run execute .* run summon epca:stage_i_beckon /.test(x))
    const eff = s.filter(x => x.indexOf(' effect give ') > 0)
    const pace = r.W.pace
    if (id === 0) {
      T.ok(summ.length === 0 && eff.length === 0 && setp(r).length === 0 && s.indexOf('time query day') < 0 && s.indexOf('time query daytime') < 0,
        'Peaceful world: no burst, no beckon, no night buff, no doom query or raise')
      T.ok(pace.every(x => x[3] === 0 && x[5] === 0 && x[6] === 0), 'Peaceful world: every Pace has spawn 0, no beckons, GA 0')
      T.ok(s.some(x => x.indexOf('particle minecraft:block') > 0) && s.some(x => x.indexOf('run playsound epca:slam') > 0),
        'Peaceful world: the atmosphere stays (gore, the slam)')
      continue
    }
    T.eq(JSON.stringify(setp(r)), JSON.stringify(hardSet), NAMES[id] + ' world: the doom clock raises the same floors in the same order as Hard (L1, ' + hardSet.length + ' raises)')
    if (id === 1) {
      T.ok(eff.length > 0 && eff.every(x => /effect give @e\[type=#pne:hive,distance=\.\.32\] minecraft:speed 7 0 true$/.test(x)),
        'Easy world: the only night buff is Speed I on EPCA within 32 (' + eff.length + ')')
    } else {
      const firstStr = s.findIndex(x => x.indexOf('minecraft:strength') > 0)
      const firstFloor = s.findIndex(x => x.indexOf('epca_evolution setpoints ') === 0)
      T.ok(firstStr > firstFloor && firstFloor >= 0 && eff.some(x => x.indexOf('#pne:spore_basic,distance=..48') > 0),
        'Normal world: Strength only after the first doom floor (' + firstFloor + ' < ' + firstStr + '), Spore Speed within 48')
    }
    const calm = pace.filter(x => x[2] === 0 && x[7] === 1)
    const w = SPEC.spawn[id][0]
    T.ok(calm.length > 0 && calm.every(x => x[3] === w || x[3] === 0), NAMES[id] + ' world: CALM Pace spawn ' + w + ' (0 under mercy or grace)')
    const bursts = (st) => st.filter(x => / run summon epca:(living_flesh_size0|mozzie) /.test(x)).length
    notes.push(NAMES[id] + ' world: ' + bursts(s) + ' burst products (Hard ' + bursts(BASE.cmds) + ')')
    T.ok(bursts(s) < bursts(BASE.cmds), NAMES[id] + ' world: fewer burst products than Hard (' + bursts(s) + ' < ' + bursts(BASE.cmds) + ')')
  }
}

// ------------------------------------------------------------------------------------------------ I. the module doc

// The problems of one copy of docs/modules/director.md against the loaded scripts (c), the suite registry and the
// fixture: [] when the doc states what the code does. Pure (no T calls), so planted edits can be checked with it.
function docProblems (text, c, suites) {
  const bad = []
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const section = (title) => {
    const i = lines.findIndex(l => l.indexOf('## ' + title) === 0)
    if (i < 0) return null
    let j = i + 1
    while (j < lines.length && lines[j].indexOf('## ') !== 0) j++
    return lines.slice(i + 1, j)
  }
  const cells = (l) => l.split('|').slice(1, -1).map(x => x.trim())
  const nums = (s) => s.split('/').map(x => Number(x.trim()))
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-12
  const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  // 1. the Tests table: one row per registered suite, and the director-diff row quotes the fixture
  const tests = section('Tests')
  if (!tests) bad.push('no "## Tests" section')
  const named = new Set()
  let diffRow = null
  for (const l of tests || []) {
    if (l.indexOf('| `') !== 0) continue
    const first = cells(l)[0] || ''
    for (const m of first.match(/`[^`]+`/g) || []) named.add(m.slice(1, -1))
    if (/`director-diff`/.test(first)) diffRow = l
  }
  for (const s of suites) if (!named.has(s)) bad.push('Tests table: no row for the suite ' + s)
  if (diffRow) {
    for (const want of [fmt(BASE.cmds.length) + ' commands', '(' + fmt(BASE.pace.length) + ')', 'tools/director/fixtures/horror_hard_baseline.json']) {
      if (diffRow.indexOf(want) < 0) bad.push('director-diff row: does not quote "' + want + '"')
    }
  }

  // 2. the Difficulty profiles section and its table, cell by cell against the core's rows
  const sec = section('Difficulty profiles (contract 1.5)')
  if (!sec) {
    bad.push('no "## Difficulty profiles (contract 1.5)" section')
    return bad
  }
  const body = sec.join('\n')
  for (const api of ['`pneResPaceOut(state, mercy, grace, deaths1h, P)`', '`inp.diff`', '`pneResDiffIn`', '`Pace.diff`', '`pneHDiff()`',
    '`PNE_H_DIFF_HARD`', '`PNE_RES_GOV1H`', '`pneCoreStarted`', '`not_started`', '`PNE_CORE_DIFF`']) {
    if (body.indexOf(api) < 0) bad.push('profiles section: does not name ' + api)
  }
  if (typeof c.pneResPaceOut !== 'function' || c.pneResPaceOut.length !== 5) bad.push('code: pneResPaceOut does not take 5 arguments')
  for (const f of ['pneResDiffIn', 'pneResDiffRow', 'pneResDiffNow', 'pneResStarted', 'pneHDiff', 'pneHDoomK', 'pneHNightOn']) {
    if (typeof c[f] !== 'function') bad.push('code: no function ' + f)
  }
  const rows = {}
  for (const l of sec) {
    if (l.indexOf('| ') !== 0 || l.indexOf('| ---') === 0) continue
    const x = cells(l)
    if (x.length === 5) rows[x[0]] = x.slice(1)
  }
  const row = (prefix) => {
    const k = Object.keys(rows).find(r => r.indexOf(prefix) === 0)
    if (!k) bad.push('profiles table: no row "' + prefix + '..."')
    return k ? rows[k] : null
  }
  const R = c.PNE_CORE_DIFF
  const S = D.STATES
  const cell = (what, id, ok) => { if (!ok) bad.push('profiles table, ' + what + ', ' + NAMES[id] + ': the cell does not match PNE_CORE_DIFF[' + id + ']') }

  let r = row('Director spawn')
  if (r) {
    for (let id = 0; id <= 3; id++) {
      const want = S.map(s => R[id].pace[s].spawn)
      const got = /everywhere/.test(r[id]) ? S.map(() => Number(r[id].split(' ')[0])) : nums(r[id])
      cell('spawn', id, got.length === 5 && got.every((v, i) => near(v, want[i])))
    }
  }
  r = row('Aggression, beckons, GA')
  if (r) {
    const parseFull = (s) => {
      const g = s.split(';').map(x => x.trim().split(/\s+/))
      if (g.length !== 3) return null
      return { aggro: g[0].map(Number), beckon: g[1].map(v => v === 'on'), ga: g[2].map(Number) }
    }
    const hard = parseFull(r[3])
    for (let id = 0; id <= 3; id++) {
      let v = null
      const m = /^([\d.]+), none, ([\d.]+)$/.exec(r[id])
      if (m) v = { aggro: S.map(() => Number(m[1])), beckon: S.map(() => false), ga: S.map(() => Number(m[2])) }
      else if (r[id].indexOf('as Hard') === 0 && hard) {
        v = JSON.parse(JSON.stringify(hard))
        let o
        const re = /(CALM|UNEASE|DREAD|PANIC|RELEASE) aggression ([\d.]+)/g
        while ((o = re.exec(r[id])) !== null) v.aggro[S.indexOf(o[1])] = Number(o[2])
      } else v = parseFull(r[id])
      cell('aggression / beckons / GA', id, v && S.every((s, i) => near(v.aggro[i], R[id].pace[s].aggro) && v.beckon[i] === R[id].pace[s].beckon &&
        near(v.ga[i], R[id].pace[s].ga)))
    }
  }
  r = row('Hourly governor')
  if (r) {
    for (let id = 0; id <= 3; id++) {
      if (/^none/.test(r[id])) {
        let one = true
        for (let d = 0; d <= 20; d++) if (c.pneResPaceOut('CALM', false, false, d, R[id]).gov !== 1) one = false
        cell('governor', id, one)
      } else {
        const g = nums(r[id])
        cell('governor', id, g.length === 3 && near(g[0], R[id].gov1h.floor) && near(g[1], R[id].gov1h.slope) && near(g[2], R[id].gov1h.free))
      }
    }
  }
  r = row('Night buffs')
  if (r) {
    for (let id = 0; id <= 3; id++) {
      const N = R[id].night
      const s = r[id]
      if (s === 'none') { cell('night buffs', id, !(N.r > 0) || !(N.spd || N.str || N.spore)); continue }
      const within = (s.match(/within (\d+)/g) || []).map(x => Number(x.slice(7)))
      const st = /from overworld stage (\d+)/.exec(s)
      cell('night buffs', id, within.length > 0 && within.every(v => v === N.r) && /Speed I\b/.test(s) === N.spd && /Strength I\b/.test(s) === N.str &&
        /Spore basic/.test(s) === N.spore && (st ? Number(st[1]) : 0) === N.strStage)
    }
  }
  r = row('Mobs Inside')
  if (r) {
    for (let id = 0; id <= 3; id++) {
      const B = R[id].burst
      if (r[id] === 'none') { cell('Mobs Inside', id, B.p === 0); continue }
      const m = /^(\d+)% \/ (\d+)% \/ (\d+)-(\d+) \/ (\d+)$/.exec(r[id])
      cell('Mobs Inside', id, m && near(Number(m[1]) / 100, B.p) && near(Number(m[2]) / 100, B.flesh) && Number(m[3]) === B.fmin &&
        Number(m[4]) === B.fmin + B.fspan - 1 && Number(m[5]) === B.cap)
    }
  }
  r = row('Reinforcement beckon')
  if (r) {
    for (let id = 0; id <= 3; id++) {
      const B = R[id].beckon
      if (r[id] === 'never') { cell('beckon', id, !(B.stage <= 13 && B.cap > 0)); continue }
      const m = /^(\d+), ([\d.]+)% \+ ([\d.]+)%(?: per stage)?, ([\d.]+)%, (\d+) t$/.exec(r[id])
      cell('beckon', id, m && Number(m[1]) === B.stage && near(Number(m[2]) / 100, B.c0) && near(Number(m[3]) / 100, B.c1) &&
        near(Number(m[4]) / 100, B.cap) && Number(m[5]) === B.cd)
    }
  }
  r = row('Doom clock')
  if (r) {
    const days = c.PNE_H_DOOM.map(x => Number(x[0]))
    const hardDays = r[3].split(',').map(x => Number(x.trim()))
    for (let id = 0; id <= 3; id++) {
      const k = R[id].doomK
      if (/^no raises/.test(r[id])) cell('doom clock', id, !(k > 0))
      else if (r[id] === 'the Hard days') cell('doom clock', id, k === R[3].doomK && k === 1)
      else cell('doom clock', id, k === 1 && JSON.stringify(hardDays) === JSON.stringify(days) && JSON.stringify(days) === JSON.stringify(SPEC.doomDays))
    }
  }
  return bad
}

{
  const DOC = process.env.PNE_DIFF_DOC ? path.resolve(process.env.PNE_DIFF_DOC) : path.join(D.ROOT, 'docs', 'modules', 'director.md')
  const reg = JSON.parse(fs.readFileSync(path.join(D.ROOT, 'tools', 'suites', 'director.json'), 'utf8'))
  const suites = reg.suites.map(s => s.name)
  const c = hard.c
  let text = null
  try { text = fs.readFileSync(DOC, 'utf8') } catch (e) { text = null }
  T.ok(text !== null, 'module doc readable: ' + path.relative(D.ROOT, DOC))
  const probs = text === null ? ['unreadable'] : docProblems(text, c, suites)
  T.ok(probs.length === 0, 'docs/modules/director.md states contract 1.5 as the code does (profile table = PNE_CORE_DIFF, ' + suites.length +
    ' suites listed, the director-diff row quotes the fixture)' + (probs.length ? ': ' + probs.slice(0, 6).join(' | ') : ''))
  if (text !== null && probs.length === 0) {
    // the check bites: planted edits of the doc must each be reported
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    const i0 = lines.findIndex(l => l.indexOf('## Difficulty profiles') === 0)
    let i1 = i0 + 1
    while (i1 < lines.length && lines[i1].indexOf('## ') !== 0) i1++
    const noSection = lines.slice(0, i0).concat(lines.slice(i1)).join('\n')
    const noRow = lines.filter(l => l.indexOf('| `director-diff` |') !== 0).join('\n')
    const easySpawn = text.replace('| 1.00 / 0.95 / 0.65 / 0 / 0.10 |', '| 1.00 / 0.95 / 0.75 / 0 / 0.10 |')
    const hardNight = text.replace('Speed I (EPCA, Spore basic) + Strength I (EPCA) within 48 |', 'Speed I + Strength I (EPCA) within 48 |')
    const plant = [['the profile section removed (as in the release 1.4 file)', noSection], ['the director-diff Tests row removed', noRow],
      ['Easy DREAD spawn 0.75 instead of 0.65', easySpawn], ['the Hard night cell without the Spore basic Speed', hardNight]]
    for (const [what, t] of plant) {
      T.ok(t !== text && docProblems(t, c, suites).length > 0, 'doc check catches a planted edit: ' + what)
    }
  }
}

console.log(notes.map(n => '  ' + n).join('\n'))
T.done()
