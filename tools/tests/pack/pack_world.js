// Pack smoke test: the mock world (control scope). ES5, runs in the instance's Rhino jar through
// tools/tests/pack/PackRhino.java. Load order in the control scope:
//   tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js, tools/visual/vis_prelude.js, tools/oracle/ora_mocks.js,
//   this file, tools/tests/pack/pack_sim.js
// The module preludes are reused unchanged (entities with attribute instances, the visual command interpreter,
// the in-memory JsonIO); this file joins them into ONE world that the startup scope and the server scope share,
// the way the game hands the same Java objects to startup and server scripts:
//   * __pneMock.fire routes ForgeEvents.* keys to the startup scope and everything else to the current server scope;
//   * one removal path (PW.remove) for every entity: passengers and teams as vanilla does (vis_prelude), then the
//     EntityLeaveLevelEvent with the removal reason (the startup listeners read it);
//   * a command interpreter in front of the visual one, for the commands the rest of the pack issues (execute
//     chains with as/at/in/positioned/rotated/if|unless entity|block/run, selectors with type/tag/distance/gamemode/
//     scores/limit, summon, effect, playsound, stopsound, particle, tellraw, data merge Silent, item replace, time,
//     seed, scoreboard, tag, epca_evolution); every command is logged for the invariant checks;
//   * PW.opts.strictKjs: entities, levels, servers and damage sources expose only the names KubeJS leaves visible in
//     game (getTime, getDimensionKey, getType/getActual/getImmediate, getYaw, isDedicated; contract F37), instead of
//     both those and the Mojang names the module mocks use.

var PW = {
  srv: null,
  startup: null,
  server: null,
  opts: { strictKjs: false },
  uncaught: [],
  cancelled: [],
  cmdN: 0,
  cmdTick: {},
  onCommand: null,
  pending: [],
  playersByUuid: {},
  nextUuid: 1,
  sidecar: false,
  tellraws: []
}

// Console lines of every scope: { kind: 'server'|'startup', level, msg, t }
PW.logs = []
PW.log = function (kind, level, msg) {
  PW.logs.push({ kind: kind, level: level, msg: String(msg), t: PW.srv ? PW.srv.tickCount : -1 })
}

// Seeded random (xorshift32), installed as Math.random in every scope so a failure reproduces.
PW.seed = 20260927
PW.rand = function () {
  var s = PW.seed
  s ^= s << 13
  s >>>= 0
  s ^= s >>> 17
  s ^= s << 5
  s >>>= 0
  PW.seed = s === 0 ? 1 : s
  return PW.seed / 4294967296
}

// java.util.UUID with a seeded randomUUID (pids seed the director's RNG); fromString stays the real one.
PW.realUuid = null
try { PW.realUuid = Java.loadClass('java.util.UUID') } catch (e) { PW.realUuid = null }
PW.uuidClass = {
  fromString: function (s) { return PW.realUuid.fromString(String(s)) },
  randomUUID: function () {
    var h = ''
    var i
    for (i = 0; i < 4; i++) h += ('00000000' + (Math.floor(PW.rand() * 4294967296) >>> 0).toString(16)).slice(-8)
    return PW.realUuid.fromString(h.substring(0, 8) + '-' + h.substring(8, 12) + '-4' + h.substring(13, 16) + '-8' + h.substring(17, 20) + '-' + h.substring(20))
  }
}
__pneHiveMockClasses['java.util.UUID'] = PW.uuidClass

// ---------------------------------------------------------------------------------------------
// Event routing between the scopes

PW.fireIn = function (scope, key, ev) {
  var hs
  var i
  var n = 0
  if (!scope) return 0
  hs = scope.__pneMock.handlers[key]
  if (!hs) return 0
  for (i = 0; i < hs.length; i++) {
    n++
    try {
      hs[i](ev)
    } catch (err) {
      if (err && err.__pneExit) {
        PW.cancelled.push(key)
        return n
      }
      // KubeJS logs an uncaught handler exception and skips the remaining handlers of the event (F16).
      PW.uncaught.push({ t: PW.srv ? PW.srv.tickCount : 0, key: key, err: String(err) + (err && err.stack ? ' ' + String(err.stack).split('\n')[0] : '') })
      return n
    }
  }
  return n
}

__pneMock.fire = function (key, ev) {
  var k = String(key)
  if (k.indexOf('ForgeEvents.') === 0) return PW.fireIn(PW.startup, k, ev)
  return PW.fireIn(PW.server, k, ev)
}

// A KubeJS event with an extra id: the handlers for that id first, then the generic ones; cancel() is an EventExit.
PW.fireTyped = function (group, typeId, ev) {
  var n
  ev.cancelled = false
  ev.cancel = function () { ev.cancelled = true; throw { __pneExit: true } }
  n = PW.fireIn(PW.server, group + ':' + typeId, ev)
  if (!ev.cancelled) n += PW.fireIn(PW.server, group, ev)
  return n
}

// ---------------------------------------------------------------------------------------------
// Damage sources (msgId: 'mob', 'player', 'arrow', 'fall', 'outOfWorld', 'genericKill')

PW.source = function (msgId, causer, direct) {
  var s = {
    msg: msgId,
    getType: function () { return msgId },
    getActual: function () { return causer || null },
    getImmediate: function () { return direct || causer || null },
    isIndirect: function () { return !!(direct && causer && direct !== causer) },
    is: function (tag) { throw new Error('mock: no damage-type tags') }
  }
  if (!PW.opts.strictKjs) {
    s.getMsgId = function () { return msgId }
    s.getEntity = function () { return causer || null }
    s.getDirectEntity = function () { return direct || causer || null }
  }
  return s
}

// ---------------------------------------------------------------------------------------------
// Entities

PW.entity0 = __pneMock.entity
__pneMock.entity = function (srv, typeId, opts) {
  var e = PW.entity0(srv, typeId, opts)
  e.discard = function () { PW.remove(e, 'DISCARDED') }
  e.kill = function () { PW.killMob(e, PW.source('genericKill', null)) }
  e.getLevel = function () { return e.level }
  e.level = e.level || srv.level
  e.isOnGround = function () { return true }
  e.getBlockX = function () { return Math.floor(e.x) }
  e.getBlockY = function () { return Math.floor(e.y) }
  e.getBlockZ = function () { return Math.floor(e.z) }
  if (PW.opts.strictKjs) {
    delete e.getYRot
    delete e.getUUID
    delete e.getStringUUID
  }
  return e
}

PW.uuid = function () {
  var n = PW.nextUuid++
  return 'c0de' + ('0000' + (n % 65536).toString(16)).slice(-4) + '-0000-4000-8000-' + ('000000000000' + n.toString(16)).slice(-12)
}

// Removal: vanilla passenger/team rules (vis_prelude), then the leave event with its reason (startup listeners).
PW.remove = function (e, reason) {
  var i
  if (!e || e.removed) return false
  if (reason === 'UNLOADED_TO_CHUNK' || reason === 'UNLOADED_WITH_PLAYER') {
    for (i = 0; i < e.passengers.length; i++) {
      e.passengers[i].removed = true
      e.passengers[i].removalReason = reason
    }
    e.removed = true
  } else {
    __pneVisMockDestroy(PW.srv, e, reason === 'KILLED')
  }
  e.removed = true
  e.removalReason = reason
  __pneMock.fire(__PNE_HIVE_EV.leave, { getLevel: function () { return e.level }, getEntity: function () { return e } })
  return true
}

// EntityJoinLevelEvent (startup listeners), then KubeJS's EntityEvents.spawned (typed, then generic). Returns false
// when a spawned handler cancelled it (F19: the entity never enters the level).
PW.join = function (e, fromDisk) {
  var ev = { entity: e, level: e.level, server: PW.srv }
  __pneMock.fire(__PNE_HIVE_EV.join, { getLevel: function () { return e.level }, getEntity: function () { return e },
    loadedFromDisk: function () { return fromDisk === true } })
  PW.fireTyped('EntityEvents.spawned', e.typeId, ev)
  if (ev.cancelled) {
    e.removed = true
    e.removalReason = 'CANCELLED'
    return false
  }
  return true
}

PW.mobs = function () {
  var out = []
  var i
  var es = PW.srv.entities
  for (i = 0; i < es.length; i++) {
    if (!es[i].removed && es[i].typeId !== 'minecraft:player' && es[i].typeId !== 'minecraft:item_display') out.push(es[i])
  }
  return out
}

PW.isParasiteId = function (id) {
  var s = String(id)
  return s.indexOf('epca:') === 0 || s.indexOf('spore:') === 0
}

PW.spawnMob = function (typeId, x, y, z, fromDisk, tags) {
  var e = __pneMock.mob(PW.srv, typeId, { x: x, y: y, z: z, hp: 20, maxHp: 20 })
  var i
  if (tags) {
    for (i = 0; i < tags.length; i++) e.addTag(tags[i])
  }
  e.bornTick = PW.srv.tickCount
  if (!PW.join(e, fromDisk === true)) return null
  return e
}

// A chunk reload: the saved entity (persistent data, tags, Silent, permanent modifiers, health, name, held item and
// riding passengers) comes back as a NEW object with the same UUID and joins loaded from disk.
PW.copyNbt = function (src) {
  return __pneHiveNbtCopy(src)
}

PW.reload = function (e) {
  var n
  var k
  var id
  var inst
  var i
  var p
  var q
  PW.remove(e, 'UNLOADED_TO_CHUNK')
  n = __pneMock.mob(PW.srv, e.typeId, { uuid: e.uuid, x: e.x, y: e.y, z: e.z, hp: e.hp, maxHp: e.maxHp, attrs: e.attrBase,
    mainHand: e.mainHand, persist: e.persist, level: e.level, bodyYaw: e.bodyYaw })
  n.persistentData = PW.copyNbt(e.persistentData)
  n.getPersistentData = function () { return n.persistentData }
  for (k in e.tagSet) {
    if (e.tagSet.hasOwnProperty(k)) n.addTag(k)
  }
  n.silent = e.silent
  n.customName = e.customName
  n.bornTick = e.bornTick
  for (id in e.attrInst) {
    if (!e.attrInst.hasOwnProperty(id)) continue
    inst = n.getAttribute(id)
    for (k in e.attrInst[id].perm) {
      if (e.attrInst[id].perm.hasOwnProperty(k)) inst.perm[k] = e.attrInst[id].perm[k]
    }
  }
  for (i = 0; i < e.passengers.length; i++) {
    p = e.passengers[i]
    q = __pneMock.entity(PW.srv, p.typeId, { uuid: p.uuid, level: p.level, x: p.x, y: p.y, z: p.z })
    for (k in p.tagSet) {
      if (p.tagSet.hasOwnProperty(k)) q.addTag(k)
    }
    q.persistentData = PW.copyNbt(p.persistentData)
    q.getPersistentData = function () { return q.persistentData }
    q.item = p.item
    q.vehicle = n
    n.passengers.push(q)
  }
  PW.join(n, true)
  for (i = 0; i < n.passengers.length; i++) PW.join(n.passengers[i], true)
  return n
}

// ---------------------------------------------------------------------------------------------
// Players

PW.addPlayer = function (name, x, z, opts) {
  var o = opts || {}
  var p = __pneMock.player(PW.srv, name, o.uuid || PW.uuid(), { x: x, y: 64, z: z, hp: 20, maxHp: 20, creative: o.creative === true })
  __pneOraMock.equip(p, {})
  PW.playerExtras(p)
  PW.playersByUuid[p.uuid] = p
  return p
}

PW.playerExtras = function (p) {
  p.spawnX = p.x
  p.spawnZ = p.z
  p.getYaw = function () { return p.yaw }
  if (PW.opts.strictKjs) {
    delete p.getYRot
    delete p.getUUID
    delete p.getStringUUID
  }
  p.block = { getLight: function () { return PW.lightAt(p.x, p.y, p.z) } }
  p.getName = function () { return { getString: function () { return p.name } } }
  p.give = function () { }
}

// Respawn: vanilla makes a NEW ServerPlayer with the tags copied (F7); KubeJS copies persistentData (F9).
PW.respawn = function (old) {
  var i
  var k
  var n
  var idx = PW.srv.players.indexOf(old)
  PW.remove(old, 'DISCARDED')
  if (idx >= 0) PW.srv.players.splice(idx, 1)
  n = __pneMock.player(PW.srv, old.name, old.uuid, { x: old.spawnX, y: 64, z: old.spawnZ, hp: 20, maxHp: 20, creative: old.creative })
  // __pneMock.player appended n; keep the list order stable
  PW.srv.players.pop()
  if (idx >= 0) PW.srv.players.splice(idx, 0, n)
  else PW.srv.players.push(n)
  __pneOraMock.equip(n, {})
  PW.playerExtras(n)
  n.spawnX = old.spawnX
  n.spawnZ = old.spawnZ
  n.persistentData = PW.copyNbt(old.persistentData)
  n.getPersistentData = function () { return n.persistentData }
  for (k in old.tagSet) {
    if (old.tagSet.hasOwnProperty(k)) n.addTag(k)
  }
  n.simMercyUntil = old.simMercyUntil
  PW.playersByUuid[n.uuid] = n
  PW.join(n, false)
  __pneMock.fire('PlayerEvents.respawned', { player: n, entity: n, server: PW.srv })
  for (i = 0; i < PW.srv.entities.length; i++) {
    if (PW.srv.entities[i].target === old) PW.srv.entities[i].target = null
  }
  return n
}

// ---------------------------------------------------------------------------------------------
// Combat: the Forge events the startup listeners hear, then KubeJS's hurt/death events, like the game

PW.hurt = function (victim, amount, source) {
  var ev = { amount: amount }
  var sev
  ev.getEntity = function () { return victim }
  ev.getAmount = function () { return ev.amount }
  ev.setAmount = function (a) { ev.amount = Number(a) }
  ev.getSource = function () { return source }
  __pneMock.fire(__PNE_HIVE_EV.hurt, ev)
  sev = { entity: victim, source: source, damage: ev.amount, server: PW.srv }
  PW.fireTyped('EntityEvents.hurt', victim.typeId, sev)
  if (sev.cancelled) return 0
  __pneMock.fire(__PNE_HIVE_EV.damage, ev)
  if (!(ev.amount > 0)) return 0
  victim.hp = Math.max(0, victim.hp - ev.amount)
  victim.lastHurt = PW.srv.tickCount
  return ev.amount
}

PW.killMob = function (e, source) {
  var ev
  if (e.removed || e.dead) return
  e.hp = 0
  e.dead = true
  ev = { entity: e, source: source, server: PW.srv }
  PW.fireTyped('EntityEvents.death', e.typeId, ev)
  PW.later(20, function () { PW.remove(e, 'KILLED') })
}

PW.killPlayer = function (p, source) {
  var ev = { entity: p, player: p, source: source, server: PW.srv }
  p.hp = 0
  p.dead = true
  PW.fireTyped('EntityEvents.death', 'minecraft:player', ev)
  PW.later(40, function () { PW.respawn(p) })
}

PW.later = function (dt, fn) {
  PW.pending.push({ at: PW.srv.tickCount + dt, fn: fn })
}

PW.runPending = function () {
  var now = PW.srv.tickCount
  var keep = []
  var due = []
  var i
  for (i = 0; i < PW.pending.length; i++) {
    if (PW.pending[i].at <= now) due.push(PW.pending[i])
    else keep.push(PW.pending[i])
  }
  PW.pending = keep
  for (i = 0; i < due.length; i++) due[i].fn()
}

// ---------------------------------------------------------------------------------------------
// Levels and light

PW.lightAt = function (x, y, z) {
  var dt = PW.srv ? PW.srv.dayTime % 24000 : 6000
  var torch = PW.torchAt(x, y, z)
  if (torch) return 14
  return (dt > 13000 && dt < 23000) ? 2 : 12
}

PW.torches = []
PW.torchAt = function (x, y, z) {
  var i
  var t
  for (i = 0; i < PW.torches.length; i++) {
    t = PW.torches[i]
    if (Math.abs(t.x - x) <= 5 && Math.abs(t.y - y) <= 3 && Math.abs(t.z - z) <= 5) return true
  }
  return false
}

PW.block = function (x, y, z) {
  var light = PW.lightAt(x, y, z)
  var st = {
    isSolid: function () { return false },
    isAir: function () { return true },
    getLightEmission: function () { return 0 }
  }
  return {
    getId: function () { return 'minecraft:air' },
    getLight: function () { return light },
    getBlockLight: function () { return PW.torchAt(x, y, z) ? 14 : 0 },
    getSkyLight: function () { return light },
    getCanSeeSky: function () { return true },
    getBlockState: function () { return st }
  }
}

PW.setupLevel = function (srv, lv) {
  __pneOraMock.world(srv)
  lv.getBlock = function (x, y, z) {
    if (typeof x === 'object' && x !== null) return PW.block(x.x, x.y, x.z)
    return PW.block(x, y, z)
  }
  lv.getDayTime = function () { return srv.dayTime }
  lv.getMaxLocalRawBrightness = function (bp) { return PW.lightAt(bp.x, bp.y, bp.z) }
  lv.canSeeSky = function (bp) { return true }
  lv.isClientSide = function () { return false }
  lv.getEntitiesWithin = function (box) {
    var out = []
    var i
    var e
    __pneOraMock.calls.query++
    for (i = 0; i < srv.entities.length; i++) {
      e = srv.entities[i]
      if (e.removed || e.level !== lv) continue
      if (e.x >= box.minX && e.x <= box.maxX && e.y >= box.minY && e.y <= box.maxY && e.z >= box.minZ && e.z <= box.maxZ) out.push(e)
    }
    return __pneMock.list(out)
  }
  lv.getTime = function () { return srv.gameTime }
  lv.getDimensionKey = function () { return { location: function () { return lv.dimension } } }
  if (PW.opts.strictKjs) delete lv.getGameTime
}

PW.newServer = function () {
  var srv = __pneMock.server({ gameTime: 1000, cmdResults: { seed: 987654321 } })
  PW.srv = srv
  srv.dayTime = 1000
  srv.dedicated = false
  srv.isDedicated = function () { return false }
  PW.setupLevel(srv, srv.level)
  if (PW.opts.strictKjs) delete srv.isDedicatedServer
  srv.scheduleInTicks = function (dt, fn) { PW.later(dt, fn) }
  srv.persistentData = __pneMock.nbt()
  srv.getPersistentData = function () { return srv.persistentData }
  PW.run1 = srv.runCommandSilent
  srv.runCommandSilent = function (cmd) { return PW.command(String(cmd)) }
  srv.runCommand = srv.runCommandSilent
  return srv
}

// ---------------------------------------------------------------------------------------------
// Selectors and the command interpreter

PW.uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

PW.typeTags = function (id) {
  var tags = {}
  var sc = PW.server
  if (sc && typeof sc.PNE_H_HIVE === 'object' && sc.PNE_H_HIVE[id] === true) tags['#pne:hive'] = true
  if (sc && typeof sc.PNE_H_SPORE === 'object' && sc.PNE_H_SPORE[id] === true) tags['#pne:spore'] = true
  if (sc && typeof sc.PNE_H_FLESH === 'object' && sc.PNE_H_FLESH[id] === true) tags['#pne:flesh'] = true
  if (sc && typeof sc.PNE_H_BECKON === 'object' && sc.PNE_H_BECKON[id] === true) tags['#pne:beckon'] = true
  if (/^spore:(inf_|bairn)/.test(id)) tags['#pne:spore_basic'] = true
  if (!sc || typeof sc.PNE_H_HIVE !== 'object') {
    if (id.indexOf('epca:') === 0) tags['#pne:hive'] = true
    if (id.indexOf('spore:') === 0) tags['#pne:spore'] = true
  }
  return tags
}

PW.parseSel = function (s) {
  var m = /^@([aeprs])(?:\[(.*)\])?$/.exec(s)
  var sel
  var parts
  var i
  var kv
  var k
  var v
  if (!m) return null
  sel = { kind: m[1], filters: [] }
  if (m[2]) {
    parts = m[2].split(',')
    for (i = 0; i < parts.length; i++) {
      kv = parts[i].split('=')
      k = kv[0]
      v = kv.slice(1).join('=')
      sel.filters.push({ k: k, v: v })
    }
  }
  return sel
}

PW.distOk = function (spec, d) {
  var lo
  var hi
  var ab
  if (spec.indexOf('..') < 0) return Math.abs(d - Number(spec)) < 1e-9
  ab = spec.split('..')
  lo = ab[0] === '' ? -Infinity : Number(ab[0])
  hi = ab[1] === '' ? Infinity : Number(ab[1])
  return d >= lo - 1e-9 && d <= hi + 1e-9
}

PW.select = function (s, ctx) {
  var sel
  var out = []
  var cand
  var i
  var j
  var e
  var f
  var ok
  var neg
  var v
  var dx
  var dy
  var dz
  var d
  var limit = -1
  var hasDist = false
  if (PW.uuidRx.test(s)) {
    e = __pneVisMockLive(s)
    return e ? [e] : []
  }
  if (/^[A-Za-z0-9_]{1,16}$/.test(s)) {
    for (i = 0; i < PW.srv.players.length; i++) {
      if (PW.srv.players[i].name === s && !PW.srv.players[i].removed) return [PW.srv.players[i]]
    }
    return []
  }
  sel = PW.parseSel(s)
  if (!sel) return []
  if (sel.kind === 's') return ctx.self ? [ctx.self] : []
  cand = (sel.kind === 'e') ? PW.srv.entities : PW.srv.players
  for (i = 0; i < cand.length; i++) {
    e = cand[i]
    if (e.removed) continue
    ok = true
    for (j = 0; j < sel.filters.length && ok; j++) {
      f = sel.filters[j]
      neg = f.v.charAt(0) === '!'
      v = neg ? f.v.substring(1) : f.v
      if (f.k === 'type') {
        if (v.charAt(0) === '#') ok = (PW.typeTags(e.typeId)[v] === true) !== neg
        else ok = (e.typeId === v) !== neg
      } else if (f.k === 'tag') {
        ok = (v === '' ? false : e.tagSet.hasOwnProperty(v)) !== neg
      } else if (f.k === 'distance') {
        hasDist = true
        if (e.level !== ctx.level) ok = false
        else {
          dx = e.x - ctx.x
          dy = e.y - ctx.y
          dz = e.z - ctx.z
          d = Math.sqrt(dx * dx + dy * dy + dz * dz)
          ok = PW.distOk(v, d)
        }
      } else if (f.k === 'gamemode') {
        ok = ((e.creative ? 'creative' : (e.spectator ? 'spectator' : 'survival')) === v) !== neg
      } else if (f.k === 'limit') {
        limit = Number(v)
      } else if (f.k === 'scores') {
        ok = PW.scoresOk(e, v)
      }
    }
    if (ok) out.push(e)
  }
  if (sel.kind === 'p' || sel.kind === 'r') {
    out = out.slice(0, 1)
  }
  if (limit > 0) out = out.slice(0, limit)
  return out
}

PW.scores = {}
PW.scoresOk = function (e, spec) {
  var m = /^\{([a-z_]+)=(\d*)\.\.(\d*)\}$/.exec(spec)
  var key
  var val
  if (!m) return true
  key = (e.name || e.uuid) + ':' + m[1]
  if (!PW.scores.hasOwnProperty(key)) return false
  val = PW.scores[key]
  if (m[2] !== '' && val < Number(m[2])) return false
  if (m[3] !== '' && val > Number(m[3])) return false
  return true
}

PW.coord = function (tok, base) {
  if (tok.charAt(0) === '~') return base + (tok.length > 1 ? Number(tok.substring(1)) : 0)
  if (tok.charAt(0) === '^') return base
  return Number(tok)
}

PW.levelOf = function (dim) {
  var i
  var ls = PW.srv.levelsArr
  for (i = 0; i < ls.length; i++) {
    if (ls[i].dimension === dim) return ls[i]
  }
  return PW.srv.level
}

// One logged command: { t, c, ctxUuid } (the executing entity for execute as), then the interpreter.
PW.cmdLog = []
PW.command = function (c) {
  var r
  PW.cmdN++
  PW.cmdTick[PW.srv.tickCount] = (PW.cmdTick[PW.srv.tickCount] || 0) + 1
  r = PW.exec(c, { self: null, x: 0, y: 64, z: 0, level: PW.srv.level, rot: false, top: c })
  if (PW.onCommand) PW.onCommand(c, r)
  return r
}

// The visual interpreter's own execute forms (graft summon, yaw tp, orphan sweep, apex names, graft particles).
PW.visExec = [
  /^execute at \S+ run summon minecraft:item_display /,
  /^execute as @e\[type=minecraft:item_display,tag=\w+\] on vehicle on passengers run tag @s remove \w+$/,
  /^execute as @e\[tag=\w+\] run data remove entity @s CustomName$/,
  /^execute if entity @e\[type=minecraft:item_display,tag=\w+\]$/
]

PW.exec = function (c, ctx) {
  var m
  var list
  var i
  var n
  var sub
  var r
  var e
  for (i = 0; i < PW.visExec.length; i++) {
    if (PW.visExec[i].test(c)) return __pneVisMockExec(PW.srv, c)
  }
  if ((m = /^execute as (\S+) at @s run tp @s ~ ~ ~ (-?[0-9.]+) 0$/.exec(c))) {
    list = PW.select(m[1], ctx)
    for (i = 0; i < list.length; i++) {
      if (list[i].typeId === 'minecraft:player') PW.camera(c)
      else list[i].rotation = Number(m[2])
    }
    return list.length
  }
  if ((m = /^execute (.*)$/.exec(c))) return PW.execChain(m[1], ctx)
  if ((m = /^(tp|teleport|spreadplayers) (\S+)/.exec(c))) {
    list = m[1] === 'spreadplayers' ? PW.srv.players : PW.select(m[2], ctx)
    for (i = 0; i < list.length; i++) {
      if (list[i].typeId === 'minecraft:player') PW.camera(c)
    }
    if (ctx.self && (m = /^tp @s ~ ~ ~ (-?[0-9.]+) 0$/.exec(c))) {
      ctx.self.rotation = Number(m[1])
      return 1
    }
    return list.length
  }
  if ((m = /^ride (\S+) (mount|dismount)/.exec(c))) {
    list = PW.select(m[1], ctx)
    for (i = 0; i < list.length; i++) {
      if (list[i].typeId === 'minecraft:player') PW.camera(c)
    }
  }
  if (c === 'seed') return 987654321
  if (c === 'time query daytime') return PW.srv.dayTime % 24000
  if (c === 'time query day') return Math.floor(PW.srv.dayTime / 24000)
  if (c === 'time query gametime') return PW.srv.gameTime
  if ((m = /^summon (\S+) (\S+) (\S+) (\S+)(?: (\{.*\}))?$/.exec(c))) return PW.summon(m[1], PW.coord(m[2], ctx.x), PW.coord(m[3], ctx.y), PW.coord(m[4], ctx.z), m[5] || '', ctx)
  if ((m = /^playsound (\S+) (\S+) (\S+)(?: (\S+) (\S+) (\S+))?(?: (\S+))?(?: (\S+))?(?: (\S+))?$/.exec(c))) return PW.playsound(m, ctx)
  if ((m = /^stopsound (\S+)/.exec(c))) return PW.select(m[1], ctx).length
  if ((m = /^particle /.exec(c))) return 1
  if ((m = /^tellraw (\S+) (.*)$/.exec(c))) {
    try { PW.tellraws.push(String(JSON.parse(m[2]).text)) } catch (err) { PW.badCmd('tellraw JSON does not parse: ' + c) }
    if (PW.tellraws.length > 400) PW.tellraws.shift()
    return PW.select(m[1], ctx).length
  }
  if ((m = /^effect (give|clear) (\S+)(?: (\S+))?/.exec(c))) {
    list = PW.select(m[2], ctx)
    if (PW.onEffect) PW.onEffect(m[1], list, m[3] || '', c)
    return list.length
  }
  if ((m = /^data merge entity (\S+) \{Silent:(\d)b\}$/.exec(c))) {
    list = PW.select(m[1], ctx)
    for (i = 0; i < list.length; i++) list[i].silent = m[2] === '1'
    return list.length
  }
  if ((m = /^data merge entity (\S+) \{HandDropChances:.*\}$/.exec(c))) return PW.select(m[1], ctx).length
  if ((m = /^data merge entity (@e\[.*\]) \{CustomName:.*\}$/.exec(c))) return PW.select(m[1], ctx).length
  if ((m = /^item replace entity (\S+) weapon\.mainhand with (.+)$/.exec(c))) {
    list = PW.select(m[1], ctx)
    for (i = 0; i < list.length; i++) list[i].mainHand = m[2]
    return list.length
  }
  if ((m = /^scoreboard objectives add /.exec(c))) return 1
  if ((m = /^scoreboard players (add|set|reset) (\S+) (\S+)(?: (-?\d+))?$/.exec(c))) {
    list = PW.select(m[2], ctx)
    for (i = 0; i < list.length; i++) {
      sub = (list[i].name || list[i].uuid) + ':' + m[3]
      if (m[1] === 'reset') delete PW.scores[sub]
      else if (m[1] === 'set') PW.scores[sub] = Number(m[4])
      else PW.scores[sub] = (PW.scores[sub] || 0) + Number(m[4])
    }
    return list.length
  }
  if ((m = /^tag (\S+) (add|remove) (\w+)$/.exec(c)) && !PW.uuidRx.test(m[1]) && m[1].indexOf('@e[type=minecraft:item_display') !== 0 &&
      !/^@e\[tag=\w+\]$/.test(m[1])) {
    list = PW.select(m[1], ctx)
    n = 0
    for (i = 0; i < list.length; i++) {
      if (m[2] === 'add' ? list[i].addTag(m[3]) : list[i].removeTag(m[3])) n++
    }
    return n
  }
  if ((m = /^epca_evolution /.exec(c))) return 1
  // Anything else: the visual interpreter (team/summon display/ride/kill/tag/data CustomName), then the base mock.
  if (ctx.self && ctx.top !== c) {
    // run inside "execute as X": forms that need their own context
    if ((m = /^data remove entity @s CustomName$/.exec(c))) {
      if (ctx.self.customName === null) return 0
      ctx.self.customName = null
      return 1
    }
    if ((m = /^tag @s (add|remove) (\w+)$/.exec(c))) return (m[1] === 'add' ? ctx.self.addTag(m[2]) : ctx.self.removeTag(m[2])) ? 1 : 0
  }
  r = __pneVisMockExec(PW.srv, c)
  if (r === undefined) {
    PW.unknownCmd(c)
    return 1
  }
  if (__pneVisMock.unknown.length) {
    for (i = 0; i < __pneVisMock.unknown.length; i++) PW.unknownCmd(__pneVisMock.unknown[i])
    __pneVisMock.unknown = []
  }
  return r
}

PW.unknown = {}
PW.unknownCmd = function (c) {
  var k = String(c).split(' ').slice(0, 2).join(' ')
  PW.unknown[k] = (PW.unknown[k] || 0) + 1
}

PW.bad = []
PW.badCmd = function (msg) {
  if (PW.bad.length < 50) PW.bad.push(msg)
}

// A command that would move a player's camera (tp/teleport/spreadplayers/ride aimed at a player): comfort I8.
PW.cameraCmds = []
PW.camera = function (c) {
  if (PW.cameraCmds.length < 20) PW.cameraCmds.push(c)
}

// execute subcommands: as, at, in, positioned, rotated, if/unless entity, if/unless block, on vehicle|passengers, run
PW.execChain = function (rest, ctx0) {
  var toks = rest.split(' ')
  var ctxs = [ctx0]
  var i = 0
  var t
  var sel
  var next
  var j
  var k
  var list
  var total
  var r
  var runCmd
  var c
  while (i < toks.length) {
    t = toks[i]
    if (t === 'run') {
      runCmd = toks.slice(i + 1).join(' ')
      total = 0
      for (j = 0; j < ctxs.length; j++) {
        c = PW.cloneCtx(ctxs[j])
        r = PW.exec(runCmd, c)
        total += Number(r) > 0 ? Number(r) : 0
      }
      return total
    }
    if (t === 'as' || t === 'at') {
      sel = toks[i + 1]
      next = []
      for (j = 0; j < ctxs.length; j++) {
        list = PW.select(sel, ctxs[j])
        for (k = 0; k < list.length; k++) {
          c = PW.cloneCtx(ctxs[j])
          if (t === 'as') c.self = list[k]
          else {
            c.x = list[k].x
            c.y = list[k].y
            c.z = list[k].z
            c.level = list[k].level
          }
          next.push(c)
        }
      }
      ctxs = next
      i += 2
    } else if (t === 'in') {
      for (j = 0; j < ctxs.length; j++) ctxs[j].level = PW.levelOf(toks[i + 1])
      i += 2
    } else if (t === 'positioned') {
      for (j = 0; j < ctxs.length; j++) {
        ctxs[j].x = PW.coord(toks[i + 1], ctxs[j].x)
        ctxs[j].y = PW.coord(toks[i + 2], ctxs[j].y)
        ctxs[j].z = PW.coord(toks[i + 3], ctxs[j].z)
      }
      i += 4
    } else if (t === 'rotated') {
      for (j = 0; j < ctxs.length; j++) ctxs[j].rot = true
      i += 3
    } else if ((t === 'if' || t === 'unless') && toks[i + 1] === 'entity') {
      next = []
      for (j = 0; j < ctxs.length; j++) {
        list = PW.select(toks[i + 2], ctxs[j])
        if ((list.length > 0) === (t === 'if')) next.push(ctxs[j])
        if (i + 3 >= toks.length) return t === 'if' ? list.length : (list.length ? 0 : 1)
      }
      ctxs = next
      i += 3
    } else if ((t === 'if' || t === 'unless') && toks[i + 1] === 'block') {
      // open natural ground everywhere: feet and head replaceable, the block below beckon ground
      i += 6
    } else if (t === 'on') {
      next = []
      for (j = 0; j < ctxs.length; j++) {
        if (!ctxs[j].self) continue
        if (toks[i + 1] === 'vehicle') {
          if (ctxs[j].self.vehicle && !ctxs[j].self.vehicle.removed) {
            c = PW.cloneCtx(ctxs[j])
            c.self = ctxs[j].self.vehicle
            next.push(c)
          }
        } else if (toks[i + 1] === 'passengers') {
          for (k = 0; k < ctxs[j].self.passengers.length; k++) {
            c = PW.cloneCtx(ctxs[j])
            c.self = ctxs[j].self.passengers[k]
            next.push(c)
          }
        }
      }
      ctxs = next
      i += 2
    } else {
      PW.unknownCmd('execute ' + t)
      return 0
    }
    if (!ctxs.length) return 0
  }
  return ctxs.length
}

PW.cloneCtx = function (c) {
  return { self: c.self, x: c.x, y: c.y, z: c.z, level: c.level, rot: c.rot, top: c.top }
}

PW.summon = function (id, x, y, z, nbt, ctx) {
  var tags = []
  var m
  var e
  if (id === 'minecraft:item_display') return undefined
  if (PW.onSummon) PW.onSummon(id, x, y, z, ctx)
  m = /Tags:\[([^\]]*)\]/.exec(nbt)
  if (m) tags = m[1].replace(/"/g, '').split(',')
  e = PW.spawnMob(id, x, y, z, false, tags)
  return e ? 1 : 0
}

PW.playsound = function (m, ctx) {
  var targets = PW.select(m[3], ctx)
  var i
  if (PW.onSound) {
    for (i = 0; i < targets.length; i++) PW.onSound(targets[i], m[1], m[2], Number(m[7] === undefined ? 1 : m[7]), ctx)
  }
  return targets.length
}

// ---------------------------------------------------------------------------------------------
// The fake Oracle sidecar: answers telemetry.json with verdict.json through the in-memory JsonIO map, the way
// oracle/sidecar.py does (same boot_id, seq echo, 4/4/3 probability vectors per pid). Off unless PW.sidecar.

PW.sidecarStep = function () {
  var tel
  var out
  var i
  var p
  var a
  if (!PW.sidecar) return
  tel = __pneOraMock.get('local/pne_oracle/telemetry.json')
  if (!tel || tel.seq === PW.sidecarSeq) return
  PW.sidecarSeq = tel.seq
  out = { v: tel.v, boot_id: String(tel.boot_id), seq: tel.seq, tick: tel.tick, backend: 'cpu_np', players: [] }
  for (i = 0; i < tel.players.length; i++) {
    p = tel.players[i]
    a = (p.f[0] || 0) > 0.5 ? [0.1, 0.2, 0.3, 0.4] : [0.55, 0.25, 0.15, 0.05]
    out.players.push({ pid: p.pid, arousal: a, style: [0.6, 0.2, 0.1, 0.1], fe: [0.5, 0.3, 0.2], window_fill: 1 })
  }
  __pneOraMock.put('local/pne_oracle/verdict.json', out)
}
