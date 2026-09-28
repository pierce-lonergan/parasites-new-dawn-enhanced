// Suite director-horror-rhino: the edited pne_horror.js in the instance's real Rhino jar together with the core
// and the director (empty catalog): it loads, a parasite death routes its gore slam through the ledger, Hive Night
// routes the heartbeat through the ledger at the housekeeping slot, night aggression skips pne_pace_soft, and
// pneHStage keeps working. The FLK flank placement of a reinforcement beckon (TDD 3.1 gene 4) runs here too: in Rhino
// Math.PI is undefined (F26), so this checks the rear-arc spot is finite, 24-40 blocks away and inside the rear
// 120 degrees of getYaw() (F37) also when the mob died off to the player's side, that the light is read at the
// player's feet block, that high block light keeps today's placement, and that a kill within 24 blocks of the
// player moves nothing (today's chain without its summon refuses there).
// Files: kjs_mocks.js, pne_00_core.js, fixtures/empty_catalog.js, pne_resonance.js, pne_horror.js, this file.
// Result: pneHorrorResult. ES5.

var pneHorFails = []
var pneHorCount = 0

// HIVE's pneHiveInfo, stubbed for the flank scenario: only mobs that scenario marks carry an expressed FLK.
var pneHorFlkOn = false
function pneHiveInfo(entity) {
  if (!pneHorFlkOn || entity.flk === undefined) return null
  return { g: '00000000000000000000000000000000000000000000000000000000', clade: 0, sil: false, apex: false,
    e: [0, 0, 0, 0, entity.flk, 0, 0, 0, 0, 0, 0, 0, 0, 0], strain: 'epca', flk: entity.flk }
}

function pneHorT(cond, msg) {
  pneHorCount++
  if (!cond) pneHorFails.push(msg)
}

function pneHorFind(srv, from, needle) {
  var n = 0
  var i
  for (i = from; i < srv.cmds.length; i++) {
    if (String(srv.cmds[i]).indexOf(needle) >= 0) n++
  }
  return n
}

function pneHorRun() {
  var srv = __pneMock.server({})
  var p = __pneMock.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 2 })
  var n0
  var i
  var bad = 0
  var run = srv.runCommandSilent
  srv.level.getDayTime = function () { return 6000 }
  // the mock server cannot run the two Hive Night tag commands; emulate them on the mock players
  srv.runCommandSilent = function (cmd) {
    var c = String(cmd)
    if (c === 'execute if entity @a[tag=pne_horde,tag=!pne_horde_told]') {
      srv.cmds.push(c)
      return (pneCoreHasTag(p, 'pne_horde') && !pneCoreHasTag(p, 'pne_horde_told')) ? 1 : 0
    }
    if (c === 'tag @a[tag=pne_horde,tag=!pne_horde_told] add pne_horde_told') {
      srv.cmds.push(c)
      if (pneCoreHasTag(p, 'pne_horde')) p.addTag('pne_horde_told')
      return 1
    }
    return run(cmd)
  }
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  p.addTag('pne_comfort_off')
  pneHorT(typeof pneHStage === 'function' && typeof pneHEmitAt === 'function', 'pne_horror.js loaded in Rhino')
  pneHorT(pneHDim(p) === 'minecraft:overworld', 'dimension through getLevel(), not the level() method object')
  srv.persistentData.putInt('pne_doom_floor', 20000)
  pneHorT(pneHStage(srv, pneHLevel(p), 'minecraft:overworld') === 4, 'pneHStage from the stored doom floor (stage 4)')
  pneHorT(pneCoreStage(srv.level) === 4, 'pneCoreStage wraps pneHStage')
  __pneMock.tick(srv, 40)
  n0 = srv.cmds.length
  __pneMock.fire('EntityEvents.death', { entity: __pneMock.mob(srv, 'epca:ripper', { x: 0, y: 64, z: 0 }), source: __pneMock.damage('mob', p) })
  pneHorT(pneHorFind(srv, n0, 'execute as aaaa0000-0000-4000-8000-000000000001 at @s run playsound epca:slam hostile @s 0.00 64.60 0.00 0.70 0.70') === 1, 'gore slam through the ledger')
  pneHorT(pneHorFind(srv, n0, 'execute in minecraft:overworld positioned 0.00 64.60 0.00 run particle') === 2, 'gore particles at the right place')
  __pneMock.tick(srv, 500)   // past the slam's LF rest window (one LF source at a time, rest >= 2x)
  p.addTag('pne_horde')
  n0 = srv.cmds.length
  __pneMock.tick(srv, 400)
  pneHorT(pneHorFind(srv, n0, 'run playsound spore:heart_beat hostile @s ~ ~ ~ ') >= 1, 'Hive Night heartbeat through the ledger (volume set by the ledger)')
  pneHorT(pneHorFind(srv, n0, 'run playsound epca:beckon_stage2 hostile @s ~ ~ ~') >= 1, 'horde call through the ledger')
  for (i = 0; i < srv.cmds.length; i++) {
    if (String(srv.cmds[i]).indexOf(' playsound ') >= 0 && String(srv.cmds[i]).indexOf('execute as ') !== 0) bad++
  }
  pneHorT(bad === 0, 'every /playsound came from the ledger (' + bad + ' others)')
  pneHorT(PNE_H_SURVIVORS.indexOf('tag=!pne_pace_soft') > 0, 'PNE_H_SURVIVORS excludes pne_pace_soft')
  pneHorT(pneHBroken === 0, 'horror tick loop healthy')
}

// A genome mob with FLK 0.8 dies about 30 blocks from a player on flat grass. The block light is 0 only in the
// player's feet block (0 64 0) and 12 everywhere else (the mob, the eyes, the spots). The chain and its test (the
// chain without its summon) are modelled for the 24-block rule, the only rule this scenario can break.
function pneHorFlank() {
  var srv = __pneMock.server({})
  var p = __pneMock.player(srv, 'Flank', 'aaaa0000-0000-4000-8000-00000000000f', { x: 0.5, y: 64, z: 0.5 })
  var spots = []
  var tests = []
  var feetDark = true
  var rnd = Math.random
  var seq
  var run = srv.runCommandSilent
  var mob
  var s
  var r
  var cosA
  var head = /^execute in minecraft:overworld positioned (\S+) (\S+) (\S+) run execute if entity @a\[distance=\.\.64,gamemode=!spectator,gamemode=!creative\] unless entity @a\[distance=\.\.24\] /
  srv.level.getBlock = function (x, y, z) {
    var solid = y <= 63
    var feet = x === 0 && y === 64 && z === 0
    return {
      getBlockState: function () { return { isSolid: function () { return solid }, isAir: function () { return !solid } } },
      getBlockLight: function () { return feet === feetDark ? 0 : 12 },
      hasTag: function (t) { return solid && String(t) === 'pne:beckon_ground' }
    }
  }
  function far(m) {
    var dx = Number(m[1]) - p.x
    var dy = Number(m[2]) - p.y
    var dz = Number(m[3]) - p.z
    return Math.sqrt(dx * dx + dy * dy + dz * dz) > 24 ? 1 : 0
  }
  srv.runCommandSilent = function (cmd) {
    var c = String(cmd)
    var m = head.exec(c)
    if (m && / if block ~ ~-1 ~ #pne:beckon_ground run summon epca:stage_i_beckon ~ ~ ~ \{Tags:\["pne_called"\]\}$/.test(c)) {
      srv.cmds.push(c)
      if (!far(m)) return 0
      spots.push({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) })
      return 1
    }
    if (m && / if block ~ ~-1 ~ #pne:beckon_ground$/.test(c)) {
      srv.cmds.push(c)
      tests.push({ x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) })
      return far(m)
    }
    return run(cmd)
  }
  function die(x, z, draws) {
    seq = draws
    pneHBeckonReadyAt = 0
    mob = __pneMock.mob(srv, 'epca:ripper', { x: x, y: 64, z: z })
    mob.flk = 0.8
    __pneMock.fire('EntityEvents.death', { entity: mob, source: __pneMock.damage('mob', p) })
  }
  // cos of the angle between spot s and straight behind a player facing yaw (sy, cy = sin yaw, cos yaw)
  function rearCos(s, sy, cy) {
    var dx = s.x - p.x
    var dz = s.z - p.z
    return (dx * sy - dz * cy) / Math.sqrt(dx * dx + dz * dz)
  }
  function dist(s) {
    return Math.sqrt((s.x - p.x) * (s.x - p.x) + (s.z - p.z) * (s.z - p.z))
  }
  srv.persistentData.putInt('pne_doom_floor', 1800000000)
  pneHStageCache = {}
  pneHorFlkOn = true
  Math.random = function () { return seq.length ? seq.shift() : 0.5 }
  try {
    // 1. facing yaw 30, the mob dies in front: draws are the chance roll, the spawn count, the FLK draw, then the
    // probe's angle and distance
    p.yaw = 30
    die(-14.5, 26.5, [0, 0.5, 0.2, 0.9, 0.3])
    pneHorT(spots.length === 1 && tests.length === 1, 'flank: one test at the mob, one beckon chain ran (' + tests.length + ', ' + spots.length + ')')
    if (spots.length === 1) {
      s = spots[0]
      r = dist(s)
      // straight behind a player facing yaw 30 is (sin 30, -cos 30) = (0.5, -0.8660254037844386)
      cosA = rearCos(s, 0.5, 0.8660254037844386)
      pneHorT(isFinite(s.x) && isFinite(s.z) && s.y === 64, 'flank: the spot is finite and on the ground (' + s.x + ' ' + s.y + ' ' + s.z + ')')
      pneHorT(r >= 24 && r <= 40, 'flank: 24-40 blocks from the player (' + r + ')')
      pneHorT(cosA >= 0.5, 'flank: inside the rear 120 degrees of getYaw() (cos ' + cosA + ')')
    }
    pneHorT(pneHFlkStats.placed === 1 && pneHFlkStats.errors === 0, 'flank: placed, no error in Rhino (dark at the feet block only)')
    // 2. facing yaw 120 (straight behind is (sin 120, -cos 120) = (0.866, 0.5)), the same mob 90 degrees off the facing,
    // probe angle draw 0.5 (straight behind): behind the facing, not away from the mob
    p.yaw = 120
    die(-14.5, 26.5, [0, 0.5, 0.2, 0.5, 0.3])
    pneHorT(spots.length === 2, 'off-axis: a beckon chain ran (' + spots.length + ')')
    if (spots.length === 2) {
      s = spots[1]
      cosA = rearCos(s, 0.8660254037844386, -0.5)
      pneHorT(cosA >= 0.99 && dist(s) >= 24 && dist(s) <= 40, 'off-axis: straight behind getYaw() 120, not away from the mob (cos ' + cosA + ')')
    }
    // 3. lit at the feet block only: today's placement at the dying mob, no FLK draw, no test
    feetDark = false
    p.yaw = 30
    die(-14.5, 26.5, [0, 0.5])
    pneHorT(spots.length === 3 && spots[2].x === -14.5 && spots[2].z === 26.5 && tests.length === 2, 'block light 12 at the feet: today\'s placement at the dying mob')
    pneHorT(pneHFlkStats.plans === 2, 'block light 12 at the feet: no third flank plan')
    // 4. dark again, a kill 3 blocks in front: today's chain refuses (a player within 24), so nothing moves
    feetDark = true
    die(0.5, 3.5, [0, 0.5, 0.2, 0.5, 0.3])
    pneHorT(spots.length === 3 && tests.length === 3 && pneHFlkStats.plans === 2 && pneHFlkStats.refused === 1,
      'a kill 3 blocks away: the test refuses, no flank, no beckon')
  } finally {
    Math.random = rnd
    pneHorFlkOn = false
  }
}

var pneHorrorResult = 'FAIL not run'
try {
  pneHorRun()
  pneHorFlank()
  pneHorrorResult = pneHorFails.length ? 'FAIL ' + pneHorFails.length + '/' + pneHorCount + ': ' + pneHorFails.join(' | ') : 'PASS ' + pneHorCount
} catch (err) {
  pneHorrorResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
