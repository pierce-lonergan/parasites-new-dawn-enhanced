// Prelude of suite diff-events-rhino (load after tools/tests/kjs_mocks.js, before the startup scripts under test). ES5.
// The Forge and mod classes the difficulty startup listeners load at the top level, as mocks in __pneMock.classes:
//   * net.minecraftforge.common.MinecraftForge: EVENT_BUS.addListener(priority, receiveCanceled, cls, fn) records
//     { prio, rc, cls, fn } in __pneDEnv.listeners;
//   * net.minecraftforge.eventbus.api.EventPriority (HIGHEST .. LOWEST, String() is the name);
//   * net.smileycorp.hordes.common.event.HordeBuildSpawnDataEvent (a class token);
//   * net.smileycorp.hordes.hordeevent.capability.HordeSavedData: getData(level) returns level.__hordeData, the test's
//     model of The Hordes' saved data (getNextDay(day), setDirty()), or null;
//   * net.minecraft.world.entity.player.Player$BedSleepingProblem (OTHER_PROBLEM), for pne_horde_rules.js.

var __pneDEnv = { listeners: [] }

__pneMock.classes['net.minecraftforge.eventbus.api.EventPriority'] = {
  HIGHEST: { toString: function () { return 'HIGHEST' } },
  HIGH: { toString: function () { return 'HIGH' } },
  NORMAL: { toString: function () { return 'NORMAL' } },
  LOW: { toString: function () { return 'LOW' } },
  LOWEST: { toString: function () { return 'LOWEST' } }
}
__pneMock.classes['net.minecraftforge.common.MinecraftForge'] = {
  EVENT_BUS: {
    addListener: function (prio, rc, cls, fn) {
      __pneDEnv.listeners.push({ prio: String(prio), rc: rc, cls: cls, fn: fn })
    }
  }
}
__pneMock.classes['net.smileycorp.hordes.common.event.HordeBuildSpawnDataEvent'] = { __cls: 'net.smileycorp.hordes.common.event.HordeBuildSpawnDataEvent' }
__pneMock.classes['net.smileycorp.hordes.hordeevent.capability.HordeSavedData'] = {
  getData: function (level) { return (level && level.__hordeData) ? level.__hordeData : null }
}
__pneMock.classes['net.minecraft.world.entity.player.Player$BedSleepingProblem'] = { OTHER_PROBLEM: { toString: function () { return 'OTHER_PROBLEM' } } }
