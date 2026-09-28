// Feature extractor tests for pne_oracle_bridge.js. ES5; runs in Node (kjs_node.js) and in real Rhino.
// Files, in order: tools/tests/kjs_mocks.js, tools/oracle/ora_mocks.js, pne_00_core.js, pne_oracle_bridge.js,
// tools/oracle/ref/features_proto.js, tools/oracle/fixtures/raw_trace.js, this file.
// Result: pneOraFeatResult ("PASS n" or "FAIL ...").
//  A. Parity: pneOraTelStep against the measured prototype (pneTelStep) on the recorded raw trace.
//  B. The live adapter on mocks: one entity query per sample, at most 4 line-of-sight checks, held-item
//     classes, place30 / torch_rate from BlockEvents.placed, 9-neighbour enclosure, dealt from player-sourced
//     hurt events (invulnerability-frame excess only), night, snapshot shape, slot staggering, budget and
//     pillar gating, and adapter-to-core parity against the prototype.

var pneOraTFails = []
var pneOraTCount = 0

function pneOraT(cond, msg) {
  pneOraTCount++
  if (!cond) pneOraTFails.push(msg)
}

function pneOraTNear(a, b, eps) {
  return Math.abs(a - b) <= (eps || 1e-12)
}

// The prototype divides by Math.PI, which the Rhino fork does not define (verified with the instance's jar).
// Give it the constant only while it runs, so the bridge is exercised without it.
function pneOraTProto(s, r) {
  var had = typeof Math.PI === 'number'
  var out
  if (!had) Math.PI = 3.141592653589793
  try {
    out = pneTelStep(s, r)
  } finally {
    if (!had) delete Math.PI
  }
  return out
}

function pneOraTRawFrom(step) {
  var hs = []
  var k
  var list = step[18]
  for (k = 0; k + 1 < list.length; k += 2) hs.push({ d: list[k], seen: list[k + 1] === 1 })
  return {
    x: step[0], y: step[1], z: step[2], yaw: step[3], health: step[4], maxHealth: step[5], food: step[6],
    light: step[7], sky: step[8] === 1, sneak: step[9] === 1, sprint: step[10] === 1, held: PNE_ORA_FIX_HELD[step[11]],
    encl: step[12], night: step[13] === 1, hostiles: hs
  }
}

function pneOraTParity() {
  var s
  var t
  var i
  var a
  var b
  var ra
  var rb
  var sa
  var sb
  var step
  var worst = 0
  var worstAgg = 0
  var n = 0
  var bad = 0
  var ohs
  var sc
  var rc
  var c
  var k
  for (s = 0; s < PNE_ORA_FIX_TRACE.length; s++) {
    sa = pneTelNew()
    sb = pneOraTelNew()
    sc = pneOraTelNew()
    for (t = 0; t < PNE_ORA_FIX_TRACE[s].length; t++) {
      step = PNE_ORA_FIX_TRACE[s][t]
      ra = pneOraTRawFrom(step)
      rb = pneOraTRawFrom(step)
      sa.pendingHurt = step[14] === 1
      sb.pendingHurt = step[14] === 1
      sa.pendingPlaces = step[15]
      sb.pendingPlaces = step[15]
      sa.pendingTorches = step[16]
      sb.pendingTorches = step[16]
      sa.pendingDealt = step[17]
      sb.pendingDealt = step[17]
      a = pneOraTProto(sa, ra)
      b = pneOraTelStep(sb, rb)
      // the adapter's aggregate path: n16 / n32 / near / seen instead of the list
      rc = pneOraTRawFrom(step)
      rc.agg = true
      rc.n16 = 0
      rc.n32 = 0
      rc.near = 32
      rc.seen = false
      for (k = 0; k < rc.hostiles.length; k++) {
        if (rc.hostiles[k].d < 32) rc.n32++
        if (rc.hostiles[k].d < 16) rc.n16++
        if (rc.hostiles[k].d < rc.near) rc.near = rc.hostiles[k].d
        if (rc.hostiles[k].seen && rc.hostiles[k].d < 24) rc.seen = true
      }
      rc.hostiles = null
      sc.pendingHurt = step[14] === 1
      sc.pendingPlaces = step[15]
      sc.pendingTorches = step[16]
      sc.pendingDealt = step[17]
      c = pneOraTelStep(sc, rc)
      for (i = 0; i < 31; i++) {
        if (Math.abs(c[i] - b[i]) > worstAgg) worstAgg = Math.abs(c[i] - b[i])
      }
      ohs = 0
      for (i = 0; i < 31; i++) {
        n++
        if (!(isFinite(b[i]) && b[i] >= -2 && b[i] <= 2)) bad++
        if (Math.abs(a[i] - b[i]) > worst) worst = Math.abs(a[i] - b[i])
        if (i >= 19 && i <= 25) ohs += b[i]
      }
      if (ohs !== 1) bad++
    }
  }
  pneOraT(n === 3 * 400 * 31, 'parity covered 3 sessions x 400 s x 31 features (' + n + ')')
  pneOraT(worst <= 1e-12, 'pneOraTelStep equals the prototype on the recorded trace (max diff ' + worst + ')')
  pneOraT(worstAgg === 0, 'the aggregate hostile path gives the same features as the list path (max diff ' + worstAgg + ')')
  pneOraT(bad === 0, 'every feature finite, within [-2, 2], one-hot held sums to 1 (' + bad + ' bad)')
  sa = pneOraTelNew()
  pneOraTelStep(sa, { x: 0, y: 64, z: 0, yaw: 0, health: 20, maxHealth: 20, food: 20, light: 15, sky: true, sneak: false, sprint: false, held: 'other', hostiles: [], encl: 0, night: false })
  pneOraTelStep(sa, { x: 0, y: 64, z: 3, yaw: 0, health: 20, maxHealth: 20, food: 20, light: 15, sky: true, sneak: false, sprint: false, held: 'other', hostiles: [], encl: 0, night: false })
  a = pneOraTelStep(sa, { x: -3, y: 64, z: 3, yaw: 0, health: 20, maxHealth: 20, food: 20, light: 15, sky: true, sneak: false, sprint: false, held: 'other', hostiles: [], encl: 0, night: false })
  pneOraT(pneOraTNear(a[2], 90 / 180, 1e-9), 'heading_rate: a 90 degree turn gives 0.5 without Math.PI (got ' + a[2] + ')')
  // The prototype's own exact-value checks (tdd/oracle/test_features.js), run on the bridge's core
  sa = pneOraTelNew()
  pneOraTelStep(sa, { x: 0, y: 64, z: 0, yaw: 350, health: 20, maxHealth: 20, food: 20, light: 15, sky: true, sneak: false, sprint: false, held: 'melee', hostiles: [], encl: 0, night: false })
  a = pneOraTelStep(sa, { x: 3, y: 64, z: 4, yaw: 10, health: 16, maxHealth: 20, food: 20, light: 15, sky: true, sneak: false, sprint: true, held: 'ranged', hostiles: [{ d: 8, seen: true }], encl: 0, night: false })
  pneOraT(pneOraTNear(a[0], 5 / 5.6, 1e-9), 'speed_h: 5 blocks in one second = 5 / 5.6 (got ' + a[0] + ')')
  pneOraT(pneOraTNear(a[3], 20 / 180, 1e-9), 'look_rate: yaw 350 -> 10 wraps to 20 degrees (got ' + a[3] + ')')
  pneOraT(pneOraTNear(a[6], -0.2, 1e-9), 'dhealth: 20 -> 16 of 20 gives -0.2 (got ' + a[6] + ')')
  pneOraT(a[14] === 0 && a[17] === 0.25 && a[18] === -1, 'a sighting resets t_since_sight; nearest 8 / 32; approach clipped to -1')
  pneOraT(a[20] === 1 && a[19] === 0 && a[12] === 1, 'held one-hot ranged; sprint flag')
  b = pneOraTelStep(sa, { x: 500, y: 64, z: 500, yaw: 10, health: 20, maxHealth: 20, food: 20, light: 15, sky: true, sneak: false, sprint: false, held: 'other', hostiles: [], encl: 0, night: false })
  pneOraT(b[0] === 0 && b[4] === 0 && pneOraTNear(b[1], 5 / 5.6, 1e-9), 'a teleport gives no speed or vy that second (accel sees the drop from 5 to 0)')
  pneOraT(b[17] === 1 && b[18] === 1 && pneOraTNear(b[14], Math.log(2) / Math.log(601), 1e-12), 'no parasite: nearest 1, dnearest clipped to +1, t_since_sight 1 s')
  pneOraT(PNE_ORA_FEATURES.length === 31 && PNE_ORA_FEATURES[0] === 'speed_h' && PNE_ORA_FEATURES[17] === 'nearest' &&
    PNE_ORA_FEATURES[30] === 'night', 'feature names in the TDD 4.3 order')
  for (i = 0; i < 31; i++) {
    if (PNE_ORA_FEATURES[i] !== PNE_TEL_FEATURES[i]) pneOraT(false, 'feature name ' + i + ' differs from the prototype')
  }
}

// Advances the mock server until pneCoreSlot === slot (the tick handler of that tick has run).
function pneOraTToSlot(srv, slot) {
  var k = 0
  __pneMock.tick(srv, 1)
  while (pneCoreSlot !== slot && k < 40) {
    __pneMock.tick(srv, 1)
    k++
  }
}

function pneOraTAdapter() {
  var srv = __pneMock.server({ tickCount: 1000 })
  var lv = __pneOraMock.world(srv)
  var p = __pneOraMock.equip(__pneMock.player(srv, 'Ann', '11111111-0000-4000-8000-000000000001', { x: 0.5, y: 64, z: 0.5 }), {})
  var sn
  var q0
  var c0
  var i
  var k
  var ids
  var want
  var protoState
  var protoRaw
  var out
  var worst
  var zombie
  var p2
  var p3
  var counts
  var slots
  var cost
  var tel
  var key

  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneOraT(pneOraSnap(p) === null, 'no snapshot before the first sample')

  // Mobs around the player: parasites at 5 (hidden), 10 (visible), 20, 30; a zombie at 3 (not a parasite);
  // a parasite 40 blocks away (outside the query box).
  __pneOraMock.addMob(srv, 'epca:ripper', 5.5, 64, 0.5, false)
  __pneOraMock.addMob(srv, 'spore:inf_human', 0.5, 64, 10.5, true)
  __pneOraMock.addMob(srv, 'epca:curbug', -19.5, 64, 0.5, false)
  __pneOraMock.addMob(srv, 'spore:brute', 0.5, 64, -29.5, true)
  zombie = __pneOraMock.addMob(srv, 'minecraft:zombie', 3.5, 64, 0.5, true)
  __pneOraMock.addMob(srv, 'epca:ripper', 40.5, 64, 0.5, true)

  q0 = __pneOraMock.calls.query
  c0 = __pneOraMock.calls.casts
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  sn = pneOraSnap(p)
  pneOraT(sn !== null && sn.tick === pneCoreTick, 'snapshot published at the player slot with the current tick')
  pneOraT(__pneOraMock.calls.query - q0 === 1, 'exactly one entity query per sample (' + (__pneOraMock.calls.query - q0) + ')')
  pneOraT(__pneOraMock.calls.casts - c0 === 2, 'line-of-sight checks nearest first, stop at the first in sight (' + (__pneOraMock.calls.casts - c0) + ')')
  pneOraT(sn.n16 === 2 && sn.n32 === 4 && pneOraTNear(sn.nearest, 5), 'n16 2, n32 4, nearest 5 (got ' + sn.n16 + ', ' + sn.n32 + ', ' + sn.nearest + ')')
  pneOraT(sn.hostileSeen === true && sn.tSinceSight === 0, 'a visible parasite within 24 is a sighting')
  pneOraT(pneOraTNear(sn.f[15], 2 / 8) && pneOraTNear(sn.f[16], 4 / 16) && pneOraTNear(sn.f[17], 5 / 32), 'n16, n32, nearest features')
  pneOraT(zombie.visible === true && sn.f.length === 31, 'non-parasites ignored; 31 features')

  // Snapshot shape (docs/IMPLEMENTATION.md 3.5)
  pneOraT(typeof sn.tick === 'number' && typeof sn.nearest === 'number' && typeof sn.n16 === 'number' && typeof sn.n32 === 'number' &&
    typeof sn.light === 'number' && typeof sn.sky === 'boolean' && typeof sn.hp === 'number' && typeof sn.hostileSeen === 'boolean' &&
    typeof sn.tSinceDmg === 'number' && typeof sn.tSinceSight === 'number' && typeof sn.dealt === 'number' && typeof sn.sneak === 'boolean' &&
    typeof sn.sprint === 'boolean' && typeof sn.y === 'number' && typeof sn.dim === 'string' && typeof sn.enclosure === 'number',
  'snapshot has every contract field with its type')
  pneOraT(sn.dim === 'minecraft:overworld' && sn.light === 15 && sn.sky === true && pneOraTNear(sn.hp, 1), 'dim, light, sky, hp')
  pneOraT(pneCoreSnap(p) === sn, 'pneCoreSnap returns the oracle snapshot')

  // Four-cast cap: six hidden parasites within 24
  lv.mobs = []
  for (i = 0; i < 6; i++) __pneOraMock.addMob(srv, 'epca:ripper', 2.5 + 3 * i, 64, 0.5, false)
  c0 = __pneOraMock.calls.casts
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(__pneOraMock.calls.casts - c0 === 4, 'at most 4 line-of-sight checks per sample (' + (__pneOraMock.calls.casts - c0) + ')')
  pneOraT(pneOraSnap(p).hostileSeen === false && pneOraSnap(p).tSinceSight === 1, 'no sighting: t_since_sight counts up')
  lv.mobs = []

  // Held-item classes
  ids = [['minecraft:iron_sword', {}, 'melee'], ['minecraft:netherite_axe', {}, 'melee'], ['minecraft:bow', {}, 'ranged'],
    ['minecraft:crossbow', {}, 'ranged'], ['minecraft:diamond_pickaxe', {}, 'tool'], ['minecraft:fishing_rod', {}, 'tool'],
    ['minecraft:torch', { block: true }, 'light'], ['minecraft:lantern', { block: true }, 'light'], ['minecraft:bread', { food: true }, 'food'],
    ['minecraft:cobblestone', { block: true }, 'block'], ['minecraft:stick', {}, 'other'], ['minecraft:bowl', {}, 'other'],
    ['minecraft:air', {}, 'other'], ['epca:serum_injector', {}, 'other'], ['minecraft:shield', {}, 'other']]
  for (i = 0; i < ids.length; i++) {
    want = pneOraHeldClass(__pneOraMock.item(ids[i][0], ids[i][1]))
    pneOraT(want === ids[i][2], 'held class of ' + ids[i][0] + ' is ' + ids[i][2] + ' (got ' + want + ')')
  }
  p.item = __pneOraMock.item('minecraft:bow')
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p).f[20] === 1 && pneOraSnap(p).f[19] === 0, 'held one-hot: ranged')

  // place30 and torch_rate from BlockEvents.placed; a non-player placer is ignored
  __pneOraMock.placed(p, __pneOraMock.block('minecraft:cobblestone'))
  __pneOraMock.placed(p, __pneOraMock.block('minecraft:cobblestone'))
  __pneOraMock.placed(p, __pneOraMock.block('minecraft:cobblestone'))
  __pneOraMock.placed(p, __pneOraMock.block('minecraft:torch'))
  __pneOraMock.placed(zombie, __pneOraMock.block('minecraft:torch'))
  __pneOraMock.placed(p, __pneOraMock.block('mymod:glow_thing', { emit: 12 }))
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  sn = pneOraSnap(p)
  pneOraT(pneOraTNear(sn.f[26], 5 / 10), 'place30 = 5 placements / 10 (got ' + sn.f[26] + ')')
  pneOraT(pneOraTNear(sn.f[28], (0.05 * 2 * 60) / 6), 'torch_rate EMA of 2 light-source placements (id words and light emission)')

  // enclosure: the 9 neighbours of the feet block (head ring + above the head)
  for (k = 0; k < PNE_ORA_ENCL.length; k++) lv.solid[(0 + PNE_ORA_ENCL[k][0]) + ',' + (64 + PNE_ORA_ENCL[k][1]) + ',' + (0 + PNE_ORA_ENCL[k][2])] = true
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraTNear(pneOraSnap(p).f[27], 1) && pneOraTNear(pneOraSnap(p).enclosure, 1), 'enclosure 9/9 when walled and roofed')
  lv.solid = { '1,65,0': true, '-1,65,0': true, '0,66,0': true, '0,64,0': true }
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraTNear(pneOraSnap(p).f[27], 3 / 9), 'enclosure counts only the 9 neighbours (3/9)')
  lv.solid = {}

  // dealt from hurt events with a player source (projectiles: the owner); i-frame repeats count the excess.
  // The sources have the in-game shape (getActual; getEntity is hidden by KubeJS, F37).
  zombie = __pneOraMock.addMob(srv, 'epca:ripper', 50, 64, 50, false)
  q0 = __pneOraMock.addMob(srv, 'spore:brute', 60, 64, 60, false)
  pneOraT(typeof __pneOraMock.damage('player', p).getEntity === 'undefined', 'the in-game damage source mock has no getEntity')
  __pneOraMock.hurt(zombie, __pneOraMock.damage('player', p), 4)
  __pneOraMock.hurt(zombie, __pneOraMock.damage('player', p), 6)
  __pneOraMock.hurt(q0, __pneOraMock.damage('arrow', p, zombie), 3)
  __pneOraMock.hurt(q0, __pneOraMock.damage('mob', zombie), 5)
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  sn = pneOraSnap(p)
  pneOraT(pneOraTNear(sn.dealt, 9) && pneOraTNear(sn.f[29], 0.9), 'dealt from getActual(): 4 + (6-4) + 3 = 9 (got ' + sn.dealt + ')')
  pneOraT(sn.tSinceDmg > 0, 'no damage taken yet')
  // The Mojang-named shape (getEntity only, as __pneMock.damage builds it) is the fallback
  __pneOraMock.hurt(q0, __pneMock.damage('player', p), 7)
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraTNear(pneOraSnap(p).dealt, 7), 'dealt from the getEntity() fallback (got ' + pneOraSnap(p).dealt + ')')
  pneOraT(pneOraSourceEntity(null) === null && pneOraSourceEntity({}) === null &&
    pneOraSourceEntity({ getActual: function () { return null }, getEntity: function () { return p } }) === p,
  'pneOraSourceEntity: null source, no method, and a null getActual() falling back to getEntity()')
  __pneOraMock.hurt(p, __pneOraMock.damage('mob', zombie), 2)
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p).tSinceDmg === 0 && pneOraSnap(p).f[13] === 0 && pneOraSnap(p).dealt === 0, 'damage taken resets t_since_dmg; a mob source is not dealt')
  __pneOraMock.hurt(p, __pneOraMock.damage('mob', zombie), 0)
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p).tSinceDmg === 1, 'a zero-damage hurt event does not count')
  lv.mobs = []

  // look_rate from the live adapter. The yaw comes from getYaw(), the only name a player has in game (KubeJS
  // renames Entity.getYRot, F37); reading the hidden name would pin look_rate at 0 whatever the player does.
  pneOraT(typeof p.getYRot === 'undefined' && typeof p.getYaw === 'function', 'the player mock has getYaw only (in-game shape)')
  p.yaw = 30
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  p.yaw = 120
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  sn = pneOraSnap(p)
  pneOraT(sn.f[3] > 0 && pneOraTNear(sn.f[3], 90 / 180, 1e-9), 'look_rate is non-zero when the yaw changes: 30 -> 120 gives 0.5 (got ' + sn.f[3] + ')')
  pneOraT(pneOraTNear(sn.f[2], 0, 1e-12), 'heading_rate stays 0 for a player turning on the spot (it follows motion, not yaw)')
  p.yaw = -170
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraTNear(pneOraSnap(p).f[3], 70 / 180, 1e-9), 'look_rate wraps: 120 -> -170 is 70 degrees (got ' + pneOraSnap(p).f[3] + ')')
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p).f[3] === 0, 'look_rate 0 when the yaw does not change')
  // pneOraYaw fallbacks: getYRot (mock shapes) when getYaw is missing or not a number; 0 when neither answers
  pneOraT(pneOraYaw({ getYaw: function () { return 45.5 } }) === 45.5, 'pneOraYaw reads getYaw()')
  pneOraT(pneOraYaw({ getYRot: function () { return 12 } }) === 12, 'pneOraYaw falls back to getYRot()')
  pneOraT(pneOraYaw({ getYaw: function () { return NaN }, getYRot: function () { return -33 } }) === -33, 'a non-finite getYaw() falls back to getYRot()')
  pneOraT(pneOraYaw({}) === 0 && pneOraYaw({ getYaw: function () { throw new Error('x') } }) === 0, 'pneOraYaw is 0 when neither method answers')

  // night (daytime 13000-23000)
  srv.dayTime = 18000 + 24000 * 3
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p).f[30] === 1 && pneOraSnap(p).night === true, 'night at daytime 18000')
  srv.dayTime = 6000
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p).f[30] === 0, 'day at daytime 6000')

  // Adapter-to-core parity: the prototype fed with the raw the test expects from the mocks
  protoState = pneTelNew()
  worst = 0
  lv.mobs = []
  __pneOraMock.addMob(srv, 'epca:ripper', 12.5, 64, 4.5, true)
  for (k = 0; k < 12; k++) {
    p.x += (k % 3) * 1.5
    p.z -= (k % 2) * 2
    p.yaw = (p.yaw + 37) % 360
    p.sneak = k % 4 === 0
    p.sprint = k % 3 === 1
    p.hp = 20 - k
    p.food = 20 - k
    p.item = __pneOraMock.item(k % 2 ? 'minecraft:iron_sword' : 'minecraft:bread', { food: true })
    srv.dayTime = k % 5 === 0 ? 15000 : 3000
    pneOraTToSlot(srv, pneCoreTelSlot(0))
    protoRaw = {
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, health: p.hp, maxHealth: 20, food: p.food, light: 15, sky: true, sneak: p.sneak,
      sprint: p.sprint, held: k % 2 ? 'melee' : 'food', encl: 0, night: k % 5 === 0,
      hostiles: [{ d: Math.sqrt((12.5 - p.x) * (12.5 - p.x) + (4.5 - p.z) * (4.5 - p.z)), seen: true }]
    }
    if (k === 0) {
      // start the prototype from the adapter's state after its first sample here
      tel = pneOraSt[pneCoreUuid(p)].tel
      for (key in tel) {
        if (tel.hasOwnProperty(key)) protoState[key] = key === 'places' ? tel.places.slice() : tel[key]
      }
      continue
    }
    out = pneOraTProto(protoState, protoRaw)
    for (i = 0; i < 31; i++) {
      if (Math.abs(out[i] - pneOraSnap(p).f[i]) > worst) worst = Math.abs(out[i] - pneOraSnap(p).f[i])
    }
  }
  pneOraT(worst <= 1e-9, 'adapter + core equal the prototype fed the same world (max diff ' + worst + ')')
  lv.mobs = []

  // Staggering: three players, each sampled once per 20 ticks, at pneCoreTelSlot(index of sorted UUID)
  p2 = __pneOraMock.equip(__pneMock.player(srv, 'Bea', '00000000-0000-4000-8000-000000000002', { x: 5, y: 64, z: 5 }), {})
  p3 = __pneOraMock.equip(__pneMock.player(srv, 'Cid', 'ffffffff-0000-4000-8000-000000000003', { x: -5, y: 64, z: 5 }), {})
  counts = { a: 0, b: 0, c: 0 }
  slots = {}
  for (k = 0; k < 40; k++) {
    __pneMock.tick(srv, 1)
    if (pneOraSnap(p) && pneOraSnap(p).tick === pneCoreTick) { counts.a++; slots.a = pneCoreSlot }
    if (pneOraSnap(p2) && pneOraSnap(p2).tick === pneCoreTick) { counts.b++; slots.b = pneCoreSlot }
    if (pneOraSnap(p3) && pneOraSnap(p3).tick === pneCoreTick) { counts.c++; slots.c = pneCoreSlot }
  }
  pneOraT(counts.a === 2 && counts.b === 2 && counts.c === 2, 'each player sampled once per second (' + counts.a + ',' + counts.b + ',' + counts.c + ')')
  pneOraT(slots.b === pneCoreTelSlot(0) && slots.a === pneCoreTelSlot(1) && slots.c === pneCoreTelSlot(2), 'slot = pneCoreTelSlot(index in UUID order)')
  pneOraT(slots.a !== 0 && slots.a !== 10 && slots.b !== 0 && slots.c !== 10, 'never on slots 0 or 10')

  // Budget refusal: the sample waits for the player's next slot
  cost = PNE_CORE_COST.playerTel
  PNE_CORE_COST.playerTel = 99
  k = pneOraSnap(p2).tick
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p2).tick === k, 'no sample when the token budget refuses playerTel')
  PNE_CORE_COST.playerTel = cost
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p2).tick === pneCoreTick, 'sampled again at the next slot')

  // Pillar gating: telemetry keeps running with the oracle off; stops only when resonance, hive and oracle are all off
  pneCoreCfgSet(srv, 'on_oracle', 0)
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p2).tick === pneCoreTick, 'telemetry runs with /pne oracle off')
  pneCoreCfgSet(srv, 'on_resonance', 0)
  pneCoreCfgSet(srv, 'on_hive', 0)
  k = pneOraSnap(p2).tick
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p2).tick === k, 'telemetry stops when resonance, hive and oracle are all off')
  pneCoreCfgSet(srv, 'on_resonance', 1)
  pneCoreCfgSet(srv, 'on_hive', 1)
  pneCoreCfgSet(srv, 'on_oracle', 1)

  // Respawn: motion features are not polluted by the jump back to spawn (teleport rule)
  p2.x = 900
  p2.z = -700
  __pneMock.fire('PlayerEvents.respawned', { player: p2 })
  pneOraTToSlot(srv, pneCoreTelSlot(0))
  pneOraT(pneOraSnap(p2).f[0] === 0 && pneOraSnap(p2).f[1] === 0, 'a jump over 60 blocks gives no speed that second')
}

var pneOraFeatResult = 'FAIL not run'
try {
  pneOraTParity()
  pneOraTAdapter()
  pneOraFeatResult = pneOraTFails.length ? 'FAIL ' + pneOraTFails.length + '/' + pneOraTCount + ': ' + pneOraTFails.join(' | ') : 'PASS ' + pneOraTCount
} catch (err) {
  pneOraFeatResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
