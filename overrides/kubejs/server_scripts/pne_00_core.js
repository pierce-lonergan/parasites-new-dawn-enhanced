// priority: 100
// Parasites New Dawn - Enhanced :: The Hive Remembers, shared core (server side)
//
// Every Hive Remembers server module builds on this file. It holds:
//   1. config defaults and the per-pillar on/off flags (persisted in server.persistentData),
//   2. the shared 2.5 ms per-tick token budget with fixed, measured cost constants,
//   3. the broken-counter helper, logging, and a status-line registry,
//   4. per-player helpers: survival check, UUID, comfort, pseudonymous pid, mercy and grace,
//   5. safe cross-module wrappers that fall back to defaults when a module is absent,
//   6. the one /pne command hub that every module registers its subcommands with.
// The contract every builder follows is docs/IMPLEMENTATION.md. Names here are binding.
//
// Load order: KubeJS sorts server scripts by the priority header, highest first
// (ScriptFile.compareTo, KubeJS 2001.6.5). All server scripts share one scope, so the top-level
// names below are visible to every later file. This file's tick handler is registered first,
// so it runs first in every tick (handlers run in registration order).
//
// Rules this file follows (Rhino fork rhino-forge-2001.2.3, see docs/IMPLEMENTATION.md):
//  * ES5 only. Every var sits at the top of its function; Rhino scopes var to the enclosing block.
//  * Values read from Java are converted before use: String(...) for strings (tags, NBT), and
//    String(...) or Number(...) for everything read back from the global map, which returns wrapped
//    Java objects (typeof 'object'; === and !== against a number or string always fail).
//  * Every handler body is wrapped in try/catch and counts failures (broken counter).
//  * No camera, screen or effect changes anywhere. Comfort is on unless a player opts out.
//  * Nothing here spawns, kills or discards anything.

// ---------------------------------------------------------------------------------------------
// Constants

var PNE_CORE_API = 1
var PNE_CORE_VERSION = '1.0.0'
var PNE_CORE_PILLARS = ['resonance', 'hive', 'oracle', 'visual']

// Config defaults, stored as ints under server.persistentData 'pne_cfg_<key>'. An absent key
// means the default. Lead decisions: light aversion on, governor target 1 hive-caused death per
// player per 3 in-game days. Telemetry logging has no config key on purpose: it is off unless that
// player runs /pne oracle log on (player.persistentData.pne_log), and an operator cannot turn it on
// for anyone else (TDD 4.4.2, I11).
// vis_grafts (VISUAL): 0 removes the display grafts but keeps teams, names and particles (a grafted host is not pushed
// by other entities and does not stroll while it carries one, docs/modules/visual.md).
var PNE_CORE_DEFAULTS = {
  on_resonance: 1, on_hive: 1, on_oracle: 1, on_visual: 1,
  light_aversion: 1,
  gov_deaths: 1,
  gov_days: 3,
  bridge_dedicated: 0,
  spawn_gate: 1,
  spawn_backstop: 1,
  vis_grafts: 1,
  debug: 0
}
var PNE_CORE_BOUNDS = {
  on_resonance: [0, 1], on_hive: [0, 1], on_oracle: [0, 1], on_visual: [0, 1],
  light_aversion: [0, 1], gov_deaths: [1, 20], gov_days: [1, 30],
  bridge_dedicated: [0, 1], spawn_gate: [0, 1], spawn_backstop: [0, 1], vis_grafts: [0, 1], debug: [0, 1]
}

// Token budget (TDD 3.7). Costs are fixed constants in ms, measured in Rhino on the desktop JVM,
// because no nanosecond clock is reachable through the KubeJS class filter (java.lang.System is
// denied). Set by the lead from the module benchmarks (docs/IMPLEMENTATION.md 7.3, integration round):
// rejoin/newborn/save and the hive keys from hive-rhino-bench (p50 x ~1.3), breed/dawn/gaSave from
// ga-core-breed-bench (warm per-call p95 with headroom; breed is breed() alone, the insert is charged per
// outcome by HIVE), playerTel from oracle-telemetry-bench (p90 0.29 ms at 150 entities, plus headroom),
// director/emit from the director's Rhino harness. spark in game has the last word.
// outcome: one GA outcome insert (PNE_HIVE_GA.outcome), hive-rhino-bench p50 x ~1.3 (lead decision, contract 7.3: the
// measured value like every other hive key, not GA-CORE's 0.7 cold-JVM margin). steer: one Mob#getNavigation().moveTo
// for SCT steering (config debug 1 only); a PLACEHOLDER, never measured offline, until the spark measurement of
// docs/TESTING.md M3 replaces it.
var PNE_CORE_BUDGET_MS = 2.5
var PNE_CORE_COST = {
  rejoin: 0.12,
  newborn: 0.32,
  mobSample: 0.0096,
  playerTel: 0.35,
  breed: 0.7,
  dreamSlice: 1.5,
  dawn: 1.2,
  gaSave: 2.0,
  gaSavePart: 0.6,
  save: 0.12,
  bridgeWrite: 0.41,
  bridgeRead: 0.39,
  director: 0.15,
  emit: 0.04,
  lightPass: 0.3,
  graftSync: 0.02,
  visApply: 0.05,
  sweep: 0.3,
  upkeep: 0.01,
  leaveOut: 0.03,
  convRec: 0.0007,
  silentVisit: 0.06,
  nearBase: 0.015,
  nearRec: 0.0007,
  outcome: 0.6,
  steer: 1.0
}

// Tick slots (tick % 20). 0 = bridge write, 10 = bridge read; nothing else heavy runs there.
// Per-player work (telemetry and the director step) uses the 18 other slots. The first 8 players
// get the even slots, which never hold a breed (t % 4 === 3 -> odd slots 3, 7, 11, 15, 19) or a
// dream slice (t % 4 === 1 -> slots 1, 5, 9, 13, 17), so their telemetry never shares a tick with
// the GA's slot work.
var PNE_CORE_SLOT_WRITE = 0
var PNE_CORE_SLOT_READ = 10
var PNE_CORE_SLOT_HOUSE = 5
var PNE_CORE_TEL_SLOTS = [2, 4, 6, 8, 12, 14, 16, 18, 1, 5, 9, 13, 17, 3, 7, 11, 15, 19]

var PNE_CORE_MERCY_HP = 0.30       // health fraction at or below which a player is in mercy
var PNE_CORE_GRACE_TICKS = 2400    // respawn grace, 120 s
var PNE_CORE_GATE_RADIUS = 48      // natural-spawn gate radius (blocks)
var PNE_CORE_AXE_CMD = 7301        // CustomModelData of the empty-model axe (Spore hosts)
var PNE_CORE_GATE_FRESH = 100      // pne_gate counts only while pne_m_t is at most this many ticks old
var PNE_CORE_PACE_STALE = 40       // a director Pace older than this (ticks) is replaced by the fallback
var PNE_CORE_HIT_WINDOW = 200      // a death within this many ticks of a parasite hit is hive-caused
var PNE_CORE_LF_COMFORT = 1400     // no-director fallback: comfort LF sounds at least 70 s apart

// Player tags (scoreboard tags on the entity, readable from startup and server scripts alike)
var PNE_CORE_TAG_MERCY = 'pne_mercy'
var PNE_CORE_TAG_GRACE = 'pne_grace'
var PNE_CORE_TAG_COMFORT_OFF = 'pne_comfort_off'
var PNE_CORE_TAG_GATE = 'pne_gate'
var PNE_CORE_TAG_PACE_SOFT = 'pne_pace_soft'

// FNV-1a over this table (charCodeAt is unusable in Rhino: it returns a java.lang.Character)
var PNE_CORE_ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'

// ---------------------------------------------------------------------------------------------
// Java classes (all optional; every use is guarded)

var $PneCoreUUID = null
var $PneCoreTagKey = null
var $PneCoreRegistries = null
var $PneCoreResourceLocation = null
var $PneCoreForgeRegistries = null
try { $PneCoreUUID = Java.loadClass('java.util.UUID') } catch (e) { $PneCoreUUID = null }
try { $PneCoreTagKey = Java.loadClass('net.minecraft.tags.TagKey') } catch (e) { $PneCoreTagKey = null }
try { $PneCoreRegistries = Java.loadClass('net.minecraft.core.registries.Registries') } catch (e) { $PneCoreRegistries = null }
try { $PneCoreResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation') } catch (e) { $PneCoreResourceLocation = null }
try { $PneCoreForgeRegistries = Java.loadClass('net.minecraftforge.registries.ForgeRegistries') } catch (e) { $PneCoreForgeRegistries = null }

// ---------------------------------------------------------------------------------------------
// Logging and the broken counter

// mode 'consecutive' (tick loops: pneCoreOk resets the count) or 'total' (event handlers).
function pneCoreBreaker(name, limit, mode) {
  return { name: String(name), limit: limit > 0 ? limit : 5, mode: mode === 'total' ? 'total' : 'consecutive', n: 0, total: 0, off: false }
}

function pneCoreOk(b) {
  if (b && b.mode === 'consecutive') b.n = 0
}

function pneCoreFail(b, err) {
  if (!b) return
  b.n++
  b.total++
  if (b.total <= 3 || b.n >= b.limit) console.warn('[pne] ' + b.name + ' failed (' + b.n + '/' + b.limit + '): ' + err)
  if (b.n >= b.limit && !b.off) {
    b.off = true
    console.warn('[pne] ' + b.name + ' disabled until the next reload')
  }
}

function pneCoreLog(mod, msg) {
  console.info('[pne_' + mod + '] ' + msg)
}

var pneCoreWarnSeen = {}
// Logs at most `max` times per key (default 3), then stays quiet.
function pneCoreWarn(mod, key, msg, max) {
  var k = String(mod) + ':' + String(key)
  var lim = max > 0 ? max : 3
  var n = pneCoreWarnSeen[k] || 0
  if (n >= lim) return
  pneCoreWarnSeen[k] = n + 1
  console.warn('[pne_' + mod + '] ' + msg)
}

var PNE_CORE_B_TICK = pneCoreBreaker('core.tick', 5, 'consecutive')
var PNE_CORE_B_EVENTS = pneCoreBreaker('core.events', 20, 'total')
var PNE_CORE_B_CMD = pneCoreBreaker('core.commands', 20, 'total')
// One breaker per foreign module, used by the safe wrappers below.
var PNE_CORE_B_API = {
  resonance: pneCoreBreaker('api.resonance', 20, 'total'),
  hive: pneCoreBreaker('api.hive', 20, 'total'),
  oracle: pneCoreBreaker('api.oracle', 20, 'total'),
  visual: pneCoreBreaker('api.visual', 20, 'total')
}

// ---------------------------------------------------------------------------------------------
// Small helpers

function pneCoreClamp(x, lo, hi) {
  var v = Number(x)
  if (!isFinite(v)) return lo
  return v < lo ? lo : (v > hi ? hi : v)
}

function pneCoreFmt(n) {
  var v = Number(n)
  return (isFinite(v) ? v : 0).toFixed(2)
}

function pneCoreImul(a, b) {
  var ah = (a >>> 16) & 0xffff
  var al = a & 0xffff
  var bh = (b >>> 16) & 0xffff
  var bl = b & 0xffff
  return ((al * bl) + (((ah * bl + al * bh) << 16) >>> 0)) >>> 0
}

// FNV-1a 32-bit, c = ASCII.indexOf(ch) + 32 (TDD 3.3.1). Unsigned result.
function pneCoreFnv1a(s) {
  var str = String(s)
  var h = 0x811c9dc5
  var i
  var c
  for (i = 0; i < str.length; i++) {
    c = PNE_CORE_ASCII.indexOf(str.charAt(i)) + 32
    h = (h ^ c) >>> 0
    h = pneCoreImul(h, 16777619)
  }
  return h >>> 0
}

// Java members are called by their Mojang names. KubeJS installs the Rhino fork's MinecraftRemapper
// (ScriptManager.load -> Context.setRemapper), and JavaMembers then registers only the mapped name:
// SRG names such as entity['m_19880_'] are not visible to scripts in game, so there are no SRG fallbacks.
function pneCoreHasTag(entity, tag) {
  try { return entity.getTags().contains(tag) ? true : false } catch (e) { return false }
}

function pneCoreSetTag(entity, tag, on) {
  var has = pneCoreHasTag(entity, tag)
  try {
    if (on && !has) entity.addTag(tag)
    else if (!on && has) entity.removeTag(tag)
  } catch (e) { }
}

// KubeJS persistent data (CompoundTag saved as "KubeJSPersistentData" on the entity, or the server's
// kubejs_persistent_data.nbt). On entities the name is unambiguous in game: KubeJS's forge EntityMixin
// shadows Forge's getPersistentData() with @RemapForJS("getForgePersistentData"), and Mixin copies a
// @Shadow method's annotations onto the target (MixinApplicatorStandard.applyShadowMethod ->
// Annotations.merge), so JS 'persistentData' / getPersistentData() is kjs$getPersistentData.
// pneCorePdCheck(entity) confirms that at run time (shown in /pne status).
function pneCorePD(obj) {
  try { return obj.persistentData } catch (e) { }
  try { return obj.getPersistentData() } catch (e2) { }
  return null
}

var pneCorePdMode = '?'   // 'kjs' once a player showed getForgePersistentData(), 'AMBIGUOUS' if not

function pneCorePdCheck(entity) {
  var ok = false
  try { ok = typeof entity.getForgePersistentData === 'function' } catch (e) { ok = false }
  pneCorePdMode = ok ? 'kjs' : 'AMBIGUOUS'
  if (!ok) pneCoreWarn('core', 'pd', 'entity.getForgePersistentData is missing: the KubeJS persistentData shadowing is not in effect, so pne_* player keys may land in Forge data and reset on death')
  return ok
}

var PNE_CORE_UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// UUID string ('' when unreadable). KubeJS names first (getStringUuid/getUuid, @RemapForJS on
// Entity), then the Mojang names; a value is accepted only if it looks like a UUID, so a missing
// member can never turn into the string 'undefined'.
function pneCoreUuid(entity) {
  var s = ''
  if (!entity) return ''
  try { s = String(entity.getStringUuid()) } catch (e) { s = '' }
  if (PNE_CORE_UUID_RX.test(s)) return s
  try { s = String(entity.getStringUUID()) } catch (e2) { s = '' }
  if (PNE_CORE_UUID_RX.test(s)) return s
  try { s = String(entity.getUuid()) } catch (e3) { s = '' }
  if (PNE_CORE_UUID_RX.test(s)) return s
  try { s = String(entity.getUUID()) } catch (e4) { s = '' }
  if (PNE_CORE_UUID_RX.test(s)) return s
  return ''
}

function pneCoreIsPlayer(entity) {
  try { return entity.isPlayer() ? true : false } catch (e) { return false }
}

// Survival or adventure (not spectator, not creative). Unknown counts as survival, so safety
// features apply when in doubt.
function pneCoreIsSurvival(player) {
  var spec = false
  var crea = false
  try { spec = player.isSpectator() ? true : false } catch (e) { spec = false }
  try { crea = player.isCreative() ? true : false } catch (e2) { crea = false }
  return !spec && !crea
}

function pneCoreHp(entity) {
  var h = NaN
  var m = NaN
  try { h = Number(entity.getHealth()); m = Number(entity.getMaxHealth()) } catch (e) { }
  if (!(m > 0) || !isFinite(h)) return 1
  return pneCoreClamp(h / m, 0, 1)
}

// Server tick count and game time
var pneCoreTick = 0         // MinecraftServer tick count this run (monotonic across /reload)
var pneCoreSlot = 0         // pneCoreTick % 20
var pneCoreLocalTicks = 0   // fallback counter
var pneCoreServer = null

// Level.getGameTime() is visible to scripts only as getTime(): KubeJS puts @RemapForJS("getTime") on it and Mixin
// merges that annotation (contract F37, suite visual-kjs-renames). getGameTime() stays as the fallback for mocks,
// reached only when getTime() on the same level gave nothing (the kjs-lint hidden-name rule).
function pneCoreLevelTime(level) {
  var t = NaN
  try { t = Number(level.getTime()) } catch (e) { t = NaN }
  if (!isFinite(t)) {
    try { t = Number(level.getGameTime()) } catch (e2) { t = NaN }
  }
  return t
}

// Overworld game time (server.getOverworld() is KubeJS's; overworld() is the Mojang method, F27).
function pneCoreGameTime(server) {
  var srv = server || pneCoreServer
  var lvl = null
  var t = NaN
  try { lvl = srv.getOverworld() } catch (e0) { lvl = null }
  if (!lvl) {
    try { lvl = srv.overworld() } catch (e) { lvl = null }
  }
  if (lvl) t = pneCoreLevelTime(lvl)
  return isFinite(t) ? t : pneCoreTick
}

// ---------------------------------------------------------------------------------------------
// Config and pillar flags

var pneCoreCfgCache = null

function pneCoreCfgLoad(server) {
  var srv = server || pneCoreServer
  var pd = srv ? pneCorePD(srv) : null
  var out = {}
  var k
  for (k in PNE_CORE_DEFAULTS) {
    if (!PNE_CORE_DEFAULTS.hasOwnProperty(k)) continue
    out[k] = PNE_CORE_DEFAULTS[k]
    if (pd) {
      try {
        if (pd.contains('pne_cfg_' + k)) out[k] = pneCoreClamp(Number(pd.getInt('pne_cfg_' + k)), PNE_CORE_BOUNDS[k][0], PNE_CORE_BOUNDS[k][1])
      } catch (e) { }
    }
  }
  if (pd) pneCoreCfgCache = out
  pneCoreMirror(out)
  return out
}

function pneCoreCfg(key) {
  var c = pneCoreCfgCache || pneCoreCfgLoad(null)
  if (c.hasOwnProperty(key)) return c[key]
  return PNE_CORE_DEFAULTS.hasOwnProperty(key) ? PNE_CORE_DEFAULTS[key] : 0
}

// Returns true when stored. Unknown keys and out-of-range values are refused.
function pneCoreCfgSet(server, key, value) {
  var srv = server || pneCoreServer
  var pd = srv ? pneCorePD(srv) : null
  var v = Math.floor(Number(value))
  if (!PNE_CORE_DEFAULTS.hasOwnProperty(key) || !isFinite(v)) return false
  if (v < PNE_CORE_BOUNDS[key][0] || v > PNE_CORE_BOUNDS[key][1]) return false
  if (!pd) return false
  pd.putInt('pne_cfg_' + key, v)
  pneCoreCfgCache = null
  pneCoreCfgLoad(srv)
  return true
}

function pneCoreOn(pillar) {
  return pneCoreCfg('on_' + pillar) === 1
}

// Startup scripts read the pillar flags from the shared global map (numbers 1 or 0).
// pneOnHive is 1 only while the hive runtime can drain what the startup producers enqueue: on_hive is 1 AND pne_hive.js
// and the GA core it needs have loaded (contract 4.5; without either nobody drains global.pneHiveQDamage/QLeave). The
// scripts after this one have not run yet while it loads, so pneOnHive is left as it is (a /reload keeps the old value,
// a fresh launch has none, so nothing is queued) until every server script has loaded: ServerEvents.loaded or the first
// tick sets pneCoreScriptsLoaded and mirrors again.
var pneCoreScriptsLoaded = false

function pneCoreHiveRuns() {
  return pneCoreLoaded('hive') && typeof PNE_HIVE_GA === 'object' && PNE_HIVE_GA !== null
}

function pneCoreMirror(cfg) {
  try {
    global.pneOnResonance = cfg.on_resonance === 1 ? 1 : 0
    if (pneCoreScriptsLoaded) global.pneOnHive = (cfg.on_hive === 1 && pneCoreHiveRuns()) ? 1 : 0
    global.pneOnOracle = cfg.on_oracle === 1 ? 1 : 0
    global.pneOnVisual = cfg.on_visual === 1 ? 1 : 0
    global.pneCfgSpawnGate = cfg.spawn_gate === 1 ? 1 : 0
    global.pneCoreApi = PNE_CORE_API
  } catch (e) { }
}

var pneCoreToggleHooks = []

// fn(on, server) runs after /pne <pillar> on|off changes the flag.
function pneCoreOnToggle(pillar, fn) {
  pneCoreToggleHooks.push({ pillar: String(pillar), fn: fn })
}

function pneCoreSetPillar(server, pillar, on) {
  var i
  var h
  if (PNE_CORE_PILLARS.indexOf(pillar) < 0) return false
  if (!pneCoreCfgSet(server, 'on_' + pillar, on ? 1 : 0)) return false
  for (i = 0; i < pneCoreToggleHooks.length; i++) {
    h = pneCoreToggleHooks[i]
    if (h.pillar !== pillar) continue
    try { h.fn(on ? true : false, server) } catch (e) { pneCoreWarn('core', 'toggle.' + pillar, 'toggle hook for ' + pillar + ' failed: ' + e) }
  }
  return true
}

// Which modules have loaded (each module sets its own PNE_<X>_API; checked at call time).
function pneCoreLoaded(pillar) {
  if (pillar === 'resonance') return typeof pneResEmit === 'function'
  if (pillar === 'hive') return typeof pneHiveInfo === 'function'
  if (pillar === 'oracle') return typeof pneOraSnap === 'function'
  if (pillar === 'visual') return typeof pneVisApply === 'function'
  return false
}

// ---------------------------------------------------------------------------------------------
// Token budget

var pneCoreLeftMs = PNE_CORE_BUDGET_MS
var pneCoreSpentMs = 0
var pneCoreSpentPeak = 0     // highest per-tick spend since the last /pne status
var pneCoreDenied = 0        // takes refused since the last /pne status

// Deducts ms and returns true only if the whole cost fits in what is left this tick.
function pneCoreTake(ms) {
  var c = Number(ms)
  if (!(c >= 0)) return false
  if (c > pneCoreLeftMs + 1e-9) {
    pneCoreDenied++
    return false
  }
  pneCoreLeftMs -= c
  pneCoreSpentMs += c
  if (pneCoreSpentMs > pneCoreSpentPeak) pneCoreSpentPeak = pneCoreSpentMs
  return true
}

// Grants up to maxN units of `ms` each; returns how many were granted (and deducted).
function pneCoreTakeN(ms, maxN) {
  var c = Number(ms)
  var n = 0
  var cap = Math.floor(Number(maxN))
  if (!(c > 0) || !(cap > 0)) return 0
  n = Math.floor((pneCoreLeftMs + 1e-9) / c)
  if (n > cap) n = cap
  if (n < cap) pneCoreDenied++
  if (n <= 0) return 0
  pneCoreLeftMs -= n * c
  pneCoreSpentMs += n * c
  if (pneCoreSpentMs > pneCoreSpentPeak) pneCoreSpentPeak = pneCoreSpentMs
  return n
}

function pneCoreLeft() {
  return pneCoreLeftMs
}

// ---------------------------------------------------------------------------------------------
// Players, slots, pid, seed

var pneCorePlayersTick = -1
var pneCorePlayersList = []

function pneCoreAllPlayers(server) {
  var srv = server || pneCoreServer
  var list = null
  var out = []
  var n = 0
  var i
  try { list = srv.getPlayers() } catch (e) { list = null }
  if (!list) {
    try { list = srv.getPlayerList().getPlayers() } catch (e2) { list = null }
  }
  if (!list) return out
  try { n = Number(list.size()) } catch (e3) { n = 0 }
  for (i = 0; i < n; i++) out.push(list.get(i))
  return out
}

// Survival/adventure players, sorted by UUID string (total order). Cached per tick. The index in
// this list is the player's telemetry index everywhere (oracle, director).
function pneCorePlayers(server) {
  var all
  var keyed = []
  var i
  if (pneCorePlayersTick === pneCoreTick && pneCorePlayersList) return pneCorePlayersList
  all = pneCoreAllPlayers(server)
  for (i = 0; i < all.length; i++) {
    if (pneCoreIsSurvival(all[i])) keyed.push({ u: pneCoreUuid(all[i]), p: all[i], i: i })
  }
  keyed.sort(function (a, b) {
    if (a.u < b.u) return -1
    if (a.u > b.u) return 1
    return a.i - b.i
  })
  pneCorePlayersList = []
  for (i = 0; i < keyed.length; i++) pneCorePlayersList.push(keyed[i].p)
  pneCorePlayersTick = pneCoreTick
  return pneCorePlayersList
}

function pneCoreTelSlot(index) {
  var i = Math.floor(Number(index))
  if (!(i >= 0)) i = 0
  return PNE_CORE_TEL_SLOTS[i % PNE_CORE_TEL_SLOTS.length]
}

// Players whose per-player slot is the current tick's slot (empty on slots 0 and 10).
function pneCorePlayersAtSlot(server) {
  var ps = pneCorePlayers(server)
  var out = []
  var i
  if (pneCoreSlot === PNE_CORE_SLOT_WRITE || pneCoreSlot === PNE_CORE_SLOT_READ) return out
  for (i = 0; i < ps.length; i++) {
    if (pneCoreTelSlot(i) === pneCoreSlot) out.push(ps[i])
  }
  return out
}

function pneCoreNewPid() {
  var s = ''
  var i
  try { s = String($PneCoreUUID.randomUUID().toString()).replace(/-/g, '') } catch (e) { s = '' }
  if (/^[0-9a-f]{32}$/.test(s)) return s
  s = ''
  for (i = 0; i < 4; i++) s += ('0000000' + (Math.floor(Math.random() * 4294967296) >>> 0).toString(16)).slice(-8)
  return s
}

// Random 128-bit pseudonym in player.persistentData.pne_pid (created on first use). It survives
// death (KubeJS copies persistent data on respawn) and never contains the UUID or name.
function pneCorePid(player) {
  var pd = pneCorePD(player)
  var s = ''
  if (!pd) return ''
  try { s = String(pd.getString('pne_pid')) } catch (e) { s = '' }
  if (/^[0-9a-f]{32}$/.test(s)) return s
  s = pneCoreNewPid()
  try { pd.putString('pne_pid', s) } catch (e2) { }
  return s
}

function pneCorePidRotate(player) {
  var pd = pneCorePD(player)
  var s = pneCoreNewPid()
  if (!pd) return ''
  try { pd.putString('pne_pid', s) } catch (e) { return '' }
  return s
}

var pneCoreSeedCache = null

// Unsigned 32-bit world seed: (int) of /seed, then >>> 0 (TDD 3.3.1). Cached per server run.
function pneCoreSeed32(server) {
  var srv = server || pneCoreServer
  var n
  if (pneCoreSeedCache !== null) return pneCoreSeedCache
  n = NaN
  try { n = Number(srv.runCommandSilent('seed')) } catch (e) { n = NaN }
  if (!isFinite(n)) return 0
  pneCoreSeedCache = (n | 0) >>> 0
  return pneCoreSeedCache
}

// ---------------------------------------------------------------------------------------------
// Comfort, mercy, grace, natural-spawn multiplier

// Comfort is ON unless the player opted out (tag pne_comfort_off). Fail-safe default.
function pneCoreComfort(player) {
  return !pneCoreHasTag(player, PNE_CORE_TAG_COMFORT_OFF)
}

// Game time as seen from an entity's level (every dimension shares the overworld's game time).
function pneCoreNow(entity) {
  var lvl = null
  var t = NaN
  try { lvl = entity.getLevel() } catch (e) { lvl = null }
  if (lvl) t = pneCoreLevelTime(lvl)
  return isFinite(t) ? t : pneCoreGameTime(null)
}

// Grace counts only while the tag is set AND the persisted deadline is live, so a tag left behind by a
// broken or absent core (tags persist in player NBT) expires on its own. Startup code applies the same rule.
function pneCoreGraceLive(player, now) {
  var pd
  var until = 0
  if (!pneCoreHasTag(player, PNE_CORE_TAG_GRACE)) return false
  pd = pneCorePD(player)
  try { until = Number(pd.getLong('pne_grace_until')) } catch (e) { until = 0 }
  return until > now && until - now <= PNE_CORE_GRACE_TICKS
}

// pne_gate counts only while the director refreshed pne_m within PNE_CORE_GATE_FRESH ticks (pne_m_t).
function pneCoreGateLive(player, now) {
  var pd
  var t = 0
  if (!pneCoreHasTag(player, PNE_CORE_TAG_GATE)) return false
  pd = pneCorePD(player)
  try { t = Number(pd.getLong('pne_m_t')) } catch (e) { t = 0 }
  return t > 0 && now - t >= 0 && now - t <= PNE_CORE_GATE_FRESH
}

function pneCoreVuln(player) {
  return {
    mercy: pneCoreHp(player) <= PNE_CORE_MERCY_HP,
    grace: pneCoreGraceLive(player, pneCoreNow(player))
  }
}

// Natural-spawn multiplier for one player (0..1). The startup gate in
// startup_scripts/pne_res_gate.js implements exactly this formula (docs/IMPLEMENTATION.md 3.4).
function pneCoreNaturalMult(player) {
  var pd
  var m = 1
  var now = pneCoreNow(player)
  if (pneCoreHasTag(player, PNE_CORE_TAG_MERCY) || pneCoreGraceLive(player, now)) return 0
  if (pneCoreHp(player) <= PNE_CORE_MERCY_HP) return 0
  if (!pneCoreGateLive(player, now)) return 1
  pd = pneCorePD(player)
  try { m = Number(pd.getDouble('pne_m')) } catch (e) { m = 1 }
  return pneCoreClamp(m, 0, 1)
}

// Survival players within `radius` (default 48) of x, y, z in the given level, as a JS array.
function pneCorePlayersNear(level, x, y, z, radius) {
  var r = radius > 0 ? radius : PNE_CORE_GATE_RADIUS
  var list = null
  var out = []
  var n = 0
  var i
  var p
  var dx
  var dy
  var dz
  try { list = level.players() } catch (e) { list = null }
  if (!list) {
    try { list = level.getPlayers() } catch (e2) { list = null }
  }
  if (!list) return out
  try { n = Number(list.size()) } catch (e3) { n = 0 }
  for (i = 0; i < n; i++) {
    p = list.get(i)
    if (!pneCoreIsSurvival(p)) continue
    try { dx = Number(p.getX()) - x; dy = Number(p.getY()) - y; dz = Number(p.getZ()) - z } catch (e4) { continue }
    if (dx * dx + dy * dy + dz * dz > r * r) continue
    out.push(p)
  }
  return out
}

// Lowest natural multiplier among survival players within `radius` (default 48) of x, y, z in
// the given level. 1 when nobody is near.
function pneCoreNaturalMultAt(level, x, y, z, radius) {
  var ps = pneCorePlayersNear(level, x, y, z, radius)
  var best = 1
  var i
  var m
  for (i = 0; i < ps.length; i++) {
    m = pneCoreNaturalMult(ps[i])
    if (m < best) best = m
  }
  return best
}

function pneCoreStartGrace(player) {
  var pd = pneCorePD(player)
  pneCoreSetTag(player, PNE_CORE_TAG_GRACE, true)
  pneCoreSetTag(player, PNE_CORE_TAG_MERCY, false)
  try { pd.putLong('pne_grace_until', pneCoreNow(player) + PNE_CORE_GRACE_TICKS) } catch (e) { }
}

// Keeps pne_mercy and pne_grace true to the player's state, and removes the director's pne_gate and
// pne_pace_soft while the director is absent, switched off or cut off. Runs at the housekeeping slot.
function pneCoreUpkeep(server) {
  var all = pneCoreAllPlayers(server)
  var now = pneCoreGameTime(server)
  var noDirector = !pneCoreLoaded('resonance') || !pneCoreOn('resonance') || PNE_CORE_B_API.resonance.off
  var i
  var p
  for (i = 0; i < all.length; i++) {
    p = all[i]
    if (!pneCoreTake(PNE_CORE_COST.upkeep)) return
    pneCoreSetTag(p, PNE_CORE_TAG_MERCY, pneCoreIsSurvival(p) && pneCoreHp(p) <= PNE_CORE_MERCY_HP)
    if (pneCoreHasTag(p, PNE_CORE_TAG_GRACE) && !pneCoreGraceLive(p, now)) pneCoreSetTag(p, PNE_CORE_TAG_GRACE, false)
    if (noDirector) {
      pneCoreSetTag(p, PNE_CORE_TAG_GATE, false)
      pneCoreSetTag(p, PNE_CORE_TAG_PACE_SOFT, false)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Parasite membership: #pne:hive (EPCA) or #pne:spore (Spore), as defined in pne_tags.js.

var pneCoreParaCache = {}
var pneCoreTagKeys = null

// Registry id ('epca:ripper') or ''. In game entity.type is KubeJS's kjs$getType (the id string),
// because KubeJS renames Entity.getType() to getEntityType() (@Shadow @RemapForJS, merged by Mixin).
// The other shapes are handled too, like pneHTypeId in pne_horror.js: getEncodeId(), the Forge
// registry key of an EntityType, and 'entity.<ns>.<path>' (EntityType.toString()).
function pneCoreTypeId(entity) {
  var raw = null
  var s = ''
  var k = null
  var parts
  if (!entity) return ''
  try { raw = entity.type; s = String(raw) } catch (e) { raw = null; s = '' }
  if (s.indexOf(':') > 0) return s
  try { k = entity.getEncodeId(); s = k === null || k === undefined ? '' : String(k) } catch (e2) { s = '' }
  if (s.indexOf(':') > 0) return s
  if ($PneCoreForgeRegistries && raw !== null && raw !== undefined) {
    try { k = $PneCoreForgeRegistries.ENTITY_TYPES.getKey(raw); s = k ? String(k) : '' } catch (e3) { s = '' }
    if (s.indexOf(':') > 0) return s
  }
  try { s = String(raw) } catch (e4) { s = '' }
  if (s.indexOf('entity.') === 0) {
    parts = s.split('.')
    if (parts.length >= 3) return parts[1] + ':' + parts.slice(2).join('.')
  }
  return ''
}

// The entity's EntityType: KubeJS's getEntityType() first, then the Forge registry by id.
function pneCoreEntityType(entity, id) {
  var t = null
  try { t = entity.getEntityType() } catch (e) { t = null }
  if (t) return t
  if (!$PneCoreForgeRegistries || !$PneCoreResourceLocation || !id) return null
  try { t = $PneCoreForgeRegistries.ENTITY_TYPES.getValue(new $PneCoreResourceLocation(id)) } catch (e2) { t = null }
  return t ? t : null
}

// true/false from the #pne:hive / #pne:spore entity-type tags, or null when the lookup is unavailable.
function pneCoreTagCheck(entity, id) {
  var t
  var hit = false
  var i
  if (!$PneCoreTagKey || !$PneCoreRegistries || !$PneCoreResourceLocation) return null
  try {
    if (!pneCoreTagKeys) {
      pneCoreTagKeys = [
        $PneCoreTagKey.create($PneCoreRegistries.ENTITY_TYPE, new $PneCoreResourceLocation('pne', 'hive')),
        $PneCoreTagKey.create($PneCoreRegistries.ENTITY_TYPE, new $PneCoreResourceLocation('pne', 'spore'))
      ]
    }
    t = pneCoreEntityType(entity, id)
    if (!t) return null
    for (i = 0; i < pneCoreTagKeys.length; i++) {
      if (t.is(pneCoreTagKeys[i])) hit = true
    }
    return hit
  } catch (e) {
    return null
  }
}

function pneCoreIsParasite(entity) {
  var id = pneCoreTypeId(entity)
  var r
  if (!id) return false
  if (pneCoreParaCache.hasOwnProperty(id)) return pneCoreParaCache[id]
  r = pneCoreTagCheck(entity, id)
  if (r === null) {
    // Fallback: the id sets in pne_horror.js (loaded later, read at call time).
    if (typeof PNE_H_HIVE === 'undefined' || typeof PNE_H_SPORE === 'undefined') return false
    r = PNE_H_HIVE[id] === true || PNE_H_SPORE[id] === true
  }
  pneCoreParaCache[id] = r ? true : false
  return pneCoreParaCache[id]
}

// 'epca', 'spore' or '' (namespace of a parasite's type id)
function pneCoreStrain(entity) {
  var id
  if (!pneCoreIsParasite(entity)) return ''
  id = pneCoreTypeId(entity)
  return id.substring(0, id.indexOf(':'))
}

// ---------------------------------------------------------------------------------------------
// Doom stage (EPCA 0..10) for HIVE (budget, ctxKey, dawn) and DIRECTOR (bed palette, Undertone).
// Wraps pneHStage(server, level, dim) from pne_horror.js (a binding name DIRECTOR keeps); -99 or
// NaN (EPCA unreadable) maps to 0. Cached per dimension for 600 ticks.

var pneCoreStageCache = {}

function pneCoreDim(level) {
  var d = ''
  try { d = String(level.getDimension()) } catch (e) { d = '' }
  if (d.indexOf(':') > 0) return d
  // Level.dimension() is visible only as getDimensionKey() in game (F37); dimension() stays for mocks
  try { d = String(level.getDimensionKey().location()) } catch (e1) { d = '' }
  if (d.indexOf(':') > 0) return d
  try { d = String(level.dimension().location()) } catch (e2) { d = '' }
  return d.indexOf(':') > 0 ? d : 'minecraft:overworld'
}

function pneCoreStage(level) {
  var dim = pneCoreDim(level)
  var c = pneCoreStageCache[dim]
  var st = 0
  var srv = pneCoreServer
  if (c && pneCoreTick - c.at >= 0 && pneCoreTick - c.at < 600) return c.stage
  if (typeof pneHStage === 'function') {
    try { srv = level.getServer() || pneCoreServer } catch (e) { srv = pneCoreServer }
    try { st = Number(pneHStage(srv, level, dim)) } catch (e2) { st = 0 }
  }
  if (!isFinite(st) || st < 0) st = 0
  st = Math.floor(st > 10 ? 10 : st)
  pneCoreStageCache[dim] = { stage: st, at: pneCoreTick }
  return st
}

// ---------------------------------------------------------------------------------------------
// Hive-caused player deaths: the one source for HIVE (dawn deaths3d, intra-day governor, cheese) and
// DIRECTOR (hourly governor). A death is hive-caused when the killer (DamageSource.getEntity(), which
// is the owner for projectiles) is a parasite, or when a parasite hit the player within
// PNE_CORE_HIT_WINDOW ticks and the cause is not void or /kill. Game time throughout (20 real minutes =
// 24000 ticks at 20 TPS). Per player: persistentData.pne_lph (long, last parasite hit) and pne_hd
// (string, comma-separated game times of the last 16 hive deaths); server: persistentData.pne_core_hd
// (last 64, all players).

var PNE_CORE_HD_KEEP = 16
var PNE_CORE_HD_KEEP_ALL = 64

// 'void', 'kill', 'fall' or 'other' from a DamageSource (msgId outOfWorld / genericKill / fall).
// DamageSource.getMsgId() is visible only as getType() in game (F37); getMsgId() stays for mocks.
function pneCoreDeathCause(source) {
  var id = ''
  try { id = String(source.getType()) } catch (e0) { id = '' }
  if (!id || id === 'undefined' || id === 'null') {
    try { id = String(source.getMsgId()) } catch (e) { id = '' }
  }
  if (id === 'outOfWorld') return 'void'
  if (id === 'genericKill') return 'kill'
  if (id === 'fall') return 'fall'
  return 'other'
}

// DamageSource.getEntity() is visible only as getActual() in game (F37); getEntity() stays for mocks.
function pneCoreSourceEntity(source) {
  var e = null
  try { e = source.getActual() } catch (e1) { e = null }
  if (!e) {
    try { e = source.getEntity() } catch (e2) { e = null }
  }
  return e ? e : null
}

function pneCoreRingAdd(str, t, keep) {
  var xs = String(str || '').length ? String(str).split(',') : []
  xs.push(String(Math.floor(t)))
  while (xs.length > keep) xs.shift()
  return xs.join(',')
}

function pneCoreRingCount(str, now, window) {
  var xs = String(str || '').length ? String(str).split(',') : []
  var n = 0
  var i
  var t
  for (i = 0; i < xs.length; i++) {
    t = Number(xs[i])
    if (isFinite(t) && now - t >= 0 && now - t <= window) n++
  }
  return n
}

// Called from the core's hurt handler: remembers when a parasite last hit this player.
function pneCoreNoteHit(player, source) {
  var src = pneCoreSourceEntity(source)
  var pd
  if (!src || !pneCoreIsParasite(src)) return
  pd = pneCorePD(player)
  try { pd.putLong('pne_lph', pneCoreNow(player)) } catch (e) { }
}

// Called from the core's player-death handler. Returns true when the death was recorded as hive-caused.
function pneCoreNoteDeath(player, source) {
  var now = pneCoreNow(player)
  var cause = pneCoreDeathCause(source)
  var src = pneCoreSourceEntity(source)
  var pd = pneCorePD(player)
  var spd = pneCoreServer ? pneCorePD(pneCoreServer) : null
  var last = 0
  var hive = false
  if (src && pneCoreIsParasite(src)) hive = true
  else if (cause !== 'void' && cause !== 'kill') {
    try { last = Number(pd.getLong('pne_lph')) } catch (e) { last = 0 }
    hive = last > 0 && now - last >= 0 && now - last <= PNE_CORE_HIT_WINDOW
  }
  if (!hive) return false
  try { pd.putString('pne_hd', pneCoreRingAdd(pd.getString('pne_hd'), now, PNE_CORE_HD_KEEP)) } catch (e2) { }
  try { if (spd) spd.putString('pne_core_hd', pneCoreRingAdd(spd.getString('pne_core_hd'), now, PNE_CORE_HD_KEEP_ALL)) } catch (e3) { }
  return true
}

// Hive-caused deaths of this player within the last windowTicks of game time.
function pneCoreHiveDeaths(player, windowTicks) {
  var pd = pneCorePD(player)
  var s = ''
  try { s = String(pd.getString('pne_hd')) } catch (e) { s = '' }
  return pneCoreRingCount(s, pneCoreNow(player), Number(windowTicks))
}

// Hive-caused deaths of all players within the last windowTicks (server ring, last 64).
function pneCoreHiveDeathsAll(windowTicks) {
  var spd = pneCoreServer ? pneCorePD(pneCoreServer) : null
  var s = ''
  try { s = String(spd.getString('pne_core_hd')) } catch (e) { s = '' }
  return pneCoreRingCount(s, pneCoreGameTime(null), Number(windowTicks))
}

// ---------------------------------------------------------------------------------------------
// Safe cross-module wrappers. Callers never test typeof themselves; these do, and they fall back
// to the documented defaults when a module is absent, switched off or broken.

function pneCoreApiCall(pillar, fn, args) {
  var b = PNE_CORE_B_API[pillar]
  if (b.off) return undefined
  try {
    return fn.apply(null, args)
  } catch (e) {
    pneCoreFail(b, e)
    if (b.off && pillar === 'resonance') {
      pneCoreWarn('core', 'ledger.off', 'the director API was cut off after ' + b.limit + ' errors: horror sounds now use the ' +
        'no-director fallback (comfort skips stingers and spaces LF sounds 70 s apart) until /reload', 1)
    }
    return undefined
  }
}

// Pacing for one player: the director's cached Pace while it is fresh (tick at most
// PNE_CORE_PACE_STALE old), else the fallback. Whatever the source, mercy or grace right now forces
// spawn 0, beckon false, ga 0 and aggro <= 0.8, so the safety override never depends on the
// director being alive.
function pneCorePace(player) {
  var r = null
  var v = pneCoreVuln(player)
  var soft = v.mercy || v.grace
  var out
  var k
  if (pneCoreOn('resonance') && typeof pneResPace === 'function') {
    r = pneCoreApiCall('resonance', pneResPace, [player])
    if (r && !(pneCoreTick - Number(r.tick) <= PNE_CORE_PACE_STALE)) r = null
  }
  if (!r) {
    return {
      state: 'CALM', spawn: soft ? 0 : 1, aggro: soft ? 0.8 : 1, beckon: !soft, ga: soft ? 0 : 1,
      tier: 'QUIET', e: 0, theta: 0, mercy: v.mercy, grace: v.grace, tick: pneCoreTick, fallback: true
    }
  }
  if (!soft) return r
  out = {}
  for (k in r) {
    if (r.hasOwnProperty(k)) out[k] = r[k]
  }
  out.spawn = 0
  out.beckon = false
  out.ga = 0
  out.aggro = Number(r.aggro) < 0.8 ? Number(r.aggro) : 0.8
  out.mercy = v.mercy
  out.grace = v.grace
  return out
}

function pneCoreSpawnMult(player) { return pneCorePace(player).spawn }
function pneCoreGaWeight(player) { return pneCorePace(player).ga }

// Positional scripted spawns (beckons, reinforcements, bursts): the lowest pneCoreSpawnMult among
// survival players within radius (default 48); 1 when nobody is near.
function pneCoreSpawnMultAt(level, x, y, z, radius) {
  var ps = pneCorePlayersNear(level, x, y, z, radius)
  var best = 1
  var i
  var m
  for (i = 0; i < ps.length; i++) {
    m = Number(pneCoreSpawnMult(ps[i]))
    if (!(m >= 0)) m = 0
    if (i === 0 || m < best) best = m
  }
  return best
}

// true only when every survival player within radius (default 48) has beckon true (true if none).
function pneCoreBeckonAt(level, x, y, z, radius) {
  var ps = pneCorePlayersNear(level, x, y, z, radius)
  var i
  for (i = 0; i < ps.length; i++) {
    if (pneCorePace(ps[i]).beckon !== true) return false
  }
  return true
}

// How many of `count` scripted spawns to make under multiplier m: floor(count * m + random).
function pneCoreSpawnCount(count, m) {
  var c = Number(count)
  var k = Number(m)
  if (!(c > 0) || !(k > 0)) return 0
  return Math.floor(c * k + Math.random())
}

// Latest telemetry snapshot (oracle extractor). Telemetry runs whatever the oracle flag says.
function pneCoreSnap(player) {
  var r
  if (typeof pneOraSnap !== 'function') return null
  r = pneCoreApiCall('oracle', pneOraSnap, [player])
  return r ? r : null
}

// Latest Oracle verdict, or null when the oracle is off, absent or has no verdict yet.
function pneCoreVerdict(player) {
  var r
  if (!pneCoreOn('oracle') || typeof pneOraVerdict !== 'function') return null
  r = pneCoreApiCall('oracle', pneOraVerdict, [player])
  return r ? r : null
}

function pneCoreHiveInfo(entity) {
  var r
  if (!pneCoreOn('hive') || typeof pneHiveInfo !== 'function') return null
  r = pneCoreApiCall('hive', pneHiveInfo, [entity])
  return r ? r : null
}

function pneCoreHiveNear(player) {
  var r
  if (pneCoreOn('hive') && typeof pneHiveNear === 'function') {
    r = pneCoreApiCall('hive', pneHiveNear, [player])
    if (r) return r
  }
  return { clade: -1, apex: false, silent: 0 }
}

// L8 tell for a silent-gene mob. false means nobody played it: the hive must then drop the
// mob's Silent flag, so silence stays fair.
function pneCoreTell(mob, player) {
  if (!pneCoreOn('resonance') || typeof pneResTell !== 'function') return false
  return pneCoreApiCall('resonance', pneResTell, [mob, player]) === true
}

function pneCoreVisApply(mob, info) {
  if (!pneCoreOn('visual') || typeof pneVisApply !== 'function') return
  pneCoreApiCall('visual', pneVisApply, [mob, info])
}

function pneCoreVisRemove(mob) {
  if (typeof pneVisRemove !== 'function') return
  pneCoreApiCall('visual', pneVisRemove, [mob])
}

// Every horror sound goes through here. With the director loaded, pneResEmit applies the ledger
// (level-jump limits, LF exclusivity and duty, per-layer switches, comfort). Without it (absent, or its
// API breaker tripped), the sound plays as it did before M2, except that comfort mode skips stingers
// and spaces LF sounds (meta.lf, e.g. the Hive Night heartbeat) at least 70 s apart per player.
var pneCoreLfLast = {}

function pneCoreEmit(player, event, category, pos, vol, meta) {
  var m = meta || {}
  var uuid
  var r
  var last
  if (typeof pneResEmit === 'function' && !PNE_CORE_B_API.resonance.off) {
    r = pneCoreApiCall('resonance', pneResEmit, [player, event, category, pos, vol, meta])
    if (r !== undefined) return r === true
  }
  uuid = pneCoreUuid(player)
  if (!uuid) return false
  if (m.stinger && pneCoreComfort(player)) return false
  if (m.lf && pneCoreComfort(player)) {
    last = pneCoreLfLast[uuid]
    if (last !== undefined && pneCoreTick - last >= 0 && pneCoreTick - last < PNE_CORE_LF_COMFORT) return false
    pneCoreLfLast[uuid] = pneCoreTick
  }
  try {
    player.getServer().runCommandSilent('execute as ' + uuid + ' at @s ' + (m.rotated ? 'rotated ~ 0 ' : '') +
      'run playsound ' + event + ' ' + (category || 'hostile') + ' @s ' + (pos || '~ ~ ~') + ' ' +
      pneCoreFmt(vol === undefined ? 1 : vol) + ' ' + pneCoreFmt(m.pitch === undefined ? 1 : m.pitch))
    return true
  } catch (e) {
    return false
  }
}

// Positional sound for every player within radius of x, y, z in dimension dim.
// Returns how many players it was issued for (the fallback returns 1 when the command ran).
// The fallback cannot tell comfort players apart, so it treats everyone as comfort: no stingers, and
// LF sounds at most once per 70 s per event.
function pneCoreEmitAt(server, dim, x, y, z, radius, event, category, vol, meta) {
  var m = meta || {}
  var srv = server || pneCoreServer
  var n = 0
  var key
  var last
  if (typeof pneResEmitAt === 'function' && !PNE_CORE_B_API.resonance.off) {
    n = pneCoreApiCall('resonance', pneResEmitAt, [srv, dim, x, y, z, radius, event, category, vol, meta])
    if (n !== undefined) return n > 0 ? n : 0
  }
  if (m.stinger) return 0
  if (m.lf) {
    key = '@' + String(event)
    last = pneCoreLfLast[key]
    if (last !== undefined && pneCoreTick - last >= 0 && pneCoreTick - last < PNE_CORE_LF_COMFORT) return 0
    pneCoreLfLast[key] = pneCoreTick
  }
  try {
    n = Number(srv.runCommandSilent('execute in ' + dim + ' positioned ' + pneCoreFmt(x) + ' ' + pneCoreFmt(y) + ' ' + pneCoreFmt(z) +
      ' run playsound ' + event + ' ' + (category || 'hostile') + ' @a[distance=..' + Math.floor(radius > 0 ? radius : 16) + '] ~ ~ ~ ' +
      pneCoreFmt(vol === undefined ? 1 : vol) + ' ' + pneCoreFmt(m.pitch === undefined ? 1 : m.pitch)))
  } catch (e) {
    n = 0
  }
  return n > 0 ? n : 0
}

// ---------------------------------------------------------------------------------------------
// Saved silent-gene mobs while the hive cannot play fair. Silent:1b is saved in entity NBT, so a mob
// that rejoins while the hive is off, absent or cut off would stay silent with nobody playing its tell.
// The core's spawned handler queues it (O(1)); the core tick unsilences it by command.

var pneCoreUnsilenceQ = []
var PNE_CORE_UNSILENCE_MAX = 4096

function pneCoreHiveFair() {
  return pneCoreLoaded('hive') && pneCoreOn('hive') && !PNE_CORE_B_API.hive.off
}

function pneCoreOnJoin(entity) {
  var id
  var pd
  var u
  if (pneCoreHiveFair()) return
  id = pneCoreTypeId(entity)
  if (id.indexOf('epca:') !== 0 && id.indexOf('spore:') !== 0) return
  pd = pneCorePD(entity)
  if (!pd) return
  try { if (Number(pd.getByte('pne_sil')) !== 1) return } catch (e) { return }
  u = pneCoreUuid(entity)
  if (!u || pneCoreUnsilenceQ.length >= PNE_CORE_UNSILENCE_MAX) return
  try { pd.remove('pne_sil') } catch (e2) { }
  pneCoreUnsilenceQ.push(u)
}

function pneCoreUnsilenceDrain(server) {
  var k = 0
  while (pneCoreUnsilenceQ.length && k < 8) {
    if (!pneCoreTake(PNE_CORE_COST.emit)) return
    try { server.runCommandSilent('data merge entity ' + pneCoreUnsilenceQ.shift() + ' {Silent:0b}') } catch (e) { }
    k++
  }
}

// ---------------------------------------------------------------------------------------------
// Status lines

var pneCoreStatusProviders = []

// fn(player or null) returns one short line (string) for /pne status.
function pneCoreStatus(name, fn) {
  pneCoreStatusProviders.push({ name: String(name), fn: fn })
}

function pneCoreStatusLines(player) {
  var out = []
  var i
  var s
  var k
  var flags = []
  for (i = 0; i < PNE_CORE_PILLARS.length; i++) {
    k = PNE_CORE_PILLARS[i]
    flags.push(k + '=' + (pneCoreOn(k) ? 'on' : 'off') + (pneCoreLoaded(k) ? '' : '(absent)'))
  }
  out.push('core ' + PNE_CORE_VERSION + ': ' + flags.join(' ') + '; tick budget peak ' +
    pneCoreFmt(pneCoreSpentPeak) + '/' + pneCoreFmt(PNE_CORE_BUDGET_MS) + ' ms, refused ' + pneCoreDenied + '; pd=' + pneCorePdMode)
  pneCoreSpentPeak = 0
  pneCoreDenied = 0
  for (i = 0; i < pneCoreStatusProviders.length; i++) {
    try {
      s = pneCoreStatusProviders[i].fn(player)
      if (s) out.push(pneCoreStatusProviders[i].name + ': ' + String(s))
    } catch (e) {
      out.push(pneCoreStatusProviders[i].name + ': status failed (' + e + ')')
    }
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The /pne command hub
//
// Modules call pneCoreCommand(word, spec) at load time. The hub builds one Brigadier tree in
// ServerEvents.commandRegistry, which fires after every server script has loaded:
//   /pne                      help
//   /pne <word>               spec.run(ctx) with ctx.args = []
//   /pne <word> <args...>     spec.run(ctx) with ctx.args = whitespace-split words (greedy)
// Several specs may share a word; they are tried in registration order until one returns true.
// spec = { run: function (ctx) -> true if handled, help: 'one line', admin: false }
// ctx  = { word, args, argStr, server, player (null for the console), source, admin, reply(text, color) }
// admin = permission level 2, or the single-player owner (so a comfort switch never needs cheats).

var pneCoreCmds = {}
var pneCoreCmdWords = []

function pneCoreCommand(word, spec) {
  var w = String(word)
  if (!/^[a-z][a-z0-9_]{0,23}$/.test(w) || !spec || typeof spec.run !== 'function') {
    console.warn('[pne_core] refused command registration for "' + w + '"')
    return false
  }
  if (!pneCoreCmds.hasOwnProperty(w)) {
    pneCoreCmds[w] = []
    pneCoreCmdWords.push(w)
  }
  pneCoreCmds[w].push({ run: spec.run, help: spec.help ? String(spec.help) : '', admin: spec.admin === true })
  return true
}

function pneCoreTellraw(server, target, text, color) {
  try {
    server.runCommandSilent('tellraw ' + target + ' ' + JSON.stringify({ text: String(text), color: color || 'gray' }))
  } catch (e) { }
}

function pneCoreCmdCtx(c, word, argStr) {
  var src = null
  var server = null
  var player = null
  var admin = false
  var words = []
  var raw = String(argStr || '').replace(/^\s+|\s+$/g, '')
  var ctx
  try { src = c.getSource() } catch (e) { src = null }
  try { server = src.getServer() } catch (e2) { server = pneCoreServer }
  try { player = src.getPlayer() } catch (e3) { player = null }
  if (!player) {
    try {
      player = src.getEntity()
      if (player && !pneCoreIsPlayer(player)) player = null
    } catch (e4) { player = null }
  }
  try { admin = src.hasPermission(2) ? true : false } catch (e5) { admin = false }
  if (!admin && player && server) {
    try { admin = server.isSingleplayerOwner(player.getGameProfile()) ? true : false } catch (e6) { admin = false }
  }
  if (raw.length) words = raw.split(/\s+/)
  ctx = { word: word, args: words, argStr: raw, server: server, player: player, source: src, admin: admin, reply: null }
  ctx.reply = function (text, color) {
    var u = ctx.player ? pneCoreUuid(ctx.player) : ''
    if (u && ctx.server) pneCoreTellraw(ctx.server, u, text, color)
    else console.info('[pne] ' + text)
  }
  return ctx
}

function pneCoreHelp(ctx) {
  var i
  var j
  var w
  var hs
  ctx.reply('The Hive Remembers. Commands:', 'dark_red')
  for (i = 0; i < pneCoreCmdWords.length; i++) {
    w = pneCoreCmdWords[i]
    hs = pneCoreCmds[w]
    for (j = 0; j < hs.length; j++) {
      if (hs[j].help && (!hs[j].admin || ctx.admin)) ctx.reply('/pne ' + w + ' ' + hs[j].help, 'gray')
    }
  }
}

function pneCoreRunCmd(c, word, argStr) {
  var ctx = null
  var hs
  var i
  var denied = false
  if (PNE_CORE_B_CMD.off) return 0
  try {
    ctx = pneCoreCmdCtx(c, word, argStr)
    if (!pneCoreCfgCache && ctx.server) pneCoreCfgLoad(ctx.server)
    if (word === '') {
      pneCoreHelp(ctx)
      return 1
    }
    hs = pneCoreCmds[word] || []
    for (i = 0; i < hs.length; i++) {
      if (hs[i].admin && !ctx.admin) {
        denied = true
        continue
      }
      if (hs[i].run(ctx) === true) return 1
    }
    if (denied) ctx.reply('That needs operator rights (or the single-player owner).', 'red')
    else ctx.reply('Unknown: /pne ' + word + (ctx.argStr ? ' ' + ctx.argStr : '') + '. Type /pne for the list.', 'red')
    return 0
  } catch (err) {
    pneCoreFail(PNE_CORE_B_CMD, err)
    if (ctx) ctx.reply('That command failed; see the server log.', 'red')
    return 0
  }
}

function pneCoreCmdNode(C, A, event, word) {
  return C.literal(word)
    .executes(function (c) { return pneCoreRunCmd(c, word, '') })
    .then(C.argument('args', A.GREEDY_STRING.create(event))
      .executes(function (c) { return pneCoreRunCmd(c, word, String(A.GREEDY_STRING.getResult(c, 'args'))) }))
}

// Built-in subcommands (core owns these words' generic handlers; modules add more specs).
function pneCoreCmdStatus(ctx) {
  var lines
  var i
  if (ctx.args.length) return false
  lines = pneCoreStatusLines(ctx.player)
  for (i = 0; i < lines.length; i++) ctx.reply(lines[i], i === 0 ? 'gold' : 'gray')
  return true
}

function pneCoreCmdConfig(ctx) {
  var k
  var shown = []
  if (ctx.args.length === 0) {
    for (k in PNE_CORE_DEFAULTS) {
      if (PNE_CORE_DEFAULTS.hasOwnProperty(k)) shown.push(k + '=' + pneCoreCfg(k))
    }
    ctx.reply('config: ' + shown.join(' '), 'gold')
    return true
  }
  if (ctx.args.length === 2) {
    if (pneCoreCfgSet(ctx.server, String(ctx.args[0]), ctx.args[1])) ctx.reply('config ' + ctx.args[0] + ' = ' + pneCoreCfg(String(ctx.args[0])), 'gold')
    else ctx.reply('Refused: unknown key or value out of range. /pne config lists keys.', 'red')
    return true
  }
  return false
}

function pneCorePillarCmd(pillar) {
  return function (ctx) {
    var a = ctx.args.length ? String(ctx.args[0]).toLowerCase() : ''
    if (ctx.args.length === 0) {
      ctx.reply(pillar + ' is ' + (pneCoreOn(pillar) ? 'ON' : 'OFF') + (pneCoreLoaded(pillar) ? '' : ' (module not loaded)'), 'gold')
      return true
    }
    if (ctx.args.length !== 1 || (a !== 'on' && a !== 'off')) return false
    if (!ctx.admin) {
      ctx.reply('Switching a whole pillar needs operator rights (or the single-player owner).', 'red')
      return true
    }
    if (pneCoreSetPillar(ctx.server, pillar, a === 'on')) ctx.reply(pillar + ' switched ' + a.toUpperCase() + ' for this world.', 'gold')
    else ctx.reply('Could not switch ' + pillar + '.', 'red')
    return true
  }
}

function pneCoreRegisterBuiltins() {
  var i
  pneCoreCommand('status', { run: pneCoreCmdStatus, help: 'status: pillar switches, tick budget and module state' })
  pneCoreCommand('config', { run: pneCoreCmdConfig, help: 'config [key value]: world settings', admin: true })
  for (i = 0; i < PNE_CORE_PILLARS.length; i++) {
    pneCoreCommand(PNE_CORE_PILLARS[i], { run: pneCorePillarCmd(PNE_CORE_PILLARS[i]), help: PNE_CORE_PILLARS[i] + ' [on|off]: pillar switch for this world' })
  }
}

pneCoreRegisterBuiltins()

// ---------------------------------------------------------------------------------------------
// Events

ServerEvents.commandRegistry(function (event) {
  var C
  var A
  var root
  var i
  try {
    C = event.commands
    A = event.arguments
    root = C.literal('pne').executes(function (c) { return pneCoreRunCmd(c, '', '') })
    for (i = 0; i < pneCoreCmdWords.length; i++) root = root.then(pneCoreCmdNode(C, A, event, pneCoreCmdWords[i]))
    event.register(root)
  } catch (err) {
    console.error('[pne_core] /pne command tree failed to register: ' + err)
  }
})

ServerEvents.loaded(function (event) {
  try {
    pneCoreServer = event.server
    pneCoreScriptsLoaded = true
    pneCoreSeedCache = null
    pneCoreCfgCache = null
    pneCoreCfgLoad(event.server)
  } catch (err) {
    pneCoreFail(PNE_CORE_B_EVENTS, err)
  }
})

ServerEvents.tick(function (event) {
  var t = NaN
  pneCoreLocalTicks++
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneCoreSpentMs = 0
  try { t = Number(event.server.getTickCount()) } catch (e) { t = NaN }
  pneCoreTick = (isFinite(t) && t >= 0) ? t : pneCoreLocalTicks
  pneCoreSlot = pneCoreTick % 20
  if (PNE_CORE_B_TICK.off) return
  try {
    pneCoreServer = event.server
    if (!pneCoreScriptsLoaded) {
      // first tick after a load or /reload: every server script has run, so the hive flag can be mirrored
      pneCoreScriptsLoaded = true
      pneCoreCfgCache = null
    }
    if (!pneCoreCfgCache) pneCoreCfgLoad(event.server)
    if (pneCoreSlot === PNE_CORE_SLOT_HOUSE) pneCoreUpkeep(event.server)
    if (pneCoreUnsilenceQ.length) pneCoreUnsilenceDrain(event.server)
    pneCoreOk(PNE_CORE_B_TICK)
  } catch (err) {
    pneCoreFail(PNE_CORE_B_TICK, err)
  }
})

PlayerEvents.respawned(function (event) {
  if (PNE_CORE_B_EVENTS.off) return
  try {
    pneCoreStartGrace(event.player)
  } catch (err) {
    pneCoreFail(PNE_CORE_B_EVENTS, err)
  }
})

PlayerEvents.loggedIn(function (event) {
  if (PNE_CORE_B_EVENTS.off) return
  try {
    pneCorePdCheck(event.player)
    pneCorePid(event.player)
  } catch (err) {
    pneCoreFail(PNE_CORE_B_EVENTS, err)
  }
})

// Hive-caused death bookkeeping (see pneCoreNoteDeath). Both handlers are O(1) and never cancel.
EntityEvents.hurt('minecraft:player', function (event) {
  if (PNE_CORE_B_EVENTS.off) return
  try {
    pneCoreNoteHit(event.entity, event.source)
  } catch (err) {
    pneCoreFail(PNE_CORE_B_EVENTS, err)
  }
})

EntityEvents.death('minecraft:player', function (event) {
  if (PNE_CORE_B_EVENTS.off) return
  try {
    pneCoreNoteDeath(event.entity, event.source)
  } catch (err) {
    pneCoreFail(PNE_CORE_B_EVENTS, err)
  }
})

// Never cancels (F19): only queues saved silent mobs for unsilencing while the hive is not running.
EntityEvents.spawned(function (event) {
  if (PNE_CORE_B_EVENTS.off) return
  try {
    pneCoreOnJoin(event.entity)
  } catch (err) {
    pneCoreFail(PNE_CORE_B_EVENTS, err)
  }
})

// Config is re-read on load and whenever /reload re-runs this file.
pneCoreCfgLoad(null)
