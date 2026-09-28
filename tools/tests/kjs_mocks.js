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

var __pneMock = { handlers: {}, uuidN: 0, opts: { typeAsObject: false, noEncodeId: false, mojangNames: false } }

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

var Java = (typeof Java !== 'undefined') ? Java : {
  loadClass: function (n) {
    if (n === 'java.util.ArrayList') return __pneMockArrayList
    throw new Error('mock: class ' + n + ' not available')
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
    persistentData: __pneMock.nbt()
  }
  srv.level = { dimension: 'minecraft:overworld', server: srv }
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
