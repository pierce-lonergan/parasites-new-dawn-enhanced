// priority: 70
// Parasites New Dawn - Enhanced :: The Hive Remembers, dread director and sound ledger (server side)
//
// What this file does (docs/IMPLEMENTATION.md 3.2, 3.2.1, 4, 6.3, 7; docs/TDD.md 2.3-2.5, 2.7):
//   1. Pacing FSM per survival player (CALM, UNEASE, DREAD, PANIC, RELEASE), driven once per second by the
//      fused arousal estimate e: the Oracle's E_O when its verdict is fresh and confident, blended toward the
//      heuristic S_H below conf 0.45 (TDD 2.5.1). Asymmetric EMA (tau up 2 s, down 6 s), holds, 8 s dwell,
//      hard triggers, 45 s PANIC cap, 30/60 s RELEASE (TDD 2.5.3, the measured prototype table).
//   2. Audio intensity controller (QUIET, UNEASE, DREAD) from threat context theta only; arousal, PANIC,
//      RELEASE, mercy and grace can only lower it (TDD 2.5.4, invariant I4).
//   3. Pacing outputs: spawn and aggression multipliers, beckons, GA weight (TDD 2.5.5), published as the
//      cached Pace (pneResPace), player.persistentData.pne_m / pne_m_t, and the tags pne_gate and
//      pne_pace_soft (contract 3.2). The multipliers per state and the hourly death governor come from the active
//      difficulty profile (contract 1.5: the core's PNE_CORE_DIFF row, pneCoreDiffId(); Hard is PNE_RES_PACING and
//      the 1.4 governor exactly, lead decision L5), so the natural-spawn gate (pne_m) follows the profile too.
//   4. The sound ledger (pneResEmit / pneResEmitAt): every horror sound for a player, old or new, passes
//      per-player switches, comfort rules, A8 LF exclusivity and duty, the level-jump limit, the -18 LU bus
//      ceiling and the per-minute budget, using the L_eff model of TDD 2.3.4 (distance, volume, the event's own
//      sounds.json volume and attenuation distance, and the server-side /playsound range check).
//   5. The Resonance layers L1-L7 from the generated catalog PNE_RES_CATALOG (may be empty or missing: then no
//      layers play and pneResTell returns false), with shuffle bags, jittered hazards, L0 Hush rules, positional
//      placement, and the PANIC drain by scheduling. PANIC and RELEASE keep their overrides under mercy and
//      grace; mercy and grace then also remove L2, L3, L4, L6 and L7 (the ledger enforces all three as well).
//   6. /pne comfort, /pne audio, /pne resonance whispers|throb|approach|stingers|self|status, the first-run
//      notice (tellraw only), and the /pne status line.
//
// Comfort (hard constraint, I8): audio only. Nothing here touches the camera, effects or the screen. Comfort
// mode is ON for every player unless that player opted out (tag pne_comfort_off).
// Start gating (contract 1.5, Appendix A rule 15): no command before the server has started (pneCoreStarted, set by
// the core's first tick): the ledger refuses to issue, and tellraw, probes and stopsound are skipped until then.
// Rhino rules: ES5 only, every var at the top of its function, values from Java converted with String() or
// Number() before use, Mojang/KubeJS member names only, every handler in try/catch with a breaker.
//
// Design values this file adds where the TDD leaves a number open (reported to the lead, easy to change):
//   PNE_RES_FLOOR (-32 LU)  the quiet reference the level-jump rule measures rises from when nothing plays
//                           (3 dB under the AmbientSounds bed median of -29 LUFS, TDD 2.3.3);
//   L4 hazard (mean 60 s, floor 30 s), L6 hazard (mean 150 s, floor 90 s), DREAD LF hazard (mean 20 s) and
//   PANIC heartbeat hazard (mean 8 s) after the A3 cooldowns; QUIET bed runs of 2-5 segments followed by a
//   silence of at least half the run (L0 a, also under mercy/grace and in RELEASE); in comfort mode at most 2
//   onsets in any 1 s (the comfort envelope rule at the schedule level: no onset train above 2 Hz); Resonance
//   onsets at least 2 s after any other onset (TDD 1 data flows), beds excepted (pack sounds are never spaced);
//   A1's "half its pool" as h = max(min(4, n - 2), ceil(n / 2)) other picks between replays; the PANIC stinger
//   only on a snapshot line-of-sight report (probe sensing has none); a budget-refused probe reuses a reading at
//   most 3 s old, else the step is skipped.

var PNE_RES_API = 1
var pneResReady = typeof PNE_CORE_API === 'number' && PNE_CORE_API >= 1
var PNE_RES_B_TICK = pneResReady ? pneCoreBreaker('resonance.tick', 5, 'consecutive') : null
var PNE_RES_B_EVENTS = pneResReady ? pneCoreBreaker('resonance.events', 20, 'total') : null
var PNE_RES_B_CMD = pneResReady ? pneCoreBreaker('resonance.commands', 20, 'total') : null

// ---------------------------------------------------------------------------------------------
// Pure core: pacing FSM, signal fusion, audio tier controller, pacing outputs.
// tools/director/director.py is a line-for-line Python port (suite director-parity).

var PNE_RES_STATES = ['CALM', 'UNEASE', 'DREAD', 'PANIC', 'RELEASE']
var PNE_RES_TIERS = ['QUIET', 'UNEASE', 'DREAD']
var PNE_RES_FSM = {
  aUp: 0.3934693402873666,     // 1 - exp(-1/2): tau up 2 s (literal, so Node, Rhino and Python agree bit for bit)
  aDown: 0.15351827510938587,  // 1 - exp(-1/6): tau down 6 s
  up: [0.25, 0.50, 0.75],      // CALM->UNEASE, UNEASE->DREAD, DREAD->PANIC
  down: [0.15, 0.38, 0.60],    // UNEASE->CALM, DREAD->UNEASE, PANIC->RELEASE
  upHold: [3, 3, 2],
  downHold: [20, 10, 4],
  minDwell: 8,
  panicMax: 45,
  releaseMin: 30,
  releaseLong: 60,
  releaseReenter: 10,
  panicWindow: 600,
  panicCount: 3,
  lowConf: 0.45,
  eCeil: 0.60
}
// The Hard pacing table of release 1.4 (TDD 2.5.5) and the Hard hourly governor. Contract 1.5 moves the tables per
// difficulty profile into the core (PNE_CORE_DIFF[id].pace and .gov1h, whose Hard row equals these); the director reads
// the row for the profile id and uses these two only when the core's table is absent.
var PNE_RES_PACING = {
  CALM: { spawn: 1.25, aggro: 1.0, beckon: true, ga: 1.0 },
  UNEASE: { spawn: 1.10, aggro: 1.0, beckon: true, ga: 1.0 },
  DREAD: { spawn: 0.80, aggro: 1.0, beckon: false, ga: 1.0 },
  PANIC: { spawn: 0.00, aggro: 0.9, beckon: false, ga: 0.5 },
  RELEASE: { spawn: 0.20, aggro: 0.8, beckon: false, ga: 0.0 }
}
var PNE_RES_GOV1H = { floor: 0.50, slope: 0.15, free: 1 }
var PNE_RES_TIER_UP = [0.25, 0.50]
var PNE_RES_TIER_DOWN = [0.15, 0.38]
var PNE_RES_TIER_UP_HOLD = 3
var PNE_RES_TIER_DOWN_HOLD = 10

function pneResFsmNew() {
  return { state: 'CALM', e: 0, inState: 0, above: 0, below: 0, t: 0, panics: [], releaseLen: 30 }
}

function pneResTierNew() {
  return { tier: 0, up: 0, dn: 0 }
}

// e_raw = w * E_O + (1 - w) * S_H with w = min(1, conf / 0.45) when the verdict is fresh, else 0 (TDD 2.5.1).
function pneResFuse(inp) {
  var w = 0
  if (inp.fresh) w = Math.min(1, inp.conf / PNE_RES_FSM.lowConf)
  return w * inp.eo + (1 - w) * inp.sh
}

// Hard trigger: hostile within 4 blocks and damaged within 1 s, or P(flee) >= 0.6 with a hostile within 8.
function pneResHard(inp) {
  return (inp.nearest < 4 && inp.tsd <= 1) || (inp.pflee >= 0.6 && inp.nearest < 8)
}

// One 1 Hz FSM step (TDD 2.5.3). d is mutated; returns the hard-trigger flag.
function pneResFsmStep(d, inp) {
  var C = PNE_RES_FSM
  var s = d.state
  var next = s
  var raw
  var hard
  var lvl
  var recent
  var i
  d.t += 1
  d.inState += 1
  raw = pneResFuse(inp)
  d.e = d.e + (raw - d.e) * (raw > d.e ? C.aUp : C.aDown)
  hard = pneResHard(inp)
  if (s === 'PANIC') {
    d.below = d.e < C.down[2] ? d.below + 1 : 0
    if ((d.below >= C.downHold[2] && d.inState >= C.minDwell) || d.inState >= C.panicMax) next = 'RELEASE'
  } else if (s === 'RELEASE') {
    if (hard && d.inState >= C.releaseReenter && d.e >= C.up[2]) next = 'PANIC'
    else if (d.inState >= d.releaseLen && d.e < C.up[1]) next = d.e >= C.up[0] ? 'UNEASE' : 'CALM'
  } else {
    lvl = s === 'CALM' ? 0 : (s === 'UNEASE' ? 1 : 2)
    d.above = d.e >= C.up[lvl] ? d.above + 1 : 0
    d.below = (lvl > 0 && d.e < C.down[lvl - 1]) ? d.below + 1 : 0
    if (hard && lvl >= 1) next = 'PANIC'
    else if (d.above >= C.upHold[lvl] && d.inState >= C.minDwell) next = PNE_RES_STATES[lvl + 1]
    else if (lvl > 0 && d.below >= C.downHold[lvl - 1] && d.inState >= C.minDwell) next = PNE_RES_STATES[lvl - 1]
  }
  if (next !== s) {
    if (next === 'PANIC') {
      d.panics.push(d.t)
      recent = 0
      for (i = 0; i < d.panics.length; i++) {
        if (d.t - d.panics[i] <= C.panicWindow) recent++
      }
      d.releaseLen = recent >= C.panicCount ? C.releaseLong : C.releaseMin
    }
    d.state = next
    d.inState = 0
    d.above = 0
    d.below = 0
  }
  while (d.panics.length && d.t - d.panics[0] > C.panicWindow) d.panics.shift()
  return hard
}

// Audio tier from theta only: QUIET -> UNEASE at theta >= 0.25 held 3 s, UNEASE -> DREAD at >= 0.50 held 3 s;
// back down after 10 s below 0.15 / 0.38 (TDD 2.5.4).
function pneResTierStep(a, theta) {
  a.up = (a.tier < 2 && theta >= PNE_RES_TIER_UP[a.tier]) ? a.up + 1 : 0
  a.dn = (a.tier > 0 && theta < PNE_RES_TIER_DOWN[a.tier - 1]) ? a.dn + 1 : 0
  if (a.up >= PNE_RES_TIER_UP_HOLD) {
    a.tier += 1
    a.up = 0
  } else if (a.dn >= PNE_RES_TIER_DOWN_HOLD) {
    a.tier -= 1
    a.dn = 0
  }
  return a.tier
}

// Ceilings and overrides in TDD order; each can only lower the tier. PANIC is a layer override (A5), not a
// tier change. Returns the tier index after the caps.
function pneResTierCap(raw, e, state, mercy, grace) {
  var t = raw
  if (e > PNE_RES_FSM.eCeil && t > 1) t = 1
  if (state === 'RELEASE') t = 0
  if (mercy || grace) t = 0
  return t
}

// Pacing outputs (TDD 2.5.5). Mercy and grace override any state; the hourly death governor scales spawns:
// x max(floor, 1 - slope * max(0, hive-caused deaths in the last real hour - free)).
// P is the difficulty profile row (contract 1.5: pneCoreDiff(), or PNE_CORE_DIFF[id] for an explicit id): P.pace[state]
// gives spawn, aggro, beckon and ga, P.gov1h the governor { floor, slope, free }. Without P (or when the row lacks
// them) the Hard values of release 1.4 apply: PNE_RES_PACING and max(0.5, 1 - 0.15 * max(0, deaths - 1)). Mercy and
// grace are the same in every profile.
function pneResPaceOut(state, mercy, grace, deaths1h, P) {
  var p = (P && P.pace && P.pace[state]) ? P.pace[state] : PNE_RES_PACING[state]
  var g = (P && P.gov1h) ? P.gov1h : PNE_RES_GOV1H
  var spawn = p.spawn
  var aggro = p.aggro
  var beckon = p.beckon
  var ga = p.ga
  var gov
  if (mercy || grace) {
    spawn = 0
    aggro = Math.min(aggro, 0.8)
    beckon = false
    ga = 0
  }
  gov = Math.max(g.floor, Math.min(1, 1 - g.slope * Math.max(0, deaths1h - g.free)))
  spawn = spawn * gov
  return { spawn: spawn, aggro: aggro, beckon: beckon, ga: ga, gov: gov }
}

// The profile id of a pure-step input: inp.diff 0..3 (0 Peaceful, 1 Easy, 2 Normal, 3 Hard), 3 when absent or invalid.
function pneResDiffIn(v) {
  var n
  if (v === undefined || v === null) return 3
  n = Number(v)
  return (n >= 0 && n <= 3) ? Math.floor(n) : 3
}

// The core's row for profile id (read-only, shared: never modified here), or null without the core's table (then
// pneResPaceOut uses the Hard values).
function pneResDiffRow(id) {
  if (typeof PNE_CORE_DIFF === 'undefined' || !PNE_CORE_DIFF) return null
  return PNE_CORE_DIFF[pneResDiffIn(id)] || null
}

// The live profile id (pneCoreDiffId: the /pne config diff_profile pin, else the last vanilla read; 3 before it).
function pneResDiffNow() {
  var d = 3
  if (typeof pneCoreDiffId !== 'function') return 3
  try { d = pneCoreDiffId() } catch (e) { d = 3 }
  return pneResDiffIn(d)
}

// One full pure step. st = { fsm, tier }; inp = { eo, conf, fresh, sh, theta, nearest, tsd, pflee, mercy, grace,
// deaths1h, diff }, diff = the difficulty profile id (default 3, Hard). Returns everything the parity test compares.
function pneResPureStep(st, inp) {
  var hard = pneResFsmStep(st.fsm, inp)
  var raw = pneResTierStep(st.tier, inp.theta)
  var tier = pneResTierCap(raw, st.fsm.e, st.fsm.state, inp.mercy, inp.grace)
  var p = pneResPaceOut(st.fsm.state, inp.mercy, inp.grace, inp.deaths1h, pneResDiffRow(inp.diff))
  return {
    state: st.fsm.state, e: st.fsm.e, hard: hard, raw: raw, tier: tier,
    spawn: p.spawn, aggro: p.aggro, beckon: p.beckon, ga: p.ga, gov: p.gov
  }
}

// ---------------------------------------------------------------------------------------------
// Ledger constants

// In the Rhino fork that KubeJS 2001.6.5 ships, Math.LN10, Math.LN2, Math.E and Math.PI are undefined (measured
// with the instance's jar); Math.log works, so the constant is computed once.
var PNE_RES_LN10 = Math.log(10)
var PNE_RES_FLOOR_PW = Math.pow(10, -3.2)   // linear power of PNE_RES_FLOOR (-32 LU)
var PNE_RES_FLOOR = -32            // LU: quiet reference for the level-jump rule (see the header)
var PNE_RES_BUS_MAX = -18          // LU: bus ceiling (A4)
var PNE_RES_BUS_ATT = 6            // dB: newcomers may be attenuated this much to fit the ceiling or budget
var PNE_RES_JUMP = { normal: 10, comfort: 6 }         // LU per window
var PNE_RES_JUMP_WIN = { normal: 60, comfort: 40 }    // ticks (3 s / 2 s)
var PNE_RES_JUMP_ATT = 10.46       // dB: largest level-jump attenuation (volume factor 0.3), else refuse
// s: a Resonance file shorter than this has no in-file rise for V15 to grade (the 400 ms windows after its onset
// fade span < 0.1 s once the fade reaches 0.1 s, the largest short-layer fade), so the level-jump rule takes its
// catalog mmax as the onset step instead of its lufs (contract 5, 1.2; covers tell.a v01/v04 and whisper.near v06,
// plus the other tells, conservatively; suite director-ledger-sim checks the manifest's set is covered)
var PNE_RES_SHORT_S = 0.6
var PNE_RES_STING_ABOVE = 18       // LU above the trailing 3 s short-term level (normal stingers)
var PNE_RES_MINUTE = { normal: -27, comfort: -30 }    // LU, Resonance-only per-minute budget
var PNE_RES_LF = {
  normal: { inst: 200, rest: 2, duty: 1200 },         // <= 10 s per instance, rest >= 2x, <= 60 s LF per 10 min
  comfort: { inst: 160, rest: 4, duty: 600 }          // <= 8 s, rest >= 4x, <= 30 s per 10 min
}
var PNE_RES_LF_WINDOW = 12000      // ticks (10 min)
var PNE_RES_LF_COMFORT_OK = { heartbeat_c: true, hive_heartbeat: true, slam: true }
var PNE_RES_CLS_MIN = { hive_heartbeat: { normal: 700, comfort: 1400 } }   // Hive Night heartbeat >= 35 s / 70 s
var PNE_RES_COMFORT_VOL = { slam: 0.5, bell: 0.5, beckon: 0.5, beckon2: 0.5 }
var PNE_RES_SLAM_GAP = 200         // ticks: comfort slams never within 10 s of another LF source; L2/L3 wait 10 s
var PNE_RES_COMFORT_RATE = 2       // comfort: at most 2 onsets in any 1 s, so the schedule never pulses above 2 Hz
var PNE_RES_SPACING = 40           // ticks (2 s): Resonance onsets after any other onset (beds excepted)
var PNE_RES_STING_COOL = 3600      // ticks: L7 at most once per 180 s
var PNE_RES_STING_GAP = 400        // ticks: never within 20 s of another stinger
var PNE_RES_EYE = 1.62             // eye height above the feet (blocks)
var PNE_RES_FADE = { L1: 30, L2: 80, L3: 60, L4: 80 }  // shortest baked fade-out per drained layer (ticks)
var PNE_RES_PANIC_OFF = { L1: true, L2: true, L4: true, L5: true }   // A5 (plus L3 flutter/rough)
var PNE_RES_VULN_OFF = { L2: true, L3: true, L4: true, L6: true, L7: true }   // TDD 2.5.4 mercy/grace row
var PNE_RES_RELEASE_HUSH = 200     // ticks: RELEASE starts with 10 s of silence (L0 c)
var PNE_RES_SENSE_STALE = 60       // ticks: a refused probe reuses a complete reading at most this old
var PNE_RES_NOTICE_V = 1

// Measured external events (tools/director/trims.py; tools/director/data/external_levels.json). Per variant
// [integrated LUFS, max momentary LUFS, sounds.json volume after the pack's trims]; dur in seconds (longest
// variant, at the event's own lowest pitch); att = attenuation_distance. Kept as one strict-JSON line so
// trims.py check can compare it with the table.
var PNE_RES_EXTERNAL = {"epca:beckon_stage1": {"att": 16, "dur": 12.149, "lf": false, "v": [[-18.52, -10.78, 0.69]]}, "epca:beckon_stage2": {"att": 16, "dur": 6.322, "lf": false, "v": [[-15.38, -8.25, 0.51]]}, "epca:infested_enderman_scream": {"att": 16, "dur": 1.385, "lf": false, "v": [[-18.52, -16.75, 0.84], [-20.9, -18.45, 1.0], [-18.73, -16.81, 0.86], [-20.53, -19.01, 1.0]]}, "epca:slam": {"att": 16, "dur": 3.986, "lf": true, "v": [[-15.86, -11.84, 0.62], [-16.02, -12.07, 0.63], [-17.06, -12.45, 0.71], [-15.34, -11.59, 0.58]]}, "minecraft:block.bell.use": {"att": 16, "dur": 2.68, "lf": false, "v": [[-33.35, -27.67, 12.0], [-32.4, -26.91, 12.0]]}, "minecraft:entity.slime.squish_small": {"att": 16, "dur": 0.375, "lf": false, "v": [[-26.33, -26.33, 1.0], [-21.46, -21.46, 1.0], [-24.68, -24.68, 1.0], [-22.45, -22.45, 1.0], [-21.03, -21.03, 1.0]]}, "spore:heart_beat": {"att": 16, "dur": 2.94, "lf": true, "v": [[-25.76, -22.66, 1.0]]}}
var PNE_RES_UNKNOWN = { att: 16, dur: 4, lf: false, v: [[-18, -12, 1]] }   // conservative defaults

// Per-layer switch tags (contract 4.2)
var PNE_RES_TAG_OFF = 'pne_res_off'
var PNE_RES_TAG_SW = {
  whispers: 'pne_res_no_whispers', throb: 'pne_res_no_throb', approach: 'pne_res_no_approach', stingers: 'pne_res_no_stingers'
}

// ---------------------------------------------------------------------------------------------
// Module state (memory only; /reload starts fresh, which is fine for pacing and bags)

var pneResP = {}          // uuid -> per-player state
var pneResCatIdx = null   // catalog index, built on first use
var pneResNoticeQ = []    // { u: uuid, at: tick }
var pneResStats = { issued: 0, refused: 0, stopped: 0, tells: 0, why: {} }

function pneResNum(v, dflt) {
  var n
  if (v === undefined || v === null) return dflt
  n = Number(v)
  return isFinite(n) ? n : dflt
}

// Contract 1.5, Appendix A rule 15 (a): no command before the server has started. pneCoreStarted is false after
// ServerEvents.loaded and after /reload until the core's next tick handler (which runs first) sets it; a core without
// the flag (before contract 1.5) counts as started.
function pneResStarted() {
  return typeof pneCoreStarted !== 'boolean' || pneCoreStarted === true
}

function pneResDb(g) {
  return g > 0 ? 20 * Math.log(g) / PNE_RES_LN10 : -120
}

function pneResPowSum(a, b) {
  var p = 0
  if (a > -119) p += Math.pow(10, a / 10)
  if (b > -119) p += Math.pow(10, b / 10)
  return p > 0 ? 10 * Math.log(p) / PNE_RES_LN10 : -120
}

// ---------------------------------------------------------------------------------------------
// Catalog (contract 5). Pools are built from the events themselves (layer + cls), so the pools key format
// does not matter. Stereo beds (amb: true) are never issued by the director.

function pneResCatReset() {
  pneResCatIdx = null
  pneResInfoCache = {}
  pneResInfoCacheN = 0
}

function pneResCat() {
  var ev
  var k
  var e
  var key
  var idx
  if (pneResCatIdx === null) {
    idx = { n: 0, pools: {}, ev: {} }
    ev = null
    try { ev = (typeof PNE_RES_CATALOG !== 'undefined' && PNE_RES_CATALOG) ? PNE_RES_CATALOG.events : null } catch (e0) { ev = null }
    if (ev) {
      for (k in ev) {
        if (!ev.hasOwnProperty(k)) continue
        e = ev[k]
        if (!e || e.amb === true) continue
        idx.ev[String(k)] = e
        key = String(e.layer) + '.' + String(e.cls)
        if (!idx.pools.hasOwnProperty(key)) idx.pools[key] = []
        idx.pools[key].push(String(k))
        idx.n++
      }
      for (k in idx.pools) {
        if (idx.pools.hasOwnProperty(k)) idx.pools[k].sort()
      }
    }
    pneResCatIdx = idx
  }
  return pneResCatIdx.n > 0 ? pneResCatIdx : null
}

function pneResPool(layer, cls) {
  var c = pneResCat()
  var key = layer + '.' + cls
  if (!c || !c.pools.hasOwnProperty(key)) return []
  return c.pools[key]
}

// Sound information for the ledger: catalog for pne:res.*, PNE_RES_EXTERNAL for measured external events,
// meta values or conservative defaults otherwise. null for a pne:res event without an asset. Cached per event
// and flag set (the object is shared: read-only for callers).
var pneResInfoCache = {}
var pneResInfoCacheN = 0

function pneResInfo(ev, meta) {
  var m = meta || {}
  var key = null
  var out
  if (m.lufs === undefined && m.mmax === undefined && m.dur === undefined && m.att === undefined) {
    key = ev + '|' + (m.cls ? String(m.cls) : '') + '|' + (m.layer ? String(m.layer) : '') + '|' +
      (m.lf === true ? 'l' : '') + (m.stinger === true ? 's' : '')
    if (pneResInfoCache.hasOwnProperty(key)) return pneResInfoCache[key]
  }
  out = pneResInfoBuild(ev, m)
  if (key !== null && out && pneResInfoCacheN < 512) {
    pneResInfoCache[key] = out
    pneResInfoCacheN++
  }
  return out
}

function pneResInfoBuild(ev, m) {
  var c = pneResCat()
  var e = null
  var x
  var out
  if (ev.indexOf('pne:res.') === 0) {
    if (c && c.ev.hasOwnProperty(ev)) e = c.ev[ev]
    if (!e) return null
    out = pneResFlat({
      res: true, v: [[pneResNum(e.lufs, -30), pneResNum(e.mmax, pneResNum(e.lufs, -30) + 6), 1]],
      dur: pneResNum(e.dur, 8), att: pneResNum(e.att, 16), lf: e.lf === true, layer: String(e.layer), cls: String(e.cls),
      cat: e.cat ? String(e.cat) : 'ambient', comfort: e.comfort !== false, normal: e.normal !== false,
      reserve: e.reserve === true, stinger: String(e.layer) === 'L7'
    })
    // a file too short for an in-file rise (V15 not applicable): its catalog mmax is the onset step (contract 5)
    if (out.dur < PNE_RES_SHORT_S && out.flat[1] > out.flat[0]) out.step = out.flat[1] - out.flat[0]
    return out
  }
  x = PNE_RES_EXTERNAL.hasOwnProperty(ev) ? PNE_RES_EXTERNAL[ev] : null
  out = {
    res: false, v: null, dur: 4, att: 16, lf: m.lf === true, layer: m.layer ? String(m.layer) : 'ext',
    cls: m.cls ? String(m.cls) : '', cat: '', comfort: true, normal: true, reserve: false, stinger: m.stinger === true
  }
  if (x) {
    out.v = x.v
    out.dur = x.dur
    out.att = x.att
    out.lf = out.lf || x.lf === true
  } else {
    out.v = [[pneResNum(m.lufs, PNE_RES_UNKNOWN.v[0][0]), pneResNum(m.mmax, PNE_RES_UNKNOWN.v[0][1]), 1]]
    out.dur = pneResNum(m.dur, PNE_RES_UNKNOWN.dur)
    out.att = pneResNum(m.att, PNE_RES_UNKNOWN.att)
  }
  return pneResFlat(out)
}

// While vol * sv <= 1 for every variant, all variants share the distance term, so the loudest one is fixed:
// flat[field] = max over variants of (level + 20 log10 sv). pneResLevel then needs two logs, not one per variant.
function pneResFlat(info) {
  var i
  var v
  var d
  info.svMax = 0
  info.flat = [-120, -120]
  info.step = 0   // dB the onset sits above the integrated level for the level-jump rule (pneResInfoBuild)
  for (i = 0; i < info.v.length; i++) {
    v = info.v[i]
    if (v[2] > info.svMax) info.svMax = v[2]
    d = pneResDb(v[2])
    if (v[0] + d > info.flat[0]) info.flat[0] = v[0] + d
    if (v[1] + d > info.flat[1]) info.flat[1] = v[1] + d
  }
  return info
}

// ---------------------------------------------------------------------------------------------
// L_eff model (TDD 2.3.4) with the Minecraft details that matter:
//  * the client multiplies the /playsound volume by the sounds.json volume (sv); gain = min(vol*sv, 1);
//    attenuation range = max(vol*sv, 1) * att, linear distance model;
//  * the server sends the sound only when the player's feet are within 16 * max(1, vol) of the position
//    (PlaySoundCommand with a variable-range event);
//  * d is measured from the eyes (1.62 blocks above the feet).
// Returns the loudest variant's level (field 0: integrated, 1: max momentary).

function pneResLevel(info, vol, geo, field) {
  var best = -120
  var i
  var v
  var vt
  var g
  var l
  if (geo.feet > 16 * Math.max(1, vol) + 1e-9) return -120
  if (vol * info.svMax <= 1) {
    g = 1 - geo.eye / info.att
    return g > 0 && vol > 0 ? info.flat[field] + pneResDb(vol) + pneResDb(g) : -120
  }
  for (i = 0; i < info.v.length; i++) {
    v = info.v[i]
    vt = vol * v[2]
    g = Math.min(vt, 1) * Math.max(0, 1 - geo.eye / (Math.max(vt, 1) * info.att))
    l = v[field] + pneResDb(g)
    if (l > best) best = l
  }
  return best
}

// Largest volume <= vmax (2 decimals, rounded down) whose level is <= target; 0 when even 0.01 is too loud or
// the answer falls past the sound's range edge (then it would be sent but never heard). Solved per variant in
// closed form (the level is the loudest variant's, so every variant must fit): with g = 10^((target - L)/20),
// a = 1 - d/att: vol*sv <= g/a while that is <= 1, else (range extension) vol*sv <= d / (att (1 - g)).
function pneResVolFor(info, vmax, geo, target, field) {
  var best = vmax
  var i
  var v
  var g
  var a
  var vt
  var k
  if (pneResLevel(info, vmax, geo, field) <= target + 1e-9) return Math.floor(vmax * 100 + 1e-9) / 100
  a = 1 - geo.eye / info.att
  if (vmax * info.svMax <= 1) {
    if (a <= 0) return 0
    v = Math.floor(Math.pow(10, (target - info.flat[field] - pneResDb(a)) / 20) * 100 + 1e-9) / 100
    return v >= 0.01 && v <= vmax && pneResLevel(info, v, geo, field) > -119 ? v : 0
  }
  for (i = 0; i < info.v.length; i++) {
    v = info.v[i]
    g = Math.pow(10, (target - v[field]) / 20)
    vt = (a > 0 && g / a <= 1) ? g / a : (g >= 1 ? Infinity : geo.eye / (info.att * (1 - g)))
    if (vt / v[2] < best) best = vt / v[2]
  }
  v = Math.floor(best * 100 + 1e-9) / 100
  for (k = 0; k < 4 && v > 0 && pneResLevel(info, v, geo, field) > target + 1e-9; k++) v = Math.floor(v * 100 - 1 + 1e-9) / 100
  if (v < 0.01 || pneResLevel(info, v, geo, field) > target + 1e-9 || pneResLevel(info, v, geo, field) <= -119) return 0
  return v
}

// Source geometry from a position string: '~a ~b ~c' or '^a ^b ^c' relative to the player's feet
// ('execute as <p> at @s'), or absolute 'x y z' (then meta.dist or the player's position is used).
// Relative geometries are cached (the director uses a handful of fixed placements).
var pneResGeoCache = {}
var pneResGeoCacheN = 0

function pneResGeo(pos, player, meta) {
  var key = String(pos || '~ ~ ~')
  var parts
  var o = [0, 0, 0]
  var g
  var rel = true
  var i
  var s
  var d
  var px
  var py
  var pz
  if (pneResGeoCache.hasOwnProperty(key)) return pneResGeoCache[key]
  parts = key.replace(/^\s+|\s+$/g, '').split(/\s+/)
  if (parts.length !== 3) parts = ['~', '~', '~']
  for (i = 0; i < 3; i++) {
    s = parts[i]
    if (s.charAt(0) === '~' || s.charAt(0) === '^') o[i] = s.length > 1 ? pneResNum(s.substring(1), 0) : 0
    else {
      rel = false
      o[i] = pneResNum(s, 0)
    }
  }
  if (rel) {
    g = {
      feet: Math.sqrt(o[0] * o[0] + o[1] * o[1] + o[2] * o[2]),
      eye: Math.sqrt(o[0] * o[0] + (o[1] - PNE_RES_EYE) * (o[1] - PNE_RES_EYE) + o[2] * o[2])
    }
    if (pneResGeoCacheN < 64) {
      pneResGeoCache[key] = g
      pneResGeoCacheN++
    }
    return g
  }
  if (meta && meta.dist !== undefined) {
    d = pneResNum(meta.dist, 0)
    return { feet: d, eye: d }
  }
  try {
    px = Number(player.getX())
    py = Number(player.getY())
    pz = Number(player.getZ())
  } catch (e) {
    return { feet: 0, eye: 0 }
  }
  return pneResGeoAbs(px, py, pz, o[0], o[1], o[2])
}

function pneResGeoAbs(px, py, pz, x, y, z) {
  var dx = x - px
  var dy = y - py
  var dz = z - pz
  var de = y - (py + PNE_RES_EYE)
  return { feet: Math.sqrt(dx * dx + dy * dy + dz * dz), eye: Math.sqrt(dx * dx + de * de + dz * dz) }
}

// ---------------------------------------------------------------------------------------------
// Per-player state

function pneResPlayerState(player) {
  var u = pneCoreUuid(player)
  var R
  if (!u) return null
  R = pneResP[u]
  if (!R) {
    R = {
      u: u, player: player, seen: pneCoreTick, joined: pneCoreTick,
      st: { fsm: pneResFsmNew(), tier: pneResTierNew() }, pace: null, prevState: 'CALM',
      rng: 0, rngDay: -1, pidHash: 0, bags: {}, played: {}, novelAt: 0,
      led: { inst: [], lfHist: [], lastOnset: -1e9, lastRes: -1e9, lastSting: -1e9, lastL7: -1e9, lastSlamEnd: -1e9, cls: {} },
      q: [], last: { wh: -1e9, L2: -1e9, L3: -1e9, L4: -1e9, L6: -1e9 }, win2: -1,
      bed: { cur: null, next: 0, changed: -1e9, until: 0, runLeft: 0, runStart: 0, gapUntil: 0 }, want: null,
      mode: 'normal', vuln: false, tier: 0, comfort: true, relStart: -1, vac: false, vacPending: 0, app: null, panicSeen: false,
      sense: null, tg: null, day: -1, stage: 0
    }
    pneResP[u] = R
  }
  R.player = player
  R.seen = pneCoreTick
  return R
}

// xorshift32 seeded worldSeed ^ pidHash ^ day (A1); reseeded when the in-game day changes.
function pneResRand(R) {
  var day = R.day >= 0 ? R.day : Math.floor(pneCoreGameTime(null) / 24000)
  var x
  if (R.rngDay !== day) {
    if (!R.pidHash && R.player) R.pidHash = pneCoreFnv1a(pneCorePid(R.player))
    R.rng = ((pneCoreSeed32(null) ^ R.pidHash ^ day) >>> 0)
    if (R.rng === 0) R.rng = 0x9e3779b9
    R.rngDay = day
  }
  x = R.rng
  x ^= x << 13
  x >>>= 0
  x ^= x >>> 17
  x ^= x << 5
  x >>>= 0
  R.rng = x
  return x / 4294967296
}

// A1 + A2: between two plays of one variant, at least h other picks of its pool, where
// h = max(A2's window min(4, n - 2) (at least 1), ceil(n / 2)) for n open variants, and h <= n - 1.
// ("nothing replays until at least half its pool has played"; for n = 12, h = 6.)
var PNE_RES_BAG_RECENT = 16        // picks remembered per pool (>= h for pools up to 32 variants)

function pneResBagGap(n) {
  if (n < 2) return 0
  return Math.min(n - 1, Math.max(Math.max(1, Math.min(4, n - 2)), Math.ceil(n / 2)))
}

// Picks since id last played in this pool (1e9 when it is not among the remembered picks).
function pneResBagAge(b, id) {
  var k = b.recent.lastIndexOf(id)
  return k < 0 ? 1e9 : b.recent.length - 1 - k
}

// A fresh bag: every open variant once, in random order, built so that the item at index i has been out of
// play for at least h - i picks already. Then no variant replays across the bag boundary before h others have
// played, without pinning the previous bag's second half to the end of every later bag (which a plain
// "recent items last" rule does: the pool would split into two fixed halves). At index i at most h - i of the
// n - i remaining items are too recent, so a choice always exists.
function pneResBagBuild(R, b, open, h) {
  var rest = open.slice(0)
  var order = []
  var ok
  var n = rest.length
  var i
  var j
  for (i = 0; i < n; i++) {
    ok = []
    for (j = 0; j < rest.length; j++) {
      if (pneResBagAge(b, rest[j]) + i >= h) ok.push(j)
    }
    j = ok.length ? ok[Math.floor(pneResRand(R) * ok.length)] : 0
    order.push(rest[j])
    rest.splice(j, 1)
  }
  b.order = order
  b.pos = 0
}

// Shuffle bag with the half-pool rule above and the novelty reserve (A1, A2, A9): reserve variants are
// withheld for the first 30 min (unless an apex genome is near), then one unplayed reserve variant is
// injected per 10 min of play.
function pneResPick(R, key, ids, now) {
  var c = pneResCat()
  var open = []
  var novel = []
  var unlocked = now - R.joined >= 36000 || R.apex === true
  var b
  var i
  var j
  var t
  var h
  var sig
  var id
  for (i = 0; i < ids.length; i++) {
    if (c && c.ev[ids[i]] && c.ev[ids[i]].reserve === true) {
      if (!unlocked) continue
      if (!R.played[ids[i]]) novel.push(ids[i])
    }
    open.push(ids[i])
  }
  if (!open.length) return null
  b = R.bags[key]
  if (!b) {
    b = { order: [], pos: 0, recent: [], sig: '', undo: null }
    R.bags[key] = b
  }
  b.undo = { id: null, pos: b.pos, recent: b.recent.slice(0), novelAt: R.novelAt, bag: false, wasPlayed: false }
  h = pneResBagGap(open.length)
  if (novel.length && now >= R.novelAt) {
    // a never-played variant cannot be too recent
    id = novel[Math.floor(pneResRand(R) * novel.length)]
    R.novelAt = now + 12000
  } else {
    b.undo.bag = true
    sig = open.join(',')
    if (b.pos >= b.order.length || b.sig !== sig) {
      pneResBagBuild(R, b, open, h)
      b.sig = sig
    }
    // an injected novelty can make the next bag item too recent: swap in a later one that is not, else rebuild
    if (pneResBagAge(b, b.order[b.pos]) < h) {
      for (j = b.pos + 1; j < b.order.length; j++) {
        if (pneResBagAge(b, b.order[j]) >= h) {
          t = b.order[b.pos]
          b.order[b.pos] = b.order[j]
          b.order[j] = t
          break
        }
      }
      if (pneResBagAge(b, b.order[b.pos]) < h) pneResBagBuild(R, b, open, h)
    }
    b.undo.pos = b.pos
    id = b.order[b.pos]
    b.pos++
  }
  b.undo.id = id
  b.undo.wasPlayed = R.played[id] === true
  b.recent.push(id)
  while (b.recent.length > PNE_RES_BAG_RECENT) b.recent.shift()
  R.played[id] = true
  return id
}

// Takes back the last pick of a pool when the ledger refused it, so refused attempts never advance the bag
// (otherwise a variant could come back and be issued twice in a row).
function pneResUnpick(R, key) {
  var b = R.bags[key]
  var u = b ? b.undo : null
  if (!u || u.id === null) return
  if (u.bag) b.pos = u.pos
  b.recent = u.recent
  R.novelAt = u.novelAt
  if (!u.wasPlayed) delete R.played[u.id]
  b.undo = null
}

// ---------------------------------------------------------------------------------------------
// The ledger

// Bus estimate at tick t: power sum of the L_eff of the instances playing at t (list = L.inst or a subset).
// Each instance carries its linear power pw = 10^(L_eff / 10), so the sums need no pow/log per instance.
function pneResPowAt(list, t) {
  var p = 0
  var i
  var x
  for (i = 0; i < list.length; i++) {
    x = list[i]
    if (x.t0 <= t && t < x.t1) p += x.pw
  }
  return p
}

function pneResBusAt(list, t) {
  var p = pneResPowAt(list, t)
  return p > 0 ? 10 * Math.log(p) / PNE_RES_LN10 : -120
}

// Instances that play at some point in [a, b] (the only ones that matter for a window).
function pneResOverlap(L, a, b) {
  var out = []
  var i
  var x
  for (i = 0; i < L.inst.length; i++) {
    x = L.inst[i]
    if (x.t0 <= b && x.t1 > a) out.push(x)
  }
  return out
}

// Lowest bus estimate (floored) over [a, b]: the bus only changes at instance boundaries.
function pneResBusMin(L, a, b) {
  var list = pneResOverlap(L, a, b)
  var best = Math.max(PNE_RES_FLOOR_PW, pneResPowAt(list, a))
  var i
  var x
  var v
  for (i = 0; i < list.length; i++) {
    x = list[i]
    if (x.t0 > a && x.t0 <= b) {
      v = Math.max(PNE_RES_FLOOR_PW, pneResPowAt(list, x.t0))
      if (v < best) best = v
    }
    if (x.t1 > a && x.t1 <= b) {
      v = Math.max(PNE_RES_FLOOR_PW, pneResPowAt(list, x.t1))
      if (v < best) best = v
    }
  }
  return 10 * Math.log(best) / PNE_RES_LN10
}

// Trailing 3 s short-term level of the bus (energy average, floored), for the stinger rule.
function pneResShortTerm(L, t) {
  var list = pneResOverlap(L, t - 60, t - 1)
  var p = 0
  var k
  for (k = 1; k <= 60; k++) p += Math.max(PNE_RES_FLOOR_PW, pneResPowAt(list, t - k))
  return 10 * Math.log(p / 60) / PNE_RES_LN10
}

function pneResLfOn(L, a, b) {
  var n = 0
  var i
  var h
  for (i = 0; i < L.lfHist.length; i++) {
    h = L.lfHist[i]
    n += Math.max(0, Math.min(h.t1, b) - Math.max(h.t0, a))
  }
  return n
}

function pneResPrune(L, now) {
  var keep = []
  var lf = []
  var i
  if (L.pruned !== undefined && now - L.pruned >= 0 && now - L.pruned < 20) return
  L.pruned = now
  for (i = 0; i < L.inst.length; i++) {
    if (L.inst[i].t1 >= now - 1200) keep.push(L.inst[i])
  }
  L.inst = keep
  for (i = 0; i < L.lfHist.length; i++) {
    if (L.lfHist[i].t1 >= now - PNE_RES_LF_WINDOW) lf.push(L.lfHist[i])
  }
  L.lfHist = lf
}

// The player's comfort, switch and horde tags, read at most once per second (the /pne commands refresh them at
// once). The tag set is fetched once (one Java call) and probed with contains(); pneCoreHasTag is the fallback.
function pneResTagHas(set, p, tag) {
  if (set) {
    try { return set.contains(tag) ? true : false } catch (e) { }
  }
  return pneCoreHasTag(p, tag)
}

function pneResTags(R, p) {
  var T = R.tg
  var set = null
  if (T && T.p === p && pneCoreTick - T.t >= 0 && pneCoreTick - T.t <= 20) return T
  try { set = p.getTags() } catch (e) { set = null }
  T = {
    t: pneCoreTick, p: p, cf: !pneResTagHas(set, p, PNE_CORE_TAG_COMFORT_OFF), off: pneResTagHas(set, p, PNE_RES_TAG_OFF),
    wh: pneResTagHas(set, p, PNE_RES_TAG_SW.whispers), th: pneResTagHas(set, p, PNE_RES_TAG_SW.throb),
    ap: pneResTagHas(set, p, PNE_RES_TAG_SW.approach), st: pneResTagHas(set, p, PNE_RES_TAG_SW.stingers),
    horde: pneResTagHas(set, p, 'pne_horde')
  }
  R.tg = T
  return T
}

function pneResTagsDirty(player) {
  var u = pneCoreUuid(player)
  if (u && pneResP[u]) pneResP[u].tg = null
}

function pneResRefuse(why) {
  pneResStats.refused++
  pneResStats.why[why] = (pneResStats.why[why] || 0) + 1
  return 0
}

// The ledger decision and the command. Returns the issued volume (> 0), or 0 when refused.
// ctx = { player, u, ev, cat, pos, vol, pitch, rotated, meta, info, geo, tell }
function pneResLedger(R, c, now) {
  var p = c.player
  var info = c.info
  var m = c.meta
  var L = R.led
  var tg = pneResTags(R, p)
  var comfort = tg.cf
  var mode = comfort ? 'comfort' : 'normal'
  var lf = info.lf === true
  var sting = info.stinger === true || m.stinger === true
  var vol = c.vol
  var dur = Math.max(1, Math.ceil(info.dur / Math.max(0.5, c.pitch) * 20))
  var lim
  var l0
  var lt
  var ref
  var busNow
  var room
  var allow
  var lu
  var i
  var x
  var e
  var cap
  var st
  var mmax
  var vs
  var cmd
  var srv
  var gap
  var k
  // rule 15 (a): nothing is issued before the server started (and nothing is recorded as played)
  if (!pneResStarted()) return pneResRefuse('not_started')
  pneResPrune(L, now)
  // 1. per-player switches (tells ignore them: fairness)
  if (!c.tell) {
    if (info.res && tg.off) return pneResRefuse('self_off')
    if (info.layer === 'L5' && tg.wh) return pneResRefuse('sw_whispers')
    if ((info.layer === 'L2' || info.layer === 'L3' || info.cls === 'hive_heartbeat') && tg.th) return pneResRefuse('sw_throb')
    if (info.layer === 'L6' && tg.ap) return pneResRefuse('sw_approach')
    if (sting && tg.st) return pneResRefuse('sw_stingers')
  }
  // 1b. the TDD 2.5.4 overrides for the director's own layers, as a backstop to the scheduler: PANIC stops
  // L1, L2, L3 flutter/rough, L4 and L5 (A5); RELEASE is silent for its first 10 s (L0 c); mercy and grace allow
  // no L2, L3, L4, L6 or L7 (whatever the pacing state). Keyed on the cached Pace, not on the scheduler's mode.
  if (info.res && !c.tell && R.pace) {
    if (R.pace.state === 'PANIC' && (PNE_RES_PANIC_OFF[info.layer] === true ||
        (info.layer === 'L3' && info.cls !== 'heartbeat' && info.cls !== 'heartbeat_c'))) return pneResRefuse('panic_a5')
    if (R.pace.state === 'RELEASE' && (R.relStart < 0 || now - R.relStart < PNE_RES_RELEASE_HUSH)) return pneResRefuse('release_hush')
    if ((R.pace.mercy === true || R.pace.grace === true) && PNE_RES_VULN_OFF[info.layer] === true) return pneResRefuse('vuln_layer')
  }
  // 2. comfort (and the normal-mode asset flags)
  if (!c.tell) {
    if (comfort) {
      if (info.res && !info.comfort) return pneResRefuse('comfort_asset')
      if (sting) return pneResRefuse('comfort_stinger')
      if (lf && !PNE_RES_LF_COMFORT_OK[info.cls]) return pneResRefuse('comfort_lf')
      if (PNE_RES_COMFORT_VOL.hasOwnProperty(info.cls)) vol = vol * PNE_RES_COMFORT_VOL[info.cls]
      k = 0
      for (i = 0; i < L.inst.length; i++) {
        if (!L.inst[i].tell && L.inst[i].t0 > now - 20) k++
      }
      if (k >= PNE_RES_COMFORT_RATE) return pneResRefuse('comfort_rate')
    } else if (info.res && !info.normal) return pneResRefuse('normal_asset')
    if (info.res && info.layer !== 'L1' && now - L.lastOnset < PNE_RES_SPACING) return pneResRefuse('spacing')
    if (PNE_RES_CLS_MIN.hasOwnProperty(info.cls) && L.cls.hasOwnProperty(info.cls) && now - L.cls[info.cls] < PNE_RES_CLS_MIN[info.cls][mode]) return pneResRefuse('cls_interval')
  }
  // 3. A8: LF exclusivity, per-instance cap, rest, slam gap, duty; stinger rate rules
  if (lf) {
    cap = PNE_RES_LF[mode]
    if (dur > cap.inst) return pneResRefuse('lf_instance')
    for (i = 0; i < L.inst.length; i++) {
      x = L.inst[i]
      if (x.lf && x.t0 <= now && now < x.t1) return pneResRefuse('lf_exclusive')
    }
    if (L.lfHist.length) {
      x = L.lfHist[L.lfHist.length - 1]
      if (now < x.t1 + cap.rest * (x.t1 - x.t0)) return pneResRefuse('lf_rest')
      gap = (comfort && (x.slam || info.cls === 'slam')) ? PNE_RES_SLAM_GAP : 0
      if (now < x.t1 + gap) return pneResRefuse('lf_slam_gap')
    }
    if ((info.layer === 'L2' || info.layer === 'L3') && now < L.lastSlamEnd + PNE_RES_SLAM_GAP) return pneResRefuse('lf_after_slam')
    if (pneResLfOn(L, now + dur - PNE_RES_LF_WINDOW, now + dur) + dur > cap.duty) return pneResRefuse('lf_duty')
  }
  if (sting) {
    if (now - L.lastSting < PNE_RES_STING_GAP) return pneResRefuse('sting_gap')
    if (info.layer === 'L7' && now - L.lastL7 < PNE_RES_STING_COOL) return pneResRefuse('sting_rate')
    for (i = 0; i < L.inst.length; i++) {
      x = L.inst[i]
      if ((x.layer === 'L2' || x.layer === 'L3') && x.t0 <= now && now < x.t1) return pneResRefuse('sting_over_lf')
    }
  }
  // 4.-6. level-jump (or the stinger rule), bus ceiling, per-minute budget: each gives a level ceiling
  l0 = pneResLevel(info, vol, c.geo, 0)
  if (l0 <= -119) return pneResRefuse('inaudible')
  lt = l0
  busNow = pneResBusAt(L.inst, now)
  if (sting && !comfort) {
    st = pneResShortTerm(L, now)
    mmax = pneResLevel(info, vol, c.geo, 1)
    if (mmax > st + PNE_RES_STING_ABOVE) {
      vs = pneResVolFor(info, vol, c.geo, st + PNE_RES_STING_ABOVE, 1)
      if (vs <= 0 || pneResLevel(info, vs, c.geo, 1) < mmax - PNE_RES_JUMP_ATT) return pneResRefuse('sting_level')
      vol = vs
      lt = pneResLevel(info, vol, c.geo, 0)
    }
  } else {
    lim = PNE_RES_JUMP[mode]
    // the onset enters at lt + info.step (info.step > 0 only for a file with no in-file rise: its mmax, contract 5).
    // The reference is never below the floor: when the new bus fits even above the floor, skip the window scan
    ref = pneResPowSum(busNow, lt + info.step) <= PNE_RES_FLOOR + lim ? PNE_RES_FLOOR : pneResBusMin(L, now - PNE_RES_JUMP_WIN[mode], now)
    room = Math.pow(10, (ref + lim) / 10) - (busNow > -119 ? Math.pow(10, busNow / 10) : 0)
    allow = room > 0 ? 10 * Math.log(room) / PNE_RES_LN10 : -120
    if (allow < lt + info.step) {
      if (lt + info.step - allow > PNE_RES_JUMP_ATT) return pneResRefuse(c.tell ? 'tell_level_jump' : 'level_jump')
      lt = allow - info.step
    }
  }
  room = Math.pow(10, PNE_RES_BUS_MAX / 10) - (busNow > -119 ? Math.pow(10, busNow / 10) : 0)
  allow = room > 0 ? 10 * Math.log(room) / PNE_RES_LN10 : -120
  if (allow < lt) {
    if (lt - allow > (c.tell ? PNE_RES_JUMP_ATT : PNE_RES_BUS_ATT)) return pneResRefuse(c.tell ? 'tell_bus_ceiling' : 'bus_ceiling')
    lt = allow
  }
  if (info.res && !c.tell) {
    e = 0
    for (i = 0; i < L.inst.length; i++) {
      x = L.inst[i]
      if (x.res && !x.tell && x.t0 > now - 1200) e += x.pw * (x.t1 - x.t0) / 20
    }
    room = 60 * Math.pow(10, PNE_RES_MINUTE[mode] / 10) - e
    allow = room > 0 ? 10 * Math.log(room / (dur / 20)) / PNE_RES_LN10 : -120
    if (allow < lt) {
      if (lt - allow > PNE_RES_BUS_ATT) return pneResRefuse('minute_budget')
      lt = allow
    }
  }
  if (lt < l0 - 1e-9) {
    vol = pneResVolFor(info, vol, c.geo, lt, 0)
    if (c.tell && vol < 0.3 * c.vol) return pneResRefuse('tell_attenuated')
    if (vol <= 0) return pneResRefuse('attenuated_out')
  } else vol = Math.floor(vol * 100 + 1e-9) / 100
  if (vol <= 0) return pneResRefuse('zero_volume')
  lu = pneResLevel(info, vol, c.geo, 0)
  // a range-extended sound (vol > 1) turned down past its range edge would be sent but never heard
  if (lu <= -119) return pneResRefuse('attenuated_out')
  // the command
  cmd = 'execute as ' + c.u + ' at @s ' + (c.rotated ? 'rotated ~ 0 ' : '') + 'run playsound ' + c.ev + ' ' + c.cat +
    ' @s ' + c.pos + ' ' + pneCoreFmt(vol) + ' ' + pneCoreFmt(c.pitch)
  srv = null
  try { srv = p.getServer() } catch (e1) { srv = null }
  if (!srv) srv = pneCoreServer
  if (!srv) return pneResRefuse('no_server')
  srv.runCommandSilent(cmd)
  pneCoreTake(PNE_CORE_COST.emit)
  pneResStats.issued++
  x = {
    ev: c.ev, cat: c.cat, t0: now, t1: now + dur, lu: lu, lf: lf, layer: info.layer, cls: info.cls, res: info.res,
    pw: lu > -119 ? Math.pow(10, lu / 10) : 0, slam: info.cls === 'slam', tell: c.tell, stopped: false, fade: PNE_RES_FADE.hasOwnProperty(info.layer) ? PNE_RES_FADE[info.layer] : 0
  }
  L.inst.push(x)
  L.lastOnset = now
  if (info.res) L.lastRes = now
  if (info.cls) L.cls[info.cls] = now
  if (lf) L.lfHist.push({ t0: now, t1: now + dur, slam: x.slam })
  if (x.slam) L.lastSlamEnd = now + dur
  if (sting) {
    L.lastSting = now
    if (info.layer === 'L7') L.lastL7 = now
  }
  return vol
}

// Shared entry for pneResEmit and the director's own layers.
function pneResEmitOne(player, event, category, pos, vol, meta, geo, tell) {
  var m = meta || {}
  var ev = String(event)
  var R = pneResPlayerState(player)
  var info
  var c
  var now = pneCoreTick
  if (!R) return 0
  info = pneResInfo(ev, m)
  if (!info) return pneResRefuse('no_asset')
  // resonance pillar OFF: Resonance layers (src 'res', or any pne:res.* event) are refused; every other source
  // still goes through the ledger (contract 3.2, 6.2)
  if ((info.res || m.src === 'res') && !pneCoreOn('resonance')) return pneResRefuse('pillar_off')
  c = {
    player: player, u: R.u, ev: ev, cat: String(category || info.cat || 'hostile'), pos: String(pos || '~ ~ ~'),
    vol: Math.max(0, pneResNum(vol, 1)), pitch: pneResNum(m.pitch, 1), rotated: m.rotated === true, meta: m, info: info,
    geo: geo || pneResGeo(pos, player, m), tell: tell === true
  }
  return pneResLedger(R, c, now)
}

// ---------------------------------------------------------------------------------------------
// Public API (contract 3.2)

// Cached Pace from the player's last 1 Hz step, or null for an unknown player. Treat it as read-only.
function pneResPace(player) {
  var u = pneCoreUuid(player)
  var R = u ? pneResP[u] : null
  return R && R.pace ? R.pace : null
}

// true if a /playsound was issued. Charges PNE_CORE_COST.emit per issued sound and proceeds when the budget
// refuses (an existing pack sound is never dropped for budget); the ledger may lower vol or refuse.
function pneResEmit(player, event, category, pos, vol, meta) {
  return pneResEmitOne(player, event, category, pos, vol, meta, null, false) > 0
}

// true when an LF-periodic onset is certain to be refused now for this player: another LF instance is playing,
// or the normal-mode rest (2x on-time) after the last one has not passed (comfort only waits longer).
function pneResLfBusy(player) {
  var u = pneCoreUuid(player)
  var R = u ? pneResP[u] : null
  var now = pneCoreTick
  var h
  if (!R || !R.led.lfHist.length) return false
  h = R.led.lfHist[R.led.lfHist.length - 1]
  return now < h.t1 + PNE_RES_LF.normal.rest * (h.t1 - h.t0)
}

// One per-player /playsound at absolute x y z for every player within radius in dimension dim.
function pneResEmitAt(server, dim, x, y, z, radius, event, category, vol, meta) {
  var ps = pneCoreAllPlayers(server)
  var r = pneResNum(radius, 16)
  var d = String(dim)
  var n = 0
  var pos = pneCoreFmt(x) + ' ' + pneCoreFmt(y) + ' ' + pneCoreFmt(z)
  var i
  var p
  var px
  var py
  var pz
  var geo
  for (i = 0; i < ps.length; i++) {
    p = ps[i]
    try {
      if (pneCoreDim(p.getLevel()) !== d) continue
      px = Number(p.getX())
      py = Number(p.getY())
      pz = Number(p.getZ())
    } catch (e) {
      continue
    }
    geo = pneResGeoAbs(px, py, pz, Number(x), Number(y), Number(z))
    if (geo.feet > r || geo.feet > 16 * Math.max(1, pneResNum(vol, 1)) + 1e-9) continue
    // bursts (a multi-kill's gore slams): skip the full ledger when an LF refusal is certain
    if (meta && meta.lf === true && pneResLfBusy(p)) continue
    if (pneResEmitOne(p, event, category, pos, vol, meta, geo, false) > 0) n++
  }
  return n
}

// L8 tell at the mob's position for that player (hostile, attenuation 24). Ignores pne_res_off, every
// per-layer switch and comfort. false when the pillar is off or no tell asset exists, and also (rarely, right
// after a loud onset) when even 0.3 of its volume would break the level-jump limit or the bus ceiling: the hive
// then drops that mob's Silent, so silence stays fair either way. The director never initiates tells; HIVE owns
// the cadence.
function pneResTell(mob, player) {
  var R
  var ids
  var ev
  var x
  var y
  var z
  var geo
  var v
  if (!pneCoreOn('resonance')) return false
  ids = pneResPool('L8', 'a')
  if (!ids.length) return false
  R = pneResPlayerState(player)
  if (!R) return false
  try {
    x = Number(mob.getX())
    y = Number(mob.getY())
    z = Number(mob.getZ())
    geo = pneResGeoAbs(Number(player.getX()), Number(player.getY()), Number(player.getZ()), x, y, z)
  } catch (e) {
    return false
  }
  ev = pneResPick(R, 'L8.a', ids, pneCoreTick)
  if (!ev) return false
  v = pneResEmitOne(player, ev, 'hostile', pneCoreFmt(x) + ' ' + pneCoreFmt(y) + ' ' + pneCoreFmt(z), 1, { src: 'res', layer: 'L8' }, geo, true)
  if (v > 0) pneResStats.tells++
  else pneResUnpick(R, 'L8.a')
  return v > 0
}

// ---------------------------------------------------------------------------------------------
// Sensing: this tick's ORACLE snapshot when fresh, else the director's own light-weight probes (contract 8:
// coarse execute-if-entity distance bands, light, health) at the same slot.

var PNE_RES_BANDS = [32, 16, 8, 4]
var PNE_RES_BAND_MID = [24, 12, 6, 2]

function pneResProbeCount(srv, u, r) {
  var n = 0
  var k
  var tags = ['#pne:hive', '#pne:spore']
  if (!pneResStarted()) return -1
  for (k = 0; k < tags.length; k++) {
    if (!pneCoreTake(PNE_CORE_COST.emit)) return -1
    n += Math.max(0, pneResNum(srv.runCommandSilent('execute as ' + u + ' at @s if entity @e[type=' + tags[k] + ',distance=..' + r + ']'), 0))
  }
  return n
}

function pneResLight(player) {
  var v = NaN
  try { v = Number(player.getLevel().getMaxLocalRawBrightness(player.blockPosition())) } catch (e) { v = NaN }
  if (!isFinite(v)) {
    try { v = Number(player.block.getLight()) } catch (e2) { v = NaN }
  }
  return isFinite(v) ? pneCoreClamp(v, 0, 15) : 15
}

// prev = the player's previous reading. A probe refused for budget is missing data, not "no parasite": the
// band scan stops and the previous complete reading is reused when it is at most PNE_RES_SENSE_STALE ticks old
// (src 'probe-stale'); otherwise the result is null and the caller skips this step (like a refused director
// step: the player waits for the next slot, and pneCorePace falls back after 40 ticks).
function pneResSense(player, u, now, prev) {
  var s = pneCoreSnap(player)
  var out = { nearest: 32, n16: 0, light: 15, hp: 1, tsd: 600, seen: false, src: 'probe', at: pneCoreTick }
  var srv = null
  var stale = false
  var k
  var c
  var pd
  var lph = 0
  if (s && isFinite(Number(s.tick)) && pneCoreTick - Number(s.tick) >= 0 && pneCoreTick - Number(s.tick) <= 20) {
    out.nearest = pneCoreClamp(pneResNum(s.nearest, 32), 0, 32)
    out.n16 = Math.max(0, pneResNum(s.n16, 0))
    out.light = pneCoreClamp(pneResNum(s.light, 15), 0, 15)
    out.hp = s.hp === undefined || s.hp === null ? pneCoreHp(player) : pneCoreClamp(pneResNum(s.hp, 1), 0, 1)
    out.tsd = Math.max(0, pneResNum(s.tSinceDmg, 600))
    out.seen = s.hostileSeen === true
    out.src = 'snap'
    return out
  }
  try { srv = player.getServer() } catch (e) { srv = null }
  if (!srv) srv = pneCoreServer
  if (srv) {
    for (k = 0; k < PNE_RES_BANDS.length; k++) {
      c = pneResProbeCount(srv, u, PNE_RES_BANDS[k])
      if (c < 0) {
        stale = true
        break
      }
      if (c === 0) break
      out.nearest = PNE_RES_BAND_MID[k]
      if (PNE_RES_BANDS[k] === 16) out.n16 = c
    }
  }
  if (stale) {
    if (!prev || !(pneCoreTick - prev.at >= 0 && pneCoreTick - prev.at <= PNE_RES_SENSE_STALE)) return null
    // proximity from the last complete reading (keeping its time, so staleness never extends itself); no
    // line-of-sight claim
    out.nearest = prev.nearest
    out.n16 = prev.n16
    out.at = prev.at
    out.src = 'probe-stale'
  }
  pd = pneCorePD(player)
  try { lph = Number(pd.getLong('pne_lph')) } catch (e2) { lph = 0 }
  if (lph > 0 && now - lph >= 0) out.tsd = (now - lph) / 20
  out.light = pneResLight(player)
  out.hp = pneCoreHp(player)
  return out
}

// ---------------------------------------------------------------------------------------------
// The 1 Hz step

function pneResDaytime(server) {
  var t = NaN
  try { t = Number(server.getOverworld().getDayTime()) } catch (e) { t = NaN }
  return isFinite(t) ? ((t % 24000) + 24000) % 24000 : -1
}

function pneResNight(server) {
  var t = pneResDaytime(server)
  return t >= 13000 && t <= 23000
}

function pneResServerOf(player) {
  var s = null
  try { s = player.getServer() } catch (e) { s = null }
  return s ? s : pneCoreServer
}

function pneResPublish(player, pace, now) {
  var pd = pneCorePD(player)
  var m = pneCoreClamp(pace.spawn, 0, 1)
  var soft
  try {
    pd.putDouble('pne_m', m)
    pd.putLong('pne_m_t', now)
  } catch (e) { }
  pneCoreSetTag(player, PNE_CORE_TAG_GATE, m < 1)
  if (pace.aggro <= 0.8 + 1e-9) soft = true
  else if (pace.aggro >= 1 - 1e-9) soft = false
  else soft = Math.floor(pneCoreTick / 100) % 2 === 1
  pneCoreSetTag(player, PNE_CORE_TAG_PACE_SOFT, soft)
}

// Clocks: the scheduler and the ledger use pneCoreTick; game time (pneCoreNow) is used only for pne_m_t and
// the age of pne_lph, which the contract defines in game time.
function pneResStep(player) {
  var R = pneResPlayerState(player)
  var now = pneCoreTick
  var gt
  var sense
  var v
  var fresh
  var vuln
  var inp
  var out
  var prox
  var dark
  var cnt
  var pflee = -1
  var eo = 0
  var conf = 0
  var near
  if (!R) return null
  gt = pneCoreNow(player)
  R.tg = null
  R.day = Math.floor(gt / 24000)
  try { R.stage = pneCoreStage(player.getLevel()) } catch (e) { R.stage = 0 }
  sense = pneResSense(player, R.u, gt, R.sense)
  if (!sense) return R.pace
  R.sense = sense
  v = pneCoreVerdict(player)
  fresh = false
  if (v && v.fresh === true && pneResNum(v.age, 999) <= 60) {
    fresh = true
    eo = pneCoreClamp(pneResNum(v.EO, 0), 0, 1)
    conf = pneCoreClamp(pneResNum(v.conf, 0), 0, 1)
    pflee = pneResNum(v.pFlee, -1)
  }
  vuln = pneCoreVuln(player)
  prox = Math.max(0, 1 - sense.nearest / 32)
  cnt = Math.min(1, sense.n16 / 8)
  dark = 1 - sense.light / 15
  inp = {
    eo: eo, conf: conf, fresh: fresh,
    sh: pneCoreClamp(0.45 * prox + 0.20 * cnt + 0.15 * dark + 0.20 * (1 - sense.hp), 0, 1),
    theta: pneCoreClamp(0.60 * prox + 0.25 * cnt + 0.15 * dark, 0, 1),
    nearest: sense.nearest, tsd: sense.tsd, pflee: pflee,
    mercy: vuln.mercy === true, grace: vuln.grace === true,
    deaths1h: pneCoreHiveDeaths(player, 72000),
    diff: pneResDiffNow()
  }
  out = pneResPureStep(R.st, inp)
  R.pace = {
    state: out.state, spawn: out.spawn, aggro: out.aggro, beckon: out.beckon, ga: out.ga,
    tier: PNE_RES_TIERS[out.tier], e: out.e, theta: inp.theta, mercy: inp.mercy, grace: inp.grace,
    tick: pneCoreTick, sh: inp.sh, eo: eo, fresh: fresh, rawTier: PNE_RES_TIERS[out.raw], gov: out.gov,
    sense: sense.src, diff: inp.diff
  }
  pneResPublish(player, R.pace, gt)
  near = pneCoreHiveNear(player)
  R.apex = near && near.apex === true
  R.clade = near ? pneResNum(near.clade, -1) : -1
  pneResAudio(player, R, out, now)
  R.prevState = out.state
  return R.pace
}

// ---------------------------------------------------------------------------------------------
// Resonance layers (catalog-driven). All placement is fixed at onset (A11): director layers 12 blocks above
// the player, whispers at ^ ^1 ^-6 (pitch levelled), approach and payoff at ^ ^1 ^-8.

function pneResSched(R, at, kind, data) {
  R.q.push({ at: at, kind: kind, data: data || null })
}

function pneResHas(R, kind) {
  var i
  for (i = 0; i < R.q.length; i++) {
    if (R.q[i].kind === kind) return true
  }
  return false
}

function pneResDrop(R, kind) {
  var keep = []
  var i
  for (i = 0; i < R.q.length; i++) {
    if (R.q[i].kind !== kind) keep.push(R.q[i])
  }
  R.q = keep
}

// Plays one variant of a layer class through the ledger. Returns the event id, or null.
function pneResLayer(R, layer, cls, pos, vol, rotated, now) {
  var ids = pneResPool(layer, cls)
  var ev
  var info
  if (!ids.length || !R.player) return null
  ev = pneResPick(R, layer + '.' + cls, ids, now)
  if (!ev) return null
  info = pneResInfo(ev, null)
  if (!info) return null
  if (pneResEmitOne(R.player, ev, info.cat, pos, vol, { src: 'res', rotated: rotated === true, layer: layer, cls: cls }, null, false) > 0) return ev
  pneResUnpick(R, layer + '.' + cls)
  return null
}

function pneResHazard(R, lastTick, floorS, meanS, now) {
  if (now - lastTick < floorS * 20) return false
  return pneResRand(R) < 1 / meanS
}

// What the bed should be: null (silent), 'dry', 'dread' or 'muffled'. The QUIET tier keeps its L0 (a) gaps in
// every mode that plays a bed there: normal, mercy/grace ('vuln') and RELEASE after its 10 s hush.
function pneResBedWant(R, out, now) {
  if (R.mode === 'panic') return null
  if (R.mode === 'release') {
    if (R.relStart < 0 || now - R.relStart < PNE_RES_RELEASE_HUSH) return null
    return now < R.bed.gapUntil ? null : 'muffled'
  }
  if (R.mode === 'vuln') return now < R.bed.gapUntil ? null : 'muffled'
  if (R.vac) return 'muffled'
  if (out.tier === 0 && now < R.bed.gapUntil) return null
  return (out.tier === 2 || R.stage >= 6) ? 'dread' : 'dry'
}

var PNE_RES_BED_ORDER = ['dry', 'dread', 'muffled']

// Issues the next bed segment (queue item 'bed'), stepping one palette class per event (A6), with the
// baked transition segments forward and the vacuum's dry -> muffled exception. B.cur is the class the player
// hears: it changes only when the ledger issued the segment. A refused segment is retried 1 s later from the
// same class (so a refused t_dry_dread never lets the next event jump dread -> muffled); once the last issued
// segment has ended, the bed counts as silent and may restart in any class.
function pneResBedIssue(R, now) {
  var B = R.bed
  var want = R.want
  var prev
  var cls
  var next
  var ci
  var wi
  var ev
  var dur
  var info
  var step = false
  B.next = 0
  if (!want) {
    B.cur = null
    return
  }
  prev = (B.cur && now < B.until) ? B.cur : null
  cls = want
  next = want
  if (prev && prev !== want) {
    if (now - B.changed >= 80 || R.vac) {
      ci = PNE_RES_BED_ORDER.indexOf(prev)
      wi = PNE_RES_BED_ORDER.indexOf(want)
      if (R.vac && prev === 'dry' && want === 'muffled' && pneResPool('L1', 't_dry_muffled').length) {
        cls = 't_dry_muffled'
        next = 'muffled'
      } else if (wi > ci) {
        next = PNE_RES_BED_ORDER[ci + 1]
        cls = pneResPool('L1', 't_' + prev + '_' + next).length ? 't_' + prev + '_' + next : next
      } else {
        next = PNE_RES_BED_ORDER[ci - 1]
        cls = next
      }
      step = true
    } else {
      cls = prev
      next = prev
    }
  }
  if (!pneResPool('L1', cls).length) {
    cls = next
    if (!pneResPool('L1', cls).length) cls = 'dry'
    if (!pneResPool('L1', cls).length) {
      B.cur = null
      return
    }
  }
  ev = pneResLayer(R, 'L1', cls, '~ ~12 ~', 1, false, now)
  if (!ev) {
    B.cur = prev
    B.next = now + 20
    pneResSched(R, B.next, 'bed', null)
    return
  }
  if (step) B.changed = now
  B.cur = next
  // the vacuum is in place once a segment ending on 'muffled' was actually issued (the transition, or a
  // muffled segment when the bed was already muffled): only then is the approach scheduled, 2-4 s later
  if (R.vacPending > 0 && next === 'muffled') {
    R.vacPending = 0
    pneResSched(R, now + 40 + Math.floor(pneResRand(R) * 41), 'app', null)
  }
  info = pneResInfo(ev, null)
  dur = info ? Math.max(40, Math.ceil(info.dur * 20)) : 140
  B.until = now + dur
  if (R.tier === 0 && R.mode !== 'panic' && !R.vac) {
    if (B.runLeft <= 0) {
      B.runLeft = 2 + Math.floor(pneResRand(R) * 4)
      B.runStart = now
    }
    B.runLeft--
    if (B.runLeft <= 0) {
      B.gapUntil = now + dur + Math.max(200, Math.ceil((now + dur - B.runStart) * (0.5 + 0.5 * pneResRand(R))))
      return
    }
  } else B.runLeft = 0
  B.next = now + dur - 30
  pneResSched(R, B.next, 'bed', null)
}

function pneResAudio(player, R, out, now) {
  var tg = pneResTags(R, player)
  var comfort = tg.cf
  var cat = pneResCat()
  var night
  var horde
  var tierName
  var cls
  var pool
  var ids
  var mean
  var fl
  var lfCls
  var k
  var pick
  R.comfort = comfort
  R.tier = out.tier
  if (out.state === 'RELEASE' && R.prevState !== 'RELEASE') R.relStart = now
  if (out.state !== 'RELEASE') R.relStart = -1
  if (out.state !== 'PANIC') R.panicSeen = false
  // PANIC and RELEASE keep their overrides under mercy or grace (each override can only lower the audio);
  // mercy/grace additionally remove L2, L3, L4, L6 and L7 in every mode (R.vuln, also enforced by the ledger)
  R.vuln = R.pace.mercy === true || R.pace.grace === true
  R.mode = out.state === 'PANIC' ? 'panic' : (out.state === 'RELEASE' ? 'release' : (R.vuln ? 'vuln' : 'normal'))
  if (!cat || !pneCoreOn('resonance') || tg.off) {
    R.want = null
    R.q = []
    R.bed.next = 0
    R.bed.cur = null
    R.vac = false
    R.vacPending = 0
    R.app = null
    return
  }
  if (R.mode !== 'normal' || out.tier < 2) {
    // an approach in progress needs DREAD in normal mode; otherwise it is dropped (the vacuum clears)
    if (R.vac || R.vacPending || pneResHas(R, 'app')) {
      R.vac = false
      R.vacPending = 0
      pneResDrop(R, 'app')
      pneResDrop(R, 'pay')
      pneResDrop(R, 'vacEnd')
    }
  }
  // L1 bed
  R.want = pneResBedWant(R, out, now)
  if (R.want && R.bed.next === 0) pneResBedIssue(R, now)
  night = pneResNight(pneResServerOf(player))
  horde = tg.horde === true
  tierName = PNE_RES_TIERS[out.tier]
  // L5 whispers (QUIET: night only 360/120 s; UNEASE 240/90; DREAD 120/45; night doubles the hazard)
  if (R.mode === 'normal' || R.mode === 'vuln') {
    if (R.mode === 'vuln' || tierName === 'QUIET') {
      mean = night ? 360 : 0
      fl = 120
    } else if (tierName === 'UNEASE') {
      mean = night ? 120 : 240
      fl = 90
    } else {
      mean = night ? 60 : 120
      fl = 45
    }
    if (mean > 0 && pneResHazard(R, R.last.wh, fl, mean, now)) {
      cls = (tierName === 'DREAD' && R.mode === 'normal') ? 'near' : 'amb'
      pool = cls
      if (R.clade >= 0 && R.clade <= 3 && pneResPool('L5', cls + '_c' + R.clade).length >= 3) pool = cls + '_c' + R.clade
      if (pneResLayer(R, 'L5', pool, '^ ^1 ^-6', 0.55, true, now)) R.last.wh = now
    }
  }
  // L2 / L3 (LF-periodic, one at a time; the ledger enforces A8)
  if (R.mode === 'normal' && tierName === 'UNEASE' && !comfort && !horde && R.stage >= 1) {
    if (now - R.last.L2 >= 1200) {
      if (R.win2 !== R.last.L2) {
        R.win2 = R.last.L2
        R.winOk = pneResRand(R) < 0.5
        if (!R.winOk) R.last.L2 = now
      }
      if (R.winOk && pneResLayer(R, 'L2', 'a', '~ ~12 ~', 1, false, now)) R.last.L2 = now
    }
  } else if (R.mode === 'normal' && tierName === 'DREAD') {
    if (pneResRand(R) < 1 / 20) {
      lfCls = []
      if (comfort) {
        if (now - R.last.L3 >= 2400) lfCls.push(['L3', 'heartbeat_c'])
      } else {
        if (!horde && now - R.last.L2 >= 1200 && R.stage >= 1) lfCls.push(['L2', 'a'])
        if (now - R.last.L3 >= 2400) {
          lfCls.push(['L3', 'heartbeat'])
          lfCls.push(['L3', 'flutter'])
          lfCls.push(['L3', 'rough'])
        }
      }
      ids = []
      for (k = 0; k < lfCls.length; k++) {
        if (pneResPool(lfCls[k][0], lfCls[k][1]).length) ids.push(lfCls[k])
      }
      if (ids.length) {
        pick = ids[Math.floor(pneResRand(R) * ids.length)]
        if (pneResLayer(R, pick[0], pick[1], '~ ~12 ~', 1, false, now)) R.last[pick[0]] = now
      }
    }
  } else if (R.mode === 'panic') {
    // the heartbeat is the only layer PANIC keeps, and mercy/grace remove it too
    if (!R.vuln && now - R.last.L3 >= 2400 && pneResRand(R) < 1 / 8) {
      if (pneResLayer(R, 'L3', comfort ? 'heartbeat_c' : 'heartbeat', '~ ~12 ~', 1, false, now)) R.last.L3 = now
    }
    // L7 only on the first sighting in this PANIC (TDD 2.5.4): a line-of-sight report from this tick's ORACLE
    // snapshot. Probe sensing has no line of sight, so it never plays the PANIC stinger.
    if (!R.panicSeen && R.sense && R.sense.src === 'snap' && R.sense.seen === true) {
      R.panicSeen = true
      if (!comfort && !R.vuln) pneResLayer(R, 'L7', 'a', '^ ^1 ^-6', 1, true, now)
    }
  }
  // L4 beat (UNEASE: slow; DREAD: tense, slow in comfort)
  if (R.mode === 'normal' && out.tier >= 1 && pneResHazard(R, R.last.L4, 30, 60, now)) {
    cls = (out.tier === 2 && !comfort) ? 'tense' : 'slow'
    if (pneResLayer(R, 'L4', cls, '~ ~12 ~', 1, false, now)) R.last.L4 = now
  }
  // L6 approach with a vacuum before it (L0 b); 50% payoff with L7 in normal mode, never in comfort
  if (R.mode === 'normal' && tierName === 'DREAD' && !R.vac && !R.vacPending && !pneResHas(R, 'app') &&
      !tg.ap && pneResPool('L6', comfort ? 'c' : 'n').length &&
      pneResHazard(R, R.last.L6, 90, 150, now)) {
    R.last.L6 = now
    R.vac = true
    if (R.bed.next > 0) R.vacPending = now
    else pneResSched(R, now + 40 + Math.floor(pneResRand(R) * 41), 'app', null)
    pneResSched(R, now + 400, 'vacEnd', null)
  }
}

// Due queue items and the PANIC drain, every tick (cheap bookkeeping).
function pneResQueueTick(R, now) {
  var due = []
  var keep = []
  var i
  var it
  var ev
  var info
  var cls
  for (i = 0; i < R.q.length; i++) {
    if (R.q[i].at <= now) due.push(R.q[i])
    else keep.push(R.q[i])
  }
  R.q = keep
  for (i = 0; i < due.length; i++) {
    it = due[i]
    if (it.kind === 'bed') {
      R.want = R.player ? pneResBedWant(R, { tier: R.tier }, now) : null
      pneResBedIssue(R, now)
    } else if (it.kind === 'app') {
      if (R.mode !== 'normal' || R.tier < 2) continue
      cls = R.comfort ? 'c' : 'n'
      ev = pneResLayer(R, 'L6', cls, '^ ^1 ^-8', 1, true, now)
      pneResDrop(R, 'vacEnd')
      if (ev) {
        info = pneResInfo(ev, null)
        if (!R.comfort && pneResRand(R) < 0.5) pneResSched(R, now + Math.ceil(info.dur * 20), 'pay', null)
        pneResSched(R, now + Math.ceil(info.dur * 20) + 20, 'vacEnd', null)
      } else pneResSched(R, now + 20, 'vacEnd', null)
    } else if (it.kind === 'pay') {
      if (R.mode === 'normal' && !R.comfort) pneResLayer(R, 'L7', 'a', '^ ^1 ^-8', 1, true, now)
    } else if (it.kind === 'vacEnd') {
      R.vac = false
      R.vacPending = 0
    }
  }
  if (R.mode === 'panic') pneResDrain(R, now)
}

// A5: in PANIC the director stops issuing L1, L2, L3 flutter/rough and L4; tracked instances end on their
// baked fades. A /stopsound is sent only for an instance already inside its fade-out (half way in), never
// before the fade starts, and only when no other instance of that event is still before its fade.
function pneResDrain(R, now) {
  var L = R.led
  var i
  var j
  var x
  var y
  var busy
  var srv = pneCoreServer
  for (i = 0; i < L.inst.length; i++) {
    x = L.inst[i]
    if (x.stopped || !x.fade || x.t0 > now || now >= x.t1) continue
    if (x.cls === 'heartbeat' || x.cls === 'heartbeat_c') continue
    if (now < x.t1 - Math.floor(x.fade / 2)) continue
    busy = false
    for (j = 0; j < L.inst.length; j++) {
      y = L.inst[j]
      if (j !== i && y.ev === x.ev && !y.stopped && y.t0 <= now && now < y.t1 - y.fade) busy = true
    }
    if (busy || !srv || !pneResStarted()) continue
    srv.runCommandSilent('stopsound ' + R.u + ' ' + x.cat + ' ' + x.ev)
    pneCoreTake(PNE_CORE_COST.emit)
    pneResStats.stopped++
    x.stopped = true
    x.t1 = now
  }
}

// ---------------------------------------------------------------------------------------------
// First-run notice, commands, status

var PNE_RES_NOTICE = [
  ['The Hive Remembers uses sound to unsettle you: low-frequency throbs, whispers and approaching sounds.', 'gold'],
  ['Comfort mode is ON for everyone by default: only a soft, rare heartbeat throb, no jump-scare stingers, gentler approaches and smaller level jumps. /pne comfort off opts out, /pne comfort on turns it back on.', 'gray'],
  ['Switch single layers off for yourself: /pne resonance whispers off, /pne resonance throb off, /pne resonance approach off, /pne resonance stingers off. /pne resonance self off silences all of them.', 'gray'],
  ['The vanilla sliders work too (Options, Music & Sounds): Ambient/Environment, Voice/Speech and Hostile Creatures.', 'gray'],
  ['/pne audio shows this again.', 'dark_gray']
]

// true when the tellraw command was issued: false before the server started (rule 15 (a)) or when it threw. The
// command's own result is not trusted either way (rule 15 (c)).
function pneResTellraw(server, u, text, color) {
  if (!server || !pneResStarted()) return false
  try {
    server.runCommandSilent('tellraw ' + u + ' ' + JSON.stringify({ text: String(text), color: color || 'gray' }))
    return true
  } catch (e) {
    return false
  }
}

// true only when every line of the notice was issued (so pne_notice_v is recorded only for a notice that was sent).
function pneResShowNotice(server, player) {
  var u = pneCoreUuid(player)
  var i
  var all = true
  if (!u || !server) return false
  for (i = 0; i < PNE_RES_NOTICE.length; i++) {
    if (!pneResTellraw(server, u, PNE_RES_NOTICE[i][0], PNE_RES_NOTICE[i][1])) all = false
  }
  return all
}

function pneResNoticeTick(server) {
  var keep = []
  var ps
  var i
  var j
  var p
  var pd
  var seen
  if (!pneResNoticeQ.length) return
  ps = pneCoreAllPlayers(server)
  for (i = 0; i < pneResNoticeQ.length; i++) {
    if (pneResNoticeQ[i].at > pneCoreTick) {
      keep.push(pneResNoticeQ[i])
      continue
    }
    for (j = 0; j < ps.length; j++) {
      p = ps[j]
      if (pneCoreUuid(p) !== pneResNoticeQ[i].u) continue
      pd = pneCorePD(p)
      seen = 0
      try { seen = Number(pd.getInt('pne_notice_v')) } catch (e) { seen = 0 }
      if (seen < PNE_RES_NOTICE_V && pneResShowNotice(server, p)) {
        try { pd.putInt('pne_notice_v', PNE_RES_NOTICE_V) } catch (e2) { }
      }
    }
  }
  pneResNoticeQ = keep
}

function pneResOnLogin(event) {
  var u
  if (!PNE_RES_B_EVENTS || PNE_RES_B_EVENTS.off) return
  try {
    u = pneCoreUuid(event.player)
    if (u && pneResNoticeQ.length < 256) pneResNoticeQ.push({ u: u, at: pneCoreTick + 60 })
  } catch (err) {
    pneCoreFail(PNE_RES_B_EVENTS, err)
  }
}

function pneResCmdComfort(ctx) {
  var a = ctx.args.length ? String(ctx.args[0]).toLowerCase() : ''
  if (ctx.args.length > 1 || (a !== '' && a !== 'on' && a !== 'off')) return false
  if (!ctx.player) {
    ctx.reply('Comfort mode is per player; run it as a player.', 'red')
    return true
  }
  if (a === 'on') pneCoreSetTag(ctx.player, PNE_CORE_TAG_COMFORT_OFF, false)
  if (a === 'off') pneCoreSetTag(ctx.player, PNE_CORE_TAG_COMFORT_OFF, true)
  pneResTagsDirty(ctx.player)
  ctx.reply('Comfort mode is ' + (pneCoreComfort(ctx.player) ? 'ON' : 'OFF') + ' for you.' +
    (pneCoreComfort(ctx.player) ? '' : ' Stingers, all throb patterns and full approaches can now play. /pne comfort on restores it.'), 'gold')
  return true
}

function pneResCmdAudio(ctx) {
  if (ctx.args.length) return false
  if (!ctx.player) {
    ctx.reply(PNE_RES_NOTICE[0][0])
    return true
  }
  pneResShowNotice(ctx.server, ctx.player)
  return true
}

function pneResCmdLayer(ctx) {
  var w = ctx.args.length ? String(ctx.args[0]).toLowerCase() : ''
  var a = ctx.args.length > 1 ? String(ctx.args[1]).toLowerCase() : ''
  var tag
  if (ctx.args.length !== 2 || (a !== 'on' && a !== 'off')) return false
  if (w === 'self') tag = PNE_RES_TAG_OFF
  else if (PNE_RES_TAG_SW.hasOwnProperty(w)) tag = PNE_RES_TAG_SW[w]
  else return false
  if (!ctx.player) {
    ctx.reply('Layer switches are per player; run it as a player.', 'red')
    return true
  }
  pneCoreSetTag(ctx.player, tag, a === 'off')
  pneResTagsDirty(ctx.player)
  ctx.reply((w === 'self' ? 'All Resonance audio' : 'Resonance ' + w) + ' is ' + a.toUpperCase() + ' for you.', 'gold')
  return true
}

function pneResCmdStatus(ctx) {
  if (ctx.args.length !== 1 || String(ctx.args[0]).toLowerCase() !== 'status') return false
  ctx.reply(pneResStatusLine(ctx.player), 'gold')
  return true
}

function pneResStatusLine(player) {
  var c = pneResCat()
  var p = player ? pneResPace(player) : null
  var pd
  var m = 1
  var sw = []
  var k
  var head = 'catalog ' + (c ? c.n : 0) + ' events; issued ' + pneResStats.issued + ', refused ' + pneResStats.refused +
    ', drained ' + pneResStats.stopped + ', tells ' + pneResStats.tells
  if (!player) return head
  pd = pneCorePD(player)
  try { m = Number(pd.getDouble('pne_m')) } catch (e) { m = 1 }
  for (k in PNE_RES_TAG_SW) {
    if (PNE_RES_TAG_SW.hasOwnProperty(k) && pneCoreHasTag(player, PNE_RES_TAG_SW[k])) sw.push(k + ' off')
  }
  if (pneCoreHasTag(player, PNE_RES_TAG_OFF)) sw.push('all off')
  if (!p) return 'no pacing yet (survival players only); comfort ' + (pneCoreComfort(player) ? 'on' : 'off') + '; ' + head
  return 'state ' + p.state + ', tier ' + p.tier + ', e ' + pneCoreFmt(p.e) + ', theta ' + pneCoreFmt(p.theta) +
    ', m ' + pneCoreFmt(m) + ', spawn ' + pneCoreFmt(p.spawn) + ', aggro ' + pneCoreFmt(p.aggro) +
    (p.mercy ? ', mercy' : '') + (p.grace ? ', grace' : '') + ', comfort ' + (pneCoreComfort(player) ? 'on' : 'off') +
    (sw.length ? ', ' + sw.join(', ') : '') + ', sensing ' + p.sense + (p.fresh ? ' + oracle' : '') + '; ' + head
}

// Resonance pillar OFF: pacing stops, layers stop, pne_gate / pne_pace_soft removed from every online player.
function pneResOnToggle(on, server) {
  var ps
  var i
  var k
  if (on) return
  ps = pneCoreAllPlayers(server)
  for (i = 0; i < ps.length; i++) {
    pneCoreSetTag(ps[i], PNE_CORE_TAG_GATE, false)
    pneCoreSetTag(ps[i], PNE_CORE_TAG_PACE_SOFT, false)
  }
  for (k in pneResP) {
    if (!pneResP.hasOwnProperty(k)) continue
    pneResP[k].q = []
    pneResP[k].bed.next = 0
    pneResP[k].bed.cur = null
    pneResP[k].want = null
    pneResP[k].vac = false
    pneResP[k].vacPending = 0
    pneResP[k].app = null
    pneResP[k].mode = 'normal'
    pneResP[k].vuln = false
  }
}

// Housekeeping at slot 5: the notice queue and state of players who left.
function pneResHouse(server) {
  var k
  pneResNoticeTick(server)
  for (k in pneResP) {
    if (pneResP.hasOwnProperty(k) && pneCoreTick - pneResP[k].seen > 1200) delete pneResP[k]
  }
}

function pneResOnTick(event) {
  var srv = event.server
  var players
  var i
  var k
  var R
  var on
  if (!PNE_RES_B_TICK || PNE_RES_B_TICK.off) return
  try {
    on = pneCoreOn('resonance')
    if (on) {
      for (k in pneResP) {
        if (!pneResP.hasOwnProperty(k)) continue
        R = pneResP[k]
        if (R.q.length || R.mode === 'panic') pneResQueueTick(R, pneCoreTick)
      }
      players = pneCorePlayersAtSlot(srv)
      for (i = 0; i < players.length; i++) {
        if (!pneCoreTake(PNE_CORE_COST.director)) break
        pneResStep(players[i])
      }
    }
    if (pneCoreSlot === PNE_CORE_SLOT_HOUSE) pneResHouse(srv)
    pneCoreOk(PNE_RES_B_TICK)
  } catch (err) {
    pneCoreFail(PNE_RES_B_TICK, err)
  }
}

function pneResCmdGuard(fn) {
  return function (ctx) {
    if (PNE_RES_B_CMD.off) return false
    try {
      return fn(ctx)
    } catch (err) {
      pneCoreFail(PNE_RES_B_CMD, err)
      ctx.reply('That command failed; see the server log.', 'red')
      return true
    }
  }
}

if (!pneResReady) console.error('[pne_resonance] pne_00_core.js did not load; the director stays off')
if (pneResReady) {
  ServerEvents.tick(pneResOnTick)
  PlayerEvents.loggedIn(pneResOnLogin)
  pneCoreOnToggle('resonance', pneResOnToggle)
  pneCoreCommand('comfort', { run: pneResCmdGuard(pneResCmdComfort), help: 'comfort [on|off]: your own comfort mode (on by default)' })
  pneCoreCommand('audio', { run: pneResCmdGuard(pneResCmdAudio), help: 'audio: what the horror audio does and how to switch it' })
  pneCoreCommand('resonance', { run: pneResCmdGuard(pneResCmdLayer), help: 'resonance whispers|throb|approach|stingers|self on|off: your own sound layers' })
  pneCoreCommand('resonance', { run: pneResCmdGuard(pneResCmdStatus), help: 'resonance status: your pacing state, audio tier, e, theta and m' })
  pneCoreStatus('resonance', pneResStatusLine)
}
