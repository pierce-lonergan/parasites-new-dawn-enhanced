// HIVE-RUNTIME test prelude (ES5; runs unchanged in Node through tools/tests/kjs_node.js and in the instance's Rhino
// jar through tools/rhino/pne_rhino.py run). Load order:
//   tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js, pne_00_core.js, pne_hive_core.js, pne_hive.js,
//   [startup_scripts/pne_hive_events.js], <test file>
// It extends the shared mocks (never edits them) with what the hive runtime touches:
//   * Java.loadClass mocks for the Minecraft/Forge classes (AttributeModifier, its Operation, ForgeRegistries,
//     ResourceLocation); java.util classes stay real in Rhino and get small shims in Node (UUID, IntStream);
//   * entity methods: attribute instances (permanent/transient modifiers that throw on a duplicate UUID like
//     AttributeInstance), getTarget, setSilent, hasCustomName, isPersistenceRequired, isRemoved/getRemovalReason,
//     getMainHandItem, blockPosition; a server entity list (getEntities) and level light/day time;
//   * Forge event helpers that drive the startup listeners exactly like the game (join with loadedFromDisk,
//     leave with a removal reason, LivingDamageEvent / LivingHurtEvent with damage sources);
//   * __pneHiveReload(srv, mob): a chunk reload (UNLOADED_TO_CHUNK leave, then a copy of the saved entity joins
//     loaded from disk: persistent data, tags, Silent and permanent modifiers survive; transient ones do not).
// Method names are the ones scripts see in game (contract F37): KubeJS hides Level.getGameTime (getTime), Entity.getYRot
// (getYaw) and DamageSource.getMsgId / getEntity / getDirectEntity (getType / getActual / getImmediate) behind its own
// names. The shared mocks answer only to the KubeJS names unless __pneMock.opts.mojangNames is set, and this prelude
// follows the same switch (its damage sources, __pneHiveSource), so a call of a hidden Mojang name fails in the hive
// suites as it does in game. __pneHiveSourceMojang (Mojang names only) exists to test the listeners' mock fallback.
// The pack's id sets PNE_H_HIVE / PNE_H_SPORE stand in for #pne:hive / #pne:spore (pneCoreIsParasite's fallback).

var __pneHiveRealJava = Java
var __pneHiveIsRhino = typeof __pneRemap !== 'undefined'
var __pneHiveStage = 0

function __pneHiveMockModifier(uuid, name, amount, op) {
  this.id = String(uuid)
  this.name = String(name)
  this.amount = Number(amount)
  this.op = String(op)
}

var __pneHiveMockClasses = {
  'net.minecraft.world.entity.ai.attributes.AttributeModifier': __pneHiveMockModifier,
  'net.minecraft.world.entity.ai.attributes.AttributeModifier$Operation': { ADDITION: 'ADDITION', MULTIPLY_BASE: 'MULTIPLY_BASE', MULTIPLY_TOTAL: 'MULTIPLY_TOTAL' },
  'net.minecraftforge.registries.ForgeRegistries': { ATTRIBUTES: { getValue: function (rl) { return String(rl.path) } } },
  'net.minecraft.resources.ResourceLocation': function (ns, path) { this.ns = String(ns); this.path = String(path); this.toString = function () { return this.ns + ':' + this.path } }
}

var __pneHiveUuidN = 0
var __pneHiveNodeShims = {
  'java.util.UUID': {
    fromString: function (s) { return { s: String(s), toString: function () { return this.s } } },
    randomUUID: function () {
      __pneHiveUuidN++
      return { toString: function () { return 'abcdef00-0000-4000-8000-' + ('000000000000' + __pneHiveUuidN).slice(-12) } }
    }
  },
  'java.util.stream.IntStream': {
    range: function (a, b) {
      return { toArray: function () { var r = []; var i; for (i = a; i < b; i++) r.push(0); return r } }
    }
  }
}

// __pneHiveOnlyNbt (bound by NbtSizeTest/HiveBench, which put the SRG Minecraft jar on the classpath): every other
// Minecraft class is refused, as in the plain harness, so no class initialiser pulls in the game's bootstrap.
// __pneHiveRealAttr (bound by HiveBench): the real AttributeModifier classes from the SRG jar are used, so the benchmark
// pays the real constructor and overload costs.
if (typeof __pneHiveRealAttr !== 'undefined' && String(__pneHiveRealAttr) === 'true') {
  delete __pneHiveMockClasses['net.minecraft.world.entity.ai.attributes.AttributeModifier']
  delete __pneHiveMockClasses['net.minecraft.world.entity.ai.attributes.AttributeModifier$Operation']
}
Java = {
  loadClass: function (name) {
    var n = String(name)
    if (__pneHiveMockClasses.hasOwnProperty(n)) return __pneHiveMockClasses[n]
    if (typeof __pneHiveRealAttr !== 'undefined' && String(__pneHiveRealAttr) === 'true' && n.indexOf('net.minecraft.world.entity.ai.attributes.AttributeModifier') === 0) {
      return __pneHiveRealJava.loadClass(n)
    }
    if (typeof __pneHiveOnlyNbt !== 'undefined' && String(__pneHiveOnlyNbt) === 'true' && n.indexOf('net.minecraft.') === 0 &&
      n.indexOf('net.minecraft.nbt.') !== 0) throw new Error('harness: class ' + n + ' is not loaded in NBT-only mode')
    try {
      return __pneHiveRealJava.loadClass(n)
    } catch (e) {
      if (!__pneHiveIsRhino && __pneHiveNodeShims.hasOwnProperty(n)) return __pneHiveNodeShims[n]
      throw e
    }
  }
}

// Stand-ins for the #pne:hive / #pne:spore tags (pneCoreIsParasite falls back to these id sets).
var PNE_H_HIVE = { 'epca:ripper': true, 'epca:curbug': true, 'epca:infested_villager': true, 'epca:biomass': true, 'epca:infested_bat': true }
var PNE_H_SPORE = { 'spore:knight': true, 'spore:inf_human': true, 'spore:spitter': true }

// pne_horror.js's stage function (the core wraps it; 600-tick cache).
function pneHStage(server, level, dim) {
  return __pneHiveStage
}

// ---------------------------------------------------------------------------------------------
// NBT: IntArray, key sets and copies (the shared mock has scalars and compounds only)

var __pneHiveNbtBase = __pneMock.nbt
__pneMock.nbt = function () {
  var t = __pneHiveNbtBase()
  var m = t.m
  t.putIntArray = function (k, a) {
    var c = []
    var n = Number(a.length)
    var i
    for (i = 0; i < n; i++) c.push(Math.floor(Number(a[i])))
    m[k] = { isIntArray: true, a: c }
  }
  t.getIntArray = function (k) {
    var v = m[k]
    return (v && v.isIntArray) ? v.a.slice(0) : []
  }
  t.getAllKeys = function () {
    var ks = []
    var k
    for (k in m) {
      if (m.hasOwnProperty(k)) ks.push(k)
    }
    return {
      size: function () { return ks.length },
      iterator: function () {
        var j = 0
        return { hasNext: function () { return j < ks.length }, next: function () { return ks[j++] } }
      }
    }
  }
  return t
}

function __pneHiveNbtCopy(src) {
  var dst = __pneMock.nbt()
  var k
  var v
  for (k in src.m) {
    if (!src.m.hasOwnProperty(k)) continue
    v = src.m[k]
    if (v && v.isMockNbt) dst.m[k] = __pneHiveNbtCopy(v)
    else if (v && v.isIntArray) dst.m[k] = { isIntArray: true, a: v.a.slice(0) }
    else dst.m[k] = v
  }
  return dst
}

// ---------------------------------------------------------------------------------------------
// Attributes

var __pneHiveNoDmg = { 'epca:curbug': true, 'spore:spitter': true }

function __pneHiveDefaultAttrs(typeId, maxHp) {
  var a
  if (typeId === 'minecraft:player') return {}
  a = {
    'generic.movement_speed': 0.25, 'generic.follow_range': 16, 'generic.knockback_resistance': 0, 'generic.armor': 0,
    'generic.attack_knockback': 0, 'generic.max_health': maxHp, 'generic.attack_damage': 7
  }
  if (__pneHiveNoDmg[typeId]) delete a['generic.attack_damage']
  if (typeId === 'epca:biomass') a['generic.attack_damage'] = 3
  if (typeId === 'epca:infested_bat') a['generic.flying_speed'] = 0.4
  return a
}

function __pneHiveAttrInst(base) {
  var inst = { base: base, perm: {}, trans: {} }
  inst.getBaseValue = function () { return inst.base }
  inst.getModifier = function (u) {
    var k = String(u)
    return inst.perm[k] || inst.trans[k] || null
  }
  inst.addPermanentModifier = function (m) {
    var k = String(m.id)
    if (inst.perm[k] || inst.trans[k]) throw new Error('Modifier is already applied on this attribute!')
    inst.perm[k] = m
  }
  inst.addTransientModifier = function (m) {
    var k = String(m.id)
    if (inst.perm[k] || inst.trans[k]) throw new Error('Modifier is already applied on this attribute!')
    inst.trans[k] = m
  }
  inst.removeModifier = function (u) {
    var k = String(u)
    delete inst.perm[k]
    delete inst.trans[k]
  }
  inst.getValue = function () {
    var v = inst.base
    var mb = 0
    var k
    var all = []
    for (k in inst.perm) {
      if (inst.perm.hasOwnProperty(k)) all.push(inst.perm[k])
    }
    for (k in inst.trans) {
      if (inst.trans.hasOwnProperty(k)) all.push(inst.trans[k])
    }
    for (k = 0; k < all.length; k++) {
      if (all[k].op === 'ADDITION') v += all[k].amount
    }
    for (k = 0; k < all.length; k++) {
      if (all[k].op === 'MULTIPLY_BASE') mb += all[k].amount
    }
    return v + inst.base * mb
  }
  inst.count = function () {
    var n = 0
    var k
    for (k in inst.perm) {
      if (inst.perm.hasOwnProperty(k)) n++
    }
    for (k in inst.trans) {
      if (inst.trans.hasOwnProperty(k)) n++
    }
    return n
  }
  return inst
}

// ---------------------------------------------------------------------------------------------
// Entities, levels, servers

var __pneHiveEntityBase = __pneMock.entity
__pneMock.entity = function (srv, typeId, opts) {
  var o = opts || {}
  var e = __pneHiveEntityBase(srv, typeId, opts)
  e.attrBase = o.attrs || __pneHiveDefaultAttrs(typeId, e.maxHp)
  e.attrInst = {}
  e.getAttribute = function (a) {
    var id = String(a)
    if (!e.attrBase.hasOwnProperty(id)) return null
    if (!e.attrInst[id]) e.attrInst[id] = __pneHiveAttrInst(e.attrBase[id])
    return e.attrInst[id]
  }
  e.getMaxHealth = function () {
    return e.attrBase.hasOwnProperty('generic.max_health') ? e.getAttribute('generic.max_health').getValue() : e.maxHp
  }
  e.setHealth = function (h) { e.hp = Number(h) }
  e.target = null
  e.getTarget = function () { return e.target }
  e.silent = false
  e.setSilent = function (b) { e.silent = b ? true : false }
  e.isSilent = function () { return e.silent }
  e.customName = o.customName || null
  e.hasCustomName = function () { return e.customName !== null }
  e.persist = o.persist === true
  e.isPersistenceRequired = function () { return e.persist }
  e.removalReason = null
  e.isRemoved = function () { return e.removed }
  e.getRemovalReason = function () { return e.removalReason }
  e.discard = function () { __pneHiveRemove(srv, e, 'DISCARDED') }
  e.mainHand = o.mainHand || ''
  e.getMainHandItem = function () { return { isEmpty: function () { return !e.mainHand } } }
  e.blockPosition = function () { return { x: Math.floor(e.x), y: Math.floor(e.y), z: Math.floor(e.z) } }
  if (!srv.entities) srv.entities = []
  srv.entities.push(e)
  return e
}

var __pneHiveServerBase = __pneMock.server
__pneMock.server = function (opts) {
  var srv = __pneHiveServerBase(opts)
  srv.entities = []
  srv.light = 0
  srv.lightAt = null
  srv.dayTime = null
  srv.getEntities = function () {
    var live = []
    var i
    for (i = 0; i < srv.entities.length; i++) {
      if (!srv.entities[i].removed) live.push(srv.entities[i])
    }
    return __pneMock.list(live)
  }
  srv.level.getBlock = function (x, y, z) {
    return { getBlockLight: function () { return srv.lightAt ? srv.lightAt(x, y, z) : srv.light } }
  }
  srv.level.getDayTime = function () { return srv.dayTime === null ? srv.gameTime : srv.dayTime }
  srv.level.canSeeSky = function (bp) { return true }
  srv.level.getBiome = function (bp) { throw new Error('mock: no biome') }
  srv.level.isClientSide = function () { return false }
  return srv
}

// ---------------------------------------------------------------------------------------------
// Forge events driven like the game

var __PNE_HIVE_EV = {
  join: 'ForgeEvents.onEvent:net.minecraftforge.event.entity.EntityJoinLevelEvent',
  leave: 'ForgeEvents.onEvent:net.minecraftforge.event.entity.EntityLeaveLevelEvent',
  damage: 'ForgeEvents.onEvent:net.minecraftforge.event.entity.living.LivingDamageEvent',
  hurt: 'ForgeEvents.onEvent:net.minecraftforge.event.entity.living.LivingHurtEvent'
}

// A mob joins the level: the startup join listener (fresh flag) and KubeJS's spawned handlers, like the game.
function __pneHiveJoin(srv, e, fromDisk) {
  var spawned = { entity: e, level: srv.level, cancelled: false }
  spawned.cancel = function () { spawned.cancelled = true }
  __pneMock.fire(__PNE_HIVE_EV.join, { getLevel: function () { return srv.level }, getEntity: function () { return e },
    loadedFromDisk: function () { return fromDisk === true } })
  __pneMock.fire('EntityEvents.spawned', spawned)
  return spawned
}

function __pneHiveSpawn(srv, typeId, opts) {
  var e = __pneMock.mob(srv, typeId, opts)
  e.lastSpawned = __pneHiveJoin(srv, e, false)
  return e
}

function __pneHiveRemove(srv, e, reason) {
  if (e.removed) return
  e.removed = true
  e.removalReason = reason
  __pneMock.fire(__PNE_HIVE_EV.leave, { getLevel: function () { return srv.level }, getEntity: function () { return e } })
}

// A mob dies (death event with a source, then the KILLED removal the game does 20 ticks later; the test decides when).
function __pneHiveDeath(srv, e, msgId, killer) {
  e.hp = 0
  __pneMock.fire('EntityEvents.death', { entity: e, source: __pneHiveSource(msgId || 'player', killer || null, false) })
}

// A DamageSource as scripts see it in game (F37): getType() = the msgId, getActual() = the causing entity (the owner for
// projectiles), getImmediate() = the direct entity. The hidden Mojang names (getMsgId, getEntity, getDirectEntity) are
// there only under __pneMock.opts.mojangNames (as in __pneMock.damage), so by default a listener that calls them fails
// here as it would in game.
function __pneHiveSource(msgId, entity, indirect) {
  var s = {
    getType: function () { return msgId },
    getActual: function () { return entity || null },
    getImmediate: function () { return entity || null },
    isIndirect: function () { return indirect === true },
    is: function (tag) { throw new Error('mock: no damage-type tags') }
  }
  if (__pneMock.opts.mojangNames) {
    s.getMsgId = function () { return msgId }
    s.getEntity = function () { return entity || null }
    s.getDirectEntity = function () { return entity || null }
  }
  return s
}

// The same source with ONLY the Mojang names (the shape of the shared mocks' __pneMock.damage): the listeners' mock
// fallbacks must still read it.
function __pneHiveSourceMojang(msgId, entity, indirect) {
  return {
    getMsgId: function () { return msgId },
    getEntity: function () { return entity || null },
    getDirectEntity: function () { return entity || null },
    isIndirect: function () { return indirect === true },
    is: function (tag) { throw new Error('mock: no damage-type tags') }
  }
}

function __pneHiveDamage(srv, victim, amount, source) {
  var ev = { amount: amount }
  ev.getEntity = function () { return victim }
  ev.getAmount = function () { return ev.amount }
  ev.setAmount = function (a) { ev.amount = Number(a) }
  ev.getSource = function () { return source }
  __pneMock.fire(__PNE_HIVE_EV.damage, ev)
  return ev
}

function __pneHiveHurt(srv, victim, amount, source) {
  var ev = { amount: amount }
  ev.getEntity = function () { return victim }
  ev.getAmount = function () { return ev.amount }
  ev.setAmount = function (a) { ev.amount = Number(a) }
  ev.getSource = function () { return source }
  __pneMock.fire(__PNE_HIVE_EV.hurt, ev)
  return ev
}

// Chunk reload: the saved entity (persistent data, tags, Silent, permanent modifiers, health) comes back as a new
// object with the same UUID and joins loaded from disk; transient modifiers are gone.
function __pneHiveReload(srv, e) {
  var n
  var k
  var inst
  var id
  __pneHiveRemove(srv, e, 'UNLOADED_TO_CHUNK')
  n = __pneMock.mob(srv, e.typeId, { uuid: e.uuid, x: e.x, y: e.y, z: e.z, hp: e.hp, maxHp: e.maxHp, attrs: e.attrBase,
    mainHand: e.mainHand, customName: e.customName, persist: e.persist })
  n.persistentData = __pneHiveNbtCopy(e.persistentData)
  n.getPersistentData = function () { return n.persistentData }
  for (k in e.tagSet) {
    if (e.tagSet.hasOwnProperty(k)) n.addTag(k)
  }
  n.silent = e.silent
  for (id in e.attrInst) {
    if (!e.attrInst.hasOwnProperty(id)) continue
    inst = n.getAttribute(id)
    for (k in e.attrInst[id].perm) {
      if (e.attrInst[id].perm.hasOwnProperty(k)) inst.perm[k] = e.attrInst[id].perm[k]
    }
  }
  n.lastSpawned = __pneHiveJoin(srv, n, true)
  return n
}

// Hand-made genome hex (u16 per gene, 14 genes) from a gene map { SIL: 65535, ... }.
function __pneHiveGenome(genes) {
  var ids = PNE_HIVE_GA.GENE_IDS
  var g = []
  var i
  for (i = 0; i < ids.length; i++) g.push(genes && genes.hasOwnProperty(ids[i]) ? genes[ids[i]] : 0)
  return PNE_HIVE_GA.hex(g)
}

// A genome mob as saved from an earlier session (it joins as a rejoin).
function __pneHiveSaved(srv, typeId, genes, opts) {
  var e = __pneMock.mob(srv, typeId, opts)
  var pd = e.persistentData
  pd.putString('pne_g', __pneHiveGenome(genes))
  pd.putInt('pne_gv', 1)
  pd.putString('pne_gi', 'p' + e.uuid.substring(30))
  pd.putString('pne_gp', '')
  pd.putString('pne_ctx', typeId + '/0/0/surface')
  pd.putLong('pne_t0', 1)
  if (opts && opts.sil) {
    pd.putByte('pne_sil', 1)
    e.silent = true
  }
  e.lastSpawned = __pneHiveJoin(srv, e, true)
  return e
}

function __pneHiveCmds(srv, sub) {
  var out = []
  var i
  for (i = 0; i < srv.cmds.length; i++) {
    if (srv.cmds[i].indexOf(sub) >= 0) out.push(srv.cmds[i])
  }
  return out
}
