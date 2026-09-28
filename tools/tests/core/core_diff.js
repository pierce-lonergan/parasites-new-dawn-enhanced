// Suites core-diff-node and core-diff-rhino: the difficulty profiles, the EPCA tier sync and the Recruits-safe start of
// overrides/kubejs/server_scripts/pne_00_core.js (docs/IMPLEMENTATION.md 1.5, spec sections A-E). ES5; runs in Node
// (tools/tests/kjs_node.js) and in the real Rhino fork (tools/rhino/pne_rhino.py run).
// Files, in order: tools/tests/kjs_mocks.js, pne_00_core.js, this file. Result: pneDiffTestResult ("PASS n" or "FAIL ...").
//
// Checks: the read mapping (0..3, hardcore 3, an unreadable read keeps the last good value, the world-data fallback), the
// diff_profile pin and the config bounds, global.pneDiffProfile as a wrapped value, the EPCA state machine (managed,
// deliberate at the first sync, an outside change, epca_follow 0 and back, missing classes, the admin command and auto,
// EASY and MASTER never written by the sync), notices only on a change, the login queue, the start gating (no command
// before the first tick; emit, emitAt, tellraw and the unsilence drain refuse; the queue is kept), the seed cache (not
// before the start; any finite value after it, a 0 too, warned once), the Peaceful-aware fallback Pace, the table's shape
// and its Hard row, the deferred sync, the dedicated-server baseline (every level NORMAL: nothing written on Hard, not
// even after /pne difficulty epca auto), EPCA data that loads but cannot be read (one warning, unavailable), no
// tellraw command text holding 'team' (rule 15 (b); the reply still reads back as the same text), and line 4's doom
// part: the next floor day from DIRECTOR's pneHDoomNext (a planted stand-in: a day, all floors reached, not read yet, a
// throw, junk, no helper), "no raises" on Peaceful without asking it.

var pneDTFails = []
var pneDTCount = 0
var pneDTWarns = []

function pneDT(cond, msg) {
  pneDTCount++
  if (!cond) pneDTFails.push(msg)
}

// every pneCoreWarn key is recorded (the warn itself still runs)
var pneDTWarn0 = pneCoreWarn
pneCoreWarn = function (mod, key, msg, max) {
  pneDTWarns.push(String(key))
  return pneDTWarn0(mod, key, msg, max)
}

function pneDTWarned(key) {
  return pneDTWarns.indexOf(key) >= 0
}

function pneDTLevel(srv, dim) {
  var l = { dimension: dim, server: srv }
  l.getDimension = function () { return dim }
  l.getTime = function () { return srv.gameTime }
  l.getServer = function () { return srv }
  l.players = function () { return __pneMock.list([]) }
  l.getPlayers = l.players
  return l
}

// A fresh world: server, the nether and the end as extra levels, one player; EPCA mock E (or none when E is null).
function pneDTWorld(opts, E) {
  var o = opts || {}
  var srv = __pneMock.server({ tickCount: o.tick === undefined ? 100 : o.tick, difficulty: o.difficulty, hardcore: o.hardcore,
    dedicated: o.dedicated === true, cmdResults: o.cmdResults || { seed: 123456789 } })
  srv.extraLevels.push(pneDTLevel(srv, 'minecraft:the_nether'))
  srv.extraLevels.push(pneDTLevel(srv, 'minecraft:the_end'))
  $PneCoreEpcaWDD = E ? E.WDD : null
  $PneCoreEpcaDL = E ? E.DL : null
  pneCoreWarnSeen = {}
  pneDTWarns = []
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  return srv
}

// Ticks until the core's handler has run with pneCoreTick % 20 === slot.
function pneDTTickTo(srv, slot) {
  var guard = 0
  while ((srv.tickCount + 1) % 20 !== slot && guard++ < 100) __pneMock.tick(srv, 1)
  __pneMock.tick(srv, 1)
}

function pneDTCmds(srv, from, prefix) {
  var out = []
  var i
  for (i = from; i < srv.cmds.length; i++) {
    if (srv.cmds[i].indexOf(prefix) === 0) out.push(srv.cmds[i])
  }
  return out
}

function pneDTTag(srv) {
  return srv.persistentData.getCompound('pne_diff')
}

function pneDTHas(obj, keys) {
  var i
  for (i = 0; i < keys.length; i++) {
    if (!obj || !obj.hasOwnProperty(keys[i])) return keys[i]
  }
  return ''
}

function pneDTTable() {
  var i
  var r
  var s
  var miss
  var st = ['CALM', 'UNEASE', 'DREAD', 'PANIC', 'RELEASE']
  var bad = []
  pneDT(PNE_CORE_DIFF.length === 4 && PNE_CORE_DIFF_NAMES.join(',') === 'Peaceful,Easy,Normal,Hard', 'four profile rows, ids 0..3 Peaceful..Hard')
  for (i = 0; i < 4; i++) {
    r = PNE_CORE_DIFF[i]
    miss = pneDTHas(r, ['epca', 'night', 'burst', 'beckon', 'doomK', 'pace', 'gov1h', 'hive', 'spore', 'horde']) ||
      pneDTHas(r.night, ['r', 'spd', 'str', 'strStage', 'spore']) || pneDTHas(r.burst, ['p', 'flesh', 'fmin', 'fspan', 'cap']) ||
      pneDTHas(r.beckon, ['stage', 'c0', 'c1', 'cap', 'cd']) || pneDTHas(r.gov1h, ['floor', 'slope', 'free']) ||
      pneDTHas(r.hive, ['budget', 'govCap', 'targetK', 'govDeaths', 'phen', 'luxMin'])
    for (s = 0; s < st.length && !miss; s++) miss = pneDTHas(r.pace, [st[s]]) || pneDTHas(r.pace[st[s]], ['spawn', 'aggro', 'beckon', 'ga'])
    if (miss) bad.push(i + ':' + miss)
    if (r.id !== i || r.epca !== (i <= 1 ? 'normal' : 'base')) bad.push(i + ':epca')
  }
  pneDT(bad.length === 0, 'every row has the binding fields (' + bad.join(' ') + ')')
  r = PNE_CORE_DIFF[3]
  pneDT(r.night.r === 48 && r.night.spd && r.night.str && r.night.strStage === 0 && r.night.spore, 'Hard nights: Speed I + Strength I within 48 and the Spore buff (release 1.4)')
  pneDT(r.burst.p === 0.65 && r.burst.flesh === 0.5 && r.burst.fmin === 2 && r.burst.fspan === 2 && r.burst.cap === 8, 'Hard Mobs Inside: 0.65 / 0.5 / 2-3 / cap 8 (release 1.4)')
  pneDT(r.beckon.stage === 3 && r.beckon.c0 === 0.02 && r.beckon.c1 === 0.01 && r.beckon.cap === 0.09 && r.beckon.cd === 100, 'Hard beckon: stage 3, 2% + 1% x (s-3), cap 9%, 100 ticks (release 1.4)')
  pneDT(r.pace.CALM.spawn === 1.25 && r.pace.UNEASE.spawn === 1.10 && r.pace.DREAD.spawn === 0.80 && r.pace.PANIC.spawn === 0 && r.pace.RELEASE.spawn === 0.20 &&
    r.pace.PANIC.aggro === 0.9 && r.pace.RELEASE.aggro === 0.8 && r.pace.PANIC.ga === 0.5 && r.pace.RELEASE.ga === 0 && r.pace.DREAD.beckon === false,
    'Hard pace equals PNE_RES_PACING of release 1.4')
  pneDT(r.gov1h.floor === 0.5 && r.gov1h.slope === 0.15 && r.gov1h.free === 1, 'Hard hourly governor max(0.5, 1 - 0.15 x max(0, d - 1))')
  pneDT(r.hive.budget === 1 && r.hive.govCap === 1.15 && r.hive.targetK === 1 && r.hive.govDeaths === 2 && r.hive.phen === 1 && r.hive.luxMin === 11,
    'Hard hive factors are identities (govCap 1.15 = the GA bound, luxMin 11 = PNE_HIVE_LIGHT_MIN)')
  pneDT(r.spore === 1 && r.horde === 1 && r.bed === true, 'Hard: Spore damage and horde size unchanged, bed rule on')
  pneDT(PNE_CORE_DIFF[0].doomK === 0 && PNE_CORE_DIFF[1].doomK === 1 && PNE_CORE_DIFF[2].doomK === 1 && PNE_CORE_DIFF[3].doomK === 1,
    'lead decision L1: doomK 1 on Easy, Normal and Hard (the 100-day arc), 0 on Peaceful')
  pneDT(PNE_CORE_DIFF[1].burst.p === 0.35 && PNE_CORE_DIFF[1].burst.flesh === 0.27 && PNE_CORE_DIFF[1].burst.cap === 4 && PNE_CORE_DIFF[2].burst.p === 0.5 &&
    PNE_CORE_DIFF[2].burst.flesh === 0.38 && PNE_CORE_DIFF[2].burst.cap === 6, 'Easy / Normal bursts 0.35 / 0.27 / cap 4 and 0.50 / 0.38 / cap 6 (row 4)')
  pneDT(PNE_CORE_DIFF[0].spore === 0.5 && PNE_CORE_DIFF[1].spore === 0.7 && PNE_CORE_DIFF[2].spore === 1 && PNE_CORE_DIFF[0].horde === 0 &&
    PNE_CORE_DIFF[1].horde === 0.6 && PNE_CORE_DIFF[2].horde === 0.8, 'rows 16 and 17: Spore x0.5 / 0.70 / 1 / 1, hordes cancel / 0.6 / 0.8 / 1')
  pneDT(PNE_CORE_DIFF[0].pace.CALM.spawn === 0 && PNE_CORE_DIFF[0].pace.CALM.beckon === false && PNE_CORE_DIFF[0].pace.UNEASE.ga === 0 && PNE_CORE_DIFF[0].bed === false,
    'Peaceful: spawn 0, beckon off, ga 0 in every state; no bed refusal')
  pneDT(PNE_CORE_DIFF[1].pace.DREAD.aggro === 0.9 && PNE_CORE_DIFF[1].hive.luxMin === 10 && PNE_CORE_DIFF[1].hive.govDeaths === 1, 'Easy: DREAD aggro 0.9, luxMin 10, governor step at 1 death')
  pneDT(PNE_CORE_EPCA_BASE === 2 && PNE_CORE_EPCA_NAMES[PNE_CORE_EPCA_BASE] === 'Expert', 'PNE_CORE_EPCA_BASE is EXPERT (2)')
  pneDT(PNE_CORE_COST.diffSync === 0.05, 'PNE_CORE_COST.diffSync 0.05 ms per level')
}

function pneDTRun() {
  var E
  var srv
  var p
  var q
  var c0
  var r
  var tag
  var brig
  var lines
  var pace
  var s
  var i
  var bad
  var id
  var u
  var js
  var o

  pneDTTable()

  // --- config keys and bounds
  srv = pneDTWorld({}, null)
  pneDT(pneCoreCfg('diff_profile') === 0 && pneCoreCfg('epca_follow') === 1, 'defaults: diff_profile 0 (follows vanilla), epca_follow 1')
  pneDT(pneCoreCfgSet(srv, 'diff_profile', 5) === false && pneCoreCfgSet(srv, 'diff_profile', -1) === false && pneCoreCfgSet(srv, 'epca_follow', 2) === false,
    'config bounds: diff_profile 0-4, epca_follow 0-1')

  // --- the read mapping
  for (i = 0; i <= 3; i++) {
    srv.difficulty = i
    pneDT(pneCoreDiffRead(srv) === i, 'vanilla difficulty ' + i + ' reads as profile ' + i)
  }
  srv.difficulty = 1
  srv.hardcore = true
  pneDT(pneCoreDiffRead(srv) === 3 && pneCoreDiffRaw === 1 && pneCoreDiffHc === true, 'hardcore counts as 3 (the raw value is kept for display)')
  srv.hardcore = false
  srv.difficultyBroken = true
  pneDT(pneCoreDiffRead(srv) === 1, 'an unreadable level falls back to the world data')
  srv.getWorldData = function () { throw new Error('mock: no world data') }
  pneDT(pneCoreDiffRead(srv) === -1, 'both reads unreadable: -1')
  srv.difficultyBroken = false
  srv.difficulty = 7
  pneDT(pneCoreDiffRead(srv) === -1, 'an out-of-range id is unreadable')

  // --- start gating, the seed cache, global as a wrapped value
  srv = pneDTWorld({ difficulty: 2, cmdResults: { seed: 42 } }, null)
  p = __pneMock.player(srv, 'Ann', 'aaaa0000-0000-4000-8000-00000000000a', {})
  pneDT(pneCoreStarted === false, 'pneCoreStarted is false after ServerEvents.loaded')
  pneDT(srv.cmds.length === 0, 'ServerEvents.loaded issues no command')
  pneDT(typeof global.pneDiffProfile === 'object' && global.pneDiffProfile !== 2 && Number(global.pneDiffProfile) === 2,
    'loaded mirrors the profile to global.pneDiffProfile; it reads back as a wrapped value (=== fails, Number() works)')
  pneDT(pneCoreEmit(p, 'epca:slam', 'hostile', '~ ~ ~', 1, {}) === false && pneCoreEmitAt(srv, 'minecraft:overworld', 0, 64, 0, 16, 'epca:slam', 'hostile', 1, {}) === 0,
    'emit and emitAt refuse before the start')
  pneDT(pneCoreTellraw(srv, '@a', 'x', 'gray') === false, 'tellraw refuses before the start')
  pneCoreUnsilenceQ.push('bbbb0000-0000-4000-8000-00000000000b')
  pneDT(pneCoreUnsilenceDrain(srv) === 0 && pneCoreUnsilenceQ.length === 1, 'the unsilence drain waits (the queue is kept)')
  pneDT(pneCoreSeed32(srv) === 0 && pneCoreSeedCache === null && pneDTWarned('seed.early'), 'seed read before start: 0, not cached, one warning')
  pneDT(srv.cmds.length === 0, 'no command at all before the first tick')
  __pneMock.fire('PlayerEvents.loggedIn', { player: p })
  pneDT(srv.cmds.length === 0 && pneCoreDiffLogins.length === 1, 'a login before the first tick is queued, not told')
  __pneMock.tick(srv, 1)
  pneDT(pneCoreStarted === true, 'the core tick sets pneCoreStarted')
  pneDT(pneDTCmds(srv, 0, 'data merge entity bbbb0000').length === 1 && pneCoreUnsilenceQ.length === 0, 'the kept unsilence queue drains on the first tick')
  pneDT(pneCoreSeed32(srv) === 42 && pneCoreSeedCache === 42, 'seed read after the start is cached')
  srv.cmdResults.seed = 7
  pneDT(pneCoreSeed32(srv) === 42, 'the cached seed stays for the run')
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneDT(pneCoreStarted === false && pneCoreSeedCache === null, 'a new load resets pneCoreStarted and the seed cache')
  __pneMock.tick(srv, 1)
  srv.cmdResults.seed = 0
  pneCoreSeedCache = null
  pneDT(pneCoreSeed32(srv) === 0 && pneCoreSeedCache === 0 && pneDTWarned('seed.zero'), 'a 0 after the start is cached like any finite value (spec D), warned')
  c0 = pneDTCmds(srv, 0, 'seed').length
  srv.cmdResults.seed = 5
  pneDT(pneCoreSeed32(srv) === 0 && pneCoreSeed32(srv) === 0 && pneDTCmds(srv, 0, 'seed').length === c0 && pneCoreWarnSeen['core:seed.zero'] === 1,
    'the cached 0 stays for the run: no further /seed, one warning')
  pneCoreSeedCache = null
  srv.cmdResults.seed = -1
  pneDT(pneCoreSeed32(srv) === 4294967295 && pneCoreSeedCache === 4294967295, 'a negative (int) seed is cached unsigned (>>> 0)')
  pneCoreSeedCache = null
  q = srv.runCommandSilent
  srv.runCommandSilent = function (c) { srv.cmds.push(String(c)); throw new Error('mock: command failed') }
  pneDT(pneCoreSeed32(srv) === 0 && pneCoreSeedCache === null, 'a /seed that throws (not a number) is not cached; the next call asks again')
  srv.runCommandSilent = q
  pneDT(pneCoreSeed32(srv) === 4294967295 && pneCoreSeedCache === 4294967295, 'and the next call reads it')

  // --- EPCA: pack-managed world (default button), Hard -> Easy -> Hard -> Normal
  E = __pneMock.epca()
  srv = pneDTWorld({ difficulty: 3 }, E)
  p = __pneMock.player(srv, 'Ann', 'aaaa0000-0000-4000-8000-00000000000a', {})
  __pneMock.fire('PlayerEvents.loggedIn', { player: p })
  __pneMock.tick(srv, 1)
  pneDT(E.writes.length === 0 && E.gets >= 3, 'Hard on a default-button world: every level read, no EPCA write')
  pneDT(pneDTTag(srv).contains('x.minecraft:overworld') === false, 'the default button counts as pack-managed')
  pneDT(pneDTCmds(srv, 0, 'tellraw').length === 0, 'no chat line on the first tick')
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  r = pneDTCmds(srv, c0, 'tellraw ' + p.uuid)
  pneDT(r.length === 1 && r[0].indexOf('[PNE] Difficulty Hard (pack profile Hard, EPCA tier Expert). /pne difficulty shows the details.') > 0,
    'login line at the first slot 5 after the first-tick sync')
  pneDT(String(p.persistentData.getString('pne_diff_seen')) === '3/2', 'pne_diff_seen = "<profile>/<overworld tier>"')
  __pneMock.fire('PlayerEvents.loggedIn', { player: p })
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  pneDT(pneDTCmds(srv, c0, 'tellraw').length === 0, 'the login line is one-time (seen key unchanged)')
  srv.difficulty = 1
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 1 && E.writes[0].dim === 'minecraft:overworld' && E.writes[0].id === 1, 'Easy: the overworld goes Expert -> Normal; nether and end stay')
  pneDT(Number(pneDTTag(srv).getInt('w.minecraft:overworld')) === 1, 'the written tier is recorded in w.<dim>')
  r = pneDTCmds(srv, c0, 'tellraw @a')
  pneDT(r.length === 1 && r[0].indexOf('Difficulty is now Easy: calmer nights, fewer bursts and reinforcements; parasites that spawn from now on use EPCA tier Normal (was Expert).') > 0,
    'one gray line to @a with the EPCA clause')
  pneDT(Number(global.pneDiffProfile) === 1 && pneCoreDiffId() === 1 && pneCoreDiff() === PNE_CORE_DIFF[1], 'the poll updates pneCoreDiffId, pneCoreDiff and global')
  pneDT(String(p.persistentData.getString('pne_diff_seen')) === '1/1', 'players online for the notice count as having seen it')
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  pneDTTickTo(srv, 5)
  pneDT(pneDTCmds(srv, c0, 'tellraw').length === 0 && E.writes.length === 1, 'no notice and no write without a change')
  srv.difficulty = 3
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 2 && E.writes[1].id === 2 && Number(pneDTTag(srv).getInt('w.minecraft:overworld')) === 2, 'back to Hard: Normal -> Expert, recorded')
  pneDT(pneDTCmds(srv, c0, 'tellraw @a')[0].indexOf('Difficulty is now Hard: full night buffs, bursts and reinforcements; parasites that spawn from now on use EPCA tier Expert (was Normal).') > 0,
    'the Hard notice')
  srv.difficulty = 2
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  r = pneDTCmds(srv, c0, 'tellraw @a')
  pneDT(E.writes.length === 2 && r.length === 1 && r[0].indexOf('EPCA tier') < 0 && r[0].indexOf('Difficulty is now Normal') > 0, 'Normal keeps the baseline: no write, no EPCA clause')
  srv.difficultyBroken = true
  srv.getWorldData = function () { throw new Error('mock: no world data') }
  pneDTTickTo(srv, 5)
  pneDT(pneCoreDiffId() === 2 && pneCoreDiffLast === 2, 'an unreadable poll keeps the last good value')
  srv.difficultyBroken = false
  srv.getWorldData = function () { return { getDifficulty: function () { return __pneMock.difficulty(srv.difficulty) }, isHardcore: function () { return srv.hardcore } } }

  // --- the pin
  c0 = srv.cmds.length
  pneDT(pneCoreCfgSet(srv, 'diff_profile', 2) === true, 'diff_profile 2 accepted')
  pneDTTickTo(srv, 5)
  pneDT(pneCoreDiffId() === 1 && pneCoreDiffPinned() && Number(global.pneDiffProfile) === 1, 'diff_profile 2 pins Easy whatever vanilla says')
  pneDT(pneDTCmds(srv, c0, 'tellraw @a').length === 1 && E.writes[E.writes.length - 1].id === 1, 'the pin is picked up by the poll (notice and sync)')
  srv.difficulty = 3
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  pneDT(pneCoreDiffId() === 1 && pneDTCmds(srv, c0, 'tellraw @a').length === 0, 'a vanilla change under a pin changes nothing')
  pneCoreCfgSet(srv, 'diff_profile', 0)
  pneDTTickTo(srv, 5)
  pneDT(pneCoreDiffId() === 3 && !pneCoreDiffPinned(), 'diff_profile 0 follows vanilla again')

  // --- commands and status
  srv.difficulty = 1
  pneDTTickTo(srv, 5)
  brig = __pneMock.brig()
  __pneMock.fire('ServerEvents.commandRegistry', brig.event())
  c0 = srv.cmds.length
  r = brig.run('pne difficulty', __pneMock.source(srv, p, 0))
  lines = pneDTCmds(srv, c0, 'tellraw ' + p.uuid)
  pneDT(r === 1 && lines.length === 4, '/pne difficulty (anyone) prints 4 lines')
  pneDT(lines.length === 4 && lines[0].indexOf('difficulty: vanilla Easy -> profile Easy (follows vanilla; /pne config diff_profile pins it)') > 0, 'line 1: vanilla -> profile')
  pneDT(lines.length === 4 && lines[1].indexOf('EPCA tier: overworld Normal (pack-managed), the_nether Normal (pack-managed), the_end Normal (pack-managed); epca_follow 1') > 0,
    'line 2: EPCA tier per dimension')
  pneDT(lines.length === 4 && lines[2].indexOf('nights: Speed I within 32, no Strength, no Spore buff; bursts 35% (cap 4); beckons from stage 4, <= 4%, 400 t') > 0, 'line 3: nights, bursts, beckons')
  pneDT(lines.length === 4 && lines[3].indexOf('"doom clock as Hard; spawns CALM 1.00 / UNEASE 0.95 / DREAD 0.65; genes x0.65, gov cap 1.00; Spore damage x0.70; hordes x0.6"') > 0,
    'line 4: doom (as Hard; no floor day without pne_horror.js), spawns, genes, Spore damage, hordes')
  s = pneCoreStatusLines(null).join('|')
  pneDT(s.indexOf('difficulty: Easy (vanilla Easy, auto); EPCA overworld Normal (managed)') >= 0, '/pne status difficulty line')
  c0 = srv.cmds.length
  r = brig.run('pne difficulty epca master', __pneMock.source(srv, p, 0))
  pneDT(r === 0 && E.tiers['minecraft:overworld'] === 1 && pneDTCmds(srv, c0, 'tellraw ' + p.uuid)[0].indexOf('operator') > 0, '/pne difficulty epca needs admin')
  r = brig.run('pne difficulty epca master', __pneMock.source(srv, null, 4))
  tag = pneDTTag(srv)
  pneDT(r === 1 && E.tiers['minecraft:overworld'] === 3 && E.tiers['minecraft:the_nether'] === 3 && E.tiers['minecraft:the_end'] === 3, 'admin: MASTER written in every loaded level')
  pneDT(Number(tag.getByte('x.minecraft:overworld')) === 1 && Number(tag.getByte('x.minecraft:the_end')) === 1, 'admin write marks every level deliberate')
  srv.difficulty = 3
  q = E.writes.length
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === q && E.tiers['minecraft:overworld'] === 3, 'a deliberate level is left alone on a profile change')
  pneDT(pneCoreStatusLines(null).join('|').indexOf('EPCA overworld Master (deliberate)') >= 0, 'status shows deliberate')
  srv.difficulty = 1
  pneDTTickTo(srv, 5)
  r = brig.run('pne difficulty epca auto', __pneMock.source(srv, null, 4))
  tag = pneDTTag(srv)
  pneDT(r === 1 && !tag.contains('x.minecraft:overworld') && Number(tag.getInt('w.minecraft:overworld')) === 3, 'auto clears x.* and records the current tier as w')
  __pneMock.tick(srv, 1)
  pneDT(E.tiers['minecraft:overworld'] === 1 && E.tiers['minecraft:the_nether'] === 1 && E.tiers['minecraft:the_end'] === 1, 'the sync after auto manages again (Easy: NORMAL everywhere)')
  bad = []
  for (i = 0; i < E.writes.length; i++) {
    if (E.writes[i].id !== 1 && E.writes[i].id !== 2 && !(E.writes[i].id === 3 && i >= q - 3 && i < q)) bad.push(JSON.stringify(E.writes[i]))
  }
  pneDT(bad.length === 0, 'the sync never writes EPCA EASY or MASTER (only the admin command did): ' + bad.join(' '))

  // --- deliberate at the first sync: the Create World button said Normal on a Hard world
  E = __pneMock.epca({ tiers: { 'minecraft:overworld': 1 } })
  srv = pneDTWorld({ difficulty: 3 }, E)
  __pneMock.tick(srv, 1)
  pneDT(E.writes.length === 0 && Number(pneDTTag(srv).getByte('x.minecraft:overworld')) === 1 && pneDTWarned('epca.x.minecraft:overworld'),
    'a button choice (Normal on Hard) is detected at the first sync: hands off, one warning')
  srv.difficulty = 1
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 0, 'and stays untouched on Easy')

  // --- an outside change of a managed tier
  E = __pneMock.epca()
  srv = pneDTWorld({ difficulty: 1 }, E)
  __pneMock.tick(srv, 1)
  pneDT(E.tiers['minecraft:overworld'] === 1 && E.writes.length === 1, 'Easy world: managed to Normal at the first sync')
  E.tiers['minecraft:overworld'] = 3
  srv.difficulty = 2
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 1 && E.tiers['minecraft:overworld'] === 3 && Number(pneDTTag(srv).getByte('x.minecraft:overworld')) === 1,
    'an outside edit (Master) is detected at the next sync and respected')

  // --- epca_follow 0 and back
  E = __pneMock.epca()
  srv = pneDTWorld({ difficulty: 3 }, E)
  __pneMock.tick(srv, 1)
  pneCoreCfgSet(srv, 'epca_follow', 0)
  srv.difficulty = 1
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 0 && pneCoreDiffId() === 1, 'epca_follow 0: the profile changes, no EPCA write')
  pneDT(pneCoreStatusLines(null).join('|').indexOf('EPCA overworld Expert (not managed)') >= 0, 'status: not managed')
  pneCoreCfgSet(srv, 'epca_follow', 1)
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 1 && E.tiers['minecraft:overworld'] === 1, 'epca_follow back to 1: the next poll syncs')

  // --- a dedicated server: EPCA applies defaultExtraDifficulty only on the client's Create World screen, so every level
  // of a dedicated world starts at NORMAL (javap: WorldDifficultyData() = NORMAL; WorldLoadHandler sets the pending screen
  // choice only when FMLEnvironment.dist is CLIENT); that is the baseline there, and Hard stays NORMAL as in release 1.4
  E = __pneMock.epca({ tiers: { 'minecraft:overworld': 1 } })
  srv = pneDTWorld({ difficulty: 3, dedicated: true }, E)
  __pneMock.tick(srv, 1)
  pneDT(pneCoreIsDedicated(srv) === true && pneCoreEpcaBase('minecraft:overworld', srv) === 1 && pneCoreEpcaBase('minecraft:the_nether', srv) === 1,
    'dedicated: the baseline is NORMAL in every dimension')
  pneDT(E.writes.length === 0 && !pneDTTag(srv).contains('x.minecraft:overworld') && !pneDTWarned('epca.x.minecraft:overworld'),
    'dedicated, Hard: a fresh world (overworld NORMAL) is pack-managed: no warning, no write')
  pneDT(pneCoreStatusLines(null).join('|').indexOf('EPCA overworld Normal (managed)') >= 0, 'dedicated: status shows the overworld managed')
  srv.difficulty = 1
  pneDTTickTo(srv, 5)
  srv.difficulty = 3
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 0 && E.tiers['minecraft:overworld'] === 1, 'dedicated, Hard -> Easy -> Hard: nothing written, never EXPERT')
  brig = __pneMock.brig()
  __pneMock.fire('ServerEvents.commandRegistry', brig.event())
  r = brig.run('pne difficulty epca auto', __pneMock.source(srv, null, 4))
  srv.difficulty = 2
  pneDTTickTo(srv, 5)
  srv.difficulty = 3
  pneDTTickTo(srv, 5)
  pneDT(r === 1 && E.writes.length === 0 && E.tiers['minecraft:overworld'] === 1, 'dedicated, after /pne difficulty epca auto: Normal and Hard still write nothing (Hard is not made harder)')
  E = __pneMock.epca()
  srv = pneDTWorld({ difficulty: 1, dedicated: true }, E)
  __pneMock.tick(srv, 1)
  pneDT(E.writes.length === 0 && Number(pneDTTag(srv).getByte('x.minecraft:overworld')) === 1 && pneDTWarned('epca.x.minecraft:overworld'),
    'dedicated, an overworld at EXPERT (a single-player world moved to the server): deliberate, one warning, never written')
  srv = __pneMock.server({})
  srv.isDedicated = undefined
  srv.isDedicatedServer = function () { return true }
  pneDT(pneCoreIsDedicated(srv) === true, 'isDedicatedServer() is the fallback when isDedicated() is missing')
  srv.isDedicatedServer = undefined
  pneDT(pneCoreIsDedicated(srv) === false && pneCoreIsDedicated(null) === false, 'unknown: the integrated baseline (EXPERT in the overworld)')

  // --- EPCA's classes load, but its tier data cannot be read
  E = __pneMock.epca()
  E.broken = true
  srv = pneDTWorld({ difficulty: 1 }, E)
  p = __pneMock.player(srv, 'Ann', 'aaaa0000-0000-4000-8000-00000000000a', {})
  __pneMock.tick(srv, 1)
  pneDT(E.writes.length === 0 && pneDTWarned('epca.read') && !pneDTWarned('epca.api'), 'EPCA data unreadable in every level: no write, an epca.read warning')
  srv.difficulty = 3
  pneDTTickTo(srv, 5)
  pneDT(pneCoreWarnSeen['core:epca.read'] === 1, 'the epca.read warning is printed once (the next sync is quiet)')
  pneDT(pneCoreStatusLines(null).join('|').indexOf('difficulty: Hard (vanilla Hard, auto); EPCA tier unavailable') >= 0, 'status: EPCA tier unavailable')
  pneDT(pneCoreDiffLines(srv)[1].indexOf('EPCA tier: overworld unavailable, the_nether unavailable, the_end unavailable') === 0, '/pne difficulty: unavailable per level')
  E.broken = false
  srv.difficulty = 1
  pneDTTickTo(srv, 5)
  pneDT(E.writes.length === 1 && E.tiers['minecraft:overworld'] === 1, 'readable again: the next sync manages the tier')

  // --- EPCA classes missing
  srv = pneDTWorld({ difficulty: 3 }, null)
  p = __pneMock.player(srv, 'Ann', 'aaaa0000-0000-4000-8000-00000000000a', {})
  __pneMock.tick(srv, 1)
  pneDT(pneDTWarned('epca.api'), 'missing EPCA classes: one warning')
  srv.difficulty = 1
  c0 = srv.cmds.length
  pneDTTickTo(srv, 5)
  pneDT(pneCoreDiffId() === 1 && Number(global.pneDiffProfile) === 1 && pneDTCmds(srv, c0, 'tellraw @a').length === 1, 'without EPCA the profile still follows (global, notice)')
  pneDT(pneCoreStatusLines(null).join('|').indexOf('difficulty: Easy (vanilla Easy, auto); EPCA tier unavailable') >= 0, 'status: EPCA tier unavailable')
  pneDT(pneCoreDiffLines(srv)[1].indexOf('EPCA tier unavailable') === 0, '/pne difficulty: EPCA tier unavailable')

  // --- the Peaceful-aware fallback Pace (no director)
  srv.difficulty = 0
  pneDTTickTo(srv, 5)
  pace = pneCorePace(p)
  pneDT(pace.fallback === true && pace.spawn === 0 && pace.beckon === false && pace.ga === 0 && pace.aggro === 0.8, 'Peaceful fallback Pace: spawn 0, beckon false, ga 0, aggro 0.8')
  srv.difficulty = 3
  pneDTTickTo(srv, 5)
  pace = pneCorePace(p)
  pneDT(pace.spawn === 1 && pace.beckon === true && pace.ga === 1 && pace.aggro === 1, 'Hard fallback Pace unchanged (spawn 1, beckon, ga 1, aggro 1)')

  // --- a sync that does not fit the budget waits for the next tick
  E = __pneMock.epca()
  srv = pneDTWorld({ difficulty: 3 }, E)
  __pneMock.tick(srv, 1)
  pneCoreDiffPend = { id: 1, notice: false, before: -1 }
  pneCoreLeftMs = 0.01
  pneCoreDiffRunPend(srv)
  pneDT(pneCoreDiffPend !== null && E.writes.length === 0, 'a refused take keeps the sync pending')
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  id = pneCoreSpentMs
  pneCoreDiffRunPend(srv)
  pneDT(pneCoreDiffPend === null && E.writes.length === 1 && Math.abs(pneCoreSpentMs - id - 3 * PNE_CORE_COST.diffSync) < 1e-9, 'it runs when it fits, charged diffSync per level')

  // --- rule 15 (b) in every reply (VISUAL's review finding VIS-1): Recruits takes over a server command whose text holds
  // 'team' (case-sensitive) plus add/remove/join/leave anywhere, so pneCoreTellraw writes each 'team' in its JSON as the
  // escape backslash-u0074eam; the JSON still reads back as the same text (Gson decodes it like JSON.parse)
  srv = pneDTWorld({ difficulty: 3 }, null)
  __pneMock.tick(srv, 1)
  u = 'addd0000-0000-4000-8000-00000000add1'
  c0 = srv.cmds.length
  pneDT(pneCoreTellraw(srv, u, 'visual: teams 8/8, 3 entries; the team adds; Teams stay', 'gold') === true, 'tellraw after the start is issued')
  r = pneDTCmds(srv, c0, 'tellraw ' + u + ' ')
  js = r.length === 1 ? r[0].substring(('tellraw ' + u + ' ').length) : ''
  pneDT(r.length === 1 && r[0].indexOf('team') < 0, 'the tellraw command text never holds team (' + r.join(' / ') + ')')
  o = null
  try { o = JSON.parse(js) } catch (e) { o = null }
  pneDT(o !== null && o.text === 'visual: teams 8/8, 3 entries; the team adds; Teams stay' && o.color === 'gold', 'its JSON reads back as the same text and color')
  pneDT(js.indexOf(String.fromCharCode(92) + 'u0074eams 8/8') > 0 && js.indexOf('Teams stay') > 0, 'the escape form, and Team (capital T, which Recruits ignores) left as is')
  c0 = srv.cmds.length
  pneDT(pneCoreTellraw(srv, '@a', 'x', 'gray') === true && pneDTCmds(srv, c0, 'tellraw @a ')[0] === 'tellraw @a {"text":"x","color":"gray"}', 'a text without team is unchanged')

  pneDTDoomLine()
}

// --- line 4's doom part: the next doom floor. pne_horror.js is not loaded here, so the suite plants a stand-in for
// DIRECTOR's read-only pneHDoomNext() (contract 3.2.1) giving each documented answer: a day >= 1, -1 (every floor
// reached), -2 (the doom clock has not read the day yet), a throw, and answers that are not a day. On Peaceful the core
// must not ask it at all.
var pneHDoomNext
var pneDTDoomAnswer = 0
var pneDTDoomCalls = 0

function pneDTDoomStub() {
  pneDTDoomCalls++
  if (pneDTDoomAnswer === 'throw') throw new Error('mock: pneHDoomNext failed')
  return pneDTDoomAnswer
}

// Line 4 of /pne difficulty while the stand-in answers a (a undefined: no helper at all).
function pneDTDoom4(srv, a) {
  pneHDoomNext = a === undefined ? undefined : pneDTDoomStub
  pneDTDoomAnswer = a
  return String(pneCoreDiffLines(srv)[3])
}

function pneDTDoomLine() {
  var srv
  var p
  var brig
  var c0
  var r
  var lines
  var i
  var bad = []
  var junk = [NaN, null, 0, 'x', Infinity, -Infinity]
  var k0 = PNE_CORE_DIFF[1].doomK
  var easy = '; spawns CALM 1.00 / UNEASE 0.95 / DREAD 0.65; genes x0.65, gov cap 1.00; Spore damage x0.70; hordes x0.6'
  srv = pneDTWorld({ difficulty: 1 }, null)
  p = __pneMock.player(srv, 'Ann', 'aaaa0000-0000-4000-8000-00000000000a', {})
  __pneMock.tick(srv, 1)
  c0 = srv.cmds.length
  pneDTDoomCalls = 0
  pneDT(pneDTDoom4(srv, undefined) === 'doom clock as Hard' + easy, 'line 4 without pneHDoomNext: doom clock as Hard, no floor day')
  pneDT(pneDTDoom4(srv, 9) === 'doom clock as Hard (next floor day 9)' + easy && pneDTDoomCalls === 1, 'line 4: the next floor day from pneHDoomNext (asked once)')
  pneDT(pneDTDoom4(srv, -1) === 'doom clock as Hard (all floors reached)' + easy, 'line 4, answer -1: all floors reached')
  pneDT(pneDTDoom4(srv, -2) === 'doom clock as Hard' + easy, 'line 4, answer -2 (the doom clock has not read the day yet): no floor day')
  pneDT(pneDTDoom4(srv, 'throw') === 'doom clock as Hard' + easy, 'line 4, the helper throws: no floor day and no error')
  pneDT(pneDTDoom4(srv, '20') === 'doom clock as Hard (next floor day 20)' + easy, 'line 4: a numeric answer that is not a JS number is converted (rule 5)')
  for (i = 0; i < junk.length; i++) {
    if (pneDTDoom4(srv, junk[i]) !== 'doom clock as Hard' + easy) bad.push(String(junk[i]))
  }
  pneDT(bad.length === 0, 'line 4, answers that are not a day (NaN, null, 0, text, infinities) show no floor day (' + bad.join(' ') + ')')
  pneDT(srv.cmds.length === c0, 'building line 4 issues no command (a pure read)')

  // through the command, in chat
  pneHDoomNext = pneDTDoomStub
  pneDTDoomAnswer = 9
  brig = __pneMock.brig()
  __pneMock.fire('ServerEvents.commandRegistry', brig.event())
  c0 = srv.cmds.length
  r = brig.run('pne difficulty', __pneMock.source(srv, p, 0))
  lines = pneDTCmds(srv, c0, 'tellraw ' + p.uuid)
  pneDT(r === 1 && lines.length === 4 && lines[3].indexOf('"doom clock as Hard (next floor day 9); spawns CALM 1.00 / UNEASE 0.95 / DREAD 0.65;') > 0,
    '/pne difficulty shows the next floor day in chat')

  // the other profiles
  srv.difficulty = 2
  pneDTTickTo(srv, 5)
  pneDT(pneDTDoom4(srv, 12).indexOf('doom clock as Hard (next floor day 12); spawns CALM 1.10 / UNEASE 1.00 / DREAD 0.75; genes x0.85,') === 0,
    'Normal: the doom clock as Hard, with the next floor day (L1)')
  srv.difficulty = 3
  pneDTTickTo(srv, 5)
  pneDT(pneDTDoom4(srv, 100).indexOf('doom clock as Hard (next floor day 100); spawns CALM 1.25 / UNEASE 1.10 / DREAD 0.80; genes x1, gov cap 1.15;') === 0,
    'Hard: the doom clock with the next floor day')
  srv.difficulty = 0
  pneDTTickTo(srv, 5)
  pneDTDoomCalls = 0
  pneDT(pneDTDoom4(srv, 9).indexOf('doom clock: no raises; spawns CALM 0.00 / UNEASE 0.00 / DREAD 0.00; genes x0,') === 0 && pneDTDoomCalls === 0,
    'Peaceful: doom clock: no raises, and pneHDoomNext is not asked')

  // a row whose doomK is not Hard's (none today, lead decision L1) names its factor instead of "as Hard"
  srv.difficulty = 1
  pneDTTickTo(srv, 5)
  r = ''
  try {
    PNE_CORE_DIFF[1].doomK = 1.5
    r = pneDTDoom4(srv, 9)
  } finally {
    PNE_CORE_DIFF[1].doomK = k0
  }
  pneDT(r.indexOf('doom clock days x1.5 (next floor day 9);') === 0 && PNE_CORE_DIFF[1].doomK === 1, 'a doomK other than Hard\'s names its factor (the table is restored)')
  pneHDoomNext = undefined
}

var pneResPace
var pneResEmit
var pneResEmitAt
var pneDiffTestResult = 'FAIL not run'
try {
  pneDTRun()
  pneDiffTestResult = pneDTFails.length ? 'FAIL ' + pneDTFails.length + '/' + pneDTCount + ': ' + pneDTFails.join(' | ') : 'PASS core-diff ' + pneDTCount + ' checks'
} catch (err) {
  pneDiffTestResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '') + ' after ' + pneDTCount + ' checks; failed so far: ' + pneDTFails.join(' | ')
}
