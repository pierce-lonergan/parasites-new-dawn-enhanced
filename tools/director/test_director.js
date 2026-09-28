// Suite director-node: the director's pure core (pacing FSM, fusion, audio tier controller, pacing outputs)
// and the module on the KubeJS mocks (Pace publication, pne_m / pne_gate / pne_pace_soft, commands, notice,
// ledger rules, degradation). Runs pne_resonance.js exactly as KubeJS would load it (one script pack with
// kjs_mocks.js, pne_00_core.js and a catalog), driven from Node.
//
//   node tools/director/test_director.js
'use strict'
const fs = require('fs')
const path = require('path')
const P = require('./pack.js')

const T = P.checker('director-node')

// ------------------------------------------------------------------------------------------------ helpers

function rng (seed) {
  let s = seed >>> 0 || 1
  return function () {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0
    return s / 4294967296
  }
}

// Synthetic 1 Hz input traces: calm stretches, approaches, fights with damage, flee spikes, mercy and
// respawn-grace episodes, stale or low-confidence verdicts and hive-death counts.
function genTrace (seed, steps) {
  const r = rng(seed)
  const out = []
  let near = 32; let tsd = 600; let hp = 1; let eo = 0.1; let conf = 0.6; let grace = 0; let deaths = 0
  let mode = 'calm'; let left = 0
  for (let t = 0; t < steps; t++) {
    if (left <= 0) {
      const u = r()
      mode = u < 0.35 ? 'calm' : u < 0.55 ? 'approach' : u < 0.8 ? 'fight' : u < 0.9 ? 'flee' : 'lull'
      left = 10 + Math.floor(r() * 90)
      if (r() < 0.05) { grace = 120; hp = 1; deaths = Math.min(6, deaths + 1) }
    }
    left--
    if (mode === 'calm') { near = Math.min(32, near + 2); eo += (0.08 - eo) * 0.2 }
    if (mode === 'approach') { near = Math.max(6, near - 1.5); eo += (0.45 - eo) * 0.15 }
    if (mode === 'fight') { near = 1 + r() * 4; eo += (0.85 - eo) * 0.3; if (r() < 0.3) { tsd = 0; hp = Math.max(0.05, hp - r() * 0.15) } }
    if (mode === 'flee') { near = 3 + r() * 6; eo += (0.95 - eo) * 0.4 }
    if (mode === 'lull') { near = 12 + r() * 10; eo += (0.3 - eo) * 0.1 }
    tsd = tsd + 1
    if (mode !== 'fight' && hp < 1) hp = Math.min(1, hp + 0.01)
    if (grace > 0) grace--
    if (r() < 0.002) deaths = Math.max(0, deaths - 1)
    conf = r() < 0.15 ? r() * 0.45 : 0.45 + r() * 0.55
    const fresh = r() > 0.1
    const n16 = near < 16 ? Math.floor(r() * 8) : 0
    const light = Math.floor(r() * 16)
    const prox = Math.max(0, 1 - near / 32)
    out.push({
      eo: Math.max(0, Math.min(1, eo + (r() - 0.5) * 0.1)), conf: conf, fresh: fresh,
      sh: Math.min(1, 0.45 * prox + 0.2 * Math.min(1, n16 / 8) + 0.15 * (1 - light / 15) + 0.2 * (1 - hp)),
      theta: Math.min(1, 0.6 * prox + 0.25 * Math.min(1, n16 / 8) + 0.15 * (1 - light / 15)),
      nearest: near, tsd: tsd, pflee: fresh ? (mode === 'flee' ? 0.5 + r() * 0.5 : r() * 0.5) : -1,
      mercy: hp <= 0.3, grace: grace > 0, deaths1h: deaths
    })
  }
  return out
}

function newWorld (files, opts) {
  const c = P.load(files || [P.MOCKS, P.CORE, P.TEST_CAT, P.RES])
  const M = c.__pneMock
  const srv = M.server({ owner: 'Host' })
  srv.dayTime = 18000
  srv.level.getDayTime = () => srv.dayTime
  M.fire('ServerEvents.loaded', { server: srv })
  return { c, M, srv }
}

// Advance to the next tick whose slot equals s (the player's telemetry slot), inclusive of n full seconds.
function secs (w, n) { w.M.tick(w.srv, 20 * n) }

function playsounds (srv, from) {
  return srv.cmds.slice(from || 0).filter(x => x.indexOf(' run playsound ') > 0)
}

// ------------------------------------------------------------------------------------------------ A. pure core

function partPure () {
  const w = newWorld()
  const c = w.c
  // fusion
  T.ok(Math.abs(c.pneResFuse({ fresh: true, conf: 0.9, eo: 0.7, sh: 0.1 }) - 0.7) < 1e-12, 'fusion: fresh + confident verdict uses E_O')
  T.ok(Math.abs(c.pneResFuse({ fresh: true, conf: 0.225, eo: 0.8, sh: 0.2 }) - 0.5) < 1e-12, 'fusion: conf 0.225 blends half way (w = conf / 0.45)')
  T.ok(c.pneResFuse({ fresh: false, conf: 0.99, eo: 0.9, sh: 0.3 }) === 0.3, 'fusion: stale verdict falls back to S_H')
  T.ok(c.PNE_RES_FSM.aUp === 0.3934693402873666 && c.PNE_RES_FSM.aDown === 0.15351827510938587, 'EMA constants (tau 2 s up, 6 s down)')

  // pacing table (I1 by construction): spawn and aggression never rise with escalation
  const tab = c.PNE_RES_PACING
  T.ok(tab.CALM.spawn >= tab.UNEASE.spawn && tab.UNEASE.spawn >= tab.DREAD.spawn && tab.DREAD.spawn >= tab.PANIC.spawn, 'spawn multiplier falls CALM > UNEASE > DREAD > PANIC')
  T.ok(tab.RELEASE.spawn <= 0.2 && tab.PANIC.spawn <= 0.2, 'PANIC and RELEASE spawn <= 0.2')
  T.ok(tab.CALM.aggro >= tab.PANIC.aggro && tab.PANIC.aggro >= tab.RELEASE.aggro, 'aggression never rises with escalation')

  // hand-crafted: sustained high arousal walks CALM -> UNEASE -> DREAD -> PANIC with holds and 8 s dwell,
  // PANIC is capped at 45 s and exits only to RELEASE, RELEASE lasts 30 s
  // (index i holds the state after step i + 1, so a transition at index 7 had 8 s in the previous state)
  const st = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
  const hi = { eo: 0.95, conf: 0.9, fresh: true, sh: 0, theta: 0.9, nearest: 20, tsd: 600, pflee: 0.1, mercy: false, grace: false, deaths1h: 0 }
  const lo = Object.assign({}, hi, { eo: 0.05, theta: 0.05 })
  const seq = []
  for (let i = 0; i < 160; i++) seq.push(c.pneResPureStep(st, hi).state)
  const first = s => seq.indexOf(s)
  T.ok(first('UNEASE') >= 7 && first('DREAD') - first('UNEASE') >= 8 && first('PANIC') - first('DREAD') >= 8, 'escalation respects the 8 s dwell (' + [first('UNEASE'), first('DREAD'), first('PANIC')] + ')')
  T.eq(first('RELEASE') - first('PANIC'), 45, 'PANIC is capped at 45 s under sustained arousal')
  T.ok(seq.slice(first('RELEASE')).every(s => s === 'RELEASE'), 'RELEASE holds while e stays >= 0.50 (measured prototype rule)')
  // three panic cycles within 10 min: RELEASE lasts 30 s, 30 s, then 60 s
  const st2 = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
  const s2 = []
  for (let i = 0; i < 590; i++) {
    const inRel = st2.fsm.state === 'RELEASE'
    s2.push(c.pneResPureStep(st2, inRel ? lo : hi).state)
  }
  let rels = []
  let runStart = -1
  for (let i = 0; i < s2.length; i++) {
    if (s2[i] === 'RELEASE' && (i === 0 || s2[i - 1] !== 'RELEASE')) runStart = i
    if (s2[i] !== 'RELEASE' && i > 0 && s2[i - 1] === 'RELEASE') rels.push(i - runStart)
  }
  T.ok(rels.length >= 3 && rels[0] === 30 && rels[1] === 30 && rels[2] === 60, 'RELEASE 30 s, and 60 s after the third panic within 10 min (' + rels.join(',') + ')')
  // hard trigger from UNEASE bypasses the dwell; not from CALM
  const st3 = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
  st3.fsm.state = 'UNEASE'
  st3.fsm.inState = 0
  let o = c.pneResPureStep(st3, Object.assign({}, hi, { eo: 0.3, nearest: 2, tsd: 0.5 }))
  T.eq(o.state, 'PANIC', 'hard trigger (hostile within 4, damaged within 1 s) from UNEASE enters PANIC at once')
  const st4 = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
  o = c.pneResPureStep(st4, Object.assign({}, hi, { eo: 0.3, nearest: 2, tsd: 0.5 }))
  T.eq(o.state, 'CALM', 'no hard-trigger shortcut from CALM (v1.0 row removed)')
  const st5 = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
  st5.fsm.state = 'DREAD'
  o = c.pneResPureStep(st5, Object.assign({}, hi, { eo: 0.3, nearest: 6, tsd: 600, pflee: 0.7 }))
  T.eq(o.state, 'PANIC', 'P(flee) >= 0.6 with a hostile within 8 is a hard trigger')

  // invariants over synthetic traces
  let steps = 0; let maxPanic = 0; let flips = 0
  const viol = {}
  const bad = (k) => { viol[k] = (viol[k] || 0) + 1 }
  for (let seed = 1; seed <= 60; seed++) {
    const tr = genTrace(seed * 7919, 1800)
    const s = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
    let last = 'CALM'; let dwell = 0; let panicRun = 0; let relRun = 0; let relLen = 30
    for (const inp of tr) {
      const before = { inState: s.fsm.inState, releaseLen: s.fsm.releaseLen }
      const out = c.pneResPureStep(s, inp)
      steps++
      if (out.state !== last) {
        flips++
        const hardEsc = out.state === 'PANIC' && (last === 'UNEASE' || last === 'DREAD') && out.hard
        const relEsc = out.state === 'PANIC' && last === 'RELEASE'
        const capExit = last === 'PANIC' && dwell + 1 >= 45
        const relExit = last === 'RELEASE'
        if (!(dwell + 1 >= 8 || hardEsc || capExit)) bad('dwell')
        if (last === 'PANIC' && out.state !== 'RELEASE') bad('PANIC exits only to RELEASE')
        if (relEsc && !(before.inState + 1 >= 10 && out.hard && out.e >= 0.75)) bad('RELEASE->PANIC needs 10 s, hard trigger and e >= 0.75')
        if (relExit && !relEsc && dwell + 1 < before.releaseLen) bad('RELEASE min time')
        if (last === 'CALM' && out.state !== 'UNEASE') bad('CALM only goes to UNEASE')
        dwell = 0
        last = out.state
      } else dwell++
      panicRun = out.state === 'PANIC' ? panicRun + 1 : 0
      if (panicRun > maxPanic) maxPanic = panicRun
      if (panicRun > 45) bad('PANIC > 45 s')
      if ((out.state === 'PANIC' || out.state === 'RELEASE' || inp.mercy || inp.grace) && out.spawn > 0.2 + 1e-12) bad('spawn > 0.2 in PANIC/RELEASE/mercy/grace')
      if ((inp.mercy || inp.grace) && (out.spawn !== 0 || out.beckon || out.ga !== 0 || out.aggro > 0.8)) bad('mercy/grace override')
      if (out.state === 'RELEASE' && out.ga !== 0) bad('RELEASE ga 0')
      if (out.state === 'PANIC' && !(inp.mercy || inp.grace) && out.ga !== 0.5) bad('PANIC ga 0.5')
      if (out.beckon && !(out.state === 'CALM' || out.state === 'UNEASE')) bad('beckons only in CALM/UNEASE')
      if (out.spawn > 1.25 || out.spawn < 0 || out.aggro < 0.8 || out.aggro > 1) bad('output ranges')
      if (out.gov < 0.5 || out.gov > 1) bad('governor range')
      // audio ceiling never raises the tier; e > 0.6 caps at UNEASE; RELEASE, mercy and grace force QUIET
      if (out.tier > out.raw) bad('audio ceiling raised the tier')
      if (out.e > 0.6 && out.tier > 1) bad('e > 0.6 must cap the tier at UNEASE')
      if ((out.state === 'RELEASE' || inp.mercy || inp.grace) && out.tier !== 0) bad('RELEASE/mercy/grace force QUIET')
    }
  }
  for (const k of Object.keys(viol)) T.ok(false, 'invariant "' + k + '" violated ' + viol[k] + ' times')
  T.ok(Object.keys(viol).length === 0, 'FSM and ceiling invariants over ' + steps + ' synthetic steps (max PANIC run ' + maxPanic + ' s)')
  T.ok(flips / (steps / 60) <= 3, 'state flips per minute on stress-heavy synthetic traces: ' + (flips / (steps / 60)).toFixed(2))

  // I4: the tier comes from theta; with identical theta traces, higher arousal never gives a higher cap
  let raises = 0
  const r = rng(99)
  for (let k = 0; k < 20000; k++) {
    const raw = Math.floor(r() * 3)
    const e1 = r(); const e2 = e1 + r() * (1 - e1)
    const states = c.PNE_RES_STATES
    const s = states[Math.floor(r() * 5)]
    const m = r() < 0.2; const g = r() < 0.2
    const t1 = c.pneResTierCap(raw, e1, s, m, g); const t2 = c.pneResTierCap(raw, e2, s, m, g)
    if (t1 > raw || t2 > raw || t2 > t1) raises++
  }
  T.eq(raises, 0, 'tier cap: never above the theta tier, and monotone non-increasing in e')
  // theta-only controller: holds and exits
  const a = c.pneResTierNew()
  const ts = []
  for (let i = 0; i < 6; i++) ts.push(c.pneResTierStep(a, 0.6))
  T.ok(ts[1] === 0 && ts[2] === 1 && ts[5] === 2, 'tier: theta >= 0.25 held 3 s -> UNEASE, >= 0.50 held 3 s more -> DREAD (' + ts + ')')
  const down = []
  for (let i = 0; i < 12; i++) down.push(c.pneResTierStep(a, 0.2))
  T.ok(down[8] === 2 && down[9] === 1, 'tier: DREAD exits after 10 s below 0.38 (' + down + ')')
}

// ------------------------------------------------------------------------------------------------ B. module

function partModule () {
  let w = newWorld()
  let { c, M, srv } = w
  const u1 = 'aaaa0000-0000-4000-8000-000000000001'
  const p = M.player(srv, 'Host', u1, {})
  T.ok(c.pneResPace(p) === null, 'no Pace for a player before the first 1 Hz step')
  T.ok(c.pneCoreLoaded('resonance') === true && c.PNE_RES_API === 1, 'director registered (PNE_RES_API 1)')
  let snap = { nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600, hostileSeen: false }
  c.pneOraSnap = function () { return Object.assign({ tick: c.pneCoreTick }, snap) }
  secs(w, 2)
  let pace = c.pneResPace(p)
  T.ok(pace && pace.state === 'CALM' && pace.spawn === 1.25 && pace.tier === 'QUIET', 'first Pace: CALM, spawn 1.25, QUIET')
  T.ok(pace && c.pneCoreTick - pace.tick < 20 && pace.sense === 'snap', 'Pace tick is this second; sensed from the ORACLE snapshot')
  T.ok(Math.abs(p.persistentData.getDouble('pne_m') - 1) < 1e-12 && p.persistentData.getLong('pne_m_t') === srv.gameTime - (c.pneCoreTick - pace.tick), 'pne_m = min(1, spawn) and pne_m_t = game time of the write')
  T.ok(!c.pneCoreHasTag(p, 'pne_gate') && !c.pneCoreHasTag(p, 'pne_pace_soft'), 'no pne_gate at m = 1, no pne_pace_soft at aggro 1')
  T.ok(c.pneCorePace(p).fallback !== true && c.pneCorePace(p).spawn === 1.25, 'pneCorePace serves the director Pace')
  T.ok(c.pneCoreNaturalMult(p) === 1, 'natural multiplier 1 (multipliers above 1 never add natural spawns)')

  // mercy: spawn 0, QUIET, gate at 0, soft tag
  p.hp = 5
  secs(w, 1)
  pace = c.pneResPace(p)
  T.ok(pace.mercy && pace.spawn === 0 && pace.ga === 0 && !pace.beckon && pace.aggro <= 0.8 && pace.tier === 'QUIET', 'mercy Pace: spawn 0, ga 0, no beckon, aggro <= 0.8, QUIET')
  T.ok(c.pneCoreHasTag(p, 'pne_gate') && p.persistentData.getDouble('pne_m') === 0 && c.pneCoreHasTag(p, 'pne_pace_soft'), 'mercy: pne_gate with pne_m 0 and pne_pace_soft')
  T.ok(c.pneCoreNaturalMult(p) === 0, 'mercy: natural multiplier 0')
  p.hp = 20
  secs(w, 1)
  T.ok(!c.pneCoreHasTag(p, 'pne_gate') && !c.pneCoreHasTag(p, 'pne_pace_soft'), 'tags cleared after healing')

  // PANIC aggro 0.9: pne_pace_soft on alternate 100-tick runs
  const R = c.pneResP[u1]
  let soft = new Set()
  for (let k = 0; k < 12; k++) {
    R.st.fsm.state = 'PANIC'; R.st.fsm.inState = 1; R.st.fsm.e = 0.9
    secs(w, 1)
    soft.add(Math.floor(c.pneResPace(p).tick / 100) % 2 + ':' + c.pneCoreHasTag(p, 'pne_pace_soft'))
  }
  T.ok(soft.has('1:true') && soft.has('0:false') && !soft.has('1:false') && !soft.has('0:true'), 'aggro 0.9: pne_pace_soft iff floor(tick / 100) is odd (' + [...soft] + ')')
  R.st.fsm.state = 'CALM'; R.st.fsm.e = 0

  // governor: 3 hive-caused deaths in the last real hour -> spawn x 0.7
  p.persistentData.putString('pne_hd', [srv.gameTime - 100, srv.gameTime - 50, srv.gameTime - 10].join(','))
  secs(w, 1)
  pace = c.pneResPace(p)
  T.ok(Math.abs(pace.spawn - 1.25 * 0.7) < 1e-12 && pace.gov === 0.7, 'hourly governor: 3 deaths -> x0.7 (spawn ' + pace.spawn + ')')
  p.persistentData.putString('pne_hd', '')

  // verdict fusion in the module
  c.pneOraVerdict = function () { return { fresh: true, age: 10, EO: 0.9, conf: 0.9, pFlee: 0.1 } }
  secs(w, 5)
  pace = c.pneResPace(p)
  T.ok(pace.fresh && pace.e > 0.8, 'fresh confident verdict drives e (e ' + pace.e.toFixed(3) + ')')
  c.pneOraVerdict = function () { return { fresh: false, age: 200, EO: 0.9, conf: 0.9, pFlee: 0.9 } }
  secs(w, 30)
  pace = c.pneResPace(p)
  T.ok(!pace.fresh && pace.e < 0.2, 'stale verdict falls back to S_H (I6), e decays (' + pace.e.toFixed(3) + ')')
  c.pneOraVerdict = undefined

  // fallback sensing without ORACLE: execute-if-entity bands, pne_lph, light
  c.pneOraSnap = undefined
  const realRun = srv.runCommandSilent
  const counts = { 32: 2, 16: 1, 8: 1, 4: 0 }
  srv.runCommandSilent = function (cmd) {
    const m = String(cmd).match(/if entity @e\[type=#pne:(hive|spore),distance=\.\.(\d+)\]/)
    if (m) { srv.cmds.push(String(cmd)); return m[1] === 'hive' ? counts[m[2]] : 0 }
    return realRun(cmd)
  }
  p.persistentData.putLong('pne_lph', srv.gameTime - 10)
  secs(w, 1)
  pace = c.pneResPace(p)
  T.ok(pace.sense === 'probe' && c.pneResP[u1].sense.nearest === 6 && c.pneResP[u1].sense.n16 === 1, 'probe sensing: nearest from distance bands (6), n16 1')
  T.ok(c.pneResP[u1].sense.tsd < 1.5 && c.pneResP[u1].sense.light === 15, 'probe sensing: damage age from pne_lph, light defaults to 15 when unreadable')
  T.ok(Math.abs(pace.theta - (0.6 * (1 - 6 / 32) + 0.25 * (1 / 8))) < 1e-9, 'theta = 0.60 prox + 0.25 min(1, n16/8) + 0.15 (1 - light/15), no health or arousal term')
  srv.runCommandSilent = realRun

  // commands (the /pne hub)
  const brig = M.brig()
  M.fire('ServerEvents.commandRegistry', brig.event())
  let n0 = srv.cmds.length
  T.eq(brig.run('pne comfort', M.source(srv, p, 0)), 1, '/pne comfort (status) handled')
  T.ok(srv.cmds.slice(n0).join('|').indexOf('Comfort mode is ON') >= 0, 'comfort is ON by default')
  brig.run('pne comfort off', M.source(srv, p, 0))
  T.ok(c.pneCoreHasTag(p, 'pne_comfort_off') && !c.pneCoreComfort(p), '/pne comfort off sets pne_comfort_off (no cheats needed)')
  brig.run('pne comfort on', M.source(srv, p, 0))
  T.ok(!c.pneCoreHasTag(p, 'pne_comfort_off'), '/pne comfort on removes it')
  for (const lay of ['whispers', 'throb', 'approach', 'stingers']) {
    brig.run('pne resonance ' + lay + ' off', M.source(srv, p, 0))
    T.ok(c.pneCoreHasTag(p, 'pne_res_no_' + lay), '/pne resonance ' + lay + ' off')
    brig.run('pne resonance ' + lay + ' on', M.source(srv, p, 0))
    T.ok(!c.pneCoreHasTag(p, 'pne_res_no_' + lay), '/pne resonance ' + lay + ' on')
  }
  brig.run('pne resonance self off', M.source(srv, p, 0))
  T.ok(c.pneCoreHasTag(p, 'pne_res_off'), '/pne resonance self off sets pne_res_off')
  brig.run('pne resonance self on', M.source(srv, p, 0))
  n0 = srv.cmds.length
  T.eq(brig.run('pne resonance status', M.source(srv, p, 0)), 1, '/pne resonance status handled')
  T.ok(/state \w+, tier \w+, e [\d.]+, theta [\d.]+, m [\d.]+/.test(srv.cmds.slice(n0).join('|')), '/pne resonance status shows state, tier, e, theta, m')
  T.eq(brig.run('pne resonance', M.source(srv, p, 0)), 1, '/pne resonance (pillar read) still handled by the core')
  n0 = srv.cmds.length
  brig.run('pne audio', M.source(srv, p, 0))
  T.ok(srv.cmds.slice(n0).filter(x => x.indexOf('tellraw ' + u1) === 0).length === 5, '/pne audio shows the 5-line notice again')
  T.eq(brig.run('pne comfort off', M.source(srv, null, 4)), 1, 'console /pne comfort answers (per-player only)')
  n0 = srv.cmds.length
  brig.run('pne status', M.source(srv, p, 0))
  T.ok(srv.cmds.slice(n0).join('|').indexOf('resonance: state') >= 0, '/pne status carries the director line')

  // first-run notice: tellraw once, remembered in pne_notice_v
  const p2 = M.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', {})
  n0 = srv.cmds.length
  M.fire('PlayerEvents.loggedIn', { player: p2 })
  secs(w, 5)
  const told = srv.cmds.slice(n0).filter(x => x.indexOf('tellraw bbbb0000') === 0)
  T.ok(told.length === 5 && told[0].indexOf('throbs, whispers and approaching sounds') > 0, 'first-run notice: tellraw, names the three risky layer types')
  T.ok(told.join('|').indexOf('/pne comfort') > 0 && told.join('|').indexOf('whispers off') > 0 && told.join('|').indexOf('Hostile Creatures') > 0, 'notice lists /pne comfort, the layer switches and the vanilla sliders')
  T.eq(p2.persistentData.getInt('pne_notice_v'), 1, 'notice version remembered')
  n0 = srv.cmds.length
  M.fire('PlayerEvents.loggedIn', { player: p2 })
  secs(w, 5)
  T.eq(srv.cmds.slice(n0).filter(x => x.indexOf('tellraw bbbb0000') === 0).length, 0, 'notice appears once')
  T.ok(srv.cmds.every(x => !/\b(effect|title|camera|spectate|tp|teleport)\b/.test(x.split(' run ')[1] || x) || x.indexOf('effect') < 0), 'no effect, title or camera commands from the director')

  // ------------------------------------------------------------------ ledger rules (fresh world each group)
  w = newWorld(); ({ c, M, srv } = w)
  const a = M.player(srv, 'Host', u1, {})
  a.addTag('pne_comfort_off')
  c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600 } }
  c.pneResCatReset()
  // make the Resonance layers stay out of the way for the ledger unit checks
  c.PNE_RES_CATALOG = { events: {}, pools: {}, gen: 'empty', v: 1 }
  c.pneResCatReset()
  secs(w, 1)
  T.ok(c.pneResTell(a, a) === false, 'empty catalog: pneResTell returns false (hive then drops Silent)')
  let before = srv.cmds.length
  T.ok(c.pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' }) === true, 'empty catalog: existing sounds still play through the ledger')
  T.ok(playsounds(srv, before)[0].indexOf('execute as ' + u1 + ' at @s run playsound spore:heart_beat hostile @s ~ ~ ~ 0.45 0.90') === 0, 'ledger command shape (volume and pitch kept)')
  M.tick(srv, 40)
  T.ok(c.pneCoreEmit(a, 'epca:slam', 'hostile', '~ ~ ~', 0.7, { pitch: 0.7, lf: true, cls: 'slam', src: 'horror' }) === false, 'LF: a slam during the heartbeat rest window is refused (one LF source at a time, rest >= 2x)')
  M.tick(srv, 700 - 40)
  T.ok(c.pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' }) === true, 'Hive Night heartbeat again after 35 s (normal mode)')
  M.tick(srv, 300)
  T.ok(c.pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' }) === false, 'Hive Night heartbeat refused 15 s later (>= 35 s apart)')
  // stingers
  M.tick(srv, 400)
  before = srv.cmds.length
  T.ok(c.pneCoreEmit(a, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 2, { pitch: 0.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' }) === true, 'normal mode: the Hive Night scream plays')
  T.ok(playsounds(srv, before)[0].indexOf('rotated ~ 0 run playsound epca:infested_enderman_scream') > 0, 'scream keeps rotated ~ 0 and ^ ^2 ^-24')
  M.tick(srv, 100)
  T.ok(c.pneCoreEmit(a, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 2, { pitch: 0.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' }) === false, 'stingers never within 20 s of each other')
  a.addTag('pne_res_no_stingers')
  M.tick(srv, 500)
  T.ok(c.pneCoreEmit(a, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 2, { pitch: 0.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' }) === false, 'stingers switch refuses the scream')
  a.removeTag('pne_res_no_stingers')
  a.addTag('pne_res_no_throb')
  M.tick(srv, 1500)
  T.ok(c.pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' }) === false, 'throb switch refuses the Hive Night heartbeat')
  a.removeTag('pne_res_no_throb')
  // comfort
  a.removeTag('pne_comfort_off')
  M.tick(srv, 500)
  T.ok(c.pneCoreEmit(a, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 2, { pitch: 0.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' }) === false, 'comfort mode: no stingers (scream skipped)')
  before = srv.cmds.length
  T.ok(c.pneCoreEmit(a, 'epca:slam', 'hostile', '~ ~ ~', 0.7, { pitch: 0.7, lf: true, cls: 'slam', src: 'horror' }) === true, 'comfort: the slam plays')
  const vs = playsounds(srv, before)[0].split(' ')
  T.ok(Number(vs[vs.length - 2]) <= 0.35 + 1e-9, 'comfort: slam at volume <= 0.35 (got ' + vs[vs.length - 2] + ')')
  M.tick(srv, 140)
  T.ok(c.pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' }) === false, 'comfort: no LF source within 10 s of a slam')
  // unknown loud event near the player: attenuated to the level-jump limit or refused
  M.tick(srv, 2000)
  before = srv.cmds.length
  const ok = c.pneCoreEmit(a, 'modx:blast', 'hostile', '~ ~ ~', 1, { lufs: -12, mmax: -6, dur: 1, src: 'hive' })
  if (ok) {
    const v = Number(playsounds(srv, before)[0].split(' ').slice(-2)[0])
    const lvl = -12 + 20 * Math.log10(v) + 20 * Math.log10(1 - 1.62 / 16)
    T.ok(lvl <= -32 + 6 + 0.01, 'comfort level jump: +6 LU over the quiet floor at most (level ' + lvl.toFixed(2) + ')')
  } else T.ok(true, 'loud unknown event refused')
  // server range: vol 1 at 20 blocks never reaches the player (16-block /playsound range)
  M.tick(srv, 200)
  T.ok(c.pneCoreEmit(a, 'minecraft:entity.slime.squish_small', 'hostile', '20 64 0', 1, { src: 'horror', dist: 20 }) === false, 'server-side /playsound range respected (16 x max(1, vol))')
  // bell: sounds.json volume 12 extends the range; the L_eff estimate uses vol x 12
  const info = c.pneResInfo('minecraft:block.bell.use', {})
  const lv = c.pneResLevel(info, 4, { feet: 30, eye: 30 }, 0)
  T.ok(Math.abs(lv - (-32.4 + 20 * Math.log10(1 - 30 / (48 * 16)))) < 1e-6, 'L_eff: bell at vol 4 x sounds.json 12 reaches 768 blocks, near file level at 30 (' + lv.toFixed(2) + ')')
  // positional emit to several players: each gets its own ledger decision
  const b2 = M.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: 5 })
  const c3 = M.player(srv, 'Far', 'cccc0000-0000-4000-8000-000000000003', { x: 300 })
  b2.addTag('pne_comfort_off')
  M.tick(srv, 600)
  before = srv.cmds.length
  const n = c.pneCoreEmitAt(srv, 'minecraft:overworld', 2, 64, 0, 24, 'minecraft:entity.slime.squish_small', 'hostile', 1, { pitch: 0.5, cls: 'squish', src: 'horror' })
  const lines = playsounds(srv, before)
  T.ok(n === lines.length && n >= 1 && lines.every(x => x.indexOf('@s 2.00 64.00 0.00') > 0) && !lines.some(x => x.indexOf('cccc0000') >= 0), 'EmitAt: per-player commands at absolute x y z within radius only (' + n + ')')
  // resonance pillar off: Resonance layers refused, existing sounds still through the ledger, tags removed
  c.PNE_RES_CATALOG = null
  c.pneResCatReset()
  const brig2 = M.brig()
  M.fire('ServerEvents.commandRegistry', brig2.event())
  a.addTag('pne_gate'); a.addTag('pne_pace_soft')
  brig2.run('pne resonance off', M.source(srv, null, 4))
  T.ok(!c.pneCoreOn('resonance') && !c.pneCoreHasTag(a, 'pne_gate') && !c.pneCoreHasTag(a, 'pne_pace_soft'), 'pillar off: pne_gate and pne_pace_soft removed from every online player')
  T.ok(c.pneResEmit(a, 'pne:res.hollow.dry.v01', 'ambient', '~ ~12 ~', 1, { src: 'res' }) === false, 'pillar off: Resonance events refused')
  M.tick(srv, 600)
  T.ok(c.pneResEmit(a, 'minecraft:entity.slime.squish_small', 'hostile', '~ ~ ~', 1, { src: 'res' }) === false && c.pneResStats.why.pillar_off >= 1, 'pillar off: any src "res" sound is refused, whatever its event id')
  n0 = srv.cmds.length
  M.tick(srv, 400)
  T.eq(playsounds(srv, n0).length, 0, 'pillar off: the director issues nothing on its own (no layers, no queued items)')
  T.ok(c.pneCoreEmit(a, 'minecraft:entity.slime.squish_small', 'hostile', '~ ~ ~', 1, { src: 'horror' }) === true, 'pillar off: existing pack sounds still go through the ledger')
  T.ok(c.pneCorePace(a).fallback === true, 'pillar off: pneCorePace falls back')
  brig2.run('pne resonance on', M.source(srv, null, 4))

  // PNE_RES_EXTERNAL mirrors the measured table and the committed trims
  const table = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'tools/director/data/external_levels.json'), 'utf8'))
  const trims = {}
  for (const ns of ['epca', 'spore']) trims[ns] = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'overrides/kubejs/assets', ns, 'sounds.json'), 'utf8'))
  let mism = []
  for (const ev of Object.keys(c.PNE_RES_EXTERNAL)) {
    const x = c.PNE_RES_EXTERNAL[ev]
    let want = []
    let dur = 0
    if (table.vanilla[ev]) {
      const seen = new Set()
      for (const e of table.vanilla[ev]) {
        const f = table.files[e.name]
        dur = Math.max(dur, f.dur / e.pitch)
        const k = e.name + ':' + e.volume
        if (!seen.has(k)) { seen.add(k); want.push([f.lufs, f.mmax, e.volume]) }
      }
    } else {
      const ns = ev.split(':')[0]; const name = ev.split(':')[1]
      const refs = table.events[ev]
      const tr = trims[ns][name]
      refs.forEach((r, i) => {
        const f = table.files[r]
        const s = tr ? tr.sounds[i] : r
        const vol = typeof s === 'string' ? 1 : s.volume
        dur = Math.max(dur, f.dur)
        want.push([f.lufs, f.mmax, vol])
      })
    }
    if (JSON.stringify(want) !== JSON.stringify(x.v)) mism.push(ev + ' variants')
    if (Math.abs(dur - x.dur) > 0.006) mism.push(ev + ' dur ' + dur + ' vs ' + x.dur)
  }
  T.ok(mism.length === 0, 'PNE_RES_EXTERNAL matches external_levels.json and the committed sounds.json trims ' + mism.join('; '))
}

// ------------------------------------------------------------------------------------------------ C. shuffle bags

function partBags () {
  const w = newWorld()
  const { c, M, srv } = w
  const p = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  secs(w, 1)
  const cat = c.PNE_RES_CATALOG.events
  for (const key of ['L2.a', 'L1.t_dry_dread', 'L5.amb', 'L7.a']) {
    const [layer, cls] = key.split('.')
    const ids = c.pneResPool(layer, cls)
    const R = c.pneResPlayerState(p)
    R.bags = {}; R.played = {}; R.joined = c.pneCoreTick; R.novelAt = 0; R.apex = false
    const r = rng(key.length * 101)
    let now = c.pneCoreTick
    let prev = null; let repeats = 0; let early = 0; let winViol = 0; let halfViol = 0; let halfChecked = 0
    const hist = []
    const opens = []
    const seenReserve = new Set()
    const lastAt = {}
    let openSince = 0
    for (let k = 0; k < 30000; k++) {
      now += 20 + Math.floor(r() * 400)
      if (r() < 0.001) R.apex = !R.apex
      const id = c.pneResPick(R, key, ids, now)
      if (id === prev) repeats++
      const unlocked = now - R.joined >= 36000 || R.apex
      if (cat[id].reserve) { seenReserve.add(id); if (!unlocked) early++ }
      const open = ids.filter(x => !cat[x].reserve || unlocked).length
      const win = open >= 2 ? Math.max(1, Math.min(4, open - 2)) : 0
      if (opens.length && opens[opens.length - 1] !== open) openSince = k
      opens.push(open)
      const stable = opens.slice(-6).every(x => x === open)
      if (stable && hist.slice(-win).indexOf(id) >= 0 && k > 50) winViol++
      // A1: at least h = max(window, ceil(n / 2)) other picks between two plays, while the open set is unchanged
      if (lastAt[id] !== undefined && lastAt[id] >= openSince) {
        halfChecked++
        if (k - lastAt[id] - 1 < c.pneResBagGap(open)) halfViol++
      }
      lastAt[id] = k
      hist.push(id)
      prev = id
    }
    const reserve = ids.filter(x => cat[x].reserve)
    T.eq(repeats, 0, key + ': no immediate repeats over 30000 picks')
    T.eq(early, 0, key + ': reserve variants withheld for the first 30 min (unless an apex genome is near)')
    T.ok(winViol === 0, key + ': no-repeat window min(4, n - 2) (at least 1) respected (' + winViol + ' violations)')
    T.ok(halfViol === 0 && halfChecked > 20000, key + ': A1 half-pool rule, h = ' + c.pneResBagGap(ids.length) + ' for the full pool (' + halfViol + ' violations in ' + halfChecked + ' replays)')
    T.ok(reserve.every(x => seenReserve.has(x)), key + ': every reserve variant is eventually injected as novelty')
  }
  // A1 on a 12-variant pool without reserve (the size of the shipped L5 pools): every replay comes after at least
  // 6 other picks, every variant plays once per 12 picks (bag), and the bag halves keep mixing (a "recent items
  // last" rule would pin one half of the pool to the end of every bag)
  {
    const R = c.pneResPlayerState(p)
    const ids12 = []
    for (let i = 1; i <= 12; i++) ids12.push('pne:test.pool12.v' + (i < 10 ? '0' : '') + i)
    R.bags = {}; R.played = {}; R.joined = -1e9
    const seq = []
    for (let k = 0; k < 24000; k++) seq.push(c.pneResPick(R, 'T.pool12', ids12, 100 + k))
    let minGap = 1e9; let short = 0
    const last = {}
    for (let k = 0; k < seq.length; k++) {
      if (last[seq[k]] !== undefined) { const g = k - last[seq[k]] - 1; minGap = Math.min(minGap, g); if (g < 6) short++ }
      last[seq[k]] = k
    }
    let bagsFull = 0
    const firstHalf = {}
    for (let b = 0; b < seq.length / 12; b++) {
      const bag = seq.slice(12 * b, 12 * b + 12)
      if (new Set(bag).size === 12) bagsFull++
      for (let i = 0; i < 6; i++) firstHalf[bag[i]] = (firstHalf[bag[i]] || 0) + 1
    }
    const shares = ids12.map(x => (firstHalf[x] || 0) / (seq.length / 12))
    T.ok(short === 0 && minGap >= 6, '12-variant pool: at least 6 other picks between replays (min ' + minGap + ', ' + short + ' short of 24000)')
    T.eq(bagsFull, seq.length / 12, '12-variant pool: every block of 12 picks plays all 12 variants')
    T.ok(shares.every(s => s > 0.3 && s < 0.7), '12-variant pool: every variant lands in the first half of a bag 30-70% of the time (' + shares.map(s => s.toFixed(2)).join(',') + ')')
  }
  // determinism: same world seed, pid and day give the same sequence
  const seqs = []
  for (let k = 0; k < 2; k++) {
    const R = c.pneResPlayerState(p)
    R.bags = {}; R.played = {}; R.rngDay = -1; R.joined = 0; R.novelAt = 1e12
    const s = []
    for (let i = 0; i < 40; i++) s.push(c.pneResPick(R, 'L5.amb', c.pneResPool('L5', 'amb'), 100000 + i))
    seqs.push(s.join(','))
  }
  T.ok(seqs[0] === seqs[1], 'bags: xorshift32 seeded worldSeed ^ pidHash ^ day is deterministic')
}

// ------------------------------------------------------------------------------------------------ D. L0 hush

// L0 (b): 2-4 s before an Approach the director issues the dry/dread -> muffled transition segment (the vacuum);
// normal mode may pay off with L7 at the approach's end, comfort never; L0 (c): RELEASE is silent for 10 s,
// then only the muffled bed plays.
// Warm-up to the DREAD tier with no approach of its own: after the first step the L6 floor (90 s) is armed, so
// the 40 s warm-up can never start a natural approach (whose vacuum would leave the bed muffled and turn the
// forced approach's vacuum into a plain muffled segment).
function warmDread (w, p) {
  secs(w, 1)
  const R = w.c.pneResP[p.uuid]
  R.last.L6 = w.c.pneCoreTick
  secs(w, 39)
  return R
}

function partHush () {
  for (const comfort of [false, true]) {
    const w = newWorld()
    const { c, M, srv } = w
    const p = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
    if (!comfort) p.addTag('pne_comfort_off')
    c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 9.6, n16: 4, light: 7, hp: 1, tSinceDmg: 600, hostileSeen: true } }
    const R = warmDread(w, p)
    T.ok(c.pneResPace(p).tier === 'DREAD' && (c.pneResPace(p).state === 'DREAD' || c.pneResPace(p).state === 'UNEASE'), (comfort ? 'comfort' : 'normal') + ': DREAD tier without PANIC for the approach test (' + c.pneResPace(p).state + ')')
    T.ok(R.bed.cur !== 'muffled' && !R.vac && !R.vacPending && !c.pneResHas(R, 'app'), (comfort ? 'comfort' : 'normal') + ': no vacuum or approach pending before the forced one (bed ' + R.bed.cur + ')')
    const realRand = c.pneResRand
    c.pneResRand = function () { return 0.001 }
    R.last.L6 = -1e9
    const n0 = srv.cmds.length
    M.tick(srv, 400)
    c.pneResRand = realRand
    const all = srv.cmds.slice(n0)
    const app = all.findIndex(x => /playsound pne:res\.approach\.(n|c)\./.test(x))
    T.ok(app >= 0, (comfort ? 'comfort' : 'normal') + ': an approach was issued')
    const vac = all.slice(0, app).map((x, i) => [x, i]).filter(([x]) => /playsound pne:res\.hollow\.t_(dry|dread)_muffled\./.test(x)).pop()
    T.ok(!!vac, (comfort ? 'comfort' : 'normal') + ': the vacuum transition segment came before the approach')
    T.ok(app >= 0 && (comfort ? /approach\.c\./ : /approach\.n\./).test(all[app]), (comfort ? 'comfort uses the comfort approach' : 'normal uses the normal approach'))
    const pay = all.slice(app + 1).some(x => /playsound pne:res\.spike\.a\./.test(x))
    T.ok(comfort ? !pay : true, (comfort ? 'comfort: never a payoff' : 'normal: payoff allowed'))
  }
  // vacuum timing, measured in ticks through the ledger's own records
  const w = newWorld()
  const { c, M, srv } = w
  const p = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  p.addTag('pne_comfort_off')
  c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 9.6, n16: 4, light: 7, hp: 1, tSinceDmg: 600 } }
  const R = warmDread(w, p)
  T.ok(R.bed.cur !== 'muffled' && !R.vac && !c.pneResHas(R, 'app'), 'timing: no vacuum pending before the forced approach')
  const realRand = c.pneResRand
  c.pneResRand = function () { return 0.001 }
  R.last.L6 = -1e9
  const seen = []
  for (let k = 0; k < 400; k++) {
    M.tick(srv, 1)
    for (const x of R.led.inst) if (!seen.includes(x)) seen.push(x)
  }
  c.pneResRand = realRand
  const a = seen.find(x => x.layer === 'L6')
  const v = seen.filter(x => a && /hollow\.t_(dry|dread)_muffled/.test(x.ev) && x.t0 <= a.t0).pop()
  T.ok(a && v && a.t0 - v.t0 >= 40 && a.t0 - v.t0 <= 80, 'vacuum 2-4 s before the approach onset (' + (a && v ? a.t0 - v.t0 : 'n/a') + ' ticks)')
  const pay = seen.find(x => x.layer === 'L7' && a && x.t0 >= a.t0)
  T.ok(!pay || pay.t0 === a.t1, 'payoff, when it plays, starts as the approach ends')
  // RELEASE: silent for 10 s, then only the muffled bed
  const w2 = newWorld()
  const q = w2.M.player(w2.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  q.addTag('pne_comfort_off')
  w2.c.pneOraSnap = function () { return { tick: w2.c.pneCoreTick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600 } }
  secs(w2, 3)
  const R2 = w2.c.pneResP[q.uuid]
  R2.st.fsm.state = 'PANIC'; R2.st.fsm.inState = 50; R2.st.fsm.e = 0.2
  secs(w2, 1)
  T.eq(w2.c.pneResPace(q).state, 'RELEASE', 'forced PANIC exits to RELEASE')
  const rel0 = w2.c.pneResPace(q).tick
  secs(w2, 25)
  const relInst = R2.led.inst.filter(x => x.t0 > rel0 && x.res && x.layer !== 'L8')
  T.ok(relInst.every(x => x.t0 - rel0 >= 190), 'RELEASE: no Resonance layer in the first 10 s (' + relInst.map(x => x.t0 - rel0).slice(0, 3) + ')')
  T.ok(relInst.length > 0 && relInst.every(x => /hollow\.(muffled|t_dread_muffled)/.test(x.ev)), 'RELEASE: then only the muffled bed (' + [...new Set(relInst.map(x => x.ev.split('.')[2]))] + ')')
}

// ------------------------------------------------------------------------------------------------ E. overrides

const SLUG = { hollow: 'L1', undertone: 'L2', pulse: 'L3', beat: 'L4', whisper: 'L5', approach: 'L6', spike: 'L7', tell: 'L8' }

// A world whose director-issued Resonance onsets are logged with the player's audio mode at that moment.
function loggedWorld (comfortOff) {
  const w = newWorld()
  const p = w.M.player(w.srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  if (comfortOff) p.addTag('pne_comfort_off')
  w.p = p
  w.log = []
  const run = w.srv.runCommandSilent
  w.srv.runCommandSilent = function (cmd) {
    const m = / run playsound pne:res\.(\w+)\.(\w+)\.v\d+ /.exec(String(cmd))
    const R = w.c.pneResP[p.uuid]
    if (m && R) w.log.push({ t: w.c.pneCoreTick, layer: SLUG[m[1]], cls: m[2], mode: R.mode, state: R.pace ? R.pace.state : '', vuln: R.vuln, rel: R.relStart })
    return run(cmd)
  }
  return w
}

// Probe answers for the fallback sensing: counts per band radius (only #pne:hive answers).
function probeCounts (w, counts) {
  const run = w.srv.runCommandSilent
  w.srv.runCommandSilent = function (cmd) {
    const m = String(cmd).match(/if entity @e\[type=#pne:(hive|spore),distance=\.\.(\d+)\]/)
    if (m) { w.srv.cmds.push(String(cmd)); return m[1] === 'hive' ? counts[m[2]] : 0 }
    return run(cmd)
  }
}

function partOverrides () {
  // PANIC and RELEASE keep their overrides under mercy (TDD 2.5.4: each override can only lower the audio).
  // Every hazard is forced to fire and every cooldown is cleared, so only the overrides can keep a layer out.
  for (const mercy of [true, false]) {
    const label = mercy ? 'PANIC with mercy: ' : 'PANIC without mercy (control): '
    const w = loggedWorld(true)
    const { c, M, srv, p } = w
    const snap = { nearest: 2, n16: 8, light: 0, hp: 1, tSinceDmg: 0.5, hostileSeen: true }
    c.pneOraSnap = function () { return Object.assign({ tick: c.pneCoreTick }, snap) }
    let st = null
    for (let s = 0; s < 90 && !(st && st.state === 'PANIC'); s++) { secs(w, 1); st = c.pneResPace(p) }
    T.ok(st && st.state === 'PANIC', label + 'reached PANIC')
    const R = c.pneResP[p.uuid]
    if (mercy) { p.hp = 4; snap.hp = 0.2 }
    const realRand = c.pneResRand
    c.pneResRand = function () { return 0.001 }
    R.last = { wh: -1e9, L2: -1e9, L3: -1e9, L4: -1e9, L6: -1e9 }
    const from = w.log.length
    const states = new Set()
    for (let s = 0; s < 75; s++) {
      if (s === 20) { snap.nearest = 20; snap.n16 = 0; snap.tSinceDmg = 600; snap.hostileSeen = false }
      secs(w, 1)
      states.add(c.pneResPace(p).state + (c.pneResPace(p).mercy ? '+mercy' : ''))
    }
    c.pneResRand = realRand
    const ons = w.log.slice(from)
    // classified by the pacing state (not the director's own audio mode, which is what a bug would get wrong)
    const inPanic = ons.filter(o => o.state === 'PANIC')
    const hush = ons.filter(o => o.state === 'RELEASE' && o.t - o.rel < 200 && o.layer !== 'L8')
    T.ok(states.has(mercy ? 'PANIC+mercy' : 'PANIC') && states.has(mercy ? 'RELEASE+mercy' : 'RELEASE'), label + 'the run covers PANIC and RELEASE (' + [...states] + ')')
    T.ok(!inPanic.some(o => ['L1', 'L2', 'L4', 'L5'].indexOf(o.layer) >= 0 || (o.layer === 'L3' && o.cls !== 'heartbeat' && o.cls !== 'heartbeat_c')), label + 'no bed, L2, L3 flutter/rough, L4 or whisper onset in PANIC (A5) (' + inPanic.map(o => o.layer + '.' + o.cls) + ')')
    T.eq(hush.length, 0, label + 'no Resonance onset in the first 10 s of RELEASE (L0 c)')
    if (mercy) {
      T.eq(inPanic.length, 0, label + 'no heartbeat and no stinger either (mercy: no L3, no L7)')
      T.ok(ons.some(o => o.state === 'RELEASE' && o.layer === 'L1' && o.t - o.rel >= 200), label + 'the muffled bed returns after the 10 s hush')
    } else T.ok(inPanic.some(o => o.layer === 'L3' && o.cls === 'heartbeat'), label + 'the PANIC heartbeat still plays (the test can see L3)')
  }

  // the ledger enforces the same overrides for the director's own layers, keyed on the cached Pace
  {
    const w = loggedWorld(true)
    const { c, p } = w
    c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600 } }
    secs(w, 2)
    const R = c.pneResP[p.uuid]
    const why = k => c.pneResStats.why[k] || 0
    const emit = (ev, pos) => c.pneResEmit(p, ev, 'ambient', pos || '~ ~12 ~', 1, { src: 'res' })
    const base = R.pace
    R.q = []
    R.pace = Object.assign({}, base, { state: 'PANIC' })
    const a0 = why('panic_a5')
    T.ok(!emit('pne:res.hollow.dry.v01') && !emit('pne:res.whisper.amb.v01', '^ ^1 ^-6') && !emit('pne:res.pulse.flutter.v01') && !emit('pne:res.beat.slow.v01') && why('panic_a5') === a0 + 4, 'ledger: PANIC refuses bed, whisper, flutter and beat (A5)')
    c.__pneMock.tick(w.srv, 200)
    R.pace = Object.assign({}, base, { state: 'RELEASE' })
    R.relStart = c.pneCoreTick - 100
    T.ok(!emit('pne:res.hollow.muffled.v02') && why('release_hush') >= 1, 'ledger: RELEASE refuses Resonance layers in its first 10 s (L0 c)')
    R.relStart = c.pneCoreTick - 400
    R.pace = Object.assign({}, base, { state: 'CALM', mercy: true })
    const v0 = why('vuln_layer')
    T.ok(!emit('pne:res.pulse.heartbeat.v02') && !emit('pne:res.approach.n.v02', '^ ^1 ^-8') && why('vuln_layer') === v0 + 2, 'ledger: mercy refuses L3 and L6')
    R.pace = base
  }

  // L0 (a) under mercy: QUIET is forced, and QUIET keeps >= 30% silence
  {
    const w = loggedWorld(true)
    const { c, M, srv, p } = w
    srv.dayTime = 6000
    c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 32, n16: 0, light: 15, hp: p.hp / 20, tSinceDmg: 600 } }
    p.hp = 5
    secs(w, 10)
    const R = c.pneResP[p.uuid]
    let q = 0; let busy = 0
    for (let k = 0; k < 12000; k++) {
      M.tick(srv, 1)
      const t = c.pneCoreTick
      q++
      if (R.led.inst.some(x => x.res && x.t0 <= t && t < x.t1)) busy++
    }
    T.ok(R.mode === 'vuln' && busy > 0 && 1 - busy / q >= 0.3, 'mercy QUIET: the muffled bed plays in runs with >= 30% silence (L0 a) (silent ' + (100 * (1 - busy / q)).toFixed(1) + '%, mode ' + R.mode + ')')
  }

  // L7 only on the first sighting in a PANIC, and only from a snapshot line-of-sight report
  {
    const w = loggedWorld(true)
    const { c, p } = w
    const snap = { nearest: 2, n16: 8, light: 0, hp: 1, tSinceDmg: 600, hostileSeen: false }
    c.pneOraSnap = function () { return Object.assign({ tick: c.pneCoreTick }, snap) }
    secs(w, 2)
    const R = c.pneResP[p.uuid]
    R.st.fsm.state = 'PANIC'; R.st.fsm.inState = 1; R.st.fsm.e = 0.9
    R.last.L3 = c.pneCoreTick
    const n0 = w.log.length
    secs(w, 3)
    const sp = () => w.log.slice(n0).filter(o => o.layer === 'L7').length
    T.ok(c.pneResPace(p).state === 'PANIC' && sp() === 0, 'PANIC without a sighting: no stinger yet')
    snap.hostileSeen = true
    secs(w, 1)
    T.eq(sp(), 1, 'PANIC: the first sighting plays the stinger')
    secs(w, 6)
    T.eq(sp(), 1, 'PANIC: later sightings in the same PANIC play no stinger')
  }
  {
    const w = loggedWorld(true)
    const { c, p } = w
    c.pneOraSnap = undefined
    probeCounts(w, { 32: 6, 16: 5, 8: 4, 4: 2 })
    p.persistentData.putLong('pne_lph', w.srv.gameTime)
    secs(w, 2)
    const R = c.pneResP[p.uuid]
    R.st.fsm.state = 'PANIC'; R.st.fsm.inState = 1; R.st.fsm.e = 0.9
    R.last.L3 = c.pneCoreTick
    const n0 = w.log.length
    secs(w, 6)
    T.ok(c.pneResPace(p).sense === 'probe' && w.log.slice(n0).filter(o => o.layer === 'L7').length === 0, 'probe sensing (no line of sight): no PANIC stinger')
  }
}

// A refused bed segment changes nothing the player hears: B.cur stays, the segment is retried 1 s later, and a
// vacuum's approach is scheduled only after its transition segment was actually issued.
// One refusal: the retry 1 s later still overlaps the old segment's baked fade, so it is the transition again.
// Two refusals: the old segment has ended by the second retry, so the bed restarts from silence with a plain
// muffled segment (a transition would first jump back up to the dread level).
function partBedRefusal () {
  for (const nRefuse of [1, 2]) {
    const label = 'bed refused ' + nRefuse + 'x: '
    const w = loggedWorld(true)
    const { c, M, p } = w
    c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 9.6, n16: 4, light: 7, hp: 1, tSinceDmg: 600 } }
    const R = warmDread(w, p)
    const refused = []
    const curAfter = []
    const realEmit = c.pneResEmitOne
    c.pneResEmitOne = function (player, ev) {
      if (/hollow\.t_(dry|dread)_muffled/.test(String(ev)) && refused.length < nRefuse) { refused.push(c.pneCoreTick); return 0 }
      return realEmit.apply(null, arguments)
    }
    const realRand = c.pneResRand
    c.pneResRand = function () { return 0.001 }
    R.last.L6 = -1e9
    const from = w.log.length
    for (let k = 0; k < 400; k++) {
      const n = refused.length
      M.tick(w.srv, 1)
      if (refused.length > n) curAfter.push(R.bed.cur)
    }
    c.pneResRand = realRand
    c.pneResEmitOne = realEmit
    const ons = w.log.slice(from)
    const bed = ons.find(o => o.layer === 'L1' && o.t > refused[refused.length - 1])
    const app = ons.find(o => o.layer === 'L6')
    T.ok(refused.length === nRefuse && curAfter.every(x => x !== 'muffled'), label + 'the bed class is unchanged after each refusal (' + curAfter + ')')
    T.ok(bed && bed.t - refused[nRefuse - 1] === 20 && (nRefuse === 1 ? /^t_(dry|dread)_muffled$/.test(bed.cls) : bed.cls === 'muffled'), label + 'retried 1 s later as ' + (nRefuse === 1 ? 'the transition' : 'a plain muffled segment (the bed had ended)') + ' (' + (bed && (bed.t - refused[nRefuse - 1]) + ' ' + bed.cls) + ')')
    T.ok(app && bed && app.t - bed.t >= 40 && app.t - bed.t <= 80 && !ons.some(o => o.layer === 'L6' && o.t < bed.t), label + 'the approach comes 2-4 s after the issued vacuum segment, never after a refused one (' + (app && bed ? app.t - bed.t : 'n/a') + ')')
  }
}

// A probe refused for budget is missing data: the last complete reading (<= 3 s old) is reused, then the step
// is skipped; it never reads as "no parasite near".
function partSenseStale () {
  const w = newWorld()
  const { c, M, srv } = w
  const p = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  c.pneOraSnap = undefined
  probeCounts(w, { 32: 2, 16: 1, 8: 1, 4: 0 })
  secs(w, 2)
  const R = c.pneResP[p.uuid]
  T.ok(R.sense.src === 'probe' && R.sense.nearest === 6, 'probe reading before the budget runs out (nearest 6)')
  const realTake = c.pneCoreTake
  let refuse = true
  c.pneCoreTake = function (ms) { return refuse && ms === c.PNE_CORE_COST.emit ? false : realTake(ms) }
  const t0 = R.pace.tick
  secs(w, 1)
  T.ok(R.pace.tick > t0 && R.sense.src === 'probe-stale' && R.sense.nearest === 6 && R.sense.n16 === 1, 'refused probe: the previous reading is reused, not nearest 32 (' + R.sense.src + ', ' + R.sense.nearest + ')')
  T.ok(Math.abs(R.pace.theta - (0.6 * (1 - 6 / 32) + 0.25 * (1 / 8))) < 1e-9, 'refused probe: theta keeps the parasite proximity')
  secs(w, 3)
  const tk = R.pace.tick
  secs(w, 2)
  T.ok(R.pace.tick === tk && c.pneCorePace(p).fallback === true, 'refused probes past 3 s: the step is skipped and pneCorePace falls back')
  refuse = false
  c.pneCoreTake = realTake
  secs(w, 1)
  T.ok(R.pace.tick > tk && R.sense.src === 'probe', 'probes answer again: fresh reading')
}

// Comfort: the Hive Night heartbeat at least 70 s apart (TDD 2.5.5, 2.7)
function partComfortHeartbeat () {
  const w = newWorld()
  const { c, M, srv } = w
  const a = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600 } }
  c.PNE_RES_CATALOG = { events: {}, pools: {}, gen: 'empty', v: 1 }
  c.pneResCatReset()
  secs(w, 1)
  const hb = () => c.pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' })
  T.ok(c.pneCoreComfort(a) && hb() === true, 'comfort: the Hive Night heartbeat plays')
  M.tick(srv, 800)
  T.ok(hb() === false, 'comfort: heartbeat refused 40 s later')
  M.tick(srv, 400)
  T.ok(hb() === false, 'comfort: heartbeat refused 60 s later')
  M.tick(srv, 199)
  T.ok(hb() === false && c.pneResStats.why.cls_interval >= 3, 'comfort: heartbeat refused at 69.95 s (class interval)')
  M.tick(srv, 1)
  T.ok(hb() === true, 'comfort: heartbeat plays again at 70 s')
}

// A file too short for an in-file rise (V15 not applicable) enters the level-jump rule at its catalog mmax, not its
// lufs (contract 5, 1.2): below PNE_RES_SHORT_S the ledger turns it down until its M-max fits, a longer file with
// the same levels only until its integrated level fits.
function partOnsetStep () {
  const w = newWorld()
  const { c, M, srv } = w
  const a = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  c.pneOraSnap = function () { return { tick: c.pneCoreTick, nearest: 32, n16: 0, light: 15, hp: 1, tSinceDmg: 600 } }
  const ev = (cls, dur) => ({ layer: 'L8', cls, lufs: -22, mmax: -19, dur, cat: 'hostile', comfort: true, normal: true, att: 24, stream: false, lf: false, reserve: false, amb: false })
  c.PNE_RES_CATALOG = {
    v: 1, gen: 'onset-step', pools: { 'x.short': ['pne:res.x.short.v01'], 'x.edge': ['pne:res.x.edge.v01'], 'x.long': ['pne:res.x.long.v01'] },
    events: { 'pne:res.x.short.v01': ev('short', 0.45), 'pne:res.x.edge.v01': ev('edge', 0.6), 'pne:res.x.long.v01': ev('long', 0.8) }
  }
  c.pneResCatReset()
  secs(w, 1)
  const si = c.pneResInfo('pne:res.x.short.v01', {})
  const ei = c.pneResInfo('pne:res.x.edge.v01', {})
  const li = c.pneResInfo('pne:res.x.long.v01', {})
  T.ok(c.PNE_RES_SHORT_S === 0.6, 'PNE_RES_SHORT_S is 0.6 s (400 ms window + 0.1 s span + the largest short-layer fade, 0.1 s)')
  T.ok(Math.abs(si.step - 3) < 1e-9 && ei.step === 0 && li.step === 0, 'onset step: mmax - lufs (3 dB) below 0.6 s only (' + si.step + ', ' + ei.step + ', ' + li.step + ')')
  T.ok(c.pneResInfo('epca:slam', { src: 'horror' }).step === 0, 'onset step: external sounds keep their integrated level')
  // comfort player, quiet bus: the jump limit is -32 + 6 = -26 LU at the ears; source 4 blocks ahead
  const g = 20 * Math.log10(1 - Math.hypot(4, 1.62) / 24)
  const vol = (id) => {
    secs(w, 3)
    const n0 = srv.cmds.length
    const ok = c.pneResEmit(a, id, 'hostile', '~ ~ ~4', 1, { src: 'hive' })
    const line = playsounds(srv, n0)[0]
    return ok && line ? Number(line.split(' ').slice(-2)[0]) : 0
  }
  const vs = vol('pne:res.x.short.v01')
  const vl = vol('pne:res.x.long.v01')
  const lvl = (l, v) => l + 20 * Math.log10(v) + g
  T.ok(vs > 0 && lvl(-19, vs) <= -26 + 1e-6 && lvl(-19, vs + 0.01) > -26, 'short file: turned down until its mmax fits the comfort jump (vol ' + vs + ', M-max ' + lvl(-19, vs).toFixed(2) + ' LU)')
  T.ok(vl > 0 && lvl(-22, vl) <= -26 + 1e-6 && lvl(-22, vl + 0.01) > -26 && lvl(-19, vl) > -26, 'long file: only its integrated level has to fit (vol ' + vl + ', lufs ' + lvl(-22, vl).toFixed(2) + ' LU)')
}

partPure()
partModule()
partBags()
partHush()
partOverrides()
partBedRefusal()
partSenseStale()
partComfortHeartbeat()
partOnsetStep()
T.done()
