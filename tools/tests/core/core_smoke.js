// Smoke test for overrides/kubejs/server_scripts/pne_00_core.js. ES5; runs in Node and in the real Rhino fork.
// Files, in order: tools/tests/kjs_mocks.js, pne_00_core.js, this file. Result: pneTestResult ("PASS n" or "FAIL ...").

var pneTestFails = []
var pneTestCount = 0

function pneT(cond, msg) {
  pneTestCount++
  if (!cond) pneTestFails.push(msg)
}

// The startup gate's step 1 (docs/IMPLEMENTATION.md 3.4), exactly as pne_res_gate.js must write it.
function pneTestGateOn() {
  var g = global.pneCfgSpawnGate
  if (g !== undefined && g !== null && Number(g) === 0) return false
  return true
}

function pneTestRun() {
  var srv = __pneMock.server({ owner: 'Host', cmdResults: { seed: -5 } })
  var brig = __pneMock.brig()
  var a = __pneMock.player(srv, 'Cara', 'cccc0000-0000-4000-8000-000000000003', {})
  var b = __pneMock.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  var c = __pneMock.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', {})
  var spec = __pneMock.player(srv, 'Spec', 'dddd0000-0000-4000-8000-000000000004', { spectator: true })
  var i
  var s
  var pid
  var pid2
  var ps
  var hookCalls = []
  var zzArgs = null
  var r
  var pace
  var throws = 0
  var cmdsBefore
  var slots = {}
  var mob
  var rip
  var AL
  var q

  // --- load-time state; global values come back wrapped, so only Number()/String() are safe
  pneT(PNE_CORE_API === 1, 'PNE_CORE_API is 1')
  pneT(Number(global.pneOnResonance) === 1, 'pillar flags mirrored to global at load')
  // pneOnHive waits until every server script has loaded (the hive loads after the core): not written at load time
  pneT(global.pneOnHive === undefined || global.pneOnHive === null, 'pneOnHive is not written before the other scripts load')
  pneT(Number(global.pneCoreApi) >= 1, 'core-loaded flag readable as Number(global.pneCoreApi) >= 1')
  pneT(typeof global.pneCoreApi === 'object' && global.pneCoreApi !== 1, 'global numbers read back as wrapper objects (=== fails; mirrors Rhino)')
  pneT(pneCoreCfg('light_aversion') === 1, 'lead default: light aversion on')
  pneT(!PNE_CORE_DEFAULTS.hasOwnProperty('log_default') && pneCoreCfgSet(srv, 'log_default', 1) === false, 'no operator-settable logging default (logging is per-player opt-in only)')
  pneT(pneCoreCfg('gov_deaths') === 1 && pneCoreCfg('gov_days') === 3, 'governor default 1 death per 3 days')
  pneT(Number(global.pneCfgSpawnGate) === 1 && pneCoreCfg('spawn_backstop') === 1, 'spawn gate and backstop default on; gate flag mirrored')
  pneT(pneTestGateOn() === true, 'gate reference reader: on by default')

  // --- server start and ticks
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneT(Number(global.pneOnHive) === 0, 'pneOnHive 0 once loaded without the hive runtime (nobody would drain the startup queues)')
  srv.tickCount = 99
  __pneMock.tick(srv, 1)
  pneT(pneCoreTick === 100 && pneCoreSlot === 0, 'tick count comes from server.getTickCount()')

  // --- spawn_gate 0 really switches the startup gate off (the wrapped-number pitfall, PF1/B1)
  pneT(pneCoreCfgSet(srv, 'spawn_gate', 0) === true, 'spawn_gate can be set to 0')
  pneT(pneTestGateOn() === false, 'gate reference reader sees spawn_gate 0 as off')
  pneT((global.pneCfgSpawnGate !== 0) === true, 'documented pitfall: global.x !== 0 stays true for a stored 0')
  pneCoreCfgSet(srv, 'spawn_gate', 1)
  pneT(pneTestGateOn() === true, 'and back on')

  // --- token budget
  pneT(Math.abs(pneCoreLeft() - 2.5) < 1e-9, 'budget reset to 2.5 ms each tick')
  pneT(pneCoreTake(PNE_CORE_COST.breed) === true, 'breed fits in a fresh tick')
  pneT(PNE_CORE_COST.outcome === 0.6 && PNE_CORE_COST.outcome < PNE_CORE_COST.breed && PNE_CORE_COST.steer === 1.0,
    'cost keys outcome (0.6, below breed) and steer (1.0 placeholder) exist')
  pneT(pneCoreTake(pneCoreLeft() + 0.01) === false, 'take refuses what does not fit')
  q = pneCoreLeft()
  pneT(pneCoreTakeN(PNE_CORE_COST.rejoin, 100) === Math.floor((q + 1e-9) / PNE_CORE_COST.rejoin), 'takeN grants floor(left / cost)')
  pneT(pneCoreTakeN(PNE_CORE_COST.rejoin, 100) === 0 && pneCoreLeft() < PNE_CORE_COST.rejoin, 'takeN grants nothing once the rest is too small')
  __pneMock.tick(srv, 1)
  pneT(Math.abs(pneCoreLeft() - 2.5) < 1e-9, 'budget reset on the next tick')

  // --- slots: first 8 players on even slots (never a breed tick t%4===3 or a dream tick t%4===1)
  for (i = 0; i < 40; i++) slots[pneCoreTelSlot(i)] = true
  pneT(!slots[0] && !slots[10], 'telemetry slots never use 0 or 10')
  pneT(pneCoreTelSlot(0) === 2 && pneCoreTelSlot(7) === 18 && pneCoreTelSlot(8) === 1 && pneCoreTelSlot(17) === 19 && pneCoreTelSlot(18) === 2, 'slot table')
  s = true
  for (i = 0; i < 8; i++) {
    if (pneCoreTelSlot(i) % 4 === 3 || pneCoreTelSlot(i) % 4 === 1) s = false
  }
  pneT(s, 'players 0-7 never share a tick with a breed or a dream slice')

  // --- players: survival only, sorted by UUID
  ps = pneCorePlayers(srv)
  pneT(ps.length === 3, 'spectators are excluded')
  pneT(ps[0] === b && ps[1] === c && ps[2] === a, 'players sorted by UUID string')
  srv.tickCount = 121
  __pneMock.tick(srv, 1)
  pneT(pneCoreSlot === 2 && pneCorePlayersAtSlot(srv).length === 1 && pneCorePlayersAtSlot(srv)[0] === b, 'slot 2 serves player index 0')
  srv.tickCount = 129
  __pneMock.tick(srv, 1)
  pneT(pneCoreSlot === 10 && pneCorePlayersAtSlot(srv).length === 0, 'no per-player work on the read slot')

  // --- uuid: validated, never 'undefined'
  pneT(pneCoreUuid(a) === 'cccc0000-0000-4000-8000-000000000003', 'uuid from getStringUuid')
  pneT(pneCoreUuid({ uuid: undefined }) === '' && pneCoreUuid({ getStringUUID: function () { return '12345678-1234-4234-8234-123456789abc' } }) === '12345678-1234-4234-8234-123456789abc', 'uuid: Mojang getStringUUID fallback; junk gives empty string')
  pneT(pneCoreUuid({ getStringUuid: function () { return undefined } }) === '', 'uuid never returns the string undefined')

  // --- pid
  pid = pneCorePid(a)
  pneT(/^[0-9a-f]{32}$/.test(pid), 'pid is 32 lowercase hex')
  pneT(pneCorePid(a) === pid, 'pid is stable')
  pid2 = pneCorePidRotate(a)
  pneT(pid2 !== pid && pneCorePid(a) === pid2, 'pid rotates on purge')
  pneT(String(a.persistentData.getString('pne_pid')) === pid2, 'pid stored in player persistentData.pne_pid')
  pneT(pid.indexOf('cccc') !== 0, 'pid is not derived from the UUID')
  __pneMock.fire('PlayerEvents.loggedIn', { player: a })
  pneT(pneCorePdMode === 'kjs' && pneCoreStatusLines(null)[0].indexOf('pd=kjs') > 0, 'login confirms KubeJS persistentData (getForgePersistentData present); shown in status')

  // --- seed and hash
  pneT(pneCoreSeed32(srv) === 4294967291, 'seed32 is (int)/seed >>> 0')
  pneT(pneCoreFnv1a('') === 0x811c9dc5, 'fnv1a empty')
  pneT(pneCoreFnv1a('a') === 0xe40c292c, 'fnv1a a')
  pneT(pneCoreFnv1a('foobar') === 0xbf9cf968, 'fnv1a foobar')

  // --- config
  pneT(pneCoreCfgSet(srv, 'gov_days', 5) === true && pneCoreCfg('gov_days') === 5, 'config set')
  pneT(srv.persistentData.getInt('pne_cfg_gov_days') === 5, 'config persisted as pne_cfg_<key>')
  pneT(pneCoreCfgSet(srv, 'gov_days', 0) === false, 'config bounds')
  pneT(pneCoreCfgSet(srv, 'nope', 1) === false, 'unknown config key refused')

  // --- mercy, grace, upkeep
  a.hp = 5
  srv.tickCount = 144
  __pneMock.tick(srv, 1)
  pneT(pneCoreSlot === 5 && pneCoreHasTag(a, 'pne_mercy'), 'upkeep tags a player at <= 30% health')
  a.hp = 20
  srv.tickCount = 164
  __pneMock.tick(srv, 1)
  pneT(!pneCoreHasTag(a, 'pne_mercy'), 'upkeep clears mercy after healing')
  __pneMock.fire('PlayerEvents.respawned', { player: c })
  pneT(pneCoreHasTag(c, 'pne_grace') && pneCoreVuln(c).grace === true, 'respawn starts grace')
  pneT(c.persistentData.getLong('pne_grace_until') === srv.gameTime + 2400, 'grace deadline in game time')
  pneT(pneCoreNaturalMult(c) === 0, 'grace zeroes the natural multiplier')
  srv.gameTime += 2401
  pneT(pneCoreVuln(c).grace === false && pneCoreNaturalMult(c) === 1, 'an expired grace deadline counts as no grace even while the tag is still set')
  srv.tickCount = 184
  __pneMock.tick(srv, 1)
  pneT(!pneCoreHasTag(c, 'pne_grace'), 'grace tag expires at upkeep')
  c.addTag('pne_grace')
  pneT(pneCoreNaturalMult(c) === 1, 'a stray pne_grace tag with no live deadline does not gate')
  c.removeTag('pne_grace')
  pneT(pneCoreNaturalMult(b) === 1, 'no gate tag means multiplier 1')
  b.addTag('pne_gate')
  b.persistentData.putDouble('pne_m', 0.4)
  pneT(pneCoreNaturalMult(b) === 1, 'pne_gate without a fresh pne_m_t is ignored')
  b.persistentData.putLong('pne_m_t', srv.gameTime - 20)
  pneT(Math.abs(pneCoreNaturalMult(b) - 0.4) < 1e-9, 'fresh gate tag reads persistentData.pne_m')
  b.x = 0
  c.x = 30
  a.x = 500
  pneT(Math.abs(pneCoreNaturalMultAt(srv.level, 10, 64, 0, 48) - 0.4) < 1e-9, 'min multiplier within 48 blocks')
  pneT(pneCoreNaturalMultAt(srv.level, 400, 64, 0, 48) === 1, 'nobody near means 1')
  srv.gameTime += 101
  pneT(pneCoreNaturalMult(b) === 1, 'a stale pne_m (director stopped writing) stops gating')
  srv.tickCount = 204
  __pneMock.tick(srv, 1)
  pneT(!pneCoreHasTag(b, 'pne_gate'), 'upkeep removes pne_gate while the director is absent')
  pneT(pneCoreComfort(a) === true, 'comfort is on by default')
  a.addTag('pne_comfort_off')
  pneT(pneCoreComfort(a) === false, 'comfort opt-out tag')

  // --- safe wrappers
  pace = pneCorePace(b)
  pneT(pace.fallback === true && pace.spawn === 1 && pace.ga === 1, 'pace fallback without a director')
  b.hp = 3
  pneT(pneCorePace(b).spawn === 0 && pneCorePace(b).ga === 0, 'pace fallback honours mercy')
  b.hp = 20
  pneT(pneCoreVerdict(b) === null && pneCoreSnap(b) === null, 'no oracle means null snapshot and verdict')
  pneT(pneCoreHiveInfo(b) === null && pneCoreHiveNear(b).clade === -1, 'no hive means null info')
  pneT(pneCoreTell(null, b) === false, 'no director means no tell')
  cmdsBefore = srv.cmds.length
  pneT(pneCoreEmit(b, 'epca:slam', 'hostile', '~ ~ ~', 0.7, { pitch: 0.7 }) === true, 'emit fallback plays')
  pneT(srv.cmds[cmdsBefore].indexOf('playsound epca:slam hostile @s ~ ~ ~ 0.70 0.70') > 0, 'emit fallback command')
  pneT(pneCoreEmit(a, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 1, { stinger: true }) === true, 'stinger plays when comfort is off')
  a.removeTag('pne_comfort_off')
  pneT(pneCoreEmit(a, 'epca:infested_enderman_scream', 'hostile', '^ ^2 ^-24', 1, { stinger: true }) === false, 'comfort skips stingers in the fallback')
  pneT(pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 1, { lf: true }) === true, 'comfort LF sound plays once')
  pneT(pneCoreEmit(a, 'spore:heart_beat', 'hostile', '~ ~ ~', 1, { lf: true }) === false, 'comfort LF sounds are spaced 70 s apart in the fallback')
  pneT(pneCoreEmitAt(srv, 'minecraft:overworld', 0, 64, 0, 32, 'epca:infested_enderman_scream', 'hostile', 1, { stinger: true }) === 0, 'positional fallback never plays stingers')

  // A director that appears later (loaded after the core) is picked up at call time.
  pneResEmit = function () { return true }
  pneResPace = function (p) { return { state: 'DREAD', spawn: 0.8, aggro: 1, beckon: true, ga: 1, tier: 'DREAD', e: 0.5, theta: 0.5, mercy: false, grace: false, tick: pneCoreTick } }
  pneT(pneCorePace(b).state === 'DREAD' && pneCorePace(b).spawn === 0.8, 'wrapper calls pneResPace when present')
  b.hp = 3
  pace = pneCorePace(b)
  pneT(pace.state === 'DREAD' && pace.spawn === 0 && pace.ga === 0 && pace.beckon === false && pace.aggro <= 0.8 && pace.mercy === true, 'mercy overrides a director Pace at call time')
  b.hp = 20
  pneResPace = function (p) { return { state: 'DREAD', spawn: 1, aggro: 1, beckon: true, ga: 1, tier: 'DREAD', e: 0.5, theta: 0.5, mercy: false, grace: false, tick: pneCoreTick - 41 } }
  pneT(pneCorePace(b).fallback === true, 'a stale director Pace (> 40 ticks) is replaced by the fallback')
  b.hp = 3
  pneT(pneCorePace(b).spawn === 0, 'stale Pace plus low health gives spawn 0')
  b.hp = 20
  pneResPace = function (p) { return { state: 'CALM', spawn: 1.25, aggro: 1, beckon: true, ga: 1, tier: 'QUIET', e: 0, theta: 0, mercy: false, grace: false, tick: pneCoreTick } }
  c.x = 20
  pneT(pneCoreSpawnMultAt(srv.level, 10, 64, 0, 48) === 1.25 && pneCoreBeckonAt(srv.level, 10, 64, 0, 48) === true, 'positional spawn multiplier and beckon')
  c.hp = 3
  pneT(pneCoreSpawnMultAt(srv.level, 10, 64, 0, 48) === 0 && pneCoreBeckonAt(srv.level, 10, 64, 0, 48) === false, 'one player in mercy nearby zeroes positional spawns')
  c.hp = 20
  pneT(pneCoreSpawnMultAt(srv.level, 400, 64, 0, 48) === 1 && pneCoreSpawnCount(4, 0) === 0 && pneCoreSpawnCount(4, 1) === 4, 'nobody near gives 1; floor(count * m + rand)')
  pneResEmit = undefined
  pneResPace = function (p) { throws++; throw new Error('boom') }
  for (i = 0; i < 25; i++) pace = pneCorePace(b)
  pneT(throws === 20 && pace.fallback === true && PNE_CORE_B_API.resonance.off === true, 'a throwing module is cut off after 20 errors')

  // --- parasite membership (Java tag lookup unavailable here: falls back to pne_horror id sets)
  PNE_H_HIVE = { 'epca:ripper': true }
  PNE_H_SPORE = { 'spore:knight': true }
  pneT(pneCoreIsParasite(__pneMock.mob(srv, 'epca:ripper')) === true, 'EPCA parasite')
  pneT(pneCoreIsParasite(__pneMock.mob(srv, 'spore:knight')) === true && pneCoreStrain(__pneMock.mob(srv, 'spore:knight')) === 'spore', 'Spore parasite and strain')
  pneT(pneCoreIsParasite(__pneMock.mob(srv, 'minecraft:cow')) === false, 'cow is not a parasite')
  __pneMock.opts.typeAsObject = true
  pneT(pneCoreTypeId(__pneMock.mob(srv, 'epca:ripper')) === 'epca:ripper', 'type id when entity.type is an EntityType (getEncodeId fallback)')
  __pneMock.opts.noEncodeId = true
  pneT(pneCoreTypeId(__pneMock.mob(srv, 'epca:stage_i_beckon')) === 'epca:stage_i_beckon', 'type id parsed from entity.<ns>.<path>')
  __pneMock.opts.typeAsObject = false
  __pneMock.opts.noEncodeId = false

  // --- doom stage: wraps pneHStage, -99 maps to 0, clamped, cached
  pneHStage = function (server, level, dim) { return -99 }
  pneT(pneCoreStage(srv.level) === 0, 'stage -99 (EPCA unreadable) maps to 0')
  pneCoreStageCache = {}
  pneHStage = function (server, level, dim) { return dim === 'minecraft:overworld' ? 12 : 3 }
  pneT(pneCoreStage(srv.level) === 10, 'stage clamped to 10')
  pneHStage = function () { return 4 }
  pneT(pneCoreStage(srv.level) === 10, 'stage cached for 600 ticks')

  // --- hive-caused deaths
  rip = __pneMock.mob(srv, 'epca:ripper')
  __pneMock.fire('EntityEvents.death:minecraft:player', { entity: a, source: __pneMock.damage('mob', rip) })
  pneT(pneCoreHiveDeaths(a, 72000) === 1 && pneCoreHiveDeathsAll(72000) === 1, 'killed by a parasite counts')
  __pneMock.fire('EntityEvents.death:minecraft:player', { entity: a, source: __pneMock.damage('outOfWorld', null) })
  pneT(pneCoreHiveDeaths(a, 72000) === 1, 'void death does not count')
  __pneMock.fire('EntityEvents.hurt:minecraft:player', { entity: a, source: __pneMock.damage('mob', rip) })
  srv.gameTime += 100
  __pneMock.fire('EntityEvents.death:minecraft:player', { entity: a, source: __pneMock.damage('fall', null) })
  pneT(pneCoreHiveDeaths(a, 72000) === 2, 'fall within 200 ticks of a parasite hit counts')
  srv.gameTime += 300
  __pneMock.fire('EntityEvents.death:minecraft:player', { entity: a, source: __pneMock.damage('fall', null) })
  __pneMock.fire('EntityEvents.death:minecraft:player', { entity: a, source: __pneMock.damage('genericKill', rip) })
  pneT(pneCoreHiveDeaths(a, 72000) === 3, 'plain fall does not count; a parasite killer always counts')
  srv.gameTime += 100
  pneT(pneCoreHiveDeaths(a, 50) === 0 && pneCoreHiveDeaths(a, 150) === 1 && pneCoreHiveDeathsAll(150) === 1, 'window respected (game time)')
  pneT(pneCoreDeathCause(__pneMock.damage('genericKill', null)) === 'kill', 'death cause classification')
  // F37: in game KubeJS leaves only its own names visible (getType/getActual on DamageSource, getTime and
  // getDimensionKey on Level). The shared mocks now have exactly that shape; the Mojang names are fallbacks for
  // other mock shapes only
  pneT(typeof __pneMock.damage('mob', rip).getMsgId === 'undefined' && typeof srv.level.getGameTime === 'undefined' &&
    typeof srv.level.getTime === 'function' && typeof rip.getYaw === 'function' && typeof rip.getYRot === 'undefined' &&
    typeof srv.isDedicated === 'function' && typeof srv.isDedicatedServer === 'undefined', 'mocks expose the in-game (KubeJS) names only')
  pneT(pneCoreDeathCause({ getType: function () { return 'outOfWorld' } }) === 'void', 'death cause from getType() (F37)')
  pneT(pneCoreDeathCause({ getMsgId: function () { return 'fall' } }) === 'fall', 'death cause: getMsgId() fallback for other mock shapes')
  pneT(pneCoreSourceEntity({ getEntity: function () { return rip } }) === rip, 'causing entity: getEntity() fallback for other mock shapes')
  pneT(pneCoreNow({ getLevel: function () { return { getGameTime: function () { return 779 } } } }) === 779, 'game time: getGameTime() fallback')
  pneT(pneCoreGameTime({ overworld: function () { return { getTime: function () { return 780 } } } }) === 780, 'overworld() when getOverworld() is missing')
  pneT(pneCoreGameTime({}) === pneCoreTick, 'game time falls back to the tick count')
  pneT(pneCoreSourceEntity({ getActual: function () { return rip } }) === rip, 'causing entity from getActual() (F37)')
  pneT(pneCoreNow({ getLevel: function () { return { getTime: function () { return 777 } } } }) === 777, 'game time from Level.getTime() (F37)')
  pneT(pneCoreGameTime({ getOverworld: function () { return { getTime: function () { return 778 } } } }) === 778, 'overworld game time from getTime() (F37)')
  pneT(pneCoreDim({ getDimensionKey: function () { return { location: function () { return 'minecraft:the_nether' } } } }) === 'minecraft:the_nether',
    'dimension from getDimensionKey() (F37)')

  // --- saved silent mobs rejoin while the hive is absent: unsilenced by command, never cancelled
  mob = __pneMock.mob(srv, 'epca:ripper')
  mob.persistentData.putByte('pne_sil', 1)
  __pneMock.fire('EntityEvents.spawned', { entity: mob })
  cmdsBefore = srv.cmds.length
  __pneMock.tick(srv, 1)
  pneT(srv.cmds.slice(cmdsBefore).join('|').indexOf('data merge entity ' + mob.uuid + ' {Silent:0b}') >= 0 && !mob.persistentData.contains('pne_sil'), 'saved silent mob is unsilenced when the hive is absent')

  // --- Node ArrayList shim / Rhino java.util.ArrayList behave alike for the startup queues
  AL = Java.loadClass('java.util.ArrayList')
  q = new AL()
  q.add('a|1')
  q.add('b|2')
  pneT(q.size() === 2 && String(q.get(0)) === 'a|1' && String(q.remove(0)) === 'a|1' && q.size() === 1, 'java.util.ArrayList queue operations')

  // --- command hub
  pneCoreOnToggle('hive', function (on, server) { hookCalls.push(on) })
  pneCoreCommand('zz', { run: function (ctx) { if (ctx.args[0] !== 'mine') return false; zzArgs = ctx.args; return true }, help: 'zz mine' })
  pneCoreCommand('zz', { run: function (ctx) { zzArgs = ['admin'].concat(ctx.args); return true }, help: 'zz admin', admin: true })
  pneT(pneCoreCommand('Bad Word', { run: function () { return true } }) === false, 'invalid words refused')
  __pneMock.fire('ServerEvents.commandRegistry', brig.event())
  pneT(!!brig.roots.pne, '/pne registered once')
  cmdsBefore = srv.cmds.length
  r = brig.run('pne', __pneMock.source(srv, c, 0))
  pneT(r === 1 && srv.cmds.length > cmdsBefore && srv.cmds[cmdsBefore].indexOf('tellraw ' + c.uuid) === 0, '/pne help replies with tellraw to the caller')
  r = brig.run('pne zz mine a b', __pneMock.source(srv, c, 0))
  pneT(r === 1 && zzArgs.join(',') === 'mine,a,b', 'greedy args reach the first matching spec')
  zzArgs = null
  r = brig.run('pne zz other', __pneMock.source(srv, c, 0))
  pneT(r === 0 && zzArgs === null, 'admin-only spec is skipped for a normal player')
  r = brig.run('pne zz other', __pneMock.source(srv, c, 2))
  pneT(r === 1 && zzArgs.join(',') === 'admin,other', 'operator reaches the admin spec')
  r = brig.run('pne hive off', __pneMock.source(srv, c, 0))
  pneT(pneCoreOn('hive') === true, 'a normal player cannot switch a pillar')
  // a stand-in hive runtime (pne_hive.js and the GA core loaded) so the pneOnHive mirror can show 1
  pneHiveInfo = function () { return null }
  PNE_HIVE_GA = { G: 14 }
  pneCoreCfgLoad(srv)
  pneT(Number(global.pneOnHive) === 1, 'pneOnHive 1 with on_hive 1 and the hive runtime (pne_hive.js + GA core) loaded')
  r = brig.run('pne hive off', __pneMock.source(srv, b, 0))
  pneT(pneCoreOn('hive') === false && Number(global.pneOnHive) === 0 && hookCalls.join(',') === 'false', 'the single-player owner can switch a pillar; hook fired; global mirrored')
  pneT(srv.persistentData.getInt('pne_cfg_on_hive') === 0, 'pillar switch persisted')
  r = brig.run('pne hive on', __pneMock.source(srv, null, 4))
  pneT(pneCoreOn('hive') === true && Number(global.pneOnHive) === 1, 'console can switch a pillar; pneOnHive back to 1')
  PNE_HIVE_GA = undefined
  pneCoreCfgLoad(srv)
  pneT(Number(global.pneOnHive) === 0, 'pneOnHive 0 when pne_hive.js is loaded but the GA core is not (the hive stays off)')
  pneHiveInfo = undefined
  pneCoreCfgLoad(srv)
  pneT(Number(global.pneOnHive) === 0 && pneCoreLoaded('hive') === false, 'pneOnHive 0 without pne_hive.js')
  r = brig.run('pne status', __pneMock.source(srv, c, 0))
  pneT(r === 1, '/pne status runs')
  pneCoreStatus('zz', function (p) { return 'zz ok' })
  s = pneCoreStatusLines(null)
  pneT(s.length >= 2 && s[s.length - 1] === 'zz: zz ok', 'status providers are listed')
  r = brig.run('pne nosuch', __pneMock.source(srv, c, 0))
  pneT(r === -3, 'unknown first word is rejected by the tree')
  r = brig.run('pne config gov_days 7', __pneMock.source(srv, c, 0))
  pneT(r === 0 && pneCoreCfg('gov_days') === 5, 'config needs admin')
  r = brig.run('pne config gov_days 7', __pneMock.source(srv, null, 4))
  pneT(r === 1 && pneCoreCfg('gov_days') === 7, 'admin sets config through the hub')

  // --- breaker
  s = pneCoreBreaker('t', 2, 'consecutive')
  pneCoreFail(s, 'x')
  pneCoreOk(s)
  pneCoreFail(s, 'x')
  pneT(s.off === false, 'consecutive breaker resets on success')
  pneCoreFail(s, 'x')
  pneT(s.off === true, 'consecutive breaker trips at the limit')
}

var pneResPace
var pneResEmit
var pneHiveInfo
var PNE_HIVE_GA
var pneHStage
var PNE_H_HIVE
var PNE_H_SPORE
var pneTestResult = 'FAIL not run'
try {
  pneTestRun()
  pneTestResult = pneTestFails.length ? 'FAIL ' + pneTestFails.length + '/' + pneTestCount + ': ' + pneTestFails.join(' | ') : 'PASS ' + pneTestCount
} catch (err) {
  pneTestResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
