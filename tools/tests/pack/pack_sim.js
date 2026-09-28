// Pack smoke test driver (control scope). ES5; every var at the top of its function (the Rhino fork scopes var to
// its block, F26). Result: pnePackMain(variants, mode) returns 'PASS ...' or 'FAIL ...'.
//
// Each variant is one game launch: a new startup scope (startup scripts), then a server scope with ALL server scripts
// of overrides/kubejs/server_scripts in KubeJS load order (priority header, highest first; ties by file name), one
// shared global HashMap, and the world of pack_world.js. The simulation drives the events the game would fire:
// logins, natural spawns through the startup PositionCheck gate, EntityJoinLevelEvent (fresh or loaded from disk),
// KubeJS spawned/hurt/death, LivingHurt/LivingDamage/EntityLeaveLevel for the startup listeners, respawns (new player
// objects, tags and persistent data copied), chunk reloads, conversions, torches, a Hive Night (The Hordes' start
// and end events and fresh horde waves), dawns, /reload (new server scope, same world and global) and a world
// restart (ServerEvents.unloaded, a saved copy of every persistent data, a new server object and scope).
//
// Variants: 'full' (2 in-game days and a bit, with /reload and a restart), the degradation matrix of contract 8 (one
// new file removed at a time: no-core, no-ga-core, no-hive, no-hive-events, no-director, no-gate, no-oracle,
// no-catalog, no-visual; and "broken" modules whose API throws until the core's API breaker trips: broken-director
// (pneResEmit and pneResPace throw), broken-hive (pneHiveInfo and pneHiveNear throw)) and the pillar switches of
// contract 6.2 (off-resonance, off-hive, off-oracle, off-visual: switched off through /pne as an operator, and back on
// near the end). With --strict the world answers only to the names KubeJS leaves visible in game (F37); otherwise the
// shared mocks also answer to the Mojang names (__pneMock.opts.mojangNames).
//
// Invariants, checked in every variant (a violation fails the suite):
//   * no uncaught handler exception, no module breaker failure (pneCoreFail), no failure line from the startup
//     listeners, no load error;
//   * no NaN in any module's top-level state, no NaN/Infinity in persistent data or in an issued command, every NBT
//     string within 65,535 bytes (pne_hive strings under 60,000);
//   * the token budget: at most 2.5 ms charged in any tick (pneCoreSpentMs), never a negative remainder;
//   * comfort (I8): no nausea/blindness/darkness/confusion given, no effect given to a player, no tp/teleport/
//     spreadplayers/ride aimed at a player; comfort players get no stinger (L7 spike, the Hive Night scream) and no
//     Resonance asset the catalog marks not comfort-safe; no Resonance sound while the pillar is off; the per-player
//     switches hold (pne_res_off, pne_res_no_whispers);
//   * mercy/grace (I3, TDD 2.5.5): no scripted parasite summon within 48 blocks of a player in mercy (health <= 30%)
//     or live grace; no natural spawn allowed there while the startup gate is loaded; fresh horde mobs near a player in
//     mercy are discarded by the hive backstop while the hive runs; the gate/backstop degradations of contract 8 are
//     checked as documented (for example no-gate: the backstop still discards natural spawns there);
//   * fairness: a Silent parasite may spend at most 120 ticks (summed over its life) within 12 blocks of a survival
//     player while nothing can play its tell (hive, GA core, director, catalog and both pillars needed);
//   * persistence: across the restart the GA state is identical (hash, generation, pool size, governor);
//   * per-variant expectations from contract 8 and 6.2 (psExpect / psPillarChecks), for example: no genome without the
//     GA core, the core unsilences a saved silent mob without the hive, probe sensing without the Oracle, no
//     Resonance sound without the director or the catalog, at most one telemetry.json after /pne oracle off, no graft
//     left 400 ticks after /pne visual off, conversions linked to their carriers (pne_gp) in the full run; without the
//     startup listener no backstop discard and no projectile scaling (and scaling seen in the full run); without the
//     hive runtime (no-hive, no-ga-core) global.pneOnHive stays 0 and the startup queues stay empty; broken modules
//     trip the core's API breaker and the core fallbacks take over (comfort players get no stinger, the ledger-off
//     warning, pacing spawn 0 / GA 0 under mercy, no tell so Silent is dropped; the hive fallbacks clade -1 and no
//     HiveInfo).
//   * contract 1.5, the Recruits-safe start (spec D, pack_world.js): (a) no command before the start's loaded dispatch
//     has finished nor before the core's first tick, (b) the 8 clade teams right at tick 200 after the start and the
//     restart, (c) no console team command and no pne_ Recruits faction, (d) every live clade host VISUAL tracks on the
//     team its clade and name want (not only the one VISUAL recorded), (e) the hive seed read after the start; in every
//     variant with a restart ('full', 'diff-1-restart') the hive loads on its first tick after the restart, never inside
//     ServerEvents.loaded (3.7), and the GA state it loads equals the one saved;
//   * contract 1.5, the difficulty profiles, checked in every variant: global.pneDiffProfile and pneCoreDiffId() follow
//     the vanilla difficulty within 2 s of a change; EPCA tier writes are exactly the ones the profile schedule needs
//     (overworld Expert -> Normal on Easy/Peaceful and back on Normal/Hard; nothing on Hard; nothing without EPCA's
//     classes); one gray notice per change and one login line per player; every Spore hit on a player is scaled by the
//     profile's factor (0.5 / 0.70 / 1 / 1) and every other hit is not; The Hordes' HordeBuildSpawnDataEvent (fired
//     at the Hive Night start) keeps 15 on Hard untouched, gives 12 on Normal and 9 on Easy, and on Peaceful is
//     cancelled with the player's schedule moved past today (then no horde runs); /pne status, /pne hive status and
//     /pne difficulty show the profile (line 4: 'doom clock: no raises' on Peaceful, else 'doom clock as Hard' with the
//     next floor day once pne_horror.js has pneHDoomNext); on Peaceful no hive gene modifier is expressed and no natural spawn gets
//     through within 48 blocks of a survival player once the director has written pne_m; nothing in the scenario picks
//     an EPCA tier outside the pack, so no dimension is ever marked deliberate (no x.<dim> in pne_diff, no "chosen
//     outside the pack" warning).
// Difficulty runs ('difficulty', suites pack-difficulty and pack-difficulty-strict): vanilla Peaceful, Easy, Normal and
// Hard (diff-0 .. diff-3), a mid-run Easy -> Hard -> Easy switch (diff-switch) and Easy across a /reload at t 6000 and a
// world restart at t 9000 (diff-1-restart: pne_diff.w.<dim> and pne_diff_seen survive, so exactly one EPCA write, no
// notice and one login line per player in the whole run). The matrix adds two rows of 1.5:
// no-epca (EPCA's tier classes absent, on Easy) and no-diff-events (startup_scripts/pne_diff_events.js removed, on Easy:
// Spore damage and waves unscaled, everything else follows the profile).
// The dev variant 'quick' (3500 ticks, run only when named) also prints the /pne status lines and every live mob.

var PS_SERVER_DIR = 'overrides/kubejs/server_scripts'
var PS_STARTUP_DIR = 'overrides/kubejs/startup_scripts'
var PS_ENV = ['tools/tests/kjs_mocks.js', 'tools/tests/pack/pack_env.js']
var PS_EPCA = ['epca:ripper', 'epca:infested_zombie', 'epca:infested_villager', 'epca:curbug', 'epca:infested_cow',
  'epca:mozzie', 'epca:small_incomplete_form', 'epca:infested_skeleton', 'epca:reshape_longarms']
var PS_SPORE = ['spore:inf_human', 'spore:knight', 'spore:spitter', 'spore:inf_villager', 'spore:slasher', 'spore:leaper']
var PS_HORDE = ['epca:infested_zombie', 'epca:ripper', 'spore:inf_human', 'spore:knight']
var PS_STINGERS = /^(epca:infested_enderman_scream|pne:res\.spike\.)/
var PS_BAD_EFFECT = /(nausea|blindness|darkness|confusion)/
// Deliberate NaN sentinels (read only through isFinite): VISUAL's host record yaw means "graft not synced yet"
// (pne_visual.js pneVisYawSync: if (isFinite(r.yaw) && ...)).
var PS_NAN_SENTINEL = /^pneVisHosts\.[0-9a-f-]+\.yaw$/
// Contract 1.5 table A, typed from the spec (not read from the scripts): row 16 Spore-to-player damage, row 17 the wave
// size of a 15-mob Hordes wave (Peaceful: cancelled), the hive's budget factor (row 10) and the profile names.
var PS_SPORE_K = [0.5, 0.70, 1.0, 1.0]
var PS_HORDE_15 = [-1, 9, 12, 15]
var PS_GENES = ['0.00', '0.65', '0.85', '1.00']
var PS_DIFF_NAMES = ['Peaceful', 'Easy', 'Normal', 'Hard']
var PS_DIFF_DIMS = ['minecraft:overworld', 'minecraft:the_nether', 'minecraft:the_end']
var PS_HORDE_BUILD = 'ForgeEvents.onEvent:net.smileycorp.hordes.common.event.HordeBuildSpawnDataEvent'
var PS_GENE_UUID = /^706e6500-4869-7665-/

var PS = null
var PS_CTL = this

function psNew(v) {
  return {
    v: v, t: 0, fails: [], failN: 0, notes: [], ms: [], maxCharged: 0, sounds: 0, resSounds: 0, tells: 0,
    natAllowed: 0, natDenied: 0, natVulnAllowed: 0, hordeSpawned: 0, hordeWatch: [], natWatch: [], backstopOk: 0,
    backstopMissed: 0, summons: 0, deathsMob: 0, deathsPlayer: 0, silentSince: {}, gaBefore: null, reloads: 0,
    restart: false, cmds: {}, probeCmds: 0, effectsOnPlayers: 0, dispatcher: null, offAt: -1, onAt: -1, seenTeams: 0,
    oraWritesAfterOff: -1, logN: 0, conv: 0, resAfterOff: 0, watched: 0, graftsMax: 0, graftsBeforeOff: 0,
    prjHits: 0, prjScaled: 0, brokenCalls: 0, brokenFails: 0, tripAt: -1, tellsAtTrip: 0, packSoundsAtTrip: 0,
    packSounds: 0, paceChecks: 0, hiveFallbackChecks: 0,
    gaAtLoaded: null, gaAfter: null, diffNotices: 0, diffLogins: {}, sporeHits: 0, sporeScaled: 0, otherHits: 0,
    hordeBuilds: 0, hordeCancelled: 0, hordeAmounts: [], natNearAllowed: 0, diffChecks: 0
  }
}

function psFail(msg) {
  PS.failN++
  if (PS.fails.length < 60) PS.fails.push('[' + PS.v.name + ' t=' + PS.t + '] ' + msg)
}

function psNote(msg) {
  if (PS.notes.length < 40) PS.notes.push(msg)
}

// ---------------------------------------------------------------------------------------------
// Loading

function psHas(list, x) {
  return list.indexOf(x) >= 0
}

function psFiles(dir, drop) {
  var raw = String(__pack.list(dir))
  var names = raw.length ? raw.split('\n') : []
  var out = []
  var i
  var rel
  for (i = 0; i < names.length; i++) {
    // '<folder>/<file>' whatever the root (overrides/kubejs or a --root scratch copy), so the drop lists apply to both
    rel = /(server|startup|client)_scripts\/[^\/]+$/.exec(String(names[i]).replace(/\\/g, '/'))
    rel = rel ? rel[0] : String(names[i])
    if (psHas(drop, rel)) continue
    out.push({ path: names[i], rel: rel, prio: Number(__pack.priority(names[i])), idx: i })
  }
  // KubeJS: ScriptFile.compareTo = Integer.compare(other.priority, this.priority), stable
  out.sort(function (a, b) {
    if (a.prio !== b.prio) return b.prio - a.prio
    return a.idx - b.idx
  })
  return out
}

function psScope(kind) {
  var s = __pack.newScope()
  var i
  s.__world = PS_CTL
  s.__pneEnvKind = kind
  for (i = 0; i < PS_ENV.length; i++) __pack.load(s, PS_ENV[i])
  s.Math.random = PW.rand
  return s
}

function psLoadAll(scope, files) {
  var i
  for (i = 0; i < files.length; i++) {
    try {
      __pack.load(scope, files[i].path)
    } catch (err) {
      psFail('load error in ' + files[i].rel + ': ' + err)
    }
  }
}

function psLoadStartup(drop) {
  PW.startup = psScope('startup')
  psLoadAll(PW.startup, psFiles(PS_STARTUP_DIR, drop))
}

function psLoadServer(drop) {
  var sc = psScope('server')
  var f0
  PW.server = sc
  psLoadAll(sc, psFiles(PS_SERVER_DIR, drop))
  if (typeof sc.pneCoreFail === 'function') {
    f0 = sc.pneCoreFail
    sc.pneCoreFail = function (b, err) {
      // a broken variant's own injected fault (and what it causes) is expected; anything else fails the suite
      if (PS.v.broken && String(err).indexOf('pne-broken') >= 0) PS.brokenFails++
      else psFail('module failure (' + (b ? b.name : '?') + '): ' + err)
      return f0(b, err)
    }
  }
  if (PS.v.broken) psBreak(sc, PS.v.broken)
  psRegisterCommands()
}

// "Broken" (contract 8): the module loaded, but its API throws on every call, until the core's API breaker for that
// pillar trips (20 errors) and the core wrappers answer with their fallbacks, as if the module were absent.
function psBreak(sc, which) {
  var msg = 'pne-broken test fault: the ' + which + ' API throws'
  function thrower() {
    PS.brokenCalls++
    throw new Error(msg)
  }
  if (which === 'director') {
    sc.pneResEmit = thrower
    sc.pneResPace = thrower
  } else if (which === 'hive') {
    sc.pneHiveInfo = thrower
    sc.pneHiveNear = thrower
  }
}

function psBrokenPillar() {
  if (PS.v.broken === 'director') return 'resonance'
  if (PS.v.broken === 'hive') return 'hive'
  return ''
}

function psTripped() {
  var pl = psBrokenPillar()
  return pl !== '' && psCoreLoaded() && PW.server.PNE_CORE_B_API[pl].off === true
}

function psRegisterCommands() {
  var disp
  var ev
  if (typeof __brig === 'undefined') {
    PS.dispatcher = null
    return
  }
  disp = __brig.dispatcher()
  ev = {
    commands: { literal: function (n) { return __brig.literal(n) }, argument: function (n, t) { return __brig.argument(n, t) } },
    arguments: { GREEDY_STRING: { create: function (e) { return __brig.greedy() }, getResult: function (c, n) { return __brig.getString(c, n) } } },
    register: function (b) { return disp.register(b) },
    server: PW.srv
  }
  PS.dispatcher = disp
  __pneMock.fire('ServerEvents.commandRegistry', ev)
}

// Runs a /pne command through real Brigadier (as the player, or the console when player is null).
function psCmd(input, player, level) {
  var src = __pneMock.source(PW.srv, player || null, level || 0)
  var r
  var before = PW.logs.length
  if (!PS.dispatcher) return -9
  r = Number(__brig.execute(PS.dispatcher, input, src))
  PS.cmds[input] = r
  return r
}

// ---------------------------------------------------------------------------------------------
// Invariant hooks (called by the world)

function psVulnerable(p) {
  var until = 0
  var now = PW.srv.gameTime
  if (p.removed || p.dead) return false
  if (p.hp <= 0.3 * p.maxHp) return true
  if (!p.tagSet.hasOwnProperty('pne_grace')) return false
  try { until = Number(p.persistentData.getLong('pne_grace_until')) } catch (e) { until = 0 }
  return until > now && until - now <= 2400
}

function psVulnNear(level, x, y, z) {
  var i
  var p
  var dx
  var dy
  var dz
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.removed || p.creative || p.spectator || p.level !== level) continue
    dx = p.x - x
    dy = p.y - y
    dz = p.z - z
    if (dx * dx + dy * dy + dz * dz <= 48 * 48 && psVulnerable(p)) return p
  }
  return null
}

function psSurvivorNear(level, x, y, z, r) {
  var i
  var p
  var dx
  var dy
  var dz
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.removed || p.dead || p.creative || p.spectator || p.level !== level) continue
    dx = p.x - x
    dy = p.y - y
    dz = p.z - z
    if (dx * dx + dy * dy + dz * dz <= r * r) return true
  }
  return false
}

function psCoreLoaded() {
  return PW.server && typeof PW.server.PNE_CORE_API === 'number'
}

function psOn(pillar) {
  return psCoreLoaded() && PW.server.pneCoreOn(pillar) === true
}

function psInstallHooks() {
  PW.onCommand = function (c, r) {
    var m
    if (/NaN|undefined|Infinity/.test(c)) psFail('command carries NaN/undefined/Infinity: ' + c.substring(0, 160))
    if (/^execute as \S+ at @s if entity @e\[type=#pne:/.test(c)) PS.probeCmds++
    // the core's difficulty chat (contract 1.5): the mid-game notice goes to @a, the login line to one player
    if (c.indexOf('tellraw ') === 0 && c.indexOf('[PNE] Difficulty') > 0) {
      m = /^tellraw (\S+) /.exec(c)
      if (c.indexOf('[PNE] Difficulty is now ') > 0) {
        PS.diffNotices++
        if (!m || m[1] !== '@a') psFail('the difficulty notice is not sent to @a: ' + c.substring(0, 120))
      } else if (m) {
        PS.diffLogins[m[1]] = (PS.diffLogins[m[1]] || 0) + 1
      }
    }
  }
  PW.onEffect = function (kind, targets, effect, c) {
    var i
    if (kind !== 'give') return
    if (PS_BAD_EFFECT.test(effect) || PS_BAD_EFFECT.test(c)) psFail('screen effect given: ' + c)
    for (i = 0; i < targets.length; i++) {
      if (targets[i].typeId === 'minecraft:player') {
        PS.effectsOnPlayers++
        psFail('effect given to a player: ' + c)
        return
      }
    }
  }
  PW.onSummon = function (id, x, y, z, ctx) {
    var p
    if (!PW.isParasiteId(id)) return
    PS.summons++
    if (!psCoreLoaded()) return
    p = psVulnNear(ctx.level, x, y, z)
    if (p) psFail('scripted ' + id + ' summoned within 48 blocks of ' + p.name + ' in mercy/grace (hp ' + p.hp + ')')
  }
  PW.onSound = function (target, ev, cat, vol, ctx) {
    var comfort
    var info
    var e = String(ev)
    PS.sounds++
    if (target.typeId !== 'minecraft:player') return
    comfort = !target.tagSet.hasOwnProperty('pne_comfort_off')
    if (comfort && PS_STINGERS.test(e)) psFail('stinger ' + e + ' played to comfort player ' + target.name)
    if (e.indexOf('pne:res.') !== 0) {
      PS.packSounds++
      return
    }
    if (PS.v.broken === 'hive' && PS.tripAt >= 0 && /^pne:res\.whisper\.\w+_c[0-3]\./.test(e)) {
      psFail('clade whisper ' + e + ' after the hive API was cut off (the core must answer clade -1)')
    }
    PS.resSounds++
    if (e.indexOf('pne:res.tell.') === 0) PS.tells++
    if (psCoreLoaded() && !psOn('resonance')) {
      PS.resAfterOff++
      psFail('Resonance sound ' + e + ' with the resonance pillar off')
    }
    if (target.tagSet.hasOwnProperty('pne_res_off') && e.indexOf('pne:res.tell.') !== 0) psFail('Resonance sound ' + e + ' to a player with pne_res_off')
    if (target.tagSet.hasOwnProperty('pne_res_no_whispers') && e.indexOf('pne:res.whisper.') === 0) psFail('whisper ' + e + ' to a player with whispers off')
    info = (typeof PW.server.PNE_RES_CATALOG === 'object' && PW.server.PNE_RES_CATALOG.events) ? PW.server.PNE_RES_CATALOG.events[e] : undefined
    if (!info) {
      psFail('Resonance event not in the catalog: ' + e)
      return
    }
    if (comfort && info.comfort !== true) psFail('non-comfort Resonance asset ' + e + ' played to comfort player ' + target.name)
    if (info.amb === true) psFail('AmbientSounds bed ' + e + ' issued by /playsound')
  }
}

// ---------------------------------------------------------------------------------------------
// The world's per-tick life

function psNearestPlayer(m, r) {
  var best = null
  var bd = r * r
  var i
  var p
  var dx
  var dz
  var d
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.removed || p.dead || p.creative || p.level !== m.level) continue
    if (p.safeUntil && p.safeUntil > PW.srv.tickCount) continue
    dx = p.x - m.x
    dz = p.z - m.z
    d = dx * dx + dz * dz
    if (d < bd) {
      bd = d
      best = p
    }
  }
  return best
}

function psDist(a, b) {
  var dx = a.x - b.x
  var dy = a.y - b.y
  var dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function psAttrValue(e, id, dflt) {
  var inst = null
  try { inst = e.getAttribute(id) } catch (err) { inst = null }
  if (!inst) return dflt
  return Number(inst.getValue())
}

function psMobs() {
  var ms = PW.mobs()
  var out = []
  var i
  for (i = 0; i < ms.length; i++) {
    if (PW.isParasiteId(ms[i].typeId) && !ms[i].dead) out.push(ms[i])
  }
  return out
}

function psMobStep(t) {
  var ms = psMobs()
  var i
  var m
  var p
  var d
  var sp
  var dmg
  for (i = 0; i < ms.length; i++) {
    m = ms[i]
    if (m.target && (m.target.removed || m.target.dead || psDist(m, m.target) > 32 || (m.target.safeUntil && m.target.safeUntil > t))) m.target = null
    if (!m.target && (t + i) % 10 === 0) {
      m.target = psNearestPlayer(m, 20)
      // a third of the mobs stalk first: they hold 6-10 blocks off for 300 ticks before they close in
      if (m.target && PW.rand() < 0.34) m.stalkUntil = t + 300
    }
    p = m.target
    if (!p) {
      // drift toward the nearest player within 72 blocks (mobs sense players from afar)
      if ((t + i) % 4 === 0) {
        p = psNearestPlayer(m, 72)
        if (p) {
          d = psDist(m, p)
          if (d > 1) {
            m.x += (p.x - m.x) / d * 0.2
            m.z += (p.z - m.z) / d * 0.2
          }
        }
      }
      continue
    }
    d = psDist(m, p)
    if (m.stalkUntil && m.stalkUntil > t) {
      if (d > 10) {
        m.x += (p.x - m.x) / d * 0.1
        m.z += (p.z - m.z) / d * 0.1
      } else if (d < 6 && d > 0) {
        m.x -= (p.x - m.x) / d * 0.1
        m.z -= (p.z - m.z) / d * 0.1
      }
      continue
    }
    if (d > 1.5) {
      sp = Math.min(0.15, psAttrValue(m, 'generic.movement_speed', 0.25) * 0.5)
      m.x += (p.x - m.x) / d * sp
      m.z += (p.z - m.z) / d * sp
    } else if ((t + i) % 20 === 0 && !(p.hitsAt === Math.floor(t / 20) && p.hits >= 1)) {
      // at most one blow per player per second, so deaths stay a few per in-game day
      if (p.hitsAt !== Math.floor(t / 20)) {
        p.hitsAt = Math.floor(t / 20)
        p.hits = 0
      }
      p.hits++
      dmg = Math.min(1.5, psAttrValue(m, 'generic.attack_damage', 3) * 0.2)
      psHurtPlayer(p, dmg, m)
    }
  }
}

function psHurtPlayer(p, dmg, m) {
  var done
  var spore
  var k
  if (p.dead || p.removed) return
  // contract 1.5 row 16 (startup_scripts/pne_diff_events.js, LivingHurtEvent): a Spore mob's hit on a player lands at
  // x0.5 / x0.70 / x1 / x1 for the profile the core mirrored into the shared global; every other hit is unscaled
  spore = !!(m && String(m.typeId).indexOf('spore:') === 0)
  k = (spore && PS.v.diffEv) ? PS_SPORE_K[psGlobalProfile()] : 1
  done = PW.hurt(p, dmg, PW.source('mob', m, m))
  if (m && done > 0) {
    if (Math.abs(done - dmg * k) > 1e-9) {
      psFail((spore ? 'Spore' : 'non-Spore') + ' hit of ' + dmg + ' on ' + p.name + ' by ' + m.typeId + ' landed as ' + done + ' (want x' + k +
        ', profile ' + psGlobalProfile() + (PS.v.diffEv ? '' : ', pne_diff_events.js absent') + ')')
    }
    if (spore) {
      PS.sporeHits++
      if (k < 1) PS.sporeScaled++
    } else {
      PS.otherHits++
    }
  }
  if (p.hp <= 0 && !p.dead) {
    PS.deathsPlayer++
    PW.killPlayer(p, PW.source('mob', m, m))
  }
  return done
}

function psPlayerStep(t) {
  var i
  var p
  var ms
  var j
  var best
  var bd
  var d
  var src
  var arrow
  var prj
  var dealt
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.removed || p.dead || p.creative) continue
    if (t % 20 === 0 && p.hp < p.maxHp && !(p.forceMercyUntil && p.forceMercyUntil > t)) p.hp = Math.min(p.maxHp, p.hp + 1)
    if ((t + i * 7) % 20 !== 0) continue
    ms = psMobs()
    best = null
    bd = 5
    for (j = 0; j < ms.length; j++) {
      d = psDist(ms[j], p)
      if (d < bd) {
        bd = d
        best = ms[j]
      }
    }
    if (!best) continue
    if (PW.rand() < 0.3) {
      arrow = { typeId: 'minecraft:arrow', type: 'minecraft:arrow' }
      src = PW.source('arrow', p, arrow)
    } else {
      src = PW.source('player', p, p)
      arrow = null
    }
    prj = Number(best.persistentData.getInt('pne_prj'))
    dealt = PW.hurt(best, 9, src)
    // projectile scaling (contract 3.3, pne_hive_events.js LivingHurtEvent): a PRJ mob takes less from an arrow
    if (arrow && prj > 0 && dealt > 0) {
      PS.prjHits++
      if (dealt < 9 - 1e-9) PS.prjScaled++
    }
    if (best.hp <= 0) {
      PS.deathsMob++
      PW.killMob(best, src)
    }
  }
}

function psSpawnAround(p, idList, fresh, tags, gate, rmin, rmax) {
  var a = PW.rand() * 6.283185307179586   // Math.PI is undefined in this Rhino fork (F26)
  var r = (rmin || 20) + PW.rand() * ((rmax || 70) - (rmin || 20))
  var x = p.x + Math.cos(a) * r
  var z = p.z + Math.sin(a) * r
  var id = idList[Math.floor(PW.rand() * idList.length)]
  var e
  var ev
  var vuln
  var i
  if (!gate) return PW.spawnMob(id, x, 64, z, !fresh, tags)
  e = __pneMock.mob(PW.srv, id, { x: x, y: 64, z: z, hp: 20, maxHp: 20 })
  ev = { result: 'DEFAULT' }
  ev.getEntity = function () { return e }
  ev.getLevel = function () { return { getLevel: function () { return p.level } } }
  ev.getX = function () { return x }
  ev.getY = function () { return 64 }
  ev.getZ = function () { return z }
  ev.setResult = function (res) { ev.result = res }
  ev.getResult = function () { return ev.result }
  __pneMock.fire('ForgeEvents.onEvent:net.minecraftforge.event.entity.living.MobSpawnEvent$PositionCheck', ev)
  vuln = psVulnNear(p.level, x, 64, z)
  if (String(ev.result) === 'DENY') {
    PS.natDenied++
    e.removed = true
    e.removalReason = 'NEVER'
    return null
  }
  PS.natAllowed++
  // Peaceful (contract 1.5): the director's spawn multiplier is 0 in every state, so pne_m 0 and the gate denies every
  // natural parasite spawn within 48 blocks of a survival player once pne_m has been written (a 200-tick warm-up)
  if (psDiffWant(PS.v, PS.t) === 0 && PS.t >= 200 && psSurvivorNear(p.level, x, 64, z, 48)) PS.natNearAllowed++
  if (vuln) {
    PS.natVulnAllowed++
    if (PS.v.gate && !(PW.srv.persistentData.contains('pne_cfg_spawn_gate') && PW.srv.persistentData.getInt('pne_cfg_spawn_gate') === 0)) {
      psFail('natural ' + id + ' spawn allowed within 48 blocks of ' + vuln.name + ' in mercy/grace (gate loaded)')
    }
  }
  e.bornTick = PW.srv.tickCount
  if (!PW.join(e, false)) return null
  if (vuln) {
    PS.natWatch.push({ e: e, at: PW.srv.tickCount, who: vuln.name })
    PS.watched++
  }
  for (i = 0; i < (tags || []).length; i++) e.addTag(tags[i])
  return e
}

function psNearCount(p, r) {
  var ms = psMobs()
  var n = 0
  var i
  for (i = 0; i < ms.length; i++) {
    if (psDist(ms[i], p) <= r) n++
  }
  return n
}

function psNaturalSpawns(t) {
  var i
  var p
  var ids
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.removed || p.dead || p.creative) continue
    if (psNearCount(p, 72) >= 9) continue
    ids = PW.rand() < 0.6 ? PS_EPCA : PS_SPORE
    if (PW.rand() < 0.02) ids = ['spore:nuke']
    psSpawnAround(p, ids, true, null, true)
  }
}

function psHordeWave() {
  var i
  var j
  var p
  var e
  var vuln
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.removed || p.dead || p.creative) continue
    for (j = 0; j < 4; j++) {
      e = psSpawnAround(p, PS_HORDE, true, ['pne_horde_mob'], false, 16, 32)
      if (!e) continue
      PS.hordeSpawned++
      vuln = psVulnNear(e.level, e.x, e.y, e.z)
      if (vuln) {
        PS.hordeWatch.push({ e: e, at: PW.srv.tickCount, who: vuln.name })
        PS.watched++
      }
    }
  }
}

// Returns how many players' hordes started (start) or ended. At the start The Hordes first posts
// HordeBuildSpawnDataEvent for the player (once per horde, HordeEvent.tryStartEvent); a cancelled one means no horde.
function psHordeEvent(start) {
  var i
  var p
  var ev
  var n = 0
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.removed || p.creative) continue
    if (start && !psHordeBuild(p)) continue
    ev = { getPlayer: function () { return p }, isCanceled: function () { return false } }
    if (start) __pneMock.fire('ForgeEvents.onEvent:net.smileycorp.hordes.common.event.HordeStartWaveEvent', ev)
    else __pneMock.fire('ForgeEvents.onEvent:net.smileycorp.hordes.common.event.HordeEndEvent', ev)
    n++
  }
  return n
}

// The Hordes' HordeBuildSpawnDataEvent for one player (contract 1.5 row 17, startup_scripts/pne_diff_events.js at
// LOWEST): a 15-mob wave on an overdue schedule (nextDay = today). Hard: untouched (setSpawnAmount never called, L5);
// Normal 12, Easy 9 (max(1, floor(15 x k))); Peaceful: cancelled, and the player's nextDay moved past today first (a
// cancel alone leaves the horde overdue: HordeEvent.tryStartEvent returns before setNextDay). Without the startup file
// every profile keeps 15. HordeSavedData is not modelled, so the listener takes its fallback step (7 days). Returns
// false when the horde is cancelled.
function psHordeBuild(p) {
  var day = Math.floor(PW.srv.dayTime / 24000)
  var horde = { next: day }
  var data = { amount: 15, sets: 0 }
  var ev = { canceled: false }
  var prof = psGlobalProfile()
  var want
  horde.getCurrentDay = function () { return day }
  horde.getNextDay = function () { return horde.next }
  horde.setNextDay = function (n) { horde.next = Number(n) }
  data.getSpawnAmount = function () { return data.amount }
  data.setSpawnAmount = function (n) {
    data.sets++
    data.amount = Number(n)
  }
  ev.getHorde = function () { return horde }
  ev.getPlayer = function () { return p }
  ev.getDay = function () { return day }
  ev.getEntityWorld = function () { return p.level }
  ev.getSpawnData = function () { return data }
  ev.setCanceled = function (b) { ev.canceled = b === true }
  ev.isCanceled = function () { return ev.canceled }
  __pneMock.fire(PS_HORDE_BUILD, ev)
  PS.hordeBuilds++
  PS.hordeAmounts.push(ev.canceled ? 'cancelled' : data.amount)
  if (!PS.v.diffEv || prof === 3) {
    if (ev.canceled || data.amount !== 15 || data.sets !== 0) {
      psFail('Hordes build event touched on ' + (PS.v.diffEv ? 'Hard' : 'a run without pne_diff_events.js') + ' (profile ' + prof + '): cancelled ' +
        ev.canceled + ', amount ' + data.amount + ', setSpawnAmount calls ' + data.sets)
    }
  } else if (prof === 0) {
    PS.hordeCancelled++
    if (!ev.canceled || !(horde.next > day)) psFail('Peaceful: the Hordes build event was not cancelled with the schedule moved (cancelled ' + ev.canceled + ', nextDay ' + horde.next + ', today ' + day + ')')
  } else {
    want = PS_HORDE_15[prof]
    if (ev.canceled || data.amount !== want) psFail('profile ' + prof + ': a 15-mob Hordes wave became ' + (ev.canceled ? 'cancelled' : data.amount) + ' (want ' + want + ')')
  }
  return !ev.canceled
}

// The profile id the startup scripts read (global.pneDiffProfile, a wrapped Double in game, F6); 3 when absent.
function psGlobalProfile() {
  var v = global.pneDiffProfile
  var p = (v === undefined || v === null) ? 3 : Number(v)
  return (p >= 0 && p <= 3) ? Math.floor(p) : 3
}

// The vanilla difficulty the variant sets at tick t (diff0 at the start, then the diffAt schedule), and the tick of
// the last change at or before t (0: the start).
function psDiffWant(v, t) {
  var d = v.diff0 === undefined ? 3 : v.diff0
  var i
  for (i = 0; v.diffAt && i < v.diffAt.length; i++) {
    if (t >= v.diffAt[i][0]) d = v.diffAt[i][1]
  }
  return d
}

function psDiffSince(v, t) {
  var s = 0
  var i
  for (i = 0; v.diffAt && i < v.diffAt.length; i++) {
    if (t >= v.diffAt[i][0]) s = v.diffAt[i][0]
  }
  return s
}

// Every 20 ticks: the core's profile and the shared global follow the vanilla difficulty within 2 s of a change.
function psDiffCheck(v, t) {
  var want
  var got
  if (!psCoreLoaded() || t < 2 || t - psDiffSince(v, t) < 40) return
  if (typeof PW.server.pneCoreDiffId !== 'function') {
    if (!PS.noDiffApi) psFail('the core has no difficulty profiles (pneCoreDiffId missing: a pre-1.5 core)')
    PS.noDiffApi = true
    return
  }
  want = psDiffWant(v, t)
  got = global.pneDiffProfile
  PS.diffChecks++
  if (got === undefined || got === null || Number(got) !== want) psFail('global.pneDiffProfile is ' + got + ' (want ' + want + ', vanilla ' + PW.srv.difficulty + ')')
  if (Number(PW.server.pneCoreDiffId()) !== want) psFail('pneCoreDiffId() is ' + PW.server.pneCoreDiffId() + ' (want ' + want + ')')
}

// The hive backstop (contract 3.3): a fresh genome-less mob near a player in mercy/grace is discarded in the newborn
// drain, before any RNG draw. Expected only while the hive runs (hive, GA core and the startup listener loaded, hive on,
// spawn_backstop 1).
function psBackstopExpected() {
  return PS.v.hive && PS.v.ga && PS.v.events && psOn('hive') && PW.server.pneCoreCfg('spawn_backstop') === 1
}

function psWatch(list, what, t) {
  var keep = []
  var i
  var w
  var pd
  for (i = 0; i < list.length; i++) {
    w = list[i]
    if (t - w.at < 80) {
      keep.push(w)
      continue
    }
    pd = w.e.persistentData
    if (w.e.removed && w.e.removalReason === 'DISCARDED' && Number(pd.getByte('pne_pacing_discard')) === 1) {
      PS.backstopOk++
    } else if (!w.e.removed && psBackstopExpected() && !w.e.dead && !w.lateCheck) {
      if (psVulnNear(w.e.level, w.e.x, w.e.y, w.e.z)) {
        PS.backstopMissed++
        psFail(what + ' ' + w.e.typeId + ' next to ' + w.who + ' in mercy/grace survived the hive backstop for 80 ticks' +
          ' (pne_fresh ' + pd.getByte('pne_fresh') + ', pne_g ' + (pd.contains('pne_g') ? 'set' : 'absent') + ')')
      }
    }
  }
  return keep
}

// A Silent parasite within 12 blocks of a survival player must be heard: its L8 tell (HIVE tries one within ~20 ticks
// and then every 100) or, when nothing can play one, audible again at the first failed tell (contract 3.3 and 8). Far
// from every player silence harms nobody. The time a mob spends silent within 12 blocks is summed over its life (it
// comes and goes while it fights) and must stay under 120 ticks while no tell can be played.
function psSilentCheck(t) {
  var ms = psMobs()
  var i
  var m
  var possible = psCoreLoaded() && PS.v.hive && PS.v.ga && psOn('hive') && PS.v.director && psOn('resonance') && PS.v.catalog &&
    !(PS.v.broken === 'director' && PS.tripAt >= 0)
  var seen = {}
  for (i = 0; i < ms.length; i++) {
    m = ms[i]
    if (!m.silent) continue
    seen[m.uuid] = true
    if (!psPlayerWithin(m, 12)) continue
    PS.silentSince[m.uuid] = (PS.silentSince[m.uuid] || 0) + 20
    if (!possible && PS.silentSince[m.uuid] > 120 && psCoreLoaded()) {
      psFail('parasite ' + m.typeId + ' stayed silent next to a player for ' + PS.silentSince[m.uuid] + ' ticks while nothing can play its tell' +
        ' (pne_g ' + (m.persistentData.contains('pne_g') ? 'set' : 'absent') + ', pne_sil ' + m.persistentData.getByte('pne_sil') +
        (m === PS.savedSilent ? ', the saved silent mob' : '') + ')')
      PS.silentSince[m.uuid] = -1000000
    }
  }
  for (i in PS.silentSince) {
    if (PS.silentSince.hasOwnProperty(i) && !seen[i]) delete PS.silentSince[i]
  }
}

function psPlayerWithin(m, r) {
  var i
  var p
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (!p.removed && !p.dead && !p.creative && p.level === m.level && psDist(p, m) <= r) return true
  }
  return false
}

function psConvert() {
  var ms = psMobs()
  var i
  var c = null
  var n
  for (i = 0; i < ms.length; i++) {
    if (ms[i].typeId.indexOf('epca:') === 0 && ms[i].persistentData.contains('pne_g')) {
      c = ms[i]
      break
    }
  }
  if (!c) return
  n = PW.spawnMob(c.typeId === 'epca:small_incomplete_form' ? 'epca:ripper' : 'epca:small_incomplete_form', c.x, c.y, c.z, false, null)
  PW.remove(c, 'DISCARDED')
  if (n) {
    PS.conv++
    PS.convWatch = PS.convWatch || []
    PS.convWatch.push({ e: n, gi: String(c.persistentData.getString('pne_gi')), at: PW.srv.tickCount })
  }
}

function psReloadSome() {
  var ms = psMobs()
  var k
  var m
  for (k = 0; k < 2 && ms.length; k++) {
    m = ms[Math.floor(PW.rand() * ms.length)]
    if (m.removed || m.dead) continue
    PW.reload(m)
  }
}

function psPlaceTorch(p) {
  PW.torches.push({ x: p.x + 1, y: p.y, z: p.z })
  __pneMock.fire('BlockEvents.placed', { entity: p, player: p, block: { getId: function () { return 'minecraft:torch' }, id: 'minecraft:torch' },
    getBlock: function () { return { getId: function () { return 'minecraft:torch' } } }, getEntity: function () { return p } })
}

// ---------------------------------------------------------------------------------------------
// Checks over state

function psIsWorldObj(v) {
  try {
    if (typeof v.getTags === 'function' && v.typeId !== undefined) return true
    if (typeof v.runCommandSilent === 'function') return true
    if (typeof v.getEntitiesWithin === 'function' || typeof v.getGameTime === 'function' || typeof v.getTime === 'function') return true
  } catch (e) { return true }
  return false
}

function psWalk(v, path, depth, budget) {
  var t = typeof v
  var tag
  var k
  var i
  if (budget.n <= 0) return
  budget.n--
  if (t === 'number') {
    if (v !== v && !PS_NAN_SENTINEL.test(path)) psFail('NaN in module state at ' + path)
    return
  }
  if (t !== 'object' || v === null || depth > 8) return
  tag = Object.prototype.toString.call(v)
  if (tag !== '[object Object]' && tag !== '[object Array]') return
  if (psIsWorldObj(v)) return
  if (tag === '[object Array]') {
    for (i = 0; i < v.length && i < 600; i++) psWalk(v[i], path + '[' + i + ']', depth + 1, budget)
    return
  }
  for (k in v) {
    if (v.hasOwnProperty(k)) psWalk(v[k], path + '.' + k, depth + 1, budget)
  }
}

function psScanState() {
  var sc = PW.server
  var k
  var budget = { n: 60000 }
  if (!sc) return
  for (k in sc) {
    if (!/^(pne|PNE_|\$Pne)/.test(k)) continue
    if (typeof sc[k] === 'function') continue
    psWalk(sc[k], k, 0, budget)
  }
}

function psScanNbt(t, path, hive) {
  var k
  var v
  var n
  for (k in t.m) {
    if (!t.m.hasOwnProperty(k)) continue
    v = t.m[k]
    if (typeof v === 'number') {
      if (!isFinite(v)) psFail('non-finite number in NBT ' + path + '.' + k)
    } else if (typeof v === 'string') {
      n = Number(__pack.utf8(v))
      if (n > 65535) psFail('NBT string ' + path + '.' + k + ' is ' + n + ' bytes (limit 65,535)')
      if (hive && n >= 60000) psFail('pne_hive string ' + k + ' is ' + n + ' bytes (contract: under 60,000)')
    } else if (v && v.isMockNbt) {
      psScanNbt(v, path + '.' + k, hive || k === 'pne_hive')
    } else if (v && v.isIntArray) {
      for (n = 0; n < v.a.length; n++) {
        if (!isFinite(v.a[n]) || Math.floor(v.a[n]) !== v.a[n] || Math.abs(v.a[n]) > 2147483647) psFail('bad IntArray value in ' + path + '.' + k)
      }
    }
  }
}

function psScanAllNbt() {
  var es = PW.srv.entities
  var i
  psScanNbt(PW.srv.persistentData, 'server', false)
  for (i = 0; i < es.length; i++) {
    if (!es[i].removed) psScanNbt(es[i].persistentData, es[i].typeId, false)
  }
}

function psLogScan() {
  var i
  var l
  var bad = /(failed|disabled|error|exception|TypeError|ReferenceError|InternalError|EvaluatorException|is not a function|undefined)/i
  var allow = /(unavailable|could not hook HordeStartWaveEvent|Event\$Result is unavailable|getForgePersistentData is missing|did not load|stays off|no JDK)/i
  var brokenAllow = /(pne-broken|\[pne\] api\.(resonance|hive) disabled until the next reload|the director API was cut off)/
  for (i = PS.logN; i < PW.logs.length; i++) {
    l = PW.logs[i]
    if (l.level !== 'warn' && l.level !== 'error') continue
    if (PS.v.broken && brokenAllow.test(l.msg)) continue
    if (bad.test(l.msg) && !allow.test(l.msg)) psFail(l.kind + ' log: ' + l.msg.substring(0, 220))
  }
  PS.logN = PW.logs.length
  for (i = 0; i < PW.uncaught.length; i++) psFail('uncaught exception in ' + PW.uncaught[i].key + ' at t=' + PW.uncaught[i].t + ': ' + PW.uncaught[i].err)
  PW.uncaught = []
  for (i = 0; i < PW.cameraCmds.length; i++) psFail('camera command aimed at a player: ' + PW.cameraCmds[i])
  PW.cameraCmds = []
  for (i = 0; i < PW.bad.length; i++) psFail(PW.bad[i])
  PW.bad = []
}

function psGaSnap() {
  var sc = PW.server
  var GA
  var st
  if (!sc || typeof sc.PNE_HIVE_GA !== 'object' || !sc.pneHiveSt) return null
  GA = sc.PNE_HIVE_GA
  st = sc.pneHiveSt
  return { hash: String(GA.hash(st)), gen: Number(GA.gen(st)), pool: Number(GA.poolSize(st)), gov: Number(GA.gov(st)), queue: Number(GA.queueSize(st)) }
}

// ---------------------------------------------------------------------------------------------
// Server lifecycle

function psLogin(p) {
  PW.join(p, true)
  __pneMock.fire('PlayerEvents.loggedIn', { player: p, entity: p, server: PW.srv })
}

function psStart(v) {
  var srv = PW.newServer()
  var i
  var pd
  srv.difficulty = v.diff0 === undefined ? 3 : v.diff0
  srv.dayTime = v.day0
  srv.gameTime = v.day0 + 1000
  srv.persistentData.putInt('pne_doom_floor', 20000)
  psLoadStartup(v.drop)
  PS.alice = PW.addPlayer('Alice', 0, 0, {})
  PS.bob = PW.addPlayer('Bob', 90, 30, {})
  PS.carol = PW.addPlayer('Carol', 400, 400, { creative: true })
  psLoadServer(v.drop)
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  for (i = 0; i < srv.players.length; i++) psLogin(srv.players[i])
  // parasites saved in chunks from an earlier session (loaded from disk), one of them silent from a hive run
  for (i = 0; i < 6; i++) psSpawnAround(PS.alice, PS_EPCA, false, null, false)
  PS.savedSilent = PW.spawnMob('epca:ripper', 30, 64, 30, true, null)
  if (PS.savedSilent) {
    // a genome mob saved by an earlier hive session with the SIL gene expressed (contract 4.4 keys)
    PW.remove(PS.savedSilent, 'UNLOADED_TO_CHUNK')
    pd = PS.savedSilent.persistentData
    pd.putString('pne_g', '00000000000000000000ffff0000000000000000000000000000000000000000'.substring(0, 56))
    pd.putInt('pne_gv', 1)
    pd.putString('pne_gi', 'p1')
    pd.putString('pne_gp', '')
    pd.putString('pne_ctx', 'epca:ripper/0/0/surface')
    pd.putLong('pne_t0', 1)
    pd.putByte('pne_healed', 1)
    pd.putByte('pne_sil', 1)
    PS.savedSilent.silent = true
    PS.savedSilent = PW.reload(PS.savedSilent)
  }
}

function psReload(v) {
  __pneMock.fire('ServerEvents.unloaded', { server: PW.srv, reload: true })
  PW.server = null
  psLoadServer(v.drop)
  PS.reloads++
}

// World restart: unloaded (the hive saves), then every entity and the server data come back from a saved copy.
function psRestart(v) {
  var old = PW.srv
  var ents = []
  var players = []
  var i
  var e
  var p
  var n
  var srv
  var k
  PS.gaBefore = psGaSnap()
  __pneMock.fire('ServerEvents.unloaded', { server: old })
  for (i = 0; i < old.players.length; i++) __pneMock.fire('PlayerEvents.loggedOut', { player: old.players[i], server: old })
  for (i = 0; i < old.entities.length; i++) {
    e = old.entities[i]
    if (!e.removed && e.typeId !== 'minecraft:player' && e.typeId !== 'minecraft:item_display') ents.push(e)
  }
  for (i = 0; i < old.players.length; i++) players.push(old.players[i])
  PW.pending = []
  srv = PW.newServer()
  srv.tickCount = 0
  srv.gameTime = old.gameTime
  srv.dayTime = old.dayTime
  srv.difficulty = old.difficulty
  srv.hardcore = old.hardcore
  srv.persistentData = PW.copyNbt(old.persistentData)
  srv.getPersistentData = function () { return srv.persistentData }
  __pneVisMock.world = {}
  for (i = 0; i < players.length; i++) {
    p = players[i]
    n = PW.addPlayer(p.name, p.x, p.z, { uuid: p.uuid, creative: p.creative })
    n.hp = p.dead ? n.maxHp : p.hp
    n.persistentData = PW.copyNbt(p.persistentData)
    n.getPersistentData = function (q) { return function () { return q.persistentData } }(n)
    for (k in p.tagSet) {
      if (p.tagSet.hasOwnProperty(k)) n.addTag(k)
    }
    n.forceMercyUntil = p.forceMercyUntil
    if (p === PS.alice) PS.alice = n
    if (p === PS.bob) PS.bob = n
    if (p === PS.carol) PS.carol = n
  }
  psLoadServer(v.drop)
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  // contract 1.5 (3.7, Appendix A rule 15): the hive loads on its first tick after the start, never inside
  // ServerEvents.loaded, so nothing may be loaded yet; the state it loads is taken right before it declares the epoch
  // (before any drain or GA work of that tick) and must equal the state saved at the stop
  PS.gaAtLoaded = psGaSnap()
  psHookEpoch(PW.server)
  for (i = 0; i < srv.players.length; i++) psLogin(srv.players[i])
  for (i = 0; i < ents.length; i++) {
    e = ents[i]
    e.passengers = []
    n = __pneMock.mob(srv, e.typeId, { uuid: e.uuid, x: e.x, y: e.y, z: e.z, hp: e.hp, maxHp: e.maxHp, attrs: e.attrBase, mainHand: e.mainHand })
    n.persistentData = PW.copyNbt(e.persistentData)
    n.getPersistentData = function (q) { return function () { return q.persistentData } }(n)
    for (k in e.tagSet) {
      if (e.tagSet.hasOwnProperty(k)) n.addTag(k)
    }
    n.silent = e.silent
    n.customName = e.customName
    n.bornTick = 0
    for (k in e.attrInst) {
      if (e.attrInst.hasOwnProperty(k)) n.getAttribute(k).perm = e.attrInst[k].perm
    }
    PW.join(n, true)
  }
  PS.restart = true
}

// Wraps PNE_HIVE_GA.epoch once: the first call (the hive's first tick after the restart) snapshots the loaded GA state
// into PS.gaAfter, then restores the real function.
function psHookEpoch(sc) {
  var GA
  var real
  if (!sc || typeof sc.PNE_HIVE_GA !== 'object' || !sc.PNE_HIVE_GA) return
  GA = sc.PNE_HIVE_GA
  real = GA.epoch
  if (typeof real !== 'function') return
  GA.epoch = function (st, ep) {
    GA.epoch = real
    PS.gaAfter = psGaSnap()
    return real.call(GA, st, ep)
  }
}

// ---------------------------------------------------------------------------------------------
// One tick of the scenario

function psTick(v, t) {
  var srv = PW.srv
  var dt
  var t0
  var spent
  var i
  srv.tickCount++
  srv.gameTime++
  srv.dayTime++
  PS.t = t
  // the pause menu's difficulty switch (MinecraftServer.setDifficulty writes the world data at once)
  for (i = 0; v.diffAt && i < v.diffAt.length; i++) {
    if (t === v.diffAt[i][0]) srv.difficulty = v.diffAt[i][1]
  }
  PW.runPending()
  dt = srv.dayTime % 24000
  psMobStep(t)
  psPlayerStep(t)
  if (t % 20 === 7) psNaturalSpawns(t)
  // one Hive Night: the first night the variant sees (The Hordes' build and start events, then a wave every 2000 ticks;
  // on Peaceful the build event is cancelled and no horde runs)
  if (!PS.horde && !PS.hordeDone && dt >= 13000 && dt < 22000) {
    PS.horde = psHordeEvent(true) > 0
    PS.hordeDone = true
  }
  if (PS.horde && dt % 2000 === 0 && dt >= 13000 && dt < 23000) psHordeWave()
  if (PS.horde && dt === 23000) {
    psHordeEvent(false)
    PS.horde = false
  }
  // Bob in mercy for 2400 ticks during the horde (mobs leave him alone meanwhile, so it stays mercy, not death)
  if (dt === 14900) {
    PS.bob.hp = 5
    PS.bob.forceMercyUntil = t + 2400
    PS.bob.safeUntil = t + 2400
  }
  if (dt === 19000 && !PS.alice.dead) {
    psHurtPlayer(PS.alice, 40, psMobs()[0] || null)
  }
  if (dt === 21500 && !PS.bob.dead) {
    PS.bob.hp = 0
    PS.bob.dead = true
    PS.deathsPlayer++
    PW.killPlayer(PS.bob, PW.source('genericKill', null))
  }
  if (dt === 20000) psPlaceTorch(PS.alice)
  if (t % 400 === 200) psReloadSome()
  if (t % 600 === 300) psConvert()
  if (t % 900 === 450) {
    i = psMobs()
    if (i.length) PW.killMob(i[0], PW.source(t % 1800 === 450 ? 'fall' : 'outOfWorld', null))
  }
  if (t === 100) {
    psCmd('pne comfort off', PS.alice, 0)
    psCmd('pne resonance whispers off', PS.bob, 0)
  }
  if (t % 3000 === 1500) psStatusCommands()
  // the switch goes off at t = 300; /pne visual off waits for a live graft (from t = 3000, at the latest t = 9000) so the
  // removal is exercised
  if (v.off && PS.offAt < 0 && (v.off === 'visual' ? (t >= 3000 && (__pneVisMock.displays('pne_graft').length > 0 || t >= 9000)) : t === 300)) {
    PS.offAt = t
    if (psCmd('pne ' + v.off + ' off', null, 4) !== 1) psFail('/pne ' + v.off + ' off did not run')
    psAfterOff(v)
  }
  if (v.off && t === v.ticks - 2500) {
    PS.onAt = t
    if (psCmd('pne ' + v.off + ' on', null, 4) !== 1) psFail('/pne ' + v.off + ' on did not run')
  }
  if (v.sidecarFrom !== undefined) PW.sidecar = t >= v.sidecarFrom && t < v.sidecarTo
  t0 = __pack.ms()
  __pneMock.fire('ServerEvents.tick', { server: srv })
  PS.ms.push(__pack.ms() - t0)
  PW.sidecarStep()
  if (psCoreLoaded()) {
    spent = Number(PW.server.pneCoreSpentMs)
    if (spent > PS.maxCharged) PS.maxCharged = spent
    if (spent > 2.5 + 1e-9) psFail('token budget overrun: ' + spent.toFixed(3) + ' ms charged in one tick')
    if (Number(PW.server.pneCoreLeftMs) < -1e-9) psFail('negative budget remainder ' + PW.server.pneCoreLeftMs)
  }
  if (PS.v.broken) psBrokenStep(t)
  if (t % 20 === 11) {
    i = __pneVisMock.displays('pne_graft').length
    if (i > PS.graftsMax) PS.graftsMax = i
    if (v.off === 'visual' && PS.offAt < 0 && i > PS.graftsBeforeOff) PS.graftsBeforeOff = i
    PS.hordeWatch = psWatch(PS.hordeWatch, 'horde', t)
    PS.natWatch = psWatch(PS.natWatch, 'natural', t)
    psSilentCheck(t)
    psPillarChecks(v, t)
    psDiffCheck(v, t)
  }
  if (t % 100 === 0) psLogScan()
  if (v.dev && t % 250 === 0) psTrace(t)
  if (t % 4000 === 0) {
    psScanState()
    psScanAllNbt()
  }
}

// Broken variants: note the tick the core's API breaker trips, then sample the core fallbacks while the fault lasts.
function psBrokenStep(t) {
  var sc = PW.server
  var pace
  var near
  var ms
  var info
  if (!psCoreLoaded()) return
  if (PS.tripAt < 0) {
    if (!psTripped()) return
    PS.tripAt = t
    PS.tellsAtTrip = PS.tells
    PS.packSoundsAtTrip = PS.packSounds
    return
  }
  if (t % 20 !== 13) return
  if (PS.v.broken === 'director') {
    // mercy/grace pacing without the director: spawn 0, GA 0, no beckon (the core's fallback Pace)
    if (!PS.bob.removed && !PS.bob.dead && psVulnerable(PS.bob)) {
      pace = sc.pneCorePace(PS.bob)
      PS.paceChecks++
      if (!pace || pace.fallback !== true || Number(pace.spawn) !== 0 || Number(pace.ga) !== 0 || pace.beckon !== false ||
          Number(sc.pneCoreSpawnMult(PS.bob)) !== 0) {
        psFail('broken director: pacing for ' + PS.bob.name + ' in mercy/grace is not the core fallback with spawn 0 / ga 0: ' + JSON.stringify(pace))
      }
    }
    if (sc.pneCoreTell(psMobs()[0] || null, PS.alice) !== false) psFail('broken director: pneCoreTell still reports a tell after the API was cut off')
  }
  if (PS.v.broken === 'hive' && PS.hiveFallbackChecks < 5) {
    near = sc.pneCoreHiveNear(PS.alice)
    ms = psMobs()
    info = ms.length ? sc.pneCoreHiveInfo(ms[0]) : null
    PS.hiveFallbackChecks++
    if (!near || Number(near.clade) !== -1 || near.apex !== false || Number(near.silent) !== 0) {
      psFail('broken hive: pneCoreHiveNear is not the fallback {clade:-1, apex:false, silent:0}: ' + JSON.stringify(near))
    }
    if (info !== null) psFail('broken hive: pneCoreHiveInfo is not null after the API was cut off')
  }
}

function psStatusCommands() {
  var lines = [PW.logs.length]
  var words = ['pne status', 'pne hive status', 'pne resonance status', 'pne oracle status', 'pne visual status', 'pne', 'pne config',
    'pne difficulty']
  var i
  var r
  var tell0 = 0
  var need = {
    'pne status': true, pne: true, 'pne config': true, 'pne difficulty': true, 'pne hive status': PS.v.hive && PS.v.ga,
    'pne resonance status': PS.v.director, 'pne oracle status': PS.v.oracle, 'pne visual status': PS.v.visual
  }
  for (i = 0; i < words.length; i++) {
    r = psCmd(words[i], words[i] === 'pne config' ? null : PS.bob, words[i] === 'pne config' ? 4 : 0)
    // a module that is absent leaves its status word to the core, which answers "Unknown" (0)
    if (PS.dispatcher && psCoreLoaded() && need[words[i]] && r !== 1) psFail('/' + words[i] + ' returned ' + r)
  }
  r = psCmd('pne nosuchword', PS.bob, 0)
  if (PS.dispatcher && psCoreLoaded() && r !== -1) psFail('/pne nosuchword should be a parse error (got ' + r + ')')
  r = psCmd('pne config spawn_backstop 1', PS.bob, 0)
  if (PS.dispatcher && psCoreLoaded() && r === 1) psFail('a non-op changed the config')
  return tell0
}

// Pillar-off expectations (contract 6.2), checked every 20 ticks while the pillar is off.
function psPillarChecks(v, t) {
  var i
  var p
  var ds
  if (!v.off || PS.offAt < 0 || (PS.onAt >= 0 && t >= PS.onAt) || t - PS.offAt < 40) return
  if (v.off === 'resonance') {
    for (i = 0; i < PW.srv.players.length; i++) {
      p = PW.srv.players[i]
      if (!p.removed && (p.tagSet.hasOwnProperty('pne_gate') || p.tagSet.hasOwnProperty('pne_pace_soft'))) {
        psFail('resonance off: ' + p.name + ' still carries pne_gate/pne_pace_soft')
      }
    }
  }
  if (v.off === 'hive') {
    if (Number(global.pneOnHive) !== 0) psFail('hive off: global.pneOnHive is not 0')
  }
  if (v.off === 'visual' && t - PS.offAt > 400) {
    ds = __pneVisMock.displays('pne_graft')
    if (ds.length) psFail('visual off: ' + ds.length + ' graft display(s) still present 400 ticks later')
    // VISUAL empties its teams on the off sweep (docs/modules/visual.md, TESTING.md M4)
    for (i in PW.srv.sb.teams) {
      if (PW.srv.sb.teams.hasOwnProperty(i) && i.indexOf('pne_clade_') === 0 && __pneVisMock.teamSize(PW.srv, i) > 0) {
        psFail('visual off: team ' + i + ' still has ' + __pneVisMock.teamSize(PW.srv, i) + ' entries 400 ticks later')
      }
    }
  }
}

function psAfterOff(v) {
  var ms = psMobs()
  var i
  if (v.off === 'hive') {
    PS.genomeBeforeOff = {}
    for (i = 0; i < ms.length; i++) {
      if (ms[i].persistentData.contains('pne_g')) PS.genomeBeforeOff[ms[i].uuid] = true
    }
  }
  if (v.off === 'oracle') PS.oraWrites0 = __pneOraMock.io.writes
}

// ---------------------------------------------------------------------------------------------
// Expectations at the end of a variant (contract 8 rows and 6.2)

function psCountTagged(tag) {
  var n = 0
  var i
  var es = PW.srv.entities
  for (i = 0; i < es.length; i++) {
    if (!es[i].removed && es[i].tagSet.hasOwnProperty(tag)) n++
  }
  return n
}

// Live mobs carrying a genome, not counting the one saved with a genome before the variant started.
function psGenomeMobs() {
  var ms = psMobs()
  var n = 0
  var i
  for (i = 0; i < ms.length; i++) {
    if (ms[i].persistentData.contains('pne_g') && !(PS.savedSilent && ms[i].uuid === PS.savedSilent.uuid)) n++
  }
  return n
}

function psLogged(rx) {
  var i
  for (i = 0; i < PW.logs.length; i++) {
    if (rx.test(PW.logs[i].msg)) return true
  }
  return false
}

function psCmdCount(rx) {
  var n = 0
  var k
  for (k in PW.unknown) {
    if (PW.unknown.hasOwnProperty(k) && rx.test(k)) n += PW.unknown[k]
  }
  return n
}

function psExpect(v) {
  var sc = PW.server
  var g = psGenomeMobs()
  var ga
  var hs
  var i
  var linked = 0
  var cw
  var qd
  var ql
  var probes = PS.probeCmds
  // every variant with a world restart ('full' on Hard, 'diff-1-restart' on Easy)
  if (v.restartAt) {
    if (!PS.restart) psFail('restart: the variant never restarted (restartAt ' + v.restartAt + ')')
    if (PS.gaAtLoaded) psFail('restart: the hive loaded inside ServerEvents.loaded (contract 1.5: it loads on its first tick after the start)')
    if (!PS.gaBefore || !PS.gaAfter) psFail('restart: no GA state before or after (' + JSON.stringify(PS.gaBefore) + ' / ' + JSON.stringify(PS.gaAfter) + ')')
    else if (PS.gaBefore.hash !== PS.gaAfter.hash || PS.gaBefore.gen !== PS.gaAfter.gen || PS.gaBefore.pool !== PS.gaAfter.pool ||
      Math.abs(PS.gaBefore.gov - PS.gaAfter.gov) > 1e-9) {
      psFail('restart changed the GA state: ' + JSON.stringify(PS.gaBefore) + ' -> ' + JSON.stringify(PS.gaAfter))
    }
  }
  if (v.name === 'full') {
    if (g < 5) psFail('full: only ' + g + ' live genome mobs at the end')
    if (PS.backstopOk < 1) psFail('full: the backstop never discarded a fresh mob next to a player in mercy/grace')
    if (PS.resSounds < 1) psFail('full: no Resonance sound in two days')
    if (__pneOraMock.io.writes < 100) psFail('full: only ' + __pneOraMock.io.writes + ' telemetry.json writes')
    cw = PS.convWatch || []
    for (i = 0; i < cw.length; i++) {
      if (cw[i].gi && String(cw[i].e.persistentData.getString('pne_gp')).indexOf(cw[i].gi) >= 0) linked++
    }
    if (PS.conv > 0 && linked < 1) psFail('full: ' + PS.conv + ' conversions, none linked to its carrier (pne_gp)')
    PS.linked = linked
  }
  if (v.name === 'no-core') {
    if (g > 0) psFail('no-core: ' + g + ' genome mobs although no module may run')
    hs = PW.server.__pneMock.handlers['ServerEvents.tick'] || []
    if (hs.length !== 2) psFail('no-core: ' + hs.length + ' tick handlers (only pne_horde_cull.js and pne_horror.js may register)')
  }
  if (v.name === 'no-ga-core' && g > 0) psFail('no-ga-core: ' + g + ' genome mobs (the hive must stay off)')
  if (v.name === 'no-hive') {
    if (g > 0) psFail('no-hive: ' + g + ' genome mobs')
    if (PS.savedSilent && !PS.savedSilent.removed && PS.savedSilent.silent) psFail('no-hive: the saved silent mob was not unsilenced by the core')
  }
  if (v.name === 'no-hive' || v.name === 'no-ga-core') {
    // nobody drains the startup queues without the hive runtime, so the core keeps the producers off (contract 4.5)
    if (Number(global.pneOnHive) !== 0) psFail(v.name + ': global.pneOnHive is ' + global.pneOnHive + ' without the hive runtime')
    qd = global.pneHiveQDamage
    ql = global.pneHiveQLeave
    if ((qd && Number(qd.size()) > 0) || (ql && Number(ql.size()) > 0)) {
      psFail(v.name + ': the startup producers queued records nobody drains (damage ' + (qd ? qd.size() : 0) + ', leave ' + (ql ? ql.size() : 0) + ')')
    }
  }
  if (v.name === 'no-hive-events') {
    ga = psGaSnap()
    if (!ga || ga.gen < 1 && Number(sc.pneHiveStats.breeds) < 1) psFail('no-hive-events: the hive stopped breeding (' + JSON.stringify(ga) + ')')
    // contract 8: nothing sets pne_fresh, so no newborn qualifies for the backstop; PRJ scaling is off
    if (PS.backstopOk > 0) psFail('no-hive-events: ' + PS.backstopOk + ' backstop discard(s) without the startup listener (nothing sets pne_fresh)')
    if (PS.prjScaled > 0) psFail('no-hive-events: ' + PS.prjScaled + ' of ' + PS.prjHits + ' arrow hits on PRJ mobs were scaled without the startup listener')
  }
  if (v.name === 'full' && PS.prjHits >= 5 && PS.prjScaled < 1) {
    psFail('full: none of ' + PS.prjHits + ' arrow hits on PRJ mobs was scaled (pne_hive_events.js LivingHurtEvent)')
  }
  if (v.broken) {
    if (PS.tripAt < 0) {
      psFail(v.name + ': the core API breaker for ' + psBrokenPillar() + ' never tripped (' + PS.brokenCalls + ' failed calls)')
    } else if (v.broken === 'director') {
      if (!psLogged(/the director API was cut off/)) psFail('broken-director: no warning that the ledger is off until /reload')
      if (PS.paceChecks < 1) psFail('broken-director: no mercy/grace pacing sample after the trip')
      if (PS.tells > PS.tellsAtTrip) psFail('broken-director: ' + (PS.tells - PS.tellsAtTrip) + ' tells after the director API was cut off')
      if (PS.packSounds <= PS.packSoundsAtTrip) psFail('broken-director: no pack sound through the core fallback after the trip')
    } else if (v.broken === 'hive') {
      if (PS.hiveFallbackChecks < 1) psFail('broken-hive: no fallback sample after the trip')
    }
  }
  if (v.name === 'no-director') {
    if (PS.resSounds > 0) psFail('no-director: ' + PS.resSounds + ' Resonance sounds without the director')
    for (i = 0; i < PW.srv.players.length; i++) {
      if (PW.srv.players[i].tagSet.hasOwnProperty('pne_gate')) psFail('no-director: pne_gate left on ' + PW.srv.players[i].name)
    }
  }
  if (v.name === 'no-oracle' && probes < 10) psFail('no-oracle: the director did not fall back to probe sensing (' + probes + ' probes)')
  if (v.name === 'no-catalog' && PS.resSounds > 0) psFail('no-catalog: ' + PS.resSounds + ' Resonance sounds without a catalog')
  if (v.name === 'no-visual' && g < 3) psFail('no-visual: the hive expressed only ' + g + ' genome mobs')
  if (v.name === 'no-gate' && PS.natVulnAllowed > 0 && PS.backstopOk < 1) psFail('no-gate: natural spawns reached vulnerable players and the backstop discarded none')
  if (v.off === 'oracle' && PS.oraWrites0 !== undefined) {
    // one last telemetry.json with want_oracle false, then nothing until the switch goes back on
    PS.oraWritesAfterOff = PS.oraWritesOffEnd - PS.oraWrites0
    if (PS.oraWritesAfterOff > 1) psFail('oracle off: ' + PS.oraWritesAfterOff + ' telemetry.json writes after the switch (want 1)')
  }
  if (v.off === 'hive' && PS.newGenomeWhileOff > 0) psFail('hive off: ' + PS.newGenomeWhileOff + ' new genome mobs while the hive was off')
  psDiffExpect(v)
}

// The chat lines one /pne command sends (the texts as the client shows them: the JSON decoded).
function psReplies(input, player, level) {
  var r
  PW.tellraws = []
  r = psCmd(input, player, level)
  return { r: r, lines: PW.tellraws.slice(0), text: PW.tellraws.join(' | ') }
}

// The doom part of /pne difficulty line 4 (contract 6.3) that the core may print now, as a list of accepted texts.
// Peaceful: 'doom clock: no raises'. Otherwise 'doom clock as Hard' (L1: Easy and Normal keep the Hard days), and, once
// pne_horror.js has DIRECTOR's read-only pneHDoomNext (3.2.1), the next floor: the first Hard doom day (3.8 row 6, typed
// from the spec) above the day the doom clock last read, which is today or, when the day turned after its last
// 1200-tick run, yesterday; day 0 is never raised (1.4), so a clock that has only seen day 0 may still say nothing.
function psDoomWant(fin) {
  var days = [6, 12, 20, 32, 48, 62, 76, 88, 96, 100]
  var day = Math.floor(PW.srv.dayTime / 24000)
  var out = []
  var d
  var i
  var n
  var s
  if (fin === 0) return ['doom clock: no raises']
  if (typeof PW.server.pneHDoomNext !== 'function') return ['doom clock as Hard']
  for (d = day; d >= day - 1 && d >= 0; d--) {
    n = -1
    for (i = 0; i < days.length && n < 0; i++) {
      if (days[i] > d) n = days[i]
    }
    s = 'doom clock as Hard (' + (n > 0 ? 'next floor day ' + n : 'all floors reached') + ')'
    if (!psHas(out, s)) out.push(s)
    if (d === 0) out.push('doom clock as Hard')
  }
  return out
}

// Contract 1.5 expectations at the end of every variant (the difficulty profiles; see the header).
function psDiffExpect(v) {
  var sc = PW.server
  var fin = psDiffWant(v, v.ticks)
  var want = []
  var cur = 2
  var got = []
  var other = []
  var seq = [v.diff0 === undefined ? 3 : v.diff0]
  var epca = v.epca !== false
  var i
  var k
  var n
  var tgt
  var st
  var hs
  var dd
  var mods = 0
  var ms
  var id
  var want4
  var ok4
  if (!psCoreLoaded()) {
    if (PW.epca && PW.epca.writes.length) psFail('EPCA tier written without the core: ' + JSON.stringify(PW.epca.writes))
    return
  }
  for (i = 0; v.diffAt && i < v.diffAt.length; i++) seq.push(v.diffAt[i][1])
  // EPCA (section B): the overworld of a single-player world starts at the pack default EXPERT (2); Easy and Peaceful
  // want NORMAL (1), Normal and Hard the baseline; only changes are written, nothing else ever
  for (i = 0; epca && i < seq.length; i++) {
    tgt = seq[i] <= 1 ? 1 : 2
    if (tgt !== cur) want.push(tgt)
    cur = tgt
  }
  for (i = 0; PW.epca && i < PW.epca.writes.length; i++) {
    if (PW.epca.writes[i].dim === 'minecraft:overworld') got.push(PW.epca.writes[i].id)
    else other.push(PW.epca.writes[i].dim + '=' + PW.epca.writes[i].id)
  }
  if (got.join(',') !== want.join(',') || other.length) {
    psFail('EPCA tier writes ' + JSON.stringify(got) + (other.length ? ' plus ' + other.join(', ') : '') + ' for the profiles ' + JSON.stringify(seq) +
      ' (want overworld ' + JSON.stringify(want) + (epca ? '' : ', EPCA classes absent') + ')')
  }
  // nothing in the scenario picks an EPCA tier outside the pack, so no pack-managed dimension may ever be marked
  // deliberate (x.<dim>, the 'epca.x' warning): after a /reload or a restart the pack must recognise its own earlier
  // write through w.<dim> (diff-1-restart)
  for (i = 0; i < PW.logs.length; i++) {
    if (PW.logs[i].msg.indexOf('was chosen outside the pack') >= 0) {
      psFail('EPCA: a pack-managed dimension was marked as chosen outside the pack at t=' + PW.logs[i].t + ': ' + PW.logs[i].msg.substring(0, 160))
      break
    }
  }
  dd = PW.srv.persistentData.contains('pne_diff') ? PW.srv.persistentData.getCompound('pne_diff') : null
  for (i = 0; dd && i < PS_DIFF_DIMS.length; i++) {
    if (dd.contains('x.' + PS_DIFF_DIMS[i])) psFail('EPCA: pne_diff marks ' + PS_DIFF_DIMS[i] + ' deliberate (x.' + PS_DIFF_DIMS[i] + ') although nothing outside the pack chose its tier')
  }
  dd = null
  if (PS.diffNotices !== seq.length - 1) psFail(PS.diffNotices + ' difficulty notices for ' + (seq.length - 1) + ' change(s)')
  for (i = 0; i < PW.srv.players.length; i++) {
    n = PS.diffLogins[PW.srv.players[i].uuid] || 0
    if (n !== 1) psFail(PW.srv.players[i].name + ' got ' + n + ' difficulty login lines (want exactly 1 in the whole run)')
  }
  // the status lines and /pne difficulty name the profile (and the EPCA state)
  if (PS.dispatcher) {
    st = psReplies('pne status', PS.bob, 0)
    k = 'difficulty: ' + PS_DIFF_NAMES[fin] + ' (vanilla ' + PS_DIFF_NAMES[fin] + ', auto); ' +
      (epca ? 'EPCA overworld ' + (fin <= 1 ? 'Normal' : 'Expert') + ' (managed)' : 'EPCA tier unavailable')
    if (st.text.indexOf(k) < 0) psFail('/pne status lacks "' + k + '": ' + st.text.substring(0, 400))
    dd = psReplies('pne difficulty', PS.bob, 0)
    if (dd.r !== 1 || dd.lines.length !== 4 || dd.lines[0].indexOf('difficulty: vanilla ' + PS_DIFF_NAMES[fin] + ' -> profile ' + PS_DIFF_NAMES[fin] + ' (follows vanilla') !== 0 ||
        dd.lines[1].indexOf(epca ? 'EPCA tier: overworld ' + (fin <= 1 ? 'Normal' : 'Expert') + ' (pack-managed)' : 'EPCA tier unavailable') !== 0) {
      psFail('/pne difficulty (' + dd.r + '): ' + dd.text.substring(0, 400))
    }
    // line 4's doom part (6.3): no raises on Peaceful, else as Hard with the next floor day when horror can tell it
    want4 = psDoomWant(fin)
    ok4 = false
    for (i = 0; i < want4.length && dd.lines.length === 4; i++) {
      if (dd.lines[3].indexOf(want4[i] + '; spawns CALM ') === 0) ok4 = true
    }
    PS.doomLine = dd.lines.length === 4 ? String(dd.lines[3]).split(';')[0] : ''
    if (!ok4) psFail('/pne difficulty line 4 (want "' + want4.join('" or "') + '; spawns CALM ..."): ' + (dd.lines.length === 4 ? dd.lines[3] : dd.text).substring(0, 300))
    if (v.hive && v.ga && psOn('hive')) {
      hs = psReplies('pne hive status', PS.bob, 0)
      if (hs.text.indexOf('diff x' + PS_GENES[fin]) < 0) psFail('/pne hive status lacks "diff x' + PS_GENES[fin] + '": ' + hs.text.substring(0, 300))
    }
  }
  // Peaceful: the hive gives genomes but no gene modifier; the gate lets no natural spawn through near a survival player
  if (seq.join(',') === '0') {
    ms = psMobs()
    for (i = 0; i < ms.length; i++) {
      for (id in ms[i].attrInst) {
        if (!ms[i].attrInst.hasOwnProperty(id)) continue
        for (k in ms[i].attrInst[id].perm) {
          if (ms[i].attrInst[id].perm.hasOwnProperty(k) && PS_GENE_UUID.test(k)) mods++
        }
        for (k in ms[i].attrInst[id].trans) {
          if (ms[i].attrInst[id].trans.hasOwnProperty(k) && PS_GENE_UUID.test(k)) mods++
        }
      }
    }
    if (mods) psFail('Peaceful: ' + mods + ' hive gene modifier(s) on live mobs (the budget factor is 0)')
    if (v.hive && v.ga && psGenomeMobs() < 1) psFail('Peaceful: the hive gave no genome at all (it keeps breeding and tagging)')
    if (v.director && v.gate && PS.natNearAllowed > 0) psFail('Peaceful: ' + PS.natNearAllowed + ' natural spawn(s) allowed within 48 blocks of a survival player')
    if (PS.hordeBuilds > 0 && PS.hordeCancelled !== PS.hordeBuilds && v.diffEv) psFail('Peaceful: ' + (PS.hordeBuilds - PS.hordeCancelled) + ' horde(s) not cancelled')
  }
  if (PS.hordeBuilds < 1 && v.ticks >= 14500) psFail('the Hive Night never fired the Hordes build event')
  if (v.diffEv && psHas(seq, 1) && PS.sporeHits > 0 && PS.sporeScaled < 1) psFail('Easy: none of ' + PS.sporeHits + ' Spore hits on players was scaled')
}

// ---------------------------------------------------------------------------------------------
// Variants

var PS_VARIANTS = [
  { name: 'full', ticks: 49000, day0: 1000, reloadAt: 12000, restartAt: 30000, sidecarFrom: 2000, sidecarTo: 20000 },
  { name: 'no-core', drop: ['server_scripts/pne_00_core.js'] },
  { name: 'no-ga-core', drop: ['server_scripts/pne_hive_core.js'] },
  { name: 'no-hive', drop: ['server_scripts/pne_hive.js'] },
  { name: 'no-hive-events', drop: ['startup_scripts/pne_hive_events.js'] },
  { name: 'no-director', drop: ['server_scripts/pne_resonance.js'] },
  { name: 'no-gate', drop: ['startup_scripts/pne_res_gate.js'] },
  { name: 'no-oracle', drop: ['server_scripts/pne_oracle_bridge.js'] },
  { name: 'no-catalog', drop: ['server_scripts/pne_res_catalog.js'] },
  { name: 'no-visual', drop: ['server_scripts/pne_visual.js'] },
  { name: 'broken-director', broken: 'director' },
  { name: 'broken-hive', broken: 'hive' },
  { name: 'off-resonance', off: 'resonance' },
  { name: 'off-hive', off: 'hive' },
  { name: 'off-oracle', off: 'oracle' },
  { name: 'off-visual', off: 'visual' },
  // contract 1.5 degradation rows: EPCA's tier classes absent, and the new startup file removed (both on Easy, where
  // they matter; the rest of the matrix runs at the mock's default vanilla Hard)
  { name: 'no-epca', epca: false, diff0: 1 },
  { name: 'no-diff-events', drop: ['startup_scripts/pne_diff_events.js'], diff0: 1 },
  // contract 1.5 difficulty runs (group 'difficulty': suites pack-difficulty and pack-difficulty-strict)
  { name: 'diff-0', diff0: 0, group: 'difficulty' },
  { name: 'diff-1', diff0: 1, group: 'difficulty' },
  { name: 'diff-2', diff0: 2, group: 'difficulty' },
  { name: 'diff-3', diff0: 3, group: 'difficulty' },
  { name: 'diff-switch', diff0: 1, diffAt: [[4000, 3], [9000, 1]], group: 'difficulty' },
  // Easy across a /reload and a world restart: pne_diff.w.<dim> must survive, so the managed overworld is neither
  // written again nor marked deliberate, and no notice or second login line follows (the only restart runs otherwise
  // are 'full', on Hard, where w is never written)
  { name: 'diff-1-restart', diff0: 1, reloadAt: 6000, restartAt: 9000, group: 'difficulty' },
  { name: 'quick', ticks: 3500, day0: 13500, dev: true }
]

function psPrepare(v) {
  var d = v.drop || []
  if (!v.ticks) v.ticks = 14500
  if (v.day0 === undefined) v.day0 = 11000
  v.drop = d
  v.core = !psHas(d, 'server_scripts/pne_00_core.js')
  v.ga = !psHas(d, 'server_scripts/pne_hive_core.js')
  v.hive = !psHas(d, 'server_scripts/pne_hive.js')
  v.events = !psHas(d, 'startup_scripts/pne_hive_events.js')
  v.director = !psHas(d, 'server_scripts/pne_resonance.js')
  v.gate = !psHas(d, 'startup_scripts/pne_res_gate.js')
  v.oracle = !psHas(d, 'server_scripts/pne_oracle_bridge.js')
  v.catalog = !psHas(d, 'server_scripts/pne_res_catalog.js')
  v.visual = !psHas(d, 'server_scripts/pne_visual.js')
  v.diffEv = !psHas(d, 'startup_scripts/pne_diff_events.js')
  return v
}

function psResetWorld() {
  __pack.resetGlobal()
  PW.logs = []
  PW.uncaught = []
  PW.cancelled = []
  PW.pending = []
  PW.torches = []
  PW.unknown = {}
  PW.scores = {}
  PW.cmdN = 0
  PW.sidecar = false
  PW.sidecarSeq = -1
  PW.seed = 20260927
  __pneVisMock.world = {}
  __pneVisMock.all = []
  __pneVisMock.log = []
  __pneVisMock.particles = []
  __pneVisMock.unknown = []
  __pneOraMock.io.files = {}
  __pneOraMock.io.writes = 0
  __pneOraMock.io.reads = 0
}

function psPercentile(xs, q) {
  var s = xs.slice(0)
  s.sort(function (a, b) { return a - b })
  if (!s.length) return 0
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

function psRunVariant(v) {
  var t
  var hiveSt
  var i
  var p50
  var p99
  var line
  var tell
  psPrepare(v)
  psResetWorld()
  // EPCA's tier classes: present unless the variant is the EPCA-absent row (a fresh mock per variant, pack_world.js)
  PW.opts.epca = v.epca !== false
  PW.epcaInstall()
  PS = psNew(v)
  psInstallHooks()
  psStart(v)
  for (t = 1; t <= v.ticks; t++) {
    if (v.reloadAt && t === v.reloadAt) psReload(v)
    if (v.restartAt && t === v.restartAt) psRestart(v)
    psTick(v, t)
    if (v.off === 'hive' && PS.offAt >= 0 && PS.onAt < 0) psHiveOffCheck()
    if (v.off === 'oracle' && PS.offAt >= 0 && PS.onAt < 0) PS.oraWritesOffEnd = __pneOraMock.io.writes
    if (PS.failN > 80) break
  }
  psLogScan()
  psScanState()
  psScanAllNbt()
  psExpect(v)
  if (v.dev) {
    PW.tellraws = []
    psCmd('pne status', PS.bob, 0)
    psCmd('pne hive status', PS.bob, 0)
    psCmd('pne resonance status', PS.bob, 0)
    psCmd('pne oracle status', PS.bob, 0)
    psCmd('pne visual status', PS.bob, 0)
    for (i = 0; i < PW.tellraws.length; i++) __pack.out('    | ' + PW.tellraws[i])
    psDump()
  }
  p50 = psPercentile(PS.ms, 0.5)
  p99 = psPercentile(PS.ms, 0.99)
  line = v.name + ': ' + (PS.failN ? 'FAIL' : 'ok') + ' ' + v.ticks + ' ticks; harness ms/tick p50 ' + p50.toFixed(2) + ' p99 ' + p99.toFixed(2) +
    '; max charged ' + PS.maxCharged.toFixed(2) + ' ms; natural allowed/denied ' + PS.natAllowed + '/' + PS.natDenied +
    '; horde ' + PS.hordeSpawned + '; backstop discards seen ' + PS.backstopOk + ' (watched ' + PS.watched + ')' + '; mob/player deaths ' + PS.deathsMob + '/' + PS.deathsPlayer +
    '; summons ' + PS.summons + '; sounds ' + PS.sounds + ' (Resonance ' + PS.resSounds + ', tells ' + PS.tells + '); genome mobs ' + psGenomeMobs() +
    '; probes ' + PS.probeCmds + '; telemetry writes ' + __pneOraMock.io.writes + '; grafts max ' + PS.graftsMax +
    '; PRJ arrow hits scaled ' + PS.prjScaled + '/' + PS.prjHits +
    (v.broken ? '; API breaker tripped at t=' + PS.tripAt + ' after ' + PS.brokenCalls + ' failed calls (' + PS.brokenFails + ' expected module failures)' : '') +
    (v.off === 'visual' ? ' (before the switch ' + PS.graftsBeforeOff + ')' : '') + '; commands ' + PW.cmdN +
    (PS.gaAfter ? '; GA after restart ' + JSON.stringify(PS.gaAfter) : '') + (PS.linked !== undefined ? '; linked conversions ' + PS.linked + '/' + PS.conv : '') +
    '; vanilla ' + (v.diff0 === undefined ? 3 : v.diff0) + (v.diffAt ? v.diffAt.map(function (a) { return '->' + a[1] + '@' + a[0] }).join('') : '') +
    ' (profile checks ' + PS.diffChecks + ')' + (v.epca === false ? ', EPCA absent' : '') + '; EPCA writes ' +
    (PW.epca ? PW.epca.writes.map(function (w) { return w.dim.replace(/^minecraft:/, '') + '=' + w.id }).join(',') || 'none' : 'none') +
    '; notices ' + PS.diffNotices + '; Spore hits scaled ' + PS.sporeScaled + '/' + PS.sporeHits + ' (other hits ' + PS.otherHits + ')' +
    '; Hordes build ' + PS.hordeAmounts.join(',') + (PS.natNearAllowed ? '; Peaceful near-player natural spawns ' + PS.natNearAllowed : '') +
    (PS.doomLine ? '; /pne difficulty "' + PS.doomLine + '"' : '')
  return line
}

function psTrace(t) {
  var i
  var p
  var out = []
  for (i = 0; i < PW.srv.players.length; i++) {
    p = PW.srv.players[i]
    if (p.creative) continue
    out.push(p.name + ' hp ' + p.hp + ' tags ' + Object.keys(p.tagSet).join('+') + ' m ' + p.persistentData.getDouble('pne_m') + ' mt ' + p.persistentData.getLong('pne_m_t') + ' now ' + PW.srv.gameTime)
  }
  __pack.out('    t' + t + ' dt ' + (PW.srv.dayTime % 24000) + ' mobs ' + psMobs().length + ' | ' + out.join(' | '))
}

function psDump() {
  var es = PW.srv.entities
  var i
  var e
  var k
  var reasons = {}
  var keys
  for (i = 0; i < es.length; i++) {
    e = es[i]
    if (e.typeId === 'minecraft:player' || e.typeId === 'minecraft:item_display') continue
    if (e.removed) {
      reasons[e.removalReason] = (reasons[e.removalReason] || 0) + 1
      continue
    }
    keys = []
    for (k in e.persistentData.m) {
      if (e.persistentData.m.hasOwnProperty(k)) keys.push(k)
    }
    __pack.out('    live ' + e.typeId + ' born ' + e.bornTick + ' hp ' + e.hp + ' silent ' + e.silent + ' pd ' + keys.join(',') + ' tags ' + JSON.stringify(e.tagSet))
  }
  __pack.out('    removed: ' + JSON.stringify(reasons))
}

function psHiveOffCheck() {
  var ms = psMobs()
  var i
  if (!PS.genomeBeforeOff) return
  PS.newGenomeWhileOff = PS.newGenomeWhileOff || 0
  for (i = 0; i < ms.length; i++) {
    if (ms[i].persistentData.contains('pne_g') && !PS.genomeBeforeOff[ms[i].uuid] && ms[i].bornTick > PS.offAt + 5) {
      PS.genomeBeforeOff[ms[i].uuid] = true
      PS.newGenomeWhileOff++
    }
  }
}

function pnePackMain(which, mode, root) {
  var names = String(which || 'all').split(',')
  var lines = []
  var fails = []
  var i
  var v
  var k
  var unk = []
  PW.opts.strictKjs = String(mode || '') === 'strict'
  // the shared mocks carry only the KubeJS names; the plain runs add the Mojang names the module mocks also answer to
  __pneMock.opts.mojangNames = !PW.opts.strictKjs
  if (root) {
    PS_SERVER_DIR = String(root) + '/server_scripts'
    PS_STARTUP_DIR = String(root) + '/startup_scripts'
  }
  for (i = 0; i < PS_VARIANTS.length; i++) {
    v = PS_VARIANTS[i]
    // by name; 'all' (every variant but the dev one); 'matrix' (every one but 'full' and the groups); a group name
    // ('difficulty')
    if (!psHas(names, v.name) && (v.dev || (names[0] !== 'all' && !(names[0] === 'matrix' && v.name !== 'full' && !v.group) &&
        !(v.group && names[0] === v.group)))) continue
    lines.push(psRunVariant(v))
    __pack.out('  ' + lines[lines.length - 1])
    fails = fails.concat(PS.fails)
    if (PS.failN > PS.fails.length) fails.push('[' + v.name + '] ... ' + (PS.failN - PS.fails.length) + ' more')
  }
  for (k in PW.unknown) {
    if (PW.unknown.hasOwnProperty(k)) unk.push(k + ' x' + PW.unknown[k])
  }
  if (unk.length) __pack.out('  commands the mock world does not model (ignored): ' + unk.join(', '))
  if (fails.length) {
    for (i = 0; i < fails.length && i < 80; i++) __pack.out('  FAIL ' + fails[i])
    return 'FAIL pack smoke: ' + fails.length + ' problem(s) in ' + lines.length + ' variant(s)' + (PW.opts.strictKjs ? ' (strict KubeJS names)' : '')
  }
  return 'PASS pack smoke: ' + lines.length + ' variant(s), every invariant held' + (PW.opts.strictKjs ? ' (strict KubeJS names)' : '')
}
