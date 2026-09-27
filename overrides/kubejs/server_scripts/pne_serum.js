// Parasites New Dawn - Enhanced :: Hive Serum effect
// Runs at eat-time via commands, so effect IDs resolve after every mod has registered them.
// An unknown effect ID only makes that one command fail silently.

const PNE_PURGED_EFFECTS = [
  'epca:coth', 'epca:bleeding', 'epca:corrosive', 'epca:fear',
  'epca:viral', 'epca:ender_erosion', 'minecraft:nausea', 'minecraft:poison'
]

ItemEvents.foodEaten('pne:hive_serum', event => {
  const player = event.player
  if (!player) return
  const name = player.username
  PNE_PURGED_EFFECTS.forEach(effect => event.server.runCommandSilent(`effect clear ${name} ${effect}`))
  event.server.runCommandSilent(`effect give ${name} minecraft:resistance 30 0 true`)
  if (!player.isCreative()) player.give('minecraft:glass_bottle')
})
