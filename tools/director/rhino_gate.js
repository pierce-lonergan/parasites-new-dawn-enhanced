// Suite director-gate: the startup natural-spawn gate (overrides/kubejs/startup_scripts/pne_res_gate.js) in the
// instance's real Rhino jar, where global is a real java.util.HashMap and every value read back from it is a
// wrapped Java object (contract F6). Files, in order: kjs_mocks.js, pne_res_gate.js, this file.
// Result: pneGateResult ('PASS n' or 'FAIL ...'). ES5.
//
// Covers contract 3.4: spawn_gate 0 in global switches the gate off (and absent counts as on); only EPCA and Spore
// mobs, never the beckons; mercy tag, low health and live grace deny every spawn; a stale pne_grace (deadline
// passed) or a stale pne_gate (pne_m_t older than 100 ticks) does not gate; a fresh pne_gate denies with
// probability 1 - pne_m; creative/spectator players and players beyond 48 blocks do not count; the lowest m of
// the players in range wins; a level that cannot be resolved (world generation) never denies; errors never throw.
//
// The level is game-shaped: KubeJS shows Level.getGameTime() to scripts only as getTime() (contract F37), so the
// mock level used here has getTime() and no getGameTime(). A gate that reads getGameTime() first gets no time and
// fails this suite (live grace would not deny). A mock-shaped level (getGameTime() only) must still work, and a
// level with no readable clock must still gate mercy and low health, fail open only for grace and pne_gate, and
// report it once as '[pne_res_gate] spawn gate failed' without tripping the error limit.

var pneGateFails = []
var pneGateCount = 0

function pneGateT(cond, msg) {
  pneGateCount++
  if (!cond) pneGateFails.push(msg)
}

function pneGateEvent(mob, level, x, y, z) {
  var ev = { result: null }
  ev.getEntity = function () { return mob }
  ev.getLevel = function () { return level === null ? { getLevel: function () { throw new Error('WorldGenRegion') } } : { getLevel: function () { return level } } }
  ev.getX = function () { return x }
  ev.getY = function () { return y }
  ev.getZ = function () { return z }
  ev.setResult = function (r) { ev.result = r }
  return ev
}

// Fraction of denied spawns over n events at (x, y, z) for a mob type.
function pneGateRate(srv, type, n, x, y, z, level) {
  var denied = 0
  var i
  var ev
  for (i = 0; i < n; i++) {
    ev = pneGateEvent(__pneMock.mob(srv, type, { x: x, y: y, z: z }), level === undefined ? srv.level : level, x, y, z)
    __pneMock.fire('ForgeEvents.onEvent:net.minecraftforge.event.entity.living.MobSpawnEvent$PositionCheck', ev)
    if (ev.result === 'DENY') denied++
  }
  return denied / n
}

// A level as the game hands it to scripts: getTime() only (F37).
function pneGateGameLevel(srv) {
  srv.level.getTime = function () { return srv.gameTime }
  delete srv.level.getGameTime
  return srv.level
}

function pneGateRun() {
  var srv = __pneMock.server({})
  var p = __pneMock.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  var r
  var now
  var key = 'ForgeEvents.onEvent:net.minecraftforge.event.entity.living.MobSpawnEvent$PositionCheck'
  pneGateGameLevel(srv)
  pneGateT(typeof srv.level.getGameTime === 'undefined' && typeof srv.level.getTime === 'function', 'the level is game-shaped: getTime() only (F37)')
  pneGateT(pneResGateNow(srv.level) === Number(srv.gameTime), 'game time read through getTime()')
  pneGateT((__pneMock.handlers[key] || []).length === 1, 'registered on MobSpawnEvent$PositionCheck (not checkSpawn)')
  pneGateT((__pneMock.handlers['EntityEvents.checkSpawn'] || []).length === 0, 'EntityEvents.checkSpawn not used')
  // Event$Result is not on the harness classpath; the gate looked it up once at load and got null
  pneGateT($PneResGateResult === null, 'Event$Result lookup guarded (null here)')
  pneGateT(pneGateRate(srv, 'epca:ripper', 20, 5, 64, 0) === 0, 'without Event$Result the gate never denies')
  $PneResGateResult = { DENY: 'DENY' }
  now = Number(srv.gameTime)

  // baseline: nobody vulnerable, no gate tag -> m = 1, never denied
  pneGateT(pneGateRate(srv, 'epca:ripper', 200, 5, 64, 0) === 0, 'm = 1: no denial')
  // mercy tag
  p.addTag('pne_mercy')
  pneGateT(pneGateRate(srv, 'epca:ripper', 200, 5, 64, 0) === 1, 'pne_mercy: every EPCA spawn denied')
  pneGateT(pneGateRate(srv, 'spore:knight', 200, 5, 64, 0) === 1, 'pne_mercy: every Spore spawn denied')
  pneGateT(pneGateRate(srv, 'epca:stage_i_beckon', 50, 5, 64, 0) === 0 && pneGateRate(srv, 'epca:stage_ii_beckon', 50, 5, 64, 0) === 0, 'beckons are never gated')
  pneGateT(pneGateRate(srv, 'minecraft:zombie', 50, 5, 64, 0) === 0, 'non-parasites are never gated')
  pneGateT(pneGateRate(srv, 'epca:ripper', 50, 60, 64, 0) === 0, 'players beyond 48 blocks do not count')
  pneGateT(pneGateRate(srv, 'epca:ripper', 50, 5, 64, 0, null) === 0, 'unresolvable level (world generation): no denial')
  // spawn_gate 0 in global: the stored 0 comes back as a wrapped Double; the gate must still see it as off
  global.pneCfgSpawnGate = 0
  pneGateT(typeof global.pneCfgSpawnGate === 'object' || Number(global.pneCfgSpawnGate) === 0, 'global value readable')
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 0, 'spawn_gate 0 in global switches the gate off')
  global.pneCfgSpawnGate = 1
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 1, 'spawn_gate 1: gate on again')
  global.remove('pneCfgSpawnGate')
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 1, 'absent spawn_gate counts as on')
  // creative players do not count
  p.creative = true
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 0, 'a creative player in mercy does not gate')
  p.creative = false
  p.removeTag('pne_mercy')
  // low health without the tag (health at impact of the check)
  p.hp = 6
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 1, 'health <= 30% denies even before upkeep sets pne_mercy')
  p.hp = 20
  // grace: live vs stale deadline
  p.addTag('pne_grace')
  p.persistentData.putLong('pne_grace_until', now + 1000)
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 1, 'live grace denies')
  p.persistentData.putLong('pne_grace_until', now - 1)
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 0, 'stale pne_grace (deadline passed) does not gate')
  p.persistentData.putLong('pne_grace_until', now + 5000)
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 0, 'a grace deadline more than 2400 ticks ahead is not trusted')
  p.removeTag('pne_grace')
  // pne_gate freshness and the probability 1 - m
  p.addTag('pne_gate')
  p.persistentData.putDouble('pne_m', 0)
  p.persistentData.putLong('pne_m_t', now - 101)
  pneGateT(pneGateRate(srv, 'epca:ripper', 200, 5, 64, 0) === 0, 'stale pne_gate (pne_m_t 101 ticks old) does not gate')
  p.persistentData.putLong('pne_m_t', now - 100)
  pneGateT(pneGateRate(srv, 'epca:ripper', 200, 5, 64, 0) === 1, 'fresh pne_gate with pne_m 0 denies every spawn')
  p.persistentData.putLong('pne_m_t', now + 5)
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0) === 0, 'a pne_m_t in the future is not fresh')
  p.persistentData.putLong('pne_m_t', now - 20)
  p.persistentData.putDouble('pne_m', 0.5)
  r = pneGateRate(srv, 'epca:ripper', 4000, 5, 64, 0)
  pneGateT(r > 0.45 && r < 0.55, 'pne_m 0.5: about half denied (' + r.toFixed(3) + ')')
  p.persistentData.putDouble('pne_m', 1.7)
  pneGateT(pneGateRate(srv, 'epca:ripper', 200, 5, 64, 0) === 0, 'pne_m above 1 is clamped: multipliers never add spawns')
  p.persistentData.putDouble('pne_m', 0.8)
  // lowest m of the players in range wins
  var q = __pneMock.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: 20 })
  q.addTag('pne_mercy')
  pneGateT(pneGateRate(srv, 'epca:ripper', 200, 10, 64, 0) === 1, 'the lowest multiplier among players in range wins')
  q.removeTag('pne_mercy')
  // entity type as an EntityType object (pre-shadowing shape): parsed from getEncodeId()
  __pneMock.opts.typeAsObject = true
  p.persistentData.putDouble('pne_m', 0)
  pneGateT(pneGateRate(srv, 'epca:ripper', 50, 5, 64, 0) === 1, 'type id from getEncodeId() when entity.type is an object')
  __pneMock.opts.typeAsObject = false
  // a throwing event is counted, never thrown
  __pneMock.fire(key, { getEntity: function () { throw new Error('boom') } })
  pneGateT(pneResGateErrors === 1 && pneResGateOff === false, 'errors are counted, the gate stays on below 20')
  pneGateClock(srv, p)
}

// The clock: getGameTime() as the mock fallback, then a level whose time cannot be read at all.
function pneGateClock(srv, p) {
  var mockLevel = { players: function () { return srv.level.players() }, getGameTime: function () { return srv.gameTime } }
  var noClock = { players: function () { return srv.level.players() } }
  var badClock = {
    players: function () { return srv.level.players() },
    getTime: function () { throw new Error('no time') },
    getGameTime: function () { return 'soon' }
  }
  var now = Number(srv.gameTime)
  var err0 = pneResGateErrors
  var warns = []
  var con = console
  p.persistentData.putDouble('pne_m', 1)
  p.removeTag('pne_gate')
  p.removeTag('pne_mercy')
  p.hp = 20
  // mock-shaped level: getGameTime() only
  pneGateT(pneResGateNow(mockLevel) === now, 'getGameTime() is the fallback when getTime() is missing (mock levels)')
  p.addTag('pne_grace')
  p.persistentData.putLong('pne_grace_until', now + 1000)
  pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0, mockLevel) === 1, 'live grace denies through the getGameTime() fallback')
  pneGateT(pneResGateTimeFails === 0 && pneResGateErrors === err0, 'a readable clock is never reported as a failure')
  // no readable clock: capture the gate's warnings
  console = { warn: function (m) { warns.push(String(m)) }, info: function () { }, log: function () { }, error: function (m) { warns.push(String(m)) } }
  try {
    pneGateT(isNaN(pneResGateNow(noClock)) && isNaN(pneResGateNow(badClock)), 'no clock, or a throwing getTime() with a non-numeric getGameTime(): time is NaN, nothing throws')
    pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0, noClock) === 0, 'no clock: live grace cannot count (fail-open for grace only)')
    p.addTag('pne_mercy')
    pneGateT(pneGateRate(srv, 'epca:ripper', 200, 5, 64, 0, noClock) === 1, 'no clock: the pne_mercy tag still denies every spawn (no early return)')
    pneGateT(pneGateRate(srv, 'spore:knight', 100, 5, 64, 0, badClock) === 1, 'throwing clock: the pne_mercy tag still denies every spawn')
    p.removeTag('pne_mercy')
    p.hp = 6
    pneGateT(pneGateRate(srv, 'epca:ripper', 200, 5, 64, 0, noClock) === 1, 'no clock: health <= 30% still denies every spawn')
    p.hp = 20
    p.removeTag('pne_grace')
    p.addTag('pne_gate')
    p.persistentData.putDouble('pne_m', 0)
    p.persistentData.putLong('pne_m_t', now - 20)
    pneGateT(pneGateRate(srv, 'epca:ripper', 100, 5, 64, 0, noClock) === 0, 'no clock: pne_gate cannot be checked for freshness, so it does not gate')
    pneGateT(pneResGateTimeFails === 700, 'every clock-less check is counted (' + pneResGateTimeFails + '/700)')
    pneGateT(pneResGateErrors === err0 + 1 && pneResGateOff === false, 'the unreadable clock is charged to the error limit once (errors ' + err0 + ' -> ' + pneResGateErrors + '), the gate stays on')
    pneGateT(warns.length === 1 && warns[0].indexOf('[pne_res_gate] spawn gate failed') === 0 && warns[0].indexOf('game time') > 0,
      'logged exactly once as "[pne_res_gate] spawn gate failed ..." (' + warns.length + ': ' + warns.join(' / ') + ')')
  } finally {
    console = con
    p.removeTag('pne_gate')
  }
}

var pneGateResult = 'FAIL not run'
try {
  pneGateRun()
  pneGateResult = pneGateFails.length ? 'FAIL ' + pneGateFails.length + '/' + pneGateCount + ': ' + pneGateFails.join(' | ') : 'PASS ' + pneGateCount
} catch (err) {
  pneGateResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
