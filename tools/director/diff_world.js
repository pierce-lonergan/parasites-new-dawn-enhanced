// The scripted world behind suite director-diff (contract 1.5, lead decision L5: Hard stays bit-for-bit release 1.4).
//
// run(opts) loads the KubeJS mocks, a core, a catalog, pne_resonance.js and pne_horror.js into ONE Node vm context
// (one script pack, like tools/director/pack.js) under a seeded Math.random, drives 20 minutes of play on the mocks
// and returns what pne_horror.js and pne_resonance.js did:
//   cmds     every command whose call stack passes through pne_horror.js or pne_resonance.js, in order (commands the
//            core issues on its own, such as the 1.5 login line or the EPCA sync, are not part of this stream; the
//            core's emit, tellraw and seed calls made for these two files are);
//   pace     the director's Pace after every 1 Hz step, per player;
//   paceOut  pneResPaceOut over every state x mercy x grace x hourly-death count 0..12;
//   pure     pneResPureStep over 8 synthetic traces of 300 steps (director-node's trace generator).
// The world answers every command itself, from its own state (no Math.random draw): the EPCA points and stage
// (/epca_evolution setpoints and a mock EvolutionManager), the day and the time of day, the Hive Night tags and the
// horde age score, the Mobs Inside products near a spot (they expire), the reinforcement execute chain evaluated as
// written (players within 64 / 24, the horde within 128, beckons within 32, open air over natural ground) with and
// without its summon, the director's probe bands for the one player without a telemetry snapshot, and 1 for the rest.
// Three survival players: Host (comfort off) and Bob get telemetry snapshots that walk through calm, approach, fight
// (damage, a hard trigger, mercy), flee and lull; Cara, far away, is sensed by the director's own probes. Parasites of
// every kind die around them every 17 ticks (hosts, non-hosts, Spore, flesh, beckons, burst products, /kill and void
// cleanups, some in the air, some with an expressed FLK); players die to parasites and respawn; Bob joins a Hive Night
// horde; the day counter runs from day 0 to day 110 so the doom clock raises every floor.
//
// The same run is used by tools/director/record_hard_baseline.js (once, from the pre-edit 1.4 scripts) and by
// tools/director/test_diff.js (every run, from the scripts in the tree). ES2017, Node only.
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..', '..')
const FILES = {
  mocks: 'tools/tests/kjs_mocks.js',
  core: 'overrides/kubejs/server_scripts/pne_00_core.js',
  cat: 'tools/director/fixtures/test_catalog.js',
  res: 'overrides/kubejs/server_scripts/pne_resonance.js',
  horror: 'overrides/kubejs/server_scripts/pne_horror.js'
}
const TICKS = 24000
const DEATH_EVERY = 17
const SEED = 20260928
const STATES = ['CALM', 'UNEASE', 'DREAD', 'PANIC', 'RELEASE']
const TIERS = ['QUIET', 'UNEASE', 'DREAD']
// EPCA stage thresholds (EvolutionManager.STAGE_THRESHOLDS, as pne_horror.js lists them)
const STAGE_PTS = [[1800000000, 10], [1000000000, 9], [500000000, 8], [25000000, 7], [5000000, 6], [200000, 5], [20000, 4],
  [1800, 3], [800, 2], [400, 1]]

function stageOf (points) {
  for (const [p, s] of STAGE_PTS) if (points >= p) return s
  return 0
}

function makeGlobal () {
  const store = Object.create(null)
  return new Proxy(store, {
    get (t, k) {
      if (typeof k !== 'string' || !(k in t)) return undefined
      const v = t[k]
      if (typeof v === 'number') return new Number(v) // eslint-disable-line no-new-wrappers
      if (typeof v === 'string') return new String(v) // eslint-disable-line no-new-wrappers
      return v
    },
    set (t, k, v) { t[k] = v; return true },
    has (t, k) { return k in t },
    deleteProperty (t, k) { delete t[k]; return true }
  })
}

// xorshift32, the generator of tools/director/pack.js
function xs (seed) {
  let s = (seed >>> 0) || 1
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
}

// items: file paths (relative to the repo root, or absolute) or { name, code }
function load (items, seed, sandboxExtra) {
  const logs = []
  const quiet = {
    info: (m) => logs.push('[info] ' + m), warn: (m) => logs.push('[warn] ' + m), error: (m) => logs.push('[error] ' + m),
    log: (m) => logs.push('[log] ' + m), debug: () => {}
  }
  const ctx = vm.createContext(Object.assign({ global: makeGlobal(), console: quiet }, sandboxExtra || {}))
  vm.runInContext('(function () { var s = ' + ((seed >>> 0) || 1) + '; Math.random = function () { s ^= s << 13; s >>>= 0; ' +
    's ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } })()', ctx)
  for (const it of items) {
    if (typeof it === 'string') {
      const f = path.isAbsolute(it) ? it : path.resolve(ROOT, it)
      vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: path.basename(f) })
    } else {
      vm.runInContext(it.code, ctx, { filename: it.name })
    }
  }
  ctx.__logs = logs
  return ctx
}

// Stubs in the script scope: EPCA's EvolutionManager (before pne_horror.js loads it), the HIVE HiveInfo (flk only) and
// the ORACLE telemetry snapshot, all answered by the Node-side world __dw.
const PRE_EPCA = '__pneMock.classes["org.tdddd.epca.impl.overworld.data.EvolutionManager"] = {' +
  ' getPointsForDimension: function (l) { return __dw.points(l) }, getStageForDimension: function (l) { return __dw.stage(l) } }'
const POST_STUBS = 'function pneHiveInfo(e) { return __dw.hiveInfo(e) }\n' +
  'function pneOraSnap(p) { return __dw.snap(p, pneCoreTick) }\n'

function run (opts) {
  const o = opts || {}
  const files = Object.assign({}, FILES, o.files || {})
  const W = { points: 0, cmds: [], stream: [], pace: [], products: [], beckons: [], age: {}, tick: 0, deaths: 0 }
  const dw = {
    points: () => W.points,
    stage: () => stageOf(W.points),
    hiveInfo: (e) => (e && e.flk !== undefined ? { g: '0'.repeat(56), clade: 0, sil: false, apex: false,
      e: [0, 0, 0, 0, e.flk, 0, 0, 0, 0, 0, 0, 0, 0, 0], strain: 'epca', flk: e.flk } : null),
    snap: (p, tick) => W.snap(p, tick)
  }
  const c = load([files.mocks, { name: 'diff_pre.js', code: PRE_EPCA }, files.core, files.cat, files.res, files.horror,
    { name: 'diff_stubs.js', code: POST_STUBS }], o.seed || SEED, { __dw: dw })
  const M = c.__pneMock
  const srv = M.server({ owner: 'Host', difficulty: o.difficulty === undefined ? 3 : o.difficulty, hardcore: o.hardcore === true })
  W.srv = srv
  const dayTime = () => (srv.gameTime * 4 + 6000) % 24000
  srv.level.getDayTime = dayTime
  // flat grass at 63 everywhere; block light 3 on every third column, else 10
  srv.level.getBlock = function (x, y, z) {
    const solid = y <= 63
    const bx = Math.floor(x)
    const bz = Math.floor(z)
    return {
      getBlockState: () => ({ isSolid: () => solid, isAir: () => !solid }),
      getBlockLight: () => (((bx + bz) % 3 + 3) % 3 === 0 ? 3 : 10),
      hasTag: (t) => solid && (String(t) === 'pne:beckon_ground')
    }
  }
  const players = []
  const survivors = () => players.filter(p => !p.spectator && !p.creative)
  const dist = (a, x, y, z) => Math.hypot(a.x - x, a.y - y, a.z - z)
  const tagged = (p, t) => p.tagSet[t] === true

  // telemetry for players 0 and 1; player 2 is probed
  function phase (i, t) {
    const u = (t + i * 2600) % 6000
    if (u < 1800) return { k: 'calm', near: 32, n16: 0 }
    if (u < 2800) return { k: 'approach', near: Math.max(6, 32 - (u - 1800) / 38), n16: u > 2400 ? 2 : 0 }
    if (u < 3500) return { k: 'fight', near: 2 + ((u / 20) % 3), n16: 5 }
    if (u < 4100) return { k: 'flee', near: 7 + ((u / 40) % 3), n16: 3 }
    return { k: 'lull', near: 20, n16: 0 }
  }
  W.snap = function (p, tick) {
    const i = players.indexOf(p)
    if (i < 0 || i > 1) return null
    const ph = phase(i, srv.tickCount)
    return { tick: tick, nearest: ph.near, n16: ph.n16, light: ph.k === 'fight' ? 4 : 11, hp: p.hp / p.maxHp,
      tSinceDmg: ph.k === 'fight' ? ((srv.tickCount / 20) % 3) : 400, hostileSeen: ph.k === 'fight' || ph.k === 'flee' }
  }

  function chainOk (x, y, z, summon) {
    const ps = players.filter(p => !p.removed)
    if (!ps.some(p => !p.spectator && !p.creative && dist(p, x, y, z) <= 64)) return 0
    if (ps.some(p => dist(p, x, y, z) <= 24)) return 0
    if (ps.some(p => tagged(p, 'pne_horde') && dist(p, x, y, z) <= 128)) return 0
    if (W.beckons.some(b => b.until > srv.tickCount && Math.hypot(b.x - x, b.y - y, b.z - z) <= 32)) return 0
    if (!(Math.floor(y) >= 64 && Math.floor(y) - 1 <= 63)) return 0
    if (summon) W.beckons.push({ x, y, z, until: srv.tickCount + 1200 })
    return 1
  }
  const near = (list, x, y, z, r, kind) => list.filter(e => e.until > srv.tickCount && e.kind === kind && Math.hypot(e.x - x, e.y - y, e.z - z) <= r).length
  const POS = /^execute in (\S+) positioned (\S+) (\S+) (\S+) run (.*)$/
  const PROBE = /^execute as ([0-9a-f-]{36}) at @s if entity @e\[type=(#pne:hive|#pne:spore),distance=\.\.(\d+)\]$/
  const attributed = () => {
    const st = String(new Error().stack)
    return st.indexOf('pne_horror.js') >= 0 || st.indexOf('pne_resonance.js') >= 0
  }
  function answer (s) {
    let m
    if (s === 'seed') return 123456789
    if (s === 'time query day') return Math.floor(srv.tickCount / 216)
    if (s === 'time query daytime') return dayTime()
    if ((m = /^epca_evolution setpoints (\d+) minecraft:overworld$/.exec(s))) { W.points = Number(m[1]); return 1 }
    if (s === 'execute if entity @a[tag=pne_horde,tag=!pne_horde_told]') return players.filter(p => tagged(p, 'pne_horde') && !tagged(p, 'pne_horde_told')).length
    if (s === 'tag @a[tag=pne_horde,tag=!pne_horde_told] add pne_horde_told') {
      let n = 0
      for (const p of players) if (tagged(p, 'pne_horde') && !tagged(p, 'pne_horde_told')) { p.addTag('pne_horde_told'); n++ }
      return n
    }
    if (s === 'scoreboard players add @a[tag=pne_horde] pne_horde_age 20') {
      for (const p of players) if (tagged(p, 'pne_horde')) W.age[p.uuid] = (W.age[p.uuid] || 0) + 20
      return 1
    }
    if ((m = /^tag @a\[tag=pne_horde,scores=\{pne_horde_age=(\d+)\.\.\}\] remove (\S+)$/.exec(s))) {
      let n = 0
      for (const p of players) if (tagged(p, 'pne_horde') && (W.age[p.uuid] || 0) >= Number(m[1]) && p.removeTag(m[2])) n++
      return n
    }
    if (s === 'tag @a[tag=!pne_horde,tag=pne_horde_told] remove pne_horde_told') {
      let n = 0
      for (const p of players) if (!tagged(p, 'pne_horde') && p.removeTag('pne_horde_told')) n++
      return n
    }
    if (s === 'scoreboard players reset @a[tag=!pne_horde] pne_horde_age') {
      for (const p of players) if (!tagged(p, 'pne_horde')) delete W.age[p.uuid]
      return 1
    }
    if ((m = PROBE.exec(s))) {
      const p = players.find(q => q.uuid === m[1])
      const i = players.indexOf(p)
      const ph = phase(i, srv.tickCount)
      const r = Number(m[3])
      if (ph.near > r) return 0
      return m[2] === '#pne:hive' ? 1 + (ph.n16 > 0 ? Math.min(4, ph.n16) : 0) : (ph.k === 'fight' ? 1 : 0)
    }
    if ((m = POS.exec(s))) {
      const x = Number(m[2])
      const y = Number(m[3])
      const z = Number(m[4])
      const inner = m[5]
      let q
      if (inner === 'execute if entity @a[tag=pne_horde,distance=..64]') return players.filter(p => tagged(p, 'pne_horde') && dist(p, x, y, z) <= 64).length
      if (inner === 'execute if entity @e[type=#pne:flesh,distance=..24]') return near(W.products, x, y, z, 24, 'flesh')
      if (inner === 'execute if entity @e[tag=pne_burst,type=!#pne:flesh,distance=..24]') return near(W.products, x, y, z, 24, 'mozzie')
      if ((q = /^summon epca:living_flesh_size0 ~(\S+) ~0\.3 ~(\S+) /.exec(inner))) {
        W.products.push({ kind: 'flesh', x: x + Number(q[1]), y: y + 0.3, z: z + Number(q[2]), until: srv.tickCount + 400 })
        return 1
      }
      if (/^summon epca:mozzie /.test(inner)) { W.products.push({ kind: 'mozzie', x, y: y + 0.6, z, until: srv.tickCount + 600 }); return 1 }
      if (/^execute if entity @a\[distance=\.\.64,/.test(inner)) return chainOk(x, y, z, / run summon epca:stage_i_beckon /.test(inner))
      return 1
    }
    return 1
  }
  srv.runCommandSilent = function (cmd) {
    const s = String(cmd)
    srv.cmds.push(s)
    if (attributed()) W.stream.push(s)
    return answer(s)
  }
  srv.runCommand = srv.runCommandSilent

  const prevLimit = Error.stackTraceLimit
  Error.stackTraceLimit = 200
  try {
    if (o.pin) c.pneCoreCfgSet(srv, 'diff_profile', o.pin)
    M.fire('ServerEvents.loaded', { server: srv })
    M.tick(srv, 1)
    const specs = [['Host', 'aaaa0000-0000-4000-8000-000000000001', 0, 0], ['Bob', 'bbbb0000-0000-4000-8000-000000000002', 36, 18],
      ['Cara', 'cccc0000-0000-4000-8000-000000000003', 420, -380]]
    for (const [name, uuid, x, z] of specs) {
      const p = M.player(srv, name, uuid, { x, y: 64, z })
      players.push(p)
      p.yaw = (x * 7) % 360
      M.fire('PlayerEvents.loggedIn', { player: p })
    }
    players[0].addTag('pne_comfort_off')
    const kinds = ['epca:infested_zombie', 'epca:ripper', 'spore:inf_human', 'epca:infested_cow', 'epca:living_flesh_size1',
      'epca:infested_villager', 'epca:stage_i_beckon', 'epca:mozzie', 'minecraft:zombie', 'epca:infested_husk', 'spore:knight',
      'epca:infested_wolf', 'epca:biomass_small']
    const radii = [5, 12, 20, 26, 30, 34, 40, 47, 55, 70]
    let k = 0
    for (let t = 2; t <= TICKS; t++) {
      M.tick(srv, 1)
      const now = srv.tickCount
      // the director's Pace after this tick's 1 Hz steps
      for (let i = 0; i < players.length; i++) {
        const R = c.pneResPace(players[i])
        if (R && R.tick === c.pneCoreTick) {
          W.pace.push([now, i, STATES.indexOf(R.state), R.spawn, R.aggro, R.beckon ? 1 : 0, R.ga, R.gov, TIERS.indexOf(R.tier), R.e])
        }
      }
      // player health: Host dips into mercy in its fights, Bob less
      for (let i = 0; i < 2; i++) {
        const ph = phase(i, now)
        const p = players[i]
        if (ph.k === 'fight') p.hp = Math.max(i === 0 ? 4 : 9, p.hp - 0.05)
        else p.hp = Math.min(20, p.hp + 0.02)
        if (ph.k === 'fight' && now % 20 === 3) {
          M.fire('EntityEvents.hurt:minecraft:player', { entity: p, source: M.damage('mob', M.mob(srv, 'epca:ripper', { x: p.x + 2, y: 64, z: p.z })) })
        }
      }
      if (now === 9000) players[1].addTag('pne_horde')
      if (now === 16050) players[1].removeTag('pne_horde')
      // player deaths (a parasite kill, a fall after a parasite hit, a Spore kill) and respawns
      const kill = { 7000: [0, 'mob', 'epca:infested_zombie'], 12500: [1, 'fall', null], 20000: [0, 'mob', 'spore:inf_human'], 22000: [2, 'arrow', 'epca:infested_skeleton'] }[now]
      if (kill) {
        const p = players[kill[0]]
        if (kill[1] === 'fall') M.fire('EntityEvents.hurt:minecraft:player', { entity: p, source: M.damage('mob', M.mob(srv, 'epca:ripper', { x: p.x + 1, y: 64, z: p.z })) })
        const killer = kill[2] ? M.mob(srv, kill[2], { x: p.x + 3, y: 64, z: p.z }) : null
        const ev = { entity: p, source: M.damage(kill[1], killer) }
        M.fire('EntityEvents.death:minecraft:player', ev)
        M.fire('EntityEvents.death', ev)
        W.deaths++
      }
      if (now === 7060 || now === 12560 || now === 20060 || now === 22060) {
        const p = players[{ 7060: 0, 12560: 1, 20060: 0, 22060: 2 }[now]]
        p.hp = 20
        M.fire('PlayerEvents.respawned', { player: p })
      }
      if (now % DEATH_EVERY !== 0) continue
      // a parasite (or something else) dies near a player
      k++
      const p = players[k % 3]
      const a = (k * 137.508) * 0.017453292519943295
      const r = radii[k % radii.length]
      const type = kinds[k % kinds.length]
      const mob = M.mob(srv, type, { x: Math.round((p.x + Math.sin(a) * r) * 100) / 100, y: k % 11 === 4 ? 70 : 64, z: Math.round((p.z + Math.cos(a) * r) * 100) / 100 })
      if (k % 4 !== 0) mob.flk = 0.9
      else if (k % 7 === 0) mob.flk = 0.3
      if (k % 19 === 6) mob.addTag('pne_burst')
      const msg = k % 13 === 0 ? 'genericKill' : (k % 29 === 0 ? 'outOfWorld' : (k % 4 === 1 ? 'arrow' : 'mob'))
      M.fire('EntityEvents.death', { entity: mob, source: M.damage(msg, msg === 'mob' || msg === 'arrow' ? p : null) })
    }
  } finally {
    Error.stackTraceLimit = prevLimit
  }
  return { c, W, srv, players }
}

// director-node's synthetic 1 Hz input traces (calm, approach, fight with damage, flee, lull; mercy, grace, hive deaths)
function genTrace (seed, steps) {
  const r = xs(seed)
  const out = []
  let near = 32; let tsd = 600; let hp = 1; let eo = 0.1; let conf = 0.6; let grace = 0; let deaths = 0
  let mode = 'calm'; let left = 0
  for (let t = 0; t < steps; t++) {
    if (left <= 0) {
      const u = r()
      mode = u < 0.35 ? 'calm' : u < 0.55 ? 'approach' : u < 0.8 ? 'fight' : u < 0.9 ? 'flee' : 'lull'
      left = 10 + Math.floor(r() * 90)
      if (r() < 0.05) { grace = 120; hp = 1; deaths = Math.min(6, deaths + 1) }
    }
    left--
    if (mode === 'calm') { near = Math.min(32, near + 2); eo += (0.08 - eo) * 0.2 }
    if (mode === 'approach') { near = Math.max(6, near - 1.5); eo += (0.45 - eo) * 0.15 }
    if (mode === 'fight') { near = 1 + r() * 4; eo += (0.85 - eo) * 0.3; if (r() < 0.3) { tsd = 0; hp = Math.max(0.05, hp - r() * 0.15) } }
    if (mode === 'flee') { near = 3 + r() * 6; eo += (0.95 - eo) * 0.4 }
    if (mode === 'lull') { near = 12 + r() * 10; eo += (0.3 - eo) * 0.1 }
    tsd = tsd + 1
    if (mode !== 'fight' && hp < 1) hp = Math.min(1, hp + 0.01)
    if (grace > 0) grace--
    if (r() < 0.002) deaths = Math.max(0, deaths - 1)
    conf = r() < 0.15 ? r() * 0.45 : 0.45 + r() * 0.55
    const fresh = r() > 0.1
    const n16 = near < 16 ? Math.floor(r() * 8) : 0
    const light = Math.floor(r() * 16)
    const prox = Math.max(0, 1 - near / 32)
    out.push({
      eo: Math.max(0, Math.min(1, eo + (r() - 0.5) * 0.1)), conf: conf, fresh: fresh,
      sh: Math.min(1, 0.45 * prox + 0.2 * Math.min(1, n16 / 8) + 0.15 * (1 - light / 15) + 0.2 * (1 - hp)),
      theta: Math.min(1, 0.6 * prox + 0.25 * Math.min(1, n16 / 8) + 0.15 * (1 - light / 15)),
      nearest: near, tsd: tsd, pflee: fresh ? (mode === 'flee' ? 0.5 + r() * 0.5 : r() * 0.5) : -1,
      mercy: hp <= 0.3, grace: grace > 0, deaths1h: deaths
    })
  }
  return out
}

// The director's pure pacing outputs in context c: pneResPaceOut over the whole grid and pneResPureStep over 8 traces.
// extra: fields merged into every pure-step input (for example { diff: 3 }); none for the 1.4 scripts.
function pacing (c, extra) {
  const paceOut = []
  for (const s of STATES) {
    for (const mercy of [false, true]) {
      for (const grace of [false, true]) {
        for (let d = 0; d <= 12; d++) {
          const o = c.pneResPaceOut(s, mercy, grace, d)
          paceOut.push([s, mercy ? 1 : 0, grace ? 1 : 0, d, o.spawn, o.aggro, o.beckon ? 1 : 0, o.ga, o.gov])
        }
      }
    }
  }
  const pure = []
  for (let i = 1; i <= 8; i++) {
    const st = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
    for (const x of genTrace(i * 7919, 300)) {
      const o = c.pneResPureStep(st, Object.assign({}, x, extra || {}))
      pure.push([i, STATES.indexOf(o.state), o.tier, o.raw, o.spawn, o.aggro, o.beckon ? 1 : 0, o.ga, o.gov, o.hard ? 1 : 0, o.e])
    }
  }
  return { paceOut, pure }
}

module.exports = { run, pacing, genTrace, load, xs, FILES, TICKS, SEED, STATES, TIERS, ROOT }
