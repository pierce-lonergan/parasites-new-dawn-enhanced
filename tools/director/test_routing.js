// Suite director-routing (docs/IMPLEMENTATION.md 3.2.1 and 9.4): no playsound command string is left in
// pne_horror.js, every sound it makes goes through pneCoreEmit / pneCoreEmitAt with the contract's flags, night
// aggression skips pne_pace_soft, scripted spawns use the pacing multipliers, and pneHStage is unchanged. Static
// checks on the file text, then the real file on the KubeJS mocks with the core and the director.
//
//   node tools/director/test_routing.js
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const P = require('./pack.js')

const T = P.checker('director-routing')
const src = fs.readFileSync(path.join(P.ROOT, P.HORROR), 'utf8')

// ------------------------------------------------------------------ static
T.ok(!/playsound/i.test(src), 'no "playsound" anywhere in pne_horror.js')
T.ok(!/pneHWhisper|PNE_H_WHISPERS|pneHNextWhisperAt/.test(src), 'old whisper pool retired')
T.ok(/var PNE_H_SURVIVORS = .*gamemode=!creative,tag=!pne_pace_soft\] at @s run '/.test(src), 'PNE_H_SURVIVORS gains tag=!pne_pace_soft')
const want = [
  [/pneHEmitAt\(server, where, 24, 'epca:slam', 'hostile', 0\.7, \{ pitch: 0\.7, lf: true, cls: 'slam', src: 'horror' \}\)/, 'gore slam: positional, lf, cls slam'],
  [/pneHEmitAt\(server, where, 20, 'minecraft:entity\.slime\.squish_small', 'hostile', 1, \{ pitch: 0\.5, cls: 'squish', src: 'horror' \}\)/, 'Mobs Inside squish: positional'],
  [/pneHEmitAt\(server, where, 96, 'minecraft:block\.bell\.use', 'hostile', 4, \{ pitch: 0\.5, cls: 'bell', src: 'horror' \}\)/, 'beckon bell: positional, cls bell'],
  [/pneHEmitAt\(server, where, 48, 'epca:beckon_stage1', 'hostile', 1\.5, \{ pitch: 0\.8, cls: 'beckon', src: 'horror' \}\)/, 'beckon stage 1: positional, cls beckon'],
  [/pneHEmitPlayer\(fresh\[i\], 'epca:beckon_stage2', 'hostile', '~ ~ ~', 1, \{ pitch: 0\.6, cls: 'beckon2', src: 'horror' \}\)/, 'horde call (beckon stage 2): per player'],
  [/pneHEmitPlayer\(horde\[i\], 'spore:heart_beat', 'hostile', '~ ~ ~', 0\.45, \{ pitch: 0\.9, lf: true, cls: 'hive_heartbeat', src: 'horror' \}\)/, 'Hive Night heartbeat: per horde player, lf, cls hive_heartbeat'],
  [/pneHEmitPlayer\(horde\[i\], 'epca:infested_enderman_scream', 'hostile', '\^ \^2 \^-24', 2,\s*\{ pitch: 0\.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' \}\)/, 'scream: per horde player, stinger, rotated, cls scream']
]
for (const [rx, what] of want) T.ok(rx.test(src), 'routing: ' + what)
T.ok(/return pneCoreEmit\(player, event, category, pos, vol, meta\)/.test(src) && /return pneCoreEmitAt\(server, where\.dim, where\.x, where\.y, where\.z, radius, event, category, vol, meta\)/.test(src), 'helpers call the core wrappers (pneCoreEmit / pneCoreEmitAt)')
const origStage = [
  'function pneHStage(server, level, dim) {',
  '  var c = pneHStageCache[dim]',
  '  if (c && pneHTick - c.at < 600) return c.stage',
  '  var stage = -99',
  '  if ($PneHEvolutionManager && level) {',
  '    try { stage = Number($PneHEvolutionManager.getStageForDimension(level)) } catch (e) { stage = -99 }',
  '  }',
  '  if (!isFinite(stage)) stage = -99',
  '  if (stage === -99 && dim === PNE_H_OVERWORLD) {',
  "    try { stage = pneHStageFromPoints(Number(server.persistentData.getInt('pne_doom_floor'))) } catch (e2) { stage = -99 }",
  '  }',
  '  pneHStageCache[dim] = { stage: stage, at: pneHTick }',
  '  return stage',
  '}'
].join('\n')
T.ok(src.replace(/\r\n/g, '\n').indexOf(origStage) >= 0, 'pneHStage(server, level, dim) kept byte for byte')
T.ok(/pneCoreSlot === PNE_CORE_SLOT_HOUSE/.test(src) && /pneHTick % 20 === 0/.test(src), '1 Hz gate on the core housekeeping slot, own counter as the fallback')

// ------------------------------------------------------------------ behaviour
function world () {
  const c = P.load([P.MOCKS, P.CORE, P.TEST_CAT, P.RES, P.HORROR])
  const M = c.__pneMock
  const srv = M.server({ owner: 'Host' })
  srv.level.getDayTime = () => 6000
  M.fire('ServerEvents.loaded', { server: srv })
  const run = srv.runCommandSilent
  srv.runCommandSilent = function (cmd) {
    const s = String(cmd)
    if (/if entity @(a\[tag=pne_horde,distance=\.\.64\]|e\[type=#pne:flesh,distance=\.\.24\]|e\[tag=pne_burst,type=!#pne:flesh,distance=\.\.24\])$/.test(s)) { srv.cmds.push(s); return 0 }
    if (s === 'time query daytime') { srv.cmds.push(s); return 18000 }
    // emulate the two Hive Night tag commands the mock server cannot run
    if (s === 'execute if entity @a[tag=pne_horde,tag=!pne_horde_told]') {
      srv.cmds.push(s)
      return srv.players.filter(p => p.tagSet.pne_horde && !p.tagSet.pne_horde_told).length
    }
    if (s === 'tag @a[tag=pne_horde,tag=!pne_horde_told] add pne_horde_told') {
      srv.cmds.push(s)
      srv.players.forEach(p => { if (p.tagSet.pne_horde) p.addTag('pne_horde_told') })
      return 1
    }
    return run(cmd)
  }
  return { c, M, srv }
}
function rand (c, v) { vm.runInContext('Math.random = function () { return ' + v + ' }', c) }
const onlyLedger = cmds => cmds.filter(x => / run playsound /.test(x)).every(x => /^execute as [0-9a-f-]{36} at @s (rotated ~ 0 )?run playsound /.test(x))

{
  const { c, M, srv } = world()
  const a = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 2 })
  const b = M.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: -3 })
  b.addTag('pne_comfort_off')
  c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600 } }
  srv.persistentData.putInt('pne_doom_floor', 1800000000)
  M.tick(srv, 40)
  T.ok(c.pneResPace(a) && c.pneResPace(a).state === 'CALM' && c.pneResPace(b).beckon === true, 'both players have a CALM Pace (beckons allowed)')
  // a host dies next to both: gore slam per player through the ledger, Mobs Inside burst, beckon with its bell
  rand(c, 0.01)
  let n0 = srv.cmds.length
  const host = M.mob(srv, 'epca:infested_zombie', { x: 0, y: 64, z: 0 })
  M.fire('EntityEvents.death', { entity: host, source: M.damage('mob', a) })
  let cmds = srv.cmds.slice(n0)
  T.ok(cmds.some(x => x.indexOf('execute in minecraft:overworld positioned 0.00 64.60 0.00 run particle') === 0), 'gore particles keep their position (dimension resolved through getLevel(), not "undefined")')
  const slams = cmds.filter(x => x.indexOf('playsound epca:slam hostile @s 0.00 64.60 0.00') > 0)
  T.eq(slams.length, 2, 'gore slam: one ledger /playsound per player within 24 blocks')
  T.ok(slams.some(x => /0\.35 0\.70$/.test(x)) && slams.some(x => /0\.70 0\.70$/.test(x)), 'comfort player gets the slam at 0.35, the opted-out player at 0.70')
  T.eq(cmds.filter(x => x.indexOf('summon epca:living_flesh_size0') > 0).length, 2, 'Mobs Inside: pneCoreSpawnCount(2, 1.25) products at CALM (random 0.01)')
  T.ok(cmds.some(x => x.indexOf('playsound minecraft:entity.slime.squish_small hostile @s 0.00 64.60 0.00') > 0), 'Mobs Inside squish through the ledger')
  T.ok(cmds.some(x => x.indexOf('run summon epca:stage_i_beckon') > 0), 'beckon summoned when every nearby player may have one')
  T.ok(onlyLedger(cmds), 'every /playsound came from the ledger (execute as <uuid> at @s ... @s ...)')
  // a non-host parasite (no Mobs Inside burst): slam then beckon bell and call, all through the ledger
  M.tick(srv, 1400)
  n0 = srv.cmds.length
  M.fire('EntityEvents.death', { entity: M.mob(srv, 'epca:ripper', { x: 0, y: 64, z: 4 }), source: M.damage('mob', a) })
  cmds = srv.cmds.slice(n0)
  T.eq(cmds.filter(x => x.indexOf('playsound minecraft:block.bell.use hostile @s 0.00 64.00 4.00') > 0).length, 2, 'beckon bell through the ledger at the ground position, for both players')
  T.ok(cmds.filter(x => x.indexOf('playsound epca:beckon_stage1 hostile @s 0.00 64.00 4.00') > 0).length >= 1, 'beckon stage-1 call through the ledger')
  T.ok(onlyLedger(cmds), 'beckon: every /playsound came from the ledger')
  T.ok(!cmds.some(x => /playsound [^ ]+ hostile @a/.test(x)), 'no broadcast @a /playsound left')
  // a player in mercy nearby: no burst products, no beckon
  a.hp = 5
  M.tick(srv, 20)
  M.tick(srv, 100)
  n0 = srv.cmds.length
  M.fire('EntityEvents.death', { entity: M.mob(srv, 'epca:infested_zombie', { x: 1, y: 64, z: 1 }), source: M.damage('mob', a) })
  cmds = srv.cmds.slice(n0)
  T.eq(cmds.filter(x => x.indexOf('summon epca:living_flesh_size0') > 0 || x.indexOf('summon epca:mozzie') > 0).length, 0, 'mercy nearby: Mobs Inside makes nothing (multiplier 0)')
  T.eq(cmds.filter(x => x.indexOf('summon epca:stage_i_beckon') > 0).length, 0, 'mercy nearby: no beckon (pneCoreBeckonAt false)')
  T.eq(cmds.filter(x => x.indexOf('squish_small') > 0).length, 0, 'mercy nearby: the skipped burst makes no sound')
  a.hp = 20
  M.tick(srv, 1400) // let the LF rest windows after the slams expire
  // Hive Night at the housekeeping slot: horde call, heartbeat, scream (normal-mode player only); night aggression
  a.addTag('pne_horde'); b.addTag('pne_horde')
  rand(c, 0.1)
  n0 = srv.cmds.length
  M.tick(srv, 600)
  cmds = srv.cmds.slice(n0)
  T.ok(cmds.filter(x => x.indexOf('playsound epca:beckon_stage2 hostile @s ~ ~ ~') > 0).length === 2, 'horde call per horde player through the ledger')
  // The ledger may lower the requested 0.45 (contract 3.2: "May lower vol"): here the normal-mode player's heartbeat
  // follows the horde call by one second, so the +10 LU / 3 s level-jump limit turns it down. Pitch is never changed.
  const hbRx = /playsound spore:heart_beat hostile @s ~ ~ ~ (\d+\.\d\d) 0\.90$/
  const hb = cmds.filter(x => hbRx.test(x))
  T.ok(hb.length >= 2 && new Set(hb.map(x => x.slice(11, 47))).size === 2, 'Hive Night heartbeat per horde player through the ledger (' + hb.length + ')')
  T.ok(hb.every(x => Number(hbRx.exec(x)[1]) > 0 && Number(hbRx.exec(x)[1]) <= 0.45), 'Hive Night heartbeat never louder than the requested 0.45 (' + hb.map(x => hbRx.exec(x)[1]).join(', ') + ')')
  T.ok(hb.some(x => /0\.45 0\.90$/.test(x)), 'the comfort player (quieter horde call) hears the heartbeat at the full 0.45')
  const sc = cmds.filter(x => x.indexOf('playsound epca:infested_enderman_scream') > 0)
  T.ok(sc.length >= 1 && sc.every(x => x.indexOf('execute as bbbb0000') === 0 && x.indexOf('rotated ~ 0 run') > 0), 'scream only for the opted-out player, rotated ~ 0 (comfort skips stingers)')
  T.ok(cmds.some(x => x.indexOf('gamemode=!creative,tag=!pne_pace_soft] at @s run effect give @e[type=#pne:hive') >= 0), 'night aggression selector excludes pne_pace_soft')
  T.ok(onlyLedger(cmds), 'Hive Night: every /playsound came from the ledger')
  const ticks = srv.cmds.slice(n0).filter(x => x.indexOf('scoreboard players add @a[tag=pne_horde] pne_horde_age 20') === 0).length
  T.eq(ticks, 30, 'horror 1 Hz loop ran once per second (30 runs in 600 ticks) on the housekeeping slot')
}

// Without the core the horror file still loads and runs; its sounds are skipped (no playsound left to fall back on)
{
  const c = P.load([P.MOCKS, P.HORROR])
  const M = c.__pneMock
  const srv = M.server({})
  M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  M.tick(srv, 100)
  M.fire('EntityEvents.death', { entity: M.mob(srv, 'epca:ripper', { x: 0, y: 64, z: 0 }), source: M.damage('mob', null) })
  T.ok(srv.cmds.some(x => x.indexOf('particle') > 0) && !srv.cmds.some(x => /playsound/.test(x)), 'no core: gore particles still run, sounds are skipped')
  T.ok(!c.__logs.some(x => /failed/.test(x)), 'no core: no handler failures (' + c.__logs.filter(x => /failed/.test(x)).slice(0, 2).join(' | ') + ')')
}

T.done()
