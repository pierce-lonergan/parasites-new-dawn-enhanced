// Parasites New Dawn - Enhanced :: comfort filter
//
// Hard rule from the player: no nausea, no screen shake, no camera movement, and no effect that
// blocks the view. Every effect below is denied for PLAYERS only; mobs still get them.
//
// 1. Nausea (minecraft:nausea) is denied from every source: NuclearCraft radiation, NuclearCraft's
//    psycho anomaly, parasites, Spore hallucinations, pufferfish. It has no gameplay effect beyond
//    the wobble.
//
// 2. Blindness (minecraft:blindness) is denied in two cases:
//    a. Spore mobs. Bloater (tumor burst, 8 blocks), Howler (scream, 12 blocks), Gorgon (ranged
//       attack, up to 32 blocks), Umarmer and Specter (melee) apply 4-10 s of Blindness. The effect
//       event carries no source, so Blindness is denied when any spore: entity is within 40 blocks
//       of the player. That radius covers the longest of those attacks.
//    b. NuclearCraft's stage-3 radiation blindness. It's created with a 900000-tick duration
//       (12.5 hours), and that duration identifies it. NuclearCraft hard-codes these debuffs in
//       PlayerRadiation.setContaminationStage; radiation damage, weakness and poison all still apply.
//    Other Blindness (no Spore mob nearby) is left alone.
//
// 3. epca:fear (EPCA 0.147i) is denied. FearEffectClientHandler runs every client tick and, every
//    2 ticks, adds a random yaw and pitch offset of up to +-0.5 * (0.8 * (amplifier + 1)) degrees
//    to the player's camera (Player.setYRot / setXRot). screenEffectScale does not affect it.
//
// 4. spore:madness (Fungal Infection: Spore 2.2.0j) is always denied. Besides its overlay, it spawns
//    Illusion entities near the player that inflict 10 s of Blindness and Nausea, plus whispers
//    and "you are being watched" messages.
//
// 5. spore:biled is denied only while Spore's overlays are switched on (config/sporeconfig.toml,
//    [Effects] "Should the effect overlays be active ?"). Its bile_overlay.png is a film over the
//    whole screen, centre included. This pack ships sporeconfig.toml with that key set to false,
//    so normally Spore draws no overlays and Biled is allowed. The check reads Spore's own config
//    object at runtime; if it can't be read, Biled is denied.
//
// 6. Spore's Infected Cleaver (spore:cleaver): holding right-click spins the camera 10 degrees per
//    tick (InfectedCleaver.onUseTick -> ClientUtils.spinPlayer). Right-click-use of the cleaver is
//    cancelled on both client and server, so the spin never starts. Melee hits still work.
//
// Kept on purpose (no camera movement, centre of the screen stays clear):
//   epca:ender_erosion  static dark-purple edge vignette whose brightness pulses 85-100% every
//                       0.8 s. It carries delayed damage, so denying it would weaken Enderman
//                       parasites.
//   spore:corrosion     heavy edge vignette (only drawn while Spore's overlays are on).
//   spore:ignitable     heavy edge vignette (only while overlays are on); sets targets ablaze.
//   spore:mycelium_ef   thin edge vignette (only while overlays are on). Needed for Spore's
//                       infection: hunger drain, and a dead infected player rises as an Infected.
//   spore:frostbite     raises the player's frozen ticks, so vanilla's powder-snow frost edge
//                       vignette shows. It does not move the camera.
//   spore:uneasy (heartbeat, no sleep), marker, starvation, symbiosis: HUD icon only.
//
// Spore's camera shake near nukes and burrowing Hohlfressers (ForgeEvents.onCameraAngles) is not
// an effect, so it's handled in server_scripts/pne_comfort_guard.js, which stops spore:nuke,
// Howitzer and Hohlfresser entities from entering the world.
//
// Effects are compared by registry key through ForgeRegistries (Forge API, no remapping). The other
// parts use Mojang-named members (getEffect, getDuration, MobEffects.*, getBoundingBox), which rely
// on KubeJS's runtime remapping. If a part throws, that part logs once and then stays off, instead
// of throwing on every potion effect in the game.
//
// Effects applied before this script existed (for example Fear saved on a player in an existing
// world) are removed once when the player logs in.

var $PneMobEffects = Java.loadClass('net.minecraft.world.effect.MobEffects')
var $PneEventResult = Java.loadClass('net.minecraftforge.eventbus.api.Event$Result')
var $PneForgeRegistries = Java.loadClass('net.minecraftforge.registries.ForgeRegistries')
var $PneResourceLocation = Java.loadClass('net.minecraft.resources.ResourceLocation')
var PNE_NC_RADIATION_EFFECT_TICKS = 900000
var PNE_SPORE_BLINDNESS_RADIUS = 40

// Always denied on players.
var PNE_COMFORT_ALWAYS_DENY = {
  'minecraft:nausea': true,
  'epca:fear': true,
  'spore:madness': true
}
// Denied on players while Spore's effect overlays are active.
var PNE_COMFORT_OVERLAY_DENY = {
  'spore:biled': true
}
// Items whose right-click-use moves the camera.
var PNE_COMFORT_BLOCKED_USE = {
  'spore:cleaver': true
}

var pneComfortBroken = false
var pneComfortKeyBroken = false
var pneComfortBlindBroken = false
var pneComfortUseBroken = false
var pneSporeConfigClass = null
var pneSporeConfigMissing = false

// True unless Spore's config says its overlays are off. Any failure (Spore absent, config not
// loaded yet, class renamed) counts as "overlays active", so the effects stay denied.
function pneSporeOverlaysActive() {
  if (pneSporeConfigMissing) return true
  try {
    if (pneSporeConfigClass == null) pneSporeConfigClass = Java.loadClass('com.Harbinger.Spore.Core.SConfig')
    var value = pneSporeConfigClass.SERVER.activeOverlays.get()
    return String(value) !== 'false'
  } catch (err) {
    if (pneSporeConfigClass == null) {
      pneSporeConfigMissing = true
      console.warn('[pne] comfort filter: cannot read Spore overlay config, overlay effects stay denied: ' + err)
    }
    return true
  }
}

function pneEffectKey(effect) {
  var key = $PneForgeRegistries.MOB_EFFECTS.getKey(effect)
  return key == null ? '' : String(key.toString())
}

function pneComfortShouldDeny(key) {
  if (PNE_COMFORT_ALWAYS_DENY[key] === true) return true
  if (PNE_COMFORT_OVERLAY_DENY[key] === true) return pneSporeOverlaysActive()
  return false
}

// Entity type id such as "spore:bloater". getEncodeId is the vanilla id string; the fallback is
// KubeJS's type string. Returns '' if neither works.
function pneEntityTypeId(entity) {
  var id = null
  try { id = entity.getEncodeId() } catch (errA) { id = null }
  if (id == null) {
    try { id = entity.getType() } catch (errB) { id = null }
  }
  return id == null ? '' : String(id)
}

function pneIsSporeTypeId(id) {
  return id.indexOf('spore:') === 0 || id.indexOf('entity.spore.') === 0
}

// True if any spore: entity is within PNE_SPORE_BLINDNESS_RADIUS blocks of the player. Only runs
// when Blindness is about to be applied to a player, which is rare.
function pneSporeMobNear(player) {
  var level = null
  try { level = player.level() } catch (errL) { level = null }
  if (level == null) level = player.getLevel()
  var list = level.getEntities(player, player.getBoundingBox().inflate(PNE_SPORE_BLINDNESS_RADIUS))
  var n = list.size()
  for (var i = 0; i < n; i++) {
    if (pneIsSporeTypeId(pneEntityTypeId(list.get(i)))) return true
  }
  return false
}

ForgeEvents.onEvent('net.minecraftforge.event.entity.living.MobEffectEvent$Applicable', function (event) {
  if (pneComfortBroken && pneComfortKeyBroken && pneComfortBlindBroken) return
  var entity = null
  var effect = null
  var instance = null
  try {
    entity = event.getEntity()
    if (!entity || !entity.isPlayer()) return
    instance = event.getEffectInstance()
    if (!instance) return
    effect = instance.getEffect()
    if (!effect) return
  } catch (err0) {
    pneComfortBroken = true
    pneComfortKeyBroken = true
    pneComfortBlindBroken = true
    console.warn('[pne] comfort filter disabled after an error: ' + err0)
    return
  }

  // Registry-key checks (Forge API).
  var key = null
  if (!pneComfortKeyBroken) {
    try {
      key = pneEffectKey(effect)
      if (pneComfortShouldDeny(key)) {
        event.setResult($PneEventResult.DENY)
        return
      }
    } catch (err1) {
      key = null
      pneComfortKeyBroken = true
      console.warn('[pne] comfort filter (registry-key checks) disabled after an error: ' + err1)
    }
  }

  // Blindness while a Spore mob is near.
  if (!pneComfortBlindBroken) {
    try {
      var isBlindness = key != null ? key === 'minecraft:blindness' : effect == $PneMobEffects.BLINDNESS
      if (isBlindness && pneSporeMobNear(entity)) {
        event.setResult($PneEventResult.DENY)
        return
      }
    } catch (err3) {
      pneComfortBlindBroken = true
      console.warn('[pne] comfort filter (Spore blindness check) disabled after an error: ' + err3)
    }
  }

  // Vanilla checks (Mojang names via KubeJS remapping). Nausea is also covered by key above.
  if (!pneComfortBroken) {
    try {
      if (effect == $PneMobEffects.CONFUSION) {
        event.setResult($PneEventResult.DENY)
      } else if (effect == $PneMobEffects.BLINDNESS && instance.getDuration() == PNE_NC_RADIATION_EFFECT_TICKS) {
        event.setResult($PneEventResult.DENY)
      }
    } catch (err2) {
      pneComfortBroken = true
      console.warn('[pne] comfort filter (vanilla checks) disabled after an error: ' + err2)
    }
  }
})

// Cancel right-click-use of camera-spinning items. Startup-script Forge handlers run on both the
// client and the server, so the client never starts using the item and never spins the camera.
ForgeEvents.onEvent('net.minecraftforge.event.entity.player.PlayerInteractEvent$RightClickItem', function (event) {
  if (pneComfortUseBroken) return
  try {
    var stack = event.getItemStack()
    if (!stack || stack.isEmpty()) return
    var key = $PneForgeRegistries.ITEMS.getKey(stack.getItem())
    if (key != null && PNE_COMFORT_BLOCKED_USE[String(key.toString())] === true) {
      event.setCanceled(true)
    }
  } catch (err) {
    pneComfortUseBroken = true
    console.warn('[pne] comfort filter (item use) disabled after an error: ' + err)
  }
})

// One-time cleanup at login: strip denied effects the player already carries from before.
ForgeEvents.onEvent('net.minecraftforge.event.entity.player.PlayerEvent$PlayerLoggedInEvent', function (event) {
  try {
    var player = event.getEntity()
    if (!player) return
    var ids = []
    var id
    for (id in PNE_COMFORT_ALWAYS_DENY) ids.push(id)
    if (pneSporeOverlaysActive()) {
      for (id in PNE_COMFORT_OVERLAY_DENY) ids.push(id)
    }
    for (var i = 0; i < ids.length; i++) {
      try {
        var effect = $PneForgeRegistries.MOB_EFFECTS.getValue(new $PneResourceLocation(ids[i]))
        // getValue can return null or a default for unknown ids, so re-check the key.
        if (effect != null && pneEffectKey(effect) === ids[i] && player.hasEffect(effect)) {
          player.removeEffect(effect)
        }
      } catch (errOne) {
        console.warn('[pne] comfort login cleanup skipped ' + ids[i] + ': ' + errOne)
      }
    }
  } catch (err) {
    console.warn('[pne] comfort login cleanup failed: ' + err)
  }
})
