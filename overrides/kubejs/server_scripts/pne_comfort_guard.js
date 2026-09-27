// Parasites New Dawn - Enhanced :: comfort guard (server side)
//
// Fungal Infection: Spore 2.2.0j shakes the player's camera in ForgeEvents.onCameraAngles
// (ViewportEvent.ComputeCameraAngles, random setYaw/setPitch). It fires within 25 blocks of a
// spore:nuke (NukeEntity, made by nuclear flesh bombs from the Howitzer and the Challenge arena, and
// by Spore's debug command) and near a burrowing, moving Hohlfresser. No Spore config switch turns
// it off, and screenEffectScale doesn't affect it.
//
// So these entities are stopped from entering the world at all (EntityJoinLevelEvent, which covers
// natural spawns, spawners, eggs, /summon, Spore's own hivemind/assimilation spawns and entities
// loaded from saved chunks). This also backs up the BadMobs block of the Howitzer and Hohlfresser,
// and removes the nuke's terrain damage.
//
// event.cancel() in KubeJS 6 works by throwing EventExit. A try/catch around it would swallow that
// exception and the spawn would go through, so cancel() is called after the try block.

var PNE_COMFORT_BLOCKED_ENTITIES = [
  'spore:nuke',
  'spore:howitzer',
  'spore:howit_arm',
  'spore:hohlfresser',
  'spore:hohlfresser_seg'
]

function pneRegisterSpawnBlock(entityId) {
  try {
    EntityEvents.spawned(entityId, function (event) {
      var block = true
      try {
        // Nothing to decide: every entity of this type is blocked. The try keeps the handler
        // fail-safe if KubeJS changes the event shape.
        block = event != null
      } catch (err) {
        block = true
      }
      if (block) event.cancel()
    })
  } catch (errReg) {
    console.warn('[pne] comfort guard: could not block spawns of ' + entityId + ': ' + errReg)
  }
}

for (var pneGuardIndex = 0; pneGuardIndex < PNE_COMFORT_BLOCKED_ENTITIES.length; pneGuardIndex++) {
  pneRegisterSpawnBlock(PNE_COMFORT_BLOCKED_ENTITIES[pneGuardIndex])
}
