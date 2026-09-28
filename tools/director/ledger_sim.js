// Suite director-ledger-sim: one simulated hour per mode (normal, comfort) of the real pne_resonance.js on the
// KubeJS mocks, with a synthetic catalog, scripted encounters (approach, fights, PANIC, mercy, a death with
// respawn grace), Hive Night, every existing pne_horror.js sound at its real volume, pitch, position and rate
// (gore slams, Mobs Inside squish, beckon bell and stage-1 call, the horde call, the Hive Night heartbeat and
// scream), and HIVE-style L8 tells. Every /playsound and /stopsound the director issues is then re-checked by an
// INDEPENDENT model built from the command text, tools/director/data/external_levels.json and the committed
// sounds.json trims (not from the module's own functions):
//   0 immediate repeats per variant pool; bus <= -18 LU; A8 (per-instance cap, one LF source at a time, rest,
//   rolling 10-min duty, comfort LF classes, comfort slam gap), counting the existing LF sounds; the level-jump
//   limit (+10 LU / 3 s normal, +6 LU / 2 s comfort, from a -32 LU quiet floor) for every source, stingers by
//   the +18 LU rule; the comfort envelope rule (no comfort-excluded asset, no stinger, no onset train above 2 Hz);
//   the per-minute Resonance budget (-27 / -30 LU); L0 (a) >= 30% silence in QUIET (mercy, grace and RELEASE
//   included); the TDD 2.5.4 overrides from the pacing state at each onset (A5: no bed, L2, L3 flutter/rough, L4
//   or whisper in PANIC; L0 (c): nothing in the first 10 s of RELEASE; mercy/grace: no L2, L3, L4, L6 or L7);
//   the Hive Night heartbeat interval (>= 35 s normal, >= 70 s comfort); no /stopsound more than 300 ms before a
//   tracked instance's fade.
// Two rules follow RESONANCE's asset gate (tools/resonance/verify.py) exactly:
//   * onset step: for a file too short for an in-file rise (V15 not applicable: the 400 ms windows after its onset
//     fade span < 0.1 s), the level-jump check uses the catalog's mmax, not its integrated lufs (contract 5, 1.2).
//     The set comes from the asset manifest for the generated catalog (which it must describe: gen = its sha256),
//     and from verify's rule with the largest short-layer onset fade (0.1 s) for the synthetic catalog.
//   * comfort envelope rule: the L5 phrase-level burst gating and the L8 click trains are PENDING a lead decision
//     (tools/resonance/tdd_pins.py PENDING_CE). Comfort-mode onsets of those pools are counted and reported as
//     pending, never as passes, exactly as the asset gate reports the files; the schedule-level part of the rule
//     (no onset train above 2 Hz) stays binding. The pending set must equal the manifest's CE pending list. When the
//     lead records the decision (the pool leaves PENDING_CE, or its assets turn comfort: false), the sim follows it.
//
//   node tools/director/ledger_sim.js
'use strict'
const fs = require('fs')
const path = require('path')
const P = require('./pack.js')

const T = P.checker('director-ledger-sim')
const HOUR = 72000
const FLOOR = -32
const EYE = 1.62
const FADE = { L1: 30, L2: 80, L3: 60, L4: 80 }

function rng (seed) {
  let s = seed >>> 0 || 1
  return function () { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
}
const db = g => g > 0 ? 20 * Math.log10(g) : -120
const psum = arr => { let p = 0; for (const l of arr) if (l > -119) p += Math.pow(10, l / 10); return p > 0 ? 10 * Math.log10(p) : -120 }

// ------------------------------------------------------------------ independent sound table
const table = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'tools/director/data/external_levels.json'), 'utf8'))
const trims = {}
for (const ns of ['epca', 'spore']) trims[ns] = JSON.parse(fs.readFileSync(path.join(P.ROOT, 'overrides/kubejs/assets', ns, 'sounds.json'), 'utf8'))
function externalInfo (ev) {
  if (table.vanilla[ev]) {
    const vars = table.vanilla[ev].map(e => ({ l: table.files[e.name].lufs, m: table.files[e.name].mmax, sv: e.volume, dur: table.files[e.name].dur / e.pitch }))
    return { vars, dur: Math.max(...vars.map(v => v.dur)), att: 16 }
  }
  const refs = table.events[ev]
  if (!refs) return null
  const ns = ev.split(':')[0]; const name = ev.split(':')[1]
  const tr = trims[ns][name]
  const vars = refs.map((r, i) => {
    const s = tr ? tr.sounds[i] : r
    return { l: table.files[r].lufs, m: table.files[r].mmax, sv: typeof s === 'string' ? 1 : s.volume, dur: table.files[r].dur }
  })
  return { vars, dur: Math.max(...vars.map(v => v.dur)), att: 16 }
}
const EXT_LF = { 'epca:slam': 'slam', 'spore:heart_beat': 'hive_heartbeat' }
const STINGER_EXT = { 'epca:infested_enderman_scream': true }

// ------------------------------------------------------------------ the asset gate's decisions (RESONANCE)
const poolOf = ev => ev.slice('pne:res.'.length).replace(/\.v[0-9]+$/, '')
// PENDING_CE pool keys from tools/resonance/tdd_pins.py (the only place the pending comfort envelope decision lives)
function pendingCE () {
  const src = fs.readFileSync(path.join(P.ROOT, 'tools/resonance/tdd_pins.py'), 'utf8').replace(/\r\n/g, '\n')
  const head = '\nPENDING_CE = {'
  const i = src.indexOf(head)
  if (i < 0) throw new Error('PENDING_CE not found in tools/resonance/tdd_pins.py')
  const j = src.indexOf('\n}', i)
  const body = src.slice(i + head.length, j < 0 ? src.length : j)
  const keys = []
  const rx = /^ {4}'([a-z0-9_]+\.[a-z0-9_]+)'\s*:/gm
  let m
  while ((m = rx.exec(body))) keys.push(m[1])
  return keys
}
// The asset manifest (verify.py output): per event, V15 not applicable (the L7 exemption excluded) and CE pending.
// sha is the catalog's gen (sha256 of the manifest with LF line ends, 12 hex: gen_sounds_json.py).
function readManifest () {
  const f = path.join(P.ROOT, 'tools/resonance/manifest.json')
  if (!fs.existsSync(f)) return null
  const bytes = Buffer.from(fs.readFileSync(f).toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
  const man = JSON.parse(bytes.toString('utf8'))
  const out = { sha: require('crypto').createHash('sha256').update(bytes).digest('hex').slice(0, 12), v15na: new Set(), pending: new Set() }
  for (const k of Object.keys(man.assets || {})) {
    const a = man.assets[k]
    const ev = a.event || ('pne:' + k)
    const g15 = (a.gates || {}).V15 || {}
    const gce = (a.gates || {}).CE || {}
    if (g15.na === true && String(g15.detail || '').indexOf('not applicable') === 0) out.v15na.add(ev)
    if (gce.pending) out.pending.add(ev)
  }
  return out
}
// verify.py's V15 rule with the onset fade unknown: not applicable when dur - 0.4 s - fade < 0.1 s; 0.1 s is the
// largest onset fade of the short layers (L5 0.07, L6 0.1, L8 0.04 s in the manifest; L1-L4 files last >= 6 s)
const V15_MAX_SHORT_FADE = 0.1
function assetGate (catLabel, cat, useManifest) {
  const ce = pendingCE()
  const g = { ce, onsetMmax: new Set(), cePending: new Set(), source: 'verify rule, fade <= ' + V15_MAX_SHORT_FADE + ' s' }
  if (useManifest) {
    const man = readManifest()
    T.ok(man !== null, catLabel + ': the asset manifest tools/resonance/manifest.json is readable')
    if (!man) return g
    T.ok(man.sha === String(cat.gen), catLabel + ': the asset manifest describes this catalog (gen ' + cat.gen + ', manifest ' + man.sha + ')')
    g.source = 'asset manifest'
    for (const ev of man.v15na) if (cat.events[ev]) g.onsetMmax.add(ev)
    for (const ev of man.pending) if (cat.events[ev]) g.cePending.add(ev)
    const want = Object.keys(cat.events).filter(ev => cat.events[ev].comfort === true && ce.indexOf(poolOf(ev)) >= 0).sort()
    const got = Array.from(g.cePending).sort()
    T.ok(JSON.stringify(want) === JSON.stringify(got), catLabel + ': CE pending set = the asset gate\'s (' + got.length + ' in the manifest, ' +
      want.length + ' comfort events in the PENDING_CE pools ' + ce.join(', ') + ')')
  } else {
    for (const ev of Object.keys(cat.events)) {
      const e = cat.events[ev]
      if (e.layer !== 'L7' && e.amb !== true && Number(e.dur) - 0.4 - V15_MAX_SHORT_FADE < 0.1 - 1e-9) g.onsetMmax.add(ev)
      if (e.comfort === true && ce.indexOf(poolOf(ev)) >= 0) g.cePending.add(ev)
    }
  }
  return g
}

// ------------------------------------------------------------------ one hour
function simulate (comfortMain, seed, catFile, gate) {
  const c = P.load([P.MOCKS, P.CORE, catFile, P.RES])
  const M = c.__pneMock
  const srv = M.server({ owner: 'Host' })
  srv.level.getDayTime = () => (srv.gameTime + 6000) % 24000
  c.pneHStage = function () { return 3 }
  M.fire('ServerEvents.loaded', { server: srv })
  const main = M.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', { x: 0, y: 64, z: 0 })
  const side = M.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: 10, y: 64, z: 0 })
  if (!comfortMain) main.addTag('pne_comfort_off')
  else side.addTag('pne_comfort_off')
  const log = []
  const run = srv.runCommandSilent
  // each command carries every player's pacing state at that moment (from the cached Pace) for the override checks
  srv.runCommandSilent = function (cmd) {
    const st = {}
    for (const pl of [main, side]) {
      const R = c.pneResP[pl.uuid]
      if (R && R.pace) st[pl.uuid] = { s: R.pace.state, v: R.pace.mercy === true || R.pace.grace === true, rel: R.relStart }
    }
    log.push({ t: c.pneCoreTick, cmd: String(cmd), st: st })
    return run(cmd)
  }
  const r = rng(seed)
  // scripted world state for the main player
  const w = { near: 32, n16: 0, light: 12, tsd: 600, seen: false }
  c.pneOraSnap = function (p) {
    if (p === main) return { tick: c.pneCoreTick, nearest: w.near, n16: w.n16, light: w.light, hp: main.hp / 20, tSinceDmg: w.tsd, hostileSeen: w.seen }
    return { tick: c.pneCoreTick, nearest: 32, n16: 0, light: 10, hp: 1, tSinceDmg: 600, hostileSeen: false }
  }
  const trace = [] // per second: pace of main
  let phase = 'calm'; let phaseLeft = 120; let nextKill = 0; let nextTell = 0; let lastHeartbeat = 0; let hordeCalled = false
  const horde = [1800, 2700]
  const deathAt = 2400
  let mercyLeft = 0
  for (let s = 0; s < HOUR / 20; s++) {
    // scenario, once per second
    if (--phaseLeft <= 0) {
      if (phase === 'calm') { phase = 'approach'; phaseLeft = 25 + Math.floor(r() * 15) } else if (phase === 'approach') { phase = 'fight'; phaseLeft = 30 + Math.floor(r() * 40) } else if (phase === 'fight') { phase = 'retreat'; phaseLeft = 20 } else { phase = 'calm'; phaseLeft = 90 + Math.floor(r() * 150) }
    }
    if (phase === 'calm') { w.near = 32; w.n16 = 0; w.seen = false }
    if (phase === 'approach') { w.near = Math.max(5, w.near - 1.2); w.n16 = w.near < 16 ? 2 : 0; w.seen = w.near < 20 }
    if (phase === 'fight') { w.near = 1.5 + r() * 3; w.n16 = 3 + Math.floor(r() * 4); w.seen = true; if (r() < 0.25) { w.tsd = 0; main.hp = Math.max(4, main.hp - 2) } }
    if (phase === 'retreat') { w.near = Math.min(32, w.near + 1.5); w.n16 = w.near < 16 ? 1 : 0; w.seen = false }
    w.tsd = w.tsd + 1
    if (phase !== 'fight' && main.hp < 20 && mercyLeft <= 0) main.hp = Math.min(20, main.hp + 0.5)
    if (phase === 'fight' && s > 900 && s < 1000 && mercyLeft === 0) { main.hp = 5; mercyLeft = 20 }
    if (mercyLeft > 0 && --mercyLeft === 0) main.hp = 20
    // a death: the player respawns at base, away from the fight, and spends the 120 s grace there
    if (s === deathAt) { main.hp = 20; M.fire('PlayerEvents.respawned', { player: main }); phase = 'calm'; phaseLeft = 150; w.tsd = 600 }
    w.light = ((srv.gameTime + 6000) % 24000) > 13000 ? 3 : 12
    const inHorde = s >= horde[0] && s < horde[1]
    if (s === horde[0]) { main.addTag('pne_horde'); side.addTag('pne_horde') }
    if (s === horde[1]) { main.removeTag('pne_horde'); side.removeTag('pne_horde') }
    for (let k = 0; k < 20; k++) {
      M.tick(srv, 1)
      const t = c.pneCoreTick
      // existing pne_horror.js sounds at their real parameters
      if (phase === 'fight' && t >= nextKill) {
        nextKill = t + 60 + Math.floor(r() * 60)
        const mx = 2 + r() * 4
        c.pneCoreEmitAt(srv, 'minecraft:overworld', mx, 64.6, 0, 24, 'epca:slam', 'hostile', 0.7, { pitch: 0.7, lf: true, cls: 'slam', src: 'horror' })
        if (r() < 0.5) c.pneCoreEmitAt(srv, 'minecraft:overworld', mx, 64.6, 0, 20, 'minecraft:entity.slime.squish_small', 'hostile', 1, { pitch: 0.5, cls: 'squish', src: 'horror' })
        if (r() < 0.08) {
          // beckon spot 33 blocks from the main player and 23 from the side player (in the pack a beckon only
          // spawns with no player within 24, so its vol-1.5 call never reaches anyone; the side player here
          // exercises the ledger path)
          c.pneCoreEmitAt(srv, 'minecraft:overworld', 33, 64, 0, 96, 'minecraft:block.bell.use', 'hostile', 4, { pitch: 0.5, cls: 'bell', src: 'horror' })
          c.pneCoreEmitAt(srv, 'minecraft:overworld', 33, 64, 0, 48, 'epca:beckon_stage1', 'hostile', 1.5, { pitch: 0.8, cls: 'beckon', src: 'horror' })
        }
      }
      if (inHorde && t % 20 === 5) {
        if (!hordeCalled) { hordeCalled = true; for (const p of [main, side]) c.pneCoreEmit(p, 'epca:beckon_stage2', 'hostile', '~ ~ ~', 1, { pitch: 0.6, cls: 'beckon2', src: 'horror' }) }
        if (t - lastHeartbeat >= 300) {
          lastHeartbeat = t
          for (const p of [main, side]) c.pneCoreEmit(p, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' })
          if (r() < 0.3) for (const p of [main, side]) c.pneCoreEmit(p, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 2, { pitch: 0.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' })
        }
      }
      // HIVE-style tells: one per 100 ticks for a silent mob 8 blocks away while engaged
      if ((phase === 'approach' || phase === 'fight') && t >= nextTell && w.near < 12) {
        nextTell = t + 100
        c.pneCoreTell(M.mob(srv, 'epca:ripper', { x: 8, y: 64, z: 0 }), main)
      }
    }
    const pc = c.pneResPace(main)
    trace.push(pc ? { t: c.pneCoreTick, state: pc.state, tier: pc.tier, mercy: pc.mercy, grace: pc.grace } : null)
  }
  return { c, srv, log, trace, gate, players: { [main.uuid]: { p: main, comfort: comfortMain, x: 0 }, [side.uuid]: { p: side, comfort: !comfortMain, x: 10 } } }
}

// ------------------------------------------------------------------ independent checks
function check (label, sim) {
  const cat = sim.c.PNE_RES_CATALOG.events
  const rxPlay = /^execute as (\S+) at @s (rotated ~ 0 )?run playsound (\S+) (\S+) @s (\S+) (\S+) (\S+) (\S+) (\S+)$/
  // groups: 1 uuid, 3 event, 4 category, 5-7 position, 8 volume, 9 pitch
  const rxStop = /^stopsound (\S+) (\S+) (\S+)$/
  const per = {}
  const stats = { onsets: 0, stops: 0, ext: {}, res: {}, maxBus: -120, maxRise: -99, earlyStops: 0, mmaxStep: {}, cePending: {} }
  const gate = sim.gate
  const V = {}
  const bad = (k, msg) => { if (!V[k]) V[k] = { n: 0, first: msg }; V[k].n++ }
  for (const u of Object.keys(sim.players)) per[u] = { inst: [], last: {}, lastOnset: -1e9, lf: [], resE: [], hb: -1e9 }
  function busAt (S, t) { return psum(S.inst.filter(x => x.t0 <= t && t < x.t1).map(x => x.lu)) }
  for (const e of sim.log) {
    let m = rxStop.exec(e.cmd)
    if (m && per[m[1]]) {
      const S = per[m[1]]
      const x = S.inst.filter(i => i.ev === m[3] && i.t0 <= e.t && e.t < i.t1).pop()
      stats.stops++
      if (!x) { bad('stop_untracked', e.cmd); continue }
      const fade = FADE[x.layer] || 0
      if (e.t < x.t1 - fade - 6) { stats.earlyStops++; bad('early stopsound', e.cmd + ' at ' + e.t + ', fade starts ' + (x.t1 - fade)) }
      x.t1 = e.t
      continue
    }
    m = rxPlay.exec(e.cmd)
    if (!m || !per[m[1]]) continue
    const u = m[1]; const S = per[u]; const pl = sim.players[u]; const t = e.t
    const ev = m[3]
    const px = [m[5], m[6], m[7]]; const volP = Number(m[8]); const pitchP = Number(m[9])
    if (!(volP > 0) || !(pitchP > 0)) { bad('unparsable volume or pitch', e.cmd); continue }
    let feet; let eye
    if (px.every(q => q[0] === '~' || q[0] === '^')) {
      const o = px.map(q => q.length > 1 ? Number(q.slice(1)) : 0)
      feet = Math.hypot(o[0], o[1], o[2]); eye = Math.hypot(o[0], o[1] - EYE, o[2])
    } else {
      const o = px.map(Number)
      feet = Math.hypot(o[0] - pl.x, o[1] - 64, o[2]); eye = Math.hypot(o[0] - pl.x, o[1] - 64 - EYE, o[2])
    }
    let info; let layer = 'ext'; let cls = ''; let isRes = false; let lf = false; let sting = false; let comfortOk = true
    if (cat[ev]) {
      const ce = cat[ev]
      info = { vars: [{ l: ce.lufs, m: ce.mmax, sv: 1 }], dur: ce.dur, att: ce.att }
      layer = ce.layer; cls = ce.cls; isRes = true; lf = ce.lf; sting = ce.layer === 'L7'; comfortOk = ce.comfort
      if (ce.amb) bad('stereo bed issued', ev)
    } else {
      info = externalInfo(ev)
      if (!info) { bad('unknown event', ev); continue }
      cls = EXT_LF[ev] || ''
      lf = !!EXT_LF[ev]
      sting = !!STINGER_EXT[ev]
    }
    if (feet > 16 * Math.max(1, volP) + 1e-6) bad('sent beyond the /playsound range', e.cmd)
    const lvl = (field) => Math.max(...info.vars.map(v => { const vt = volP * v.sv; return v[field] + db(Math.min(vt, 1) * Math.max(0, 1 - eye / (Math.max(vt, 1) * info.att))) }))
    const lu = lvl('l'); const mm = lvl('m')
    // the onset step: the catalog's mmax for a file with no in-file rise to grade (V15 not applicable), else lufs
    const mmaxStep = isRes && gate.onsetMmax.has(ev)
    const step = mmaxStep ? mm : lu
    if (mmaxStep) stats.mmaxStep[ev] = (stats.mmaxStep[ev] || 0) + 1
    const dur = Math.max(1, Math.ceil(info.dur / Math.max(0.5, pitchP) * 20))
    const comfort = pl.comfort
    stats.onsets++
    const key = isRes ? 'res.' + layer + '.' + cls : ev
    const bucket = isRes ? stats.res : stats.ext
    bucket[key] = (bucket[key] || 0) + 1
    // 1. immediate repeats per pool
    if (isRes) {
      const pool = layer + '.' + cls
      if (S.last[pool] === ev) bad('immediate repeat', pool + ' ' + ev + ' at ' + t)
      S.last[pool] = ev
    }
    // comfort envelope rule and comfort asset rules
    const isTell = layer === 'L8'
    // TDD 2.5.4 overrides, from the pacing state when the command ran
    const ps = e.st ? e.st[u] : null
    if (isRes && !isTell && ps) {
      if (ps.s === 'PANIC' && (['L1', 'L2', 'L4', 'L5'].indexOf(layer) >= 0 || (layer === 'L3' && cls !== 'heartbeat' && cls !== 'heartbeat_c'))) bad('A5: bed, L2, L3 flutter/rough, L4 or whisper in PANIC', ev + ' at ' + t)
      if (ps.s === 'RELEASE' && t - ps.rel < 200) bad('L0 (c): Resonance onset in the first 10 s of RELEASE', ev + ' at ' + (t - ps.rel))
      if (ps.v && ['L2', 'L3', 'L4', 'L6', 'L7'].indexOf(layer) >= 0) bad('mercy/grace: L2, L3, L4, L6 or L7', ev + ' at ' + t)
    }
    if (ev === 'spore:heart_beat') {
      if (t - S.hb < (comfort ? 1400 : 700)) bad('Hive Night heartbeat interval', (t - S.hb) + ' ticks ' + (comfort ? '(comfort, >= 1400)' : '(normal, >= 700)'))
      S.hb = t
    }
    if (comfort) {
      // the comfort envelope rule inside the file: PENDING a lead decision for these pools (never counted as a pass)
      if (isRes && gate.cePending.has(ev)) stats.cePending[poolOf(ev)] = (stats.cePending[poolOf(ev)] || 0) + 1
      if (isRes && !comfortOk) bad('comfort-excluded asset in comfort mode', ev)
      if (sting) bad('stinger in comfort mode', ev)
      if (!isTell && S.inst.filter(x => !x.tell && x.t0 > t - 20).length >= 2) bad('comfort: more than 2 onsets within 1 s', ev + ' at ' + t)
      if (lf && !(cls === 'heartbeat_c' || cls === 'hive_heartbeat' || cls === 'slam')) bad('comfort LF class', ev)
    } else if (isRes && cat[ev].normal === false) bad('comfort-only asset in normal mode', ev)
    // 3. level jump / stinger rule
    const W = comfort ? 40 : 60; const lim = comfort ? 6 : 10
    const before = busAt(S, t)
    let ref = 99
    for (let k = t - W; k <= t; k++) ref = Math.min(ref, Math.max(FLOOR, busAt(S, k)))
    const after = psum([before, lu])
    const afterStep = psum([before, step])
    if (sting && !comfort) {
      let p = 0
      for (let k = 1; k <= 60; k++) p += Math.pow(10, Math.max(FLOOR, busAt(S, t - k)) / 10)
      const st = 10 * Math.log10(p / 60)
      if (mm > st + 18 + 0.01) bad('stinger above trailing short-term + 18 LU', ev + ' ' + mm.toFixed(2) + ' vs ' + st.toFixed(2))
    } else {
      if (afterStep - ref > lim + 0.01) bad('level jump (' + (isTell ? 'tell' : isRes ? 'res' : 'existing') + ')', ev + ' rise ' + (afterStep - ref).toFixed(2) + (mmaxStep ? ' (mmax onset step)' : '') + ' at ' + t)
      stats.maxRise = Math.max(stats.maxRise, afterStep - ref)
    }
    // 2. bus ceiling
    if (after > -18 + 0.01) bad('bus above -18 LU', ev + ' ' + after.toFixed(2) + ' at ' + t)
    stats.maxBus = Math.max(stats.maxBus, after)
    // 4. A8
    if (lf) {
      const capInst = comfort ? 160 : 200; const rest = comfort ? 4 : 2; const duty = comfort ? 600 : 1200
      if (dur > capInst) bad('LF instance too long', ev + ' ' + dur)
      for (const x of S.lf) if (x.t0 <= t && t < x.t1) bad('two LF sources at once', ev + ' at ' + t)
      const prev = S.lf[S.lf.length - 1]
      if (prev && t < prev.t1 + rest * (prev.t1 - prev.t0)) bad('LF rest < ' + rest + 'x on-time', ev + ' at ' + t)
      if (prev && comfort && (prev.cls === 'slam' || cls === 'slam') && t < prev.t1 + 200) bad('comfort slam within 10 s of another LF', ev)
      let on = dur
      for (const x of S.lf) on += Math.max(0, Math.min(x.t1, t + dur) - Math.max(x.t0, t + dur - 12000))
      if (on > duty) bad('LF duty over the rolling 10 min', ev + ' ' + on)
      S.lf.push({ t0: t, t1: t + dur, cls })
    }
    // per-minute budget (Resonance only, tells excepted as fairness cues)
    if (isRes && !isTell) {
      let E = Math.pow(10, lu / 10) * dur / 20
      for (const x of S.inst) if (x.res && !x.tell && x.t0 > t - 1200) E += Math.pow(10, x.lu / 10) * (x.t1 - x.t0) / 20
      const L60 = 10 * Math.log10(E / 60)
      if (L60 > (comfort ? -30 : -27) + 0.01) bad('per-minute Resonance budget', ev + ' ' + L60.toFixed(2))
    }
    S.inst.push({ ev, t0: t, t1: t + dur, lu, layer, res: isRes, tell: isTell })
    S.lastOnset = t
  }
  // L0 (a): >= 30% silence (no Resonance layer) in the QUIET tier, including mercy, grace and RELEASE (PANIC plays
  // no bed at all, so it is left out rather than allowed to pad the figure)
  const mainU = Object.keys(sim.players).find(u => sim.players[u].x === 0)
  const S = per[mainU]
  let q = 0; let silent = 0
  for (const s of sim.trace) {
    if (!s || s.tier !== 'QUIET' || s.state === 'PANIC') continue
    for (let k = 0; k < 20; k++) {
      const t = s.t + k
      q++
      if (!S.inst.some(x => x.res && x.t0 <= t && t < x.t1)) silent++
    }
  }
  const silentPct = q ? silent / q : 1
  if (silentPct < 0.3) bad('L0 (a) QUIET silence < 30%', (100 * silentPct).toFixed(1) + '%')
  // the same figure over the mercy/grace seconds alone (about 140 s of the hour: a 20 s mercy window and the
  // 120 s respawn grace at base), where QUIET is forced: the bed keeps its runs and gaps there too.
  let qv = 0; let sv = 0
  for (const s of sim.trace) {
    if (!s || !(s.mercy || s.grace) || s.state === 'PANIC') continue
    for (let k = 0; k < 20; k++) {
      const t = s.t + k
      qv++
      if (!S.inst.some(x => x.res && x.t0 <= t && t < x.t1)) sv++
    }
  }
  const silentVuln = qv ? sv / qv : 1
  if (qv < 1200) bad('mercy/grace coverage', (qv / 20) + ' s')
  if (silentVuln < 0.3) bad('L0 (a) silence under mercy/grace < 30%', (100 * silentVuln).toFixed(1) + '% of ' + (qv / 20) + ' s')
  const CATS = ['immediate repeat', 'bus above -18 LU', 'level jump (existing)', 'level jump (res)', 'level jump (tell)',
    'stinger above trailing short-term + 18 LU', 'LF instance too long', 'two LF sources at once', 'LF rest < 2x on-time',
    'LF rest < 4x on-time', 'comfort slam within 10 s of another LF', 'LF duty over the rolling 10 min',
    'comfort-excluded asset in comfort mode', 'stinger in comfort mode', 'comfort: more than 2 onsets within 1 s', 'comfort LF class',
    'comfort-only asset in normal mode', 'per-minute Resonance budget', 'L0 (a) QUIET silence < 30%', 'early stopsound',
    'stop_untracked', 'sent beyond the /playsound range', 'stereo bed issued', 'unknown event', 'unparsable volume or pitch',
    'A5: bed, L2, L3 flutter/rough, L4 or whisper in PANIC', 'L0 (c): Resonance onset in the first 10 s of RELEASE',
    'mercy/grace: L2, L3, L4, L6 or L7', 'Hive Night heartbeat interval', 'mercy/grace coverage', 'L0 (a) silence under mercy/grace < 30%']
  for (const k of CATS) T.ok(!V[k], label + ': ' + k + (V[k] ? ' x' + V[k].n + ' (first: ' + V[k].first + ')' : ': none'))
  for (const k of Object.keys(V)) if (CATS.indexOf(k) < 0) T.ok(false, label + ': ' + k + ' x' + V[k].n + ' (first: ' + V[k].first + ')')
  const states = {}
  for (const s of sim.trace) if (s) states[s.state] = (states[s.state] || 0) + 1
  return { stats, silentPct, silentVuln, vulnS: qv / 20, states, why: sim.c.pneResStats.why, issued: sim.c.pneResStats.issued, refused: sim.c.pneResStats.refused }
}

// The synthetic catalog always; RESONANCE's generated catalog too when it has events.
const catalogs = [['test catalog', P.TEST_CAT, false]]
const REAL_CAT = 'overrides/kubejs/server_scripts/pne_res_catalog.js'
try {
  const line = fs.readFileSync(path.join(P.ROOT, REAL_CAT), 'utf8').split(String.fromCharCode(10))[2] || ''
  const real = JSON.parse(line.slice('var PNE_RES_CATALOG = '.length))
  if (Object.keys(real.events || {}).length) catalogs.push(['generated catalog (' + Object.keys(real.events).length + ' events)', REAL_CAT, true])
} catch (e) { console.log('generated catalog not usable here (' + e.message + '); synthetic catalog only') }
const out = {}
const pendingTotal = {}
for (const [catLabel, catFile, useManifest] of catalogs) {
// read in a bare context (P.load would advance the per-world seed counter and change every simulated world)
const cat0 = (function () { const cx = require('vm').createContext({}); require('vm').runInContext(fs.readFileSync(path.join(P.ROOT, catFile), 'utf8'), cx); return cx.PNE_RES_CATALOG })()
const gate = assetGate(catLabel, cat0, useManifest)
console.log(catLabel + ': onset step = catalog mmax for ' + gate.onsetMmax.size + ' file(s) with V15 not applicable (' + gate.source + ')' +
  (gate.onsetMmax.size ? ': ' + Array.from(gate.onsetMmax).sort().join(', ') : '') + '; comfort envelope PENDING (tdd_pins.PENDING_CE ' +
  gate.ce.join(', ') + '): ' + gate.cePending.size + ' comfort event(s)')
for (const [mode, comfort] of [['normal', false], ['comfort', true]]) {
  const label = mode + ', ' + catLabel
  const sim = simulate(comfort, comfort ? 777 : 20260927, catFile, gate)
  const r = check(label, sim)
  // the director treats every file shorter than PNE_RES_SHORT_S as having no in-file rise: that must cover the set
  const shortS = Number(sim.c.PNE_RES_SHORT_S)
  const uncovered = Array.from(gate.onsetMmax).filter(ev => !(Number(cat0.events[ev].dur) < shortS))
  T.ok(uncovered.length === 0, label + ': the director applies the mmax onset step to every V15-not-applicable file (PNE_RES_SHORT_S ' + shortS + ' s)' +
    (uncovered.length ? ': missing ' + uncovered.join(', ') : ''))
  if (gate.onsetMmax.size) T.ok(Object.keys(r.stats.mmaxStep).length > 0, label + ': V15-not-applicable files were issued and checked with the mmax onset step ' + JSON.stringify(r.stats.mmaxStep))
  // each run has one comfort player (the main player in the comfort run, the side player in the normal run)
  for (const k of Object.keys(r.stats.cePending)) pendingTotal[k] = (pendingTotal[k] || 0) + r.stats.cePending[k]
  console.log('  ' + label + ': PENDING lead decision (comfort envelope rule, tdd_pins.PENDING_CE; reported, not graded): comfort-player onsets ' + JSON.stringify(r.stats.cePending))
  out[label] = r
  const ext = r.stats.ext
  T.ok(r.stats.onsets > 300, label + ': enough onsets simulated (' + r.stats.onsets + ')')
  T.ok(r.states.PANIC > 0 && r.states.RELEASE > 0 && r.states.DREAD > 0, label + ': the hour covers DREAD, PANIC and RELEASE (' + JSON.stringify(r.states) + ')')
  for (const ev of ['epca:slam', 'minecraft:entity.slime.squish_small', 'minecraft:block.bell.use', 'epca:beckon_stage2', 'spore:heart_beat']) {
    T.ok((ext[ev] || 0) > 0, label + ': existing sound ' + ev + ' went through the ledger')
  }
  // beckon stage 1 (vol 1.5, sounds.json 0.69 after the trim: client range ~16.6 blocks) is placed >= 23 blocks
  // from everyone here, as the pack's beckon rule requires: it must be refused as inaudible, never sent
  T.ok(!(ext['epca:beckon_stage1'] > 0) && (r.why.inaudible || 0) > 0, label + ': beckon stage 1 at the pack\'s beckon distance is refused as inaudible, not sent')
  T.ok((ext['epca:infested_enderman_scream'] || 0) > 0, label + ': the scream played for the normal-mode player of the pair')
  T.ok(r.stats.stops > 0 || comfort, label + ': PANIC drain used /stopsound inside fades (' + r.stats.stops + ')')
  T.ok(r.stats.earlyStops === 0, label + ': no early /stopsound')
  console.log(label + ': onsets ' + r.stats.onsets + ', stops ' + r.stats.stops + ', max bus ' + r.stats.maxBus.toFixed(2) +
    ' LU, max rise ' + r.stats.maxRise.toFixed(2) + ' LU, QUIET silence ' + (100 * r.silentPct).toFixed(1) + '% (mercy/grace ' + (100 * r.silentVuln).toFixed(1) + '% of ' + r.vulnS + ' s), issued ' + r.issued + ', refused ' + r.refused)
  console.log('  res: ' + JSON.stringify(r.stats.res))
  console.log('  ext: ' + JSON.stringify(ext))
  console.log('  refusals: ' + JSON.stringify(r.why))
}
}
const pendN = Object.keys(pendingTotal).reduce((a, k) => a + pendingTotal[k], 0)
T.done(Object.keys(out).map(k => k + ': max bus ' + out[k].stats.maxBus.toFixed(2) + ' LU').join('; ') +
  '; comfort envelope rule PENDING lead decision for ' + pendN + ' comfort onsets ' + JSON.stringify(pendingTotal) + ' (not graded)')
