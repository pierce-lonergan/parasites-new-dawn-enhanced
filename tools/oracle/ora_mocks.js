// ORACLE test prelude: extends tools/tests/kjs_mocks.js with what pne_oracle_bridge.js touches.
// ES5; runs unchanged in Node (tools/tests/kjs_node.js) and in the real Rhino fork (tools/rhino/pne_rhino.py run).
// Load order: kjs_mocks.js, this file, pne_00_core.js, pne_oracle_bridge.js, then the test.
//
//   __pneOraMock.world(srv)                 level.getBlock / getEntitiesWithin / getDayTime on srv.level; srv.isDedicated
//   __pneOraMock.equip(player, opts)        player getters the extractor calls (yaw, eye, food, stance, item, sight)
//   __pneOraMock.damage(msgId, entity)      a DamageSource shaped as scripts see it in game (getType, getActual,
//                                           getImmediate); __pneMock.damage keeps the Mojang names for the fallback
//   __pneOraMock.addMob(srv, id, x, y, z, visible)
// Methods that KubeJS renames for scripts (IMPLEMENTATION F37) exist here only under the name scripts see in game
// (getYaw, isDedicated, getActual), so a call of a hidden Mojang name fails these tests as it would fail in game.
//   __pneOraMock.item(id, opts)             an ItemStack stand-in (getId, isEmpty, isEdible, isBlock)
//   __pneOraMock.block(id, opts)            a BlockContainerJS stand-in (for BlockEvents.placed)
//   JsonIO                                  read/write on an in-memory file map (__pneOraMock.io). In Rhino, read()
//                                           parses with the real Gson (JsonParser) and converts with the Rhino fork's
//                                           own JsonUtils.toObject, exactly like KubeJS's JsonIO.read (MapJS.of ->
//                                           JsonUtils.toObject): java.util.LinkedHashMap / ArrayList whose numbers are
//                                           com.google.gson.internal.LazilyParsedNumber and whose numeric-looking
//                                           strings (boot_id!) come back as LazilyParsedNumber too. Without Gson it falls
//                                           back to LinkedHashMap / ArrayList with java.lang.Double / String. In Node it
//                                           returns objects whose numbers, strings and booleans are wrapper objects, so
//                                           === on an unconverted value fails everywhere.
// Parasite ids: the core falls back to pne_horror.js's PNE_H_HIVE / PNE_H_SPORE sets when the entity-type
// tags are unreachable (no Minecraft classes here), so this prelude defines small ones.

var PNE_H_HIVE = { 'epca:ripper': true, 'epca:infested_zombie': true, 'epca:curbug': true }
var PNE_H_SPORE = { 'spore:inf_human': true, 'spore:brute': true }

var __pneOraMock = {
  io: { files: {}, torn: {}, failWrite: false, writes: 0, reads: 0 },
  calls: { query: 0, casts: 0, blocks: 0 },
  java: null
}

try {
  __pneOraMock.java = {
    Map: Java.loadClass('java.util.LinkedHashMap'),
    List: Java.loadClass('java.util.ArrayList'),
    Double: Java.loadClass('java.lang.Double'),
    Boolean: Java.loadClass('java.lang.Boolean')
  }
} catch (e) {
  __pneOraMock.java = null
}
__pneOraMock.gson = null
try {
  __pneOraMock.gson = {
    Parser: Java.loadClass('com.google.gson.JsonParser'),
    Utils: Java.loadClass('dev.latvian.mods.rhino.mod.util.JsonUtils')
  }
} catch (e) {
  __pneOraMock.gson = null
}

// Plain parsed JSON -> the shape JsonIO.read returns on this platform.
__pneOraMock.toHost = function (v) {
  var J = __pneOraMock.java
  var out
  var i
  var k
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return J ? J.Double.valueOf(v) : new Number(v) // eslint-disable-line no-new-wrappers
  if (typeof v === 'string') return J ? v : new String(v) // eslint-disable-line no-new-wrappers
  if (typeof v === 'boolean') return J ? J.Boolean.valueOf(v) : new Boolean(v) // eslint-disable-line no-new-wrappers
  if (Object.prototype.toString.call(v) === '[object Array]') {
    out = J ? new J.List() : []
    for (i = 0; i < v.length; i++) {
      if (J) out.add(__pneOraMock.toHost(v[i]))
      else out.push(__pneOraMock.toHost(v[i]))
    }
    return out
  }
  out = J ? new J.Map() : {}
  for (k in v) {
    if (!v.hasOwnProperty(k)) continue
    if (J) out.put(k, __pneOraMock.toHost(v[k]))
    else out[k] = __pneOraMock.toHost(v[k])
  }
  return out
}

var JsonIO = {
  write: function (path, obj) {
    if (__pneOraMock.io.failWrite) throw new Error('java.nio.file.NoSuchFileException: ' + path)
    __pneOraMock.io.files[String(path)] = JSON.stringify(obj)
    __pneOraMock.io.writes++
  },
  read: function (path) {
    var p = String(path)
    __pneOraMock.io.reads++
    if (__pneOraMock.io.torn[p]) throw new Error('com.google.gson.JsonSyntaxException: torn ' + p)
    if (!__pneOraMock.io.files.hasOwnProperty(p)) return null
    if (__pneOraMock.gson) return __pneOraMock.gson.Utils.toObject(__pneOraMock.gson.Parser.parseString(__pneOraMock.io.files[p]))
    return __pneOraMock.toHost(JSON.parse(__pneOraMock.io.files[p]))
  }
}

// Test helpers for the file map
__pneOraMock.put = function (path, obj) { __pneOraMock.io.files[path] = JSON.stringify(obj) }
__pneOraMock.get = function (path) {
  return __pneOraMock.io.files.hasOwnProperty(path) ? JSON.parse(__pneOraMock.io.files[path]) : null
}
__pneOraMock.raw = function (path) {
  return __pneOraMock.io.files.hasOwnProperty(path) ? __pneOraMock.io.files[path] : ''
}

__pneOraMock.block = function (id, opts) {
  var o = opts || {}
  var st = {
    isSolid: function () { return o.solid === true },
    isAir: function () { return o.solid !== true },
    getLightEmission: function () { return o.emit || 0 }
  }
  return {
    getId: function () { return id },
    getLight: function () { return o.light === undefined ? 15 : o.light },
    getCanSeeSky: function () { return o.sky === true },
    getBlockState: function () { return st }
  }
}

__pneOraMock.world = function (srv) {
  var lv = srv.level
  lv.mobs = []
  lv.solid = {}
  lv.lightAt = 15
  lv.skyAt = true
  srv.dayTime = 6000
  // In game KubeJS shows MinecraftServer.isDedicatedServer() only as isDedicated() (IMPLEMENTATION F37).
  srv.isDedicated = function () { return srv.dedicated === true }
  lv.getDayTime = function () { return srv.dayTime }
  lv.getBlock = function (x, y, z) {
    var k = Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z)
    __pneOraMock.calls.blocks++
    return __pneOraMock.block(lv.solid[k] ? 'minecraft:stone' : 'minecraft:air', { solid: lv.solid[k] === true, light: lv.lightAt, sky: lv.skyAt })
  }
  lv.getEntitiesWithin = function (box) {
    var out = []
    var i
    var e
    __pneOraMock.calls.query++
    for (i = 0; i < srv.players.length; i++) out.push(srv.players[i])
    for (i = 0; i < lv.mobs.length; i++) {
      e = lv.mobs[i]
      if (e.x >= box.minX && e.x <= box.maxX && e.y >= box.minY && e.y <= box.maxY && e.z >= box.minZ && e.z <= box.maxZ) out.push(e)
    }
    return __pneMock.list(out)
  }
  return lv
}

__pneOraMock.addMob = function (srv, id, x, y, z, visible) {
  var m = __pneMock.mob(srv, id, { x: x, y: y, z: z })
  m.visible = visible === true
  srv.level.mobs.push(m)
  return m
}

__pneOraMock.item = function (id, opts) {
  var o = opts || {}
  return {
    getId: function () { return id },
    isEmpty: function () { return id === 'minecraft:air' },
    isEdible: function () { return o.food === true },
    isBlock: function () { return o.block === true }
  }
}

__pneOraMock.equip = function (p, opts) {
  var o = opts || {}
  p.yaw = o.yaw || 0
  p.food = o.food === undefined ? 20 : o.food
  p.sneak = o.sneak === true
  p.sprint = o.sprint === true
  p.item = o.item || __pneOraMock.item('minecraft:air')
  // KubeJS renames Entity.getYRot() to getYaw() (F37): in game getYRot is undefined on a player.
  p.getYaw = function () { return p.yaw }
  p.getEyeY = function () { return p.y + 1.62 }
  p.getFoodLevel = function () { return p.food }
  p.isCrouching = function () { return p.sneak }
  p.isSprinting = function () { return p.sprint }
  p.getMainHandItem = function () { return p.item }
  p.canEntityBeSeen = function (e) { __pneOraMock.calls.casts++; return e.visible === true }
  p.distanceToSqr = function (e) {
    var dx = e.x - p.x
    var dy = e.y - p.y
    var dz = e.z - p.z
    return dx * dx + dy * dy + dz * dz
  }
  return p
}

// DamageSource as a script sees it in game: KubeJS renames getMsgId/getEntity/getDirectEntity to
// getType/getActual/getImmediate (F36, F37), so the Mojang names are absent. entity = the causer (the owner for
// projectiles), direct = the projectile (defaults to entity).
__pneOraMock.damage = function (msgId, entity, direct) {
  return {
    getType: function () { return msgId },
    getActual: function () { return entity || null },
    getImmediate: function () { return direct || entity || null }
  }
}

// Fires one hurt event the way KubeJS does: the generic handler and the type-filtered one.
__pneOraMock.hurt = function (victim, source, amount) {
  var ev = { entity: victim, source: source, damage: amount }
  __pneMock.fire('EntityEvents.hurt', ev)
  __pneMock.fire('EntityEvents.hurt:' + victim.typeId, ev)
}

__pneOraMock.placed = function (player, block) {
  __pneMock.fire('BlockEvents.placed', { entity: player, block: block })
}
