// Pack smoke test: bindings of one script scope (startup or server), loaded right after tools/tests/kjs_mocks.js and
// before the pack's scripts. ES5. The driver sets __world (the control scope) and __pneEnvKind ('startup' or
// 'server') on the scope first. Everything here stands in for what KubeJS binds in game:
//   * Java.loadClass: the world's class mocks (AttributeModifier, its Operation, ForgeRegistries.ATTRIBUTES,
//     ResourceLocation; Forge's Event$Result for the startup gate), otherwise the harness's class-filtered loader
//     (java.util.* is real: the startup queues are real ArrayLists in the shared global HashMap);
//   * JsonIO (the in-memory file map of tools/oracle/ora_mocks.js), Platform, ItemEvents, StartupEvents, Text;
//   * console: every line is recorded by the world (PW.log) with its scope, so the driver can fail on errors.

var __pneEnvJava = Java
var __pneEnvResult = { DENY: 'DENY', ALLOW: 'ALLOW', DEFAULT: 'DEFAULT' }

// Game classes the legacy startup scripts load at the top level (they exist in game; the harness has no Minecraft
// classes): Forge's event bus registers into the same handler table as ForgeEvents.onEvent, keyed by class name.
var __pneEnvGame = {
  'net.minecraftforge.eventbus.api.Event$Result': __pneEnvResult,
  'net.minecraftforge.eventbus.api.EventPriority': { HIGHEST: 'HIGHEST', HIGH: 'HIGH', NORMAL: 'NORMAL', LOW: 'LOW', LOWEST: 'LOWEST' },
  'net.minecraftforge.common.MinecraftForge': {
    EVENT_BUS: {
      addListener: function (prio, receiveCanceled, cls, fn) {
        var key = 'ForgeEvents.onEvent:' + String(cls.__cls)
        if (!__pneMock.handlers[key]) __pneMock.handlers[key] = []
        __pneMock.handlers[key].push(fn)
      }
    }
  },
  'net.minecraft.world.effect.MobEffects': {
    CONFUSION: 'minecraft:nausea', BLINDNESS: 'minecraft:blindness', DARKNESS: 'minecraft:darkness',
    MOVEMENT_SLOWDOWN: 'minecraft:slowness', WEAKNESS: 'minecraft:weakness', POISON: 'minecraft:poison', WITHER: 'minecraft:wither'
  }
}

Java = {
  loadClass: function (name) {
    var n = String(name)
    if (__pneEnvGame.hasOwnProperty(n)) return __pneEnvGame[n]
    if (__world.__pneHiveMockClasses.hasOwnProperty(n)) return __world.__pneHiveMockClasses[n]
    if (/^net\.minecraftforge\.event\.|^net\.smileycorp\.hordes\.common\.event\./.test(n)) return { __cls: n }
    return __pneEnvJava.loadClass(n)
  }
}

var JsonIO = __world.JsonIO
var Platform = {
  isClientEnvironment: function () { return true },   // single player: the integrated server runs in the client JVM
  isForge: function () { return true },
  getMcVersion: function () { return '1.20.1' }
}
var ItemEvents = __pneMockGroup('ItemEvents', ['foodEaten', 'rightClicked', 'crafted', 'pickedUp'])
var StartupEvents = __pneMockGroup('StartupEvents', ['registry', 'init', 'postInit'])
var Text = {
  gray: function (s) { return s }, green: function (s) { return s }, red: function (s) { return s },
  darkGreen: function (s) { return s }, gold: function (s) { return s }, of: function (s) { return s }
}

console = {
  info: function (m) { __world.PW.log(__pneEnvKind, 'info', m) },
  log: function (m) { __world.PW.log(__pneEnvKind, 'log', m) },
  warn: function (m) { __world.PW.log(__pneEnvKind, 'warn', m) },
  error: function (m) { __world.PW.log(__pneEnvKind, 'error', m) },
  debug: function (m) { }
}
