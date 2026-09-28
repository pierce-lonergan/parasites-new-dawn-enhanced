// Suite director-rhino: pne_resonance.js in the instance's real Rhino jar (tools/rhino/pne_rhino.py run), with
// the empty catalog first (no layers, pneResTell false, existing sounds through the ledger), then a missing
// catalog, then a small inline catalog so the layer scheduler, the bags and the drain also run in Rhino.
// global is a real java.util.HashMap here (values read back are wrapped Java objects, contract F6).
// Files, in order: kjs_mocks.js, pne_00_core.js, fixtures/empty_catalog.js, pne_resonance.js, this file.
// Result: pneSmokeResult ('PASS n ...' or 'FAIL ...'). ES5.

var pneSmokeFails = []
var pneSmokeCount = 0
var pneSmokeInfo = ''

function pneSmokeT(cond, msg) {
  pneSmokeCount++
  if (!cond) pneSmokeFails.push(msg)
}

function pneSmokeCmds(srv, from, needle) {
  var out = []
  var i
  for (i = from; i < srv.cmds.length; i++) {
    if (String(srv.cmds[i]).indexOf(needle) >= 0) out.push(String(srv.cmds[i]))
  }
  return out
}

function pneSmokeRun() {
  var srv = __pneMock.server({ owner: 'Host' })
  var brig = __pneMock.brig()
  var p = __pneMock.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  var q = __pneMock.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', { x: 4 })
  var pace
  var n0
  var i
  var k
  var t0
  var dt
  var steps
  var ev
  var cat
  var layers
  var lay
  var got
  var R
  srv.level.getDayTime = function () { return 18000 }
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneOraSnap = function (pl) { return { tick: pneCoreTick, nearest: 32, n16: 0, light: 12, hp: 1, tSinceDmg: 600, hostileSeen: false } }

  pneSmokeT(PNE_RES_API === 1 && pneCoreLoaded('resonance') === true, 'director loaded in Rhino')
  pneSmokeT(pneResPace(p) === null, 'no Pace before the first step')
  __pneMock.tick(srv, 60)
  pace = pneResPace(p)
  pneSmokeT(pace !== null && pace.state === 'CALM' && pace.tier === 'QUIET' && pace.spawn === 1.25, 'Pace after three seconds (CALM, QUIET, 1.25)')
  pneSmokeT(Math.abs(Number(p.persistentData.getDouble('pne_m')) - 1) < 1e-9 && Number(p.persistentData.getLong('pne_m_t')) > 0, 'pne_m and pne_m_t written')
  pneSmokeT(pneCorePace(p).fallback !== true, 'core wrapper serves the director Pace')
  pneSmokeT(pneCat() === null, 'empty catalog: no layers')
  pneSmokeT(pneResTell(p, p) === false, 'empty catalog: pneResTell false')
  n0 = srv.cmds.length
  pneSmokeT(pneCoreEmit(p, 'spore:heart_beat', 'hostile', '~ ~ ~', 0.45, { pitch: 0.9, lf: true, cls: 'hive_heartbeat', src: 'horror' }) === true, 'existing sound plays through the ledger')
  pneSmokeT(pneSmokeCmds(srv, n0, 'execute as aaaa0000-0000-4000-8000-000000000001 at @s run playsound spore:heart_beat hostile @s ~ ~ ~ 0.45 0.90').length === 1, 'ledger command text')
  __pneMock.tick(srv, 400)
  pneSmokeT(pneCoreEmit(p, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 2, { pitch: 0.6, stinger: true, rotated: true, cls: 'scream', src: 'horror' }) === false, 'comfort (default) skips the scream')
  pneSmokeT(pneCoreEmitAt(srv, 'minecraft:overworld', 1, 64, 0, 24, 'epca:slam', 'hostile', 0.7, { pitch: 0.7, lf: true, cls: 'slam', src: 'horror' }) >= 1, 'positional slam through the ledger')
  // mercy
  p.hp = 4
  __pneMock.tick(srv, 20)
  pace = pneResPace(p)
  pneSmokeT(pace.mercy === true && pace.spawn === 0 && pneCoreHasTag(p, 'pne_gate') && pneCoreHasTag(p, 'pne_pace_soft'), 'mercy Pace, pne_gate and pne_pace_soft')
  p.hp = 20
  // commands through the hub
  __pneMock.fire('ServerEvents.commandRegistry', brig.event())
  brig.run('pne comfort off', __pneMock.source(srv, p, 0))
  pneSmokeT(pneCoreHasTag(p, 'pne_comfort_off'), '/pne comfort off')
  brig.run('pne comfort on', __pneMock.source(srv, p, 0))
  pneSmokeT(!pneCoreHasTag(p, 'pne_comfort_off'), '/pne comfort on')
  brig.run('pne resonance whispers off', __pneMock.source(srv, p, 0))
  pneSmokeT(pneCoreHasTag(p, 'pne_res_no_whispers'), '/pne resonance whispers off')
  n0 = srv.cmds.length
  brig.run('pne resonance status', __pneMock.source(srv, p, 0))
  pneSmokeT(pneSmokeCmds(srv, n0, 'tellraw aaaa0000').length === 1, '/pne resonance status replies')
  // pillar off: tags removed, global mirrored (read back as a wrapped Java number)
  p.addTag('pne_gate')
  pneSmokeT(pneCoreSetPillar(srv, 'resonance', false) === true, 'resonance switched off')
  pneSmokeT(Number(global.pneOnResonance) === 0 && !pneCoreHasTag(p, 'pne_gate') && !pneCoreHasTag(p, 'pne_pace_soft'), 'pillar off: global mirrored, director tags removed')
  pneSmokeT(pneResEmit(p, 'pne:res.hollow.dry.v01', 'ambient', '~ ~12 ~', 1, { src: 'res' }) === false, 'pillar off: Resonance events refused')
  pneCoreSetPillar(srv, 'resonance', true)
  // missing catalog
  PNE_RES_CATALOG = undefined
  pneResCatReset()
  __pneMock.tick(srv, 100)
  pneSmokeT(pneResPace(p) !== null && pneResTell(p, p) === false, 'missing catalog: pacing continues, no tells')

  // a small catalog: layers, bags, approach and drain run in Rhino
  cat = { v: 1, gen: 'rhino', events: {}, pools: {} }
  layers = [['L1', 'hollow', 'dry', -30, 7, 128, true, true, false, 'ambient'], ['L1', 'hollow', 'dread', -32, 7, 128, true, true, false, 'ambient'],
    ['L1', 'hollow', 'muffled', -36, 7, 128, true, true, false, 'ambient'], ['L1', 'hollow', 't_dry_muffled', -33, 7, 128, true, true, false, 'ambient'],
    ['L2', 'undertone', 'a', -32, 9, 128, false, true, true, 'ambient'], ['L3', 'pulse', 'heartbeat', -32, 8, 128, false, true, true, 'ambient'],
    ['L3', 'pulse', 'heartbeat_c', -34, 7.5, 128, true, false, true, 'ambient'], ['L4', 'beat', 'slow', -34, 9, 128, true, true, false, 'ambient'],
    ['L4', 'beat', 'tense', -34, 9, 128, false, true, false, 'ambient'], ['L5', 'whisper', 'amb', -28, 3, 32, true, true, false, 'voice'],
    ['L5', 'whisper', 'near', -28, 3, 32, true, true, false, 'voice'], ['L6', 'approach', 'n', -24, 3.5, 128, false, true, false, 'hostile'],
    ['L6', 'approach', 'c', -28, 4, 128, true, false, false, 'hostile'], ['L7', 'spike', 'a', -20, 1.5, 128, false, true, false, 'hostile'],
    ['L8', 'tell', 'a', -22, 0.6, 24, true, true, false, 'hostile']]
  for (i = 0; i < layers.length; i++) {
    lay = layers[i]
    for (k = 1; k <= 6; k++) {
      ev = 'pne:res.' + lay[1] + '.' + lay[2] + '.v0' + k
      cat.events[ev] = { layer: lay[0], cls: lay[2], lufs: lay[3], mmax: lay[3] + 5, dur: lay[4], att: lay[5], comfort: lay[6], normal: lay[7], lf: lay[8], cat: lay[9], reserve: k > 5, amb: false }
    }
  }
  PNE_RES_CATALOG = cat
  pneResCatReset()
  q.addTag('pne_comfort_off')
  pneHStage = function () { return 3 }
  n0 = srv.cmds.length
  got = { tell: pneResTell(__pneMock.mob(srv, 'epca:ripper', { x: 8, y: 64, z: 0 }), p) }
  pneOraSnap = function (pl) {
    var ph = Math.floor(pneCoreTick / 20) % 300
    return { tick: pneCoreTick, nearest: ph < 100 ? 32 : (ph < 200 ? 9 : 3), n16: ph < 100 ? 0 : 4, light: 4, hp: 1, tSinceDmg: (ph > 220 && ph < 230) ? 0.5 : 600, hostileSeen: ph >= 100 }
  }
  __pneMock.tick(srv, 20 * 900)
  got.beds = pneSmokeCmds(srv, n0, 'playsound pne:res.hollow.').length
  got.layers = pneSmokeCmds(srv, n0, 'playsound pne:res.').length
  got.stops = pneSmokeCmds(srv, n0, 'stopsound ').length
  pneSmokeT(got.tell === true, 'tell plays with a catalog')
  pneSmokeT(got.beds > 50 && got.layers > got.beds, 'layers scheduled in Rhino (' + got.layers + ' onsets, ' + got.beds + ' bed segments)')
  pneSmokeT(pneResStats.issued > 0, 'ledger issued sounds (' + pneResStats.issued + ', refused ' + pneResStats.refused + ', drained ' + pneResStats.stopped + ')')
  // Rhino cost of one director step (1 Hz per player) with the catalog, and of one ledger decision
  R = pneResP['aaaa0000-0000-4000-8000-000000000001']
  // (the player's ledger and queue are restored before every step, so the state does not pile up at one tick)
  steps = 4000
  got.pinst = R.led.inst.slice(0)
  got.plf = R.led.lfHist.slice(0)
  for (i = 0; i < 6000 + steps; i++) {
    if (i === 6000) t0 = new Date().getTime()
    R.led.inst = got.pinst.slice(0)
    R.led.lfHist = got.plf.slice(0)
    R.q = []
    pneResStep(p)
  }
  dt = new Date().getTime() - t0
  pneSmokeInfo = 'director step ' + (dt / steps).toFixed(3) + ' ms in Rhino (interpreter, warmed up, catalog, mocks)'
  // one ledger decision against the real state this hour left (restored before every call)
  got.led = pneResP['bbbb0000-0000-4000-8000-000000000002'].led
  got.inst = got.led.inst.slice(0)
  got.lf = got.led.lfHist.slice(0)
  for (i = 0; i < 6000 + steps; i++) {
    if (i === 6000) t0 = new Date().getTime()
    got.led.inst = got.inst.slice(0)
    got.led.lfHist = got.lf.slice(0)
    got.led.lastOnset = -1e9
    pneResEmit(q, 'minecraft:entity.slime.squish_small', 'hostile', '~ ~ ~', 1, { src: 'horror' })
  }
  dt = new Date().getTime() - t0
  pneSmokeInfo += '; ledger decision ' + (dt / steps).toFixed(3) + ' ms with ' + got.inst.length + ' tracked instances'
  pneSmokeT(R && R.pace !== null, 'state kept per player')
  pneSmokeLater(srv, p)
}

// The review-round paths in Rhino: the A1 bag build (Array lastIndexOf, splice), refused probes, and PANIC under
// mercy. Runs after the cost measurement, so the costs above are unaffected.
function pneSmokeLater(srv, p) {
  var R = pneResP['aaaa0000-0000-4000-8000-000000000001']
  var realTake = pneCoreTake
  var realRand = pneResRand
  var ids = []
  var last = {}
  var minGap = 1e9
  var i
  var ev
  var n0
  var mine
  var t0
  for (i = 1; i <= 12; i++) ids.push('pne:rhino.pool12.v' + (i < 10 ? '0' : '') + i)
  R.bags = {}
  for (i = 0; i < 2400; i++) {
    ev = pneResPick(R, 'T.pool12', ids, 100 + i)
    if (last.hasOwnProperty(ev)) minGap = Math.min(minGap, i - last[ev] - 1)
    last[ev] = i
  }
  pneSmokeT(minGap >= 6, 'A1 half-pool rule in Rhino (min gap ' + minGap + ' over 2400 picks of 12)')
  // probe sensing (the mock answers 1 per probe command), then the budget refuses every probe
  pneOraSnap = undefined
  __pneMock.tick(srv, 40)
  pneSmokeT(R.sense.src === 'probe' && R.sense.nearest === 2, 'probe sensing in Rhino (' + R.sense.src + ', nearest ' + R.sense.nearest + ')')
  pneCoreTake = function (ms) { return ms === PNE_CORE_COST.emit ? false : realTake(ms) }
  __pneMock.tick(srv, 20)
  pneSmokeT(R.sense.src === 'probe-stale' && R.sense.nearest === 2, 'refused probe in Rhino: the last reading is reused (' + R.sense.src + ', nearest ' + R.sense.nearest + ')')
  __pneMock.tick(srv, 60)
  t0 = R.pace.tick
  __pneMock.tick(srv, 40)
  pneSmokeT(R.pace.tick === t0, 'refused probes past 3 s in Rhino: the step is skipped')
  pneCoreTake = realTake
  // PANIC under mercy, every hazard forced: the director issues nothing for this player (A5 + mercy)
  pneOraSnap = function () { return { tick: pneCoreTick, nearest: 2, n16: 8, light: 0, hp: 0.2, tSinceDmg: 600, hostileSeen: true } }
  p.hp = 4
  __pneMock.tick(srv, 20)
  R.st.fsm.state = 'PANIC'
  R.st.fsm.inState = 1
  R.st.fsm.e = 0.9
  R.last = { wh: -1e9, L2: -1e9, L3: -1e9, L4: -1e9, L6: -1e9 }
  R.panicSeen = false
  pneResRand = function () { return 0.001 }
  n0 = srv.cmds.length
  __pneMock.tick(srv, 200)
  pneResRand = realRand
  mine = pneSmokeCmds(srv, n0, 'execute as aaaa0000-0000-4000-8000-000000000001 at @s run playsound pne:res.').concat(
    pneSmokeCmds(srv, n0, 'execute as aaaa0000-0000-4000-8000-000000000001 at @s rotated ~ 0 run playsound pne:res.'))
  pneSmokeT(pneResPace(p).state === 'PANIC' && pneResPace(p).mercy === true && mine.length === 0, 'PANIC under mercy in Rhino: no Resonance layer (' + pneResPace(p).state + ', ' + mine.length + ' onsets)')
  p.hp = 20
}

var pneOraSnap
var pneHStage
var pneSmokeResult = 'FAIL not run'
function pneCat() { return pneResCat() }
try {
  pneSmokeRun()
  pneSmokeResult = pneSmokeFails.length ? 'FAIL ' + pneSmokeFails.length + '/' + pneSmokeCount + ': ' + pneSmokeFails.join(' | ') : 'PASS ' + pneSmokeCount + ' (' + pneSmokeInfo + ')'
} catch (err) {
  pneSmokeResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
