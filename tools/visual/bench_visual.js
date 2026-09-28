// Script-side cost of pne_visual.js in the real Rhino fork (suite visual-rhino-bench). ES5. Files, in order:
// tools/tests/kjs_mocks.js, tools/visual/vis_prelude.js, pne_00_core.js, pne_visual.js, this file.
//
// The world (200 engaged hosts, 30 grafts, 250 team entries of which 50 leaked) is built with the mock interpreter, then
// runCommandSilent is replaced by a stub that returns 1, so the numbers are VISUAL's own logic per call:
// bookkeeping, scoreboard reads, string building. Minecraft's own command execution is NOT included (checked in
// game with spark), and mock objects are plain JS, so in-game Java calls add to these figures. Timing uses Date
// (ms resolution) averaged over many iterations: the class filter allows no nanosecond clock (F25).
// Result: pneVisBenchResult = "PASS visual bench: ..." The bench fails only when one scheduled step's logic alone
// exceeds 1 ms, which would put I9 (3 ms per tick) at risk before any command runs, or when one scan record costs
// more than a graftSync token covers (PNE_CORE_COST.graftSync / PNE_VIS_SCAN_PER_TOKEN). The figures are reported
// for the lead's PNE_CORE_COST table (visApply, graftSync, sweep).

// Mean ms per call in the fastest of 5 trials (n calls in total): other processes on the machine only ever add
// time, so the minimum is the least noisy estimate of the code's own cost.
function pneVisBenchTime(fn, n) {
  var per = Math.max(1, Math.floor(n / 5))
  var best = Infinity
  var t0
  var i
  var k
  var ms
  for (k = 0; k < 5; k++) {
    t0 = Date.now()
    for (i = 0; i < per; i++) fn(k * per + i)
    ms = (Date.now() - t0) / per
    if (ms < best) best = ms
  }
  return best
}

function pneVisBenchUs(ms) {
  return (ms * 1000).toFixed(1) + ' us'
}

function pneVisBenchRun() {
  var srv = __pneMock.server({})
  var player = __pneMock.player(srv, 'Cara', 'cccc0000-0000-4000-8000-000000000003', { x: 0, y: 64, z: 0 })
  var hosts = []
  var i
  var h
  var s
  var ms
  var out = []
  var fails = []
  var grafted = []
  var info
  var E = [0.1, 0.2, 0.3, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0]
  var per
  var guard
  PNE_CORE_BUDGET_MS = 1e9
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  srv.tickCount = 2000
  __pneMock.tick(srv, 1)
  for (i = 0; i < 200; i++) {
    s = '000000000000' + i
    h = __pneMock.mob(srv, 'epca:ripper', { uuid: 'be7c0000-0000-4000-8000-' + s.substring(s.length - 12), x: i % 20, z: Math.floor(i / 20), bodyYaw: i })
    h.target = player
    hosts.push(h)
    pneCoreLeftMs = 1e9
    pneVisApply(h, { clade: i % 4, apex: i % 25 === 0, graft: 1 + (i % 4), stage: 6, strain: 'epca', e: E })
  }
  // the scan grants the grafts (15% of 200 engaged hosts = 30)
  for (guard = 0; guard < 200 && pneVisGraftN < 30; guard++) {
    pneCoreLeftMs = 1e9
    pneVisScanStep(srv, 1000)
  }
  for (i = 0; i < 50; i++) srv.runCommandSilent('team join pne_clade_1 dead0000-0000-4000-8000-0000000000' + (10 + i))
  for (i = 0; i < hosts.length; i++) {
    if (pneVisGraftOf(hosts[i])) grafted.push(hosts[i])
  }
  out.push(hosts.length + ' engaged hosts, ' + grafted.length + ' grafts, 250 team entries')
  if (grafted.length !== 30) fails.push('expected 30 grafts, got ' + grafted.length)
  srv.runCommandSilent = function (cmd) { return 1 }

  ms = pneVisBenchTime(function (k) {
    var j = k % 200
    pneCoreLeftMs = 1e9
    pneVisApply(hosts[j], { clade: j % 4, apex: j % 25 === 0, graft: 1 + (j % 4), stage: 6, strain: 'epca', e: E })
  }, 20000)
  out.push('apply no-op ' + pneVisBenchUs(ms))

  info = { clade: 2, apex: false, graft: 0, stage: 2, strain: 'epca', e: null }
  ms = pneVisBenchTime(function (k) {
    var m = hosts[k % 200]
    pneCoreLeftMs = 1e9
    info.clade = k % 4
    pneVisApplyNow(m, m.uuid, pneVisWant(m, info))
  }, 5000)
  out.push('apply (name, team, graft checks) ' + pneVisBenchUs(ms))
  if (ms > 1) fails.push('apply logic ' + ms + ' ms')

  for (i = 0; i < hosts.length; i++) {
    pneCoreLeftMs = 1e9
    pneVisApply(hosts[i], { clade: i % 4, apex: false, graft: 1 + (i % 4), stage: 6, strain: 'epca', e: null })
  }
  pneVisPrune(srv)
  ms = pneVisBenchTime(function (k) {
    var j
    pneCoreLeftMs = 1e9
    for (j = 0; j < grafted.length; j++) grafted[j].bodyYaw = (k * 7 + j) % 360
    pneVisSyncYaw(srv)
  }, 2000)
  out.push('yaw sync ' + pneVisBenchUs(ms / Math.max(1, pneVisGraftN)) + ' per graft (' + pneVisGraftN + ' moving)')
  if (ms > 1) fails.push('yaw sync pass ' + ms + ' ms')

  // the scan in steady state (every record engaged, grafts at the cap: reads only, no command)
  ms = pneVisBenchTime(function (k) {
    pneCoreLeftMs = 1e9
    pneVisScanStep(srv, PNE_VIS_SCAN_STEP)
  }, 4000)
  per = ms / PNE_VIS_SCAN_STEP
  out.push('scan ' + pneVisBenchUs(per) + ' per record (' + PNE_VIS_SCAN_STEP + ' per tick: ' + pneVisBenchUs(ms) + ')')
  if (ms > 1) fails.push('scan step ' + ms + ' ms')
  if (per * PNE_VIS_SCAN_PER_TOKEN > PNE_CORE_COST.graftSync) {
    fails.push('one scan token covers ' + PNE_VIS_SCAN_PER_TOKEN + ' records of ' + pneVisBenchUs(per) + ', more than graftSync')
  }
  ms = pneVisBenchTime(function (k) {
    pneCoreLeftMs = 1e9
    pneVisGraftsCheck(srv)
    pneVisSweepOrphans(srv)
  }, 1000)
  out.push('sweep phase 1 (vis_grafts check, orphans) ' + pneVisBenchUs(ms))
  if (ms > 1) fails.push('sweep phase 1 ' + ms + ' ms')
  ms = pneVisBenchTime(function (k) {
    pneVisTrim(srv, PNE_VIS_TRIM_MAX)
    pneVisRecount()
  }, 1000)
  out.push('phase 2 (trim check of ' + PNE_VIS_TRIM_CHECK + ' engaged records, recount) ' + pneVisBenchUs(ms))
  if (ms > 1) fails.push('sweep phase 2 ' + ms + ' ms')
  ms = pneVisBenchTime(function (k) {
    pneVisStaleStep(srv, PNE_VIS_STALE_SCAN, PNE_VIS_STALE_LOOKUPS, PNE_VIS_STALE_MAX)
  }, 1000)
  out.push('phase 3 (stale window, ' + PNE_VIS_STALE_SCAN + ' entries, ' + PNE_VIS_STALE_LOOKUPS + ' lookups) ' + pneVisBenchUs(ms))
  if (ms > 1) fails.push('sweep phase 3 ' + ms + ' ms')
  ms = pneVisBenchTime(function (k) {
    pneCoreLeftMs = 1e9
    pneVisSweep(srv)
  }, 100)
  out.push('full /pne visual sweep ' + pneVisBenchUs(ms))

  ms = pneVisBenchTime(function (k) {
    pneCoreLeftMs = 1e9
    pneVisFx(srv)
  }, 2000)
  out.push('apex particle pass ' + pneVisBenchUs(ms))

  if (fails.length) return 'FAIL ' + fails.join('; ') + ' | ' + out.join(', ')
  return 'PASS visual bench (Rhino, mock world, command execution excluded): ' + out.join(', ')
}

var pneVisBenchResult = (function () {
  try {
    return pneVisBenchRun()
  } catch (e) {
    return 'FAIL exception ' + e
  }
})()
