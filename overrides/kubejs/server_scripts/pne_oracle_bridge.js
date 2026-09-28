// priority: 80
// Parasites New Dawn - Enhanced :: The Hive Remembers, Oracle bridge (server side)
//
// What this file does (docs/IMPLEMENTATION.md 3.5, TDD 4.3 and 4.4.2):
//   1. Telemetry extractor. Once per second, at each survival player's own slot (pneCorePlayersAtSlot),
//      it computes the 31 Oracle features in the TDD 4.3 order and publishes them as that player's
//      snapshot (pneOraSnap, read by every module through pneCoreSnap). One entity query and at most
//      4 line-of-sight checks per player per second. It runs while any of resonance, hive or oracle is on.
//   2. File bridge to the Oracle sidecar in <instance>/local/pne_oracle/ (the folder must exist:
//      JsonIO never creates folders). telemetry.json is written at slot 0 (JsonIO.write truncates the
//      file and rewrites it in place: not atomic, so the sidecar can see a partial file and retries).
//      verdict.json is read at slot 10 and accepted only when its boot_id is this run's and its seq is
//      newer than the last one applied; its age counts from the tick of the telemetry it answers, so a
//      late answer is applied but never fresh; a verdict older than 60 ticks is stale.
//   3. /pne oracle status | log on | log off | purge, the login notice for logging players, the purge
//      hand-shake with the sidecar and the oracle status line.
// Privacy: bridge files carry the random pseudonym pne_pid only, never a UUID or a name, and never the
// x or z position. The sidecar logs a player's samples only after that player turned logging on for
// themselves: /pne oracle log on only sends that player a one-time confirmation link (valid 60 s),
// and only /pne oracle log confirm <code> with that code sets pne_log. An operator, the console, a
// command block or a function using "execute as <player>" never sees the code, so nobody can turn
// logging on for someone else. The bridge is off on a dedicated server unless the world config
// bridge_dedicated is 1. Log retention (7 days, 50 MB) is applied by the sidecar whenever it runs.
// Determinism boundary: only the bucketed verdict (style and band) may reach the GA or a log line.
//
// Rhino notes: every var sits at the top of its function; values from Java (JsonIO maps and lists,
// ids, NBT strings) go through Number(...) or String(...) before any comparison; Java methods are called
// by their Mojang or KubeJS names only; every handler is wrapped in try/catch with a broken counter.

var PNE_ORA_API = 1
var pneOraReady = typeof PNE_CORE_API === 'number' && PNE_CORE_API >= 1

// ---------------------------------------------------------------------------------------------
// Constants

var PNE_ORA_DIR = 'local/pne_oracle/'
var PNE_ORA_TEL = PNE_ORA_DIR + 'telemetry.json'
var PNE_ORA_VER = PNE_ORA_DIR + 'verdict.json'
var PNE_ORA_STA = PNE_ORA_DIR + 'status.json'
var PNE_ORA_V = 2                 // bridge file version (TDD 4.4.2)
var PNE_ORA_STALE = 60            // a verdict older than this many ticks is not fresh (3 s)
var PNE_ORA_BOX_H = 32            // entity query half-width (blocks)
var PNE_ORA_BOX_V = 16            // entity query half-height (blocks)
var PNE_ORA_SIGHT = 24            // a sighting is a parasite within 24 blocks with line of sight
var PNE_ORA_CASTS = 4             // at most 4 line-of-sight checks per player per second
var PNE_ORA_MAX_SCAN = 512        // entities looked at per query at most (caps the cost of item floods)
var PNE_ORA_PURGE_MAX = 64        // old pids kept for the purge hand-shake
var PNE_ORA_IO_BACKOFF = 600      // after 5 failed writes in a row, try again every 30 s
var PNE_ORA_STYLE_MIN = 0.5       // style bucket = argmax(styleP) only when max(styleP) >= 0.5
var PNE_ORA_PID_RX = /^[0-9a-f]{32}$/
var PNE_ORA_SEQ_KEEP = 64         // telemetry seq -> tick entries kept to date the verdicts that answer them
var PNE_ORA_CONFIRM_TICKS = 1200  // a logging confirmation code is valid for 60 s
var PNE_ORA_PROMPT_GAP = 100      // at most one confirmation prompt per player per 5 s (no chat spam)
var PNE_ORA_CODE_RX = /^[0-9a-f]{12}$/

var PNE_ORA_FEATURES = ['speed_h', 'accel', 'heading_rate', 'look_rate', 'vy', 'health', 'dhealth', 'food',
  'light', 'sky', 'depth', 'sneak', 'sprint', 't_since_dmg', 't_since_sight', 'n16', 'n32', 'nearest', 'dnearest',
  'held_melee', 'held_ranged', 'held_tool', 'held_block', 'held_food', 'held_light', 'held_other',
  'place30', 'enclosure', 'torch_rate', 'dealt', 'night']
var PNE_ORA_HELD = { melee: 0, ranged: 1, tool: 2, block: 3, food: 4, light: 5, other: 6 }
var PNE_ORA_LOG600 = Math.log(601)
// 180 / pi. The Rhino fork has no Math constants (Math.PI, Math.E, ... are undefined: NativeMath defines them
// but findPrototypeId never resolves the names), so the prototype's `180 / Math.PI` would be NaN in game.
var PNE_ORA_RAD2DEG = 57.29577951308232
var PNE_ORA_STYLES = ['hide', 'kite', 'turtle', 'explore']

// Enclosure: the 8 blocks around the player at head height plus the block above the head.
var PNE_ORA_ENCL = [[1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, 1, 1], [1, 1, -1], [-1, 1, 1], [-1, 1, -1], [0, 2, 0]]

// Held-item classes by id word (the id path split on '_'), checked in this order: light, ranged, melee,
// tool; then isEdible() -> food, isBlock() -> block, else other. Cached per item id.
var PNE_ORA_W_LIGHT = { torch: 1, lantern: 1, glowstone: 1, campfire: 1, candle: 1, lamp: 1, froglight: 1, shroomlight: 1, beacon: 1 }
var PNE_ORA_W_RANGED = { bow: 1, crossbow: 1, longbow: 1, shortbow: 1, trident: 1, gun: 1, rifle: 1, pistol: 1, shotgun: 1,
  launcher: 1, slingshot: 1, blowgun: 1, musket: 1, revolver: 1, snowball: 1, egg: 1 }
var PNE_ORA_W_MELEE = { sword: 1, axe: 1, dagger: 1, knife: 1, scythe: 1, mace: 1, spear: 1, halberd: 1, katana: 1, club: 1,
  hammer: 1, sickle: 1, glaive: 1, cleaver: 1, blade: 1, saber: 1, sabre: 1, rapier: 1, machete: 1, greatsword: 1,
  battleaxe: 1, warhammer: 1, claymore: 1, longsword: 1 }
var PNE_ORA_W_TOOL = { pickaxe: 1, shovel: 1, hoe: 1, shears: 1, rod: 1, brush: 1, spyglass: 1, compass: 1, clock: 1,
  bucket: 1, wrench: 1, drill: 1, saw: 1, paxel: 1, mattock: 1, flint: 1 }

// ---------------------------------------------------------------------------------------------
// Java classes (optional; every use is guarded)

var $PneOraAABB = null
try { $PneOraAABB = Java.loadClass('net.minecraft.world.phys.AABB') } catch (e) { $PneOraAABB = null }
var $PneOraUUID = null
try { $PneOraUUID = Java.loadClass('java.util.UUID') } catch (e) { $PneOraUUID = null }

// ---------------------------------------------------------------------------------------------
// Module state (starts fresh on /reload; nothing here must survive a restart)

var PNE_ORA_B_TICK = pneOraReady ? pneCoreBreaker('oracle.tick', 5, 'consecutive') : null
var PNE_ORA_B_EVENTS = pneOraReady ? pneCoreBreaker('oracle.events', 20, 'total') : null
var PNE_ORA_B_CMD = pneOraReady ? pneCoreBreaker('oracle.commands', 20, 'total') : null

var pneOraSt = {}                 // player UUID -> { tel, snap, ev, respAt, enc, dealtU, dealtT, dealtA, seen }
var pneOraVerdicts = {}           // pid -> accepted verdict record
var pneOraBoot = ''               // this run's boot id (epoch ms when the script loaded, as a string)
var pneOraSeq = 0                 // seq of the last telemetry.json written
var pneOraSeqTick = {}            // seq -> pneCoreTick of that write (the last PNE_ORA_SEQ_KEEP)
var pneOraLogCodes = {}           // player UUID -> { code, tick }: pending logging confirmations (memory only)
var pneOraApplied = -1            // seq of the last verdict applied
var pneOraAcceptTick = -1         // pneCoreTick of the last accepted verdict
var pneOraBackend = ''            // backend of the last accepted verdict
var pneOraWritePending = false
var pneOraReadPending = false
var pneOraStatusPending = false
var pneOraOffPending = false      // one last telemetry.json with want_oracle false after /pne oracle off
var pneOraPurge = null            // old pids awaiting the sidecar's purge acknowledgement (lazy)
var pneOraWid = ''
var pneOraWidAt = -1000000
var pneOraDedicated = null        // true, false, or null before the first check
var pneOraIo = { wOk: 0, wFail: 0, consec: 0, nextTry: 0, err: '', rOk: 0, rMissing: 0, rTorn: 0, rStale: 0, rBad: 0 }
var pneOraHeldCache = {}
var pneOraLightCache = {}
var pneOraParaCache = {}          // entity type id -> pneCoreIsParasite decision (hot loop cache)
var pneOraDistSq = null           // whether player.distanceToSqr(entity) is callable (checked once)

// ---------------------------------------------------------------------------------------------
// Small helpers for Java and JS values

function pneOraNum(v, d) {
  var n = (v === undefined || v === null) ? NaN : Number(v)
  return isFinite(n) ? n : d
}

function pneOraStr(v) {
  return (v === undefined || v === null) ? '' : String(v)
}

function pneOraBool(v) {
  if (v === undefined || v === null) return false
  return v === true || String(v) === 'true'
}

// Value of key k in a JsonIO map (a java.util.Map in game) or a plain JS object.
function pneOraGet(o, k) {
  var v
  if (o === null || o === undefined) return undefined
  try {
    if (typeof o.containsKey === 'function') return o.containsKey(k) ? o.get(k) : undefined
  } catch (e) { }
  try { v = o[k] } catch (e2) { v = undefined }
  return v
}

// Length of a JsonIO list (a java.util.List in game) or a JS array.
function pneOraLen(a) {
  var n = NaN
  if (a === null || a === undefined) return 0
  try { if (typeof a.size === 'function') n = Number(a.size()) } catch (e) { n = NaN }
  if (!isFinite(n)) {
    try { n = Number(a.length) } catch (e2) { n = NaN }
  }
  return isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function pneOraAt(a, i) {
  try { if (typeof a.size === 'function' && typeof a.get === 'function') return a.get(i) } catch (e) { }
  try { return a[i] } catch (e2) { return undefined }
}

// ---------------------------------------------------------------------------------------------
// The feature core (TDD 4.3). Pure ES5, identical to the measured prototype (tdd/oracle/features.js, with
// 180 / Math.PI written as PNE_ORA_RAD2DEG):
// pneOraTelStep(state, raw) -> Array(31). raw = { x, y, z, yaw, health, maxHealth, food, light, sky,
// sneak, sprint, held (class name), hostiles: [{ d: blocks, seen: bool }], encl: 0..9, night: bool }.
// The live adapter passes the hostile aggregates instead of the list (raw.agg true with raw.n16, raw.n32,
// raw.near, raw.seen): the same numbers the loop below derives, without one object per parasite.
// Event counters (placements, light-source placements, damage dealt, damage taken) are accumulated
// between samples by the event handlers into state.pending* and consumed here.

function pneOraTelNew() {
  return { init: false, x: 0, y: 0, z: 0, yaw: 0, heading: 0, speed: 0, health: 1, near: 32,
    tsd: 600, tss: 600, places: [], placeSum: 0, torchEma: 0, pendingPlaces: 0, pendingTorches: 0,
    pendingDealt: 0, pendingHurt: false }
}

// Smallest absolute difference between two angles in degrees.
function pneOraAngle(a, b) {
  var d = (a - b) % 360
  if (d < 0) d += 360
  return d > 180 ? 360 - d : d
}

function pneOraClip(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v)
}

function pneOraTelStep(s, r) {
  var out = new Array(31)
  var i
  var dx = 0
  var dz = 0
  var dy = 0
  var tele
  var speed
  var heading
  var hp
  var n16 = 0
  var n32 = 0
  var near = 32
  var seen = false
  var h
  var e
  var hc
  for (i = 0; i < 31; i++) out[i] = 0
  if (s.init) {
    dx = r.x - s.x
    dz = r.z - s.z
    dy = r.y - s.y
  }
  tele = Math.abs(dx) + Math.abs(dz) + Math.abs(dy) > 60   // teleport or respawn: no motion this second
  if (tele) {
    dx = 0
    dz = 0
    dy = 0
  }
  speed = Math.sqrt(dx * dx + dz * dz)
  heading = speed > 0.5 ? Math.atan2(-dx, dz) * PNE_ORA_RAD2DEG : s.heading
  hp = r.maxHealth > 0 ? r.health / r.maxHealth : 0
  out[0] = pneOraClip(speed / 5.6, 0, 2)
  out[1] = s.init ? Math.abs(speed - s.speed) / 5.6 : 0
  out[2] = (s.init && speed > 0.5) ? pneOraAngle(heading, s.heading) / 180 : 0
  out[3] = s.init ? pneOraAngle(r.yaw, s.yaw) / 180 : 0
  out[4] = pneOraClip(dy / 4, -2, 2)
  out[5] = hp
  out[6] = s.init ? pneOraClip(hp - s.health, -1, 1) : 0
  out[7] = r.food / 20
  out[8] = r.light / 15
  out[9] = r.sky ? 1 : 0
  out[10] = pneOraClip((63 - r.y) / 64, -0.5, 2)
  out[11] = r.sneak ? 1 : 0
  out[12] = r.sprint ? 1 : 0
  s.tsd = s.pendingHurt ? 0 : Math.min(s.tsd + 1, 600)
  out[13] = Math.log(1 + s.tsd) / PNE_ORA_LOG600
  if (r.agg === true) {
    n16 = r.n16
    n32 = r.n32
    near = r.near < 32 ? r.near : 32
    seen = r.seen === true
  } else {
    for (h = 0; h < r.hostiles.length; h++) {
      e = r.hostiles[h]
      if (e.d < 32) n32++
      if (e.d < 16) n16++
      if (e.d < near) near = e.d
      if (e.seen && e.d < 24) seen = true
    }
  }
  s.tss = seen ? 0 : Math.min(s.tss + 1, 600)
  out[14] = Math.log(1 + s.tss) / PNE_ORA_LOG600
  out[15] = Math.min(n16 / 8, 1)
  out[16] = Math.min(n32 / 16, 1)
  out[17] = near / 32
  out[18] = s.init ? pneOraClip((near - s.near) / 8, -1, 1) : 0
  hc = PNE_ORA_HELD[r.held]
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
  s.x = r.x
  s.y = r.y
  s.z = r.z
  s.yaw = r.yaw
  s.heading = heading
  s.speed = speed
  s.health = hp
  s.near = near
  s.pendingPlaces = 0
  s.pendingTorches = 0
  s.pendingDealt = 0
  s.pendingHurt = false
  s.init = true
  return out
}

// ---------------------------------------------------------------------------------------------
// Live adapter: builds `raw` from a player (KubeJS 2001.6.5 API: LevelKJS.getEntitiesWithin,
// BlockContainerJS.getLight / getCanSeeSky / getBlockState, PlayerKJS.getFoodLevel,
// LivingEntityKJS.getMainHandItem / canEntityBeSeen, ItemStackKJS.getId / isBlock; the KubeJS name
// getYaw, because KubeJS hides Entity.getYRot (docs/IMPLEMENTATION.md F37); Mojang names getEyeY,
// isCrouching, isSprinting, distanceToSqr, isSolid, isEdible, getDayTime).

// The player's yaw in degrees. In game only getYaw() exists: KubeJS renames Entity.getYRot() with
// @RemapForJS("getYaw") (F37), so a getYRot() call there throws and would pin look_rate at 0.
// getYRot() stays only as the fallback for other entity shapes (mocks); 0 when neither answers.
function pneOraYaw(player) {
  var yaw = NaN
  try { yaw = pneOraNum(player.getYaw(), NaN) } catch (e) { yaw = NaN }
  if (!isFinite(yaw)) {
    try { yaw = pneOraNum(player.getYRot(), NaN) } catch (e2) { yaw = NaN }
  }
  return isFinite(yaw) ? yaw : 0
}

// The entity that caused a damage (the owner for projectiles). In game DamageSource.getEntity() is
// visible only as getActual() (F37); getEntity() stays only as the fallback for mocks.
function pneOraSourceEntity(source) {
  var ent = null
  if (!source) return null
  try { ent = source.getActual() } catch (e) { ent = null }
  if (!ent) {
    try { ent = source.getEntity() } catch (e2) { ent = null }
  }
  return ent ? ent : null
}

function pneOraState(u) {
  var st = pneOraSt[u]
  if (!st) {
    st = { tel: pneOraTelNew(), snap: null, enc: false, seen: 0, respAt: -1,
      ev: { died: false, respawned: false, enc_start: false, enc_end: false, tele: false },
      dealtU: '', dealtT: -1000, dealtA: 0 }
    pneOraSt[u] = st
  }
  return st
}

// Class of an item id by its words ('' when the words say nothing).
function pneOraWordClass(id) {
  var s = String(id)
  var path = s.indexOf(':') >= 0 ? s.substring(s.indexOf(':') + 1) : s
  var ws = path.split('_')
  var i
  var hit = { light: false, ranged: false, melee: false, tool: false }
  if (path === 'end_rod' || path === 'sea_pickle') return 'light'
  if (path === 'flint_and_steel' || path === 'fishing_rod') return 'tool'
  for (i = 0; i < ws.length; i++) {
    if (PNE_ORA_W_LIGHT.hasOwnProperty(ws[i])) hit.light = true
    if (PNE_ORA_W_RANGED.hasOwnProperty(ws[i])) hit.ranged = true
    if (PNE_ORA_W_MELEE.hasOwnProperty(ws[i])) hit.melee = true
    if (PNE_ORA_W_TOOL.hasOwnProperty(ws[i])) hit.tool = true
  }
  if (hit.light) return 'light'
  if (hit.ranged) return 'ranged'
  if (hit.melee) return 'melee'
  if (hit.tool) return 'tool'
  return ''
}

// Held-item class of an ItemStack: melee, ranged, tool, block, food, light or other.
function pneOraHeldClass(item) {
  var id = ''
  var c
  var empty = false
  if (!item) return 'other'
  try { empty = item.isEmpty() ? true : false } catch (e) { empty = false }
  if (empty) return 'other'
  try { id = String(item.getId()) } catch (e2) { id = '' }
  if (!id || id === 'minecraft:air') return 'other'
  if (pneOraHeldCache.hasOwnProperty(id)) return pneOraHeldCache[id]
  c = pneOraWordClass(id)
  if (!c) {
    try { if (item.isEdible()) c = 'food' } catch (e3) { }
  }
  if (!c) {
    try { if (item.isBlock()) c = 'block' } catch (e4) { }
  }
  if (!c) c = 'other'
  pneOraHeldCache[id] = c
  return c
}

// Whether a placed block is a light source (by its id words, else its light emission). Cached per id.
function pneOraIsLight(block) {
  var id = ''
  var r = false
  try { id = String(block.getId()) } catch (e) { id = '' }
  if (id && pneOraLightCache.hasOwnProperty(id)) return pneOraLightCache[id]
  r = pneOraWordClass(id) === 'light'
  if (!r) {
    try { r = Number(block.getBlockState().getLightEmission()) > 0 } catch (e2) { r = false }
  }
  if (id) pneOraLightCache[id] = r
  return r
}

function pneOraSolid(block) {
  var st = null
  try { st = block.getBlockState() } catch (e) { st = null }
  if (!st) return 0
  try { return st.isSolid() ? 1 : 0 } catch (e2) { }
  try { return st.isAir() ? 0 : 1 } catch (e3) { }
  return 0
}

// Solid blocks among the 9 neighbours (0..9) of the block the player's feet are in.
function pneOraEnclosure(level, bx, by, bz) {
  var n = 0
  var i
  var o
  for (i = 0; i < PNE_ORA_ENCL.length; i++) {
    o = PNE_ORA_ENCL[i]
    try { n += pneOraSolid(level.getBlock(bx + o[0], by + o[1], bz + o[2])) } catch (e) { }
  }
  return n
}

function pneOraBox(x, y, z) {
  if ($PneOraAABB) return new $PneOraAABB(x - PNE_ORA_BOX_H, y - PNE_ORA_BOX_V, z - PNE_ORA_BOX_H, x + PNE_ORA_BOX_H, y + PNE_ORA_BOX_V, z + PNE_ORA_BOX_H)
  return { minX: x - PNE_ORA_BOX_H, minY: y - PNE_ORA_BOX_V, minZ: z - PNE_ORA_BOX_H, maxX: x + PNE_ORA_BOX_H, maxY: y + PNE_ORA_BOX_V, maxZ: z + PNE_ORA_BOX_H }
}

// Parasites around the player: ONE entity query. Returns { n16, n32, near (32 if none), seen, casts }.
// At most PNE_ORA_CASTS line-of-sight checks, nearest first, on parasites within 24 blocks, stopping at the
// first one in sight.
// Cost (tools/oracle/TelemetryBench.java, real Rhino): one Java call costs about 0.3 us, but a JS function call or
// an object allocation costs about 1-2 us in the interpreter. So the loop reads each entity's type id once, looks the
// parasite decision up in pneOraParaCache (filled from pneCoreIsParasite once per type id), counts with locals and
// keeps the nearest candidates in fixed slots.
var pneOraCandD = [0, 0, 0, 0]
var pneOraCandE = [null, null, null, null]

function pneOraScan(player, level, x, y, z) {
  var res = { n16: 0, n32: 0, near: 32, seen: false, casts: 0 }
  var list = null
  var n = 0
  var i
  var j
  var e
  var id
  var para
  var d2
  var d
  var n16 = 0
  var n32 = 0
  var near = 32
  var nc = 0
  var getter = false
  try { list = level.getEntitiesWithin(pneOraBox(x, y, z)) } catch (err) {
    pneCoreWarn('oracle', 'query', 'entity query failed, telemetry sees no parasites: ' + err)
    return res
  }
  n = pneOraLen(list)
  if (n > PNE_ORA_MAX_SCAN) n = PNE_ORA_MAX_SCAN
  try { getter = typeof list.get === 'function' } catch (e0) { getter = false }
  if (pneOraDistSq === null) {
    try { pneOraDistSq = typeof player.distanceToSqr === 'function' } catch (e1) { pneOraDistSq = false }
  }
  try {
    for (i = 0; i < n; i++) {
      e = getter ? list.get(i) : list[i]
      if (!e) continue
      id = String(e.type)
      para = pneOraParaCache[id]
      if (para === undefined) {
        para = pneCoreIsParasite(e)
        if (id.indexOf(':') > 0) pneOraParaCache[id] = para
      }
      if (!para) continue
      d2 = pneOraDistSq ? Number(player.distanceToSqr(e)) : pneOraDist2(e, x, y, z)
      if (!(d2 < 1024)) continue
      d = Math.sqrt(d2)
      n32++
      if (d < 16) n16++
      if (d < near) near = d
      if (d < PNE_ORA_SIGHT && (nc < PNE_ORA_CASTS || d < pneOraCandD[nc - 1])) {
        // insertion into the nearest-first slots (strict < keeps the earlier entity on ties: a total order)
        j = nc < PNE_ORA_CASTS ? nc++ : nc - 1
        while (j > 0 && pneOraCandD[j - 1] > d) {
          pneOraCandD[j] = pneOraCandD[j - 1]
          pneOraCandE[j] = pneOraCandE[j - 1]
          j--
        }
        pneOraCandD[j] = d
        pneOraCandE[j] = e
      }
    }
  } catch (err2) {
    pneCoreWarn('oracle', 'scan', 'entity scan stopped early: ' + err2)
  }
  res.n16 = n16
  res.n32 = n32
  res.near = near
  for (i = 0; i < nc; i++) {
    res.casts++
    try {
      if (player.canEntityBeSeen(pneOraCandE[i])) {
        res.seen = true
        break
      }
    } catch (e3) { }
  }
  for (i = 0; i < PNE_ORA_CASTS; i++) pneOraCandE[i] = null
  return res
}

// Squared distance from the entity's position (fallback when distanceToSqr is not callable).
function pneOraDist2(e, x, y, z) {
  var dx
  var dy
  var dz
  try {
    dx = Number(e.getX()) - x
    dy = Number(e.getY()) - y
    dz = Number(e.getZ()) - z
    return dx * dx + dy * dy + dz * dz
  } catch (err) {
    return NaN
  }
}

function pneOraNight(level) {
  var t = NaN
  try { t = Number(level.getDayTime()) } catch (e) { t = NaN }
  if (!isFinite(t)) return false
  t = t % 24000
  if (t < 0) t += 24000
  if (typeof pneHIsNight === 'function') {
    try { return pneHIsNight(t) ? true : false } catch (e2) { }
  }
  return t >= 13000 && t <= 23000
}

// raw for one player, or null when the player cannot be read.
function pneOraRaw(player) {
  var level = null
  var x
  var y
  var z
  var eyeY = NaN
  var eye = null
  var raw
  var scan
  var item = null
  try { level = player.getLevel() } catch (e) { level = null }
  if (!level) return null
  try {
    x = pneOraNum(player.getX(), NaN)
    y = pneOraNum(player.getY(), NaN)
    z = pneOraNum(player.getZ(), NaN)
  } catch (e0) {
    return null
  }
  if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null
  try { eyeY = Number(player.getEyeY()) } catch (e1) { eyeY = NaN }
  if (!isFinite(eyeY)) eyeY = y + 1.62
  raw = { x: x, y: y, z: z, yaw: 0, health: 20, maxHealth: 20, food: 20, light: 15, sky: false, sneak: false,
    sprint: false, held: 'other', hostiles: null, agg: true, encl: 0, night: false, n16: 0, n32: 0, near: 32, seen: false, dim: '' }
  raw.yaw = pneOraYaw(player)
  try { raw.health = pneOraNum(player.getHealth(), 20) } catch (e3) { raw.health = 20 }
  try { raw.maxHealth = pneOraNum(player.getMaxHealth(), 20) } catch (e4) { raw.maxHealth = 20 }
  try { raw.food = pneOraClip(pneOraNum(player.getFoodLevel(), 20), 0, 20) } catch (e5) { raw.food = 20 }
  try {
    eye = level.getBlock(Math.floor(x), Math.floor(eyeY), Math.floor(z))
    raw.light = pneOraClip(pneOraNum(eye.getLight(), 15), 0, 15)
    raw.sky = eye.getCanSeeSky() ? true : false
  } catch (e6) { }
  try { raw.sneak = player.isCrouching() ? true : false } catch (e7) { raw.sneak = false }
  try { raw.sprint = player.isSprinting() ? true : false } catch (e8) { raw.sprint = false }
  try { item = player.getMainHandItem() } catch (e9) { item = null }
  raw.held = pneOraHeldClass(item)
  scan = pneOraScan(player, level, x, y, z)
  raw.n16 = scan.n16
  raw.n32 = scan.n32
  raw.near = scan.near
  raw.seen = scan.seen
  raw.encl = pneOraEnclosure(level, Math.floor(x), Math.floor(y), Math.floor(z))
  raw.night = pneOraNight(level)
  raw.dim = pneCoreDim(level)
  return raw
}

// Samples one player (its slot, budget already charged). Returns the new snapshot or null.
function pneOraSample(player) {
  var u = pneCoreUuid(player)
  var st
  var raw
  var f
  var dealt
  var tel
  var enc
  if (!u) return null
  st = pneOraState(u)
  raw = pneOraRaw(player)
  if (!raw) return null
  tel = st.tel
  if (tel.init && Math.abs(raw.x - tel.x) + Math.abs(raw.y - tel.y) + Math.abs(raw.z - tel.z) > 60) st.ev.tele = true
  if (st.snap && st.snap.dim !== raw.dim) st.ev.tele = true
  dealt = tel.pendingDealt
  f = pneOraTelStep(tel, raw)
  enc = raw.near < PNE_ORA_SIGHT
  if (enc && !st.enc) st.ev.enc_start = true
  if (!enc && st.enc) st.ev.enc_end = true
  st.enc = enc
  st.seen = pneCoreTick
  st.snap = {
    tick: pneCoreTick, f: f, nearest: raw.near, n16: raw.n16, n32: raw.n32, light: raw.light, sky: raw.sky,
    hp: f[5], hostileSeen: raw.seen, tSinceDmg: tel.tsd, tSinceSight: tel.tss, dealt: dealt, sneak: raw.sneak,
    sprint: raw.sprint, y: raw.y, dim: raw.dim, enclosure: raw.encl / 9, held: raw.held, night: raw.night
  }
  return st.snap
}

// ---------------------------------------------------------------------------------------------
// Public API (docs/IMPLEMENTATION.md 3.5). Callers use pneCoreSnap / pneCoreVerdict.

// Latest snapshot of this player (read-only; null until the first sample).
function pneOraSnap(player) {
  var u
  var st
  if (!pneOraReady) return null
  u = pneCoreUuid(player)
  st = u ? pneOraSt[u] : null
  return st && st.snap ? st.snap : null
}

// Latest verdict for this player, or null (oracle off, no sidecar verdict yet, unknown player).
function pneOraVerdict(player) {
  var pid
  var r
  var age
  if (!pneOraReady || !pneCoreOn('oracle')) return null
  pid = pneCorePid(player)
  r = pid ? pneOraVerdicts[pid] : null
  if (!r) return null
  age = pneCoreTick - r.tick
  return {
    fresh: age >= 0 && age <= PNE_ORA_STALE && r.backend !== '',
    age: age,
    EO: r.EO,
    conf: r.conf,
    band: r.band,
    arousal: r.arousal.slice(),
    fe: r.fe.slice(),
    pFlee: r.fe[1],
    pEngage: r.fe[2],
    style: r.style,
    styleP: r.styleP.slice(),
    backend: r.backend,
    fill: r.fill,
    seq: r.seq
  }
}

// Bucketed view of a verdict: the only Oracle output allowed into the GA or a log (TDD 4.4.2).
function pneOraBuckets(player) {
  var v = pneOraVerdict(player)
  if (!v) return null
  return { style: v.style, band: v.band, fresh: v.fresh }
}

// ---------------------------------------------------------------------------------------------
// Verdict parsing (JsonIO gives java.util.Map / List with Double and String values: convert everything)

// Probability vector of length n from a JsonIO list, or null when malformed.
function pneOraProbs(a, n) {
  var out = []
  var i
  var v
  var sum = 0
  if (pneOraLen(a) !== n) return null
  for (i = 0; i < n; i++) {
    v = pneOraNum(pneOraAt(a, i), NaN)
    if (!(v >= -1e-6 && v <= 1 + 1e-6)) return null
    v = pneOraClip(v, 0, 1)
    out.push(v)
    sum += v
  }
  if (!(sum > 0.98 && sum < 1.02)) return null
  for (i = 0; i < n; i++) out[i] = out[i] / sum
  return out
}

function pneOraArgmax(p) {
  var best = 0
  var i
  for (i = 1; i < p.length; i++) {
    if (p[i] > p[best]) best = i
  }
  return best
}

// Verdict record for one players[] entry (EO, conf, band and style computed here, never trusted).
function pneOraRecord(entry, base, seq, backend) {
  var ar = pneOraProbs(pneOraGet(entry, 'arousal'), 4)
  var sp = pneOraProbs(pneOraGet(entry, 'style'), 4)
  var fe = pneOraProbs(pneOraGet(entry, 'fe'), 3)
  var eo
  var conf
  var k
  if (!ar || !sp || !fe) return null
  eo = (ar[1] + 2 * ar[2] + 3 * ar[3]) / 3
  conf = Math.max(ar[0], ar[1], ar[2], ar[3])
  k = pneOraArgmax(sp)
  return {
    tick: base, seq: seq, backend: backend, arousal: ar, styleP: sp, fe: fe, EO: eo, conf: conf,
    band: Math.min(3, Math.floor(4 * eo)),
    style: sp[k] >= PNE_ORA_STYLE_MIN ? PNE_ORA_STYLES[k] : 'none',
    fill: Math.floor(pneOraNum(pneOraGet(entry, 'window_fill'), 0))
  }
}

// Tick a verdict's age counts from: the tick this run wrote that seq at (remembered for the last 64
// writes), else the echoed telemetry tick when it lies in the past, else "already stale". A late answer
// (a sidecar that stalled for seconds) is therefore applied, so seq and the purge hand-shake move on,
// but it is never reported fresh.
function pneOraVerdictBase(seq, vt) {
  var k = String(seq)
  if (pneOraSeqTick.hasOwnProperty(k)) return pneOraSeqTick[k]
  if (isFinite(vt) && vt >= 0 && vt <= pneCoreTick) return vt
  return pneCoreTick - PNE_ORA_STALE - 1
}

// Applies a parsed verdict.json. Returns true when accepted (boot_id matches, seq newer than the last
// applied and not newer than the last written).
function pneOraAccept(m) {
  var seq
  var vt
  var base
  var backend
  var players
  var n
  var i
  var e
  var pid
  var rec
  var got = 0
  if (pneOraNum(pneOraGet(m, 'v'), -1) !== PNE_ORA_V) {
    pneOraIo.rBad++
    return false
  }
  pneOraPurgeAck(pneOraGet(m, 'purged'))
  if (pneOraStr(pneOraGet(m, 'boot_id')) !== pneOraBoot) {
    pneOraIo.rStale++
    return false
  }
  seq = pneOraNum(pneOraGet(m, 'seq'), -1)
  if (!(seq > pneOraApplied) || seq > pneOraSeq) {
    pneOraIo.rStale++
    return false
  }
  backend = pneOraStr(pneOraGet(m, 'backend'))
  vt = pneOraNum(pneOraGet(m, 'tick'), NaN)
  base = pneOraVerdictBase(seq, vt)
  players = pneOraGet(m, 'players')
  n = pneOraLen(players)
  for (i = 0; i < n; i++) {
    e = pneOraAt(players, i)
    pid = pneOraStr(pneOraGet(e, 'pid'))
    if (!PNE_ORA_PID_RX.test(pid)) continue
    rec = pneOraRecord(e, base, seq, backend)
    if (!rec) continue
    pneOraVerdicts[pid] = rec
    got++
  }
  pneOraApplied = seq
  pneOraAcceptTick = pneCoreTick
  pneOraBackend = backend
  pneOraIo.rOk++
  if (pneCoreCfg('debug') === 1) pneCoreLog('oracle', 'verdict seq ' + seq + ' accepted (' + got + ' player(s), ' + (backend || 'no backend') + ')')
  return true
}

// ---------------------------------------------------------------------------------------------
// Purge hand-shake: old pids ride in telemetry.json until the sidecar lists them in `purged`.

function pneOraPurgeList(server) {
  var pd
  var s = ''
  var xs
  var i
  if (pneOraPurge !== null) return pneOraPurge
  pneOraPurge = []
  pd = server ? pneCorePD(server) : null
  try { s = String(pd.getCompound('pne_ora').getString('purge')) } catch (e) { s = '' }
  xs = s.length ? s.split(',') : []
  for (i = 0; i < xs.length; i++) {
    if (PNE_ORA_PID_RX.test(xs[i]) && pneOraPurge.indexOf(xs[i]) < 0) pneOraPurge.push(xs[i])
  }
  return pneOraPurge
}

function pneOraPurgeSave(server) {
  var pd = server ? pneCorePD(server) : null
  var c
  if (!pd || pneOraPurge === null) return
  try {
    c = pd.getCompound('pne_ora')
    c.putString('purge', pneOraPurge.join(','))
    pd.put('pne_ora', c)
  } catch (e) {
    pneCoreWarn('oracle', 'purge.save', 'could not save the purge list: ' + e)
  }
}

// Drops the pids the sidecar has confirmed (a `purged` list from verdict.json or status.json).
function pneOraPurgeAck(list) {
  var n = pneOraLen(list)
  var i
  var k
  var pid
  var changed = false
  if (!n || pneOraPurge === null || !pneOraPurge.length) return false
  for (i = 0; i < n; i++) {
    pid = pneOraStr(pneOraAt(list, i))
    k = pneOraPurge.indexOf(pid)
    if (k >= 0) {
      pneOraPurge.splice(k, 1)
      changed = true
    }
  }
  if (changed) pneOraPurgeSave(pneCoreServer)
  return changed
}

// ---------------------------------------------------------------------------------------------
// Bridge I/O

// true on a dedicated server, false on an integrated one, null when unknown. In game the method is
// isDedicated(): KubeJS renames MinecraftServer.isDedicatedServer() (F37). isDedicatedServer() stays as
// the fallback (mocks, or a server subclass that still shows the Mojang name), then Platform.
function pneOraIsDedicated(server) {
  var d = null
  if (!server) return null
  try { d = server.isDedicated() ? true : false } catch (e) { d = null }
  if (d === null) {
    try { d = server.isDedicatedServer() ? true : false } catch (e1) { d = null }
  }
  if (d === null) {
    try { d = Platform.isClientEnvironment() ? false : true } catch (e2) { d = null }
  }
  return d
}

// The bridge runs only with the oracle on and, on a dedicated server (or when the server type is
// unknown), only when the world config bridge_dedicated is 1.
function pneOraBridgeOn(server) {
  if (!pneCoreOn('oracle')) return false
  if (pneOraDedicated === null && server) pneOraDedicated = pneOraIsDedicated(server)
  if (pneOraDedicated !== false && pneCoreCfg('bridge_dedicated') !== 1) return false
  return true
}

function pneOraBridgeWhy(server) {
  if (!pneCoreOn('oracle')) return 'oracle off'
  if (pneOraDedicated === null && server) pneOraDedicated = pneOraIsDedicated(server)
  if (pneOraDedicated === true && pneCoreCfg('bridge_dedicated') !== 1) return 'dedicated server (config bridge_dedicated 0)'
  if (pneOraDedicated === null && pneCoreCfg('bridge_dedicated') !== 1) return 'server type unknown (config bridge_dedicated 0)'
  return ''
}

// World id from the hive's compound (read-only; HIVE owns it), refreshed every 600 ticks.
function pneOraWorldId(server) {
  var pd
  var s = ''
  if (pneCoreTick - pneOraWidAt >= 0 && pneCoreTick - pneOraWidAt < 600) return pneOraWid
  pneOraWidAt = pneCoreTick
  pd = server ? pneCorePD(server) : null
  try { if (pd && pd.contains('pne_hive')) s = String(pd.getCompound('pne_hive').getString('wid')) } catch (e) { s = '' }
  pneOraWid = /^[0-9a-f-]{8,64}$/.test(s) ? s : ''
  return pneOraWid
}

function pneOraR4(v) {
  var n = Number(v)
  if (!isFinite(n)) return 0
  return Math.round(n * 10000) / 10000
}

// telemetry.json payload (TDD 4.4.2). want = false gives the one last file after /pne oracle off.
// Returns { obj, uuids, evs }: the players written and the event flags each one carried.
function pneOraPayload(server, want) {
  var ps = want ? pneCorePlayers(server) : []
  var out = []
  var uuids = []
  var evs = []
  var i
  var j
  var p
  var u
  var st
  var pid
  var f
  var pd
  var log
  var ev
  var obj
  var purge
  var wid
  for (i = 0; i < ps.length; i++) {
    p = ps[i]
    u = pneCoreUuid(p)
    st = u ? pneOraSt[u] : null
    if (!st || !st.snap) continue
    pid = pneCorePid(p)
    if (!PNE_ORA_PID_RX.test(pid)) continue
    f = []
    for (j = 0; j < 31; j++) f.push(pneOraR4(st.snap.f[j]))
    log = false
    pd = pneCorePD(p)
    try { log = Number(pd.getByte('pne_log')) === 1 } catch (e) { log = false }
    // respawned rides with the first sample taken after the respawn, so the sidecar's window restarts there
    ev = { died: st.ev.died, respawned: st.ev.respawned && st.snap.tick >= st.respAt, enc_start: st.ev.enc_start,
      enc_end: st.ev.enc_end, tele: st.ev.tele }
    out.push({ pid: pid, f: f, dim: st.snap.dim, comfort: pneCoreComfort(p), log: log, t: st.snap.tick, ev: ev })
    uuids.push(u)
    evs.push(ev)
  }
  obj = { v: PNE_ORA_V, boot_id: pneOraBoot, seq: pneOraSeq + 1, tick: pneCoreTick, ts_ms: Date.now(), want_oracle: want ? true : false, players: out }
  purge = pneOraPurgeList(server)
  if (purge.length) obj.purge = purge.slice()
  wid = pneOraWorldId(server)
  if (wid) obj.wid = wid
  return { obj: obj, uuids: uuids, evs: evs }
}

function pneOraIoFail(what, err) {
  pneOraIo.wFail++
  pneOraIo.consec++
  pneOraIo.err = what + ': ' + err
  if (pneOraIo.consec >= 5) pneOraIo.nextTry = pneCoreTick + PNE_ORA_IO_BACKOFF
  pneCoreWarn('oracle', 'io.' + what, 'bridge ' + what + ' failed (' + err + '); is ' + PNE_ORA_DIR + ' missing? The sidecar launcher creates it')
}

// Writes telemetry.json. Returns true on success (the cycle is skipped on failure).
function pneOraWrite(server, want) {
  var pl = pneOraPayload(server, want)
  var i
  var k
  var st
  try {
    JsonIO.write(PNE_ORA_TEL, pl.obj)
  } catch (err) {
    pneOraIoFail('write', err)
    return false
  }
  pneOraSeq = pl.obj.seq
  pneOraSeqTick[String(pneOraSeq)] = pl.obj.tick
  k = String(pneOraSeq - PNE_ORA_SEQ_KEEP)
  if (pneOraSeqTick.hasOwnProperty(k)) delete pneOraSeqTick[k]
  pneOraIo.wOk++
  pneOraIo.consec = 0
  pneOraIo.nextTry = 0
  // Flags that reached the file are cleared; the others wait for the next write.
  for (i = 0; i < pl.uuids.length; i++) {
    st = pneOraSt[pl.uuids[i]]
    if (!st) continue
    for (k in pl.evs[i]) {
      if (pl.evs[i].hasOwnProperty(k) && pl.evs[i][k] === true) st.ev[k] = false
    }
  }
  return true
}

// Reads verdict.json (missing -> no sidecar yet; a torn file throws -> keep the last verdict).
function pneOraRead() {
  var m = null
  try {
    m = JsonIO.read(PNE_ORA_VER)
  } catch (err) {
    pneOraIo.rTorn++
    return false
  }
  if (m === null || m === undefined) {
    pneOraIo.rMissing++
    return false
  }
  return pneOraAccept(m)
}

// Reads status.json only for the purge hand-shake.
function pneOraReadStatus() {
  var m = null
  try { m = JsonIO.read(PNE_ORA_STA) } catch (err) { return false }
  if (m === null || m === undefined) return false
  return pneOraPurgeAck(pneOraGet(m, 'purged'))
}

// ---------------------------------------------------------------------------------------------
// Tick handler: telemetry at the players' slots, bridge write at slot 0, read at slot 10.
// A write or read refused by the token budget retries on the following ticks (docs/IMPLEMENTATION.md 7.2).

function pneOraTelemetryOn() {
  return pneCoreOn('resonance') || pneCoreOn('hive') || pneCoreOn('oracle')
}

function pneOraCleanup() {
  var u
  var pid
  var online = {}
  var ps = pneCoreAllPlayers(pneCoreServer)
  var i
  for (i = 0; i < ps.length; i++) online[pneCoreUuid(ps[i])] = true
  for (u in pneOraSt) {
    if (pneOraSt.hasOwnProperty(u) && !online[u] && pneCoreTick - pneOraSt[u].seen > 1200) delete pneOraSt[u]
  }
  for (pid in pneOraVerdicts) {
    if (pneOraVerdicts.hasOwnProperty(pid) && pneCoreTick - pneOraVerdicts[pid].tick > 1200) delete pneOraVerdicts[pid]
  }
  for (u in pneOraLogCodes) {
    if (pneOraLogCodes.hasOwnProperty(u) && pneCoreTick - pneOraLogCodes[u].tick > PNE_ORA_CONFIRM_TICKS) delete pneOraLogCodes[u]
  }
}

function pneOraOnTick(event) {
  var server
  var ps
  var i
  if (PNE_ORA_B_TICK.off) return
  try {
    server = event.server
    if (!pneOraBoot) pneOraBoot = String(Date.now())
    if (pneOraTelemetryOn()) {
      ps = pneCorePlayersAtSlot(server)
      for (i = 0; i < ps.length; i++) {
        if (!pneCoreTake(PNE_CORE_COST.playerTel)) break
        pneOraSample(ps[i])
      }
    }
    if (pneOraBridgeOn(server)) {
      pneOraOffPending = false
      if (pneCoreSlot === PNE_CORE_SLOT_WRITE) pneOraWritePending = true
      if (pneCoreSlot === PNE_CORE_SLOT_READ) pneOraReadPending = true
      if (pneOraWritePending && pneCoreTick >= pneOraIo.nextTry && pneCoreTake(PNE_CORE_COST.bridgeWrite)) {
        pneOraWritePending = false
        pneOraWrite(server, true)
      } else if (pneOraWritePending && pneCoreTick < pneOraIo.nextTry) {
        pneOraWritePending = false
      }
      if (pneOraReadPending && pneCoreTake(PNE_CORE_COST.bridgeRead)) {
        pneOraReadPending = false
        pneOraRead()
        if (pneOraPurgeList(server).length) pneOraStatusPending = true
      }
      if (pneOraStatusPending && !pneOraReadPending && pneCoreTake(PNE_CORE_COST.bridgeRead)) {
        pneOraStatusPending = false
        if (pneOraPurgeList(server).length) pneOraReadStatus()
      }
    } else if (pneOraOffPending) {
      if (pneCoreTake(PNE_CORE_COST.bridgeWrite)) {
        pneOraOffPending = false
        pneOraWrite(server, false)
      }
    }
    if (pneCoreTick % 1200 === 3) pneOraCleanup()
    pneCoreOk(PNE_ORA_B_TICK)
  } catch (err) {
    pneCoreFail(PNE_ORA_B_TICK, err)
  }
}

// ---------------------------------------------------------------------------------------------
// Event handlers (O(1), never cancel)

function pneOraOnLoaded(event) {
  if (PNE_ORA_B_EVENTS.off) return
  try {
    pneOraDedicated = pneOraIsDedicated(event.server)
    pneOraPurge = null
    pneOraPurgeList(event.server)
    pneOraWidAt = -1000000
  } catch (err) {
    pneCoreFail(PNE_ORA_B_EVENTS, err)
  }
}

// Server stopping: tell a running sidecar that the game no longer wants verdicts.
function pneOraOnUnloaded(event) {
  try {
    if (pneOraBoot && pneOraBridgeOn(event.server) && pneOraIo.wOk > 0) pneOraWrite(event.server, false)
  } catch (err) { }
}

function pneOraOnLogin(event) {
  var p
  var srv
  if (PNE_ORA_B_EVENTS.off) return
  try {
    p = event.player
    if (!pneOraLogOn(p)) return
    try { srv = p.getServer() } catch (e) { srv = null }
    pneCoreTellraw(srv || pneCoreServer, pneCoreUuid(p),
      'The Hive Remembers: Oracle telemetry logging is ON for you. While the optional sidecar runs, it stores your samples ' +
      'under a random pseudonym on this computer only and deletes logs older than 7 days each time it runs. ' +
      '/pne oracle log off stops it, /pne oracle purge deletes your logs.', 'gold')
  } catch (err) {
    pneCoreFail(PNE_ORA_B_EVENTS, err)
  }
}

function pneOraOnLogout(event) {
  var u
  if (PNE_ORA_B_EVENTS.off) return
  try {
    u = pneCoreUuid(event.player)
    if (u && pneOraSt.hasOwnProperty(u)) delete pneOraSt[u]
    if (u && pneOraLogCodes.hasOwnProperty(u)) delete pneOraLogCodes[u]
  } catch (err) {
    pneCoreFail(PNE_ORA_B_EVENTS, err)
  }
}

function pneOraOnRespawn(event) {
  var u
  var st
  if (PNE_ORA_B_EVENTS.off) return
  try {
    u = pneCoreUuid(event.player)
    if (!u) return
    st = pneOraState(u)
    st.ev.respawned = true
    st.respAt = pneCoreTick + 1
  } catch (err) {
    pneCoreFail(PNE_ORA_B_EVENTS, err)
  }
}

function pneOraOnDeath(event) {
  var u
  if (PNE_ORA_B_EVENTS.off) return
  try {
    u = pneCoreUuid(event.entity)
    if (u) pneOraState(u).ev.died = true
  } catch (err) {
    pneCoreFail(PNE_ORA_B_EVENTS, err)
  }
}

// One handler for every living entity's hurt event (LivingAttackEvent, F20): damage taken by a player
// (t_since_dmg) and damage dealt by a player (dealt; the owner for projectiles). A repeat on the same
// victim within 10 ticks counts only the excess, like vanilla invulnerability frames.
function pneOraOnHurt(event) {
  var victim
  var src = null
  var amt
  var u
  var vu
  var st
  var add
  if (PNE_ORA_B_EVENTS.off) return
  try {
    victim = event.entity
    amt = pneOraNum(event.damage, 0)
    if (!(amt > 0)) return
    if (pneCoreIsPlayer(victim)) {
      u = pneCoreUuid(victim)
      if (u) pneOraState(u).tel.pendingHurt = true
    }
    try { src = pneOraSourceEntity(event.source) } catch (e) { src = null }
    if (!src || !pneCoreIsPlayer(src)) return
    u = pneCoreUuid(src)
    vu = pneCoreUuid(victim)
    if (!u || u === vu) return
    st = pneOraState(u)
    add = amt
    if (vu && st.dealtU === vu && pneCoreTick - st.dealtT >= 0 && pneCoreTick - st.dealtT < 10) {
      add = amt > st.dealtA ? amt - st.dealtA : 0
      if (amt > st.dealtA) st.dealtA = amt
    } else {
      st.dealtU = vu
      st.dealtT = pneCoreTick
      st.dealtA = amt
    }
    st.tel.pendingDealt += add
  } catch (err) {
    pneCoreFail(PNE_ORA_B_EVENTS, err)
  }
}

function pneOraOnPlaced(event) {
  var ent
  var u
  var st
  if (PNE_ORA_B_EVENTS.off) return
  try {
    ent = event.entity
    if (!ent || !pneCoreIsPlayer(ent)) return
    u = pneCoreUuid(ent)
    if (!u) return
    st = pneOraState(u)
    st.tel.pendingPlaces++
    if (pneOraIsLight(event.block)) st.tel.pendingTorches++
  } catch (err) {
    pneCoreFail(PNE_ORA_B_EVENTS, err)
  }
}

// /pne oracle off: one last telemetry.json with want_oracle false, verdicts dropped.
function pneOraOnToggle(on, server) {
  if (!on) {
    pneOraOffPending = pneOraIo.wOk > 0
    pneOraVerdicts = {}
    pneOraWritePending = false
    pneOraReadPending = false
    pneOraStatusPending = false
  }
}

// ---------------------------------------------------------------------------------------------
// Commands: /pne oracle status | log on | log off | purge (the core handles /pne oracle [on|off]).

function pneOraAnswering() {
  return pneOraAcceptTick >= 0 && pneCoreTick - pneOraAcceptTick >= 0 && pneCoreTick - pneOraAcceptTick <= PNE_ORA_STALE
}

function pneOraLogOn(player) {
  var pd = pneCorePD(player)
  try { return Number(pd.getByte('pne_log')) === 1 } catch (e) { return false }
}

function pneOraStatusLine(player) {
  var why = pneOraBridgeWhy(pneCoreServer)
  var n = 0
  var u
  var s
  for (u in pneOraSt) {
    if (pneOraSt.hasOwnProperty(u) && pneOraSt[u].snap) n++
  }
  s = 'bridge ' + (why ? 'off (' + why + ')' : (pneOraIo.consec > 0 ? 'failing (' + pneOraIo.err + ')' : 'on')) +
    ', sidecar ' + (pneOraAnswering() ? 'answering (' + (pneOraBackend || 'no backend') + ', ' + pneCoreFmt((pneCoreTick - pneOraAcceptTick) / 20) + ' s)' : 'silent') +
    ', seq ' + pneOraSeq + '/' + (pneOraApplied < 0 ? '-' : pneOraApplied) +
    ', reads ok ' + pneOraIo.rOk + ' missing ' + pneOraIo.rMissing + ' torn ' + pneOraIo.rTorn +
    ', telemetry for ' + n + ' player(s)'
  if (player) s += '; your logging ' + (pneOraLogOn(player) ? 'ON' : 'off')
  return s
}

function pneOraCmdStatus(ctx) {
  var m = null
  var w
  ctx.reply('Oracle: ' + pneOraStatusLine(ctx.player), 'gold')
  try { m = JsonIO.read(PNE_ORA_STA) } catch (e) { m = null }
  if (m) {
    w = pneOraGet(m, 'worker')
    ctx.reply('sidecar status.json: backend ' + pneOraStr(pneOraGet(m, 'backend')) + ', worker ' + pneOraStr(pneOraGet(w, 'state')) +
      ', up ' + pneCoreFmt(pneOraGet(m, 'uptime_s')) + ' s, infer p50 ' + pneCoreFmt(pneOraGet(m, 'infer_p50_us')) + ' us' +
      (pneOraLen(pneOraGet(m, 'errors')) ? ', errors ' + pneOraLen(pneOraGet(m, 'errors')) : ''), 'gray')
  } else {
    ctx.reply('No sidecar status found. Start it with launch_oracle.cmd in <instance>/local/pne_oracle (optional: the pack works without it).', 'gray')
  }
  if (ctx.player) {
    ctx.reply(pneOraLogOn(ctx.player)
      ? 'Your telemetry logging is ON (pseudonymous, stays on this computer; the sidecar deletes logs older than 7 days each time it runs). ' +
        '/pne oracle log off stops it; /pne oracle purge deletes your logs.'
      : 'Your telemetry logging is off. Only you can turn it on for yourself: /pne oracle log on, then confirm in your chat.', 'gray')
  }
  return true
}

// A fresh one-time confirmation code (12 hex digits; SecureRandom through java.util.UUID when available).
function pneOraNewCode() {
  var s = ''
  var hex = '0123456789abcdef'
  var i
  try { s = String($PneOraUUID.randomUUID().toString()).replace(/-/g, '').substring(0, 12) } catch (e) { s = '' }
  if (!PNE_ORA_CODE_RX.test(s)) {
    s = ''
    for (i = 0; i < 12; i++) s += hex.charAt(Math.floor(Math.random() * 16))
  }
  return s
}

// The confirmation prompt, sent to that player alone (tellraw by UUID). Whoever ran the command through
// "execute as" never sees it; the player clicks it (or types the command) to confirm.
function pneOraPrompt(server, u, code) {
  var cmd = '/pne oracle log confirm ' + code
  var msg = ['',
    { text: 'The Hive Remembers: turn Oracle telemetry logging ON for yourself? ', color: 'gold' },
    { text: 'While the optional sidecar runs, it stores your once-per-second gameplay features (movement, health, nearby ' +
      'parasites; no name, UUID or x/z position) under a random pseudonym on this computer, and deletes logs older than 7 days ' +
      'each time it runs. ', color: 'gray' },
    { text: '[Yes, log my samples]', color: 'green', underlined: true,
      clickEvent: { action: 'run_command', value: cmd }, hoverEvent: { action: 'show_text', contents: 'Runs ' + cmd } },
    { text: ' Valid for 60 s and only shown to you. Ignore it to keep logging off.', color: 'gray' }]
  server.runCommandSilent('tellraw ' + u + ' ' + JSON.stringify(msg))
}

// /pne oracle log on | off. Off takes effect at once (it only reduces data). On never sets pne_log by
// itself: it sends the caller a one-time code, because "execute as <player>" makes anyone with command
// access look like that player here (CommandSourceStack.getPlayer() is the re-targeted entity).
function pneOraCmdLog(ctx, on) {
  var pd
  var u
  var pend
  var code
  if (!ctx.player) {
    ctx.reply('Logging is a per-player choice: each player runs /pne oracle log on|off for themselves.', 'red')
    return true
  }
  u = pneCoreUuid(ctx.player)
  pd = pneCorePD(ctx.player)
  if (!pd || !u || !ctx.server) {
    ctx.reply('Could not change your logging setting.', 'red')
    return true
  }
  if (!on) {
    if (pneOraLogCodes.hasOwnProperty(u)) delete pneOraLogCodes[u]
    pd.putByte('pne_log', 0)
    ctx.reply('Oracle telemetry logging is off for you. /pne oracle purge also deletes what was logged.', 'gold')
    return true
  }
  if (pneOraLogOn(ctx.player)) {
    ctx.reply('Your telemetry logging is already ON. /pne oracle log off stops it; /pne oracle purge deletes your logs.', 'gold')
    return true
  }
  pend = pneOraLogCodes.hasOwnProperty(u) ? pneOraLogCodes[u] : null
  if (pend && pneCoreTick - pend.tick >= 0 && pneCoreTick - pend.tick < PNE_ORA_PROMPT_GAP) return true
  code = pneOraNewCode()
  pneOraLogCodes[u] = { code: code, tick: pneCoreTick }
  pneOraPrompt(ctx.server, u, code)
  return true
}

// /pne oracle log confirm <code>: the only way pne_log becomes 1. The code must be the caller's own,
// unused and at most 60 s old; any attempt uses it up, so it cannot be guessed by trying.
function pneOraCmdConfirm(ctx, code) {
  var pd
  var u
  var pend
  var ok
  if (!ctx.player) {
    ctx.reply('Logging is a per-player choice: each player turns it on for themselves.', 'red')
    return true
  }
  u = pneCoreUuid(ctx.player)
  pend = (u && pneOraLogCodes.hasOwnProperty(u)) ? pneOraLogCodes[u] : null
  if (pend) delete pneOraLogCodes[u]
  ok = pend !== null && PNE_ORA_CODE_RX.test(code) && code === pend.code &&
    pneCoreTick - pend.tick >= 0 && pneCoreTick - pend.tick <= PNE_ORA_CONFIRM_TICKS
  if (!ok) {
    ctx.reply('That confirmation is not valid (wrong, already used or older than 60 s). Run /pne oracle log on again.', 'red')
    return true
  }
  pd = pneCorePD(ctx.player)
  if (!pd) {
    ctx.reply('Could not change your logging setting.', 'red')
    return true
  }
  pd.putByte('pne_log', 1)
  ctx.reply('Oracle telemetry logging is ON for you only. While the optional sidecar runs, it stores your once-per-second ' +
    'gameplay features (movement, health, nearby parasites; no name, UUID or x/z position) under a random pseudonym on this ' +
    'computer and deletes logs older than 7 days each time it runs. /pne oracle log off stops it; /pne oracle purge deletes your logs.', 'gold')
  return true
}

function pneOraCmdPurge(ctx) {
  var old
  var fresh
  var list
  if (!ctx.player) {
    ctx.reply('Purge is per player: each player runs /pne oracle purge for themselves.', 'red')
    return true
  }
  old = pneCorePid(ctx.player)
  fresh = pneCorePidRotate(ctx.player)
  if (!PNE_ORA_PID_RX.test(fresh)) {
    ctx.reply('Could not rotate your pseudonym; nothing was changed.', 'red')
    return true
  }
  list = pneOraPurgeList(ctx.server)
  if (PNE_ORA_PID_RX.test(old) && list.indexOf(old) < 0) {
    list.push(old)
    while (list.length > PNE_ORA_PURGE_MAX) list.shift()
    pneOraPurgeSave(ctx.server)
  }
  if (pneOraVerdicts.hasOwnProperty(old)) delete pneOraVerdicts[old]
  ctx.reply('Your pseudonym was replaced. The sidecar deletes the logs of the old one while it runs (now, or the next time ' +
    'it starts; a log file another program holds open is deleted as soon as it is released)' +
    (pneOraLogOn(ctx.player) ? '; logging stays ON under the new pseudonym (/pne oracle log off to stop).' : '.'), 'gold')
  return true
}

function pneOraCmd(ctx) {
  var a0 = ctx.args.length ? String(ctx.args[0]).toLowerCase() : ''
  var a1 = ctx.args.length > 1 ? String(ctx.args[1]).toLowerCase() : ''
  var a2 = ctx.args.length > 2 ? String(ctx.args[2]).toLowerCase() : ''
  if (PNE_ORA_B_CMD.off) return false
  try {
    if (a0 === 'status' && ctx.args.length === 1) return pneOraCmdStatus(ctx)
    if (a0 === 'log' && ctx.args.length === 2 && (a1 === 'on' || a1 === 'off')) return pneOraCmdLog(ctx, a1 === 'on')
    if (a0 === 'log' && ctx.args.length === 3 && a1 === 'confirm') return pneOraCmdConfirm(ctx, a2)
    if (a0 === 'purge' && ctx.args.length === 1) return pneOraCmdPurge(ctx)
    return false
  } catch (err) {
    pneCoreFail(PNE_ORA_B_CMD, err)
    ctx.reply('That oracle command failed; see the server log.', 'red')
    return true
  }
}

// ---------------------------------------------------------------------------------------------
// Registration

if (!pneOraReady) console.error('[pne_oracle_bridge] pne_00_core.js did not load; this module stays off')
if (pneOraReady) {
  ServerEvents.tick(pneOraOnTick)
  ServerEvents.loaded(pneOraOnLoaded)
  ServerEvents.unloaded(pneOraOnUnloaded)
  PlayerEvents.loggedIn(pneOraOnLogin)
  PlayerEvents.loggedOut(pneOraOnLogout)
  PlayerEvents.respawned(pneOraOnRespawn)
  EntityEvents.death('minecraft:player', pneOraOnDeath)
  EntityEvents.hurt(pneOraOnHurt)
  BlockEvents.placed(pneOraOnPlaced)
  pneCoreCommand('oracle', { run: pneOraCmd, help: 'oracle status|log on|log off|purge: sidecar state, your own telemetry logging (on asks you to confirm), delete your logs' })
  pneCoreStatus('oracle', pneOraStatusLine)
  pneCoreOnToggle('oracle', pneOraOnToggle)
}
