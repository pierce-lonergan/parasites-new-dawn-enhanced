// Shared KubeJS mock world for tests of server scripts. ES5, runs unchanged in Node (tools/tests/kjs_node.js)
// and in the real Rhino fork (tools/rhino/pne_rhino.py run). Load it BEFORE the scripts under test.
// It mocks only what the Hive Remembers modules touch; extend it in your own test prelude, not here
// (this file is owned by the core; ask the lead for additions that every module needs).
//
// What it provides (all names start with __pneMock or are the KubeJS event groups):
//   ServerEvents, PlayerEvents, EntityEvents, BlockEvents, LevelEvents, ForgeEvents, NetworkEvents: record
//                                   handlers (ForgeEvents.onEvent(cls, fn) -> key 'ForgeEvents.onEvent:<cls>').
//   __pneMock.fire(key, event)      call handlers; key 'Group.name' or 'Group.name:extraId'
//   __pneMock.server(opts)          mock MinecraftServer (tick count, game time, persistentData, commands)
//   __pneMock.player(srv, name, uuid, opts) / __pneMock.mob(srv, typeId, opts)
//   __pneMock.tick(srv, n)          advance n ticks and fire ServerEvents.tick each time
//   __pneMock.brig()                a small JS Brigadier (literal/argument/then/executes, greedy strings)
//   __pneMock.source(srv, player, level)  a command source (hasPermission, getPlayer, getServer)
//   __pneMock.nbt()                 a CompoundTag stand-in (contains/get*/put*/remove, getCompound/put like Java:
//                                   getCompound of a missing key returns a NEW detached tag; put attaches it)
//   __pneMock.damage(msgId, entity, direct)  a DamageSource stand-in (getType, getActual, getImmediate)
//   __pneMock.opts                  switches for platform shapes a test wants to exercise:
//                                     typeAsObject: entities made afterwards expose entity.type as an EntityType-like
//                                       object whose String() is 'entity.<ns>.<path>' (the pre-shadowing shape)
//                                     noEncodeId: entities made afterwards have no getEncodeId()
//                                     mojangNames: servers, levels, entities and damage sources made afterwards ALSO
//                                       answer to the Mojang names KubeJS hides in game (getGameTime, getMsgId,
//                                       getEntity, getDirectEntity, getYRot, getXRot, isDedicatedServer); only for a
//                                       test of a mock-fallback path, never to make module code pass
// The game shape by default (contract F37): KubeJS renames some Minecraft methods with @RemapForJS on its mixins'
// @Shadow methods, so scripts see them ONLY under the KubeJS name. The mocks expose the same names: the level has
// getTime() and getDimensionKey() (no getGameTime/dimension()), damage sources getType()/getActual()/getImmediate()
// (no getMsgId/getEntity/getDirectEntity), entities getYaw()/getPitch() (no getYRot/getXRot), the server
// isDedicated() (no isDedicatedServer). A module that calls a hidden name without the KubeJS name first fails here
// the way it fails in game.
// Entities also carry getForgePersistentData() (a separate tag) and getEntityType(), like the game, where
// KubeJS renames Forge's getPersistentData and vanilla getType (@Shadow @RemapForJS merged by Mixin).
// In Rhino the harness binds global (a java.util.HashMap: values read back are wrapped Java objects),
// console and Java; in Node the runner binds a global that wraps numbers and strings the same way, and this
// file provides Java.loadClass('java.util.ArrayList') as a small shim (add, size, get, remove, clear,
// isEmpty). Code that touches global or the startup queues must also be tested in Rhino.
//
// Contract 1.5 additions (difficulty profiles, the Recruits-safe start):
//   * Java.loadClass answers __pneMock.classes first (in Node and in Rhino): the vanilla enums
//     'net.minecraft.world.scores.Team$Visibility' (ALWAYS, NEVER, HIDE_FOR_OTHER_TEAMS, HIDE_FOR_OWN_TEAM) and
//     'net.minecraft.world.scores.Team$CollisionRule' (ALWAYS, NEVER, PUSH_OTHER_TEAMS, PUSH_OWN_TEAM); String(constant)
//     is its name ('NEVER'), like a Java enum. Everything else goes to the harness's own loader.
//   * the server: srv.difficulty (0..3, default 3 = Hard, the behaviour of release 1.4) and srv.hardcore, read through
//     level.getDifficulty().getId(), server.getWorldData().getDifficulty().getId() and server.isHardcore() (set
//     srv.difficultyBroken = true to make the level read throw); server.getAllLevels() (a Java-like Iterable of the
//     overworld and srv.extraLevels); server.getScoreboard(), the ServerScoreboard Java API over srv.sb (below).
//   * __pneMock.scoreboard(srv): getPlayerTeam(name), getPlayersTeam(entry), addPlayerTeam(name) (throws when it
//     exists, like vanilla), removePlayerTeam(team), getPlayerTeams(), addPlayerToTeam(entry, team) (moves the entry),
//     removePlayerFromTeam(entry) (boolean) / removePlayerFromTeam(entry, team) (throws when the entry is not on it); a
//     team: getName, getPlayers, set/getNameTagVisibility, set/getCollisionRule, setAllowFriendlyFire /
//     isAllowFriendlyFire, setSeeFriendlyInvisibles / canSeeFriendlyInvisibles. The storage srv.sb = { teams: { name: {
//     name, nametagVisibility: 'always'|'never'|..., collisionRule: 'always'|..., members: { entry: true },
//     friendlyFire, seeFriendlyInvisibles } }, byEntry: { entry: name } } is the one VISUAL's command interpreter
//     (tools/visual/vis_prelude.js) uses, and the API reads srv.sb at call time, so both agree on one scoreboard.
//     srv.noScoreboard = true makes getScoreboard() throw.
//   * __pneMock.epca(opts): EPCA's WorldDifficultyData / DifficultyLevel for the core's test seam: assign
//     $PneCoreEpcaWDD = E.WDD and $PneCoreEpcaDL = E.DL. E.tiers maps a dimension id to its tier id (default: overworld
//     2 = EXPERT, any other dimension 1 = NORMAL, EPCA's own default), E.writes logs every setDifficulty, E.broken = true
//     makes get() throw. DifficultyLevel ids: EASY 0, NORMAL 1, EXPERT 2, MASTER 3, CUSTOM 4, LEGENDARY 5; fromId of an
//     unknown id gives NORMAL (as EPCA's does).
//   * nbt tags answer getAllKeys() (a Java-like Set).

var __pneMock = { handlers: {}, uuidN: 0, opts: { typeAsObject: false, noEncodeId: false, mojangNames: false }, classes: {} }

function __pneMockReg(group, name) {
  return function (a, b) {
    var fn = typeof a === 'function' ? a : b
    var key = group + '.' + name + (typeof a === 'function' ? '' : ':' + String(a))
    if (!__pneMock.handlers[key]) __pneMock.handlers[key] = []
    __pneMock.handlers[key].push(fn)
  }
}

function __pneMockGroup(group, names) {
  var g = {}
  var i
  for (i = 0; i < names.length; i++) g[names[i]] = __pneMockReg(group, names[i])
  return g
}

var ServerEvents = __pneMockGroup('ServerEvents', ['tick', 'loaded', 'unloaded', 'commandRegistry', 'tags', 'recipes', 'customCommand'])
var PlayerEvents = __pneMockGroup('PlayerEvents', ['loggedIn', 'loggedOut', 'respawned', 'tick', 'chat', 'advancement'])
var EntityEvents = __pneMockGroup('EntityEvents', ['spawned', 'death', 'hurt', 'checkSpawn'])
var BlockEvents = __pneMockGroup('BlockEvents', ['placed', 'broken', 'rightClicked', 'leftClicked'])
var LevelEvents = __pneMockGroup('LevelEvents', ['loaded', 'unloaded', 'tick'])
var ForgeEvents = __pneMockGroup('ForgeEvents', ['onEvent'])
var NetworkEvents = __pneMockGroup('NetworkEvents', ['dataReceived'])

function __pneMockArrayList() {
  var a = []
  this.a = a
  this.add = function (v) { a.push(v); return true }
  this.size = function () { return a.length }
  this.get = function (i) { if (i < 0 || i >= a.length) throw new Error('IndexOutOfBounds ' + i); return a[i] }
  this.remove = function (i) { if (i < 0 || i >= a.length) throw new Error('IndexOutOfBounds ' + i); return a.splice(i, 1)[0] }
  this.clear = function () { a.length = 0 }
  this.isEmpty = function () { return a.length === 0 }
}

// A Java-like Iterable over a JS array (iterator, size, get).
function __pneMockIterable(arr) {
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

// A Java-like enum: constants are objects whose String() is the constant name; values() lists them.
function __pneMockEnum(names, ids) {
  var E = { __all: [] }
  var i
  for (i = 0; i < names.length; i++) {
    E[names[i]] = (function (name, id, ord) {
      return { __enum: true, id: id, ordinal: function () { return ord }, name: function () { return name }, toString: function () { return name } }
    })(names[i], ids[i], i)
    E.__all.push(E[names[i]])
  }
  E.values = function () { return E.__all.slice(0) }
  E.byId = function (id) {
    var j
    for (j = 0; j < E.__all.length; j++) {
      if (E.__all[j].id === id) return E.__all[j]
    }
    return null
  }
  return E
}

__pneMock.classes['net.minecraft.world.scores.Team$Visibility'] = __pneMockEnum(['ALWAYS', 'NEVER', 'HIDE_FOR_OTHER_TEAMS', 'HIDE_FOR_OWN_TEAM'],
  ['always', 'never', 'hideForOtherTeams', 'hideForOwnTeam'])
__pneMock.classes['net.minecraft.world.scores.Team$CollisionRule'] = __pneMockEnum(['ALWAYS', 'NEVER', 'PUSH_OTHER_TEAMS', 'PUSH_OWN_TEAM'],
  ['always', 'never', 'pushOtherTeams', 'pushOwnTeam'])

// __pneMock.classes first (Node and Rhino), then the harness's loader (Rhino), else the Node shims.
var __pneMockJava0 = (typeof Java !== 'undefined') ? Java : null
var Java = {
  loadClass: function (n) {
    var k = String(n)
    if (__pneMock.classes.hasOwnProperty(k)) return __pneMock.classes[k]
    if (__pneMockJava0) return __pneMockJava0.loadClass(k)
    if (k === 'java.util.ArrayList') return __pneMockArrayList
    throw new Error('mock: class ' + k + ' not available')
  }
}

__pneMock.fire = function (key, event) {
  var hs = __pneMock.handlers[key] || []
  var i
  for (i = 0; i < hs.length; i++) hs[i](event)
  return hs.length
}

__pneMock.list = function (arr) {
  return { size: function () { return arr.length }, get: function (i) { return arr[i] }, arr: arr }
}

__pneMock.nbt = function () {
  var m = {}
  return {
    m: m,
    isMockNbt: true,
    contains: function (k) { return m.hasOwnProperty(k) },
    getAllKeys: function () {
      var ks = []
      var k
      for (k in m) {
        if (m.hasOwnProperty(k)) ks.push(k)
      }
      return __pneMockIterable(ks)
    },
    getCompound: function (k) { return (m.hasOwnProperty(k) && m[k] && m[k].isMockNbt) ? m[k] : __pneMock.nbt() },
    put: function (k, v) { m[k] = v; return null },
    remove: function (k) { delete m[k] },
    getInt: function (k) { return m.hasOwnProperty(k) ? Math.floor(Number(m[k])) : 0 },
    getLong: function (k) { return m.hasOwnProperty(k) ? Math.floor(Number(m[k])) : 0 },
    getDouble: function (k) { return m.hasOwnProperty(k) ? Number(m[k]) : 0 },
    getFloat: function (k) { return m.hasOwnProperty(k) ? Number(m[k]) : 0 },
    getByte: function (k) { return m.hasOwnProperty(k) ? Math.floor(Number(m[k])) : 0 },
    getBoolean: function (k) { return m.hasOwnProperty(k) ? Number(m[k]) !== 0 : false },
    getString: function (k) { return m.hasOwnProperty(k) ? String(m[k]) : '' },
    putInt: function (k, v) { m[k] = Math.floor(Number(v)) },
    putLong: function (k, v) { m[k] = Math.floor(Number(v)) },
    putDouble: function (k, v) { m[k] = Number(v) },
    putFloat: function (k, v) { m[k] = Number(v) },
    putByte: function (k, v) { m[k] = Math.floor(Number(v)) },
    putBoolean: function (k, v) { m[k] = v ? 1 : 0 },
    putString: function (k, v) { m[k] = String(v) }
  }
}

__pneMock.server = function (opts) {
  var o = opts || {}
  var srv = {
    tickCount: o.tickCount || 0,
    gameTime: o.gameTime || 1000,
    players: [],
    cmds: [],
    cmdResults: o.cmdResults || { seed: 123456789 },
    owner: o.owner || '',
    persistentData: __pneMock.nbt(),
    difficulty: o.difficulty === undefined ? 3 : o.difficulty,
    hardcore: o.hardcore === true,
    difficultyBroken: false,
    extraLevels: [],
    sb: { teams: {}, byEntry: {} },
    noScoreboard: false
  }
  srv.level = { dimension: 'minecraft:overworld', server: srv }
  // Level.getDifficulty() / Difficulty.getId() (Mojang names, not hidden by KubeJS), read at call time
  srv.level.getDifficulty = function () {
    if (srv.difficultyBroken) throw new Error('mock: difficulty unreadable')
    return __pneMock.difficulty(srv.difficulty)
  }
  srv.getWorldData = function () {
    return {
      getDifficulty: function () { return __pneMock.difficulty(srv.difficulty) },
      isHardcore: function () { return srv.hardcore }
    }
  }
  srv.isHardcore = function () { return srv.hardcore }
  srv.getAllLevels = function () { return __pneMockIterable([srv.level].concat(srv.extraLevels)) }
  srv.getScoreboard = function () {
    if (srv.noScoreboard) throw new Error('mock: scoreboard unavailable')
    return __pneMock.scoreboard(srv)
  }
  srv.level.getTime = function () { return srv.gameTime }
  srv.level.getDimensionKey = function () { return { location: function () { return 'minecraft:overworld' } } }
  if (__pneMock.opts.mojangNames) srv.level.getGameTime = function () { return srv.gameTime }
  srv.level.getDimension = function () { return 'minecraft:overworld' }
  srv.level.getServer = function () { return srv }
  srv.level.players = function () { return __pneMock.list(srv.players) }
  srv.level.getPlayers = srv.level.players
  srv.getTickCount = function () { return srv.tickCount }
  srv.getOverworld = function () { return srv.level }
  srv.overworld = function () { return srv.level }
  srv.getPlayers = function () { return __pneMock.list(srv.players) }
  srv.getPlayerList = function () { return { getPlayers: function () { return __pneMock.list(srv.players) } } }
  srv.getPersistentData = function () { return srv.persistentData }
  srv.isDedicated = function () { return o.dedicated === true }
  if (__pneMock.opts.mojangNames) srv.isDedicatedServer = function () { return o.dedicated === true }
  srv.isSingleplayerOwner = function (profile) { return srv.owner !== '' && String(profile.getName()) === srv.owner }
  srv.runCommandSilent = function (cmd) {
    var c = String(cmd)
    var k
    srv.cmds.push(c)
    for (k in srv.cmdResults) {
      if (srv.cmdResults.hasOwnProperty(k) && c.indexOf(k) === 0) return srv.cmdResults[k]
    }
    return 1
  }
  srv.runCommand = srv.runCommandSilent
  return srv
}

// Minecraft's Difficulty enum stand-in: getId() 0..3, String() 'PEACEFUL'..'HARD'.
__pneMock.difficulty = function (id) {
  var names = ['PEACEFUL', 'EASY', 'NORMAL', 'HARD']
  var n = Number(id)
  return {
    getId: function () { return n },
    getKey: function () { return (names[n] || '?').toLowerCase() },
    toString: function () { return names[n] || String(n) }
  }
}

// The ServerScoreboard Java API over srv.sb (see the header). Team objects are made on each lookup; state lives in srv.sb.
__pneMock.scoreboard = function (srv) {
  var V = __pneMock.classes['net.minecraft.world.scores.Team$Visibility']
  var C = __pneMock.classes['net.minecraft.world.scores.Team$CollisionRule']
  function rec(name) { return srv.sb.teams.hasOwnProperty(name) ? srv.sb.teams[name] : null }
  function leave(entry) {
    var t = srv.sb.byEntry[entry]
    if (!t) return false
    if (srv.sb.teams[t]) delete srv.sb.teams[t].members[entry]
    delete srv.sb.byEntry[entry]
    return true
  }
  function team(name) {
    return {
      __team: name,
      getName: function () { return name },
      getPlayers: function () {
        var r = rec(name)
        var ks = []
        var k
        if (r) {
          for (k in r.members) {
            if (r.members.hasOwnProperty(k)) ks.push(k)
          }
        }
        return __pneMockIterable(ks)
      },
      setNameTagVisibility: function (v) { var r = rec(name); if (r && v) r.nametagVisibility = v.id },
      getNameTagVisibility: function () { var r = rec(name); return r ? (V.byId(r.nametagVisibility) || V.ALWAYS) : V.ALWAYS },
      setCollisionRule: function (c) { var r = rec(name); if (r && c) r.collisionRule = c.id },
      getCollisionRule: function () { var r = rec(name); return r ? (C.byId(r.collisionRule) || C.ALWAYS) : C.ALWAYS },
      setAllowFriendlyFire: function (b) { var r = rec(name); if (r) r.friendlyFire = b ? true : false },
      isAllowFriendlyFire: function () { var r = rec(name); return r ? r.friendlyFire !== false : true },
      setSeeFriendlyInvisibles: function (b) { var r = rec(name); if (r) r.seeFriendlyInvisibles = b ? true : false },
      canSeeFriendlyInvisibles: function () { var r = rec(name); return r ? r.seeFriendlyInvisibles !== false : true }
    }
  }
  return {
    getPlayerTeam: function (n) { return rec(String(n)) ? team(String(n)) : null },
    getPlayersTeam: function (entry) {
      var t = srv.sb.byEntry[String(entry)]
      return t && rec(t) ? team(t) : null
    },
    addPlayerTeam: function (n) {
      var k = String(n)
      if (rec(k)) throw new Error('IllegalArgumentException: A team with the name \'' + k + '\' already exists!')
      srv.sb.teams[k] = { name: k, nametagVisibility: 'always', collisionRule: 'always', members: {}, friendlyFire: true, seeFriendlyInvisibles: true }
      return team(k)
    },
    removePlayerTeam: function (t) {
      var k = String(t.getName())
      var r = rec(k)
      var e
      if (!r) return
      for (e in r.members) {
        if (r.members.hasOwnProperty(e)) delete srv.sb.byEntry[e]
      }
      delete srv.sb.teams[k]
    },
    getPlayerTeams: function () {
      var out = []
      var k
      for (k in srv.sb.teams) {
        if (srv.sb.teams.hasOwnProperty(k)) out.push(team(k))
      }
      return __pneMockIterable(out)
    },
    addPlayerToTeam: function (entry, t) {
      var e = String(entry)
      var k = String(t.getName())
      var r = rec(k)
      if (!r) return false
      if (srv.sb.byEntry[e] === k) return false
      leave(e)
      r.members[e] = true
      srv.sb.byEntry[e] = k
      return true
    },
    removePlayerFromTeam: function (entry, t) {
      var e = String(entry)
      if (t !== undefined && t !== null) {
        if (srv.sb.byEntry[e] !== String(t.getName())) throw new Error('IllegalStateException: Player is either on another team or not on any team.')
        return leave(e)
      }
      return leave(e)
    }
  }
}

// EPCA's per-level tier classes for the core's test seam (see the header).
__pneMock.epca = function (opts) {
  var o = opts || {}
  var E = { tiers: {}, writes: [], broken: false, gets: 0 }
  var names = ['EASY', 'NORMAL', 'EXPERT', 'MASTER', 'CUSTOM', 'LEGENDARY']
  var DL = { __all: [] }
  var k
  var i
  for (i = 0; i < names.length; i++) {
    DL[names[i]] = (function (name, id) {
      return { getId: function () { return id }, getName: function () { return name.toLowerCase() }, toString: function () { return name } }
    })(names[i], i)
    DL.__all.push(DL[names[i]])
  }
  DL.fromId = function (n) {
    var j
    for (j = 0; j < DL.__all.length; j++) {
      if (DL.__all[j].getId() === Number(n)) return DL.__all[j]
    }
    return DL.NORMAL
  }
  E.tiers['minecraft:overworld'] = 2
  if (o.tiers) {
    for (k in o.tiers) {
      if (o.tiers.hasOwnProperty(k)) E.tiers[k] = o.tiers[k]
    }
  }
  function dimOf(level) {
    var d = ''
    try { d = String(level.getDimension()) } catch (e) { d = '' }
    if (d.indexOf(':') > 0) return d
    try { d = String(level.dimension) } catch (e2) { d = '' }
    return d.indexOf(':') > 0 ? d : 'minecraft:overworld'
  }
  E.WDD = {
    get: function (level) {
      var dim = dimOf(level)
      E.gets++
      if (E.broken) throw new Error('mock: EPCA data unavailable')
      if (!E.tiers.hasOwnProperty(dim)) E.tiers[dim] = 1
      return {
        getDifficulty: function () { return DL.fromId(E.tiers[dim]) },
        setDifficulty: function (v) {
          E.tiers[dim] = Number(v.getId())
          E.writes.push({ dim: dim, id: Number(v.getId()) })
        }
      }
    }
  }
  E.DL = DL
  return E
}

__pneMock.entity = function (srv, typeId, opts) {
  var o = opts || {}
  var tags = {}
  var e
  var ns = String(typeId).split(':')[0]
  var path = String(typeId).split(':').slice(1).join(':')
  var typeObj = { id: typeId, toString: function () { return 'entity.' + ns + '.' + path } }
  __pneMock.uuidN++
  e = {
    type: __pneMock.opts.typeAsObject ? typeObj : typeId,
    typeId: typeId,
    uuid: o.uuid || ('00000000-0000-4000-8000-' + ('000000000000' + __pneMock.uuidN).slice(-12)),
    hp: o.hp === undefined ? 20 : o.hp,
    maxHp: o.maxHp === undefined ? 20 : o.maxHp,
    x: o.x || 0, y: o.y === undefined ? 64 : o.y, z: o.z || 0,
    yaw: o.yaw || 0, pitch: o.pitch || 0,
    server: srv,
    level: srv.level,
    persistentData: __pneMock.nbt(),
    forgeData: __pneMock.nbt(),
    removed: false,
    tagSet: tags
  }
  e.getTags = function () { return { contains: function (t) { return tags.hasOwnProperty(t) } } }
  e.addTag = function (t) { if (tags.hasOwnProperty(t)) return false; tags[t] = true; return true }
  e.removeTag = function (t) { if (!tags.hasOwnProperty(t)) return false; delete tags[t]; return true }
  e.getHealth = function () { return e.hp }
  e.getMaxHealth = function () { return e.maxHp }
  e.isPlayer = function () { return e.typeId === 'minecraft:player' }
  e.getEntityType = function () { return typeObj }
  if (!__pneMock.opts.noEncodeId) e.getEncodeId = function () { return e.typeId === 'minecraft:player' ? null : e.typeId }
  e.getForgePersistentData = function () { return e.forgeData }
  e.getStringUuid = function () { return e.uuid }
  e.getUuid = function () { return e.uuid }
  e.getPersistentData = function () { return e.persistentData }
  e.getServer = function () { return srv }
  e.getLevel = function () { return srv.level }
  e.getX = function () { return e.x }
  e.getY = function () { return e.y }
  e.getZ = function () { return e.z }
  e.getYaw = function () { return e.yaw }
  e.getPitch = function () { return e.pitch }
  if (__pneMock.opts.mojangNames) {
    e.getYRot = function () { return e.yaw }
    e.getXRot = function () { return e.pitch }
  }
  e.discard = function () { e.removed = true }
  e.isAlive = function () { return !e.removed && e.hp > 0 }
  return e
}

__pneMock.player = function (srv, name, uuid, opts) {
  var o = opts || {}
  var p = __pneMock.entity(srv, 'minecraft:player', { uuid: uuid, hp: o.hp, maxHp: o.maxHp, x: o.x, y: o.y, z: o.z })
  p.name = name
  p.spectator = o.spectator === true
  p.creative = o.creative === true
  p.isSpectator = function () { return p.spectator }
  p.isCreative = function () { return p.creative }
  p.getGameProfile = function () { return { getName: function () { return p.name } } }
  p.username = name
  srv.players.push(p)
  return p
}

__pneMock.mob = function (srv, typeId, opts) {
  return __pneMock.entity(srv, typeId, opts)
}

// DamageSource stand-in: msgId like 'mob', 'arrow', 'fall', 'outOfWorld', 'genericKill'; entity = the causer
// (for projectiles, the owner), or null; direct = the direct entity (the projectile), default the causer. The KubeJS
// names only (F37: getType = getMsgId, getActual = getEntity, getImmediate = getDirectEntity); the Mojang names too
// under __pneMock.opts.mojangNames.
__pneMock.damage = function (msgId, entity, direct) {
  var s = {
    getType: function () { return msgId },
    getActual: function () { return entity || null },
    getImmediate: function () { return direct || entity || null },
    isIndirect: function () { return !!(direct && entity && direct !== entity) }
  }
  if (__pneMock.opts.mojangNames) {
    s.getMsgId = function () { return msgId }
    s.getEntity = function () { return entity || null }
    s.getDirectEntity = function () { return direct || entity || null }
  }
  return s
}

__pneMock.tick = function (srv, n) {
  var k = n > 0 ? n : 1
  var i
  for (i = 0; i < k; i++) {
    srv.tickCount++
    srv.gameTime++
    __pneMock.fire('ServerEvents.tick', { server: srv })
  }
}

__pneMock.source = function (srv, player, level) {
  return {
    getServer: function () { return srv },
    getPlayer: function () { return player || null },
    getEntity: function () { return player || null },
    hasPermission: function (l) { return (level || 0) >= l }
  }
}

// A small Brigadier: enough to test a command tree built with literal/argument/then/executes.
__pneMock.brig = function () {
  var roots = {}
  function node(kind, name, type) {
    var n = { kind: kind, name: name, type: type, kids: [], cmd: null, req: null }
    n.executes = function (fn) { n.cmd = fn; return n }
    n.then = function (k) { n.kids.push(k); return n }
    n.requires = function (p) { n.req = p; return n }
    return n
  }
  var b = {
    commands: {
      literal: function (name) { return node('lit', name, null) },
      argument: function (name, type) { return node('arg', name, type) }
    },
    arguments: {
      GREEDY_STRING: {
        create: function (ev) { return 'greedy' },
        getResult: function (ctx, name) { return ctx.args[name] }
      }
    },
    roots: roots
  }
  b.register = function (root) { roots[root.name] = root; return root }
  b.run = function (input, source) {
    var toks = String(input).split(' ')
    var cur = roots[toks[0]]
    var args = {}
    var i = 1
    var j
    var next
    var matched
    if (!cur) return -2
    while (i < toks.length) {
      next = null
      matched = false
      for (j = 0; j < cur.kids.length; j++) {
        if (cur.kids[j].kind === 'lit' && cur.kids[j].name === toks[i]) { next = cur.kids[j]; matched = true }
      }
      if (!matched) {
        for (j = 0; j < cur.kids.length; j++) {
          if (cur.kids[j].kind === 'arg' && cur.kids[j].type === 'greedy') {
            next = cur.kids[j]
            args[next.name] = toks.slice(i).join(' ')
            i = toks.length
            matched = true
          }
        }
      } else {
        i++
      }
      if (!matched) return -3
      if (next.req && !next.req(source)) return -4
      cur = next
    }
    if (!cur.cmd) return -5
    return cur.cmd({ getSource: function () { return source }, args: args })
  }
  b.event = function () {
    return { commands: b.commands, arguments: b.arguments, register: b.register }
  }
  return b
}
