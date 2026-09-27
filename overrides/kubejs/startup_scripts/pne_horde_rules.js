// Parasites New Dawn - Enhanced :: horde night bed rule (startup)
//
// The Hordes 1.6.3i is set to hordeEventByPlayerTime=false, hordeSpawnDays=7, variation 0, start 18000
// (config/hordes-common.toml). Its own canSleepDuringHorde=false check (HordeEventHandler.trySleep ->
// HordeSavedData.isHordeNight -> HordeEvent.isHordeDay) is only true while the event runs or once a
// scheduled horde is overdue. Beds work from about 12542, so without this script a player could sleep
// through the evening of day 7, wake on day 8 and meet the horde a night late.
//
// This listener refuses sleep for the whole of every 7th day (day > 0, day % 7 == 0). Sleeping in daylight
// is only possible in a thunderstorm, so in practice this is the evening and night of the horde day. It uses
// Player.BedSleepingProblem.OTHER_PROBLEM, the same constant The Hordes uses (it keeps its Mojang name at
// runtime, as the Hordes bytecode shows), and shows a line on the action bar (text only, no camera or
// screen effect). If anything fails, sleep is allowed (fail safe).
//
// Day and time come from the vanilla /time query command run by the server (overworld source), so no
// remapped Mojang members are needed for them.
//
// ES5 only (Rhino). The body is wrapped in try/catch.

var $PneBedProblem = null
try { $PneBedProblem = Java.loadClass('net.minecraft.world.entity.player.Player$BedSleepingProblem') } catch (e) { $PneBedProblem = null }

var PNE_BED_HORDE_DAYS = 7
var pneBedErrors = 0
var pneBedLines = [
  'The hive gathers tonight. You will not sleep.',
  'Something is coming for you tonight. Sleep will not come.',
  'You close your eyes and hear them breathing. Not tonight.'
]

function pneBedTellBar(player, server, text) {
  try { player.setStatusMessage(text); return } catch (e) { }
  try {
    var name = String(player.getProfile().getName())
    server.runCommandSilent('title ' + name + ' actionbar {"text":"' + text + '","color":"dark_red"}')
  } catch (e2) { }
}

try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.player.PlayerSleepInBedEvent', function (event) {
    if (pneBedErrors >= 20 || $PneBedProblem === null) return
    try {
      if (event.getResultStatus() != null) return
      var player = event.getEntity()
      if (!player) return
      var server = player.getServer()
      if (!server) return
      var day = Number(server.runCommandSilent('time query day'))
      if (!isFinite(day) || day <= 0 || day % PNE_BED_HORDE_DAYS !== 0) return
      event.setResult($PneBedProblem.OTHER_PROBLEM)
      pneBedTellBar(player, server, pneBedLines[Math.floor(Math.random() * pneBedLines.length)])
    } catch (err) {
      pneBedErrors++
      if (pneBedErrors >= 20) console.warn('[pne_horde_rules] horde-night bed rule disabled after repeated errors: ' + err)
    }
  })
} catch (regErr) {
  console.warn('[pne_horde_rules] could not register the horde-night bed rule: ' + regErr)
}
