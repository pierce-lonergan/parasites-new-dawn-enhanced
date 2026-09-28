// Suite director-flank: the FLK phenotype of scripted reinforcements (TDD 3.1 gene 4, "reinforcements biased to the
// player's rear 120-degree arc at low block light") in pne_horror.js, on the KubeJS mocks with the core (and, in one
// world, the director). A small terrain model answers level.getBlock (block state, block light, the
// #pne:beckon_ground tag) and a small interpreter evaluates the reinforcement execute chain exactly as written
// (players within 64 / 24, the Hive Night horde within 128, beckons within 32, replaceable feet and head,
// #pne:beckon_ground below), with and without its summon, so a flank spot counts only when the chain itself would
// summon there.
//
// What it checks:
//  - FLK >= 0.5 at block light <= 7: the beckon lands in the nearest survival player's rear 120-degree arc (relative
//    to getYaw(), the name KubeJS leaves visible, F37) at 24-40 blocks horizontally, with probability FLK; the arc
//    follows the facing, not the bearing of the dying mob (mobs dying beside and behind the player), and the light
//    is read at the player's feet block (a light that differs there from everywhere else);
//  - high light, FLK < 0.5, no genome, the hive pillar off, an unreadable facing: today's placement, and for high
//    light / FLK < 0.5 / no genome the command stream is identical to a world without the hive (no extra random draw);
//  - FLK changes where a beckon stands, never whether one appears: the same deaths with FLK 1 and without a genome
//    give the same beckon count death by death (kills within 24 blocks, on planks, near a beckon, in a horde: none);
//  - every existing rule still binds the flank spot (natural ground, 64 / 24, horde, 32-block beckon spacing,
//    cooldown, stage, chance, the scripted-spawn multiplier, mercy and grace at the death point and at the spot);
//  - the ground search passes through a tree canopy or a floor to natural ground below it;
//  - at most 8 probes, each at most 14 block reads, 14 tag reads and one chain command, then today's placement;
//  - the bell and the call sound where the beckon stands (through the ledger with the director loaded).
//
//   node tools/director/test_flank.js
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const P = require('./pack.js')

const T0 = P.checker('director-flank')
// PNE_TEST_VERBOSE=1 prints every check; PNE_TEST_SEED=<n> runs the random streams under another seed.
const VERBOSE = process.env.PNE_TEST_VERBOSE === '1'
const T = {
  ok (c, m) { if (VERBOSE) console.log((c ? '  ok   ' : '  FAIL ') + m); T0.ok(c, m) },
  eq (a, b, m) { if (VERBOSE) console.log((a === b ? '  ok   ' : '  FAIL ') + m + ' (' + JSON.stringify(a) + ')'); T0.eq(a, b, m) },
  done () { T0.done() }
}
// PNE_FLANK_HORROR=<path> runs the suite against another copy of pne_horror.js (mutation checks of this suite).
const HORROR = process.env.PNE_FLANK_HORROR ? path.resolve(process.env.PNE_FLANK_HORROR) : P.HORROR
const src = fs.readFileSync(path.resolve(P.ROOT, HORROR), 'utf8').replace(/\r\n/g, '\n')

const CHAIN = ' run execute if entity @a[distance=..64,gamemode=!spectator,gamemode=!creative]' +
  ' unless entity @a[distance=..24] unless entity @a[tag=pne_horde,distance=..128]' +
  ' unless entity @e[type=#pne:beckon,distance=..32] if block ~ ~ ~ #minecraft:replaceable' +
  ' if block ~ ~1 ~ #minecraft:replaceable if block ~ ~-1 ~ #pne:beckon_ground' +
  ' run summon epca:stage_i_beckon ~ ~ ~ {Tags:["pne_called"]}'
// The same chain without its summon (pneHBeckonTest): true when today's placement would summon there.
const DRY = CHAIN.substring(0, CHAIN.lastIndexOf(' run summon '))
const CHAIN_RX = /^execute in (\S+) positioned (\S+) (\S+) (\S+)( run execute if entity .*)$/
const BAD = []
const ENV_SEED = Number(process.env.PNE_TEST_SEED)
const SEED = isFinite(ENV_SEED) && ENV_SEED > 0 ? (ENV_SEED >>> 0) || 1 : 20260928

// Block ids of the terrain model. Replaceable = #minecraft:replaceable members used here; ground = #pne:beckon_ground
// members used here (pne_tags.js); everything else is solid and not natural ground (planks: a base floor).
const REPL = new Set(['minecraft:air', 'minecraft:water', 'minecraft:short_grass'])
const GROUND = new Set(['minecraft:grass_block', 'minecraft:dirt', 'minecraft:sand', 'minecraft:stone', 'minecraft:crimson_nylium'])
// #minecraft:leaves members used here (a tree canopy, which the ground search passes through)
const LEAVES = new Set(['minecraft:dark_oak_leaves', 'minecraft:oak_leaves'])

// ------------------------------------------------------------------ static
T.ok(/function pneHYaw\(entity\) \{\n {2}var yaw = NaN\n {2}try \{ yaw = Number\(entity\.getYaw\(\)\) \} catch \(e\) \{ yaw = NaN \}\n {2}if \(!isFinite\(yaw\)\) \{\n {4}try \{ yaw = Number\(entity\.getYRot\(\)\) \}/.test(src),
  'facing from getYaw() (KubeJS name, F37); getYRot() only as the guarded mock fallback after it')
T.ok(!/Math\.PI/.test(src.replace(/\/\/.*$/gm, '')) && /var PNE_H_DEG = 0\.017453292519943295/.test(src), 'no Math.PI (undefined in Rhino, F26): degrees through a literal')
T.ok(/var PNE_H_FLK_PROBES = 8\n/.test(src) && /var PNE_H_FLK_MIN = 0\.5\n/.test(src) && /var PNE_H_FLK_LIGHT = 7\n/.test(src),
  'constants: 8 probes, FLK >= 0.5, block light <= 7')
T.ok(/info = pneCoreHiveInfo\(entity\)/.test(src) && /flk = Number\(info\.flk\)/.test(src), 'FLK read through the core wrapper pneCoreHiveInfo(entity).flk')
T.ok(/ok \+= Number\(server\.runCommandSilent\(pneHBeckonCmd\(atGround\)\)\) \|\| 0/.test(src) &&
  /server\.runCommandSilent\(pneHBeckonCmd\(at\)\)/.test(src), 'today\'s placement and every probe run the one chain builder pneHBeckonCmd')
const cmdFn = /function pneHBeckonCmd\(at\) \{\n {2}return at \+ 'execute' \+\n([\s\S]*?)\n\}/.exec(src)
T.ok(cmdFn && cmdFn[1].replace(/'\s*\+\s*\n\s*'/g, '').replace(/^\s*'|'$/g, '') === CHAIN.replace(/^ run execute/, ''),
  'pneHBeckonCmd holds exactly the pre-FLK chain (64 / 24 / horde 128 / beckon 32 / replaceable feet and head / beckon ground)')
T.ok(/function pneHBeckonTest\(at\) \{\n {2}var c = pneHBeckonCmd\(at\)\n {2}return c\.substring\(0, c\.lastIndexOf\(' run summon '\)\)\n\}/.test(src),
  'pneHBeckonTest is pneHBeckonCmd without its summon (one chain text, so the test cannot drift from the chain)')
T.ok(/var PNE_H_FLK_GROUND = 'pne:beckon_ground'\s/.test(src) && /var PNE_H_FLK_CANOPY = 'minecraft:leaves'\n/.test(src) &&
  /level\.getBlock\(x, y, z\)\.hasTag\(tag\)/.test(src) && /pneHBlockTag\(level, bx, y, bz, PNE_H_FLK_GROUND\)/.test(src) &&
  /pneHBlockTag\(level, bx, y, bz, PNE_H_FLK_CANOPY\) !== true\) return null/.test(src),
  'the ground search reads the chain\'s own #pne:beckon_ground tag and #minecraft:leaves (BlockContainerJS.hasTag, a KubeJS name)')

// ------------------------------------------------------------------ world
function flat (id, top) { return () => ({ top, id }) }

function world (opts) {
  const o = opts || {}
  const files = [P.MOCKS, P.CORE]
  if (o.director) files.push(P.TEST_CAT, P.RES)
  files.push(HORROR)
  const c = P.load(files)
  vm.runInContext('var __rq = []; (function () { var s = ' + (o.seed || SEED) + '; Math.random = function () { ' +
    'if (__rq.length) return __rq.shift(); s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; ' +
    'return s / 4294967296 } })()', c)
  const M = c.__pneMock
  const srv = M.server({ owner: 'Host' })
  srv.level.getDayTime = () => 18000
  // tag: how hasTag answers, 'ok' (the tag as modelled), 'lie' (true for every block), 'throw' (not readable)
  const W = { c, M, srv, beckons: [], chains: [], dry: [], states: 0, tags: 0, lights: 0, infoCalls: 0,
    col: o.col || flat('minecraft:grass_block', 63), light: o.light || (() => 0), unreadable: false, tag: 'ok' }
  // A column: { top, id, under, water, at(y) } (at: an id for level y that overrides the rest, or undefined).
  W.idAt = function (x, y, z) {
    const col = W.col(x, z)
    if (!col) return 'minecraft:air'
    if (col.at) { const v = col.at(y); if (v) return v }
    if (y > col.top) return (col.water !== undefined && y <= col.water) ? 'minecraft:water' : 'minecraft:air'
    if (y === col.top) return col.id
    return col.under || 'minecraft:stone'
  }
  srv.level.getBlock = function (x, y, z) {
    if (W.unreadable) throw new Error('mock: block not readable')
    const id = W.idAt(x, y, z)
    return {
      getId: () => id,
      getBlockState: () => { W.states++; return { isSolid: () => !REPL.has(id), isAir: () => id === 'minecraft:air' } },
      getBlockLight: () => { W.lights++; return W.light(x, y, z) },
      // BlockContainerJS.hasTag(ResourceLocation): KubeJS turns 'ns:path' into a ResourceLocation ('#...' does not parse)
      hasTag: (t) => {
        W.tags++
        if (W.tag === 'throw') throw new Error('mock: tag not readable')
        if (typeof t !== 'string' || !/^[a-z0-9_.-]+:[a-z0-9_./-]+$/.test(t)) throw new Error('mock: not a resource location: ' + t)
        if (W.tag === 'lie') return true
        return (t === 'pne:beckon_ground' && GROUND.has(id)) || (t === 'minecraft:leaves' && LEAVES.has(id))
      }
    }
  }
  const run = srv.runCommandSilent
  srv.runCommandSilent = function (cmd) {
    const s = String(cmd)
    const m = CHAIN_RX.exec(s)
    if (m && m[5] === CHAIN) {
      srv.cmds.push(s)
      const x = Number(m[2])
      const y = Number(m[3])
      const z = Number(m[4])
      const r = W.chainOk(x, y, z, true)
      W.chains.push({ x, y, z, ok: r, tick: srv.tickCount })
      return r
    }
    if (m && m[5] === DRY) {
      // today's chain without its summon: 1 when it would summon, and nothing changes
      srv.cmds.push(s)
      const x = Number(m[2])
      const y = Number(m[3])
      const z = Number(m[4])
      const r = W.chainOk(x, y, z, false)
      W.dry.push({ x, y, z, ok: r, tick: srv.tickCount })
      return r
    }
    if (m) {
      // a beckon chain with a rule lost or changed: recorded and failed below
      srv.cmds.push(s)
      BAD.push(s)
      return 0
    }
    if (/summon epca:stage_i_beckon/.test(s)) {
      // any other beckon summon (a chain that lost or changed a rule): recorded and failed below
      srv.cmds.push(s)
      BAD.push(s)
      return 0
    }
    if (/playsound/.test(s)) { srv.cmds.push(s); return 1 }
    if (s === 'time query daytime') { srv.cmds.push(s); return 6000 }
    return run(cmd)
  }
  W.chainOk = function (x, y, z, summon) {
    const d = (e) => Math.hypot(e.x - x, e.y - y, e.z - z)
    const ps = srv.players.filter(p => !p.removed)
    if (!ps.some(p => !p.spectator && !p.creative && d(p) <= 64)) return 0
    if (ps.some(p => d(p) <= 24)) return 0
    if (ps.some(p => p.tagSet.pne_horde && d(p) <= 128)) return 0
    if (W.beckons.some(b => d(b) <= 32)) return 0
    const bx = Math.floor(x)
    const by = Math.floor(y)
    const bz = Math.floor(z)
    if (!REPL.has(W.idAt(bx, by, bz)) || !REPL.has(W.idAt(bx, by + 1, bz)) || !GROUND.has(W.idAt(bx, by - 1, bz))) return 0
    if (summon) W.beckons.push({ x, y, z, tick: srv.tickCount })
    return 1
  }
  c.pneHiveInfo = function (e) {
    W.infoCalls++
    if (e.flk === undefined) return null
    return { g: '0'.repeat(56), clade: 0, sil: false, apex: false, e: [0, 0, 0, 0, e.flk, 0, 0, 0, 0, 0, 0, 0, 0, 0], strain: 'epca', flk: e.flk }
  }
  srv.persistentData.putInt('pne_doom_floor', 1800000000) // stage 10: chance 9%
  M.fire('ServerEvents.loaded', { server: srv })
  // contract 1.5 (rule 15): nothing issues a command before the server's first tick, so the world starts one tick in
  M.tick(srv, 1)
  return W
}

// A non-host parasite dies at x y z (no Mobs Inside burst). q: values Math.random returns first (then the seeded
// stream): by default 0 for the chance roll and 0.5 for pneCoreSpawnCount (k = floor(m + 0.5)).
function die (W, flk, x, y, z, o) {
  const opt = o || {}
  const mob = W.M.mob(W.srv, opt.type || 'epca:ripper', { x, y, z })
  if (flk !== undefined) mob.flk = flk
  if (!opt.keepCooldown) W.c.pneHBeckonReadyAt = 0
  const q = opt.q === undefined ? [0, 0.5] : opt.q
  for (const v of q) W.c.__rq.push(v)
  const n0 = W.srv.cmds.length
  const c0 = W.chains.length
  const d0 = W.dry.length
  const b0 = W.beckons.length
  const s0 = W.states
  const t0 = W.tags
  const st0 = Object.assign({}, W.c.pneHFlkStats)
  W.M.fire('EntityEvents.death', { entity: mob, source: W.M.damage('mob', null) })
  W.c.__rq.length = 0
  const st = W.c.pneHFlkStats
  return {
    cmds: W.srv.cmds.slice(n0),
    chains: W.chains.slice(c0),
    dry: W.dry.slice(d0),
    placed: W.beckons.slice(b0),
    reads: W.states - s0,
    tags: W.tags - t0,
    probes: st.probes - st0.probes,
    plans: st.plans - st0.plans,
    refused: st.refused - st0.refused,
    fallbacks: st.fallbacks - st0.fallbacks
  }
}

// Horizontal distance and angle (degrees) of spot s from straight behind player p facing yaw. Minecraft's view vector
// (Entity.calculateViewVector) is (-sin yaw cos pitch, -sin pitch, cos yaw cos pitch); straight behind is its opposite
// in the horizontal plane, (sin yaw, -cos yaw).
function rear (p, yaw, s) {
  const dx = s.x - p.x
  const dz = s.z - p.z
  const r = Math.hypot(dx, dz)
  const th = yaw * Math.PI / 180
  const cos = (dx * Math.sin(th) - dz * Math.cos(th)) / r
  return { r, ang: Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI }
}
// A point `dist` blocks in front of a player at (x, z) facing yaw.
function ahead (x, z, yaw, dist) {
  const th = yaw * Math.PI / 180
  return { x: x - Math.sin(th) * dist, z: z + Math.cos(th) * dist }
}
// Same place, allowing for the 2-decimal command text of today's placement (pneHPos).
const at = (s, x, y, z) => Math.abs(s.x - x) <= 0.006 && Math.abs(s.y - y) <= 0.006 && Math.abs(s.z - z) <= 0.006

// ------------------------------------------------------------------ 1. FLK >= 0.5 at low light: the rear arc
{
  const W = world({})
  const p = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  let rearN = 0
  let frontN = 0
  let other = 0
  let worstR = [99, 0]
  let worstA = 0
  let maxProbes = 0
  const yaws = []
  for (let i = 0; i < 400; i++) {
    const yaw = -720 + 1440 * ((i * 0.6180339887) % 1)   // any yaw, including wrapped values
    p.yaw = yaw
    p.x = ((i * 37) % 200) - 100
    p.z = ((i * 53) % 200) - 100
    const f = ahead(p.x, p.z, yaw, 30)
    W.beckons.length = 0
    const r = die(W, 0.8, f.x, 64, f.z)
    maxProbes = Math.max(maxProbes, r.probes)
    if (r.placed.length !== 1) { other++; continue }
    const s = r.placed[0]
    if (at(s, f.x, 64, f.z)) { frontN++; continue }
    const g = rear(p, yaw, s)
    rearN++
    yaws.push(yaw)
    worstR = [Math.min(worstR[0], g.r), Math.max(worstR[1], g.r)]
    worstA = Math.max(worstA, g.ang)
  }
  T.eq(other, 0, 'open natural ground: every reinforcement places exactly one beckon')
  T.ok(worstR[0] >= 24 && worstR[1] <= 40, 'FLK 0.8, block light 0: every flank beckon 24-40 blocks from the player horizontally (' +
    worstR[0].toFixed(2) + '-' + worstR[1].toFixed(2) + ')')
  T.ok(worstA <= 60, 'every flank beckon inside the rear 120-degree arc of the player\'s facing (worst ' + worstA.toFixed(2) + ' degrees off straight behind)')
  T.ok(worstA > 50, 'the arc is used out to its edges (widest ' + worstA.toFixed(2) + ' degrees)')
  T.ok(rearN / 400 > 0.72 && rearN / 400 < 0.88, 'placed in the rear with probability FLK 0.8 (' + rearN + '/400)')
  T.eq(rearN + frontN, 400, 'the rest keep today\'s placement at the dying mob (' + frontN + ')')
  T.ok(maxProbes <= 8, 'never more than 8 probes (' + maxProbes + ')')
  T.ok(new Set(yaws.map(y => Math.round(((y % 360) + 360) % 360 / 45))).size >= 8, 'facings all around the compass were exercised')

  // FLK 1: always the rear arc; the first probe succeeds on open ground, so one chain command and 8 block reads
  W.beckons.length = 0
  p.x = 0; p.z = 0; p.yaw = 90
  const r1 = die(W, 1, -30, 64, 0) // 30 blocks in front (yaw 90 faces -X)
  T.ok(r1.placed.length === 1 && rear(p, 90, r1.placed[0]).ang <= 60 && r1.placed[0].x > 0, 'FLK 1, facing -X: the beckon is behind the player (+X side)')
  T.eq(r1.chains.length, 1, 'open ground: the first probe summons (one chain command)')
  T.eq(r1.reads, 8, 'the probe reads down from 6 above the player\'s feet level to the ground: 8 blocks here (at most 14)')
  T.eq(r1.tags, 1, 'one tag read: the grass surface is #pne:beckon_ground')
  T.ok(r1.dry.length === 1 && at(r1.dry[0], -30, 64, 0) && r1.dry[0].ok === 1 && r1.cmds.indexOf(r1.cmds.find(x => CHAIN_RX.exec(x) && CHAIN_RX.exec(x)[5] === DRY)) <
    r1.cmds.indexOf(r1.cmds.find(x => CHAIN_RX.exec(x) && CHAIN_RX.exec(x)[5] === CHAIN)),
  'before moving it, today\'s chain without its summon is asked once, at the dying mob, and passes')
  T.ok(r1.chains.length === 1 && r1.chains[0].y === 64 && Number.isInteger(r1.chains[0].x - 0.5) && Number.isInteger(r1.chains[0].z - 0.5),
    'the spot is the block centre on the ground (feet 64 above the grass at 63)')
  T.ok(r1.cmds.some(x => x.indexOf('run playsound minecraft:block.bell.use hostile @a[distance=..96] ~ ~ ~ 4.00 0.50') > 0 &&
    x.indexOf('positioned ' + r1.placed[0].x.toFixed(2) + ' 64.00 ' + r1.placed[0].z.toFixed(2) + ' ') > 0), 'the bell sounds where the beckon stands (no director: the core fallback)')

  // boundaries: FLK exactly 0.5 and block light exactly 7 qualify; the FLK draw decides
  W.beckons.length = 0
  W.light = () => 7
  const r2 = die(W, 0.5, -30, 64, 0, { q: [0, 0.5, 0.49] })
  T.ok(r2.placed.length === 1 && r2.placed[0].x > 0 && r2.plans === 1, 'FLK 0.5 at block light 7, draw 0.49 < 0.5: flanked')
  W.beckons.length = 0
  const r3 = die(W, 0.5, -30, 64, 0, { q: [0, 0.5, 0.5] })
  T.ok(r3.placed.length === 1 && at(r3.placed[0], -30, 64, 0) && r3.plans === 0, 'FLK 0.5, draw 0.5: not flanked, today\'s placement')
  W.light = () => 0
}

// ------------------------------------------------------------------ 1b. the arc follows the facing, not the dying mob
// The mob dies beside or behind the player, so "behind the player's facing" and "away from the mob" differ.
{
  const W = world({})
  const p = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  // (a) facing -X (yaw 90), the mob dies 30 blocks to the player's side (+Z): behind the facing is +X
  p.yaw = 90
  let okA = 0
  for (let i = 0; i < 40; i++) {
    W.beckons.length = 0
    const r = die(W, 1, 0, 64, 30)
    if (r.placed.length === 1 && r.plans === 1 && r.placed[0].x > 0 && rear(p, 90, r.placed[0]).ang <= 60) okA++
  }
  T.eq(okA, 40, 'facing -X, the mob dying at the player\'s side (+Z): every beckon behind the facing, on the +X side (' + okA + '/40)')
  // (b) facing +Z (yaw 0), the mob dies 30 blocks behind the player (-Z): the beckon is behind the facing (-Z), not
  // on the far side of the player from the mob (+Z)
  p.yaw = 0
  let okB = 0
  for (let i = 0; i < 40; i++) {
    W.beckons.length = 0
    const r = die(W, 1, 0, 64, -30)
    if (r.placed.length === 1 && r.plans === 1 && r.placed[0].z < 0 && rear(p, 0, r.placed[0]).ang <= 60) okB++
  }
  T.eq(okB, 40, 'facing +Z, the mob dying behind the player: every beckon behind the facing (-Z), none away from the mob (' + okB + '/40)')
  // (c) facing and the mob's bearing drawn independently all round the compass
  let bad = 0
  let n = 0
  let off = 0
  for (let i = 0; i < 300; i++) {
    const yaw = 360 * ((i * 0.6180339887) % 1) - 180
    const bear = 360 * ((i * 0.7548776662) % 1)   // degrees, Minecraft yaw convention: the direction the mob lies in
    const dist = 26 + (i % 25)
    p.yaw = yaw
    const f = ahead(0, 0, bear, dist)
    const between = Math.abs((((bear - yaw) % 360) + 540) % 360 - 180)
    if (between > 90) off++
    W.beckons.length = 0
    const r = die(W, 1, f.x, 64, f.z)
    if (r.placed.length !== 1 || r.plans !== 1) { bad++; continue }
    n++
    const g = rear(p, yaw, r.placed[0])
    if (!(g.ang <= 60 && g.r >= 24 && g.r <= 40)) bad++
  }
  T.ok(bad === 0 && n === 300, 'facing and mob bearing independent (300 deaths): every beckon 24-40 blocks inside the rear 120 degrees of getYaw() (' +
    n + ' placed, ' + bad + ' not)')
  T.ok(off > 100, 'the sweep includes many mobs dying beside or behind the player (' + off + ' more than 90 degrees off the facing)')
}

// ------------------------------------------------------------------ 1c. the light is read at the player's feet
{
  // block light 0 only in the player's feet block (0 64 0), 12 everywhere else (the dying mob, the eyes, the spots)
  const W = world({ light: (x, y, z) => (x === 0 && y === 64 && z === 0 ? 0 : 12) })
  const p = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0.5, y: 64, z: 0.5 })
  p.yaw = 0
  const r = die(W, 1, 0.5, 64, 30.5)
  T.ok(r.plans === 1 && r.placed.length === 1 && r.placed[0].z < 0 && rear(p, 0, r.placed[0]).ang <= 60,
    'dark at the player\'s feet block only (lit at the mob, the eyes and the spots): flanked')
  // the inverse: 12 at the player's feet block, 0 everywhere else
  const W2 = world({ light: (x, y, z) => (x === 0 && y === 64 && z === 0 ? 12 : 0) })
  const p2 = W2.M.player(W2.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0.5, y: 64, z: 0.5 })
  p2.yaw = 0
  const r2 = die(W2, 1, 0.5, 64, 30.5)
  T.ok(r2.plans === 0 && r2.dry.length === 0 && r2.placed.length === 1 && at(r2.placed[0], 0.5, 64, 30.5),
    'lit at the player\'s feet block only (dark everywhere else): today\'s placement, no draw, no test command')
}

// ------------------------------------------------------------------ 2. high light, FLK < 0.5, no genome: unchanged
// The same scenario in a world with the given FLK/light and in a world where no mob has a genome: identical command
// streams (same seed), so nothing about today's placement or its random draws changed.
function unchanged (flk, lightFn, what) {
  const run = (withFlk) => {
    const W = world({ light: lightFn, seed: (SEED ^ 777) >>> 0 || 1 })
    const p = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
    const q = W.M.player(W.srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: 5, y: 64, z: 60 })
    for (let i = 0; i < 120; i++) {
      p.yaw = (i * 47) % 360
      q.x = 5 + (i % 7)
      if (i % 30 === 0) W.beckons.length = 0
      const f = ahead(p.x, p.z, p.yaw, 25 + (i % 12))
      // the chance roll passes on every second death (queued 0); on the others it, and on all deaths the spawn
      // count and everything after it, come from the seeded stream
      die(W, withFlk ? flk : undefined, f.x, 64, f.z, { q: i % 2 === 0 ? [0] : [] })
      if (i % 10 === 9) W.M.tick(W.srv, 20)
    }
    return W
  }
  const A = run(true)
  const B = run(false)
  T.ok(A.infoCalls > 0, what + ': the dying mobs were asked for HiveInfo (' + A.infoCalls + ')')
  T.eq(A.c.pneHFlkStats.plans, 0, what + ': no flank plan')
  T.ok(A.srv.cmds.length === B.srv.cmds.length && A.srv.cmds.every((x, i) => x === B.srv.cmds[i]),
    what + ': the command stream equals a world without the hive (' + A.srv.cmds.length + ' commands)')
  T.ok(A.chains.filter(x => x.ok).length > 0, what + ': reinforcements still happen (' + A.chains.filter(x => x.ok).length + ' beckons)')
}
unchanged(0.9, () => 12, 'FLK 0.9 at block light 12')
unchanged(0.9, () => 8, 'FLK 0.9 at block light 8')
unchanged(0.4999, () => 0, 'FLK 0.4999 at block light 0')
unchanged(0, () => 0, 'FLK 0 at block light 0')

// Other ways the flank stays off: no flk field, NaN, the hive pillar off, no readable facing, no readable light,
// no survival player near, the FLK draw failing.
{
  const W = world({})
  const p = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const front = (r, what) => T.ok(r.placed.length === 1 && at(r.placed[0], 0, 64, 30) && r.plans === 0, what + ': today\'s placement')
  W.beckons.length = 0
  const hi = W.c.pneHiveInfo
  W.c.pneHiveInfo = function (e) { const i = hi(e); if (i) delete i.flk; return i }
  front(die(W, 0.9, 0, 64, 30), 'HiveInfo without flk')
  W.c.pneHiveInfo = function (e) { const i = hi(e); if (i) i.flk = NaN; return i }
  W.beckons.length = 0
  front(die(W, 0.9, 0, 64, 30), 'flk NaN')
  W.c.pneHiveInfo = hi
  W.c.pneCoreCfgSet(W.srv, 'on_hive', 0)
  W.beckons.length = 0
  const calls = W.infoCalls
  front(die(W, 0.9, 0, 64, 30), 'hive pillar off (pneCoreHiveInfo null)')
  T.eq(W.infoCalls, calls, 'hive pillar off: pneHiveInfo is not even asked')
  W.c.pneCoreCfgSet(W.srv, 'on_hive', 1)
  const yawFn = p.getYaw
  p.getYaw = () => NaN
  W.beckons.length = 0
  front(die(W, 0.9, 0, 64, 30), 'no readable facing (getYaw NaN, no getYRot in game shape)')
  p.getYaw = yawFn
  W.unreadable = true
  W.beckons.length = 0
  front(die(W, 0.9, 0, 64, 30), 'no readable block light')
  W.unreadable = false
  p.creative = true
  W.beckons.length = 0
  const rc = die(W, 0.9, 0, 64, 30)
  T.ok(rc.placed.length === 0 && rc.plans === 0 && rc.chains.length === 1, 'no survival player near: no flank plan, today\'s chain runs and summons nothing (a survival player within 64 is required)')
  p.creative = false
  W.beckons.length = 0
  const rd = die(W, 0.6, 0, 64, 30, { q: [0, 0.5, 0.6] })
  T.ok(rd.placed.length === 1 && at(rd.placed[0], 0, 64, 30) && rd.plans === 0, 'FLK 0.6, draw 0.6: today\'s placement')
  W.beckons.length = 0
  const re = die(W, 0.6, 0, 64, 30, { q: [0, 0.5, 0.59] })
  T.ok(re.placed.length === 1 && re.placed[0].z < 0 && re.plans === 1, 'FLK 0.6, draw 0.59: flanked (behind a player facing +Z)')
  // Mock-only fallback (F37): a player object that answers only the Mojang getYRot still flanks
  W.M.opts.mojangNames = true
  const m = W.M.player(W.srv, 'Old', 'cccc0000-0000-4000-8000-000000000003', { x: 300, y: 64, z: 0 })
  W.M.opts.mojangNames = false
  delete m.getYaw
  m.yaw = 180
  W.beckons.length = 0
  const rf = die(W, 1, 300, 64, -30)
  T.ok(rf.placed.length === 1 && rf.placed[0].z > 0 && rear(m, 180, rf.placed[0]).ang <= 60, 'mock fallback getYRot (facing -Z): flank behind, on the +Z side')
}
{
  // the nearest survival player is the one flanked: A (25 blocks, facing +Z) and B (31 blocks, facing -Z) face the
  // dying mob from both sides; the beckon lands behind A, never behind B
  const W = world({})
  const a = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const b = W.M.player(W.srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: 0, y: 64, z: 56 })
  a.yaw = 0
  b.yaw = 180
  let behindA = 0
  for (let i = 0; i < 20; i++) {
    W.beckons.length = 0
    const r = die(W, 1, 0, 64, 25)
    if (r.placed.length === 1 && rear(a, 0, r.placed[0]).ang <= 60 && r.placed[0].z < 0) behindA++
  }
  T.eq(behindA, 20, 'two players: the beckon flanks the nearest survival player (A, 25 blocks), not B (31 blocks)')
  // B nearer now: behind B
  W.beckons.length = 0
  const r2 = die(W, 1, 0, 64, 31)
  T.ok(r2.placed.length === 1 && r2.placed[0].z > 56 && rear(b, 180, r2.placed[0]).ang <= 60, 'B nearer (25 vs 31 blocks): the beckon flanks B')
  // B within 24 of the dying mob: today's chain would call nothing, so nothing is moved either
  W.beckons.length = 0
  const r3 = die(W, 1, 0, 64, 33)
  T.ok(r3.placed.length === 0 && r3.plans === 0 && r3.refused === 1, 'B 23 blocks from the dying mob: no beckon anywhere (today\'s chain refuses, so no flank)')
}

// ------------------------------------------------------------------ 2b. FLK changes where, never whether
{
  // a kill 3 blocks in front, FLK 1, block light 0: today's chain refuses (a player within 24), so nothing is moved
  const W = world({})
  const p = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  p.yaw = 0
  const r = die(W, 1, 0, 64, 3)
  T.ok(r.placed.length === 0 && r.plans === 0 && r.refused === 1 && r.dry.length === 1 && r.chains.length === 1 && r.chains[0].ok === 0,
    'a kill 3 blocks in front, FLK 1, block light 0: no beckon anywhere, no flank plan (today\'s chain refuses at the dying mob)')
}
{
  // The same 270 deaths with FLK 1 and with no genome: kills at 3-58 blocks all round the player, some on planks,
  // some 20 blocks from a beckon, some 10 blocks from a creative player. The beckon count must match death by death.
  const kinds = ['open', 'planks under the mob', 'a beckon 20 blocks from the mob', 'a creative player 10 blocks from the mob']
  const dists = [3, 10, 18, 23.5, 24.5, 28, 35, 45, 58]
  const scen = []
  for (let i = 0; i < 270; i++) {
    scen.push({ bear: 360 * ((i * 0.7548776662) % 1), yaw: 360 * ((i * 0.6180339887) % 1), dist: dists[i % 9], kind: [0, 1, 0, 2, 0, 3][Math.floor(i / 9) % 6] })
  }
  const runAll = (flk) => {
    const ctx = { planks: null }
    const W = world({ col: (x, z) => ({ top: 63, id: ctx.planks && Math.abs(x - ctx.planks.x) < 1.5 && Math.abs(z - ctx.planks.z) < 1.5 ? 'minecraft:oak_planks' : 'minecraft:grass_block' }) })
    const p = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
    const cr = W.M.player(W.srv, 'Watcher', 'bbbb0000-0000-4000-8000-000000000002', { x: 0, y: 500, z: 0, creative: true })
    const out = []
    for (const s of scen) {
      p.yaw = s.yaw
      const f = ahead(0, 0, s.bear, s.dist)
      const mx = Math.round(f.x * 100) / 100
      const mz = Math.round(f.z * 100) / 100
      ctx.planks = s.kind === 1 ? { x: mx, z: mz } : null
      W.beckons.length = 0
      if (s.kind === 2) W.beckons.push({ x: mx + 20, y: 64, z: mz })
      cr.x = s.kind === 3 ? mx + 10 : 0
      cr.y = s.kind === 3 ? 64 : 500
      cr.z = mz
      const r = die(W, flk, mx, 64, mz)
      out.push({ n: r.placed.length, moved: r.placed.length === 1 && !at(r.placed[0], mx, 64, mz), s })
    }
    return out
  }
  const A = runAll(1)
  const B = runAll(undefined)
  const diff = A.filter((a, i) => a.n !== B[i].n)
  T.eq(diff.length, 0, 'FLK 1 and no genome, the same 270 deaths: the same beckon count death by death' +
    (diff.length ? ' (first: ' + JSON.stringify(diff[0].s) + ' ' + diff[0].n + ' vs ' + B[A.indexOf(diff[0])].n + ')' : ''))
  const moved = A.filter(a => a.moved).length
  const made = B.filter(b => b.n === 1).length
  T.ok(moved > 60 && moved === A.filter(a => a.n === 1).length, 'FLK 1: every beckon that appears is moved to the rear (' + moved + ' of ' + made + ')')
  T.ok(A.filter(a => a.s.dist < 24 && a.n > 0).length === 0 && A.filter(a => a.s.dist < 24).length >= 100,
    'no beckon from a kill within 24 blocks of the player (' + A.filter(a => a.s.dist < 24).length + ' such kills)')
  for (let k = 1; k < 4; k++) {
    T.ok(A.filter(a => a.s.kind === k && a.n > 0).length === 0 && B.filter(b => b.s.kind === k && b.n > 0).length === 0,
      kinds[k] + ': no beckon with or without FLK')
  }
}

// ------------------------------------------------------------------ 3. every existing rule still binds the flank spot
{
  // natural ground only: planks behind the player (a base floor), grass in front
  const W = world({ col: (x, z) => ({ top: 63, id: z < 0 ? 'minecraft:oak_planks' : 'minecraft:grass_block' }) })
  W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r = die(W, 1, 0, 64, 30)
  T.eq(r.probes, 8, 'planks behind the player: all 8 probes used')
  T.eq(r.chains.length, 1, 'planks: the ground search refuses every rear spot before any command (not #pne:beckon_ground), then today\'s chain')
  T.ok(r.placed.length === 1 && at(r.placed[0], 0, 64, 30) && r.fallbacks === 1, 'planks: falls back to today\'s placement at the dying mob')
  T.ok(r.reads <= 8 * 14 && r.tags <= 8 * 14, 'planks: at most 8 x 14 block reads and 8 x 14 tag reads (' + r.reads + ', ' + r.tags + ')')
  T.ok(r.cmds.every(x => !CHAIN_RX.test(x) || CHAIN_RX.exec(x)[5] === CHAIN || CHAIN_RX.exec(x)[5] === DRY),
    'every chain command, rear or not, is today\'s chain word for word (or it without its summon)')
  // the chain still binds when the tag read is wrong or unreadable: a lying tag, then an unreadable one
  W.tag = 'lie'
  W.beckons.length = 0
  const r2 = die(W, 1, 0, 64, 30)
  T.ok(r2.chains.length === 9 && r2.chains.slice(0, 8).every(x => x.ok === 0 && x.z < 0) && at(r2.placed[0], 0, 64, 30),
    'planks, a tag read that says natural ground everywhere: the 8 rear chains refuse the planks themselves, today\'s placement')
  W.tag = 'throw'
  W.beckons.length = 0
  const r3 = die(W, 1, 0, 64, 30)
  T.ok(r3.chains.length === 9 && r3.chains.slice(0, 8).every(x => x.ok === 0 && x.z < 0) && at(r3.placed[0], 0, 64, 30) &&
    W.c.pneHFlkStats.errors === 0, 'planks, the tag not readable: the surface is taken, the chain refuses it (8 rear chains), today\'s placement, no error')
  W.tag = 'ok'
  W.beckons.length = 0
  W.col = () => ({ top: 63, id: 'minecraft:grass_block' })
  W.tag = 'throw'
  const r4 = die(W, 1, 0, 64, 30)
  T.ok(r4.plans === 1 && r4.chains.length === 1 && r4.placed.length === 1 && r4.placed[0].z < 0,
    'grass, the tag not readable: the flank still works (the chain decides the ground)')
  W.tag = 'ok'
}
{
  // a tree canopy behind the player: grass at 63 (feet 64), dark oak leaves at 67-69 over the rear columns, air between
  const W = world({ col: (x, z) => ({ top: 63, id: 'minecraft:grass_block', at: z < 0 ? (y => (y >= 67 && y <= 69 ? 'minecraft:dark_oak_leaves' : undefined)) : undefined }) })
  W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  let ok = 0
  let cmds = 0
  for (let i = 0; i < 40; i++) {
    W.beckons.length = 0
    const r = die(W, 1, 0, 64, 30)
    cmds += r.chains.length
    if (r.plans === 1 && r.placed.length === 1 && r.placed[0].z < 0 && r.placed[0].y === 64 && r.chains.length === 1) ok++
  }
  T.eq(ok, 40, 'under a canopy: the ground search passes through the leaves, every beckon on the grass below, first probe (' + ok + '/40)')
  T.eq(cmds, 40, 'under a canopy: one chain command per beckon (no command spent on the leaves)')
  // a roof: oak planks at 67 over grass (a building behind the player): the column ends at the roof, no spot under it
  const W2 = world({ col: (x, z) => ({ top: 63, id: 'minecraft:grass_block', at: z < 0 ? (y => (y === 67 ? 'minecraft:oak_planks' : undefined)) : undefined }) })
  W2.M.player(W2.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r2 = die(W2, 1, 0, 64, 30)
  T.ok(r2.probes === 8 && r2.chains.length === 1 && at(r2.placed[0], 0, 64, 30) && r2.reads < 8 * 14,
    'a roof behind the player: no spot is looked for under it (no rear command, the scan stops at the roof), today\'s placement')
  // the read bound: leaves and air alternating through the whole window, no ground in it
  const W3 = world({ col: (x, z) => (z < 0 ? { top: 20, id: 'minecraft:stone', at: y => (y % 2 === 1 ? 'minecraft:oak_leaves' : 'minecraft:air') } : { top: 63, id: 'minecraft:grass_block' }) })
  W3.M.player(W3.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r3 = die(W3, 1, 0, 64, 30)
  T.ok(r3.probes === 8 && r3.reads === 8 * 14 && r3.tags === 8 * 14 && r3.chains.length === 1 && at(r3.placed[0], 0, 64, 30),
    'leaves and air alternating: 8 probes, exactly 8 x 14 block reads and 8 x 14 tag reads (the bound), no rear command, today\'s placement (' +
    r3.reads + ', ' + r3.tags + ')')
}
{
  // no ground within 6 blocks of the player's feet level (a ravine or open water behind): no commands, fallback
  const W = world({ col: (x, z) => (z < 0 ? { top: 40, id: 'minecraft:stone', water: 70 } : { top: 63, id: 'minecraft:grass_block' }) })
  W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r = die(W, 1, 0, 64, 30)
  T.ok(r.probes === 8 && r.chains.length === 1 && r.reads === 8 * 14, 'deep water behind: 8 probes, 112 block reads, no rear command')
  T.ok(r.placed.length === 1 && at(r.placed[0], 0, 64, 30), 'deep water behind: today\'s placement')
  W.beckons.length = 0
  W.unreadable = true
  W.light = () => 0
  const r2 = die(W, 1, 0, 64, 30)
  T.ok(r2.placed.length === 1 && at(r2.placed[0], 0, 64, 30) && r2.plans === 0, 'blocks unreadable: no plan (light unknown), today\'s placement')
  W.unreadable = false
}
{
  // ground search window: a hill 5 higher behind the player is found, 8 higher is not
  const W = world({ col: (x, z) => ({ top: z < 0 ? 68 : 63, id: 'minecraft:grass_block' }) })
  W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r = die(W, 1, 0, 64, 30)
  T.ok(r.placed.length === 1 && r.placed[0].y === 69 && r.placed[0].z < 0, 'a slope 5 blocks up behind the player: the beckon stands on it (feet 69)')
  const W2 = world({ col: (x, z) => ({ top: z < -10 ? 71 : 63, id: 'minecraft:grass_block' }) })
  W2.M.player(W2.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r2 = die(W2, 1, 0, 64, 30)
  T.ok(r2.probes === 8 && r2.chains.length === 1 && at(r2.placed[0], 0, 64, 30), 'a cliff 8 blocks up (solid through the window): no ground found, today\'s placement')
}
{
  // a player within 24: a creative player (still counts for "no player within 24") stands behind the survival player
  const W = world({})
  W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const b = W.M.player(W.srv, 'Watcher', 'bbbb0000-0000-4000-8000-000000000002', { x: 0, y: 64, z: -32, creative: true })
  let rej = 0
  let near = 0
  let rearN = 0
  for (let i = 0; i < 60; i++) {
    W.beckons.length = 0
    const r = die(W, 1, 0, 64, 30)
    rej += r.chains.filter(x => x.ok === 0 && x.z < 0).length
    for (const s of r.placed) {
      if (Math.hypot(s.x - b.x, s.y - b.y, s.z - b.z) <= 24) near++
      if (s.z < 0) rearN++
    }
  }
  T.eq(near, 0, 'a player behind: no beckon ever within 24 blocks of any player')
  T.ok(rej > 0 && rearN > 0, 'a player behind: rear spots near them are refused by the chain (' + rej + '), others still flank (' + rearN + ')')
  // horde: the player in a Hive Night horde: today's chain refuses at the dying mob, so no flank and no beckon
  const W2 = world({})
  const h = W2.M.player(W2.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  h.addTag('pne_horde')
  const r2 = die(W2, 1, 0, 64, 30)
  T.ok(r2.placed.length === 0 && r2.plans === 0 && r2.refused === 1 && r2.chains.length === 1 && r2.chains[0].ok === 0,
    'Hive Night horde within 128 of the dying mob: no beckon, no flank (the test refuses, today\'s chain refuses)')
  // a horde player within 128 of every rear spot but 150 from the dying mob: the rear chains refuse, today's placement
  h.removeTag('pne_horde')
  const h2 = W2.M.player(W2.srv, 'Horde', 'eeee0000-0000-4000-8000-000000000005', { x: 0, y: 64, z: -120 })
  h2.addTag('pne_horde')
  W2.beckons.length = 0
  const r2b = die(W2, 1, 0, 64, 30)
  T.ok(r2b.plans === 1 && r2b.chains.length === 9 && r2b.chains.slice(0, 8).every(x => x.ok === 0 && x.z < 0) && at(r2b.placed[0], 0, 64, 30),
    'a horde player within 128 of the rear only: 8 rear chains refused by the horde rule, today\'s placement')
  // no survival player within 64 of the spot: the only survival player is 70 blocks above the dying mob's level
  // (so none is near the mob either): nothing happens at all
  const W3 = world({})
  W3.M.player(W3.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 134, z: 0 })
  const r3 = die(W3, 1, 0, 64, 30)
  T.ok(r3.placed.length === 0 && r3.plans === 0, 'no survival player within 64: no plan and no beckon')
}
{
  // no beckon within 32: a grid of beckons covers the whole rear band; the dying mob in front is 45+ blocks from them
  const W = world({})
  W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const grid = []
  for (const x of [-30, -15, 0, 15, 30]) for (const z of [-15, -30]) grid.push({ x, y: 64, z })
  W.beckons.push(...grid)
  const r = die(W, 1, 0, 64, 30)
  T.ok(r.chains.length === 9 && r.chains.slice(0, 8).every(x => x.ok === 0), 'beckons behind: 8 rear chains refused (another beckon within 32)')
  T.ok(r.placed.length === 1 && at(r.placed[0], 0, 64, 30), 'beckons behind: today\'s placement in front')
  // the scripted-spawn multiplier: m 1.25 with k = 2 still makes one beckon (the second run meets the first within 32)
  const W2 = world({})
  W2.M.player(W2.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  W2.c.pneCoreSpawnMultAt = function () { return 1.25 }
  const r2 = die(W2, 1, 0, 64, 30, { q: [0, 0.9] })
  T.ok(r2.placed.length === 1 && r2.placed[0].z < 0 && r2.chains.length === 2 && r2.chains[1].ok === 0 &&
    at(r2.chains[1], r2.chains[0].x, r2.chains[0].y, r2.chains[0].z), 'm 1.25, k 2: one flank beckon; the second run is today\'s chain at the same spot, refused (beckon within 32)')
  // multiplier 0: k = 0, nothing is planned or probed
  W2.c.pneCoreSpawnMultAt = function () { return 0 }
  W2.beckons.length = 0
  const calls2 = W2.infoCalls
  const r3 = die(W2, 1, 0, 64, 30, { q: [0, 0.5, 0] })
  T.ok(r3.placed.length === 0 && r3.plans === 0 && r3.chains.length === 0 && r3.reads === 0, 'multiplier 0 (k = 0): no plan, no probe, no chain')
  T.ok(W2.infoCalls === calls2 && W2.c.__rq.length === 0 && r3.cmds.every(x => x.indexOf('summon') < 0),
    'multiplier 0 (k = 0): HiveInfo is not asked (' + (W2.infoCalls - calls2) + ' calls)')
  // multiplier 0 only around the rear (a spot check the chain does not do): every probe refused before its command
  W2.c.pneCoreSpawnMultAt = function (l, x, y, z) { return z < 0 ? 0 : 1 }
  W2.beckons.length = 0
  const r4 = die(W2, 1, 0, 64, 30)
  T.ok(r4.probes === 8 && r4.chains.length === 1 && at(r4.placed[0], 0, 64, 30), 'multiplier 0 at the rear spots: 8 probes, no rear command, today\'s placement')
}
{
  // mercy and grace at the death point: no beckon at all (unchanged); at the rear spot only: no flank, today's placement
  const W = world({})
  const a = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  a.hp = 5
  let r = die(W, 1, 0, 64, 30)
  T.ok(r.placed.length === 0 && r.plans === 0 && r.chains.length === 0 && W.infoCalls === 0, 'mercy at the dying mob: no beckon, no HiveInfo, no probe')
  a.hp = 20
  const mm = W.M.player(W.srv, 'Hurt', 'dddd0000-0000-4000-8000-000000000004', { x: 0, y: 64, z: -32 })
  mm.hp = 5  // 62 blocks from the dying mob (outside its 48-block pacing check), within 48 of every rear spot
  r = die(W, 1, 0, 64, 30)
  T.ok(r.probes === 8 && r.chains.length === 1 && r.placed.length === 1 && at(r.placed[0], 0, 64, 30),
    'a player in mercy behind: all 8 rear spots refused by pneCoreBeckonAt before any command, today\'s placement')
  mm.hp = 20
  mm.addTag('pne_grace')
  mm.getPersistentData().putLong('pne_grace_until', W.srv.gameTime + 1000)
  W.beckons.length = 0
  r = die(W, 1, 0, 64, 30)
  T.ok(r.probes === 8 && r.chains.length === 1 && at(r.placed[0], 0, 64, 30), 'a player in respawn grace behind: no flank, today\'s placement')
  mm.removeTag('pne_grace')
  // PANIC near the rear spot only (the director's Pace: beckon false): no flank
  W.c.pneResPace = function (pl) {
    return { state: pl === mm ? 'PANIC' : 'CALM', spawn: pl === mm ? 0.2 : 1, aggro: 1, beckon: pl !== mm, ga: 1, tier: 'QUIET', e: 0, theta: 0,
      mercy: false, grace: false, tick: W.c.pneCoreTick }
  }
  W.beckons.length = 0
  r = die(W, 1, 0, 64, 30)
  T.ok(r.probes === 8 && r.chains.length === 1 && at(r.placed[0], 0, 64, 30), 'a player in PANIC behind (beckon false): no flank, today\'s placement')
  delete W.c.pneResPace
}
{
  // cooldown, stage and chance are checked before anything flank-related
  const W = world({})
  W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r1 = die(W, 1, 0, 64, 30)
  const calls = W.infoCalls
  const r2 = die(W, 1, 10, 64, 30, { keepCooldown: true })
  T.ok(r1.placed.length === 1 && r2.placed.length === 0 && r2.plans === 0 && r2.chains.length === 0 && W.infoCalls === calls,
    'cooldown: a second death within 100 ticks roots nothing and plans nothing')
  W.M.tick(W.srv, 101)
  W.beckons.length = 0
  const r3 = die(W, 1, 10, 64, 30, { keepCooldown: true })
  T.ok(r3.placed.length === 1 && r3.plans === 1, 'cooldown over after 100 ticks: flanks again')
  W.beckons.length = 0
  const r4 = die(W, 1, 0, 64, 30, { q: [0.09, 0.5] })
  T.ok(r4.placed.length === 0 && r4.plans === 0 && r4.chains.length === 0, 'chance roll 0.09 at stage 10 (chance 9%): nothing')
  const W2 = world({})
  W2.M.player(W2.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  W2.srv.persistentData.putInt('pne_doom_floor', 800) // stage 2
  W2.c.pneHStageCache = {}
  const r5 = die(W2, 1, 0, 64, 30)
  T.ok(r5.placed.length === 0 && r5.plans === 0 && W2.infoCalls === 0, 'stage 2: no reinforcement, no HiveInfo, no probe')
  // beckons, flesh and burst products never root a reinforcement, whatever their FLK
  const W3 = world({})
  W3.M.player(W3.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const r6 = die(W3, 1, 0, 64, 30, { type: 'epca:stage_i_beckon' })
  const r7 = die(W3, 1, 0, 64, 30, { type: 'epca:living_flesh_size2' })
  T.ok(r6.placed.length + r7.placed.length === 0 && r6.plans + r7.plans === 0, 'a dying beckon or living flesh roots nothing, flank or not')
}

// ------------------------------------------------------------------ 4. with the director: the ledger at the flank spot
{
  const W = world({ director: true })
  const a = W.M.player(W.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  a.addTag('pne_comfort_off')
  W.c.pneOraSnap = function () { return { tick: W.c.pneCoreTick, nearest: 32, n16: 0, light: 0, hp: 1, tSinceDmg: 600 } }
  W.M.tick(W.srv, 40)
  T.ok(W.c.pneResPace(a) && W.c.pneResPace(a).beckon === true, 'director: CALM Pace, beckons allowed')
  vm.runInContext('Math.random = function () { return 0.01 }', W.c)
  const r = die(W, 0.7, 0, 64, 30, { q: [] })
  T.ok(r.placed.length === 1 && r.placed[0].z < 0, 'director loaded: FLK 0.7 flanks (draw 0.01)')
  const s = r.placed[0]
  const g = rear(a, 0, s)
  T.ok(g.r >= 24 && g.r <= 40 && g.ang <= 60, 'director loaded: spot ' + g.r.toFixed(2) + ' blocks, ' + g.ang.toFixed(2) + ' degrees off straight behind')
  const bell = r.cmds.filter(x => /^execute as aaaa0000-0000-4000-8000-000000000001 at @s run playsound minecraft:block\.bell\.use hostile @s /.test(x))
  T.ok(bell.length === 1 && bell[0].indexOf(' @s ' + s.x.toFixed(2) + ' 64.00 ' + s.z.toFixed(2) + ' ') > 0, 'the bell goes through the ledger at the beckon\'s spot behind the player')
  T.ok(r.cmds.filter(x => / run playsound /.test(x)).every(x => /^execute as [0-9a-f-]{36} at @s (rotated ~ 0 )?run playsound /.test(x)), 'every /playsound came from the ledger')
  T.ok(!r.cmds.some(x => /^(tp|teleport|spreadplayers|ride) /.test(x) || / run (tp|teleport) /.test(x)), 'nothing moves a player or the camera')
}

T.ok(BAD.length === 0, 'no beckon summon or beckon chain other than the pre-FLK chain word for word, or it without its summon (' + BAD.slice(0, 2).join(' | ') + ')')
T.done()
