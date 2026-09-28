// Reference copy of the measured prototype (TDD Appendix B: tdd/oracle/features.js), kept verbatim below this
// header so tools/oracle/test_features.js can check pne_oracle_bridge.js against it on recorded inputs.
// Not loaded by KubeJS. Do not edit the code below; regenerate the parity fixture instead if the design changes.

// PNE Oracle telemetry: per-player, per-second feature vector (31 floats). ES5, Rhino + Node.
// Pure core: pneTelNew() / pneTelStep(state, raw) -> Array(31). The KubeJS adapter that builds
// `raw` from the live player is sketched at the bottom (API names checked against
// kubejs-forge-2001.6.5 bytecode: EntityKJS.getBlock, BlockContainerJS.getLight/getCanSeeSky,
// PlayerKJS.getFoodLevel, LivingEntityKJS.canEntityBeSeen/getMainHandItem, LevelKJS.getEntitiesWithin).

var PNE_TEL_FEATURES = ['speed_h', 'accel', 'heading_rate', 'look_rate', 'vy', 'health', 'dhealth', 'food',
  'light', 'sky', 'depth', 'sneak', 'sprint', 't_since_dmg', 't_since_sight', 'n16', 'n32', 'nearest', 'dnearest',
  'held_melee', 'held_ranged', 'held_tool', 'held_block', 'held_food', 'held_light', 'held_other',
  'place30', 'enclosure', 'torch_rate', 'dealt', 'night']
var PNE_TEL_HELD = { melee: 0, ranged: 1, tool: 2, block: 3, food: 4, light: 5, other: 6 }
var PNE_TEL_LOG600 = Math.log(601)

function pneTelNew() {
  return { init: false, x: 0, y: 0, z: 0, yaw: 0, heading: 0, speed: 0, health: 1, near: 32,
           tsd: 600, tss: 600, places: [], placeSum: 0, torchEma: 0, pendingPlaces: 0, pendingTorches: 0,
           pendingDealt: 0, pendingHurt: false }
}

function pneTelAngle(a, b) { // smallest absolute difference between two yaw angles in degrees
  var d = (a - b) % 360
  if (d < 0) d += 360
  return d > 180 ? 360 - d : d
}
function pneTelClip(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v) }

// raw: { x,y,z, yaw, health, maxHealth, food, light, sky, sneak, sprint, held (class string),
//        hostiles: [{d: blocks, seen: bool}], encl: 0..9 solid neighbours, night: bool }
// Event counters (placements, torch placements, damage dealt, damage taken) are accumulated between
// samples by event handlers into state.pending* and consumed here.
function pneTelStep(s, r) {
  var out = new Array(31)
  for (var i = 0; i < 31; i++) out[i] = 0
  var dx = 0, dz = 0, dy = 0
  if (s.init) { dx = r.x - s.x; dz = r.z - s.z; dy = r.y - s.y }
  var tele = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) > 60 // teleport/respawn: ignore motion this second
  if (tele) { dx = 0; dz = 0; dy = 0 }
  var speed = Math.sqrt(dx * dx + dz * dz)
  var heading = speed > 0.5 ? Math.atan2(-dx, dz) * 180 / Math.PI : s.heading
  var hp = r.maxHealth > 0 ? r.health / r.maxHealth : 0
  out[0] = pneTelClip(speed / 5.6, 0, 2)
  out[1] = s.init ? Math.abs(speed - s.speed) / 5.6 : 0
  out[2] = (s.init && speed > 0.5) ? pneTelAngle(heading, s.heading) / 180 : 0
  out[3] = s.init ? pneTelAngle(r.yaw, s.yaw) / 180 : 0
  out[4] = pneTelClip(dy / 4, -2, 2)
  out[5] = hp
  out[6] = s.init ? pneTelClip(hp - s.health, -1, 1) : 0
  out[7] = r.food / 20
  out[8] = r.light / 15
  out[9] = r.sky ? 1 : 0
  out[10] = pneTelClip((63 - r.y) / 64, -0.5, 2)
  out[11] = r.sneak ? 1 : 0
  out[12] = r.sprint ? 1 : 0
  s.tsd = s.pendingHurt ? 0 : Math.min(s.tsd + 1, 600)
  out[13] = Math.log(1 + s.tsd) / PNE_TEL_LOG600
  var n16 = 0, n32 = 0, near = 32, seen = false
  for (var h = 0; h < r.hostiles.length; h++) {
    var e = r.hostiles[h]
    if (e.d < 32) n32++
    if (e.d < 16) n16++
    if (e.d < near) near = e.d
    if (e.seen && e.d < 24) seen = true
  }
  s.tss = seen ? 0 : Math.min(s.tss + 1, 600)
  out[14] = Math.log(1 + s.tss) / PNE_TEL_LOG600
  out[15] = Math.min(n16 / 8, 1)
  out[16] = Math.min(n32 / 16, 1)
  out[17] = near / 32
  out[18] = s.init ? pneTelClip((near - s.near) / 8, -1, 1) : 0
  var hc = PNE_TEL_HELD[r.held]
  out[19 + (hc === undefined ? 6 : hc)] = 1
  s.places.push(s.pendingPlaces)
  s.placeSum += s.pendingPlaces
  if (s.places.length > 30) s.placeSum -= s.places.shift()
  out[26] = Math.min(s.placeSum / 10, 1)
  out[27] = r.encl / 9
  s.torchEma = 0.95 * s.torchEma + 0.05 * s.pendingTorches * 60
  out[28] = Math.min(s.torchEma / 6, 1)
  out[29] = Math.min(s.pendingDealt / 10, 1)
  out[30] = r.night ? 1 : 0
  s.x = r.x; s.y = r.y; s.z = r.z; s.yaw = r.yaw; s.heading = heading; s.speed = speed; s.health = hp; s.near = near
  s.pendingPlaces = 0; s.pendingTorches = 0; s.pendingDealt = 0; s.pendingHurt = false
  s.init = true
  return out
}

if (typeof module !== 'undefined') module.exports = { pneTelNew: pneTelNew, pneTelStep: pneTelStep, PNE_TEL_FEATURES: PNE_TEL_FEATURES }

/* ---- KubeJS adapter sketch (not executed in Node) ------------------------------------------
var $AABB = Java.loadClass('net.minecraft.world.phys.AABB')
function pneTelRaw(player, server) {
  var b = player.block                        // EntityKJS.getBlock -> BlockContainerJS at feet
  var eye = b.offset(0, 1, 0)
  var lvl = player.level
  var box = new $AABB(player.x - 32, player.y - 16, player.z - 32, player.x + 32, player.y + 16, player.z + 32)
  var hs = [], list = lvl.getEntitiesWithin(box), seenBudget = 4
  // nearest-first; line-of-sight raycasts only for the 4 nearest candidates (cost cap)
  ...filter e.isMonster() || e.type startsWith 'epca:' or 'spore:'; d = player.distanceToEntity(e)
  ...seen = seenBudget-- > 0 && player.canEntityBeSeen(e)
  return { x: player.x, y: player.y, z: player.z, yaw: player.yaw, health: player.health,
           maxHealth: player.maxHealth, food: player.foodLevel, light: eye.light, sky: eye.canSeeSky,
           sneak: player.crouching, sprint: player.sprinting, held: pneTelHeldClass(player.mainHandItem),
           hostiles: hs, encl: pneTelEnclosure(lvl, player), night: pneHIsNight(daytime) }
}
Events: BlockEvents.placed -> state.pendingPlaces++, and pendingTorches++ if the block is in
#pne:light_sources; EntityEvents.hurt -> pendingHurt on the player / pendingDealt += damage when the
source entity is the player.
--------------------------------------------------------------------------------------------- */
