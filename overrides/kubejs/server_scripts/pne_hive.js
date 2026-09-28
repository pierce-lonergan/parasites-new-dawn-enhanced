// priority: 60
// Parasites New Dawn - Enhanced :: The Hive Remembers, hive runtime (server side)
//
// The live Hive Genome of docs/TDD.md 3.1-3.7 under the binding contract docs/IMPLEMENTATION.md (3.3, with
// 3.4, 4 and 7 where they touch it). The GA itself is PNE_HIVE_GA (pne_hive_core.js, priority 95); this file
// connects it to the world:
//   * joins: EntityEvents.spawned is never cancelled (F19). A parasite with a genome (pne_g) goes to the rejoin
//     queue (<= 12 re-expressions per tick; a newer object of a queued UUID replaces the queued one), any other
//     parasite to the newborn queue (<= 4 per tick, sorted by join time), drained in the tick handler; a newborn only
//     once it joined in an EARLIER tick and no queued leave record can still be its carrier's (vanilla convertTo adds
//     the new mob before it discards the old one), so the carrier's removal is buffered first.
//   * conversion buffer: KILLED and DISCARDED genome mobs (not natural despawns, not pacing discards) are kept
//     by position for linking; a newborn within 2.5 blocks whose join is within 2 ticks of the removal inherits
//     the carrier's genome, mutated once (GA join with a link).
//   * backstop (TDD 2.5.5, contract 3.3): in the newborn drain, before any RNG draw, a fresh (pne_fresh) mob with
//     no genome, no link, no CustomName, not persistence-required is discarded when spawn_backstop is 1 and
//     pneCoreNaturalMultAt(...) is 0 (a player in mercy or grace within 48 blocks, live positions).
//   * expression: fixed-UUID attribute modifiers (permanent max health with check-then-add and a single heal,
//     transient everything else, re-applied idempotently on every rejoin), the Silent flag for the SIL gene with
//     its tells, the PRC axe, the PRJ projectile scaling value, SCT/FLK/LUX tags, then pneCoreVisApply.
//   * telemetry: damage (x k_mercy at impact, from the startup queue), engaged time and located (round-robin
//     samples, <= 20 per tick), kill share, team pressure, fast kill, cheese; fitness through PNE_HIVE_GA.
//   * persistence in server.persistentData.pne_hive (contract 4.1): every 6000 ticks, at dawn and when the hive is
//     switched off as an incremental save (PNE_HIVE_GA.saveBegin/savePart/saveEnd, one piece per free save slot, each
//     charged gaSavePart; a superseded or failed save starts over and never writes); the one-call save only at server
//     stop. Every load declares a new, salted load epoch (PNE_HIVE_GA.epoch), so genome ids never repeat after a /reload
//     or a restart once that epoch is in the stored compound (at the load itself; a fresh or unreadable state saves at
//     once); before that, and after a crash before the next world save (which alone writes the epoch to disk), an
//     earlier run's epoch comes back only by chance (about 1 in 1000). Every string stays under 60,000 bytes
//     (tools/genome/test/NbtSizeTest.java). An unreadable saved state is kept as pne_hive.prev, never overwritten.
//   * dawn: governor, tactic profile (T_est from Oracle style buckets plus the light and audio rule tactics), and
//     the sliced dawn dream; the intra-day governor from the core's hive-death tracking.
//   * light aversion (config light_aversion); the silent pass first in the tick (L8 tells for every survival player
//     within 12 blocks, the 3-block rule, the 30% cap; what does not fit the budget makes the mob audible); SCT steering
//     only with config debug 1; FLK as a tag and as HiveInfo.flk for the director's flank placement.
// Everything costed is charged against the shared token budget: the core's constants, raised to the hive's measured
// costs where those are higher (PNE_HIVE_MEASURED, contract 7).
//
// Rules (docs/IMPLEMENTATION.md Appendix A): ES5 only; every var at the top of its function; values read from
// Java are converted with String()/Number(); Mojang or KubeJS method names only; world changes by command or by
// the attribute and entity calls the contract names; nothing moves the camera or applies a screen effect; every
// handler catches its own errors and counts them.

var PNE_HIVE_API = 1
var PNE_HIVE_SCHEMA = 1
var pneHiveCoreOk = typeof PNE_CORE_API === 'number' && PNE_CORE_API >= 1
var pneHiveReady = pneHiveCoreOk && typeof PNE_HIVE_GA === 'object' && PNE_HIVE_GA !== null && typeof PNE_HIVE_GA.join === 'function'

// Drain and schedule limits (contract 7.2)
var PNE_HIVE_REJOIN_MAX = 12
var PNE_HIVE_NEWBORN_MAX = 4
var PNE_HIVE_SAMPLE_MAX = 20
var PNE_HIVE_REC_MAX = 32          // startup records drained per queue per tick
var PNE_HIVE_REC_BOOST = 128       // leave records drained per tick while a newborn waits on them
var PNE_HIVE_Q_MAX = 4096          // module queues (same cap as the startup queues)
var PNE_HIVE_OUT_MAX = 256         // outcomes waiting for a GA slot
var PNE_HIVE_REDISC_MAX = 64       // entities inspected per tick by the rediscovery pass
var PNE_HIVE_STEER_MAX = 1         // steering calls per tick (SCT breadcrumbs, only with config debug 1: see pneHiveSteer)

// Conversion buffer and removal rules (TDD 3.2)
var PNE_HIVE_CONV_R2 = 6.25        // 2.5 blocks
var PNE_HIVE_CONV_DT = 2           // ticks between the join and the removal
var PNE_HIVE_CONV_KEEP = 40        // how long a buffered removal waits for a newborn, and a newborn for leave records (ticks)
var PNE_HIVE_CONV_MAX = 256
var PNE_HIVE_CONV_SCAN = 256       // newborn candidates compared per removal at most (joined within 2 ticks of it)
var PNE_HIVE_DESPAWN_R = 32
var PNE_HIVE_DESPAWN_IDLE = 600

// Telemetry and fitness inputs (TDD 3.2)
var PNE_HIVE_ENGAGE_R2 = 576       // 24 blocks
var PNE_HIVE_DMG_CAP = 12          // HP per encounter
var PNE_HIVE_KILL_WINDOW = 200     // 10 s before a player's death
var PNE_HIVE_FAST_KILL = 30        // 1.5 s from located to kill
var PNE_HIVE_AFK = 1200            // 60 s without moving
var PNE_HIVE_SAMPLE_DT_MAX = 100   // engaged time credited per sample at most (ticks)

// SIL (TDD 3.1, contract 3.3)
var PNE_HIVE_SIL_MIN = 0.5
var PNE_HIVE_SIL_SHARE = 0.30
var PNE_HIVE_TELL_R2 = 144         // 12 blocks: every survival player this close is told
var PNE_HIVE_TELL_EVERY = 100      // at most one tell per (mob, player) per 100 ticks
var PNE_HIVE_SIL_CLOSE2 = 9        // 3 blocks
var PNE_HIVE_ASH_R2 = 256          // ash tell only when a player is within 16 blocks
var PNE_HIVE_ASH_EVERY = 20        // the ash-particle tell every 20 ticks
var PNE_HIVE_SIL_EVERY = 20        // each silent mob is visited every 20 ticks ...
var PNE_HIVE_SIL_NEAR2 = 64        // ... and every 4 ticks while a player is within 8 blocks (the 3-block rule stays timely)
var PNE_HIVE_SIL_FAST = 4

// Schedules (contract 7.2)
var PNE_HIVE_SAVE_EVERY = 6000
var PNE_HIVE_SAVE_AT = 6
var PNE_HIVE_BASE_CHUNK = 16       // base IntArrays written per save step (one pneHiveCost('save') each, measured ~0.095 ms)
var PNE_HIVE_LIGHT_EVERY = 100
var PNE_HIVE_LIGHT_AT = 42
var PNE_HIVE_PRUNE_SLOT = 12       // kill-ledger pruning

// Light aversion (TDD 3.2)
var PNE_HIVE_LIGHT_MIN = 11
var PNE_HIVE_WK_BASE = 6

// Governor and dawn (contract 3.7, TDD 3.6)
var PNE_HIVE_PIDS_WINDOW = 72000   // players seen survival-online during the last 72000 ticks
var PNE_HIVE_DEATHS_3D = 72000
var PNE_HIVE_GOV_WINDOW = 24000    // 2 hive deaths of one player within 20 real minutes
var PNE_HIVE_GRACE_WINDOW = 6000   // budget x 0.7 near a player with a hive death this recent
var PNE_HIVE_SP_RING = 400         // outcome species ring (the dawn dream's species context)

var PNE_HIVE_PS_FRESH = 40         // player states older than this (ticks) are not trusted
var PNE_HIVE_NEAR_OLD = 40         // pneHiveNear answers from the per-player table while it is at most this old (ticks)
var PNE_HIVE_NEAR_R2 = 576
var PNE_HIVE_SILENT_R2 = 144
var PNE_HIVE_HEX_RX = /^[0-9a-f]{56}$/
var PNE_HIVE_LIGHT_RX = /torch|lantern|glowstone|shroomlight|froglight|campfire|end_rod|glow_lichen|beacon/
var PNE_HIVE_STYLES = ['hide', 'kite', 'turtle']
var PNE_HIVE_NON_OUTCOME = { UNLOADED_TO_CHUNK: true, UNLOADED_WITH_PLAYER: true, CHANGED_DIMENSION: true }

// Attribute phenotype (TDD 3.1): [gene, attribute path, operation, amount at e = 1, permanent].
// Speed caps at +12.5%, armour at +4, follow range at +24 with an absolute cap of 48 blocks.
var PNE_HIVE_ATTRS = [
  [0, 'generic.movement_speed', 'MULTIPLY_BASE', 0.125, false],
  [0, 'generic.flying_speed', 'MULTIPLY_BASE', 0.125, false],
  [1, 'generic.follow_range', 'ADDITION', 24, false],
  [6, 'generic.knockback_resistance', 'ADDITION', 0.5, false],
  [8, 'generic.armor', 'ADDITION', 4, false],
  [9, 'generic.attack_knockback', 'ADDITION', 0.5, false],
  [10, 'generic.max_health', 'MULTIPLY_BASE', 0.5, true],
  [11, 'generic.attack_damage', 'MULTIPLY_BASE', 0.4, false]
]
// Per-item costs measured by hive-rhino-bench (tools/hive/HiveBench.java: the instance's Rhino interpreter, JDK 17, Java
// stand-in mobs, real CompoundTag and AttributeModifier), about 1.3x the p50. An item is charged the higher of this and the
// core's constant, so the shared budget stays true to the work until the lead updates PNE_CORE_COST (docs/modules/hive.md).
// Keys the core has no constant for are charged these values:
//   outcome     one GA outcome insert (PNE_HIVE_GA.outcome; no core constant: charging breed starved them)
//   leaveOut    one KILLED/DISCARDED leave record (outcome record, despawn check, buffer), plus convRec for each newborn
//               the conversion search walks (joins within 2 ticks of a DISCARDED record, at most PNE_HIVE_CONV_SCAN)
//   silentVisit one silent-mob visit incl. its ash-particle command (0.03 ms measured + PNE_CORE_COST.emit)
//   nearBase / nearRec   the per-player pneHiveNear table: a fixed part plus each tracked mob in the 3x3 grid cells
//   steer       one Mob#getNavigation().moveTo (a synchronous path search: unmeasured offline, so a large placeholder)
var PNE_HIVE_MEASURED = { rejoin: 0.12, newborn: 0.32, upkeep: 0.03, save: 0.12, outcome: 0.33, leaveOut: 0.03, convRec: 0.0007,
  silentVisit: 0.06, nearBase: 0.015, nearRec: 0.0007, steer: 1.0 }
// Fixed modifier UUID per gene (contract 4.4); NN = gene index as two hex digits.
var PNE_HIVE_UUID_PREFIX = '706e6500-4869-7665-0000-0000000000'

// ---------------------------------------------------------------------------------------------
// Java classes (all optional; every use is guarded)

var $PneHiveUUID = null
var $PneHiveArrayList = null
var $PneHiveIntStream = null
var $PneHiveAttrMod = null
var $PneHiveAttrOp = null
var $PneHiveForgeReg = null
var $PneHiveResLoc = null
try { $PneHiveUUID = Java.loadClass('java.util.UUID') } catch (e) { $PneHiveUUID = null }
try { $PneHiveArrayList = Java.loadClass('java.util.ArrayList') } catch (e) { $PneHiveArrayList = null }
try { $PneHiveIntStream = Java.loadClass('java.util.stream.IntStream') } catch (e) { $PneHiveIntStream = null }
try { $PneHiveAttrMod = Java.loadClass('net.minecraft.world.entity.ai.attributes.AttributeModifier') } catch (e) { $PneHiveAttrMod = null }
try { $PneHiveAttrOp = Java.loadClass('net.minecraft.world.entity.ai.attributes.AttributeModifier$Operation') } catch (e) { $PneHiveAttrOp = null }
try { $PneHiveForgeReg = Java.loadClass('net.minecraftforge.registries.ForgeRegistries') } catch (e) { $PneHiveForgeReg = null }
try { $PneHiveResLoc = Java.loadClass('net.minecraft.resources.ResourceLocation') } catch (e) { $PneHiveResLoc = null }

// ---------------------------------------------------------------------------------------------
// Breakers (one per job, so a failing job never takes the others down)

var PNE_HIVE_B_LOAD = pneHiveCoreOk ? pneCoreBreaker('hive.load', 5, 'consecutive') : null
var PNE_HIVE_B_DRAIN = pneHiveCoreOk ? pneCoreBreaker('hive.drain', 5, 'consecutive') : null
var PNE_HIVE_B_SAMPLE = pneHiveCoreOk ? pneCoreBreaker('hive.sample', 5, 'consecutive') : null
var PNE_HIVE_B_SIL = pneHiveCoreOk ? pneCoreBreaker('hive.silent', 5, 'consecutive') : null
var PNE_HIVE_B_PLAYER = pneHiveCoreOk ? pneCoreBreaker('hive.player', 5, 'consecutive') : null
var PNE_HIVE_B_LIGHT = pneHiveCoreOk ? pneCoreBreaker('hive.light', 5, 'consecutive') : null
var PNE_HIVE_B_GA = pneHiveCoreOk ? pneCoreBreaker('hive.ga', 5, 'consecutive') : null
var PNE_HIVE_B_SAVE = pneHiveCoreOk ? pneCoreBreaker('hive.save', 5, 'consecutive') : null
var PNE_HIVE_B_HOUSE = pneHiveCoreOk ? pneCoreBreaker('hive.house', 5, 'consecutive') : null
var PNE_HIVE_B_EVENTS = pneHiveCoreOk ? pneCoreBreaker('hive.events', 20, 'total') : null

// ---------------------------------------------------------------------------------------------
// State (module-level: /reload starts it fresh; the GA state reloads from persistent data and a rediscovery
// pass re-adopts the genome mobs already in the world)

var pneHiveSt = null              // PNE_HIVE_GA state
var pneHiveSeed = 0
var pneHiveLoadTried = false
var pneHiveWid = ''
var pneHiveMobs = {}              // uuid -> tracked genome mob record
var pneHiveMobN = 0
var pneHiveList = []              // records in round-robin sampling order (dead ones removed lazily)
var pneHiveCursor = 0
var pneHiveSil = []               // records whose mob is silent right now
var pneHiveRejoinQ = []           // { mob, u }
var pneHiveRejoinSet = {}         // uuid -> its queue entry while queued (a newer object of the same uuid replaces entry.mob)
var pneHiveNewQ = []              // { mob, u, n: handler tick number at the join, t: game time (non-decreasing), p: [x,y,z], dim }
var pneHiveAxeQ = []              // records waiting for their PRC axe
var pneHiveConv = []              // buffered removals { x, y, z, dim, t, g, id, used }
var pneHiveOutQ = []              // { rec: outcome record for the GA, sp: species }
var pneHiveTickNo = 0             // hive tick handler runs (newborn eligibility)
var pneHiveTDay = [0, 0, 0, 0, 0] // today's tactic evidence, PNE_HIVE_GA.TACTICS order
var pneHiveDay = -1               // day index of the last dawn handled
var pneHiveDawnDue = false
var pneHiveBreedDue = false
var pneHiveDreamDue = false
var pneHiveSaveDue = false        // a save is due (6000-tick cadence, dawn, switch-off, /pne hive prev drop, a load that found no
                                  // readable state)
var pneHiveSaving = null          // save in progress: { ph: 'ga', st, ctx, hv, spd, n } while PNE_HIVE_GA.savePart pieces run,
                                  // then { ph: 'nbt', st, spd, sv, tag, bt, i, hv } while the result is written (pneHiveSaveWriter)
var PNE_HIVE_EP_MAX = 2147483647  // the largest epoch PNE_HIVE_GA.load accepts
var pneHiveEpoch = 0              // load epoch (persisted in hv, salted, declared to the GA after every load): genome ids do not
                                  // repeat when a /reload or a restart rolls the GA state back to its last save; see pneHiveLoad
                                  // for the windows where only the salt keeps them apart (about 1 in 1000)
var pneHiveEpochDue = false       // a load happened: PNE_HIVE_GA.epoch runs on the next hive tick, before any drain or GA work
var pneHivePrev = null            // a saved pne_hive the GA core could not load, kept as pne_hive.prev (never overwritten)
var pneHiveLightDue = false
var pneHiveLightAt = 0            // player cursor of an interrupted light pass
var pneHivePids = {}              // pid -> last game time seen survival-online
var pneHiveDeathSeen = {}         // pid -> game time of the newest hive death already handled
var pneHivePlayerSt = {}          // player uuid -> { x, y, z, yaw, moveT, hist, light, dim }
var pneHiveLedger = {}            // player uuid -> [{ t, u, k }] k-weighted damage of the last 200 ticks
var pneHiveTeamDmg = {}           // player uuid -> running k-weighted hive damage
var pneHiveEngagedOn = {}         // player uuid -> genome mobs engaged on that player (last samples)
var pneHiveEngagedN = 0
var pneHiveFatal = {}             // player uuid -> { t, cause } of the last fatal blow
var pneHiveTorch = {}             // player uuid -> light sources placed since that player's last step
var pneHiveApex = null
var pneHiveApexAt = -1
var pneHiveNearCache = {}
var pneHiveGrid = {}              // 32-block cells (dim|cx|cz) -> tracked records (pneHiveNear without a table scan)
var pneHiveRedisc = null
var pneHiveSpRing = []
var pneHiveSpHead = 0
var pneHiveBaseWk = {}            // species -> base attack_damage >= 6
var pneHiveAttrCache = {}
var pneHiveUuidObj = {}
var pneHiveNav = -1               // Mob#getNavigation from Rhino: -1 untested, 0 unavailable, 1 works (F33)
var pneHiveSteerN = 0
var pneHiveSteerOn = false        // SCT steering this tick (config debug 1 only, until spark measures moveTo)
var pneHivePosTick = -1           // pneHivePlayersPos cache (one read of the survival players per tick)
var pneHivePosList = null
var pneHiveSilBroken = false
var pneHiveWasOff = false
var pneHiveStats = { joins: 0, rejoins: 0, links: 0, backstop: 0, outcomes: 0, outDropped: 0, qDropped: 0, gov: 0,
  tells: 0, tellFail: 0, unsilenced: 0, light: 0, steer: 0, dawns: 0, saves: 0, saveParts: 0, saveRestarts: 0, dream: 0, breeds: 0 }

// ---------------------------------------------------------------------------------------------
// Small helpers

// The charge for one item: the core's constant, raised to the hive's measured value (keys without a core constant are
// charged the measured value alone).
function pneHiveCost(key) {
  var c = PNE_CORE_COST[key]
  var m = PNE_HIVE_MEASURED[key]
  if (typeof c !== 'number' || !isFinite(c)) c = 0
  return (typeof m === 'number' && m > c) ? m : c
}

function pneHiveNum(x, d) {
  var v = Number(x)
  return isFinite(v) ? v : d
}

function pneHivePdStr(pd, k) {
  try { return pd.contains(k) ? String(pd.getString(k)) : '' } catch (e) { return '' }
}

function pneHivePdByte(pd, k) {
  try { return pd.contains(k) ? Number(pd.getByte(k)) : 0 } catch (e) { return 0 }
}

function pneHivePdLong(pd, k) {
  try { return pd.contains(k) ? Number(pd.getLong(k)) : 0 } catch (e) { return 0 }
}

function pneHiveCmd(srv, cmd) {
  var n = 0
  try { n = Number(srv.runCommandSilent(cmd)) } catch (e) { n = 0 }
  return isFinite(n) ? n : 0
}

function pneHiveRemoved(ent) {
  try { return ent.isRemoved() ? true : false } catch (e) { return false }
}

function pneHiveAlive(ent) {
  if (pneHiveRemoved(ent)) return false
  try { return ent.isAlive() ? true : false } catch (e) { return true }
}

function pneHivePos(ent) {
  var x
  var y
  var z
  try { x = Number(ent.getX()); y = Number(ent.getY()); z = Number(ent.getZ()) } catch (e) { return null }
  if (!isFinite(x) || !isFinite(y) || !isFinite(z)) return null
  return [x, y, z]
}

function pneHiveLevel(ent) {
  try { return ent.getLevel() } catch (e) { }
  try { return ent.level() } catch (e2) { }
  return null
}

function pneHiveD2(ax, ay, az, bx, by, bz) {
  var dx = ax - bx
  var dy = ay - by
  var dz = az - bz
  return dx * dx + dy * dy + dz * dz
}

function pneHiveIsParaId(id) {
  return id.indexOf('epca:') === 0 || id.indexOf('spore:') === 0
}

function pneHiveDayTime(level) {
  var t = NaN
  try { t = Number(level.getDayTime()) } catch (e) { t = NaN }
  return isFinite(t) ? t : 0
}

function pneHiveOverworld(srv) {
  try { return srv.getOverworld() } catch (e) { }
  return null
}

// Keys of a CompoundTag as a sorted JS array of strings.
function pneHiveKeys(tag) {
  var out = []
  var it
  try {
    it = tag.getAllKeys().iterator()
    while (it.hasNext()) out.push(String(it.next()))
  } catch (e) { }
  out.sort()
  return out
}

// A Java int[] (for CompoundTag.putIntArray) with these values; the JS array itself when IntStream is missing.
function pneHiveIntArr(vals) {
  var a = null
  var i
  if ($PneHiveIntStream) {
    try { a = $PneHiveIntStream.range(0, vals.length).toArray() } catch (e) { a = null }
  }
  if (!a) return vals
  for (i = 0; i < vals.length; i++) a[i] = vals[i]
  return a
}

function pneHiveJsInts(a) {
  var out = []
  var n = 0
  var i
  if (!a) return out
  try { n = Number(a.length) } catch (e) { n = 0 }
  if (!(n > 0)) return out
  for (i = 0; i < n; i++) out.push(Math.floor(Number(a[i])))
  return out
}

// ---------------------------------------------------------------------------------------------
// Queues shared with pne_hive_events.js (java.util.ArrayList<String>, contract 3.3)

function pneHiveQDamage() {
  var q = global.pneHiveQDamage
  if (q === undefined || q === null) {
    if (!$PneHiveArrayList) return null
    q = new $PneHiveArrayList()
    global.pneHiveQDamage = q
  }
  return q
}

function pneHiveQLeave() {
  var q = global.pneHiveQLeave
  if (q === undefined || q === null) {
    if (!$PneHiveArrayList) return null
    q = new $PneHiveArrayList()
    global.pneHiveQLeave = q
  }
  return q
}

// Removes and returns up to max records (JS strings) from the front of a startup queue.
function pneHiveTake(q, max) {
  var n = 0
  var k
  var out = []
  var i
  if (!q || !(max > 0)) return out
  try { n = Number(q.size()) } catch (e) { n = 0 }
  if (!(n > 0)) return out
  k = n < max ? n : max
  for (i = 0; i < k; i++) out.push(String(q.get(i)))
  if (k === n) {
    q.clear()
  } else {
    try {
      q.subList(0, k).clear()
    } catch (e2) {
      for (i = 0; i < k; i++) q.remove(0)
    }
  }
  return out
}

function pneHiveQueueSize(q) {
  var n = 0
  if (!q) return 0
  try { n = Number(q.size()) } catch (e) { n = 0 }
  return n > 0 ? n : 0
}

// ---------------------------------------------------------------------------------------------
// Tracked genome mobs

function pneHiveNewRec(mob, u) {
  return {
    u: u, mob: mob, g: '', id: '', parents: '', ctx: '', t0: 0, e: null, clade: 0, stage: 0, type: '', strain: '',
    sil: false, silGene: false, silOff: false, attacked: false, hit: false, apex: false, axe: false,
    tel: { dmg: 0, eng: 0, loc: false, locT: 0, kill: 0, team: 0, fast: false, chz: 0, engN: 0 },
    targetU: '', teamMark: 0, lastS: 0, lastEng: -1000000, lastTgtU: '', x: 0, y: 0, z: 0, dim: '', cause: '',
    phase: pneHivePhase(u), tells: {}, ashT: -1000000, visitN: 0, steerT: -1000000, gone: -1, dead: false, inSil: false,
    cell: ''
  }
}

// Puts a silent record on the silent pass (first visit spread over the next 20 ticks by the UUID's phase).
function pneHiveSilAdd(rec) {
  if (rec.inSil) return
  rec.inSil = true
  rec.visitN = pneHiveTickNo + 1 + rec.phase
  pneHiveSil.push(rec)
}

// Silent-pass phase 0..19 from the UUID's last hex digits (spreads the silent mobs over the 20 slots).
function pneHivePhase(u) {
  var v = parseInt(String(u).substring(32), 16)
  return isFinite(v) ? v % 20 : 0
}

function pneHiveSetTarget(rec, pu) {
  var old = rec.targetU
  if (old === pu) return
  if (old) {
    pneHiveEngagedOn[old] = (pneHiveEngagedOn[old] || 1) - 1
    if (pneHiveEngagedOn[old] <= 0) delete pneHiveEngagedOn[old]
    pneHiveEngagedN--
  }
  rec.targetU = pu
  if (pu) {
    pneHiveEngagedOn[pu] = (pneHiveEngagedOn[pu] || 0) + 1
    pneHiveEngagedN++
    rec.teamMark = pneHiveTeamDmg[pu] || 0
  }
}

function pneHiveCellKey(dim, x, z) {
  return dim + '|' + Math.floor(x / 32) + '|' + Math.floor(z / 32)
}

function pneHiveGridDel(rec) {
  var a
  var i
  if (!rec.cell) return
  a = pneHiveGrid[rec.cell]
  if (a) {
    i = a.indexOf(rec)
    if (i >= 0) {
      a[i] = a[a.length - 1]
      a.pop()
    }
    if (!a.length) delete pneHiveGrid[rec.cell]
  }
  rec.cell = ''
}

function pneHiveGridSet(rec) {
  var key = pneHiveCellKey(rec.dim, rec.x, rec.z)
  if (key === rec.cell) return
  pneHiveGridDel(rec)
  if (!pneHiveGrid[key]) pneHiveGrid[key] = []
  pneHiveGrid[key].push(rec)
  rec.cell = key
}

function pneHiveTrack(rec) {
  var old = pneHiveMobs[rec.u]
  if (old === rec) return
  if (old) pneHiveUntrack(old)
  pneHiveMobs[rec.u] = rec
  pneHiveMobN++
  rec.dead = false
  pneHiveList.push(rec)
  pneHiveGridSet(rec)
  if (rec.sil) pneHiveSilAdd(rec)
}

function pneHiveUntrack(rec) {
  if (pneHiveMobs[rec.u] !== rec) {
    rec.dead = true
    return
  }
  delete pneHiveMobs[rec.u]
  pneHiveMobN--
  rec.dead = true
  pneHiveSetTarget(rec, '')
  pneHiveGridDel(rec)
}

function pneHiveClearRuntime() {
  var k
  for (k in pneHiveMobs) {
    if (pneHiveMobs.hasOwnProperty(k)) pneHiveMobs[k].dead = true
  }
  pneHiveMobs = {}
  pneHiveMobN = 0
  pneHiveList = []
  pneHiveCursor = 0
  pneHiveSil = []
  pneHiveRejoinQ = []
  pneHiveRejoinSet = {}
  pneHiveNewQ = []
  pneHiveAxeQ = []
  pneHiveConv = []
  pneHiveOutQ = []
  pneHiveEngagedOn = {}
  pneHiveEngagedN = 0
  pneHiveNearCache = {}
  pneHiveGrid = {}
  pneHiveRedisc = null
}

// ---------------------------------------------------------------------------------------------
// Telemetry accumulator on the mob (pne_tel), so an unloaded mob keeps its evidence

function pneHiveTelStr(rec) {
  var t = rec.tel
  return [Math.round(t.dmg * 1000), Math.round(t.eng * 1000), t.loc ? 1 : 0, Math.floor(t.locT), Math.round(t.kill * 1000000),
    Math.round(t.team * 1000), t.chz, t.engN, rec.attacked ? 1 : 0, rec.hit ? 1 : 0, t.fast ? 1 : 0].join(',')
}

function pneHiveTelLoad(rec, s) {
  var p = String(s).split(',')
  var n = []
  var i
  if (p.length < 11) return
  for (i = 0; i < 11; i++) {
    n.push(Number(p[i]))
    if (!isFinite(n[i])) return
  }
  rec.tel.dmg = n[0] / 1000
  rec.tel.eng = n[1] / 1000
  rec.tel.loc = n[2] === 1
  rec.tel.locT = n[3]
  rec.tel.kill = n[4] / 1000000
  rec.tel.team = n[5] / 1000
  rec.tel.chz = n[6]
  rec.tel.engN = n[7]
  rec.attacked = n[8] === 1
  rec.hit = n[9] === 1
  rec.tel.fast = n[10] === 1
}

function pneHiveTelSave(rec) {
  var pd = pneCorePD(rec.mob)
  if (!pd) return
  try { pd.putString('pne_tel', pneHiveTelStr(rec)) } catch (e) { }
}

// ---------------------------------------------------------------------------------------------
// Silent gene (TDD 3.1, contract 3.3)

// A tell can be played only while the director is loaded, on and not cut off; otherwise nobody is silenced.
function pneHiveTellable() {
  return !pneHiveSilBroken && !PNE_HIVE_B_SIL.off && pneCoreOn('resonance') && typeof pneResTell === 'function' &&
    !PNE_CORE_B_API.resonance.off
}

function pneHiveSetSilent(srv, mob, u, on) {
  try {
    mob.setSilent(on ? true : false)
    return true
  } catch (e) { }
  if (!srv || !u) return false
  return pneHiveCmd(srv, 'data merge entity ' + u + ' {Silent:' + (on ? 1 : 0) + 'b}') > 0
}

function pneHiveSilence(srv, rec, pd) {
  if (!pneHiveSetSilent(srv, rec.mob, rec.u, true)) return
  try { pd.putByte('pne_sil', 1) } catch (e) { }
  rec.sil = true
  if (!rec.dead && pneHiveMobs[rec.u] === rec) pneHiveSilAdd(rec)
}

// Drops Silent for good (first attack, within 3 blocks, a tell nobody heard, the 30% cap, or the hive stopping).
function pneHiveUnsilence(srv, rec) {
  var pd = pneCorePD(rec.mob)
  pneHiveSetSilent(srv, rec.mob, rec.u, false)
  try { if (pd) pd.remove('pne_sil') } catch (e) { }
  if (rec.sil) pneHiveStats.unsilenced++
  rec.sil = false
  rec.silOff = true
}

function pneHiveUnsilenceAll(srv) {
  var i
  var rec
  for (i = 0; i < pneHiveSil.length; i++) {
    rec = pneHiveSil[i]
    rec.inSil = false
    if (rec.sil) {
      try { pneHiveUnsilence(srv, rec) } catch (e) { }
    }
  }
  pneHiveSil = []
}

// ---------------------------------------------------------------------------------------------
// Attributes (contract F24): ForgeRegistries attribute, fixed UUID per gene, Mojang method names only

function pneHiveAttr(path) {
  var a
  if (pneHiveAttrCache.hasOwnProperty(path)) return pneHiveAttrCache[path]
  a = null
  if ($PneHiveForgeReg && $PneHiveResLoc) {
    try { a = $PneHiveForgeReg.ATTRIBUTES.getValue(new $PneHiveResLoc('minecraft', path)) } catch (e) { a = null }
  }
  pneHiveAttrCache[path] = a ? a : null
  return pneHiveAttrCache[path]
}

function pneHiveModUuid(gene) {
  var s
  if (pneHiveUuidObj.hasOwnProperty(gene)) return pneHiveUuidObj[gene]
  s = PNE_HIVE_UUID_PREFIX + (gene < 16 ? '0' : '') + gene.toString(16)
  pneHiveUuidObj[gene] = $PneHiveUUID ? $PneHiveUUID.fromString(s) : null
  return pneHiveUuidObj[gene]
}

function pneHiveApplyAttrs(mob, rec, pd) {
  var i
  var row
  var attr
  var inst
  var uuid
  var amt
  var base
  var op
  var name
  if (!$PneHiveAttrMod || !$PneHiveAttrOp || !$PneHiveUUID) return
  for (i = 0; i < PNE_HIVE_ATTRS.length; i++) {
    row = PNE_HIVE_ATTRS[i]
    attr = pneHiveAttr(row[1])
    if (!attr) continue
    inst = null
    try { inst = mob.getAttribute(attr) } catch (e) { inst = null }
    if (!inst) continue
    uuid = pneHiveModUuid(row[0])
    amt = row[3] * rec.e[row[0]]
    if (row[0] === 1) {
      base = pneHiveNum(inst.getBaseValue(), 0)
      if (base + amt > 48) amt = 48 - base
      if (amt < 0) amt = 0
    }
    op = $PneHiveAttrOp[row[2]]
    name = 'pne.gene.' + PNE_HIVE_GA.GENE_IDS[row[0]]
    if (row[4]) {
      // max health: permanent, so it is saved and loaded before Health (no clipping on chunk reload); a
      // duplicate UUID throws, so check first; never removed (that would clip health); healed once.
      if (amt > 0 && !inst.getModifier(uuid)) {
        inst.addPermanentModifier(new $PneHiveAttrMod(uuid, name, amt, op))
        if (pneHivePdByte(pd, 'pne_healed') !== 1) {
          try { mob.setHealth(Number(mob.getMaxHealth())) } catch (e2) { }
          try { pd.putByte('pne_healed', 1) } catch (e3) { }
        }
      }
    } else {
      // transient: not saved; removed and re-added, so a rejoin re-expresses idempotently
      inst.removeModifier(uuid)
      if (amt > 0) inst.addTransientModifier(new $PneHiveAttrMod(uuid, name, amt, op))
    }
  }
}

// Base attack damage >= 6 (Weakness in the light-aversion rule), cached per species.
function pneHiveWeakens(mob, type) {
  var attr
  var inst
  var base = 0
  if (pneHiveBaseWk.hasOwnProperty(type)) return pneHiveBaseWk[type]
  attr = pneHiveAttr('generic.attack_damage')
  inst = null
  if (attr) {
    try { inst = mob.getAttribute(attr) } catch (e) { inst = null }
  }
  if (inst) base = pneHiveNum(inst.getBaseValue(), 0)
  pneHiveBaseWk[type] = base >= PNE_HIVE_WK_BASE
  return pneHiveBaseWk[type]
}

function pneHiveTier(e) {
  var t = Math.floor(4 * e)
  return t > 3 ? 3 : (t < 0 ? 0 : t)
}

// SCT tier tag (tag-only expression until navigation is confirmed, F33), FLK, LUX tier (light aversion
// selector; tier 3 is immune and carries no tag) and pne_wk (Weakness applies).
function pneHiveApplyTags(mob, rec, fresh) {
  var sct = pneHiveTier(rec.e[2])
  var lux = pneHiveTier(rec.e[3])
  var want = {}
  var names = ['pne_sct1', 'pne_sct2', 'pne_sct3', 'pne_flk', 'pne_lux0', 'pne_lux1', 'pne_lux2', 'pne_wk']
  var ts = null
  var i
  var has
  if (sct >= 1) want['pne_sct' + sct] = true
  if (rec.e[4] >= 0.5) want.pne_flk = true
  if (lux <= 2) want['pne_lux' + lux] = true
  if (pneHiveWeakens(mob, rec.type)) want.pne_wk = true
  try { ts = mob.getTags() } catch (e) { ts = null }
  for (i = 0; i < names.length; i++) {
    if (fresh && !want[names[i]]) continue
    has = false
    try { has = ts ? (ts.contains(names[i]) ? true : false) : false } catch (e2) { has = false }
    try {
      if (want[names[i]] && !has) mob.addTag(names[i])
      else if (!want[names[i]] && has) mob.removeTag(names[i])
    } catch (e3) { }
  }
}

// Graft occupancy index for VISUAL (TDD 3.5.1: floor(x * (k + 1)), 0 = empty, k = 4 variants), driven by the
// PRJ gene: the display graft is the readable cue of the projectile armour (TDD 3.5.2).
function pneHiveGraft(e) {
  var g = Math.floor(5 * e[7])
  return g > 4 ? 4 : (g < 0 ? 0 : g)
}

// A survival player with a hive-caused death in the last 6000 ticks within 48 blocks (budget x 0.7, TDD 3.6). Positions
// are live (pneCorePlayersNear), never the hive's 1 Hz player states, which lag a respawn, a pearl or a portal by up to a
// second; only the death flag comes from the per-player step (pneCoreHiveDeaths is read there).
function pneHiveGraceNear(level, pos) {
  var ps
  var st
  var i
  if (!level || !pos) return false
  ps = pneCorePlayersNear(level, pos[0], pos[1], pos[2], 48)
  for (i = 0; i < ps.length; i++) {
    st = pneHivePlayerSt[pneCoreUuid(ps[i])]
    if (st && st.hd) return true
  }
  return false
}

// Context key (TDD 3.2): species / night / stage band / biome group. '/' keeps it inside the GA's id alphabet.
function pneHiveCtx(mob, type, level, pos, stage) {
  var dt = pneHiveDayTime(level) % 24000
  var night = dt >= 13000 && dt < 23000 ? 1 : 0
  var band = stage <= 2 ? 0 : (stage <= 5 ? 1 : (stage <= 8 ? 2 : 3))
  var dim = pneCoreDim(level)
  var biome = 'surface'
  var bid = ''
  var bp = null
  var sky = true
  if (dim.indexOf('nether') >= 0) biome = 'nether'
  else if (dim.indexOf('end') >= 0) biome = 'end'
  else {
    try { bp = mob.blockPosition() } catch (e) { bp = null }
    if (bp) {
      try { bid = String(level.getBiome(bp).unwrapKey().get().location()) } catch (e2) { bid = '' }
      try { sky = level.canSeeSky(bp) ? true : false } catch (e3) { sky = true }
    }
    if (bid.indexOf('parasite') >= 0) biome = 'ruin'
    else if (!sky && pos && pos[1] < 60) biome = 'cave'
  }
  return type + '/' + night + '/' + band + '/' + biome
}

// Expression (TDD 3.3.1 express / expressWith, 3.1 phenotype). fresh = newborn (first expression).
function pneHiveExpress(srv, mob, rec, pd, fresh) {
  var GA = PNE_HIVE_GA
  var level = pneHiveLevel(mob)
  var pos = pneHivePos(mob)
  var type = pneCoreTypeId(mob)
  var stage = level ? pneCoreStage(level) : 0
  var B
  var hadSil
  rec.type = type
  rec.strain = type.indexOf('spore:') === 0 ? 'spore' : 'epca'
  B = GA.budget(stage, GA.gov(pneHiveSt), pneHiveGraceNear(level, pos))
  rec.e = GA.express(rec.g, GA.mask(type), B)
  rec.clade = GA.clade(rec.g)
  rec.stage = stage
  if (pos) {
    rec.x = pos[0]
    rec.y = pos[1]
    rec.z = pos[2]
  }
  rec.dim = level ? pneCoreDim(level) : ''
  pneHiveApplyAttrs(mob, rec, pd)
  try { pd.putInt('pne_prj', Math.round(1000 * rec.e[7])) } catch (e) { }
  // SIL: silent until the first attack or within 3 blocks, and only while a tell can be played
  rec.silGene = rec.e[5] >= PNE_HIVE_SIL_MIN
  hadSil = pneHivePdByte(pd, 'pne_sil') === 1
  if (fresh) {
    if (rec.silGene && !rec.attacked && pneHiveTellable()) pneHiveSilence(srv, rec, pd)
  } else if (hadSil) {
    if (rec.silGene && !rec.attacked && !rec.silOff && pneHiveTellable()) pneHiveSilence(srv, rec, pd)
    else pneHiveUnsilence(srv, rec)
  }
  pneHiveApplyTags(mob, rec, fresh)
  if (fresh && rec.e[9] >= 0.5 && pneHiveAxeQ.length < PNE_HIVE_Q_MAX) pneHiveAxeQ.push(rec)
  rec.apex = pneHiveIsApex(rec.g)
  pneCoreVisApply(mob, { clade: rec.clade, apex: rec.apex, graft: pneHiveGraft(rec.e), stage: stage, strain: rec.strain, e: rec.e })
}

// PRC axe (TDD 3.1): EPCA hosts show no held items but vanilla maybeDisableShield applies (25% + 5% per
// Efficiency level, so Efficiency <= II keeps it <= 35%); AttributeModifiers:[] removes the axe's own damage;
// mainhand drop chance 0. Spore renders held items, so its axe carries CustomModelData 7301 (VISUAL's empty
// model). Only an empty main hand gets one (a mob's own weapon is never replaced).
function pneHiveGiveAxe(srv, rec) {
  var hand = null
  var empty = false
  var lvl
  var nbt
  try {
    hand = rec.mob.getMainHandItem()
    empty = hand ? (hand.isEmpty() ? true : false) : false
  } catch (e) { empty = false }
  if (!empty) return false
  lvl = rec.e[9] >= 0.8 ? 2 : (rec.e[9] >= 0.65 ? 1 : 0)
  nbt = '{AttributeModifiers:[]' + (lvl > 0 ? ',Enchantments:[{id:"minecraft:efficiency",lvl:' + lvl + 's}]' : '') +
    (rec.strain === 'spore' ? ',CustomModelData:' + PNE_CORE_AXE_CMD : '') + '}'
  if (pneHiveCmd(srv, 'item replace entity ' + rec.u + ' weapon.mainhand with minecraft:iron_axe' + nbt) <= 0) return false
  pneHiveCmd(srv, 'data merge entity ' + rec.u + ' {HandDropChances:[0.0f,0.085f]}')
  rec.axe = true
  return true
}

// ---------------------------------------------------------------------------------------------
// Apex set (top 5% by shrunk estimate with n >= 6), cached for 200 ticks or until the pool changes

function pneHiveApexSet() {
  if (!pneHiveSt) return {}
  if (!pneHiveApex || pneHiveApexAt < 0 || Math.abs(pneCoreTick - pneHiveApexAt) >= 200) {
    pneHiveApex = PNE_HIVE_GA.apexSet(pneHiveSt)
    pneHiveApexAt = pneCoreTick
  }
  return pneHiveApex
}

function pneHiveIsApex(g) {
  return pneHiveApexSet()[g] === true
}

// ---------------------------------------------------------------------------------------------
// Joins (contract 3.3). The handler only queues (O(1)); nothing is ever cancelled (F19).

function pneHiveOnSpawned(ent) {
  var s = ''
  var pd
  var u
  var g
  var q
  var t
  var level
  if (!ent) return
  try { s = String(ent.type) } catch (e) { s = '' }
  if (s.indexOf(':') > 0 && !pneHiveIsParaId(s)) return
  if (!pneCoreIsParasite(ent)) return
  pd = pneCorePD(ent)
  if (!pd) return
  // A saved silent mob whose tells cannot run (a hive job cut off) is made audible right away.
  if (pneHivePdByte(pd, 'pne_sil') === 1 && (PNE_HIVE_B_DRAIN.off || PNE_HIVE_B_SIL.off || pneHiveSilBroken)) {
    pneHiveSetSilent(pneCoreServer, ent, pneCoreUuid(ent), false)
    try { pd.remove('pne_sil') } catch (e2) { }
  }
  u = pneCoreUuid(ent)
  if (!u) return
  g = pneHivePdStr(pd, 'pne_g')
  if (g.length === 56) {
    // Already queued: this is a newer object with the same UUID (its chunk unloaded and loaded again, or it changed
    // dimension, before the drain). The newest object is the live one, so it replaces the queued one.
    q = pneHiveRejoinSet.hasOwnProperty(u) ? pneHiveRejoinSet[u] : null
    if (q) {
      q.mob = ent
      return
    }
    if (pneHiveRejoinQ.length >= PNE_HIVE_Q_MAX) return
    q = { mob: ent, u: u }
    pneHiveRejoinSet[u] = q
    pneHiveRejoinQ.push(q)
    return
  }
  if (pneHiveNewQ.length >= PNE_HIVE_Q_MAX) {
    pneHiveStats.qDropped++
    return
  }
  // join time and place (the conversion search pairs removals with newborns by both); game time never runs backwards,
  // so the queue stays sorted by t
  t = pneCoreNow(ent)
  if (pneHiveNewQ.length && !(t >= pneHiveNewQ[pneHiveNewQ.length - 1].t)) t = pneHiveNewQ[pneHiveNewQ.length - 1].t
  level = pneHiveLevel(ent)
  pneHiveNewQ.push({ mob: ent, u: u, n: pneHiveTickNo, t: t, p: pneHivePos(ent), dim: level ? pneCoreDim(level) : '' })
}

// The GA core failed to load: no genomes at all, but saved silent mobs must never stay silent.
function pneHiveFallbackSpawned(ent) {
  var s = ''
  var pd
  try { s = String(ent.type) } catch (e) { s = '' }
  if (!pneHiveIsParaId(s)) return
  pd = pneCorePD(ent)
  if (!pd || pneHivePdByte(pd, 'pne_sil') !== 1) return
  try { ent.setSilent(false) } catch (e2) { pneHiveCmd(pneCoreServer, 'data merge entity ' + pneCoreUuid(ent) + ' {Silent:0b}') }
  try { pd.remove('pne_sil') } catch (e3) { }
}

function pneHiveRejoin(srv, mob, u) {
  var pd = pneCorePD(mob)
  var g
  var rec
  var old
  if (!pd || !pneHiveAlive(mob)) return
  g = pneHivePdStr(pd, 'pne_g')
  if (!PNE_HIVE_HEX_RX.test(g)) return
  old = pneHiveMobs[u]
  rec = pneHiveNewRec(mob, u)
  if (old && old.g === g) {
    rec.tel = old.tel
    rec.attacked = old.attacked
    rec.hit = old.hit
    rec.silOff = old.silOff
    rec.cause = old.cause
    rec.lastEng = old.lastEng
    rec.lastTgtU = old.lastTgtU
  } else {
    pneHiveTelLoad(rec, pneHivePdStr(pd, 'pne_tel'))
  }
  rec.g = g
  rec.id = pneHivePdStr(pd, 'pne_gi') || ('u' + u.substring(0, 8))
  rec.parents = pneHivePdStr(pd, 'pne_gp')
  rec.ctx = pneHivePdStr(pd, 'pne_ctx')
  rec.t0 = pneHivePdLong(pd, 'pne_t0')
  pneHiveExpress(srv, mob, rec, pd, false)
  pneHiveTrack(rec)
  pneHiveStats.rejoins++
}

// Buffered removal nearest to pos (same dimension) whose removal time is within 2 ticks of the join.
function pneHiveConvFind(pos, dim, t) {
  var best = null
  var bd = PNE_HIVE_CONV_R2 + 1e-9
  var i
  var c
  var d
  for (i = 0; i < pneHiveConv.length; i++) {
    c = pneHiveConv[i]
    if (c.used || c.dim !== dim || Math.abs(c.t - t) > PNE_HIVE_CONV_DT) continue
    d = pneHiveD2(c.x, c.y, c.z, pos[0], pos[1], pos[2])
    if (d <= bd) {
      bd = d
      best = c
    }
  }
  return best
}

function pneHiveNamed(mob) {
  try { return mob.hasCustomName() ? true : false } catch (e) { return true }
}

function pneHivePersistent(mob) {
  try { return mob.isPersistenceRequired() ? true : false } catch (e) { return true }
}

// Backstop decision (contract 3.3): exactly the contract's conditions, decided by the core formula with the players'
// live positions (no shortcut from the hive's own player table, which lags a respawn or a teleport). Unreadable name or
// persistence counts as "keep".
function pneHiveBackstop(mob, pd, level, pos) {
  if (pneCoreCfg('spawn_backstop') !== 1) return false
  if (pneHivePdByte(pd, 'pne_fresh') !== 1) return false
  if (pneHivePdStr(pd, 'pne_g').length) return false
  if (!level || !pos) return false
  if (pneHiveNamed(mob) || pneHivePersistent(mob)) return false
  return pneCoreNaturalMultAt(level, pos[0], pos[1], pos[2], 48) === 0
}

// The genome id this run writes on the mob (pne_gi). The GA's counters roll back with its state when /reload or a crash
// reloads the last save, so every id must carry this run's load epoch. Ids the GA generates after the epoch call carry it
// already ('j42.3' in epoch 3) and are used as they are. A queued child bred before the last save keeps the id it was
// bred with ('b17.2'); after a rollback to that save it would be handed out a second time, so it gets this run's epoch
// appended ('b17.2.3'), which no GA id (one dot) can equal.
function pneHiveRunId(id) {
  var s = String(id)
  var tail = '.' + pneHiveEpoch
  if (s.length > tail.length && s.substring(s.length - tail.length) === tail) return s
  return s + tail
}

function pneHiveNewborn(srv, q) {
  var mob = q.mob
  var pd
  var level
  var pos
  var dim
  var link
  var child
  var rec
  if (!pneHiveAlive(mob)) return
  pd = pneCorePD(mob)
  if (!pd) return
  if (pneHivePdStr(pd, 'pne_g').length === 56) {
    pneHiveRejoin(srv, mob, q.u)
    return
  }
  level = pneHiveLevel(mob)
  pos = pneHivePos(mob)
  dim = level ? pneCoreDim(level) : ''
  // the conversion link pairs the join (where and when it joined) with a buffered removal
  link = (q.p || pos) ? pneHiveConvFind(q.p || pos, q.dim || dim, q.t) : null
  // Backstop first: before any RNG draw (no GA join, no J event).
  if (!link && pneHiveBackstop(mob, pd, level, pos)) {
    try { pd.putByte('pne_pacing_discard', 1) } catch (e) { }
    try { mob.discard() } catch (e2) { }
    pneHiveStats.backstop++
    return
  }
  child = PNE_HIVE_GA.join(pneHiveSt, link ? { id: link.id, g: link.g } : null)
  if (link) {
    link.used = true
    pneHiveStats.links++
  }
  rec = pneHiveNewRec(mob, q.u)
  rec.g = child.hex
  rec.id = pneHiveRunId(child.id)
  rec.parents = child.parents
  rec.t0 = q.t
  rec.ctx = pneHiveCtx(mob, pneCoreTypeId(mob), level, pos, level ? pneCoreStage(level) : 0)
  pd.putString('pne_g', child.hex)
  pd.putInt('pne_gv', PNE_HIVE_SCHEMA)
  pd.putString('pne_gp', child.parents)
  pd.putString('pne_gi', rec.id)
  pd.putString('pne_ctx', rec.ctx)
  pd.putLong('pne_t0', q.t)
  pneHiveExpress(srv, mob, rec, pd, true)
  try { pd.remove('pne_fresh') } catch (e3) { }
  pneHiveTrack(rec)
  pneHiveStats.joins++
}

// ---------------------------------------------------------------------------------------------
// Removals (TDD 3.2 removal handling) and damage records

function pneHiveOutcomeRec(rec) {
  var t = rec.tel
  var cheese
  if (!(t.loc || t.eng > 0 || t.dmg > 0)) return null   // never engaged: no evidence
  cheese = rec.cause === 'void' || rec.cause === 'kill' || rec.cause === 'fall' || (t.engN > 0 && t.chz * 2 > t.engN)
  // Only telemetry channels, the genome and its expression: no arousal and no player health (I2).
  return {
    id: rec.id, g: rec.g, parents: rec.parents, ctx: rec.ctx, e: rec.e,
    tel: { dmg: t.dmg, engagedSec: t.eng, located: t.loc ? 1 : 0, killShare: t.kill, teamPressure: t.team,
      fastKill: t.fast ? true : false, cheese: cheese ? true : false }
  }
}

function pneHiveQueueOutcome(rec) {
  var out = pneHiveOutcomeRec(rec)
  if (!out) return
  if (pneHiveOutQ.length >= PNE_HIVE_OUT_MAX) {
    pneHiveStats.outDropped++
    return
  }
  pneHiveOutQ.push({ rec: out, sp: rec.type })
}

// A newborn waiting in the queue within 2.5 blocks whose join is within 2 ticks: this discard is a conversion.
// pneHiveNewQ is sorted by join time, so a binary search finds the newest join at or before t + 2 and the scan walks
// back only through joins within the 2-tick window (at most PNE_HIVE_CONV_SCAN of them), comparing the stored join
// positions: O(log n + window) per removal however deep the newborn queue is.
function pneHiveConversionJoin(x, y, z, dim, t) {
  var Q = pneHiveNewQ
  var lo = 0
  var hi = Q.length
  var mid
  var i
  var q
  var n = 0
  while (lo < hi) {
    mid = Math.floor((lo + hi) / 2)
    if (Q[mid].t > t + PNE_HIVE_CONV_DT) hi = mid
    else lo = mid + 1
  }
  for (i = lo - 1; i >= 0 && n < PNE_HIVE_CONV_SCAN; i--) {
    q = Q[i]
    if (q.t < t - PNE_HIVE_CONV_DT) break
    n++
    if (!q.p || q.dim !== dim) continue
    if (pneHiveD2(q.p[0], q.p[1], q.p[2], x, y, z) <= PNE_HIVE_CONV_R2 + 1e-9) return true
  }
  return false
}

// Survival players' dimension and position, read once per tick (live positions, never the 1 Hz player states).
function pneHivePlayersPos(srv) {
  var ps
  var out
  var i
  var level
  var pos
  if (pneHivePosTick === pneCoreTick && pneHivePosList) return pneHivePosList
  ps = pneCorePlayers(srv)
  out = []
  for (i = 0; i < ps.length; i++) {
    level = pneHiveLevel(ps[i])
    pos = pneHivePos(ps[i])
    if (level && pos) out.push({ dim: pneCoreDim(level), x: pos[0], y: pos[1], z: pos[2] })
  }
  pneHivePosTick = pneCoreTick
  pneHivePosList = out
  return out
}

// Natural despawn: no survival player within 32 blocks and not engaged during the last 600 ticks.
function pneHiveDespawn(srv, rec, x, y, z, dim, t) {
  var ps
  var i
  var q
  if (rec && t - rec.lastEng <= PNE_HIVE_DESPAWN_IDLE) return false
  ps = pneHivePlayersPos(srv)
  for (i = 0; i < ps.length; i++) {
    q = ps[i]
    if (q.dim === dim && pneHiveD2(q.x, q.y, q.z, x, y, z) <= PNE_HIVE_DESPAWN_R * PNE_HIVE_DESPAWN_R) return false
  }
  return true
}

// l|uuid|reason|g|gi|x|y|z|dim|t|pacing|type
function pneHiveOnLeave(srv, s) {
  var p = s.split('|')
  var u
  var reason
  var rec
  var x
  var y
  var z
  var dim
  var t
  if (p.length < 12 || p[0] !== 'l') return
  u = p[1]
  reason = p[2]
  rec = pneHiveMobs.hasOwnProperty(u) ? pneHiveMobs[u] : null
  // the record belongs to an older entity object when the tracked one is still in the world (a dimension change
  // or a rejoin already replaced it)
  if (rec && !pneHiveRemoved(rec.mob)) rec = null
  if (p[10] === '1') {
    if (rec) pneHiveUntrack(rec)
    return
  }
  if (PNE_HIVE_NON_OUTCOME[reason] === true) {
    if (rec) pneHiveUntrack(rec)
    return
  }
  if (reason !== 'KILLED' && reason !== 'DISCARDED') {
    if (rec) pneHiveUntrack(rec)
    return
  }
  x = Number(p[5])
  y = Number(p[6])
  z = Number(p[7])
  dim = p[8]
  t = Number(p[9])
  if (!isFinite(x) || !isFinite(y) || !isFinite(z) || !isFinite(t)) {
    if (rec) pneHiveUntrack(rec)
    return
  }
  if (reason === 'DISCARDED' && !pneHiveConversionJoin(x, y, z, dim, t) && pneHiveDespawn(srv, rec, x, y, z, dim, t)) {
    if (rec) {
      pneCoreVisRemove(rec.mob)
      pneHiveUntrack(rec)
    }
    return
  }
  if (PNE_HIVE_HEX_RX.test(p[3])) {
    if (pneHiveConv.length >= PNE_HIVE_CONV_MAX) pneHiveConv.shift()
    pneHiveConv.push({ x: x, y: y, z: z, dim: dim, t: t, g: p[3], id: p[4] || (rec ? rec.id : ''), used: false })
  }
  if (rec) {
    pneHiveQueueOutcome(rec)
    pneCoreVisRemove(rec.mob)
    pneHiveUntrack(rec)
  }
}

function pneHiveMsgCause(msg) {
  if (msg === 'outOfWorld') return 'void'
  if (msg === 'genericKill') return 'kill'
  if (msg === 'fall') return 'fall'
  return 'other'
}

function pneHivePlayerByU(srv, u) {
  var ps = pneCorePlayers(srv)
  var i
  for (i = 0; i < ps.length; i++) {
    if (pneCoreUuid(ps[i]) === u) return ps[i]
  }
  return null
}

// d|attacker|player|amount*1000|k|proj|t, x|player|msgId|t, p|mob|player|t
function pneHiveOnDamage(srv, s) {
  var p = s.split('|')
  var rec
  var kd
  var L
  var t
  var w
  var pl
  if (p[0] === 'd' && p.length >= 7) {
    t = Number(p[6])
    kd = Number(p[3]) / 1000 * (p[4] === '1' ? 1 : 0)
    if (!isFinite(kd) || kd < 0) kd = 0
    rec = pneHiveMobs.hasOwnProperty(p[1]) ? pneHiveMobs[p[1]] : null
    if (rec) {
      rec.tel.dmg = Math.min(PNE_HIVE_DMG_CAP, rec.tel.dmg + kd)
      if (!rec.attacked) {
        rec.attacked = true
        if (rec.sil) pneHiveUnsilence(srv, rec)
      }
      pneHiveTelSave(rec)
    }
    pneHiveTeamDmg[p[2]] = (pneHiveTeamDmg[p[2]] || 0) + kd
    L = pneHiveLedger[p[2]]
    if (!L) {
      L = []
      pneHiveLedger[p[2]] = L
    }
    L.push({ t: t, u: p[1], k: kd })
    while (L.length && (t - L[0].t > PNE_HIVE_KILL_WINDOW || L.length > 256)) L.shift()
    return
  }
  if (p[0] === 'x' && p.length >= 4) {
    pneHiveFatal[p[1]] = { t: Number(p[3]), cause: pneHiveMsgCause(p[2]) }
    return
  }
  if (p[0] === 'p' && p.length >= 4) {
    rec = pneHiveMobs.hasOwnProperty(p[1]) ? pneHiveMobs[p[1]] : null
    if (!rec || rec.hit) return
    rec.hit = true
    pneHiveTelSave(rec)
    if (rec.tel.loc) return
    // audio tactic (weak proxy): the player struck before this mob had located anyone
    pl = pneHivePlayerByU(srv, p[2])
    w = pl ? pneHiveNum(pneCoreGaWeight(pl), 0) : 0
    if (w > 0) pneHiveTDay[4] += w
  }
}

// ---------------------------------------------------------------------------------------------
// Drains (every tick): leave and damage records, rejoins, newborns, axes. Returns true while a drain is pending.

// Newborns the conversion search walks for a removal at game time t: the joins within 2 ticks of it (two binary
// searches on the sorted newborn queue), at most PNE_HIVE_CONV_SCAN.
function pneHiveConvWindow(t) {
  var Q = pneHiveNewQ
  var lo = 0
  var hi = Q.length
  var mid
  var a
  while (lo < hi) {
    mid = Math.floor((lo + hi) / 2)
    if (Q[mid].t < t - PNE_HIVE_CONV_DT) lo = mid + 1
    else hi = mid
  }
  a = lo
  hi = Q.length
  while (lo < hi) {
    mid = Math.floor((lo + hi) / 2)
    if (Q[mid].t > t + PNE_HIVE_CONV_DT) hi = mid
    else lo = mid + 1
  }
  return Math.min(PNE_HIVE_CONV_SCAN, lo - a)
}

// Removes and returns up to max leave records from the front of the startup leave queue, each charged before it is taken:
// a KILLED record (outcome, buffer) costs leaveOut, a DISCARDED one also convRec per newborn its conversion search will
// walk, any other record mobSample.
function pneHiveTakeLeave(q, max) {
  var n = pneHiveQueueSize(q)
  var k = n < max ? n : max
  var out = []
  var s
  var c
  var t
  var i
  for (i = 0; i < k; i++) {
    s = String(q.get(i))
    c = PNE_CORE_COST.mobSample
    if (s.indexOf('|KILLED|') > 0) c = pneHiveCost('leaveOut')
    else if (s.indexOf('|DISCARDED|') > 0) {
      t = Number(s.split('|')[9])
      c = pneHiveCost('leaveOut') + (isFinite(t) ? pneHiveConvWindow(t) : 0) * pneHiveCost('convRec')
    }
    if (!pneCoreTake(c)) break
    out.push(s)
  }
  if (!out.length) return out
  if (out.length === n) {
    q.clear()
  } else {
    try {
      q.subList(0, out.length).clear()
    } catch (e) {
      for (i = 0; i < out.length; i++) q.remove(0)
    }
  }
  return out
}

// true when no leave record still queued can be the removal of a carrier that converted into a newborn joined at t:
// the queue is in event order and game time never runs backwards, so once its head was recorded more than 2 ticks after
// t, so were all the others. A newborn waits at most PNE_HIVE_CONV_KEEP ticks (its carrier's buffered removal would
// expire by then anyway).
function pneHiveLeaveClear(q, t, now) {
  var lt
  if (pneHiveQueueSize(q) === 0 || now - t > PNE_HIVE_CONV_KEEP) return true
  try { lt = Number(String(q.get(0)).split('|')[9]) } catch (e) { return true }
  return !isFinite(lt) || lt > t + PNE_HIVE_CONV_DT
}

function pneHiveDrains(srv, now) {
  var recs
  var k
  var i
  var q
  var pending = false
  // leave records first, so a carrier's removal is buffered before its newborn is drained (and more of them while a
  // newborn is waiting on them)
  q = pneHiveQLeave()
  k = (pneHiveNewQ.length && pneHiveNewQ[0].n < pneHiveTickNo - 1 && !pneHiveLeaveClear(q, pneHiveNewQ[0].t, now)) ? PNE_HIVE_REC_BOOST : PNE_HIVE_REC_MAX
  recs = pneHiveTakeLeave(q, k)
  for (i = 0; i < recs.length; i++) pneHiveOnLeave(srv, recs[i])
  if (pneHiveQueueSize(q) > 0) pending = true
  q = pneHiveQDamage()
  k = pneCoreTakeN(PNE_CORE_COST.mobSample, Math.min(PNE_HIVE_REC_MAX, pneHiveQueueSize(q)))
  recs = pneHiveTake(q, k)
  for (i = 0; i < recs.length; i++) pneHiveOnDamage(srv, recs[i])
  if (pneHiveQueueSize(q) > 0) pending = true
  // rejoins, drawn first (contract 7.2)
  k = 0
  while (pneHiveRejoinQ.length && k < PNE_HIVE_REJOIN_MAX) {
    if (!pneCoreTake(pneHiveCost('rejoin'))) break
    q = pneHiveRejoinQ.shift()
    if (pneHiveRejoinSet[q.u] === q) delete pneHiveRejoinSet[q.u]
    pneHiveRejoin(srv, q.mob, q.u)
    k++
  }
  if (pneHiveRejoinQ.length) pending = true
  // newborns that joined in an earlier tick, once no queued leave record can be their carrier's removal (a linked
  // newborn is never discarded by the backstop, so its carrier's removal must be buffered first)
  k = 0
  q = pneHiveQLeave()
  while (pneHiveNewQ.length && k < PNE_HIVE_NEWBORN_MAX) {
    if (pneHiveNewQ[0].n >= pneHiveTickNo - 1) break
    if (!pneHiveLeaveClear(q, pneHiveNewQ[0].t, now)) break
    if (!pneCoreTake(pneHiveCost('newborn'))) break
    pneHiveNewborn(srv, pneHiveNewQ.shift())
    k++
  }
  if (pneHiveNewQ.length && pneHiveNewQ[0].n < pneHiveTickNo - 1) pending = true
  // PRC axes (two commands each)
  while (pneHiveAxeQ.length) {
    q = pneHiveAxeQ[0]
    if (q.dead || !pneHiveAlive(q.mob)) {
      pneHiveAxeQ.shift()
      continue
    }
    if (!pneCoreTake(2 * PNE_CORE_COST.emit)) break
    pneHiveAxeQ.shift()
    pneHiveGiveAxe(srv, q)
  }
  return pending
}

// ---------------------------------------------------------------------------------------------
// Telemetry samples (<= 20 per tick, round robin) and steering

function pneHivePS(u) {
  var s = pneHivePlayerSt[u]
  if (!s) {
    s = { x: 0, y: 0, z: 0, yaw: 0, moveT: -1, hist: [], light: 0, dim: '', t: -1000000, hd: false, surv: true }
    pneHivePlayerSt[u] = s
  }
  return s
}

function pneHiveAfk(u, now) {
  var s = pneHivePlayerSt[u]
  return s ? (s.moveT >= 0 && now - s.moveT > PNE_HIVE_AFK) : false
}

// Survival and AFK from the player's 1 Hz state when it is fresh, else from the core.
function pneHiveCheesy(tgt, pu, now) {
  var ps = pneHivePlayerSt[pu]
  if (ps && now - ps.t <= PNE_HIVE_PS_FRESH) return !ps.surv || (ps.moveT >= 0 && now - ps.moveT > PNE_HIVE_AFK)
  return !pneCoreIsSurvival(tgt) || pneHiveAfk(pu, now)
}

function pneHiveSample(srv, rec, now) {
  var mob = rec.mob
  var pos
  var dt
  var tgt = null
  var tpos
  var pu = ''
  var team
  var per
  var d2
  var save = false
  var alive = true
  if (pneHiveRemoved(mob)) {
    pneHiveSetTarget(rec, '')
    if (rec.gone < 0) rec.gone = now
    else if (now - rec.gone > 400) pneHiveUntrack(rec)   // no leave record came (startup listener absent)
    return
  }
  pos = pneHivePos(mob)
  if (pos) {
    rec.x = pos[0]
    rec.y = pos[1]
    rec.z = pos[2]
    pneHiveGridSet(rec)
  }
  dt = rec.lastS > 0 ? now - rec.lastS : 0
  if (dt > PNE_HIVE_SAMPLE_DT_MAX) dt = PNE_HIVE_SAMPLE_DT_MAX
  if (dt < 0) dt = 0
  rec.lastS = now
  try { alive = mob.isAlive() ? true : false } catch (e) { alive = true }
  if (alive) {
    try { tgt = mob.getTarget() } catch (e2) { tgt = null }
  }
  if (tgt && pneCoreIsPlayer(tgt)) {
    if (!rec.tel.loc) {
      rec.tel.loc = true
      rec.tel.locT = now
      save = true
    }
    tpos = pneHivePos(tgt)
    d2 = (pos && tpos) ? pneHiveD2(pos[0], pos[1], pos[2], tpos[0], tpos[1], tpos[2]) : Infinity
    // the 3-block rule, also on the sample path (the silent pass checks every player on its own cadence)
    if (rec.sil && d2 <= PNE_HIVE_SIL_CLOSE2) pneHiveUnsilence(srv, rec)
    if (d2 <= PNE_HIVE_ENGAGE_R2) {
      pu = pneCoreUuid(tgt)
      rec.tel.eng += dt / 20
      rec.tel.engN++
      if (pneHiveCheesy(tgt, pu, now)) rec.tel.chz++
      rec.lastEng = now
      rec.lastTgtU = pu
      // the accumulator is written on events (located, damage, kill credit) and every 5th engaged sample
      if (rec.tel.engN % 5 === 0) save = true
    }
  }
  pneHiveSetTarget(rec, pu)
  if (pu) {
    team = pneHiveTeamDmg[pu] || 0
    per = pneHiveEngagedOn[pu] || 1
    if (team > rec.teamMark) rec.tel.team += (team - rec.teamMark) / per
    rec.teamMark = team
  }
  if (save) pneHiveTelSave(rec)
  pneHiveSteer(srv, rec, pu, now)
}

// Player position about 3 s ago (the per-player step keeps one entry per second).
function pneHiveHistAt(ps, t) {
  var i
  var h
  for (i = ps.hist.length - 1; i >= 0; i--) {
    h = ps.hist[i]
    if (h.t <= t) return h
  }
  return null
}

// SCT breadcrumbs through Mob#getNavigation (TDD 3.1: a mob that lost its player paths to where the player was 3 s ago;
// F33: reachable from Rhino only in game). moveTo runs a synchronous path search whose cost nobody has measured yet, so
// steering runs only with config debug 1 (until spark measures it and the lead adds a switch), at most once per tick and
// charged PNE_HIVE_MEASURED.steer. Probed on first use; when it fails, SCT stays tag-only. FLK never steers: its TDD
// phenotype is spawn placement in the player's rear arc, which the director's reinforcement logic does with HiveInfo.flk.
function pneHiveSteer(srv, rec, pu, now) {
  var sct
  var ps
  var pt
  var nav
  if (!pneHiveSteerOn || pu || pneHiveNav === 0 || pneHiveSteerN >= PNE_HIVE_STEER_MAX || !rec.e) return
  sct = pneHiveTier(rec.e[2])
  if (sct < 1 || !rec.lastTgtU || now - rec.lastEng > 100 * sct || now - rec.steerT < 40) return
  ps = pneHivePlayerSt[rec.lastTgtU]
  pt = ps ? pneHiveHistAt(ps, now - 60) : null
  if (!pt || pt.dim !== rec.dim) return
  if (!pneCoreTake(pneHiveCost('steer'))) return
  pneHiveSteerN++
  rec.steerT = now
  try {
    nav = rec.mob.getNavigation()
    nav.moveTo(pt.x, pt.y, pt.z, 1.0)
    pneHiveNav = 1
    pneHiveStats.steer++
  } catch (e) {
    pneHiveNav = 0
    pneCoreWarn('hive', 'nav', 'Mob#getNavigation is not reachable from scripts; SCT stays tag-only (' + e + ')', 1)
  }
}

function pneHiveSampleJob(srv, now) {
  var n = pneCoreTakeN(PNE_CORE_COST.mobSample, Math.min(PNE_HIVE_SAMPLE_MAX, pneHiveMobN))
  var done = 0
  var guard = pneHiveList.length + n
  var rec
  while (done < n && pneHiveList.length && guard-- > 0) {
    if (pneHiveCursor >= pneHiveList.length) pneHiveCursor = 0
    rec = pneHiveList[pneHiveCursor]
    if (rec.dead) {
      pneHiveList[pneHiveCursor] = pneHiveList[pneHiveList.length - 1]
      pneHiveList.pop()
      continue
    }
    pneHiveCursor++
    pneHiveSample(srv, rec, now)
    done++
  }
}

// ---------------------------------------------------------------------------------------------
// Silent pass: each silent mob once per 20 ticks (its phase): ash tell, L8 tells, the 3-block rule

// The survival players within sqrt(r2) blocks of a silent mob, each with its UUID and squared distance, and the nearest
// squared distance (Infinity when nobody is there). Refreshes the record's position.
function pneHivePlayersAround(rec, r2) {
  var level = pneHiveLevel(rec.mob)
  var pos = pneHivePos(rec.mob)
  var out = { list: [], d2: Infinity }
  var ps
  var i
  var q
  var d
  var u
  if (!level || !pos) return out
  rec.x = pos[0]
  rec.y = pos[1]
  rec.z = pos[2]
  ps = pneCorePlayersNear(level, pos[0], pos[1], pos[2], Math.sqrt(r2))
  for (i = 0; i < ps.length; i++) {
    q = pneHivePos(ps[i])
    if (!q) continue
    d = pneHiveD2(q[0], q[1], q[2], pos[0], pos[1], pos[2])
    if (d > r2) continue
    u = pneCoreUuid(ps[i])
    if (!u) continue
    out.list.push({ p: ps[i], u: u, d2: d })
    if (d < out.d2) out.d2 = d
  }
  return out
}

// L8 tells (contract 3.3; open decision "tells for every player within 12 blocks"): every survival player within 12 blocks
// is told through the core (pneCoreTell: that player's own ledger and switches), at most once per 100 ticks per (mob,
// player): rec.tells maps the player's UUID to its last attempt { t, ok } while that attempt is inside the 100-tick window.
// The mob keeps Silent while at least one player within 12 blocks heard a tell inside the window; when every player within
// 12 blocks was refused (no nearby player could be told), Silent is dropped for good. A tell that does not fit the budget
// makes the mob audible (fairness is a floor, not a budget item). Returns false when Silent was dropped.
function pneHiveTells(srv, rec, list, now) {
  var T = rec.tells
  var k
  var i
  var q
  var e
  var within = 0
  var heard = false
  for (k in T) {
    if (T.hasOwnProperty(k) && !(now >= T[k].t && now - T[k].t < PNE_HIVE_TELL_EVERY)) delete T[k]
  }
  for (i = 0; i < list.length; i++) {
    q = list[i]
    if (q.d2 > PNE_HIVE_TELL_R2) continue
    within++
    e = T.hasOwnProperty(q.u) ? T[q.u] : null
    if (!e) {
      if (!pneCoreTake(PNE_CORE_COST.emit)) {
        pneHiveUnsilence(srv, rec)
        return false
      }
      e = { t: now, ok: pneCoreTell(rec.mob, q.p) === true }
      T[q.u] = e
      pneHiveStats.tells++
      if (!e.ok) pneHiveStats.tellFail++
    }
    if (e.ok) heard = true
  }
  if (within > 0 && !heard) {
    pneHiveUnsilence(srv, rec)
    return false
  }
  return true
}

// One visit of a silent mob: the 3-block rule, the 20-tick ash tell and the L8 tells (contract 3.3). Fairness is a floor,
// not a budget item: whatever does not fit the budget makes the mob audible (Silent dropped) instead of leaving it silent
// without its tells.
function pneHiveSilentVisit(srv, rec, now) {
  var near
  rec.visitN = pneHiveTickNo + PNE_HIVE_SIL_EVERY
  if (!pneHiveAlive(rec.mob)) return
  if (!pneCoreTake(pneHiveCost('silentVisit'))) {
    pneHiveUnsilence(srv, rec)
    return
  }
  if (rec.attacked || !pneHiveTellable()) {
    pneHiveUnsilence(srv, rec)
    return
  }
  near = pneHivePlayersAround(rec, PNE_HIVE_ASH_R2)
  if (!near.list.length) return
  if (near.d2 <= PNE_HIVE_SIL_CLOSE2) {
    pneHiveUnsilence(srv, rec)
    return
  }
  if (near.d2 <= PNE_HIVE_SIL_NEAR2) rec.visitN = pneHiveTickNo + PNE_HIVE_SIL_FAST
  if (now - rec.ashT >= PNE_HIVE_ASH_EVERY) {
    // the ash command is part of the silentVisit charge
    rec.ashT = now
    pneHiveCmd(srv, 'execute in ' + rec.dim + ' run particle minecraft:ash ' + pneCoreFmt(rec.x) + ' ' + pneCoreFmt(rec.y + 1) + ' ' +
      pneCoreFmt(rec.z) + ' 0.25 0.5 0.25 0 6 normal')
  }
  pneHiveTells(srv, rec, near.list, now)
}

// The silent pass, first in the hive's tick (so fairness work is not left the scraps): every silent mob is visited every
// 20 ticks, every 4 while a player is within 8 blocks; then the 30% cap, every tick.
function pneHiveSilentJob(srv, now) {
  var i
  var rec
  for (i = pneHiveSil.length - 1; i >= 0; i--) {
    rec = pneHiveSil[i]
    if (rec.dead || !rec.sil) {
      rec.inSil = false
      pneHiveSil[i] = pneHiveSil[pneHiveSil.length - 1]
      pneHiveSil.pop()
      continue
    }
    if (pneHiveTickNo >= rec.visitN) pneHiveSilentVisit(srv, rec, now)
  }
  pneHiveSilentCap(srv)
}

// At most 30% of the engaged genome mobs silent at once (TDD 3.1). Runs every tick (the engaged counts come from the
// round-robin samples, so a newly engaged silent mob is capped within a tick of its sample).
function pneHiveSilentCap(srv) {
  var engaged = []
  var i
  var allow = Math.floor(PNE_HIVE_SIL_SHARE * pneHiveEngagedN + 1e-9)
  for (i = 0; i < pneHiveSil.length; i++) {
    if (pneHiveSil[i].sil && !pneHiveSil[i].dead && pneHiveSil[i].targetU) engaged.push(pneHiveSil[i])
  }
  i = 0
  while (engaged.length - i > allow) {
    pneHiveUnsilence(srv, engaged[i])
    i++
  }
}

// ---------------------------------------------------------------------------------------------
// Per-player step (1 Hz, at the player's telemetry slot): AFK, position history, light, tactic evidence,
// hive-caused deaths (intra-day governor and kill credit)

function pneHiveBlockLight(level, pos) {
  var v = 0
  if (!level || !pos) return 0
  try { v = Number(level.getBlock(Math.floor(pos[0]), Math.floor(pos[1]), Math.floor(pos[2])).getBlockLight()) } catch (e) { v = 0 }
  return isFinite(v) ? v : 0
}

function pneHiveKillCredit(u, td) {
  var fat = pneHiveFatal[u]
  var L = pneHiveLedger[u] || []
  var total = 0
  var per = {}
  var i
  var k
  var rec
  var share
  if (fat && Math.abs(fat.t - td) <= 5 && fat.cause !== 'other') return   // fall, void or /kill: cheese, no credit
  for (i = 0; i < L.length; i++) {
    if (td - L[i].t < 0 || td - L[i].t > PNE_HIVE_KILL_WINDOW) continue
    total += L[i].k
    per[L[i].u] = (per[L[i].u] || 0) + L[i].k
  }
  if (!(total > 0)) return
  for (k in per) {
    if (!per.hasOwnProperty(k) || !pneHiveMobs.hasOwnProperty(k)) continue
    rec = pneHiveMobs[k]
    share = per[k] / total
    if (share > rec.tel.kill) rec.tel.kill = share
    if (rec.tel.loc && td - rec.tel.locT < PNE_HIVE_FAST_KILL) rec.tel.fast = true
    pneHiveTelSave(rec)
  }
}

function pneHiveDeathCheck(p, u, pid, now) {
  var pd = pneCorePD(p)
  var s = pneHivePdStr(pd, 'pne_hd')
  var parts
  var last
  if (!pid) return
  if (!s) {
    if (!pneHiveDeathSeen.hasOwnProperty(pid)) pneHiveDeathSeen[pid] = 0
    return
  }
  parts = s.split(',')
  last = Number(parts[parts.length - 1])
  if (!isFinite(last)) return
  if (!pneHiveDeathSeen.hasOwnProperty(pid)) {
    pneHiveDeathSeen[pid] = last   // deaths before this server run are history
    return
  }
  if (last <= pneHiveDeathSeen[pid]) return
  pneHiveDeathSeen[pid] = last
  // intra-day governor: 2 hive-caused deaths of one player within 20 real minutes -> gov x 0.85
  if (pneCoreHiveDeaths(p, PNE_HIVE_GOV_WINDOW) >= 2) {
    PNE_HIVE_GA.govStep(pneHiveSt)
    pneHiveStats.gov++
  }
  pneHiveKillCredit(u, last)
}

function pneHivePlayerStep(srv, p, now) {
  var u = pneCoreUuid(p)
  var pid = pneCorePid(p)
  var ps
  var pos
  var yaw = 0
  var level
  var w
  var threat
  var torches
  var v
  var si
  if (!u) return
  if (pid) pneHivePids[pid] = now
  ps = pneHivePS(u)
  pos = pneHivePos(p)
  // Entity.getYRot() is visible to scripts only as getYaw() (KubeJS's @RemapForJS rename, contract F37); getYRot() stays
  // as the fallback for mocks. A turn counts as movement for the AFK rule.
  try { yaw = Number(p.getYaw()) } catch (e) { yaw = NaN }
  if (!isFinite(yaw)) {
    try { yaw = Number(p.getYRot()) } catch (e2) { yaw = NaN }
  }
  if (!isFinite(yaw)) yaw = 0
  level = pneHiveLevel(p)
  ps.dim = level ? pneCoreDim(level) : ''
  if (pos) {
    if (ps.moveT < 0 || Math.abs(pos[0] - ps.x) > 0.1 || Math.abs(pos[1] - ps.y) > 0.1 || Math.abs(pos[2] - ps.z) > 0.1 || Math.abs(yaw - ps.yaw) > 1) ps.moveT = now
    ps.x = pos[0]
    ps.y = pos[1]
    ps.z = pos[2]
    ps.yaw = yaw
    ps.hist.push({ t: now, x: pos[0], y: pos[1], z: pos[2], dim: ps.dim })
    while (ps.hist.length > 5) ps.hist.shift()
  }
  ps.t = now
  ps.surv = pneCoreIsSurvival(p)
  ps.hd = pneCoreHiveDeaths(p, PNE_HIVE_GRACE_WINDOW) > 0
  ps.light = pneHiveBlockLight(level, pos)
  torches = pneHiveTorch[u] || 0
  pneHiveTorch[u] = 0
  // tactic evidence (T_est): each second weighted by the director's GA weight (PANIC 0.5; RELEASE, mercy and
  // grace 0) and only while the hive is engaged on this player; the Oracle contributes only its style bucket
  w = pneHiveNum(pneCoreGaWeight(p), 0)
  threat = (pneHiveEngagedOn[u] || 0) > 0
  if (w > 0 && threat) {
    v = pneCoreVerdict(p)
    if (v && v.fresh === true) {
      si = PNE_HIVE_STYLES.indexOf(String(v.style))
      if (si >= 0) pneHiveTDay[si] += w
    }
    if (ps.light >= PNE_HIVE_LIGHT_MIN) pneHiveTDay[3] += w
    if (torches > 0) pneHiveTDay[3] += w * Math.min(3, torches)
  }
  pneHiveDeathCheck(p, u, pid, now)
}

function pneHivePlayerJob(srv, now) {
  var ps = pneCorePlayersAtSlot(srv)
  var i
  for (i = 0; i < ps.length; i++) {
    if (!pneCoreTake(pneHiveCost('upkeep'))) return
    pneHivePlayerStep(srv, ps[i], now)
    pneHiveNearUpdate(ps[i], now)
  }
}

// Tracked records in the 3x3 grid of 32-block cells around a position (what one pneHiveNear table entry scans).
function pneHiveNearCount(dim, x, z) {
  var cx = Math.floor(x / 32)
  var cz = Math.floor(z / 32)
  var n = 0
  var gx
  var gz
  var cell
  for (gx = cx - 1; gx <= cx + 1; gx++) {
    for (gz = cz - 1; gz <= cz + 1; gz++) {
      cell = pneHiveGrid[dim + '|' + gx + '|' + gz]
      if (cell) n += cell.length
    }
  }
  return n
}

// The per-player pneHiveNear entry (contract 3.3: dominant clade among engaged genome mobs within 24 blocks, ties ->
// lower clade; an apex genome within 24; silent-gene mobs within 12 that have not attacked yet), computed once per
// second in this player's step and charged here by the records it scans, so pneHiveNear itself is O(1) for the
// director (whose own step constant could never cover a scan).
function pneHiveNearUpdate(p, now) {
  var u = pneCoreUuid(p)
  var ps = u ? pneHivePlayerSt[u] : null
  var counts = [0, 0, 0, 0]
  var apex = false
  var silent = 0
  var best = -1
  var cx
  var cz
  var gx
  var gz
  var cell
  var k
  var rec
  var d
  var i
  var dx
  var dy
  var dz
  var aset
  if (!ps || ps.t !== now || !ps.dim) return
  if (!pneCoreTake(pneHiveCost('nearBase') + pneHiveNearCount(ps.dim, ps.x, ps.z) * pneHiveCost('nearRec'))) return
  aset = pneHiveApexSet()
  cx = Math.floor(ps.x / 32)
  cz = Math.floor(ps.z / 32)
  for (gx = cx - 1; gx <= cx + 1; gx++) {
    for (gz = cz - 1; gz <= cz + 1; gz++) {
      cell = pneHiveGrid[ps.dim + '|' + gx + '|' + gz]
      if (!cell) continue
      for (k = 0; k < cell.length; k++) {
        rec = cell[k]
        dx = rec.x - ps.x
        dy = rec.y - ps.y
        dz = rec.z - ps.z
        d = dx * dx + dy * dy + dz * dz
        if (d > PNE_HIVE_NEAR_R2) continue
        if (rec.targetU) counts[rec.clade]++
        if (!apex && aset[rec.g] === true) apex = true
        if (d <= PNE_HIVE_SILENT_R2 && rec.silGene && !rec.attacked) silent++
      }
    }
  }
  for (i = 0; i < 4; i++) {
    if (counts[i] > 0 && (best < 0 || counts[i] > counts[best])) best = i
  }
  pneHiveNearCache[u] = { t: pneCoreTick, v: { clade: best, apex: apex, silent: silent } }
}

// ---------------------------------------------------------------------------------------------
// Light aversion (TDD 3.2): every 100 ticks, hive mobs within 48 blocks of a survival player standing at block
// light >= 11 + LUX tier get Slowness I for 5 s, and Weakness I where base attack_damage >= 6; tier 3 is immune.
// Mob effects only, particles hidden: nothing on any player's screen.

function pneHiveLightJob(srv) {
  var ps = pneCorePlayers(srv)
  var i
  var p
  var u
  var pos
  var light
  var kmax
  var k
  if (pneHiveLightAt === 0 && !pneCoreTake(PNE_CORE_COST.lightPass)) return
  for (i = pneHiveLightAt; i < ps.length; i++) {
    p = ps[i]
    pos = pneHivePos(p)
    light = pneHiveBlockLight(pneHiveLevel(p), pos)
    if (light < PNE_HIVE_LIGHT_MIN) continue
    u = pneCoreUuid(p)
    if (!u) continue
    kmax = light - PNE_HIVE_LIGHT_MIN
    if (kmax > 2) kmax = 2
    if (!pneCoreTake(2 * (kmax + 1) * PNE_CORE_COST.emit)) {
      pneHiveLightAt = i   // retried next tick from this player (contract 7.2)
      return
    }
    for (k = 0; k <= kmax; k++) {
      pneHiveCmd(srv, 'execute as ' + u + ' at @s run effect give @e[tag=pne_lux' + k + ',distance=..48] minecraft:slowness 5 0 true')
      pneHiveCmd(srv, 'execute as ' + u + ' at @s run effect give @e[tag=pne_lux' + k + ',tag=pne_wk,distance=..48] minecraft:weakness 5 0 true')
    }
    pneHiveStats.light++
  }
  pneHiveLightAt = 0
  pneHiveLightDue = false
}

// ---------------------------------------------------------------------------------------------
// GA work: dawn, outcomes, dream slices, breeding (never on slots 0 and 10)

function pneHiveSpPush(raw) {
  var sp = String(raw).replace(/[^a-z0-9_:.\/-]/g, '_')
  if (pneHiveSpRing.length < PNE_HIVE_SP_RING) pneHiveSpRing.push(sp)
  else {
    pneHiveSpRing[pneHiveSpHead] = sp
    pneHiveSpHead = (pneHiveSpHead + 1) % PNE_HIVE_SP_RING
  }
}

// Most common species among the recent engaged outcomes (the dawn dream's species context); ties -> lower id.
function pneHiveTopSpecies() {
  var c = {}
  var i
  var k
  var best = ''
  var bn = 0
  for (i = 0; i < pneHiveSpRing.length; i++) c[pneHiveSpRing[i]] = (c[pneHiveSpRing[i]] || 0) + 1
  for (k in c) {
    if (!c.hasOwnProperty(k)) continue
    if (c[k] > bn || (c[k] === bn && k < best)) {
      bn = c[k]
      best = k
    }
  }
  return best
}

function pneHivePlayersSeen(now) {
  var n = 0
  var k
  for (k in pneHivePids) {
    if (!pneHivePids.hasOwnProperty(k)) continue
    if (now - pneHivePids[k] <= PNE_HIVE_PIDS_WINDOW && now - pneHivePids[k] >= 0) n++
    else delete pneHivePids[k]
  }
  return n > 1 ? n : 1
}

// Dawn inputs (contract 3.7): deaths3d from the core's hive-death ring, target from config and the players seen,
// tDay = today's tactic evidence normalised to sum 1 (only buckets and rule scores: no arousal, no health, I2).
function pneHiveDawnInput(srv) {
  var now = pneCoreGameTime(srv)
  var sum = 0
  var td = []
  var i
  var ow = pneHiveOverworld(srv)
  for (i = 0; i < 5; i++) sum += pneHiveTDay[i]
  for (i = 0; i < 5; i++) td.push(sum > 0 ? pneHiveTDay[i] / sum : 0)
  return {
    deaths3d: pneCoreHiveDeathsAll(PNE_HIVE_DEATHS_3D),
    target: pneCoreCfg('gov_deaths') * pneHivePlayersSeen(now) * 3 / pneCoreCfg('gov_days'),
    tDay: td,
    stage: ow ? pneCoreStage(ow) : 0
  }
}

function pneHiveDawn(srv) {
  PNE_HIVE_GA.dawn(pneHiveSt, pneHiveDawnInput(srv))
  pneHiveTDay = [0, 0, 0, 0, 0]
  pneHiveApexAt = -1
  pneHiveSaveDue = true
  pneHiveStats.dawns++
}

function pneHiveDreamB(srv) {
  var ow = pneHiveOverworld(srv)
  return PNE_HIVE_GA.budget(ow ? pneCoreStage(ow) : 0, PNE_HIVE_GA.gov(pneHiveSt), false)
}

// GA work (contract 7.2). Each GA tick's own job comes first: the breed on breed ticks (t % 4 == 3), the dream slice on
// dream ticks (t % 4 == 1); either retries on the following ticks until it runs, one per tick, only while no drain is
// pending. Outcomes then use what is left on the odd ticks (never slots 0 and 10), charged their measured cost: one per
// tick, two while the outcome queue is more than half full. So a steady stream of outcomes never starves the breed or
// the dream, and the breed and the dream never starve the outcomes.
function pneHiveGaJob(srv, t, s, pending) {
  var GA = PNE_HIVE_GA
  var st = pneHiveSt
  var o
  var n
  var k
  if (t % 4 === 3) pneHiveBreedDue = true
  if (t % 4 === 1) pneHiveDreamDue = true
  if (s === PNE_CORE_SLOT_WRITE || s === PNE_CORE_SLOT_READ) return
  if (pneHiveDawnDue) {
    // the dawn is charged its own constant (PNE_HIVE_GA.dawn plus its inputs; contract 7.3 dawn row), not a breed
    if (pneCoreTake(pneHiveCost('dawn'))) {
      pneHiveDawnDue = false
      pneHiveDawn(srv)
    }
    return
  }
  if (!GA.dreamPending(st)) pneHiveDreamDue = false
  if (GA.queueSize(st) >= GA.QUEUE_MAX) pneHiveBreedDue = false
  if (!pending) {
    if (pneHiveBreedDue && (t % 4 === 3 || !pneHiveDreamDue)) {
      if (pneCoreTake(PNE_CORE_COST.breed)) {
        pneHiveBreedDue = false
        GA.breed(st)
        pneHiveStats.breeds++
      }
    } else if (pneHiveDreamDue) {
      if (pneCoreTake(PNE_CORE_COST.dreamSlice)) {
        pneHiveDreamDue = false
        GA.dreamSlice(st, GA.mask(pneHiveTopSpecies()), pneHiveDreamB(srv))
        pneHiveStats.dream++
        if (!GA.dreamPending(st)) pneHiveApexAt = -1
      }
    }
  }
  if (t % 2 !== 1 || !pneHiveOutQ.length) return
  n = pneHiveOutQ.length > PNE_HIVE_OUT_MAX / 2 ? 2 : 1
  for (k = 0; k < n && pneHiveOutQ.length; k++) {
    if (!pneCoreTake(pneHiveCost('outcome'))) return
    o = pneHiveOutQ.shift()
    GA.outcome(st, o.rec)
    pneHiveSpPush(o.sp)
    pneHiveApexAt = -1
    pneHiveStats.outcomes++
  }
}

// ---------------------------------------------------------------------------------------------
// Persistence (contract 4.1): server.persistentData.pne_hive
//   v (int), pool, queue, state, log (strings), samples.0..n (strings <= 48 KB), base (CompoundTag
//   ctxKey -> IntArray [dmg, engaged, team EMA x 1e6, count, LRU rank]), wid (world id), hv (runtime string:
//   day, today's tactic evidence, players seen, outcome species ring)

// The load epoch's salt (pneHiveLoad): 0..1023 from 10 random bits, the last hex digits of a random UUID (Math.random
// without the class).
function pneHiveEpochSalt() {
  var s = ''
  try { s = String($PneHiveUUID.randomUUID().toString()) } catch (e) { s = '' }
  s = s.length >= 3 ? s.substring(s.length - 3) : ''
  if (/^[0-9a-fA-F]{3}$/.test(s)) return parseInt(s, 16) & 1023
  return Math.floor(Math.random() * 1024) & 1023
}

function pneHiveNewWid() {
  var s = ''
  var h = ''
  var i
  try { s = String($PneHiveUUID.randomUUID().toString()) } catch (e) { s = '' }
  if (/^[0-9a-f-]{36}$/.test(s)) return s
  for (i = 0; i < 4; i++) h += ('0000000' + (Math.floor(Math.random() * 4294967296) >>> 0).toString(16)).slice(-8)
  return h.substring(0, 8) + '-' + h.substring(8, 12) + '-' + h.substring(12, 16) + '-' + h.substring(16, 20) + '-' + h.substring(20, 32)
}

function pneHiveRuntimeStr() {
  var pids = []
  var sp = []
  var names = []
  var idx = {}
  var k
  var i
  var j
  for (k in pneHivePids) {
    if (pneHivePids.hasOwnProperty(k) && /^[0-9a-f]{32}$/.test(k)) pids.push(k + ':' + Math.floor(pneHivePids[k]))
  }
  pids.sort()
  while (pids.length > 64) pids.pop()
  for (i = 0; i < pneHiveSpRing.length; i++) {
    j = (pneHiveSpRing.length < PNE_HIVE_SP_RING ? i : (pneHiveSpHead + i) % PNE_HIVE_SP_RING)
    k = pneHiveSpRing[j]
    if (!idx.hasOwnProperty(k)) {
      idx[k] = names.length
      names.push(k)
    }
    sp.push(idx[k])
  }
  return 'day=' + pneHiveDay + ';ep=' + pneHiveEpoch + ';td=' + [Math.round(pneHiveTDay[0] * 1000), Math.round(pneHiveTDay[1] * 1000),
    Math.round(pneHiveTDay[2] * 1000), Math.round(pneHiveTDay[3] * 1000), Math.round(pneHiveTDay[4] * 1000)].join(',') + ';pids=' + pids.join(',') +
    ';spn=' + names.join(',') + ';sp=' + sp.join('.')
}

// Reads the runtime string; returns the saved load epoch (0 when absent).
function pneHiveRuntimeLoad(s) {
  var kv = {}
  var parts = String(s || '').split(';')
  var i
  var j
  var a
  var names
  var v
  var ep = 0
  for (i = 0; i < parts.length; i++) {
    j = parts[i].indexOf('=')
    if (j > 0) kv[parts[i].substring(0, j)] = parts[i].substring(j + 1)
  }
  if (kv.day !== undefined && isFinite(Number(kv.day))) pneHiveDay = Math.floor(Number(kv.day))
  if (kv.ep !== undefined && isFinite(Number(kv.ep)) && Number(kv.ep) >= 0) ep = Math.floor(Number(kv.ep))
  if (kv.td !== undefined) {
    a = kv.td.split(',')
    if (a.length === 5) {
      for (i = 0; i < 5; i++) {
        v = Number(a[i]) / 1000
        pneHiveTDay[i] = isFinite(v) && v > 0 ? v : 0
      }
    }
  }
  if (kv.pids) {
    a = kv.pids.split(',')
    for (i = 0; i < a.length; i++) {
      j = a[i].indexOf(':')
      if (j === 32 && isFinite(Number(a[i].substring(33)))) pneHivePids[a[i].substring(0, 32)] = Number(a[i].substring(33))
    }
  }
  if (kv.spn !== undefined && kv.sp) {
    names = kv.spn.split(',')
    a = kv.sp.split('.')
    pneHiveSpRing = []
    pneHiveSpHead = 0
    for (i = 0; i < a.length && pneHiveSpRing.length < PNE_HIVE_SP_RING; i++) {
      v = Number(a[i])
      if (v >= 0 && v < names.length) pneHiveSpRing.push(names[v])
    }
  }
  return ep
}

// The saved object PNE_HIVE_GA.load expects, read from the pne_hive compound.
function pneHiveTagToSaved(tag) {
  var saved = { pool: pneHivePdStr(tag, 'pool'), queue: pneHivePdStr(tag, 'queue'), state: pneHivePdStr(tag, 'state'),
    log: pneHivePdStr(tag, 'log'), samples: [], base: [] }
  var n = 0
  var bt
  var keys
  var rows = []
  var i
  var a
  while (n < 64 && tag.contains('samples.' + n)) {
    saved.samples.push(String(tag.getString('samples.' + n)))
    n++
  }
  if (tag.contains('base')) {
    bt = tag.getCompound('base')
    keys = pneHiveKeys(bt)
    for (i = 0; i < keys.length; i++) {
      a = pneHiveJsInts(bt.getIntArray(keys[i]))
      if (a.length < 4) continue
      rows.push({ k: keys[i], v: a.length > 4 ? [a[0], a[1], a[2], a[3], a[4]] : [a[0], a[1], a[2], a[3]], r: a.length > 4 ? a[4] : i })
    }
    rows.sort(function (x, y) {
      if (x.r !== y.r) return x.r - y.r
      return x.k < y.k ? -1 : (x.k > y.k ? 1 : 0)
    })
    for (i = 0; i < rows.length; i++) saved.base.push({ k: rows[i].k, v: rows[i].v })
  }
  return saved
}

// A saved pne_hive the GA core cannot load is never overwritten: it is kept as the child pne_hive.prev (or, when it
// already carries one, that older child: the original memory) and every later save writes it along, until an admin
// runs /pne hive prev drop. The hive meanwhile starts a fresh pool.
function pneHiveKeepUnreadable(tag, why) {
  var msg = 'the saved hive state could not be loaded (' + why + '); starting a fresh pool and keeping the old one as pne_hive.prev ' +
    '(/pne hive prev drop discards it)'
  try { pneHivePrev = tag.contains('prev') ? tag.getCompound('prev') : tag } catch (e) { pneHivePrev = tag }
  try { console.error('[pne_hive] ' + msg) } catch (e2) { }
  pneCoreWarn('hive', 'load', msg, 1)
}

function pneHiveLoad(srv) {
  var spd = pneCorePD(srv)
  var tag = null
  var st = null
  var ep = 0
  var base
  pneHiveSeed = pneCoreSeed32(srv)
  pneHivePrev = null
  try {
    if (spd && spd.contains('pne_hive')) {
      tag = spd.getCompound('pne_hive')
      ep = pneHiveRuntimeLoad(pneHivePdStr(tag, 'hv'))
      pneHiveWid = pneHivePdStr(tag, 'wid')
      st = PNE_HIVE_GA.load(pneHiveTagToSaved(tag), pneHiveSeed)
      if (!st) pneHiveKeepUnreadable(tag, 'schema or format rejected by the GA core')
      else if (tag.contains('prev')) pneHivePrev = tag.getCompound('prev')
    }
  } catch (err) {
    st = null
    if (tag) pneHiveKeepUnreadable(tag, String(err))
    else pneCoreWarn('hive', 'load2', 'reading the saved hive state failed (' + err + '); starting a fresh pool', 1)
  }
  if (!st) st = PNE_HIVE_GA.newState(pneHiveSeed)
  // The new load epoch: above both the persisted counter and the epoch the GA state itself carries (PNE_HIVE_GA.epoch
  // takes max(ep, current + 1), so this is exactly what it will declare), plus a salt of 0..1023. A fresh or unreadable
  // state gets one too. The salt covers what a counter cannot: KubeJS writes server.persistentData to disk only when the
  // overworld saves, while a mob's pne_gi reaches disk whenever its chunk unloads, so after a crash before the first
  // world save that follows a load, the next load starts from the counter the lost run started from. Unsalted it would
  // declare the same epoch and, with the GA counters rolled back as well, reissue the lost run's ids; salted the two
  // epochs are equal only by chance: 1 in 1024 for each epoch the lost run declared after its last world save, and the
  // same again for a later load while the epoch is still below the lost one's (a load adds about 512 on average, so
  // rarely more than one). A /reload, or a restart after a clean stop, starts from a counter at or above every epoch
  // already used (see the recording below), so there the epoch is always new.
  base = ep
  if (PNE_HIVE_GA.ep(st) > base) base = PNE_HIVE_GA.ep(st)
  pneHiveEpoch = base + 1 + (base < PNE_HIVE_EP_MAX - 1024 ? pneHiveEpochSalt() : 0)
  pneHiveEpochDue = true
  if (!/^[0-9a-f-]{36}$/.test(pneHiveWid)) pneHiveWid = pneHiveNewWid()
  pneHiveSt = st
  pneHiveSaving = null
  // record the new epoch in the stored compound at once, so a /reload starts above it and the next world save writes it
  // even when no hive save comes first (from that world save on, a load after a crash starts above it too). With no
  // compound to take it (a fresh world, or an unreadable state kept whole as prev, which is never written) a save is due
  // at once instead; until it completes (a few seconds of free save slots) only the salt tells a /reload's epoch apart.
  if (tag && pneHivePrev !== tag) {
    try { tag.putString('hv', pneHiveRuntimeStr()) } catch (e) { }
  } else {
    pneHiveSaveDue = true
  }
}

// Declares the load epoch to the GA (an E event), on the first hive tick after every load: before any drain or GA work
// can generate an id, and after ServerEvents.loaded, so a load followed by a save with no hive tick in between (a quick
// restart) round-trips the GA state unchanged.
function pneHiveEpochApply() {
  if (!pneHiveEpochDue || !pneHiveSt) return
  pneHiveEpochDue = false
  pneHiveEpoch = PNE_HIVE_GA.epoch(pneHiveSt, pneHiveEpoch)
}

function pneHiveEnsureLoaded(srv) {
  if (pneHiveSt || pneHiveLoadTried) return
  pneHiveLoadTried = true
  pneHiveLoad(srv)
  pneHiveRediscStart(srv)
}

// Every save builds one new compound (a detached tag from getCompound of an absent key) and swaps it in with a single
// put, so an overworld autosave in between always sees a complete pne_hive; a save that is superseded or fails never
// writes anything. Two paths produce the saved form {pool, queue, state, samples, base, log} and the runtime string:
//   * incremental (every 6000 ticks, at dawn, at a switch-off): PNE_HIVE_GA.saveBegin, then one PNE_HIVE_GA.savePart per
//     free save slot, then PNE_HIVE_GA.saveEnd, which returns exactly what PNE_HIVE_GA.save returned at saveBegin
//     (copy on write), however the state changed in between;
//   * one call (pneHiveSave: server stop only): PNE_HIVE_GA.save.
// Both then write through pneHiveSaveWriter, pneHiveSaveBase and pneHiveSaveFinish, so they store identical compounds.

// Starts writing a finished saved form: the detached compound and its base compound (the write phase of every save).
function pneHiveSaveWriter(spd, sv, hv, st) {
  var tag = spd.getCompound('pne_hive_new')
  pneHiveSaving = { ph: 'nbt', st: st, spd: spd, sv: sv, tag: tag, bt: tag.getCompound('base'), i: 0, hv: hv }
  return true
}

// The one-call save's first step: PNE_HIVE_GA.save and the runtime string.
function pneHiveSaveBegin(srv) {
  var spd = srv ? pneCorePD(srv) : null
  if (!pneHiveSt || !spd) {
    pneHiveSaving = null
    return false
  }
  return pneHiveSaveWriter(spd, PNE_HIVE_GA.save(pneHiveSt), pneHiveRuntimeStr(), pneHiveSt)
}

function pneHiveSaveBase(n) {
  var sv = pneHiveSaving.sv
  var end = Math.min(sv.base.length, pneHiveSaving.i + n)
  var i
  var b
  for (i = pneHiveSaving.i; i < end; i++) {
    // [dmg, engaged, team EMA x 1e6, count, LRU rank]: the GA lists baselines least recently used first (and newer
    // GA versions add the rank themselves), because a CompoundTag gives its keys back in hash order
    b = sv.base[i]
    pneHiveSaving.bt.putIntArray(String(b.k), pneHiveIntArr([b.v[0], b.v[1], b.v[2], b.v[3], b.v.length > 4 ? b.v[4] : i]))
  }
  pneHiveSaving.i = end
  return end >= sv.base.length
}

function pneHiveSaveFinish() {
  var w = pneHiveSaving
  var i
  w.tag.putInt('v', PNE_HIVE_SCHEMA)
  w.tag.putString('pool', w.sv.pool)
  w.tag.putString('queue', w.sv.queue)
  w.tag.putString('state', w.sv.state)
  w.tag.putString('log', w.sv.log)
  for (i = 0; i < w.sv.samples.length; i++) w.tag.putString('samples.' + i, w.sv.samples[i])
  w.tag.put('base', w.bt)
  w.tag.putString('wid', pneHiveWid)
  w.tag.putString('hv', w.hv)
  if (pneHivePrev) w.tag.put('prev', pneHivePrev)
  w.spd.put('pne_hive', w.tag)
  pneHiveSaving = null
  pneHiveStats.saves++
  return true
}

// The one-call save (server stop: the last save before shutdown must be synchronous; also the tests' reference). It is
// newer than any incremental save still running, so that one is abandoned (its snapshot must never be written after
// this); its GA registration stays until the next saveBegin supersedes it, which costs nothing.
function pneHiveSave(srv) {
  pneHiveSaving = null
  if (!pneHiveSaveBegin(srv)) return false
  pneHiveSaveBase(PNE_HIVE_GA.CAP * 1000)
  pneHiveSaveDue = false
  return pneHiveSaveFinish()
}

// A free save slot: an even tick outside slots 0 and 10 (contract 7.2: the pool save sits on even ticks, so a save piece
// never shares its tick with a breed (t % 4 == 3), a dream slice (t % 4 == 1) or the outcomes (odd ticks), nor with the
// bridge I/O of slots 0 and 10).
function pneHiveSaveSlot(t, s) {
  return t % 2 === 0 && s !== PNE_CORE_SLOT_WRITE && s !== PNE_CORE_SLOT_READ
}

// An incremental save that was superseded (a newer PNE_HIVE_GA.saveBegin), failed, or belongs to a state that is no longer
// the live one starts over at the next free slot; nothing of it is ever written.
function pneHiveSaveRestart() {
  pneHiveSaving = null
  pneHiveSaveDue = true
  pneHiveStats.saveRestarts++
  return false
}

// First step of the incremental save: the GA snapshot (PNE_HIVE_GA.saveBegin, copy on write from here on) and the runtime
// string as of the same moment. Returns true when it began.
function pneHiveSaveStart(srv) {
  var spd = srv ? pneCorePD(srv) : null
  var ctx
  if (!pneHiveSt || !spd) return false
  ctx = PNE_HIVE_GA.saveBegin(pneHiveSt)
  if (!ctx) return false
  pneHiveSaving = { ph: 'ga', st: pneHiveSt, ctx: ctx, hv: pneHiveRuntimeStr(), spd: spd, n: 0 }
  pneHiveSaveDue = false
  return true
}

// One PNE_HIVE_GA.savePart piece of the running incremental save (pool, queue, state, each samples chunk, base in slices of
// 64 contexts, log). After the last piece, PNE_HIVE_GA.saveEnd (which then runs no part: it only hands back the result
// as of saveBegin) starts the write phase. A superseded context gives null from savePart and saveEnd: start over.
function pneHiveSavePart() {
  var w = pneHiveSaving
  var GA = PNE_HIVE_GA
  var sv
  if (w.st !== pneHiveSt) return pneHiveSaveRestart()
  if (!GA.saveDone(w.ctx)) {
    if (GA.savePart(w.ctx) === null) return pneHiveSaveRestart()
    w.n++
    pneHiveStats.saveParts++
    if (!GA.saveDone(w.ctx)) return true
  }
  sv = GA.saveEnd(w.ctx)
  if (!sv) return pneHiveSaveRestart()
  return pneHiveSaveWriter(w.spd, sv, w.hv, w.st)
}

// What one GA step of the incremental save is charged: a savePart piece PNE_CORE_COST.gaSavePart; the start also builds
// the runtime string (up to 64 players and the 400-entry species ring), one hive save step more (hive-rhino-bench:
// saveStart 0.37 ms p50 at the maximum state and tables, against 0.52 charged).
function pneHiveSaveStepCost() {
  return pneHiveSaving ? pneHiveCost('gaSavePart') : pneHiveCost('gaSavePart') + pneHiveCost('save')
}

// The GA half of the incremental save, early in the hive's tick: on a free save slot, one step (the start, or one
// savePart piece), charged pneHiveSaveStepCost; refused, it retries at the next free slot (contract 7.2). A step that
// throws starts the save over (never a partial write) and counts against the save breaker.
function pneHiveSaveGaJob(srv, t, s) {
  if (!pneHiveSaveSlot(t, s)) return
  if (pneHiveSaving && pneHiveSaving.ph !== 'ga') return
  if (!pneHiveSaving && !pneHiveSaveDue) return
  if (!pneHiveSt || !pneCoreTake(pneHiveSaveStepCost())) return
  try {
    if (!pneHiveSaving) pneHiveSaveStart(srv)
    else pneHiveSavePart()
  } catch (err) {
    pneHiveSaveRestart()
    throw err
  }
}

// The write half of every multi-tick save, late in the hive's tick: 16 base IntArrays per PNE_CORE_COST.save (up to 4
// steps a tick), then the swap (contract 7.2: fixed-schedule jobs retry until they run). The result is complete, so a
// failure here only starts the save over; the stored pne_hive is untouched until the swap.
function pneHiveSaveJob(srv) {
  var k
  var w = pneHiveSaving
  if (!w || w.ph !== 'nbt') return
  try {
    if (w.st !== pneHiveSt) {
      pneHiveSaveRestart()
      return
    }
    if (w.i < w.sv.base.length) {
      k = pneCoreTakeN(pneHiveCost('save'), Math.min(4, Math.ceil((w.sv.base.length - w.i) / PNE_HIVE_BASE_CHUNK)))
      if (k > 0) pneHiveSaveBase(k * PNE_HIVE_BASE_CHUNK)
      return
    }
    if (pneCoreTake(2 * pneHiveCost('save'))) pneHiveSaveFinish()
  } catch (err) {
    pneHiveSaveRestart()
    throw err
  }
}

// ---------------------------------------------------------------------------------------------
// Rediscovery after /reload or a pillar switch: genome mobs already in the world are re-adopted as rejoins

function pneHiveRediscStart(srv) {
  var list = null
  var n = 0
  try { list = srv.getEntities() } catch (e) { list = null }
  if (list) {
    try { n = Number(list.size()) } catch (e2) { n = 0 }
  }
  pneHiveRedisc = n > 0 ? { list: list, i: 0, n: n } : null
}

function pneHiveRediscJob() {
  var r = pneHiveRedisc
  var k
  var end
  var ent
  var s
  var pd
  var u
  var q
  if (!r) return
  k = pneCoreTakeN(PNE_CORE_COST.mobSample, Math.min(PNE_HIVE_REDISC_MAX, r.n - r.i))
  end = r.i + k
  for (; r.i < end; r.i++) {
    ent = null
    try { ent = r.list.get(r.i) } catch (e) { ent = null }
    if (!ent) continue
    s = ''
    try { s = String(ent.type) } catch (e2) { s = '' }
    if (!pneHiveIsParaId(s) || !pneHiveAlive(ent)) continue
    pd = pneCorePD(ent)
    if (!pd || pneHivePdStr(pd, 'pne_g').length !== 56) continue
    u = pneCoreUuid(ent)
    if (!u || (pneHiveMobs.hasOwnProperty(u) && !pneHiveRemoved(pneHiveMobs[u].mob))) continue
    q = pneHiveRejoinSet.hasOwnProperty(u) ? pneHiveRejoinSet[u] : null
    if (q) {
      // queued with an object that is gone by now: this live one takes its place
      if (pneHiveRemoved(q.mob)) q.mob = ent
      continue
    }
    if (pneHiveRejoinQ.length >= PNE_HIVE_Q_MAX) continue
    q = { mob: ent, u: u }
    pneHiveRejoinSet[u] = q
    pneHiveRejoinQ.push(q)
  }
  if (r.i >= r.n) pneHiveRedisc = null
}

// ---------------------------------------------------------------------------------------------
// Housekeeping: dawn detection, conversion buffer expiry, ledger pruning (the silent cap runs in the silent pass)

function pneHiveCheckDawn(srv) {
  var ow = pneHiveOverworld(srv)
  var day
  if (!ow) return
  day = Math.floor(pneHiveDayTime(ow) / 24000)
  if (pneHiveDay < 0) {
    pneHiveDay = day
    return
  }
  if (day > pneHiveDay) pneHiveDawnDue = true
  pneHiveDay = day
}

function pneHiveHouse(srv, now, s) {
  var i
  var k
  var L
  for (i = pneHiveConv.length - 1; i >= 0; i--) {
    if (pneHiveConv[i].used || now - pneHiveConv[i].t > PNE_HIVE_CONV_KEEP || now < pneHiveConv[i].t - PNE_HIVE_CONV_KEEP) pneHiveConv.splice(i, 1)
  }
  if (s === PNE_CORE_SLOT_HOUSE) pneHiveCheckDawn(srv)
  if (s === PNE_HIVE_PRUNE_SLOT) {
    for (k in pneHiveLedger) {
      if (!pneHiveLedger.hasOwnProperty(k)) continue
      L = pneHiveLedger[k]
      while (L.length && now - L[0].t > PNE_HIVE_KILL_WINDOW) L.shift()
      if (!L.length) delete pneHiveLedger[k]
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tick handler (contract 7.1: core -> oracle -> director -> hive -> visual)

function pneHiveRun(b, fn, a1, a2, a3, a4) {
  var r
  if (b.off) return undefined
  try {
    r = fn(a1, a2, a3, a4)
  } catch (err) {
    pneCoreFail(b, err)
    return undefined
  }
  pneCoreOk(b)
  return r
}

// Hive switched off (or its config set to 0): no hive work at all; tracked silent mobs become audible, queues are
// emptied (the startup producers stop on their own through global.pneOnHive).
function pneHiveOffTick(srv) {
  if (pneHiveSil.length) pneHiveUnsilenceAll(srv)
  if (pneHiveMobN || pneHiveNewQ.length || pneHiveRejoinQ.length) pneHiveClearRuntime()
  if (pneHiveQueueSize(pneHiveQDamage()) > 0) pneHiveQDamage().clear()
  if (pneHiveQueueSize(pneHiveQLeave()) > 0) pneHiveQLeave().clear()
}

function pneHiveOnTick(event) {
  var srv = event.server
  var t = pneCoreTick
  var s = pneCoreSlot
  var now
  var pending
  pneHiveTickNo++
  if (!pneHiveReady) return
  if (!pneCoreOn('hive')) {
    if (!pneHiveWasOff) {
      // just switched off (also by /pne config on_hive 0, which runs no toggle hook): keep the GA's progress
      pneHiveWasOff = true
      if (pneHiveSt) pneHiveSaveDue = true
    }
    pneHiveRun(PNE_HIVE_B_HOUSE, pneHiveOffTick, srv)
    // a save due or running still completes while the hive is off (the GA state no longer changes meanwhile)
    if (pneHiveSt && (pneHiveSaveDue || pneHiveSaving)) {
      pneHiveRun(PNE_HIVE_B_SAVE, pneHiveSaveGaJob, srv, t, s)
      if (pneHiveSaving) pneHiveRun(PNE_HIVE_B_SAVE, pneHiveSaveJob, srv)
    }
    return
  }
  if (!pneHiveSt) {
    pneHiveRun(PNE_HIVE_B_LOAD, pneHiveEnsureLoaded, srv)
    if (!pneHiveSt) return
  } else if (pneHiveWasOff) {
    // switched back on (by /pne hive on or /pne config): re-adopt the genome mobs already in the world
    pneHiveRun(PNE_HIVE_B_LOAD, pneHiveRediscStart, srv)
  }
  pneHiveWasOff = false
  // the load epoch, before anything below can generate a genome id
  if (pneHiveEpochDue) pneHiveRun(PNE_HIVE_B_LOAD, pneHiveEpochApply)
  now = pneCoreGameTime(srv)
  pneHiveSteerN = 0
  pneHiveSteerOn = pneCoreCfg('debug') === 1
  // fairness first: the silent pass (tells, the 3-block rule, the 30% cap) is never left the scraps of the tick
  if (!PNE_HIVE_B_SIL.off) {
    pneHiveRun(PNE_HIVE_B_SIL, pneHiveSilentJob, srv, now)
    if (PNE_HIVE_B_SIL.off) {
      // the silent pass was cut off: nobody may stay silent without tells
      pneHiveSilBroken = true
      try { pneHiveUnsilenceAll(srv) } catch (e) { }
    }
  }
  // the incremental pool save: one step per free save slot, before the drains so it always progresses (gaSavePart each)
  if (t % PNE_HIVE_SAVE_EVERY === PNE_HIVE_SAVE_AT) pneHiveSaveDue = true
  if (pneHiveSaveDue || pneHiveSaving) pneHiveRun(PNE_HIVE_B_SAVE, pneHiveSaveGaJob, srv, t, s)
  pending = pneHiveRun(PNE_HIVE_B_DRAIN, pneHiveDrains, srv, now)
  if (pending === undefined) pending = true
  // GA work before the samples: a breed never shares its tick with drains (TDD 3.7); samples take what is left
  pneHiveRun(PNE_HIVE_B_GA, pneHiveGaJob, srv, t, s, pending)
  if (t % PNE_HIVE_LIGHT_EVERY === PNE_HIVE_LIGHT_AT) pneHiveLightDue = pneCoreCfg('light_aversion') === 1
  if (pneHiveLightDue) pneHiveRun(PNE_HIVE_B_LIGHT, pneHiveLightJob, srv)
  pneHiveRun(PNE_HIVE_B_SAMPLE, pneHiveSampleJob, srv, now)
  pneHiveRun(PNE_HIVE_B_PLAYER, pneHivePlayerJob, srv, now)
  if (pneHiveSaving) pneHiveRun(PNE_HIVE_B_SAVE, pneHiveSaveJob, srv)
  pneHiveRun(PNE_HIVE_B_HOUSE, pneHiveHouse, srv, now, s)
  if (pneHiveRedisc) pneHiveRun(PNE_HIVE_B_DRAIN, pneHiveRediscJob)
}

// ---------------------------------------------------------------------------------------------
// Public API (contract 3.3). Other modules call these only through pneCoreHiveInfo / pneCoreHiveNear.

// HiveInfo (contract 3.3) plus flk: the expressed FLK gene (e[4], PNE_HIVE_GA.GENE_IDS index 4) as a number in [0, 1], the
// strength of the mob's flank bias (TDD 3.1: reinforcements and ambient spawns placed in the player's rear 120-degree arc
// at low block light). It is the value the hive applied at the mob's last expression (budget-scaled by stage and
// governor, combination caps applied, 0 where the species masks it); the hive's own tag pne_flk marks flk >= 0.5. A
// genome mob the hive does not track (yet) gets the same expression computed from its genome at the current stage.
function pneHiveInfo(entity) {
  var pd
  var g
  var u
  var rec
  var e
  var type
  var level
  var flk
  if (!pneHiveReady || !pneHiveSt || !entity) return null
  pd = pneCorePD(entity)
  if (!pd) return null
  g = pneHivePdStr(pd, 'pne_g')
  if (!PNE_HIVE_HEX_RX.test(g)) return null
  u = pneCoreUuid(entity)
  rec = u && pneHiveMobs.hasOwnProperty(u) ? pneHiveMobs[u] : null
  if (rec && rec.g === g && rec.e) {
    e = rec.e.slice(0)
  } else {
    type = pneCoreTypeId(entity)
    level = pneHiveLevel(entity)
    e = PNE_HIVE_GA.express(g, PNE_HIVE_GA.mask(type), PNE_HIVE_GA.budget(level ? pneCoreStage(level) : 0, PNE_HIVE_GA.gov(pneHiveSt), false))
  }
  flk = Number(e[4])
  if (!(flk > 0)) flk = 0
  if (flk > 1) flk = 1
  return {
    g: g, clade: PNE_HIVE_GA.clade(g), sil: rec ? rec.sil : pneHivePdByte(pd, 'pne_sil') === 1, apex: pneHiveIsApex(g),
    e: e, strain: pneCoreTypeId(entity).indexOf('spore:') === 0 ? 'spore' : 'epca', flk: flk
  }
}

// From the hive's own tables (no entity query): dominant clade among engaged genome mobs within 24 blocks (-1 none,
// ties -> lower clade), whether an apex genome is within 24, and how many silent-gene mobs within 12 have not
// attacked yet. O(1): the answer is the player's entry from the hive's per-player step (pneHiveNearUpdate, at most
// PNE_HIVE_NEAR_OLD ticks old); before the first entry, or when it is older, the neutral answer.
function pneHiveNear(player) {
  var u = pneCoreUuid(player)
  var c = u ? pneHiveNearCache[u] : null
  if (!c || !pneHiveSt || pneCoreTick - c.t > PNE_HIVE_NEAR_OLD || pneCoreTick < c.t) return { clade: -1, apex: false, silent: 0 }
  return { clade: c.v.clade, apex: c.v.apex, silent: c.v.silent }
}

// ---------------------------------------------------------------------------------------------
// Commands and status

function pneHiveStatusLine() {
  var GA = PNE_HIVE_GA
  var st = pneHiveSt
  if (!pneHiveReady) return 'GA core missing: the hive stays off'
  if (!pneCoreOn('hive')) return 'off'
  if (!st) return 'not loaded yet'
  return 'pool ' + GA.poolSize(st) + '/' + GA.CAP + ', gen ' + GA.gen(st) + ', gov ' + pneCoreFmt(GA.gov(st)) + ', sigma ' +
    pneCoreFmt(GA.sigma(st)) + ', queue ' + GA.queueSize(st) + '/' + GA.QUEUE_MAX + (GA.dreamPending(st) ? ', dreaming' : '') +
    ', tracked ' + pneHiveMobN + ', silent ' + pneHiveSil.length + (pneHivePrev ? ', unreadable old state kept (pne_hive.prev)' : '')
}

// /pne hive prev [drop] (admin): whether an unreadable saved state is being kept as pne_hive.prev, and discarding it.
function pneHiveCmdPrev(ctx) {
  var a0 = ctx.args.length ? String(ctx.args[0]).toLowerCase() : ''
  var a1 = ctx.args.length > 1 ? String(ctx.args[1]).toLowerCase() : ''
  if (a0 !== 'prev' || ctx.args.length > 2 || (a1 !== '' && a1 !== 'drop')) return false
  if (!pneHivePrev) {
    ctx.reply('hive: no unreadable old state is kept', 'gray')
    return true
  }
  if (a1 !== 'drop') {
    ctx.reply('hive: an unreadable old state is kept as pne_hive.prev (' + pneHiveKeys(pneHivePrev).length + ' tags); /pne hive prev drop discards it at the next save', 'gold')
    return true
  }
  pneHivePrev = null
  pneHiveSaveDue = true
  ctx.reply('hive: the old state will be discarded at the next save', 'gold')
  return true
}

function pneHiveCmdHive(ctx) {
  var GA = PNE_HIVE_GA
  var te
  var i
  var parts = []
  if (ctx.args.length !== 1 || String(ctx.args[0]).toLowerCase() !== 'status') return false
  ctx.reply('hive: ' + pneHiveStatusLine(), 'gold')
  if (pneHiveReady && pneHiveSt) {
    te = GA.tEst(pneHiveSt)
    for (i = 0; i < GA.TACTICS.length; i++) parts.push(GA.TACTICS[i] + ' ' + pneCoreFmt(te[i]))
    ctx.reply('T_est ' + parts.join(', ') + '; hypermutation ' + GA.hyper(pneHiveSt) + '; newborns ' + pneHiveStats.joins +
      ' (linked ' + pneHiveStats.links + ', backstop ' + pneHiveStats.backstop + '), outcomes ' + pneHiveStats.outcomes +
      ', governor steps ' + pneHiveStats.gov + ', tells ' + pneHiveStats.tells, 'gray')
    ctx.reply('queues: damage ' + pneHiveQueueSize(pneHiveQDamage()) + ', leave ' + pneHiveQueueSize(pneHiveQLeave()) + ', newborn ' +
      pneHiveNewQ.length + ', rejoin ' + pneHiveRejoinQ.length + ', outcomes ' + pneHiveOutQ.length + ' (dropped ' + pneHiveStats.outDropped +
      '); saves ' + pneHiveStats.saves + (pneHiveStats.saveRestarts ? ' (restarted ' + pneHiveStats.saveRestarts + ')' : '') +
      (pneHiveSaving ? ', one in progress' : '') + '; epoch ' + pneHiveEpoch + '; light passes ' + pneHiveStats.light + '; SCT steering ' +
      (pneCoreCfg('debug') !== 1 ? 'off (debug 0: SCT tag-only; FLK is never steered)' : (pneHiveNav === 1 ? 'on (' + pneHiveStats.steer + ' moves)' :
        (pneHiveNav === 0 ? 'unavailable (tags only)' : 'untested'))), 'gray')
  }
  return true
}

function pneHiveOnToggle(on, srv) {
  if (!pneHiveReady) return
  if (!on) {
    // keep the GA's progress since the last save: an incremental save, which the off ticks complete (the GA state does
    // not change while the hive is off)
    if (pneHiveSt && !pneHiveWasOff) pneHiveSaveDue = true
    pneHiveWasOff = true
    pneHiveUnsilenceAll(srv)
    pneHiveClearRuntime()
    return
  }
  if (pneHiveSt) pneHiveRediscStart(srv)
}

// ---------------------------------------------------------------------------------------------
// Event handlers (each O(1), each catching its own errors; spawned is never cancelled)

function pneHiveOnDeath(event) {
  var ent = event.entity
  var s = ''
  var u
  try { s = String(ent.type) } catch (e) { s = '' }
  if (!pneHiveIsParaId(s)) return
  u = pneCoreUuid(ent)
  if (u && pneHiveMobs.hasOwnProperty(u)) pneHiveMobs[u].cause = pneCoreDeathCause(event.source)
}

function pneHiveOnPlaced(event) {
  var id = ''
  var ent = null
  var u
  try { id = String(event.getBlock().getId()) } catch (e) { id = '' }
  if (!PNE_HIVE_LIGHT_RX.test(id)) return
  try { ent = event.getEntity() } catch (e2) { ent = null }
  if (!ent || !pneCoreIsPlayer(ent)) return
  u = pneCoreUuid(ent)
  if (u) pneHiveTorch[u] = (pneHiveTorch[u] || 0) + 1
}

if (!pneHiveCoreOk) console.error('[pne_hive] pne_00_core.js did not load; the hive runtime stays off')
if (pneHiveCoreOk && !pneHiveReady) console.error('[pne_hive] pne_hive_core.js (PNE_HIVE_GA) did not load; the hive stays off (no genomes, no telemetry, no backstop)')
if (pneHiveCoreOk && !pneHiveReady) {
  EntityEvents.spawned(function (event) {
    if (PNE_HIVE_B_EVENTS.off) return
    try {
      pneHiveFallbackSpawned(event.entity)
    } catch (err) {
      pneCoreFail(PNE_HIVE_B_EVENTS, err)
    }
  })
  pneCoreStatus('hive', pneHiveStatusLine)
}
if (pneHiveReady) {
  ServerEvents.loaded(function (event) {
    try {
      if (pneCoreOn('hive')) pneHiveEnsureLoaded(event.server)
    } catch (err) {
      pneCoreFail(PNE_HIVE_B_LOAD, err)
    }
  })
  ServerEvents.unloaded(function (event) {
    try {
      // the last save before shutdown must be synchronous: the one-call save (it abandons an incremental save still
      // running). Whatever the switch says: a state loaded this run is the newest there is (with the hive off it is unchanged)
      if (pneHiveSt) pneHiveSave(event.server)
    } catch (err) {
      pneCoreFail(PNE_HIVE_B_SAVE, err)
    }
  })
  ServerEvents.tick(pneHiveOnTick)
  EntityEvents.spawned(function (event) {
    if (PNE_HIVE_B_EVENTS.off) return
    try {
      if (pneCoreOn('hive')) pneHiveOnSpawned(event.entity)
    } catch (err) {
      pneCoreFail(PNE_HIVE_B_EVENTS, err)
    }
  })
  EntityEvents.death(function (event) {
    if (PNE_HIVE_B_EVENTS.off) return
    try {
      if (pneCoreOn('hive')) pneHiveOnDeath(event)
    } catch (err) {
      pneCoreFail(PNE_HIVE_B_EVENTS, err)
    }
  })
  BlockEvents.placed(function (event) {
    if (PNE_HIVE_B_EVENTS.off) return
    try {
      if (pneCoreOn('hive')) pneHiveOnPlaced(event)
    } catch (err) {
      pneCoreFail(PNE_HIVE_B_EVENTS, err)
    }
  })
  pneCoreCommand('hive', { run: pneHiveCmdHive, help: 'hive status: pool size, generation, governor, sigma, queue' })
  pneCoreCommand('hive', { run: pneHiveCmdPrev, help: 'hive prev [drop]: an unreadable old hive state kept as pne_hive.prev', admin: true })
  pneCoreStatus('hive', pneHiveStatusLine)
  pneCoreOnToggle('hive', pneHiveOnToggle)
}
