// Tests for overrides/kubejs/server_scripts/pne_visual.js on the mock world. ES5; the same file runs in Node
// (suite visual-node) and in the real Rhino fork (suite visual-rhino). Files, in order: tools/tests/kjs_mocks.js,
// tools/visual/vis_prelude.js, pne_00_core.js, pne_visual.js, this file. Result: pneVisTestResult ("PASS n ..." or
// "FAIL ...").
//
// Covers: clade teams (options incl. collisionRule always, repair of an old rule, assignment, moves, removal, leak
// sweep, name tags given later), grafts only on engaged hosts (a host that targets no player never carries one; the
// graft goes PNE_VIS_LINGER ticks after the target is lost and comes back when it returns), graft caps (<= 1 per
// host, <= 15% of the live engaged hive, also after hosts unload or die; stage >= 4; the scan retries every host
// fairly, including after a failed summon; summons draw their own tokens), graft bookkeeping (tag, pne_host,
// deterministic UUID, riding), yaw sync cadence (t % 3 === 0 only, only on change), the orphan sweep, sweep phases
// on even ticks only, apex naming (dominant counter-trait, ties, foreign names, named-team switch, the pne_vis_apex
// tag and name removal after the pillar switch even for hosts unloaded at the time), trait particles (<= 0.5 Hz,
// only near players), the deferred visApply / removal queues, the pillar switch, rejoin after a chunk reload,
// rediscovery after a reload, multi-dimension hosts, the /pne visual commands, and that no command ever moves a
// camera, applies an effect or changes team collision.

var pneVisTestFails = []
var pneVisTestN = 0
var pneHiveInfo = null   // test double for the hive, installed later (typeof null !== 'function')

function pneVisT(cond, msg) {
  pneVisTestN++
  if (!cond) pneVisTestFails.push(msg)
}

function pneVisTI(clade, apex, graft, stage, e) {
  return { clade: clade, apex: apex, graft: graft, stage: stage, strain: 'epca', e: e || null }
}

function pneVisTU(n) {
  var s = '000000000000' + n
  return '5eed0000-0000-4000-8000-' + s.substring(s.length - 12)
}

function pneVisTFresh() {
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
}

function pneVisTGrafts(host) {
  var out = []
  var i
  for (i = 0; i < host.passengers.length; i++) {
    if (host.passengers[i].tagSet.hasOwnProperty('pne_graft')) out.push(host.passengers[i])
  }
  return out
}

function pneVisTRiding() {
  var ds = __pneVisMock.displays('pne_graft')
  var n = 0
  var i
  for (i = 0; i < ds.length; i++) {
    if (ds[i].vehicle && !ds[i].vehicle.removed) n++
  }
  return n
}

function pneVisTLogSince(k, rx) {
  var out = []
  var i
  for (i = k; i < __pneVisMock.log.length; i++) {
    if (rx.test(__pneVisMock.log[i].c)) out.push(__pneVisMock.log[i])
  }
  return out
}

function pneVisTTickTo(srv, mod, rem) {
  do {
    __pneMock.tick(srv, 1)
  } while (srv.tickCount % mod !== rem)
}

// Ticks until the scan started k more cycles (k = 2: every record was checked at least once since the call).
function pneVisTCycles(srv, k) {
  var c0 = pneVisScanCycles
  var guard = 0
  while (pneVisScanCycles < c0 + (k || 2) && guard < 3000) {
    __pneMock.tick(srv, 1)
    guard++
  }
}

// Live engaged hive from the mock world itself: records whose host is loaded, alive and targets a live player.
function pneVisTLiveEngaged() {
  var k
  var r
  var n = 0
  for (k in pneVisHosts) {
    if (!pneVisHosts.hasOwnProperty(k)) continue
    r = pneVisHosts[k]
    if (r.mob && !r.mob.removed && r.mob.hp > 0 && r.mob.target && !r.mob.target.removed && r.mob.target.typeId === 'minecraft:player') n++
  }
  return n
}

function pneVisTMobs(srv, n, base, type, opts) {
  var out = []
  var i
  var o
  for (i = 0; i < n; i++) {
    o = { uuid: pneVisTU(base + i), x: (opts && opts.x) || 0, z: i }
    if (opts && opts.level) o.level = opts.level
    out.push(__pneMock.mob(srv, type, o))
  }
  return out
}

function pneVisTApplyAll(list, infoFn, target) {
  var i
  for (i = 0; i < list.length; i++) {
    list[i].target = target || null
    pneVisTFresh()
    pneVisApply(list[i], infoFn(i))
  }
}

function pneVisTKill(list) {
  var i
  for (i = 0; i < list.length; i++) {
    pneVisTFresh()
    pneVisRemove(list[i])
    list[i].discard()
  }
}

function pneVisTRun() {
  var srv = __pneMock.server({ owner: 'Host' })
  var player = __pneMock.player(srv, 'Cara', 'cccc0000-0000-4000-8000-000000000003', { x: 0, y: 64, z: 0 })
  var setupLog
  var names
  var i
  var k
  var m1
  var hosts = []
  var geneless = []
  var h
  var g
  var n
  var left
  var before
  var logs
  var ok
  var yawHost
  var still
  var disp
  var orphanHost
  var orphanDisp
  var stray
  var sweptBefore
  var ghost = 'deadbeef-0000-4000-8000-00000000dead'
  var apex
  var named
  var pre
  var stageGroup
  var lateHost
  var q1
  var q2
  var ev
  var nether
  var nh
  var brig
  var src
  var oldBudget
  var rej
  var rej2
  var idleRej
  var idleRej2
  var redHost
  var redDisp
  var fxHost
  var farHost
  var plain
  var fxTicks
  var bad
  var gu
  var nog
  var nog2
  var car
  var rider
  var g1
  var g2
  var gn
  var oldHost
  var oldDisp
  var moved
  var alive
  var killAt
  var summonAt
  var fresh
  var dying
  var arrivals
  var leavers
  var filler
  var riders
  var carriers
  var lone
  var failHost
  var budHost
  var tagHost
  var apexU
  var apexU2
  var phaseTicks
  var origStep
  var cap
  var live

  // ---- load: teams are created on server load with the binding options. A team left by an older version with
  // collisionRule pushOtherTeams (which in 1.20.1 stops members from pushing players and other mobs) is repaired.
  srv.runCommandSilent('team add pne_clade_0')
  srv.runCommandSilent('team modify pne_clade_0 collisionRule pushOtherTeams')
  setupLog = __pneVisMock.log.length
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  srv.tickCount = 999
  __pneMock.tick(srv, 1)
  names = pneVisTeamNames()
  pneVisT(names.length === 8, 'eight teams: pne_clade_0..3 and their _named siblings')
  for (i = 0; i < 4; i++) {
    pneVisT(srv.sb.teams.hasOwnProperty('pne_clade_' + i), 'team pne_clade_' + i + ' exists after server load')
    pneVisT(srv.sb.teams['pne_clade_' + i].nametagVisibility === 'never', 'pne_clade_' + i + ' nametagVisibility never')
    pneVisT(srv.sb.teams['pne_clade_' + i].collisionRule === 'always', 'pne_clade_' + i + ' collisionRule always (vanilla pushing)')
    pneVisT(srv.sb.teams['pne_clade_' + i + '_named'].nametagVisibility === 'always', 'pne_clade_' + i + '_named shows names')
    pneVisT(srv.sb.teams['pne_clade_' + i + '_named'].collisionRule === 'always', 'pne_clade_' + i + '_named collisionRule always')
  }
  pneVisT(pneVisTeamsReady === true, 'teams marked ready')
  pneVisT(typeof pneVisApply === 'function' && typeof pneVisRemove === 'function' && typeof pneVisSweep === 'function' && PNE_VIS_API === 1,
    'contract API present (pneVisApply, pneVisRemove, pneVisSweep, PNE_VIS_API = 1)')
  pneVisT(pneCoreLoaded('visual') === true, 'core sees the visual module as loaded')
  gu = pneVisGraftUuid(pneVisTU(1))
  pneVisT(PNE_VIS_UUID_RX.test(gu) && gu !== pneVisTU(1) && gu === pneVisGraftUuid(pneVisTU(1)), 'graft UUID is deterministic, valid and differs from the host')

  // ---- team assignment, idempotence, moves, invalid clade
  m1 = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(1), x: 3, z: 3 })
  pneVisTFresh()
  pneCoreVisApply(m1, pneVisTI(2, false, 1, 2))
  pneVisT(__pneVisMock.teamOf(srv, m1.uuid) === 'pne_clade_2', 'core wrapper applies: host joins pne_clade_2')
  pneVisT(pneVisTGrafts(m1).length === 0, 'no graft below doom stage 4')
  before = __pneVisMock.log.length
  left = pneCoreLeft()
  pneVisApply(m1, pneVisTI(2, false, 1, 2))
  pneVisT(__pneVisMock.log.length === before, 'identical re-apply issues no command')
  pneVisT(pneCoreLeft() === left, 'identical re-apply charges no budget')
  pneVisApply(m1, pneVisTI(0, false, 0, 2))
  pneVisT(__pneVisMock.teamOf(srv, m1.uuid) === 'pne_clade_0' && __pneVisMock.teamSize(srv, 'pne_clade_2') === 0, 'clade change moves the one entry')
  pneVisApply(m1, pneVisTI(7, false, 0, 2))
  pneVisT(__pneVisMock.teamOf(srv, m1.uuid) === '', 'out-of-range clade leaves the team')
  pneVisApply(m1, pneVisTI(1, false, 0, 2))
  pneVisT(__pneVisMock.teamOf(srv, m1.uuid) === 'pne_clade_1', 'valid clade again joins pne_clade_1')

  // ---- a team that is not ours is respected (another mod's or an operator's)
  h = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(2), x: 3, z: 4 })
  srv.runCommandSilent('team add someone_elses')
  srv.runCommandSilent('team join someone_elses ' + h.uuid)
  pneVisTFresh()
  pneVisApply(h, pneVisTI(2, false, 0, 2))
  pneVisT(__pneVisMock.teamOf(srv, h.uuid) === 'someone_elses', 'apply never moves a mob off a foreign team')
  pneVisTCycles(srv)
  pneVisT(__pneVisMock.teamOf(srv, h.uuid) === 'someone_elses', 'the scan never moves a mob off a foreign team')
  pneVisRemove(h)
  pneVisT(__pneVisMock.teamOf(srv, h.uuid) === 'someone_elses', 'remove never takes a mob off a foreign team')
  srv.runCommandSilent('team leave ' + h.uuid)

  // ---- removal
  pneVisRemove(m1)
  pneVisT(__pneVisMock.teamOf(srv, m1.uuid) === '' && !pneVisHosts.hasOwnProperty(m1.uuid), 'remove: team entry and record gone')
  before = __pneVisMock.log.length
  pneVisRemove(m1)
  pneVisT(pneVisTLogSince(before, /^team leave/).length === 0, 'removing twice issues no team leave (scoreboard read first)')
  pneVisT(pneVisHostN === 0 && pneVisEngN === 0 && pneVisGraftN === 0, 'no records left before the graft tests')

  // ---- grafts exist only while the host is engaged, at stage 4 and up (7 engaged hosts give room for 1 graft)
  stageGroup = pneVisTMobs(srv, 7, 50, 'epca:curbug', { x: 60 })
  pneVisTApplyAll(stageGroup, function (j) { return pneVisTI(1, false, 0, 5) }, player)
  lateHost = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(399), x: 9, z: 9 })
  lateHost.target = player
  pneVisTFresh()
  pneVisApply(lateHost, pneVisTI(1, false, 2, 3))
  pneVisTCycles(srv)
  pneVisT(pneVisEngN === 8 && pneVisGraftCap() === 1, 'engaged hive of 8 gives a cap of 1 (' + pneVisEngN + ', ' + pneVisGraftCap() + ')')
  pneVisT(pneVisTGrafts(lateHost).length === 0 && pneVisHosts[lateHost.uuid].gvar === 0, 'stage 3 host gets no graft despite room under the cap')
  pneVisTFresh()
  pneVisApply(lateHost, pneVisTI(1, false, 2, 4))
  pneVisT(pneVisTGrafts(lateHost).length === 0, 'apply never summons (the scan grants)')
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(lateHost).length === 1 && pneVisGraftN === 1, 'the same host at stage 4 gets its graft from the scan')
  pneVisTFresh()
  pneVisApply(lateHost, pneVisTI(1, false, 0, 4))
  pneVisT(pneVisTGrafts(lateHost).length === 0 && __pneVisMock.displays('pne_graft').length === pneVisTRiding(), 'graft 0 on re-apply removes the graft (no orphan left)')
  pneVisTFresh()
  pneVisApply(lateHost, pneVisTI(1, false, 2, 4))
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(lateHost).length === 1, 'graft back with the occupancy index')
  // the host stops targeting a player: the graft goes after the linger, and never comes back while it is idle
  lateHost.target = null
  __pneMock.tick(srv, 10)
  pneVisT(pneVisTGrafts(lateHost).length === 1, 'a target lost for a moment keeps the graft (linger)')
  __pneMock.tick(srv, PNE_VIS_LINGER)
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(lateHost).length === 0 && pneVisGraftN === 0 && __pneVisMock.displays('pne_graft').length === 0,
    'a host with no target loses its graft within the linger plus one scan cycle (idle hosts are never vehicles)')
  before = __pneVisMock.log.length
  __pneMock.tick(srv, 200)
  pneVisT(pneVisTGrafts(lateHost).length === 0 && pneVisTLogSince(before, /summon/).length === 0, 'an idle host is never grafted')
  lateHost.target = __pneMock.mob(srv, 'minecraft:villager', { uuid: pneVisTU(398), x: 9, z: 10 })
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(lateHost).length === 0, 'a host that targets a non-player is not engaged')
  lateHost.target = player
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(lateHost).length === 1, 'engaged again: the graft comes back')
  pneVisTKill(stageGroup.concat([lateHost]))
  pneVisTCycles(srv)
  pneVisT(pneVisHostN === 0 && pneVisEngN === 0 && pneVisGraftN === 0 && pneVisTRiding() === 0, 'stage group removed, counters back to 0')

  // ---- graft caps: 20 hosts at stage 5 that want a graft. Idle, none; engaged, 3 (15% of 20), one per host
  for (i = 0; i < 20; i++) {
    h = __pneMock.mob(srv, i % 2 ? 'spore:inf_human' : 'epca:infested_zombie', { uuid: pneVisTU(100 + i), x: 4 + i, z: 2 })
    hosts.push(h)
    pneVisTFresh()
    pneVisApply(h, pneVisTI(i % 4, false, 1 + (i % 4), 5))
  }
  pneVisTCycles(srv)
  pneVisT(pneVisHostN === 20 && pneVisEngN === 0, 'host count 20, none engaged (' + pneVisHostN + ', ' + pneVisEngN + ')')
  pneVisT(pneVisTRiding() === 0, 'idle hosts carry no graft')
  for (i = 0; i < 10; i++) hosts[i].target = player
  pneVisTCycles(srv)
  pneVisT(pneVisEngN === 10 && pneVisGraftCap() === 1 && pneVisGraftN === 1, 'the cap counts the engaged hosts only: 10 of 20 engaged -> 1 graft (' + pneVisGraftN + '/' + pneVisGraftCap() + ')')
  for (i = 0; i < 20; i++) hosts[i].target = player
  pneVisTCycles(srv)
  pneVisT(pneVisEngN === 20, 'the scan sees 20 engaged hosts (' + pneVisEngN + ')')
  pneVisT(pneVisTRiding() === 3 && pneVisGraftN === 3, '15% cap: 3 grafts on 20 engaged hosts (riding ' + pneVisTRiding() + ', counted ' + pneVisGraftN + ')')
  ok = true
  for (i = 0; i < hosts.length; i++) {
    g = pneVisTGrafts(hosts[i])
    if (g.length > 1) ok = false
    if (g.length === 1) {
      if (g[0].uuid !== pneVisGraftUuid(hosts[i].uuid)) ok = false
      if (String(g[0].persistentData.getString('pne_host')) !== hosts[i].uuid) ok = false
      if (g[0].typeId !== 'minecraft:item_display' || g[0].item !== PNE_VIS_GRAFTS[i % 4].item) ok = false
      if (!/transformation:\{left_rotation:\[[^\]]+\],right_rotation:\[0f,0f,0f,1f\],translation:\[[^\]]+\],scale:\[[^\]]+\]\}/.test(g[0].nbt)) ok = false
    }
  }
  pneVisT(ok, 'each graft: at most 1 per host, deterministic UUID, pne_host = host UUID, item per variant, full transformation')
  // 7 more engaged hosts without grafts raise the cap to floor(0.15 * 27) = 4; the scan grants one more
  geneless = pneVisTMobs(srv, 7, 200, 'epca:curbug', { x: -5 })
  pneVisTApplyAll(geneless, function (j) { return pneVisTI(3, false, 0, 5) }, player)
  pneVisTCycles(srv)
  pneVisT(pneVisTRiding() === 4 && pneVisGraftN === 4 && pneVisGraftCap() === 4, 'the scan grants a capped graft once the cap allows (4 on 27)')
  ok = true
  for (i = 0; i < geneless.length; i++) {
    if (pneVisTGrafts(geneless[i]).length) ok = false
  }
  pneVisT(ok, 'hosts without a graft gene get none')

  // ---- yaw sync: only on t % 3 === 0, only when the body yaw moved by 2 degrees or more
  yawHost = null
  still = null
  for (i = 0; i < hosts.length; i++) {
    if (pneVisTGrafts(hosts[i]).length && !yawHost) yawHost = hosts[i]
    else if (pneVisTGrafts(hosts[i]).length && !still) still = hosts[i]
  }
  pneVisT(yawHost !== null && still !== null, 'two grafted hosts for the yaw test')
  __pneMock.tick(srv, 3)   // settle: first sync sends every graft's initial yaw
  disp = pneVisTGrafts(yawHost)[0]
  before = __pneVisMock.log.length
  for (i = 1; i <= 12; i++) {
    yawHost.bodyYaw = 10 * i
    __pneMock.tick(srv, 1)
  }
  logs = pneVisTLogSince(before, / run tp @s ~ ~ ~ /)
  ok = logs.length > 0
  for (i = 0; i < logs.length; i++) {
    if (logs[i].t % 3 !== 0) ok = false
    if (logs[i].c.indexOf(disp.uuid) < 0) ok = false
  }
  pneVisT(ok, 'rotation commands only on ticks with t % 3 === 0, only for the moving host (' + logs.length + ')')
  pneVisT(logs.length === 4, 'one rotation per sync tick over 12 ticks (4 sync ticks), got ' + logs.length)
  pneVisT(disp.rotation === yawHost.bodyYaw - 10 * ((srv.tickCount % 3)), 'graft yaw equals the host body yaw at the last sync (' + disp.rotation + ')')
  n = yawHost.bodyYaw === disp.rotation ? 0 : 1
  before = __pneVisMock.log.length
  __pneMock.tick(srv, 9)
  pneVisT(pneVisTLogSince(before, / run tp @s ~ ~ ~ /).length === n, 'no rotation command while the yaw does not change (only the pending last value)')

  // ---- orphan sweep: a host that vanishes without pneVisRemove leaves an orphan display; the sweep kills it
  orphanHost = yawHost
  orphanDisp = pneVisTGrafts(orphanHost)[0]
  orphanHost.discard()
  pneVisT(orphanDisp.vehicle === null && !orphanDisp.removed, 'discarded host ejects its graft (orphan)')
  stray = __pneVisMock.display(srv, 'abcdef00-0000-4000-8000-0000000000aa', null)
  sweptBefore = pneVisSwept
  pneVisTTickTo(srv, 200, 106)
  pneVisT(orphanDisp.removed && stray.removed, 'the scheduled sweep (t % 200 === 106) kills orphan and stray grafts')
  pneVisT(pneVisSwept - sweptBefore >= 2, 'sweep counted what it removed')
  pneVisT(pneVisTGrafts(still).length === 1 && !pneVisTGrafts(still)[0].removed, 'a graft riding a live host survives the sweep')
  pneVisT(pneVisSweepPhase === 2, 'phase 2 waits for the next even tick')
  __pneMock.tick(srv, 1)
  pneVisT(pneVisSweepPhase === 2, 'no sweep phase on the odd tick 107 (a breed tick)')
  __pneMock.tick(srv, 1)
  pneVisT(pneVisSweepPhase === 3, 'phase 2 (cap trim) ran on tick 108')
  __pneMock.tick(srv, 2)
  pneVisT(pneVisSweepPhase === 0, 'phase 3 (stale entries) ran on tick 110 and closed the cycle')
  pneVisTCycles(srv)
  pneVisT(!pneVisHosts.hasOwnProperty(orphanHost.uuid), 'the scan dropped the vanished host record')

  // ---- stale team entries (leaks): entries whose entity is not loaded are removed; live ones stay
  srv.runCommandSilent('team join pne_clade_1 ' + ghost)
  srv.runCommandSilent('team join pne_clade_2 not-a-uuid-entry')
  n = pneVisSweep(srv)
  pneVisT(__pneVisMock.teamOf(srv, ghost) === '', 'leak sweep removes an entry whose entity does not exist')
  pneVisT(__pneVisMock.teamOf(srv, 'not-a-uuid-entry') === 'pne_clade_2', 'non-UUID entries (not ours) are left alone')
  pneVisT(__pneVisMock.teamOf(srv, still.uuid) !== '', 'a live host keeps its entry')
  srv.runCommandSilent('team leave not-a-uuid-entry')

  // ---- rejoin after a chunk unload: entry swept while unloaded, graft rides back, re-apply restores the team
  rej = still
  __pneVisMock.unload(rej)
  pneVisSweep(srv)
  pneVisT(__pneVisMock.teamOf(srv, rej.uuid) === '' && !pneVisHosts.hasOwnProperty(rej.uuid), 'unloaded host: entry and record dropped by the sweep')
  rej2 = __pneVisMock.reload(srv, rej)
  rej2.target = player
  before = __pneVisMock.log.length
  pneVisTFresh()
  pneVisApply(rej2, pneVisTI(2, false, 1 + (hosts.indexOf(rej) % 4), 5))
  pneVisT(__pneVisMock.teamOf(srv, rej2.uuid) === 'pne_clade_2', 'rejoin: the hive re-apply restores the team entry')
  pneVisT(pneVisTLogSince(before, /summon/).length === 0 && pneVisTGrafts(rej2).length === 1 && pneVisHosts[rej2.uuid].disp === pneVisTGrafts(rej2)[0].uuid,
    'rejoin engaged: the graft that rode back is adopted, no second summon')
  // an idle host that rejoins with a graft riding (saved while it fought) loses it at the apply
  idleRej = null
  for (i = 0; i < hosts.length; i++) {
    if (hosts[i] !== rej && !hosts[i].removed && pneVisTGrafts(hosts[i]).length) idleRej = hosts[i]
  }
  pneVisT(idleRej !== null, 'a second grafted host for the idle rejoin')
  __pneVisMock.unload(idleRej)
  __pneMock.tick(srv, PNE_VIS_LINGER)
  pneVisTCycles(srv)
  pneVisT(!pneVisHosts.hasOwnProperty(idleRej.uuid), 'the unloaded host record was dropped by the scan')
  idleRej2 = __pneVisMock.reload(srv, idleRej)
  pneVisT(pneVisTGrafts(idleRej2).length === 1, 'the graft rode back with the reloaded host')
  pneVisTFresh()
  pneVisApply(idleRej2, pneVisTI(3, false, 4, 5))
  pneVisT(pneVisTGrafts(idleRej2).length === 0 && __pneVisMock.displays('pne_graft').length === pneVisTRiding(),
    'rejoin idle: the riding graft is removed at the apply (no orphan)')
  idleRej2.target = player
  pneVisTCycles(srv)
  pneVisT(pneVisGraftN <= pneVisGraftCap() && pneVisTRiding() === pneVisGraftN, 'grafts stay within the cap after rejoins (' + pneVisGraftN + '/' + pneVisGraftCap() + ')')

  // ---- the cap holds when the engaged hive shrinks: ungrafted engaged hosts die (pneVisRemove) -> within one
  // scheduled sweep cycle grafts <= floor(15% of the live engaged hosts)
  dying = []
  for (i = 0; i < hosts.length; i++) {
    if (!hosts[i].removed && !pneVisTGrafts(hosts[i]).length && dying.length < 14) dying.push(hosts[i])
  }
  dying = dying.concat(geneless)
  pneVisTKill(dying)
  pneVisTTickTo(srv, 200, 112)
  live = pneVisTLiveEngaged()
  pneVisT(pneVisGraftN <= Math.floor(0.15 * live + 1e-9) && pneVisTRiding() === pneVisGraftN,
    'after deaths and one sweep cycle: grafts ' + pneVisGraftN + ' <= floor(0.15 * ' + live + ' live engaged)')
  pneVisT(pneVisEngN === live, 'engaged count equals the live engaged hosts (' + pneVisEngN + ' vs ' + live + ')')
  dying = []
  for (i = 0; i < hosts.length; i++) {
    if (!hosts[i].removed) dying.push(hosts[i])
  }
  if (!rej2.removed) dying.push(rej2)
  if (!idleRej2.removed) dying.push(idleRej2)
  pneVisTKill(dying)
  pneVisTCycles(srv)
  pneVisT(pneVisHostN === 0 && pneVisEngN === 0 && pneVisGraftN === 0 && pneVisTRiding() === 0, 'cap group removed, counters back to 0')
  // mass unload of 100 engaged hosts, and 20 engaged hosts that want grafts arrive in the same tick: the first scan
  // visit of the newcomers comes after every unloaded record was dropped, so the cap counts only live hosts
  leavers = pneVisTMobs(srv, 100, 3000, 'epca:curbug', { x: 300 })
  pneVisTApplyAll(leavers, function (j) { return pneVisTI(j % 4, false, 0, 5) }, player)
  pneVisTCycles(srv)
  pneVisT(pneVisEngN === 100 && pneVisGraftCap() === 15, 'a large engaged hive (' + pneVisEngN + ', cap ' + pneVisGraftCap() + ')')
  for (i = 0; i < leavers.length; i++) __pneVisMock.unload(leavers[i])
  arrivals = pneVisTMobs(srv, 20, 3200, 'epca:ripper', { x: 320 })
  pneVisTApplyAll(arrivals, function (j) { return pneVisTI(j % 4, false, 1 + (j % 4), 6) }, player)
  pneVisTCycles(srv)
  live = pneVisTLiveEngaged()
  n = 0
  for (i = 0; i < arrivals.length; i++) n += pneVisTGrafts(arrivals[i]).length
  pneVisT(live === 20 && pneVisGraftN === 3 && n === 3,
    'after a mass unload: grafts ' + pneVisGraftN + ' (newcomers ' + n + ') = floor(0.15 * ' + live + ' live engaged), not 15% of the stale 120')
  ok = true
  for (i = 0; i < leavers.length; i++) {
    if (pneVisHosts.hasOwnProperty(leavers[i].uuid)) ok = false
  }
  pneVisT(ok && pneVisHostN === 20 && pneVisEngN === 20, 'every unloaded record was dropped (hosts ' + pneVisHostN + ', engaged ' + pneVisEngN + ')')
  pneVisTTickTo(srv, 200, 112)
  pneVisT(pneVisGraftN === 3 && pneVisTRiding() === 3, 'and the next sweep cycle keeps them (' + pneVisGraftN + ')')
  pneVisTKill(arrivals)

  // ---- fairness: 5 engaged hosts carrying another mob come first; a plain engaged host behind them still gets its
  // graft within one scan cycle, and the carriers get theirs once free. A failed summon is retried later.
  filler = pneVisTMobs(srv, 60, 4000, 'epca:curbug', { x: 400 })
  pneVisTApplyAll(filler, function (j) { return pneVisTI(0, false, 0, 5) }, player)
  carriers = pneVisTMobs(srv, 5, 4100, 'epca:ripper', { x: 410 })
  riders = pneVisTMobs(srv, 5, 4110, 'epca:curbug', { x: 411 })
  for (i = 0; i < 5; i++) __pneVisMock.mount(riders[i], carriers[i])
  pneVisTApplyAll(carriers, function (j) { return pneVisTI(1, false, 1, 6) }, player)
  plain = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(4120), x: 412, z: 0 })
  plain.target = player
  pneVisTFresh()
  pneVisApply(plain, pneVisTI(1, false, 2, 6))
  pneVisTCycles(srv)
  pneVisT(pneVisGraftCap() >= pneVisGraftN, 'room under the cap for the fairness test (' + pneVisGraftN + '/' + pneVisGraftCap() + ')')
  pneVisT(pneVisTGrafts(plain).length === 1, 'the plain host behind 5 carriers is grafted within one scan cycle')
  ok = true
  for (i = 0; i < 5; i++) {
    if (pneVisTGrafts(carriers[i]).length) ok = false
  }
  pneVisT(ok, 'hosts carrying another mob get no graft')
  for (i = 0; i < 5; i++) __pneVisMock.dismount(riders[i])
  pneVisTCycles(srv, 3)
  n = 0
  for (i = 0; i < 5; i++) n += pneVisTGrafts(carriers[i]).length
  pneVisT(n === 5, 'freed carriers get their grafts from the scan (' + n + ')')
  failHost = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(4130), x: 413, z: 0 })
  failHost.target = player
  __pneVisMock.failSummon = 1
  pneVisTFresh()
  pneVisApply(failHost, pneVisTI(2, false, 3, 6))
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(failHost).length === 0 && pneVisHosts[failHost.uuid].retryT > pneCoreTick && __pneVisMock.failSummon === 0,
    'a failed summon leaves the host waiting with a retry time')
  __pneMock.tick(srv, PNE_VIS_RETRY)
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(failHost).length === 1, 'the failed summon is retried after its backoff')
  // a summon draws two visApply tokens of its own; a refused take leaves the host teamed and waiting
  budHost = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(4140), x: 414, z: 0 })
  budHost.target = player
  pneVisTFresh()
  pneVisApply(budHost, pneVisTI(3, false, 4, 6))
  oldBudget = PNE_CORE_BUDGET_MS
  PNE_CORE_BUDGET_MS = 0.05
  pneVisTCycles(srv)
  PNE_CORE_BUDGET_MS = oldBudget
  pneVisT(pneVisTGrafts(budHost).length === 0 && __pneVisMock.teamOf(srv, budHost.uuid) === 'pne_clade_3',
    'no summon while the budget cannot cover it; the host keeps its team')
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(budHost).length === 1, 'granted once the budget allows')

  // ---- apex naming (and the pne_vis_apex tag that lets the pillar switch find named hosts later)
  apex = __pneMock.mob(srv, 'epca:light_carrier', { uuid: pneVisTU(500), x: 2, z: -2 })
  pneVisTFresh()
  pneVisApply(apex, pneVisTI(3, true, 0, 5, [0.1, 0.2, 0.9, 0, 0.3, 0, 0, 0, 0, 0, 0, 0.5, 1, 1]))
  pneVisT(apex.customName !== null && apex.customName.key === 'pne.vis.apex.sct', 'apex named after the dominant counter-trait (SCT)')
  pneVisT(apex.customName && apex.customName.text === 'Hive Apex: Tracker', 'fallback text "Hive Apex: Tracker"')
  pneVisT(apex.customName && apex.customName.json.italic === false && apex.customName.json.color === 'dark_red', 'static styled name (no obfuscation, no animation)')
  pneVisT(__pneVisMock.teamOf(srv, apex.uuid) === 'pne_clade_3_named', 'named host joins pne_clade_3_named (names stay visible)')
  pneVisT(apex.tagSet.hasOwnProperty('pne_vis_apex'), 'a host named here carries the pne_vis_apex tag')
  pneVisApply(apex, pneVisTI(3, true, 0, 5, [0.5, 0.5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  pneVisT(apex.customName.key === 'pne.vis.apex.spd', 'ties go to the lower gene index (SPD over ACU)')
  pneVisApply(apex, pneVisTI(3, true, 0, 5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]))
  pneVisT(apex.customName.key === 'pne.vis.apex.any' && apex.customName.text === 'Hive Apex', 'TEL and MOR never name an apex (generic name)')
  pneVisApply(apex, pneVisTI(3, false, 0, 5, null))
  pneVisT(apex.customName === null && __pneVisMock.teamOf(srv, apex.uuid) === 'pne_clade_3', 'no longer apex: our name removed, back to pne_clade_3')
  pneVisT(!apex.tagSet.hasOwnProperty('pne_vis_apex'), 'no longer apex: the tag goes with the name')
  named = __pneMock.mob(srv, 'epca:medium_incomplete_form', { uuid: pneVisTU(501), x: 1, z: 1 })
  named.customName = { text: 'What was once Steve', key: null }
  pneVisTFresh()
  pneVisApply(named, pneVisTI(1, true, 0, 5, [0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0]))
  pneVisT(named.customName.text === 'What was once Steve', 'a foreign CustomName is never overwritten')
  pneVisT(__pneVisMock.teamOf(srv, named.uuid) === 'pne_clade_1_named', 'a pre-named host keeps a visible name (named team)')
  pneVisT(!named.tagSet.hasOwnProperty('pne_vis_apex'), 'a foreign name gets no apex tag')
  pneVisApply(named, pneVisTI(1, false, 0, 5, null))
  pneVisT(named.customName.text === 'What was once Steve', 'a foreign CustomName survives a non-apex re-apply')
  // a name tag used later moves the host to the _named team (its name would be hidden otherwise), and back
  tagHost = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(505), x: 1, z: 3 })
  pneVisTFresh()
  pneVisApply(tagHost, pneVisTI(2, false, 0, 5))
  pneVisT(__pneVisMock.teamOf(srv, tagHost.uuid) === 'pne_clade_2', 'unnamed host on pne_clade_2')
  tagHost.customName = { text: 'Bob', key: null }
  pneVisTCycles(srv)
  pneVisT(__pneVisMock.teamOf(srv, tagHost.uuid) === 'pne_clade_2_named' && tagHost.customName.text === 'Bob',
    'a name tag given later moves the host to pne_clade_2_named within one scan cycle')
  tagHost.customName = null
  pneVisTCycles(srv)
  pneVisT(__pneVisMock.teamOf(srv, tagHost.uuid) === 'pne_clade_2', 'the name gone: back to pne_clade_2')
  // e from the hive when the caller does not pass it (HiveInfo.e)
  pneHiveInfo = function (mob) { return { g: '', clade: 0, sil: false, apex: true, e: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0, 0, 0, 0], strain: 'epca' } }
  pre = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(502), x: 1, z: 2 })
  pneVisTFresh()
  pneVisApply(pre, pneVisTI(0, true, 0, 5, null))
  pneVisT(pre.customName && pre.customName.key === 'pne.vis.apex.prc' && pre.customName.text === 'Hive Apex: Shieldbreaker', 'apex trait read from pneCoreHiveInfo(mob).e when info.e is absent')
  pneHiveInfo = null
  // a player renames an apex: our tag goes (a later pillar switch must not remove the player's name)
  apexU2 = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(506), x: 1, z: 4 })
  pneVisTFresh()
  pneVisApply(apexU2, pneVisTI(1, true, 0, 5, [0, 0, 0, 0, 0, 0, 0.9, 0, 0, 0, 0, 0, 0, 0]))
  pneVisT(apexU2.customName.key === 'pne.vis.apex.kbr' && apexU2.tagSet.hasOwnProperty('pne_vis_apex'), 'second apex named and tagged')
  apexU2.customName = { text: 'Rex', key: null }
  pneVisTCycles(srv)
  pneVisT(!apexU2.tagSet.hasOwnProperty('pne_vis_apex') && __pneVisMock.teamOf(srv, apexU2.uuid) === 'pne_clade_1_named',
    'a renamed apex loses the pne_vis_apex tag and keeps a visible name')

  // ---- trait particles: apex hosts near a survival player, 3 particles, 0.5 Hz; never for far or non-apex hosts
  fxHost = pre
  farHost = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(503), x: 200, z: 200 })
  plain = hosts[5]
  pneVisTFresh()
  pneVisApply(farHost, pneVisTI(0, true, 0, 5, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
  k = __pneVisMock.particles.length
  __pneMock.tick(srv, 400)
  fxTicks = {}
  ok = true
  n = 0
  for (i = k; i < __pneVisMock.particles.length; i++) {
    ev = __pneVisMock.particles[i]
    if (ev.u === farHost.uuid || ev.u === plain.uuid) ok = false
    if (ev.t % 40 !== 6) ok = false
    if (!/ 0 3 normal$/.test(ev.rest)) ok = false
    if (ev.u === fxHost.uuid) {
      n++
      fxTicks[ev.t] = true
    }
  }
  pneVisT(ok, 'particles only at t % 40 === 6, 3 per burst, normal mode, never for far or non-apex hosts')
  pneVisT(n === 10, 'one burst per 40 ticks for a near apex over 400 ticks (0.5 Hz): ' + n)

  // ---- deferred visApply queue (budget refused) and deferred removal
  q1 = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(600), x: 0, z: 5 })
  pneCoreLeftMs = 0
  before = __pneVisMock.log.length
  pneVisApply(q1, pneVisTI(1, false, 0, 5))
  ev = pneVisTI(2, false, 0, 5)
  pneVisApply(q1, ev)
  ev.clade = 3   // the caller reuses its object; the queued copy must not change
  pneVisT(__pneVisMock.log.length === before && pneVisApplyOrder.length === 1, 'refused budget: no command, one deferred entry (deduplicated)')
  __pneMock.tick(srv, 1)
  pneVisT(pneVisApplyOrder.length === 0 && __pneVisMock.teamOf(srv, q1.uuid) === 'pne_clade_2', 'deferred apply drained next tick with the latest info (copied)')
  q2 = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(601), x: 0, z: 6 })
  pneCoreLeftMs = 0
  pneVisApply(q2, pneVisTI(1, false, 0, 5))
  pneVisRemove(q2)
  pneVisT(!pneVisApplyPending.hasOwnProperty(q2.uuid), 'a removal cancels a pending apply')
  pneCoreLeftMs = 0
  pneVisRemove(q1)
  pneVisT(pneVisRemoveOrder.length >= 1 && __pneVisMock.teamOf(srv, q1.uuid) === 'pne_clade_2', 'refused budget: removal deferred')
  __pneMock.tick(srv, 1)
  pneVisT(pneVisRemoveOrder.length === 0 && __pneVisMock.teamOf(srv, q1.uuid) === '' && __pneVisMock.teamOf(srv, q2.uuid) === '', 'deferred removals drained next tick')

  // ---- sweep phases run on even ticks only (never beside a breed at t % 4 === 3 or a dream slice at t % 4 === 1);
  // a refused take retries on the next even tick (contract 7.2)
  pneVisTTickTo(srv, 200, 105)
  oldBudget = PNE_CORE_BUDGET_MS
  PNE_CORE_BUDGET_MS = 0.1
  before = __pneVisMock.log.length
  __pneMock.tick(srv, 1)
  pneVisT(pneVisSweepPhase === 1 && pneVisTLogSince(before, /pne_graft_chk/).length === 0, 'sweep refused at t % 200 === 106 stays due')
  PNE_CORE_BUDGET_MS = oldBudget
  __pneMock.tick(srv, 1)
  pneVisT(pneVisSweepPhase === 1, 'no retry on the odd tick 107')
  __pneMock.tick(srv, 1)
  logs = pneVisTLogSince(before, /^tag @e\[type=minecraft:item_display,tag=pne_graft\] add pne_graft_chk$/)
  pneVisT(pneVisSweepPhase === 2 && logs.length === 1 && logs[0].t % 200 === 108, 'the retry ran on the next even tick (108)')
  __pneMock.tick(srv, 4)
  pneVisT(pneVisSweepPhase === 0, 'one phase per even tick, then idle')
  phaseTicks = []
  origStep = pneVisSweepPhaseStep
  pneVisSweepPhaseStep = function (s) {
    phaseTicks.push(pneCoreTick)
    return origStep(s)
  }
  __pneMock.tick(srv, 800)
  pneVisSweepPhaseStep = origStep
  ok = phaseTicks.length === 12
  for (i = 0; i < phaseTicks.length; i++) {
    if (phaseTicks[i] % 2 !== 0 || phaseTicks[i] % 4 === 3 || phaseTicks[i] % 4 === 1) ok = false
  }
  pneVisT(ok, 'over 800 ticks: 12 sweep phases, all on even ticks (' + phaseTicks.slice(0, 6).join(',') + ')')
  // the stale phase is windowed: a flood of leaked entries is removed over several cycles, never all at once
  for (i = 0; i < 70; i++) srv.runCommandSilent('team join pne_clade_3 dead0000-0000-4000-8000-0000000' + (10000 + i))
  before = __pneVisMock.log.length
  pneVisTTickTo(srv, 200, 111)
  n = pneVisTLogSince(before, /^team leave dead0000/).length
  pneVisT(n <= PNE_VIS_STALE_LOOKUPS, 'one scheduled stale phase removes at most ' + PNE_VIS_STALE_LOOKUPS + ' unknown entries (' + n + ')')
  for (i = 0; i < 30 && pneVisTLogSince(before, /^team leave dead0000/).length < 70; i++) pneVisTTickTo(srv, 200, 111)
  pneVisT(__pneVisMock.teamSize(srv, 'pne_clade_3') >= 0 && pneVisTLogSince(before, /^team leave dead0000/).length === 70, 'later cycles remove the rest')

  // ---- multi-dimension host
  nether = __pneVisMock.addLevel(srv, 'minecraft:the_nether')
  __pneMock.tick(srv, 1)   // levels are listed once per tick
  nh = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(799), level: nether, x: 50, z: 0 })
  nh.target = player
  pneVisTFresh()
  pneVisApply(nh, pneVisTI(0, false, 1, 6))
  pneVisTCycles(srv)
  g = pneVisTGrafts(nh)
  pneVisT(g.length === 1 && g[0].level === nether, 'a nether host gets its graft in the nether')
  pneVisT(pneVisFind(srv, g[0].uuid, null) === g[0], 'displays are found across dimensions (getAllLevels)')
  pneVisRemove(nh)
  pneVisT(g[0].removed, 'remove kills the ejected graft by its UUID')

  // ---- rediscovery after a (re)load: a graft riding a host VISUAL has no record of is adopted; the host is idle,
  // so the graft goes after the linger
  redHost = __pneMock.mob(srv, 'spore:inf_human', { uuid: pneVisTU(800), x: 7, z: 7, bodyYaw: 33 })
  redDisp = __pneVisMock.display(srv, pneVisGraftUuid(redHost.uuid), redHost)
  redDisp.addTag('pne_gv2')
  pneVisT(!pneVisHosts.hasOwnProperty(redHost.uuid), 'graft made outside VISUAL is unknown before rediscovery')
  pneVisRediscPending = true
  pneVisTTickTo(srv, 6, 1)
  __pneMock.tick(srv, 2)
  pneVisT(pneVisHosts.hasOwnProperty(redHost.uuid) && pneVisHosts[redHost.uuid].partial && pneVisHosts[redHost.uuid].disp === redDisp.uuid &&
    pneVisHosts[redHost.uuid].variant === 2, 'rediscovery rebuilds a partial record for a riding graft (variant from its tag)')
  __pneMock.tick(srv, 3)
  pneVisT(redDisp.rotation === 33, 'a rediscovered graft is yaw-synced')
  __pneMock.tick(srv, PNE_VIS_LINGER)
  pneVisTCycles(srv)
  pneVisT(redDisp.removed && pneVisHosts[redHost.uuid].disp === '', 'the rediscovered graft of an idle host goes after the linger')

  // ---- /pne visual status and sweep through the hub
  brig = __pneMock.brig()
  __pneMock.fire('ServerEvents.commandRegistry', brig.event())
  srv.cmds.length = 0
  src = __pneMock.source(srv, player, 0)
  pneVisT(brig.run('pne visual status', src) === 1, '/pne visual status runs for anyone')
  pneVisT(srv.cmds.join('\n').indexOf('grafts ') >= 0 && srv.cmds.join('\n').indexOf(' engaged of ') >= 0, 'status line mentions grafts and the engaged hive')
  srv.cmds.length = 0
  pneVisT(brig.run('pne visual sweep', src) === 0 && srv.cmds.join('\n').indexOf('operator') >= 0, '/pne visual sweep needs operator rights')
  src = __pneMock.source(srv, player, 2)
  srv.cmds.length = 0
  pneVisT(brig.run('pne visual sweep', src) === 1 && srv.cmds.join('\n').indexOf('visual sweep removed') >= 0, 'admin /pne visual sweep runs')
  pneVisT(pneCoreStatusLines(null).join('\n').indexOf('visual: teams ') >= 0, '/pne status carries the visual line')

  // ---- visual OFF: no new entries or grafts; the next sweep removes grafts, empties teams, removes our names, also
  // from an apex host that was unloaded at the switch and loads later
  apexU = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(507), x: 1, z: 7 })
  pneVisTFresh()
  pneVisApply(apexU, pneVisTI(2, true, 0, 5, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0, 0, 0]))
  pneVisT(apexU.customName && apexU.customName.key === 'pne.vis.apex.hpx' && apexU.tagSet.hasOwnProperty('pne_vis_apex'), 'apex to be unloaded is named and tagged')
  __pneVisMock.unload(apexU)
  apex = pre
  pneVisT(apex.customName !== null, 'apex still named before the switch')
  pneVisT(pneCoreSetPillar(srv, 'visual', false) === true, 'visual switched off')
  h = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(900), x: 1, z: 9 })
  before = __pneVisMock.log.length
  pneVisTFresh()
  pneCoreVisApply(h, pneVisTI(1, true, 1, 9))
  pneVisApply(h, pneVisTI(1, true, 1, 9))
  pneVisT(__pneVisMock.log.length === before, 'pillar off: apply issues nothing (wrapper and direct call)')
  __pneMock.tick(srv, 2)
  pneVisT(__pneVisMock.displays('pne_graft').length === 0, 'pillar off: the next sweep removed every graft')
  ok = true
  for (i = 0; i < names.length; i++) {
    if (__pneVisMock.teamSize(srv, names[i]) !== 0) ok = false
  }
  pneVisT(ok, 'pillar off: clade teams emptied')
  pneVisT(apex.customName === null && !apex.tagSet.hasOwnProperty('pne_vis_apex'), 'pillar off: our apex names and tags removed')
  pneVisT(named.customName !== null && named.customName.text === 'What was once Steve', 'pillar off: foreign names untouched')
  pneVisT(apexU2.customName !== null && apexU2.customName.text === 'Rex', 'pillar off: a player name on a former apex untouched')
  apexU = __pneVisMock.reload(srv, apexU)
  pneVisT(apexU.customName !== null && apexU.tagSet.hasOwnProperty('pne_vis_apex'), 'the unloaded apex loads again, still named')
  pneVisTTickTo(srv, 200, 107)
  pneVisT(apexU.customName === null && !apexU.tagSet.hasOwnProperty('pne_vis_apex'), 'the next off sweep removes its name and tag too')
  srv.runCommandSilent('team join pne_clade_0 ' + h.uuid)
  pneCoreVisRemove(h)
  pneVisT(__pneVisMock.teamOf(srv, h.uuid) === '', 'pillar off: remove still works (cleanup)')
  pneVisT(pneCoreSetPillar(srv, 'visual', true) === true, 'visual switched on again')
  __pneMock.tick(srv, 1)
  pneVisTFresh()
  pneVisApply(h, pneVisTI(1, false, 0, 9))
  pneVisT(__pneVisMock.teamOf(srv, h.uuid) === 'pne_clade_1', 'pillar on again: apply works')

  // ---- degraded platform: no readable scoreboard still assigns teams and never throws
  srv.noScoreboard = true
  h = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(901), x: 2, z: 9 })
  pneVisTFresh()
  pneVisApply(h, pneVisTI(2, false, 0, 1))
  pneVisT(__pneVisMock.teamOf(srv, h.uuid) === 'pne_clade_2', 'without a readable scoreboard the join is still issued')
  pneVisT(pneVisSweep(srv) >= 0, 'sweep without a readable scoreboard does not throw')
  srv.noScoreboard = false

  // ---- species that fight differently while something rides them never get a graft (PNE_VIS_NO_GRAFT)
  filler = pneVisTMobs(srv, 60, 1000, 'epca:ripper', { x: 40 })
  pneVisTApplyAll(filler, function (j) { return pneVisTI(j % 4, false, 0, 6) }, player)
  nog = __pneMock.mob(srv, 'spore:busser', { uuid: pneVisTU(1100), x: 41, z: 44 })
  nog2 = __pneMock.mob(srv, 'epca:large_incomplete_form', { uuid: pneVisTU(1101), x: 42, z: 44 })
  nog.target = player
  nog2.target = player
  pneVisTFresh()
  pneVisApply(nog, pneVisTI(1, false, 2, 6))
  pneVisApply(nog2, pneVisTI(2, false, 1, 6))
  pneVisTCycles(srv)
  pneVisT(pneVisNoGraftType(nog) && pneVisNoGraftType(nog2) && !pneVisNoGraftType(filler[0]), 'busser and large_incomplete_form are no-graft species, ripper is not')
  pneVisT(pneVisTGrafts(nog).length === 0 && pneVisTGrafts(nog2).length === 0, 'engaged no-graft species get no graft at stage 6 with a graft index')
  pneVisT(__pneVisMock.teamOf(srv, nog.uuid) === 'pne_clade_1' && __pneVisMock.teamOf(srv, nog2.uuid) === 'pne_clade_2', 'no-graft species still join their clade team')
  pneVisT(pneVisHosts[nog.uuid].gvar === 0 && pneVisHosts[nog.uuid].variant === 0, 'a no-graft host never wants a graft')
  pneVisT(PNE_VIS_NO_GRAFT.hasOwnProperty('spore:umarmed') && PNE_VIS_NO_GRAFT.hasOwnProperty('spore:kraken'), 'carriers and grabbers listed (umarmed, kraken)')

  // ---- a host that already carries something else waits; the scan grants its graft once it is free
  car = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(1102), x: 43, z: 44 })
  rider = __pneMock.mob(srv, 'epca:curbug', { uuid: pneVisTU(1103), x: 43, z: 44 })
  __pneVisMock.mount(rider, car)
  car.target = player
  pneVisTFresh()
  pneVisApply(car, pneVisTI(2, false, 1, 6))
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(car).length === 0 && pneVisHosts[car.uuid].variant === 1, 'a host carrying another mob gets no graft yet')
  __pneVisMock.dismount(rider)
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(car).length === 1, 'freed host gets its graft from the scan')

  // ---- the graft carries its variant tag; a changed occupancy index swaps the display (the count does not change)
  g1 = pneVisTGrafts(car)[0]
  pneVisT(g1 && g1.tagSet.hasOwnProperty('pne_gv1') && g1.tagSet.hasOwnProperty('pne_graft'), 'graft tagged pne_graft and pne_gv1')
  gn = pneVisGraftN
  pneVisTFresh()
  pneVisApply(car, pneVisTI(2, false, 2, 6))
  pneVisT(g1.removed, 'occupancy 1 -> 2: the variant 1 display is removed at the apply')
  pneVisTCycles(srv)
  g2 = pneVisTGrafts(car)
  pneVisT(g2.length === 1 && g2[0].tagSet.hasOwnProperty('pne_gv2') && g2[0].item === PNE_VIS_GRAFTS[1].item, 'and the scan summons variant 2')
  pneVisT(pneVisGraftN === gn && g2.length === 1 && g2[0].uuid === pneVisGraftUuid(car.uuid), 'replacement keeps the count and the deterministic UUID')
  // a graft from before variant tags (pne_graft only) is adopted, not replaced
  oldHost = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(1104), x: 44, z: 44 })
  oldDisp = __pneVisMock.display(srv, pneVisGraftUuid(oldHost.uuid), oldHost)
  oldHost.target = player
  before = __pneVisMock.log.length
  pneVisTFresh()
  pneVisApply(oldHost, pneVisTI(0, false, 3, 6))
  pneVisT(!oldDisp.removed && pneVisTLogSince(before, /summon|^kill /).length === 0 && pneVisHosts[oldHost.uuid].disp === oldDisp.uuid,
    'an untagged graft riding its engaged host is adopted as is')

  // ---- dimension change: the old graft stays behind as an orphan; it is removed before the new graft is summoned
  moved = __pneVisMock.changeDim(srv, car, nether)
  pneVisT(g2[0].vehicle === null && !g2[0].removed && __pneVisMock.teamOf(srv, car.uuid) === '', 'dimension change: graft ejected in the overworld, team entry dropped')
  moved.target = player
  before = __pneVisMock.log.length
  pneVisTFresh()
  pneVisApply(moved, pneVisTI(2, false, 2, 6))
  pneVisTCycles(srv)
  logs = pneVisTLogSince(before, /./)
  killAt = -1
  summonAt = -1
  for (i = 0; i < logs.length; i++) {
    if (killAt < 0 && logs[i].c === 'kill ' + pneVisGraftUuid(car.uuid)) killAt = i
    if (summonAt < 0 && logs[i].c.indexOf('summon') >= 0 && logs[i].c.indexOf(car.uuid) >= 0) summonAt = i
  }
  pneVisT(g2[0].removed && killAt >= 0 && summonAt > killAt, 'the orphan in the other dimension is killed before the new summon')
  alive = 0
  for (i = 0; i < __pneVisMock.all.length; i++) {
    if (!__pneVisMock.all[i].removed && __pneVisMock.all[i].uuid === pneVisGraftUuid(car.uuid)) alive++
  }
  g = pneVisTGrafts(moved)
  pneVisT(alive === 1 && g.length === 1 && g[0].level === nether && __pneVisMock.teamOf(srv, moved.uuid) === 'pne_clade_2',
    'one graft with that UUID, riding the host in the nether; team restored')

  // ---- yaw falls back to the KubeJS name getYaw() when the body yaw is unreadable
  delete moved.getVisualRotationYInDegrees
  moved.yaw = 77
  pneVisTTickTo(srv, 3, 0)
  pneVisT(g[0].rotation === 77, 'graft yaw from getYaw() when getVisualRotationYInDegrees is missing (' + g[0].rotation + ')')

  // ---- config vis_grafts (once the core defines it): 0 removes every graft at the next sweep, 1 brings them back
  pneVisT(pneVisGraftsOn() === true, 'grafts on while the core has no vis_grafts key')
  PNE_CORE_DEFAULTS.vis_grafts = 1
  PNE_CORE_BOUNDS.vis_grafts = [0, 1]
  pneVisT(pneVisGraftsOn() === true, 'vis_grafts default 1 keeps grafts on')
  pneVisT(pneCoreCfgSet(srv, 'vis_grafts', 0) === true && pneVisGraftsOn() === false, 'vis_grafts 0 stored')
  pneVisTTickTo(srv, 200, 107)
  pneVisT(__pneVisMock.displays('pne_graft').length === 0 && pneVisGraftN === 0, 'vis_grafts 0: the scheduled sweep removed every graft')
  pneVisT(__pneVisMock.teamOf(srv, moved.uuid) === 'pne_clade_2', 'vis_grafts 0: team entries stay')
  fresh = __pneMock.mob(srv, 'epca:ripper', { uuid: pneVisTU(1105), x: 45, z: 44 })
  fresh.target = player
  pneVisTFresh()
  pneVisApply(fresh, pneVisTI(1, false, 1, 6))
  pneVisTCycles(srv)
  pneVisT(pneVisTGrafts(fresh).length === 0 && pneVisHosts[fresh.uuid].gvar === 1, 'vis_grafts 0: no new graft, the wanted one is remembered')
  pneVisT(pneVisStatusLine(null).indexOf('grafts off') >= 0, 'status line says grafts are off')
  pneVisT(pneCoreCfgSet(srv, 'vis_grafts', 1) === true, 'vis_grafts 1 stored')
  pneVisTTickTo(srv, 200, 107)
  pneVisTCycles(srv)
  cap = pneVisGraftCap()
  pneVisT(pneVisTGrafts(fresh).length + pneVisTGrafts(moved).length >= 1 && pneVisGraftN >= 1 && pneVisGraftN <= cap,
    'vis_grafts 1: the scan grants remembered grafts again, within the cap (' + pneVisGraftN + '/' + cap + ')')
  delete PNE_CORE_DEFAULTS.vis_grafts
  delete PNE_CORE_BOUNDS.vis_grafts
  pneCoreCfgCache = null

  // ---- counters stay exact: the running counts equal a recount from the records
  n = pneVisGraftN
  k = pneVisEngN
  left = pneVisHostN
  pneVisRecount()
  pneVisT(n === pneVisGraftN && k === pneVisEngN && left === pneVisHostN, 'running counters equal a recount (' + n + '/' + k + '/' + left + ')')
  pneVisT(pneVisTRiding() === pneVisGraftN, 'every counted graft rides its host (' + pneVisTRiding() + ' vs ' + pneVisGraftN + ')')

  // ---- nothing ever moves a camera or applies an effect; every command was one the module is meant to issue
  bad = []
  for (i = setupLog; i < __pneVisMock.log.length; i++) {
    ev = __pneVisMock.log[i].c
    if (/\beffect\b|teleport|spectate|camera|\bnausea\b|\bblindness\b|flash|firework|end_rod|@[apr]\b/.test(ev)) bad.push(ev)
    if (/collisionRule (?!always$)/.test(ev)) bad.push(ev)
    // The only tp allowed: a graft display turning itself in place (execute as <display> at @s run tp @s ~ ~ ~ <yaw> 0).
    if (/\btp\b/.test(ev)) {
      k = /^execute as ([0-9a-f-]{36}) at @s run tp @s ~ ~ ~ -?[0-9.]+ 0$/.exec(ev)
      if (!k || !__pneVisMock.world[k[1]] || __pneVisMock.world[k[1]].typeId !== 'minecraft:item_display' ||
          !__pneVisMock.world[k[1]].tagSet.hasOwnProperty('pne_graft')) bad.push(ev)
    }
  }
  pneVisT(bad.length === 0, 'no effect, player teleport, camera or non-vanilla collision command; tp only turns graft displays in place: ' + bad.slice(0, 3).join(' | '))
  pneVisT(__pneVisMock.unknown.length === 0, 'no unexpected world command: ' + __pneVisMock.unknown.slice(0, 3).join(' | '))
  pneVisT(PNE_VIS_B_TICK.off === false && PNE_VIS_B_TICK.total === 0, 'tick handler never failed (' + PNE_VIS_B_TICK.total + ')')
  pneVisT(PNE_CORE_B_API.visual.total === 0, 'core API breaker saw no visual error')

  if (pneVisTestFails.length) return 'FAIL ' + pneVisTestFails.length + ' of ' + pneVisTestN + ': ' + pneVisTestFails.join(' || ')
  return 'PASS ' + pneVisTestN + ' visual assertions'
}

var pneVisTestResult = (function () {
  try {
    return pneVisTRun()
  } catch (e) {
    return 'FAIL exception ' + e + (e && e.stack ? ' ' + e.stack : '')
  }
})()
