// Suite diff-events-rhino: overrides/kubejs/startup_scripts/pne_diff_events.js (Spore-to-player damage and the Hordes
// wave size per difficulty profile) and the Peaceful skip of pne_horde_rules.js's bed rule, in the real Rhino fork
// (global is a java.util.HashMap there, so every value read back is a wrapped Java object, F6). ES5.
// Files, in order: tools/tests/kjs_mocks.js, tools/tests/core/diff_events_env.js, pne_00_core.js,
// startup_scripts/pne_diff_events.js, startup_scripts/pne_horde_rules.js, this file. Result: pneDiffEvResult.
//
// Checks: a missing global means no change; Spore damage scaled for player victims only (by the causing entity, also
// for a projectile's owner), never for EPCA or non-Spore attackers or mob victims; Hard and Normal never touch the event;
// the Hordes listener at LOWEST without receiveCanceled, floor(amount x k), at least 1, the Peaceful cancel, the wave
// sizes of days 7/14/21/28; the factor tables equal PNE_CORE_DIFF; the core's global mirror read back as a wrapped value
// drives the listener; the per-listener breaker; the bed rule off on Peaceful only.
// The Peaceful cancel against a model of The Hordes' schedule (pneDEHordes, from javap): one attempt per horde day, the
// schedule moves on, The Hordes' own bed refusal (isHordeDay) never fires, no catch-up after leaving Peaceful; a
// /hordes spawnWave build event leaves a schedule that is not due alone; the fallbacks (no saved data: the configured
// step; a schedule that cannot be moved: an empty wave instead of a cancel, one warning).

var pneDEFails = []
var pneDECount = 0
var PNE_DE_HURT = 'ForgeEvents.onEvent:net.minecraftforge.event.entity.living.LivingHurtEvent'
var PNE_DE_SLEEP = 'ForgeEvents.onEvent:net.minecraftforge.event.entity.player.PlayerSleepInBedEvent'

function pneDE(cond, msg) {
  pneDECount++
  if (!cond) pneDEFails.push(msg)
}

function pneDEHurt(victim, attacker, amount, direct) {
  var e = { amount: amount, sets: 0 }
  var src = __pneMock.damage(direct ? 'arrow' : 'mob', attacker, direct || attacker)
  e.getEntity = function () { return victim }
  e.getSource = function () { return src }
  e.getAmount = function () { return e.amount }
  e.setAmount = function (a) { e.sets++; e.amount = Number(a) }
  __pneMock.fire(PNE_DE_HURT, e)
  return e
}

function pneDEHordeFn() {
  var i
  var l
  for (i = 0; i < __pneDEnv.listeners.length; i++) {
    l = __pneDEnv.listeners[i]
    if (l.cls && l.cls.__cls === 'net.smileycorp.hordes.common.event.HordeBuildSpawnDataEvent') return l
  }
  return null
}

// A HordeBuildSpawnDataEvent for the player of schedule model M (default: a fresh schedule at its first scheduled
// start, day 7 at 18000), fired at the registered listener.
function pneDEHorde(amount, M0) {
  var d = { n: amount, sets: 0 }
  var e = { canceled: false, d: d }
  var l = pneDEHordeFn()
  var M = M0 || pneDEHordes()
  if (!M0) M.t = 7 * 24000 + 18000
  d.getSpawnAmount = function () { return d.n }
  d.setSpawnAmount = function (v) { d.sets++; d.n = Number(v) }
  e.getSpawnData = function () { return d }
  e.setCanceled = function (b) { e.canceled = b ? true : false }
  e.getHorde = function () { return M.horde }
  e.getPlayer = function () { return M.player }
  e.getDay = function () { return Math.floor(M.t / 24000) }
  e.getEntityWorld = function () { return M.level }
  e.M = M
  if (l) l.fn(e)
  return e
}

// A model of one player's schedule in The Hordes 1.6.3i under the pack's hordes-common.toml (dayLength 24000,
// hordeStartTime 18000, hordeStartBuffer 1200, hordeSpawnDuration 6000, hordeSpawnDays 7, hordeSpawnVariation 0,
// spawnFirstDay false, hordeEventByPlayerTime false), from javap of HordeEvent, HordeEventHandler and HordeSavedData:
//   * new HordeEvent: nextDay 7, day 0;
//   * HordeEventHandler.playerTick: while the horde is active it only counts down (stopEvent clears spawnData at 0);
//     otherwise, in the start window (time of day 18000..19200) with getCurrentDay >= nextDay and day > 0, it calls
//     tryStartEvent;
//   * tryStartEvent: when spawnData is null it posts HordeBuildSpawnDataEvent and returns if that is cancelled (before
//     setNextDay); else the horde runs 6000 ticks, day = nextDay, nextDay = HordeSavedData.getNextDay(day) = day + 7;
//   * HordeEvent.isHordeDay, The Hordes' own bed refusal (canSleepDuringHorde = false): active, or
//     now >= (nextDay + 1) x 24000.
function pneDEHordes() {
  var M = { t: 0, nextDay: 7, day: 0, until: 0, spawnData: null, tries: 0, starts: [], dirty: 0 }
  M.player = { name: 'Ann' }
  M.data = {
    getNextDay: function (dd) { return Number(dd) + 7 },
    setDirty: function () { M.dirty++ }
  }
  M.level = { __hordeData: M.data }
  M.horde = {
    getNextDay: function () { return M.nextDay },
    setNextDay: function (v) { M.nextDay = Math.floor(Number(v)) },
    getCurrentDay: function (pl) { return Math.floor(M.t / 24000) },
    getDay: function () { return M.day }
  }
  M.active = function () { return M.t < M.until }
  M.tryStart = function () {
    var e
    M.tries++
    if (M.spawnData === null) {
      e = pneDEHorde(15, M)
      if (e.canceled) return
      M.spawnData = e.d
    }
    M.starts.push({ day: Math.floor(M.t / 24000), n: M.spawnData.n })
    M.until = M.t + 6000
    M.day = M.nextDay
    M.nextDay = M.data.getNextDay(M.day)
  }
  M.tick = function () {
    var tod = M.t % 24000
    var cd = Math.floor(M.t / 24000)
    if (M.active()) return
    M.spawnData = null
    if (tod >= 18000 && tod <= 19200 && cd >= M.nextDay && cd > 0) M.tryStart()
  }
  M.hordeDay = function () { return M.active() || M.t >= (M.nextDay + 1) * 24000 }
  // every tick of each day's start window; The Hordes' bed rule sampled at 13000 (evening), 20000 and 23000
  M.run = function (from, to, refused) {
    var dd
    var s
    for (dd = from; dd <= to; dd++) {
      M.t = dd * 24000 + 13000
      if (M.hordeDay()) refused.push(dd + '@13000')
      for (s = 18000; s <= 19200; s++) {
        M.t = dd * 24000 + s
        M.tick()
      }
      M.t = dd * 24000 + 20000
      if (M.hordeDay()) refused.push(dd + '@20000')
      M.t = dd * 24000 + 23000
      if (M.hordeDay()) refused.push(dd + '@23000')
    }
  }
  return M
}

function pneDEStarts(M) {
  var out = []
  var i
  for (i = 0; i < M.starts.length; i++) out.push(M.starts[i].day + ':' + M.starts[i].n)
  return out.join(',')
}

// Removes the key (in Rhino global is a java.util.HashMap: putting null throws a Java NullPointerException that a script
// cannot catch, so the key is removed instead; the Node harness's global has no remove(), there it is deleted).
function pneDEClear() {
  var done = false
  try {
    global.remove('pneDiffProfile')
    done = true
  } catch (e) {
    done = false
  }
  if (!done) delete global.pneDiffProfile
}

function pneDESleep(day) {
  var srv = { runCommandSilent: function (c) { return String(c) === 'time query day' ? day : 0 } }
  var player = { told: 0, getServer: function () { return srv }, setStatusMessage: function (t) { player.told++ } }
  var e = { result: null }
  e.getResultStatus = function () { return null }
  e.getEntity = function () { return player }
  e.setResult = function (r) { e.result = r }
  __pneMock.fire(PNE_DE_SLEEP, e)
  return e
}

function pneDERun() {
  var srv = __pneMock.server({ difficulty: 3 })
  var pl = __pneMock.player(srv, 'Ann', 'aaaa0000-0000-4000-8000-00000000000a', {})
  var knight = __pneMock.mob(srv, 'spore:knight')
  var zombie = __pneMock.mob(srv, 'epca:infested_zombie')
  var cow = __pneMock.mob(srv, 'minecraft:cow')
  var arrow = { type: 'minecraft:arrow', typeId: 'minecraft:arrow' }
  var e
  var i
  var p
  var l
  var ok
  var waves = [15, 19, 23, 26]
  var want
  var M
  var refused

  // --- the factor tables equal the core's binding table
  ok = true
  for (i = 0; i < 4; i++) {
    if (PNE_DIFF_SPORE_K[i] !== PNE_CORE_DIFF[i].spore || PNE_DIFF_HORDE_K[i] !== PNE_CORE_DIFF[i].horde) ok = false
  }
  pneDE(ok && PNE_DIFF_SPORE_K.length === 4 && PNE_DIFF_HORDE_K.length === 4, 'PNE_DIFF_SPORE_K / PNE_DIFF_HORDE_K equal PNE_CORE_DIFF[i].spore / .horde')
  pneDE(PNE_CORE_DIFF[0].bed === false && PNE_CORE_DIFF[1].bed && PNE_CORE_DIFF[2].bed && PNE_CORE_DIFF[3].bed, 'the bed rule is off on Peaceful only (row 18)')

  // --- registration
  l = pneDEHordeFn()
  pneDE(l !== null && l.prio === 'LOWEST' && l.rc === false && pneDiffHordeHooked === true, 'Hordes listener on EVENT_BUS at LOWEST, receiveCanceled false')
  pneDE((__pneMock.handlers[PNE_DE_HURT] || []).length === 1, 'LivingHurtEvent listener registered through ForgeEvents')

  // --- missing global: no change (release 1.4)
  pneDE(global.pneDiffProfile === undefined || global.pneDiffProfile === null, 'global.pneDiffProfile starts absent')
  e = pneDEHurt(pl, knight, 10)
  pneDE(e.amount === 10 && e.sets === 0 && pneDiffProfile() === 3, 'absent global: Spore damage untouched (profile 3)')
  e = pneDEHorde(15)
  pneDE(e.d.n === 15 && e.d.sets === 0 && e.canceled === false, 'absent global: horde untouched')

  // --- per profile
  for (p = 0; p <= 3; p++) {
    global.pneDiffProfile = p
    pneDE(typeof global.pneDiffProfile === 'object' && pneDiffProfile() === p, 'profile ' + p + ' read back from a wrapped global value')
    e = pneDEHurt(pl, knight, 10)
    want = 10 * PNE_DIFF_SPORE_K[p]
    pneDE(Math.abs(e.amount - want) < 1e-9 && e.sets === (PNE_DIFF_SPORE_K[p] === 1 ? 0 : 1), 'profile ' + p + ': Spore melee on a player x' + PNE_DIFF_SPORE_K[p] + ' (got ' + e.amount + ')')
    e = pneDEHurt(pl, knight, 8, arrow)
    pneDE(Math.abs(e.amount - 8 * PNE_DIFF_SPORE_K[p]) < 1e-9, 'profile ' + p + ': a Spore projectile (owner = causing entity) is scaled too')
    e = pneDEHurt(pl, zombie, 10)
    pneDE(e.amount === 10 && e.sets === 0, 'profile ' + p + ': EPCA damage untouched (vanilla scales it)')
    e = pneDEHurt(pl, cow, 10)
    pneDE(e.amount === 10 && e.sets === 0, 'profile ' + p + ': non-parasite damage untouched')
    e = pneDEHurt(zombie, knight, 10)
    pneDE(e.amount === 10 && e.sets === 0, 'profile ' + p + ': a mob victim is never scaled')
    e = pneDEHurt(pl, null, 10)
    pneDE(e.amount === 10 && e.sets === 0, 'profile ' + p + ': ownerless damage untouched')
    for (i = 0; i < waves.length; i++) {
      e = pneDEHorde(waves[i])
      if (p === 0) pneDE(e.canceled === true && e.d.n === waves[i], 'Peaceful cancels the horde (wave ' + waves[i] + ')')
      else if (p === 3) pneDE(e.canceled === false && e.d.sets === 0 && e.d.n === waves[i], 'Hard leaves the wave untouched (' + waves[i] + ')')
      else pneDE(e.canceled === false && e.d.n === Math.max(1, Math.floor(waves[i] * PNE_DIFF_HORDE_K[p])), 'profile ' + p + ': wave ' + waves[i] + ' -> ' + e.d.n)
    }
  }
  global.pneDiffProfile = 1
  pneDE(pneDEHorde(15).d.n === 9 && pneDEHorde(19).d.n === 11 && pneDEHorde(23).d.n === 13 && pneDEHorde(26).d.n === 15, 'Easy waves 9, 11, 13, 15 (days 7..28)')
  global.pneDiffProfile = 2
  pneDE(pneDEHorde(15).d.n === 12 && pneDEHorde(19).d.n === 15 && pneDEHorde(23).d.n === 18 && pneDEHorde(26).d.n === 20, 'Normal waves 12, 15, 18, 20 (days 7..28)')
  global.pneDiffProfile = 1
  pneDE(pneDEHorde(1).d.n === 1 && pneDEHorde(0).d.n === 1, 'a scaled wave is at least 1')
  global.pneDiffProfile = 9
  pneDE(pneDiffProfile() === 3, 'an out-of-range profile reads as 3')
  global.pneDiffProfile = 'x'
  pneDE(pneDiffProfile() === 3, 'an unreadable profile reads as 3')
  pneDEClear()
  pneDE((global.pneDiffProfile === undefined || global.pneDiffProfile === null) && pneDiffProfile() === 3, 'a removed profile reads as 3 again')

  // --- the core's mirror drives the startup listener (the real global round trip)
  srv.difficulty = 1
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneDE(Number(global.pneDiffProfile) === 1 && pneDiffProfile() === 1, 'core mirror on load: vanilla Easy -> global.pneDiffProfile 1')
  e = pneDEHurt(pl, knight, 10)
  pneDE(Math.abs(e.amount - 7) < 1e-9, 'the mirrored Easy profile scales Spore damage to x0.70')

  // --- the bed rule of pne_horde_rules.js
  pneDEClear()
  pneDE(pneDESleep(7).result !== null && pneDESleep(8).result === null, 'bed rule: day 7 refused, day 8 allowed (absent profile)')
  global.pneDiffProfile = 3
  pneDE(pneDESleep(14).result !== null, 'bed rule on Hard')
  global.pneDiffProfile = 1
  pneDE(pneDESleep(7).result !== null, 'bed rule on Easy')
  global.pneDiffProfile = 0
  pneDE(pneDESleep(7).result === null, 'bed rule skipped on Peaceful')

  // --- the Peaceful cancel against The Hordes' schedule (model from javap, see pneDEHordes)
  global.pneDiffProfile = 3
  M = pneDEHordes()
  refused = []
  M.run(1, 14, refused)
  pneDE(pneDEStarts(M) === '7:15,14:15' && M.tries === 2 && M.dirty === 0, 'model, Hard: hordes on days 7 and 14 at full size, the listener leaves the schedule alone (' + pneDEStarts(M) + ')')
  pneDE(refused.join(',') === '7@20000,7@23000,14@20000,14@23000', "model, Hard: The Hordes' own bed refusal only while a horde runs (" + refused.join(',') + ')')
  global.pneDiffProfile = 0
  M = pneDEHordes()
  refused = []
  M.run(1, 35, refused)
  pneDE(M.starts.length === 0 && M.tries === 5, 'Peaceful: one start attempt per horde day (7, 14, 21, 28, 35) and no horde (attempts ' + M.tries + ')')
  pneDE(refused.length === 0, "Peaceful: The Hordes' own bed rule never refuses on days 1-35 (refused " + refused.slice(0, 6).join(',') + ')')
  pneDE(M.nextDay === 42 && M.day === 0 && M.dirty === 5, 'Peaceful: each skipped horde moves the schedule 7 days on (next 42), marks the saved data dirty, and does not count toward the size (day ' +
    M.day + ', next ' + M.nextDay + ', dirty ' + M.dirty + ')')
  global.pneDiffProfile = 1
  M.run(36, 49, refused)
  pneDE(pneDEStarts(M) === '42:9,49:9', 'after Peaceful: no catch-up, the next horde is day 42, at the Easy size x0.6 (' + pneDEStarts(M) + ')')
  pneDE(refused.join(',') === '42@20000,42@23000,49@20000,49@23000', "after Peaceful: The Hordes' bed rule is back for running hordes only (" + refused.join(',') + ')')
  global.pneDiffProfile = 0
  M = pneDEHordes()
  M.t = 3 * 24000 + 5000
  e = pneDEHorde(15, M)
  pneDE(e.canceled === true && M.nextDay === 7 && M.dirty === 0, 'Peaceful, /hordes spawnWave on day 3: cancelled, a schedule that is not due is left alone')
  M = pneDEHordes()
  M.t = 30 * 24000 + 18000
  e = pneDEHorde(15, M)
  pneDE(e.canceled === true && M.nextDay === 35 && M.dirty === 1, 'Peaceful, a horde overdue since day 7 on day 30: the schedule jumps past today (35)')
  M = pneDEHordes()
  M.level = {}
  M.t = 7 * 24000 + 18000
  e = pneDEHorde(15, M)
  pneDE(e.canceled === true && M.nextDay === 14 && M.dirty === 0, 'Peaceful without The Hordes saved data: the configured 7-day step')
  M = pneDEHordes()
  M.horde.getCurrentDay = function () { throw new Error('mock: no getCurrentDay') }
  M.t = 14 * 24000 + 18000
  M.nextDay = 14
  e = pneDEHorde(15, M)
  pneDE(e.canceled === true && M.nextDay === 21, 'Peaceful: getCurrentDay unreadable, the event day is used')
  pneDE(pneDiffHordeEmptyWarned === false, 'no fallback warning so far')
  M = pneDEHordes()
  M.horde.setNextDay = function (v) { }
  M.t = 7 * 24000 + 18000
  e = pneDEHorde(15, M)
  pneDE(e.canceled === false && e.d.n === 0 && e.d.sets === 1 && M.nextDay === 7 && pneDiffHordeEmptyWarned === true,
    'Peaceful, a schedule that does not take the new day: not cancelled, an empty wave instead (The Hordes moves on itself), one warning')
  e = pneDEHorde(15, M)
  pneDE(e.canceled === false && e.d.n === 0, 'and again on the next attempt')
  M = pneDEHordes()
  M.horde = null
  M.t = 7 * 24000 + 18000
  e = pneDEHorde(15, M)
  pneDE(e.canceled === false && e.d.n === 0, 'Peaceful, no HordeEvent on the event: an empty wave')
  pneDE(pneDiffB.horde.n === 0 && pneDiffB.horde.off === false, 'the fallbacks are not listener errors')

  // --- the per-listener breaker
  global.pneDiffProfile = 1
  for (i = 0; i < 25; i++) {
    e = { getEntity: function () { throw new Error('mock: broken event') } }
    __pneMock.fire(PNE_DE_HURT, e)
  }
  pneDE(pneDiffB.spore.off === true && pneDiffB.spore.n === 20 && pneDiffB.horde.off === false, 'the Spore listener stops after 20 errors; the horde listener keeps running')
  e = pneDEHurt(pl, knight, 10)
  pneDE(e.amount === 10, 'a stopped listener leaves damage unscaled')
  pneDE(pneDEHorde(15).d.n === 9, 'the horde listener still works')
}

var pneDiffEvResult = 'FAIL not run'
try {
  pneDERun()
  pneDiffEvResult = pneDEFails.length ? 'FAIL ' + pneDEFails.length + '/' + pneDECount + ': ' + pneDEFails.join(' | ') : 'PASS diff-events ' + pneDECount + ' checks'
} catch (err) {
  pneDiffEvResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '') + ' after ' + pneDECount + ' checks'
}
