// Test prelude for overrides/kubejs/server_scripts/pne_visual.js. ES5; runs in Node (tools/tests/kjs_node.js) and in
// the real Rhino fork (tools/rhino/pne_rhino.py run). Load it right after tools/tests/kjs_mocks.js.
//
// It extends the shared mocks (without editing them) with what VISUAL touches:
//   - entities: passengers/vehicle, body yaw, bounding box, CustomName (translatable contents), isRemoved, a level
//     per entity, a target (getTarget; set e.target); every entity is registered by UUID in __pneVisMock.world;
//   - levels: getEntity(UUID) and extra dimensions (__pneVisMock.addLevel); server.getAllLevels(), getEntities();
//   - the scoreboard: server.getScoreboard() is the shared ServerScoreboard Java API mock of tools/tests/kjs_mocks.js
//     (__pneMock.scoreboard over srv.sb: teams with nametag/collision/friendly-fire options, one team per entry),
//     wrapped so that every write is logged in __pneVisMock.sbLog = [{ t, op, a, b, started }] (op 'addTeam',
//     'removeTeam', 'join', 'leave', 'nametag', 'collision', 'friendlyFire', 'seeInvisibles'; started = the core's
//     pneCoreStarted at that moment) and so that a write can be made to fail silently: __pneVisMock.sbFault.join /
//     .leave / .set (the call does nothing but answers as if it worked, so only a read-back can tell) and .add
//     (addPlayerTeam throws). Plus vanilla's Scoreboard.entityRemoved rule (a destroyed non-player leaves its team).
//     Tests plant scoreboard state with __pneVisMock.addTeam(srv, name, opts), .join(srv, name, entry) and
//     .leave(srv, entry), never with commands;
//   - Recruits (contract 1.5, spec D): every command Recruits would take over (text holding "team" and also "add",
//     "remove", "join" or "leave") is recorded in __pneVisMock.teamCmds, every command whose text holds "team" at all
//     (Appendix A rule 15 (b), whatever else it says; a tellraw reply included) in __pneVisMock.teamText, and every
//     command issued while pneCoreStarted is false in __pneVisMock.early. With __pneVisMock.recruits = true they
//     behave as in game with Recruits installed: a command before the start is not run and answers 0; afterwards a
//     command with "team" plus add/remove/join/leave is cancelled and answers 1 (the answer a module must not trust).
//     Off by default (the pack harness has its own Recruits model in front of this interpreter);
//   - an interpreter for exactly the commands pne_visual.js issues (summon item_display, ride, kill, tag,
//     execute ... on vehicle on passengers, the graft yaw tp, data merge/remove CustomName, tag <uuid> add/remove,
//     execute as @e[tag=...] run data remove entity @s CustomName, tag @e[tag=...] remove, particle), plus vanilla
//     team commands for other scripts. Results mimic Minecraft (count of affected entities, 0 on failure).
//     __pneVisMock.failSummon = n makes the next n summons fail. Any other world-changing command is recorded in
//     __pneVisMock.unknown.
//   - in Node only: a java.util.UUID shim (fromString); Rhino uses the real class.
// Every command is logged with the server tick: __pneVisMock.log = [{ t, c, r }].

var __pneVisMock = { unknown: [], log: [], world: {}, all: [], particles: [], failSummon: 0, sbLog: [],
  sbFault: { join: false, leave: false, set: false, add: false }, teamCmds: [], teamText: [], early: [], recruits: false }
var __PNE_VIS_MOCK_UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function __pneVisMockUuidObj(s) {
  var v = String(s).toLowerCase()
  if (!__PNE_VIS_MOCK_UUID_RX.test(v)) throw new Error('IllegalArgumentException: Invalid UUID string: ' + s)
  return { s: v, toString: function () { return v } }
}

if (typeof __pneRemap === 'undefined') {
  __pneVisMock.loadClass0 = Java.loadClass
  Java.loadClass = function (n) {
    if (String(n) === 'java.util.UUID') {
      return { fromString: __pneVisMockUuidObj, randomUUID: function () { throw new Error('mock: no randomUUID') } }
    }
    return __pneVisMock.loadClass0(n)
  }
}

function __pneVisMockIterable(arr) {
  return {
    arr: arr,
    size: function () { return arr.length },
    get: function (i) { return arr[i] },
    iterator: function () {
      var i = 0
      return { hasNext: function () { return i < arr.length }, next: function () { return arr[i++] } }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Entities

__pneVisMock.entity0 = __pneMock.entity
__pneMock.entity = function (srv, typeId, opts) {
  var o = opts || {}
  var e = __pneVisMock.entity0(srv, typeId, o)
  e.level = o.level || srv.level
  e.passengers = []
  e.vehicle = null
  e.bodyYaw = o.bodyYaw || 0
  e.yaw = o.yaw || 0
  e.bbW = o.bbWidth || 0.6
  e.bbH = o.bbHeight || 1.8
  e.customName = null
  e.rotation = null
  e.item = null
  e.target = null
  e.getTarget = function () { return e.target }
  e.getLevel = function () { return e.level }
  e.getServer = function () { return srv }
  e.getPassengers = function () { return __pneVisMockIterable(e.passengers.slice()) }
  e.getVehicle = function () { return e.vehicle }
  e.isRemoved = function () { return e.removed }
  e.getVisualRotationYInDegrees = function () { return e.bodyYaw }
  // KubeJS renames Entity.getYRot to getYaw (@RemapForJS), so in game only getYaw exists; the mock mirrors that.
  e.getYaw = function () { return e.yaw }
  e.getBbWidth = function () { return e.bbW }
  e.getBbHeight = function () { return e.bbH }
  e.hasCustomName = function () { return e.customName !== null }
  e.getCustomName = function () {
    var n = e.customName
    if (n === null) return null
    return {
      getString: function () { return n.text },
      getContents: function () {
        return { getKey: function () { if (!n.key) throw new Error('literal contents have no key'); return n.key } }
      }
    }
  }
  e.discard = function () { __pneVisMockDestroy(srv, e, false) }
  __pneVisMock.world[e.uuid] = e
  __pneVisMock.all.push(e)
  return e
}

function __pneVisMockLive(u) {
  var e = __pneVisMock.world[String(u)]
  return e && !e.removed ? e : null
}

function __pneVisMockDetach(e) {
  var v = e.vehicle
  var i
  if (!v) return
  for (i = v.passengers.length - 1; i >= 0; i--) {
    if (v.passengers[i] === e) v.passengers.splice(i, 1)
  }
  e.vehicle = null
}

// KILLED or DISCARDED: passengers are ejected, the entity leaves its vehicle, and vanilla drops a destroyed
// non-player's team entry (ServerLevel onDestroyed -> Scoreboard.entityRemoved when !isAlive()).
function __pneVisMockDestroy(srv, e, killed) {
  var i
  if (e.removed) return false
  e.removed = true
  if (killed) e.hp = 0
  for (i = 0; i < e.passengers.length; i++) e.passengers[i].vehicle = null
  e.passengers = []
  __pneVisMockDetach(e)
  if (e.typeId !== 'minecraft:player') __pneVisMockLeave(srv, e.uuid)
  return true
}

// Chunk unload: the host and its passengers leave the level together; team entries stay.
__pneVisMock.unload = function (e) {
  var i
  e.removed = true
  for (i = 0; i < e.passengers.length; i++) e.passengers[i].removed = true
}

// Chunk load: new objects with the same UUIDs, passengers riding again, tags and persistent data kept.
__pneVisMock.reload = function (srv, e) {
  var n = __pneMock.mob(srv, e.typeId, { uuid: e.uuid, x: e.x, y: e.y, z: e.z, level: e.level, bodyYaw: e.bodyYaw })
  var i
  var p
  var q
  var k
  for (k in e.tagSet) {
    if (e.tagSet.hasOwnProperty(k)) n.addTag(k)
  }
  n.customName = e.customName
  for (i = 0; i < e.passengers.length; i++) {
    p = e.passengers[i]
    q = __pneMock.entity(srv, p.typeId, { uuid: p.uuid, level: p.level, x: p.x, y: p.y, z: p.z })
    for (k in p.tagSet) {
      if (p.tagSet.hasOwnProperty(k)) q.addTag(k)
    }
    for (k in p.persistentData.m) {
      if (p.persistentData.m.hasOwnProperty(k)) q.persistentData.m[k] = p.persistentData.m[k]
    }
    q.item = p.item
    q.vehicle = n
    n.passengers.push(q)
  }
  return n
}

// Dimension change (Entity.changeDimension): the old object is removed with CHANGED_DIMENSION, which ejects its
// passengers (unRide) and, being a destroying reason on an entity that is no longer alive, drops its team entry
// (Scoreboard.entityRemoved). A new object with the same UUID appears in the target level, riding nothing.
__pneVisMock.changeDim = function (srv, e, level) {
  var n
  var i
  var k
  e.removed = true
  for (i = 0; i < e.passengers.length; i++) e.passengers[i].vehicle = null
  e.passengers = []
  __pneVisMockDetach(e)
  __pneVisMockLeave(srv, e.uuid)
  n = __pneMock.mob(srv, e.typeId, { uuid: e.uuid, level: level, x: e.x, y: e.y, z: e.z, bodyYaw: e.bodyYaw })
  for (k in e.tagSet) {
    if (e.tagSet.hasOwnProperty(k)) n.addTag(k)
  }
  n.customName = e.customName
  return n
}

// Makes one entity ride another (a foreign passenger such as a carried mob).
__pneVisMock.mount = function (rider, vehicle) {
  __pneVisMockDetach(rider)
  rider.vehicle = vehicle
  vehicle.passengers.push(rider)
}
__pneVisMock.dismount = function (rider) {
  __pneVisMockDetach(rider)
}

// A graft-like display made outside VISUAL (for orphan and rediscovery tests).
__pneVisMock.display = function (srv, uuid, host, tag) {
  var d = __pneMock.entity(srv, 'minecraft:item_display', { uuid: uuid, level: host ? host.level : srv.level })
  d.addTag(tag || 'pne_graft')
  if (host) {
    d.vehicle = host
    host.passengers.push(d)
    d.persistentData.putString('pne_host', host.uuid)
  }
  return d
}

// ---------------------------------------------------------------------------------------------
// Levels and server

function __pneVisMockLevel(lvl) {
  lvl.getEntity = function (u) {
    var e = __pneVisMockLive(u)
    return e && e.level === lvl ? e : null
  }
  return lvl
}

__pneVisMock.addLevel = function (srv, dim) {
  var l = { dimension: dim, server: srv }
  l.getGameTime = function () { return srv.gameTime }
  l.getDimension = function () { return dim }
  l.getServer = function () { return srv }
  l.players = function () { return __pneMock.list([]) }
  l.getPlayers = l.players
  __pneVisMockLevel(l)
  srv.levelsArr.push(l)
  return l
}

// The core's start flag as the game would see it (true when the core under test has none).
function __pneVisMockStarted() {
  return typeof pneCoreStarted === 'boolean' ? pneCoreStarted : true
}

function __pneVisMockSbLog(srv, op, a, b) {
  if (__pneVisMock.sbLog.length >= 20000) __pneVisMock.sbLog.splice(0, 10000)
  __pneVisMock.sbLog.push({ t: srv.tickCount, op: op, a: String(a), b: b === undefined || b === null ? '' : String(b), started: __pneVisMockStarted() })
}

// A team of the shared mock, with its writes logged (and dropped while __pneVisMock.sbFault.set).
function __pneVisMockTeamWrap(srv, t) {
  if (!t) return null
  return {
    __team: t.__team,
    getName: t.getName,
    getPlayers: t.getPlayers,
    getNameTagVisibility: t.getNameTagVisibility,
    getCollisionRule: t.getCollisionRule,
    isAllowFriendlyFire: t.isAllowFriendlyFire,
    canSeeFriendlyInvisibles: t.canSeeFriendlyInvisibles,
    setNameTagVisibility: function (v) {
      __pneVisMockSbLog(srv, 'nametag', t.getName(), v)
      if (!__pneVisMock.sbFault.set) t.setNameTagVisibility(v)
    },
    setCollisionRule: function (c) {
      __pneVisMockSbLog(srv, 'collision', t.getName(), c)
      if (!__pneVisMock.sbFault.set) t.setCollisionRule(c)
    },
    setAllowFriendlyFire: function (b) {
      __pneVisMockSbLog(srv, 'friendlyFire', t.getName(), b)
      if (!__pneVisMock.sbFault.set) t.setAllowFriendlyFire(b)
    },
    setSeeFriendlyInvisibles: function (b) {
      __pneVisMockSbLog(srv, 'seeInvisibles', t.getName(), b)
      if (!__pneVisMock.sbFault.set) t.setSeeFriendlyInvisibles(b)
    }
  }
}

// server.getScoreboard(): the shared ServerScoreboard mock over srv.sb, writes logged, faults injectable (see the header).
function __pneVisMockScoreboard(srv) {
  var sb = __pneMock.scoreboard(srv)
  return {
    getPlayerTeam: function (n) { return __pneVisMockTeamWrap(srv, sb.getPlayerTeam(n)) },
    getPlayersTeam: function (entry) { return __pneVisMockTeamWrap(srv, sb.getPlayersTeam(entry)) },
    getPlayerTeams: sb.getPlayerTeams,
    addPlayerTeam: function (n) {
      __pneVisMockSbLog(srv, 'addTeam', n)
      if (__pneVisMock.sbFault.add) throw new Error('mock: addPlayerTeam refused')
      return __pneVisMockTeamWrap(srv, sb.addPlayerTeam(n))
    },
    removePlayerTeam: function (t) {
      __pneVisMockSbLog(srv, 'removeTeam', t.getName())
      sb.removePlayerTeam(t)
    },
    addPlayerToTeam: function (entry, t) {
      __pneVisMockSbLog(srv, 'join', entry, t.getName())
      if (__pneVisMock.sbFault.join) return true
      return sb.addPlayerToTeam(entry, t)
    },
    removePlayerFromTeam: function (entry, t) {
      __pneVisMockSbLog(srv, 'leave', entry, t ? t.getName() : '')
      if (__pneVisMock.sbFault.leave) return true
      return (t === undefined || t === null) ? sb.removePlayerFromTeam(entry) : sb.removePlayerFromTeam(entry, t)
    }
  }
}

// Recruits' command interception (see the header): undefined when the command runs normally. Recruits 1.15.2
// (FactionEvents.onTypeCommandEvent) tests plain substrings of the whole command text: "team", then "add", "remove",
// "join" or "leave" anywhere in it (a tellraw whose text says "teams" and whose target UUID holds "add" counts too).
function __pneVisMockRecruits(srv, c) {
  var hit = c.indexOf('team') >= 0 && /add|remove|join|leave/.test(c)
  if (c.indexOf('team') >= 0 && __pneVisMock.teamText.length < 1000) __pneVisMock.teamText.push({ t: srv.tickCount, c: c })
  if (hit && __pneVisMock.teamCmds.length < 1000) __pneVisMock.teamCmds.push({ t: srv.tickCount, c: c })
  if (!__pneVisMockStarted()) {
    if (__pneVisMock.early.length < 1000) __pneVisMock.early.push({ t: srv.tickCount, c: c })
    if (__pneVisMock.recruits) return 0
  }
  if (__pneVisMock.recruits && hit) return 1
  return undefined
}

__pneVisMock.server0 = __pneMock.server
__pneMock.server = function (opts) {
  var srv = __pneVisMock.server0(opts)
  var run0 = srv.runCommandSilent
  srv.levelsArr = [__pneVisMockLevel(srv.level)]
  srv.sb = { teams: {}, byEntry: {} }
  srv.noScoreboard = false
  srv.getAllLevels = function () { return __pneVisMockIterable(srv.levelsArr.slice()) }
  srv.getScoreboard = function () {
    if (srv.noScoreboard) throw new Error('mock: scoreboard unavailable')
    return __pneVisMockScoreboard(srv)
  }
  srv.getEntities = function () {
    var out = []
    var i
    for (i = 0; i < __pneVisMock.all.length; i++) {
      if (!__pneVisMock.all[i].removed && __pneVisMock.all[i].server === srv) out.push(__pneVisMock.all[i])
    }
    return __pneVisMockIterable(out)
  }
  srv.runCommandSilent = function (cmd) {
    var c = String(cmd)
    var r = __pneVisMockRecruits(srv, c)
    if (r !== undefined) {
      srv.cmds.push(c)
      __pneVisMock.log.push({ t: srv.tickCount, c: c, r: r, recruits: true })
      return r
    }
    r = __pneVisMockExec(srv, c)
    if (r === undefined) return run0(c)
    srv.cmds.push(c)
    __pneVisMock.log.push({ t: srv.tickCount, c: c, r: r })
    return r
  }
  srv.runCommand = srv.runCommandSilent
  return srv
}

// ---------------------------------------------------------------------------------------------
// Scoreboard helpers

function __pneVisMockLeave(srv, entry) {
  var t = srv.sb.byEntry[String(entry)]
  if (!t) return false
  delete srv.sb.teams[t].members[String(entry)]
  delete srv.sb.byEntry[String(entry)]
  return true
}

__pneVisMock.teamOf = function (srv, entry) {
  return srv.sb.byEntry[String(entry)] || ''
}

// Test planting (no command, no log): a team with vanilla defaults unless opts says otherwise; returns its record.
__pneVisMock.addTeam = function (srv, name, opts) {
  var o = opts || {}
  if (!srv.sb.teams.hasOwnProperty(name)) {
    srv.sb.teams[name] = { name: name, nametagVisibility: 'always', collisionRule: 'always', members: {}, friendlyFire: true,
      seeFriendlyInvisibles: true }
  }
  if (o.nametagVisibility) srv.sb.teams[name].nametagVisibility = o.nametagVisibility
  if (o.collisionRule) srv.sb.teams[name].collisionRule = o.collisionRule
  if (o.friendlyFire !== undefined) srv.sb.teams[name].friendlyFire = o.friendlyFire
  if (o.seeFriendlyInvisibles !== undefined) srv.sb.teams[name].seeFriendlyInvisibles = o.seeFriendlyInvisibles
  return srv.sb.teams[name]
}

// Test planting: the entry moves to team `name` (created with vanilla defaults when missing).
__pneVisMock.join = function (srv, name, entry) {
  __pneVisMock.addTeam(srv, name, null)
  __pneVisMockLeave(srv, entry)
  srv.sb.teams[name].members[String(entry)] = true
  srv.sb.byEntry[String(entry)] = name
}

// Test planting: the entry leaves its team; true when it was on one.
__pneVisMock.leave = function (srv, entry) {
  return __pneVisMockLeave(srv, entry)
}

__pneVisMock.teamSize = function (srv, name) {
  var t = srv.sb.teams[name]
  var n = 0
  var k
  if (!t) return -1
  for (k in t.members) {
    if (t.members.hasOwnProperty(k)) n++
  }
  return n
}

function __pneVisMockIntsToUuid(a, b, c, d) {
  var h = ''
  var parts = [a, b, c, d]
  var i
  for (i = 0; i < 4; i++) h += ('00000000' + (Number(parts[i]) >>> 0).toString(16)).slice(-8)
  return h.substring(0, 8) + '-' + h.substring(8, 12) + '-' + h.substring(12, 16) + '-' + h.substring(16, 20) + '-' + h.substring(20)
}

function __pneVisMockDisplays(tag) {
  var out = []
  var i
  var e
  for (i = 0; i < __pneVisMock.all.length; i++) {
    e = __pneVisMock.all[i]
    if (!e.removed && e.typeId === 'minecraft:item_display' && (!tag || e.tagSet.hasOwnProperty(tag))) out.push(e)
  }
  return out
}
__pneVisMock.displays = __pneVisMockDisplays

// Loaded entities of any type that carry a tag (the @e[tag=...] selector).
function __pneVisMockTagged(tag) {
  var out = []
  var i
  var e
  for (i = 0; i < __pneVisMock.all.length; i++) {
    e = __pneVisMock.all[i]
    if (!e.removed && e.tagSet.hasOwnProperty(tag)) out.push(e)
  }
  return out
}

// ---------------------------------------------------------------------------------------------
// The command interpreter (returns undefined for commands it does not model)

function __pneVisMockExec(srv, c) {
  var m
  var t
  var e
  var h
  var n
  var i
  var j
  var list
  var nbt
  var u
  var json
  var old
  if ((m = /^team add (\S+)$/.exec(c))) {
    if (srv.sb.teams.hasOwnProperty(m[1])) return 0
    srv.sb.teams[m[1]] = { name: m[1], nametagVisibility: 'always', collisionRule: 'always', members: {} }
    return 1
  }
  if ((m = /^team modify (\S+) (nametagVisibility|collisionRule) (never|always|pushOtherTeams|pushOwnTeam|hideForOtherTeams|hideForOwnTeam)$/.exec(c))) {
    t = srv.sb.teams[m[1]]
    if (!t || t[m[2]] === m[3]) return 0
    t[m[2]] = m[3]
    return 1
  }
  if ((m = /^team join (\S+) (\S+)$/.exec(c))) {
    t = srv.sb.teams[m[1]]
    if (!t) return 0
    __pneVisMockLeave(srv, m[2])
    t.members[m[2]] = true
    srv.sb.byEntry[m[2]] = m[1]
    return 1
  }
  if ((m = /^team leave (\S+)$/.exec(c))) return __pneVisMockLeave(srv, m[1]) ? 1 : 0
  if ((m = /^team empty (\S+)$/.exec(c))) {
    t = srv.sb.teams[m[1]]
    if (!t) return 0
    list = []
    for (u in t.members) {
      if (t.members.hasOwnProperty(u)) list.push(u)
    }
    for (i = 0; i < list.length; i++) __pneVisMockLeave(srv, list[i])
    return list.length
  }
  if ((m = /^execute at (\S+) run summon minecraft:item_display ~ ~ ~ (\{.*\})$/.exec(c))) {
    h = __pneVisMockLive(m[1])
    nbt = m[2]
    if (!h) return 0
    if (__pneVisMock.failSummon > 0) {
      __pneVisMock.failSummon--
      return 0
    }
    m = /UUID:\[I;(-?\d+),(-?\d+),(-?\d+),(-?\d+)\]/.exec(nbt)
    if (!m) return 0
    u = __pneVisMockIntsToUuid(m[1], m[2], m[3], m[4])
    if (__pneVisMockLive(u)) return 0
    e = __pneMock.entity(srv, 'minecraft:item_display', { uuid: u, level: h.level, x: h.x, y: h.y, z: h.z })
    m = /Tags:\[([^\]]*)\]/.exec(nbt)
    if (m) {
      list = m[1].split(',')
      for (i = 0; i < list.length; i++) e.addTag(list[i].replace(/"/g, ''))
    }
    m = /KubeJSPersistentData:\{pne_host:"([^"]+)"\}/.exec(nbt)
    if (m) e.persistentData.putString('pne_host', m[1])
    m = /item:\{id:"([^"]+)",Count:1b\}/.exec(nbt)
    e.item = m ? m[1] : null
    e.nbt = nbt
    return 1
  }
  if ((m = /^ride (\S+) mount (\S+)$/.exec(c))) {
    e = __pneVisMockLive(m[1])
    h = __pneVisMockLive(m[2])
    if (!e || !h || e.vehicle || e === h || h.typeId === 'minecraft:player') return 0
    e.vehicle = h
    h.passengers.push(e)
    return 1
  }
  if ((m = /^kill ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(c))) {
    e = __pneVisMockLive(m[1])
    return e && __pneVisMockDestroy(srv, e, true) ? 1 : 0
  }
  if ((m = /^kill @e\[type=minecraft:item_display,tag=(\w+)\]$/.exec(c))) {
    list = __pneVisMockDisplays(m[1])
    for (i = 0; i < list.length; i++) __pneVisMockDestroy(srv, list[i], true)
    return list.length
  }
  if ((m = /^tag @e\[type=minecraft:item_display,tag=(\w+)\] add (\w+)$/.exec(c))) {
    list = __pneVisMockDisplays(m[1])
    n = 0
    for (i = 0; i < list.length; i++) {
      if (list[i].addTag(m[2])) n++
    }
    return n
  }
  if ((m = /^execute as @e\[type=minecraft:item_display,tag=(\w+)\] on vehicle on passengers run tag @s remove (\w+)$/.exec(c))) {
    list = __pneVisMockDisplays(m[1])
    n = 0
    for (i = 0; i < list.length; i++) {
      h = list[i].vehicle
      if (!h || h.removed) continue
      for (j = 0; j < h.passengers.length; j++) {
        if (h.passengers[j].removeTag(m[2])) n++
      }
    }
    return n
  }
  if ((m = /^execute as (\S+) at @s run tp @s ~ ~ ~ (-?[0-9.]+) 0$/.exec(c))) {
    e = __pneVisMockLive(m[1])
    if (!e) return 0
    e.rotation = Number(m[2])
    return 1
  }
  if ((m = /^data merge entity (\S+) \{CustomName:'(.*)'\}$/.exec(c))) {
    e = __pneVisMockLive(m[1])
    if (!e) return 0
    json = JSON.parse(m[2])
    old = e.customName
    e.customName = { text: String(json.fallback || json.text || ''), key: json.translate ? String(json.translate) : null, json: json }
    return old && old.key === e.customName.key && old.text === e.customName.text ? 0 : 1
  }
  if ((m = /^data remove entity (\S+) CustomName$/.exec(c))) {
    e = __pneVisMockLive(m[1])
    if (!e || e.customName === null) return 0
    e.customName = null
    return 1
  }
  if ((m = /^execute at (\S+) run particle (\S+) (.*)$/.exec(c))) {
    e = __pneVisMockLive(m[1])
    if (!e) return 0
    __pneVisMock.particles.push({ t: srv.tickCount, u: m[1], type: m[2], rest: m[3] })
    return 1
  }
  if ((m = /^execute if entity @e\[type=minecraft:item_display,tag=(\w+)\]$/.exec(c))) return __pneVisMockDisplays(m[1]).length
  if ((m = /^tag ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) (add|remove) (\w+)$/.exec(c))) {
    e = __pneVisMockLive(m[1])
    if (!e) return 0
    return (m[2] === 'add' ? e.addTag(m[3]) : e.removeTag(m[3])) ? 1 : 0
  }
  if ((m = /^execute as @e\[tag=(\w+)\] run data remove entity @s CustomName$/.exec(c))) {
    list = __pneVisMockTagged(m[1])
    n = 0
    for (i = 0; i < list.length; i++) {
      if (list[i].customName !== null && list[i].typeId !== 'minecraft:player') {
        list[i].customName = null
        n++
      }
    }
    return n
  }
  if ((m = /^tag @e\[tag=(\w+)\] remove (\w+)$/.exec(c))) {
    list = __pneVisMockTagged(m[1])
    n = 0
    for (i = 0; i < list.length; i++) {
      if (list[i].removeTag(m[2])) n++
    }
    return n
  }
  if (/^(team|tag|kill|ride|data|execute|summon|particle|effect|tp|teleport|scoreboard|attribute|item) /.test(c)) {
    __pneVisMock.unknown.push(c)
    return 0
  }
  return undefined
}
