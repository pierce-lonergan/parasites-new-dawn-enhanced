// Prelude of the real-class run in tools/visual/scoreboard_api.py (not a suite of its own). ES5, Rhino only: loaded after
// tools/tests/kjs_mocks.js and tools/visual/vis_prelude.js and before pne_00_core.js / pne_visual.js, with the SRG
// Minecraft jar and the instance's libraries on the classpath. It removes the mocks' Team$Visibility and
// Team$CollisionRule entries, so pne_visual.js loads the real enums through Java.loadClass (the KubeJS class-filter
// replica of tools/rhino/PneRhino.java), and it checks that the game's remapper is active, which is what makes the
// Mojang method names visible at all (fact F34).

var __pneVisRealPre = []
if (typeof __pneRemap === 'undefined' || String(__pneRemap) !== 'minecraft') {
  __pneVisRealPre.push('the MinecraftRemapper is not active (' + (typeof __pneRemap === 'undefined' ? 'no __pneRemap' : String(__pneRemap)) + ')')
}
delete __pneMock.classes['net.minecraft.world.scores.Team$Visibility']
delete __pneMock.classes['net.minecraft.world.scores.Team$CollisionRule']

// Only the scoreboard classes come from the jar: any other Minecraft class is refused (as in the plain harness, where
// none is on the classpath), so no class initialiser pulls in the game's bootstrap (the core loads TagKey, Registries
// and ResourceLocation at the top level and copes with their absence).
var __pneVisRealJava = Java
Java = {
  loadClass: function (name) {
    var n = String(name)
    if (n.indexOf('net.minecraft.') === 0 && n.indexOf('net.minecraft.world.scores.') !== 0 && n !== 'net.minecraft.server.ServerScoreboard') {
      throw new Error('real-class run: ' + n + ' is not loaded')
    }
    return __pneVisRealJava.loadClass(n)
  }
}
