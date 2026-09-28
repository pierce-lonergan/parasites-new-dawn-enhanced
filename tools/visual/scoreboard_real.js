// Real-class run of pne_visual.js's clade teams (tools/visual/scoreboard_api.py step 4). ES5, Rhino only. Files, in order:
// tools/tests/kjs_mocks.js, tools/visual/vis_prelude.js, tools/visual/scoreboard_real_prelude.js, pne_00_core.js,
// pne_visual.js, this file; the SRG Minecraft jar and the instance's libraries on the classpath, the game's remapper on.
// The mock server's getScoreboard() answers a real net.minecraft.world.scores.Scoreboard (the superclass of
// ServerScoreboard, whose own overrides only add the client broadcast and need a running server), so every call
// pne_visual.js makes on the scoreboard, its teams and the option enums goes to Minecraft's own classes under the
// names the remapper gives them. Result: pneVisRealResult ("PASS n ..." or "FAIL ...").

var pneVisRealFails = []
var pneVisRealN = 0

function pneVisRealT(cond, msg) {
  pneVisRealN++
  if (!cond) pneVisRealFails.push(msg)
}

function pneVisRealRun() {
  var SB = Java.loadClass('net.minecraft.world.scores.Scoreboard')
  var SSB = Java.loadClass('net.minecraft.server.ServerScoreboard')
  var V = Java.loadClass('net.minecraft.world.scores.Team$Visibility')
  var C = Java.loadClass('net.minecraft.world.scores.Team$CollisionRule')
  var real = new SB()
  var srv = __pneMock.server({})
  var names
  var i
  var t
  var ok
  var old
  var m
  var m2
  var ssb
  var cmds0
  var fn = ['getPlayerTeam', 'addPlayerTeam', 'getPlayersTeam', 'addPlayerToTeam', 'removePlayerFromTeam', 'getPlayerTeams']
  for (i = 0; i < __pneVisRealPre.length; i++) pneVisRealT(false, __pneVisRealPre[i])
  srv.getScoreboard = function () { return real }
  pneVisRealT($PneVisVisibility !== null && $PneVisCollision !== null && String($PneVisVisibility.NEVER) === 'NEVER' &&
    String($PneVisCollision.ALWAYS) === 'ALWAYS', 'pne_visual.js loaded the real Team$Visibility / Team$CollisionRule (String() gives the constant name)')
  pneVisRealT(typeof real.m_83489_ === 'undefined' && typeof real.getPlayerTeam === 'function', 'SRG names hidden, Mojang names visible (remapper on)')
  // a team left by an older version: another collision rule, and friendly fire off as Recruits leaves it after a start
  old = real.addPlayerTeam('pne_clade_1')
  old.setCollisionRule(C.PUSH_OTHER_TEAMS)
  old.setAllowFriendlyFire(false)
  old.setSeeFriendlyInvisibles(false)
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneVisRealT(Number(real.getPlayerTeams().size()) === 1, 'no team created before the start')
  cmds0 = srv.cmds.length
  srv.tickCount = 99
  __pneMock.tick(srv, 1)
  names = pneVisTeamNames()
  pneVisRealT(pneVisTeamsReady === true && pneVisTeamsOk === 8, 'the first tick after the start sets up all 8 teams (' + pneVisTeamsOk + '/8)')
  ok = true
  for (i = 0; i < names.length; i++) {
    t = real.getPlayerTeam(names[i])
    if (!t) {
      ok = false
      continue
    }
    if (String(t.getNameTagVisibility()) !== (i % 2 ? 'ALWAYS' : 'NEVER') || String(t.getCollisionRule()) !== 'ALWAYS' ||
        t.isAllowFriendlyFire() !== true || t.canSeeFriendlyInvisibles() !== true) ok = false
  }
  pneVisRealT(ok, 'real PlayerTeam options read back: nametag never / always (_named), collision always, friendly fire and invisibles on')
  pneVisRealT(Number(real.getPlayerTeams().size()) === 8 && String(real.getPlayerTeam('pne_clade_1').getCollisionRule()) === 'ALWAYS' &&
    real.getPlayerTeam('pne_clade_1').isAllowFriendlyFire() === true, 'the old team was repaired in place (8 teams in all)')
  pneVisRealT(pneVisTeamsCount(srv) === 8 && pneVisStatusLine(null).indexOf('teams 8/8') === 0, 'status line: ' + pneVisStatusLine(null).substring(0, 30))
  // membership through pneVisApply / pneVisRemove and the helpers, read back from the real scoreboard
  m = __pneMock.mob(srv, 'epca:ripper', { uuid: 'feed0000-0000-4000-8000-000000000001', x: 1, z: 1 })
  m2 = __pneMock.mob(srv, 'epca:ripper', { uuid: 'feed0000-0000-4000-8000-000000000002', x: 2, z: 1 })
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneVisApply(m, { clade: 2, apex: false, graft: 0, stage: 1, strain: 'epca', e: null })
  t = real.getPlayersTeam(m.uuid)
  pneVisRealT(t !== null && String(t.getName()) === 'pne_clade_2' && pneVisHosts[m.uuid].team === 'pne_clade_2', 'apply joins the real team')
  pneVisApply(m, { clade: 3, apex: false, graft: 0, stage: 1, strain: 'epca', e: null })
  pneVisRealT(String(real.getPlayersTeam(m.uuid).getName()) === 'pne_clade_3' && Number(real.getPlayerTeam('pne_clade_2').getPlayers().size()) === 0,
    'a clade change moves the one entry (addPlayerToTeam moves it)')
  pneVisRealT(pneVisTeamJoin(srv, m2.uuid, 'pne_clade_0_named') === true && pneVisTeamOf(srv, m2.uuid) === 'pne_clade_0_named', 'pneVisTeamJoin reads back')
  pneVisRealT(pneVisTeamLeave(srv, m2.uuid) === true && real.getPlayersTeam(m2.uuid) === null, 'pneVisTeamLeave reads back (removePlayerFromTeam, one argument)')
  pneVisRealT(pneVisTeamLeave(srv, m2.uuid) === true, 'leaving again is a no-op that still reads back "not on ours"')
  real.addPlayerToTeam(m2.uuid, real.getPlayerTeam('pne_clade_0'))
  real.addPlayerToTeam('deadbeef-0000-4000-8000-00000000dead', real.getPlayerTeam('pne_clade_0'))
  pneVisRealT(pneVisTeamEmpty(srv, 'pne_clade_0') === 2 && Number(real.getPlayerTeam('pne_clade_0').getPlayers().size()) === 0, 'pneVisTeamEmpty counts 2 removals read back')
  pneVisRemove(m)
  pneVisRealT(real.getPlayersTeam(m.uuid) === null, 'pneVisRemove takes the entry off')
  // a missing team: the join fails, the teams are set up again on the next tick
  real.removePlayerTeam(real.getPlayerTeam('pne_clade_3_named'))
  pneVisRealT(pneVisTeamJoin(srv, m.uuid, 'pne_clade_3_named') === false && pneVisTeamsReady === false, 'a join to a missing team fails and clears ready')
  __pneMock.tick(srv, 1)
  pneVisRealT(pneVisTeamsReady === true && real.getPlayerTeam('pne_clade_3_named') !== null, 'the next tick recreates it')
  pneVisRealT(pneVisTeamJoin(srv, m.uuid, 'pne_clade_3_named') === true, 'and the join then reads back')
  // no console command on the way (the vis_prelude interpreter would have logged it)
  ok = true
  for (i = cmds0; i < srv.cmds.length; i++) {
    if (String(srv.cmds[i]).indexOf('team') >= 0) ok = false
  }
  pneVisRealT(ok, 'no console command named a team')
  // the ServerScoreboard subclass (what server.getScoreboard() returns in game) shows the same names
  ssb = new SSB(null)
  ok = true
  for (i = 0; i < fn.length; i++) {
    if (typeof ssb[fn[i]] !== 'function') ok = false
  }
  pneVisRealT(ok, 'ServerScoreboard answers ' + fn.join(', ') + ' under their Mojang names')
  pneVisRealT(String(V.valueOf('NEVER')) === 'NEVER', 'enum valueOf round trip')
  if (pneVisRealFails.length) return 'FAIL ' + pneVisRealFails.length + ' of ' + pneVisRealN + ': ' + pneVisRealFails.join(' || ')
  return 'PASS ' + pneVisRealN + ' real-class assertions (Scoreboard, PlayerTeam, Team$Visibility, Team$CollisionRule)'
}

var pneVisRealResult = (function () {
  try {
    return pneVisRealRun()
  } catch (e) {
    return 'FAIL exception ' + e + (e && e.stack ? ' ' + e.stack : '')
  }
})()
