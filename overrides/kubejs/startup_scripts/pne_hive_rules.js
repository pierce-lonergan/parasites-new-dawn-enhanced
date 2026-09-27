// Parasites New Dawn - Enhanced :: hive rules that need Forge-level listeners (startup)
//
// 1. Call of the Hive drops safety net (players only).
//    EPCA's EvolutionStageEvents.onLivingDrops cancels LivingDropsEvent (NORMAL priority) for
//    any entity that still has epca:coth once the dimension's erosion stage is >= 3. Corpse
//    collects player items in its own LivingDropsEvent listener at LOWEST priority without
//    receiveCanceled, so a cancelled event deletes the whole inventory.
//    The primary fix is in server_scripts/pne_horror.js: it removes COTH level I during
//    LivingDeathEvent, which Forge fires before LivingDropsEvent (EPCA itself clears COTH II+).
//    This listener is the backstop in case that fix ever fails. It runs at LOW priority with
//    receiveCanceled=true, so it sits after EPCA (NORMAL) and before Corpse (LOWEST). If a
//    player's drops arrive cancelled while the player still has COTH (EPCA's exact condition),
//    or if COTH cannot be checked, it un-cancels the event so Corpse receives the items.
//    A cancel from anything else on a player without COTH is left alone.
//    KubeJS's ForgeEvents.onEvent always registers at NORMAL without receiveCanceled
//    (ForgeEventWrapper bytecode), so this uses MinecraftForge.EVENT_BUS.addListener directly.
//
// 2. The Hordes hooks. The Hordes 1.6.3i posts HordeStartWaveEvent / HordeEndEvent (per player,
//    net.smileycorp.hordes.common.event) on MinecraftForge.EVENT_BUS. The player gets the
//    scoreboard tag pne_horde from the first real wave until the horde ends. pne_horror.js reads
//    the tag for Hive Night atmosphere (text and sound only) and to hold back reinforcement
//    beckons and half of the Mobs Inside bursts during the horde. Nothing here spawns, converts
//    or cancels anything.
//
// ES5 only (Rhino). Every body is wrapped in try/catch and fails safe.

var $PneRForgeRegistries = null
var $PneRResourceLocation = null
try { $PneRForgeRegistries = Java.loadClass('net.minecraftforge.registries.ForgeRegistries') } catch (e) { $PneRForgeRegistries = null }
try { $PneRResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation') } catch (e) { $PneRResourceLocation = null }

var pneRCothEffect = null
var pneRNetLogged = false
var pneRNetErrors = 0

// Resolved lazily: startup scripts run before registries are populated.
function pneRCoth() {
  if (pneRCothEffect) return pneRCothEffect
  try { pneRCothEffect = $PneRForgeRegistries.MOB_EFFECTS.getValue(new $PneRResourceLocation('epca', 'coth')) } catch (e) { pneRCothEffect = null }
  return pneRCothEffect
}

// Returns true, false, or null when it cannot tell.
function pneRHasCoth(entity) {
  var coth = pneRCoth()
  if (!coth) return null
  try { return entity.hasEffect(coth) ? true : false } catch (e) { }
  try { return entity.potionEffects.isActive(coth) ? true : false } catch (e2) { }
  return null
}

function pneRIsPlayer(entity) {
  try { return entity.isPlayer() ? true : false } catch (e) { return false }
}

// 1. Drops safety net
try {
  var $PneRMinecraftForge = Java.loadClass('net.minecraftforge.common.MinecraftForge')
  var $PneREventPriority = Java.loadClass('net.minecraftforge.eventbus.api.EventPriority')
  var $PneRLivingDropsEvent = Java.loadClass('net.minecraftforge.event.entity.living.LivingDropsEvent')
  $PneRMinecraftForge.EVENT_BUS.addListener($PneREventPriority.LOW, true, $PneRLivingDropsEvent, function (event) {
    if (pneRNetErrors >= 20) return
    try {
      if (!event.isCanceled()) return
      var entity = event.getEntity()
      if (!entity || !pneRIsPlayer(entity)) return
      var coth = pneRHasCoth(entity)
      if (coth === false) return
      event.setCanceled(false)
      if (!pneRNetLogged) {
        pneRNetLogged = true
        console.info('[pne_hive_rules] restored a player drop list that EPCA cancelled (COTH); Corpse will receive it')
      }
    } catch (err) {
      pneRNetErrors++
      if (pneRNetErrors >= 20) console.warn('[pne_hive_rules] drops safety net disabled after repeated errors: ' + err)
    }
  })
} catch (regErr) {
  console.warn('[pne_hive_rules] could not register the COTH drops safety net: ' + regErr)
}

// 2. The Hordes hooks
//    The player is tagged on each wave The Hordes actually starts, not on HordeStartEvent.
//    HordeEvent.tryStartEvent posts the @Cancelable HordeStartEvent before it checks the spawn
//    table and, when the table is empty, gives up without posting HordeEndEvent. spawnWave posts
//    HordeStartWaveEvent (also @Cancelable, subclass of HordePlayerEvent with getPlayer()) only
//    once spawn data exists, and returns if a listener cancelled it. The first wave starts with
//    the horde (timer 6000 % interval 2000 == 0), later waves every hordeSpawnInterval ticks.
//    Registered at LOWEST with receiveCanceled=false, so cancelled waves never reach this.
//    Each wave also resets the player's pne_horde_age score, which pne_horror.js uses to clear
//    leftover tags 12000 ticks after the last wave (a missed end event).
function pneRPlayerName(player) {
  try { return String(player.getGameProfile().getName()) } catch (e) { }
  try { return String(player.username) } catch (e2) { }
  try { return String(player.getName().getString()) } catch (e3) { }
  return ''
}

function pneRRun(player, cmd) {
  try { player.getServer().runCommandSilent(cmd); return } catch (e) { }
  try { player.server.runCommandSilent(cmd) } catch (e2) { }
}

function pneRTagPlayer(player, add) {
  if (!player) return
  var name = pneRPlayerName(player)
  var done = false
  try {
    if (add) {
      player.addTag('pne_horde')
    } else {
      player.removeTag('pne_horde')
      player.removeTag('pne_horde_told')
    }
    done = true
  } catch (e) { done = false }
  if (!name || !/^[A-Za-z0-9_]{1,16}$/.test(name)) return
  if (!done) {
    if (add) {
      pneRRun(player, 'tag ' + name + ' add pne_horde')
    } else {
      pneRRun(player, 'tag ' + name + ' remove pne_horde')
      pneRRun(player, 'tag ' + name + ' remove pne_horde_told')
    }
  }
  if (add) {
    pneRRun(player, 'scoreboard players set ' + name + ' pne_horde_age 0')
  } else {
    pneRRun(player, 'scoreboard players reset ' + name + ' pne_horde_age')
  }
}

function pneROnWave(event) {
  try {
    if (event.isCanceled()) return
    pneRTagPlayer(event.getPlayer(), true)
  } catch (err) { }
}

var pneRWaveHooked = false
try {
  var $PneRMinecraftForge2 = Java.loadClass('net.minecraftforge.common.MinecraftForge')
  var $PneREventPriority2 = Java.loadClass('net.minecraftforge.eventbus.api.EventPriority')
  var $PneRHordeStartWaveEvent = Java.loadClass('net.smileycorp.hordes.common.event.HordeStartWaveEvent')
  $PneRMinecraftForge2.EVENT_BUS.addListener($PneREventPriority2.LOWEST, false, $PneRHordeStartWaveEvent, pneROnWave)
  pneRWaveHooked = true
} catch (waveErr) {
  console.warn('[pne_hive_rules] could not hook HordeStartWaveEvent at LOWEST, falling back to ForgeEvents: ' + waveErr)
}

try {
  if (!pneRWaveHooked) {
    // NORMAL priority; the isCanceled check skips waves cancelled by earlier listeners.
    ForgeEvents.onEvent('net.smileycorp.hordes.common.event.HordeStartWaveEvent', pneROnWave)
  }
  ForgeEvents.onEvent('net.smileycorp.hordes.common.event.HordeEndEvent', function (event) {
    try { pneRTagPlayer(event.getPlayer(), false) } catch (err) { }
  })
} catch (hordeErr) {
  console.warn('[pne_hive_rules] The Hordes events unavailable, Hive Night atmosphere is off: ' + hordeErr)
}
