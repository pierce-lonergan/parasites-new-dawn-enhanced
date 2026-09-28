// Suite director-gate-parity: the startup gate's multiplier (pne_res_gate.js, pneResGatePlayerMult and
// pneResGateMultAt) must equal the server core's pneCoreNaturalMult / pneCoreNaturalMultAt for every player state
// (contract 3.4: "This is exactly pneCoreNaturalMult / pneCoreNaturalMultAt"). In the game the two files live in
// separate script managers; here both are loaded into one Rhino scope only to compare the formulas on the same
// mock players. Random states cover the mercy tag, health around 30%, live, stale and far-future grace deadlines,
// fresh, stale and future pne_m_t, pne_m outside 0..1, creative and spectator players, and players beyond 48 blocks.
// The level is game-shaped (getTime() only: KubeJS hides getGameTime(), contract F37), and the gate is also driven
// end to end through its PositionCheck handler with Math.random pinned, so the time the handler reads, and its
// deny decision, are compared with the core too (a gate that cannot read the time fails here).
// Files: kjs_mocks.js, pne_00_core.js, pne_res_gate.js, this file. Result: pneGateParResult. ES5.

var pneGateParFails = []
var pneGateParCount = 0

function pneGateParT(cond, msg) {
  pneGateParCount++
  if (!cond && pneGateParFails.length < 10) pneGateParFails.push(msg)
}

// xorshift32, deterministic
var pneGateParS = 20260927

function pneGateParR() {
  var x = pneGateParS
  x ^= x << 13
  x >>>= 0
  x ^= x >>> 17
  x ^= x << 5
  x >>>= 0
  pneGateParS = x
  return x / 4294967296
}

function pneGateParPick(arr) {
  return arr[Math.floor(pneGateParR() * arr.length)]
}

function pneGateParState(p, now) {
  var pd = p.persistentData
  p.hp = pneGateParPick([20, 20, 20, 12, 6.2, 6, 5.9, 1])
  p.creative = pneGateParR() < 0.1
  p.spectator = pneGateParR() < 0.05
  if (pneGateParR() < 0.1) p.addTag('pne_mercy')
  else p.removeTag('pne_mercy')
  if (pneGateParR() < 0.25) p.addTag('pne_grace')
  else p.removeTag('pne_grace')
  pd.putLong('pne_grace_until', now + pneGateParPick([-500, -1, 0, 1, 1200, 2400, 2401, 9000]))
  if (pneGateParR() < 0.6) p.addTag('pne_gate')
  else p.removeTag('pne_gate')
  pd.putDouble('pne_m', pneGateParPick([0, 0.2, 0.5, 0.8, 1, 1.25, -0.3]))
  pd.putLong('pne_m_t', now - pneGateParPick([0, 1, 50, 100, 101, 400, -5]))
  p.x = pneGateParPick([0, 10, 30, 47, 49, 80])
}

// One PositionCheck event for an EPCA mob at x, y, z in level (as NaturalSpawner would fire it).
function pneGateParEvent(srv, level, x, y, z) {
  var mob = __pneMock.mob(srv, 'epca:ripper', { x: x, y: y, z: z })
  var ev = { result: null }
  ev.getEntity = function () { return mob }
  ev.getLevel = function () { return { getLevel: function () { return level } } }
  ev.getX = function () { return x }
  ev.getY = function () { return y }
  ev.getZ = function () { return z }
  ev.setResult = function (r) { ev.result = r }
  return ev
}

function pneGateParRun() {
  var srv = __pneMock.server({ owner: 'Host', gameTime: 50000 })
  var key = 'ForgeEvents.onEvent:net.minecraftforge.event.entity.living.MobSpawnEvent$PositionCheck'
  var ps = []
  var k
  var i
  var now
  var a
  var b
  var r
  var ev
  var same = 0
  var sameAt = 0
  var sameNow = 0
  var sameDeny = 0
  var denies = 0
  var zeros = 0
  var partial = 0
  var rnd = Math.random
  var pinned = 0
  // the level as scripts see it in game: getTime() only (F37)
  srv.level.getTime = function () { return srv.gameTime }
  delete srv.level.getGameTime
  pneGateParT(typeof srv.level.getGameTime === 'undefined', 'the level is game-shaped: no getGameTime() (F37)')
  $PneResGateResult = { DENY: 'DENY' }
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  for (i = 0; i < 3; i++) ps.push(__pneMock.player(srv, 'P' + i, 'aaaa0000-0000-4000-8000-00000000000' + (i + 1), { x: 0 }))
  Math.random = function () { return pinned }
  try {
    for (k = 0; k < 3000; k++) {
      now = pneResGateNow(srv.level)
      if (now === Number(srv.gameTime) && now === pneCoreNow(ps[0])) sameNow++
      else pneGateParT(false, 'clock differs: gate ' + now + ', core ' + pneCoreNow(ps[0]) + ', world ' + srv.gameTime)
      for (i = 0; i < ps.length; i++) pneGateParState(ps[i], now)
      for (i = 0; i < ps.length; i++) {
        a = pneResGatePlayerMult(ps[i], now)
        b = pneCoreNaturalMult(ps[i])
        if (a === b) same++
        else pneGateParT(false, 'player mult differs: gate ' + a + ' vs core ' + b + ' (hp ' + ps[i].hp + ', tags ' + [pneCoreHasTag(ps[i], 'pne_mercy'), pneCoreHasTag(ps[i], 'pne_grace'), pneCoreHasTag(ps[i], 'pne_gate')] + ')')
        if (b === 0) zeros++
        if (b > 0 && b < 1) partial++
      }
      a = pneResGateMultAt(srv.level, 0, 64, 0, now)
      b = pneCoreNaturalMultAt(srv.level, 0, 64, 0, 48)
      if (a === b) sameAt++
      else pneGateParT(false, 'MultAt differs: gate ' + a + ' vs core ' + b)
      // end to end: the handler reads the clock itself and denies iff random >= the core's multiplier
      r = pneGateParR()
      pinned = r
      ev = pneGateParEvent(srv, srv.level, 0, 64, 0)
      __pneMock.fire(key, ev)
      if ((ev.result === 'DENY') === (r >= b)) sameDeny++
      else pneGateParT(false, 'handler decision differs: ' + ev.result + ' with random ' + r.toFixed(3) + ' and core m ' + b)
      if (ev.result === 'DENY') denies++
      srv.gameTime += 7
    }
  } finally {
    Math.random = rnd
  }
  pneGateParT(sameNow === 3000, 'gate clock (getTime) = core clock in ' + sameNow + '/3000 steps')
  pneGateParT(same === 9000, 'per-player multiplier identical in ' + same + '/9000 states')
  pneGateParT(sameAt === 3000, 'lowest multiplier within 48 blocks identical in ' + sameAt + '/3000 states')
  pneGateParT(sameDeny === 3000, 'PositionCheck handler decision = (random >= core multiplier) in ' + sameDeny + '/3000 events')
  pneGateParT(denies > 500 && denies < 2500, 'the handler both denied and allowed (' + denies + '/3000 denied)')
  pneGateParT(zeros > 1000 && partial > 500, 'the states cover m = 0 (' + zeros + ') and 0 < m < 1 (' + partial + ')')
  pneGateParT(pneResGateErrors === 0 && pneResGateTimeFails === 0, 'no gate errors, clock always readable (' + pneResGateErrors + ', ' + pneResGateTimeFails + ')')
  return same + '/9000 player states, ' + sameAt + '/3000 positions, ' + sameDeny + '/3000 handler decisions'
}

var pneGateParResult = 'FAIL not run'
try {
  var pneGateParInfo = pneGateParRun()
  pneGateParResult = pneGateParFails.length ? 'FAIL ' + pneGateParFails.length + '/' + pneGateParCount + ': ' + pneGateParFails.join(' | ') : 'PASS ' + pneGateParCount + ' checks: gate formula = core formula on ' + pneGateParInfo
} catch (err) {
  pneGateParResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
