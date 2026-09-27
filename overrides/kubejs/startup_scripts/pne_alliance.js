// Parasites New Dawn - Enhanced :: EPCA + Spore alliance (startup)
//
// EPCA (mod id epca) and Fungal Infection: Spore (mod id spore, verified in its mods.toml) are
// two strains of one plague. Neither may pick the other as a target; both still hunt the player.
//
// Forge 47 fires LivingChangeTargetEvent (cancelable) from Mob.setTarget and from brain-based
// attack-target changes. Cancelling it keeps the mob's previous target. This covers targeting
// goals and revenge targeting after area damage. It does not stop area effects themselves
// (EPCA COTH spread, Spore Mycelium Infection); that needs each mod's own config.
//
// Fails safe: any error is counted, and after 20 errors the filter turns itself off instead of
// throwing on every target change in the game. ES5 only (Rhino).

var $PneAForgeRegistries = null
try { $PneAForgeRegistries = Java.loadClass('net.minecraftforge.registries.ForgeRegistries') } catch (e) { $PneAForgeRegistries = null }

var pneAErrors = 0
var pneADisabled = false

// Namespace of an entity's type. KubeJS exposes entity.type as the registry id string; the Forge
// registry lookup (ForgeRegistries.ENTITY_TYPES.getKey(entity.getType())) is the fallback, and
// "entity.<ns>.<path>" (EntityType.toString) is handled last.
function pneANamespace(entity) {
  if (!entity) return ''
  var s = ''
  try { s = String(entity.type) } catch (e) { s = '' }
  var i = s.indexOf(':')
  if (i > 0) return s.substring(0, i)
  if ($PneAForgeRegistries) {
    try {
      var key = $PneAForgeRegistries.ENTITY_TYPES.getKey(entity.getType())
      if (key) return String(key.getNamespace())
    } catch (e2) { }
  }
  if (s.indexOf('entity.') === 0) {
    var parts = s.split('.')
    if (parts.length >= 3) return parts[1]
  }
  return ''
}

try {
  ForgeEvents.onEvent('net.minecraftforge.event.entity.living.LivingChangeTargetEvent', function (event) {
    if (pneADisabled) return
    try {
      var target = event.getNewTarget()
      if (!target) return
      var a = pneANamespace(event.getEntity())
      if (a !== 'epca' && a !== 'spore') return
      var b = pneANamespace(target)
      if ((a === 'epca' && b === 'spore') || (a === 'spore' && b === 'epca')) {
        event.setCanceled(true)
      }
    } catch (err) {
      pneAErrors++
      if (pneAErrors >= 20) {
        pneADisabled = true
        console.warn('[pne_alliance] disabled after repeated errors: ' + err)
      }
    }
  })
} catch (regErr) {
  console.warn('[pne_alliance] could not register the target filter: ' + regErr)
}
