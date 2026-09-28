// priority: 50
// Parasites New Dawn - Enhanced :: The Hive Remembers, visual phenotype (server side)
//
// The hive's genomes become visible here, without changing what a mob does when it is not fighting.
//   1. Clade teams pne_clade_0..3 (nametagVisibility never, collisionRule always). Teams sync to every client,
//      where Entity Texture Features picks a clade texture variant through "teams.N" rules. The variant textures
//      are generated on the user's own machine by tools/visual/etf_variants_local.py from the user's own jars; none
//      ship in the repo. collisionRule stays "always" (vanilla pushing): in 1.20.1 pushOtherTeams lets a team member
//      push only its own team (EntitySelector.pushableBy returns "allied" for PUSH_OTHER_TEAMS, MC-87984), which
//      would stop players and parasites from pushing each other.
//      Teams and their members change ONLY through the ServerScoreboard Java API, never through a console command
//      (contract 1.5, Appendix A rule 15 (b)): Recruits cancels every server command whose text holds "team" plus
//      add/remove/join/leave after the start (and turns a short team add into a Recruits faction), and every command
//      before the start fails. The teams are set up on the first tick after the start (pneCoreStarted) and whenever a
//      check fails, with a backoff; every write is read back (pneVisTeamOf, pneVisTeamGood) before it counts.
//   2. Display grafts: one minecraft:item_display passenger per host (never a Mob, so no goal selector hands MOVE/LOOK
//      to it), doom stage 4 or higher, at most 15% of the engaged hive (hosts whose target is a player), and only
//      while the host itself is engaged. A passenger makes its host a vehicle, and vanilla idle strolls
//      (RandomStrollGoal and relatives) refuse to run for a vehicle, so a graft is summoned when its host targets a
//      player and removed PNE_VIS_LINGER ticks after it stops: an idle host never carries one. Some goals also refuse
//      to run in combat for a vehicle (vanilla LeapAtTargetGoal; Spore's carriers and grabbers), so the species in
//      PNE_VIS_NO_GRAFT (read from the mods' bytecode by tools/visual/passenger_scan.py) never get a graft. Display
//      entities never despawn, so a sweep every 200 ticks removes orphans. The graft's yaw is copied from the host's
//      body every 3 ticks (1.20.1 has no teleport_duration, and a display's rotation is not interpolated on the
//      client, so the graft turns in 3-tick steps).
//   3. Apex readability: a CustomName only on apex genomes, naming the dominant counter-trait, plus a few trait
//      particles every 2 s (0.5 Hz). A team with nametagVisibility never hides a CustomName
//      (LivingEntityRenderer.shouldShowName returns false for NEVER), so named hosts use the sibling team
//      pne_clade_<c>_named (nametagVisibility always) and the ETF rules list both names. Hosts named here carry the
//      tag pne_vis_apex, so the pillar switch can remove the names later even from hosts that were unloaded then.
// Comfort: nothing here touches the camera or applies any effect. No emissive layers, blinks or pulses
// (textures are static; particles run at 0.5 Hz, well under the 2 Hz photosensitivity limit).
// Contract: docs/IMPLEMENTATION.md 3.6 (API), 4.4 and 4.6 (names), 6.2 (off switch), 7.2 and 7.3 (slots,
// token budget), Appendix A rule 15 (start gating). Every other world change goes through server.runCommandSilent
// (pack rule 8), and only once the server has started (pneVisCmd returns 0 before); scoreboard team writes are the
// one Java exception (rule 8, contract 1.5), and they too wait for the start.

var PNE_VIS_API = 1
var pneVisReady = typeof PNE_CORE_API === 'number' && PNE_CORE_API >= 1

var PNE_VIS_CLADES = 4
var PNE_VIS_TEAM = 'pne_clade_'
var PNE_VIS_NAMED = '_named'
var PNE_VIS_TAG = 'pne_graft'
var PNE_VIS_TAG_CHK = 'pne_graft_chk'
var PNE_VIS_TAG_VAR = 'pne_gv'    // + variant 1..k: which graft a display is, so a changed occupancy index swaps it
var PNE_VIS_TAG_APEX = 'pne_vis_apex'   // on hosts that carry an apex name set here
var PNE_VIS_DISPLAY = 'minecraft:item_display'
var PNE_VIS_SHARE = 0.15          // grafts per engaged hive member, at most (TDD 3.5.2)
var PNE_VIS_MIN_STAGE = 4         // doom stage from which grafts appear
var PNE_VIS_LINGER = 40           // ticks a graft stays after its host stopped targeting a player
var PNE_VIS_SYNC_EVERY = 3        // graft yaw sync cadence (ticks), contract 7.2
var PNE_VIS_YAW_EPS = 2           // degrees; smaller changes are not sent
var PNE_VIS_SCAN_STEP = 8         // host records checked per tick (engagement, names, grafts): 200 hosts in 25 ticks
var PNE_VIS_SCAN_PER_TOKEN = 2    // records per PNE_CORE_COST.graftSync charge (5.4 us each in Rhino, mock objects)
var PNE_VIS_GRANT_MAX = 2         // grafts summoned per tick
var PNE_VIS_DROP_MAX = 4          // grafts removed per tick because their host is no longer engaged
var PNE_VIS_RETRY = 100           // ticks before a failed summon is tried again (doubles per failure, up to 8x)
var PNE_VIS_SWEEP_EVERY = 200
var PNE_VIS_SWEEP_AT = 106
var PNE_VIS_TRIM_MAX = 16         // grafts removed per sweep while grafts exceed the cap
var PNE_VIS_TRIM_CHECK = 64       // engaged records re-checked for removal before a trim
var PNE_VIS_FX_EVERY = 40         // apex trait particles: 0.5 Hz
var PNE_VIS_FX_AT = 6
var PNE_VIS_FX_COUNT = 3
var PNE_VIS_FX_RADIUS = 32
var PNE_VIS_FX_MAX = 8            // apex hosts per particle pass
var PNE_VIS_Q_MAX = 512           // deferred applies and removals, each
var PNE_VIS_STALE_SCAN = 32       // team entries examined per scheduled sweep
var PNE_VIS_STALE_LOOKUPS = 8     // unknown team entries looked up per scheduled sweep
var PNE_VIS_STALE_MAX = 32        // team entries removed per scheduled sweep
var PNE_VIS_REDISC_STEP = 256     // entities scanned per step while rediscovering grafts after a (re)load
var PNE_VIS_TEAMS_RETRY = 20      // ticks before a failed team setup runs again: 20, 40, 80 ... (doubles per failure)
var PNE_VIS_TEAMS_RETRY_MAX = 1200
var PNE_VIS_TEAMS_WARN_AT = 3     // the one warning comes with this consecutive failure
var PNE_VIS_NAME_KEY = 'pne.vis.apex.'
var PNE_VIS_NAME_TEXT = 'Hive Apex'
var PNE_VIS_UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

// Genes 0..11 are the counter genes (TDD 3.2); TEL (12) and MOR (13) never name an apex.
var PNE_VIS_GENES = ['SPD', 'ACU', 'SCT', 'LUX', 'FLK', 'SIL', 'KBR', 'PRJ', 'ARM', 'PRC', 'HPX', 'DMG', 'TEL', 'MOR']
var PNE_VIS_COUNTER_GENES = 12
var PNE_VIS_TRAIT = ['Runner', 'Seer', 'Tracker', 'Lightproof', 'Flanker', 'Silent', 'Anchored', 'Arrowproof',
  'Armoured', 'Shieldbreaker', 'Enduring', 'Brute']
// Dim, slow particles only (no flash, firework or glow particles).
var PNE_VIS_TRAIT_FX = ['white_ash', 'warped_spore', 'warped_spore', 'warped_spore', 'white_ash', 'mycelium',
  'mycelium', 'mycelium', 'mycelium', 'crimson_spore', 'mycelium', 'crimson_spore']

// Species that fight differently while something rides them, so they never get a graft. Generated from the
// bytecode of EPCA 0.147i and Spore 2.2.0j by tools/visual/passenger_scan.py (suite visual-passenger-scan fails
// when a pack update adds one that is missing here): vanilla LeapAtTargetGoal refuses to leap for a vehicle, and
// Spore's carriers and grabbers (Busser, Brute, Leaper, Umarmer, Ogre, Grakensenker, ...) test isVehicle, read their
// first passenger or position their riders, which a display passenger would block.
var PNE_VIS_NO_GRAFT = {
  'epca:large_incomplete_form': 1,
  'spore:bairn': 1, 'spore:brot': 1, 'spore:brute': 1, 'spore:busser': 1, 'spore:hevoker_arm': 1,
  'spore:inf_player': 1, 'spore:inquisitor': 1, 'spore:jagd': 1, 'spore:kraken': 1, 'spore:lacerator': 1,
  'spore:leaper': 1, 'spore:leviathan': 1, 'spore:ogre': 1, 'spore:plagued': 1, 'spore:saugling': 1,
  'spore:sieger': 1, 'spore:stalker': 1, 'spore:umarmed': 1, 'spore:wendigo': 1
}

// Graft variants, indexed by the hive's occupancy index 1..k (k = 4). rot is a quaternion [x, y, z, w],
// pos a translation from the passenger seat in the host's body frame (+z forward), s a uniform scale.
// Items are referenced, never copied; a missing item id would just render nothing.
var PNE_VIS_GRAFTS = [
  { item: 'epca:infested_bone', rot: [-0.3007, 0, 0, 0.9537], pos: [0, 0.05, -0.28], s: 0.55 },
  { item: 'epca:infested_flesh', rot: [0, 0, 0.1736, 0.9848], pos: [0.18, 0.12, -0.08], s: 0.45 },
  { item: 'epca:diseased_heart', rot: [0, 0.2588, 0, 0.9659], pos: [-0.16, 0.1, -0.12], s: 0.4 },
  { item: 'minecraft:bone', rot: [0.5, 0, 0, 0.866], pos: [0, 0.32, 0.05], s: 0.5 }
]

var $PneVisUUID = null
try { $PneVisUUID = Java.loadClass('java.util.UUID') } catch (e) { $PneVisUUID = null }
// The vanilla team option enums (Mojang class names at runtime; constants keep their names). Loading a class only
// reads; nothing is written here.
var $PneVisVisibility = null
try { $PneVisVisibility = Java.loadClass('net.minecraft.world.scores.Team$Visibility') } catch (e) { $PneVisVisibility = null }
var $PneVisCollision = null
try { $PneVisCollision = Java.loadClass('net.minecraft.world.scores.Team$CollisionRule') } catch (e) { $PneVisCollision = null }

var PNE_VIS_B_TICK = pneVisReady ? pneCoreBreaker('visual.tick', 5, 'consecutive') : null

// ---------------------------------------------------------------------------------------------
// State (module-level; /reload starts it fresh, and the rediscovery pass rebuilds graft records)

var pneVisHosts = {}          // host uuid -> record
var pneVisHostN = 0           // records (live hive members VISUAL knows)
var pneVisEngN = 0            // records whose host targets a player (the engaged hive)
var pneVisGraftN = 0          // records with a graft
var pneVisGraftSeq = 0        // order in which grafts appeared (the newest are trimmed first)
var pneVisGraftList = []      // host uuids with a graft (yaw sync order)
var pneVisGraftDirty = true
var pneVisSyncCursor = 0
var pneVisFxCursor = 0
var pneVisScanKeys = null     // snapshot of the record keys for the current scan cycle
var pneVisScanAt = 0
var pneVisScanCycles = 0
var pneVisApplyOrder = []     // deferred applies (budget refused), FIFO of uuids
var pneVisApplyPending = {}   // uuid -> { mob, info }
var pneVisRemoveOrder = []    // deferred removals, FIFO of uuids
var pneVisRemovePending = {}  // uuid -> { level, disp }
var pneVisTeamsReady = false  // all 8 clade teams exist with their options, read back after the last setup
var pneVisTeamsRetryAt = 0    // pneCoreTick from which the next team setup may run (backoff after a failed check)
var pneVisTeamsFails = 0      // consecutive failed team setups
var pneVisTeamsOk = 0         // teams that passed the last setup's check
var pneVisSweepPhase = 0      // scheduled sweep: 0 idle, 1 orphans, 2 cap trim, 3 stale window (even ticks only)
var pneVisOffClean = false
var pneVisSwept = 0           // orphans and stale entries removed since load
var pneVisStaleTeam = 0
var pneVisStaleAt = 0
var pneVisStaleList = null
var pneVisRediscPending = true
var pneVisRedisc = null
var pneVisLevelsTick = -1
var pneVisLevelsList = []
var pneVisGraftsWas = true    // vis_grafts as the last scheduled sweep saw it

// ---------------------------------------------------------------------------------------------
// Small helpers

function pneVisTeamName(clade, named) {
  return PNE_VIS_TEAM + clade + (named ? PNE_VIS_NAMED : '')
}

function pneVisTeamNames() {
  var out = []
  var c
  for (c = 0; c < PNE_VIS_CLADES; c++) {
    out.push(pneVisTeamName(c, false))
    out.push(pneVisTeamName(c, true))
  }
  return out
}

function pneVisOurTeam(name) {
  return String(name).indexOf(PNE_VIS_TEAM) === 0
}

// The server has started (contract 1.5, Appendix A rule 15 (a)): the core sets pneCoreStarted on the first tick after a
// load or /reload. Before that no command and no scoreboard write may run. A core without the flag counts as started.
function pneVisStarted() {
  return typeof pneCoreStarted !== 'boolean' || pneCoreStarted === true
}

// Runs a command as the server (permission 4, output suppressed); returns its result count, 0 on failure. Returns 0
// without running anything before the start (rule 15 (a)), and for any text that names a team (rule 15 (b): Recruits
// takes such commands over; VISUAL changes teams only through the Java API below). The count is only a hint: required
// state is read back, never inferred from it (rule 15 (c)).
function pneVisCmd(srv, cmd) {
  var r = 0
  var c = String(cmd)
  if (!pneVisStarted()) return 0
  if (c.indexOf('team') >= 0) {
    pneCoreWarn('visual', 'teamcmd', 'refused a console command naming a scoreboard team (Recruits intercepts those): ' + c.substring(0, 60), 1)
    return 0
  }
  try { r = Number(srv.runCommandSilent(c)) } catch (e) { r = 0 }
  return isFinite(r) ? r : 0
}

function pneVisServer(mob) {
  var s = null
  try { s = mob.getServer() } catch (e) { s = null }
  return s ? s : pneCoreServer
}

function pneVisLevelOf(entity) {
  var l = null
  try { l = entity.getLevel() } catch (e) { l = null }
  return l ? l : null
}

// Removed (unloaded, killed, discarded) or dead.
function pneVisGone(entity) {
  if (!entity) return true
  try { if (entity.isRemoved()) return true } catch (e) { }
  try { return entity.isAlive() ? false : true } catch (e2) { return false }
}

// Engaged: the host's current target is a live player (the hive's own meaning of "engaged", contract 3.3).
// Mob.getTarget() is a read under its Mojang name (KubeJS does not rename it).
function pneVisEngaged(mob) {
  var t = null
  try { t = mob.getTarget() } catch (e) { t = null }
  if (!t || !pneCoreIsPlayer(t)) return false
  return !pneVisGone(t)
}

function pneVisUuidObj(u) {
  if (!$PneVisUUID) return null
  try { return $PneVisUUID.fromString(String(u)) } catch (e) { return null }
}

// The loaded entity with this UUID in one level, or null (ServerLevel.getEntity(UUID) is a read).
function pneVisFindIn(level, u) {
  var id
  var e = null
  if (!level) return null
  id = pneVisUuidObj(u)
  if (!id) return null
  try { e = level.getEntity(id) } catch (err) { e = null }
  return e ? e : null
}

function pneVisLevels(srv) {
  var out = []
  var it
  if (pneVisLevelsTick === pneCoreTick && pneVisLevelsList.length) return pneVisLevelsList
  try {
    it = srv.getAllLevels().iterator()
    while (it.hasNext()) out.push(it.next())
  } catch (e) { out = [] }
  if (!out.length) {
    try { out.push(srv.getOverworld()) } catch (e2) { }
  }
  pneVisLevelsList = out
  pneVisLevelsTick = pneCoreTick
  return out
}

function pneVisFind(srv, u, hint) {
  var ls
  var i
  var e = pneVisFindIn(hint, u)
  if (e) return e
  ls = pneVisLevels(srv)
  for (i = 0; i < ls.length; i++) {
    if (ls[i] === hint) continue
    e = pneVisFindIn(ls[i], u)
    if (e) return e
  }
  return null
}

function pneVisScoreboard(srv) {
  var sb = null
  try { sb = srv.getScoreboard() } catch (e) { sb = null }
  return sb ? sb : null
}

// Name of the entry's team on the scoreboard sb, '' for none, null when it cannot be read.
function pneVisTeamOfSb(sb, u) {
  var t = null
  if (!sb) return null
  try { t = sb.getPlayersTeam(u) } catch (e) { return null }
  if (!t) return ''
  try { return String(t.getName()) } catch (e2) { return null }
}

// Name of the entry's team, '' for none, null when the scoreboard cannot be read.
function pneVisTeamOf(srv, u) {
  return pneVisTeamOfSb(pneVisScoreboard(srv), u)
}

// A team name as read (pneVisTeamOf) if it is one of ours, else '' (no team, a foreign team, or unreadable).
function pneVisOurName(cur) {
  return cur !== null && cur !== '' && pneVisOurTeam(cur) ? cur : ''
}

// The entry's team if it is one of ours, else '': what a record's team field holds, always read back from the scoreboard.
function pneVisOurTeamOf(srv, u) {
  return pneVisOurName(pneVisTeamOf(srv, u))
}

// ---------------------------------------------------------------------------------------------
// Clade teams through the ServerScoreboard Java API (contract 1.5, spec D; names checked by tools/visual/scoreboard_api.py)
//   sb = server.getScoreboard(); team = sb.getPlayerTeam(n) || sb.addPlayerTeam(n)
//   team.setNameTagVisibility / setCollisionRule (Team$Visibility, Team$CollisionRule), setAllowFriendlyFire,
//   setSeeFriendlyInvisibles; members: sb.addPlayerToTeam(entry, team), sb.removePlayerFromTeam(entry)
// ServerScoreboard broadcasts each change to the clients and marks the scoreboard dirty, as the team command does.
// Enum values are compared through String() (their names), never as objects: Rhino's SpecialEquality treats a Java
// enum differently from the mocks (contract 1.5, spec C).

// A team passes when its options read back as wanted: nametag never (always for the _named sibling), collision always,
// friendly fire and seeing invisible team mates on (the vanilla defaults, which Recruits resets on every start).
function pneVisTeamGood(t, named) {
  try {
    if (String(t.getNameTagVisibility()) !== (named ? 'ALWAYS' : 'NEVER')) return false
    if (String(t.getCollisionRule()) !== 'ALWAYS') return false
    if (String(t.isAllowFriendlyFire()) !== 'true') return false
    return String(t.canSeeFriendlyInvisibles()) === 'true'
  } catch (e) {
    return false
  }
}

// Creates the team if it is missing and writes every option that differs; true when it then passes pneVisTeamGood.
function pneVisTeamSetup(sb, name, named) {
  var t = null
  try { t = sb.getPlayerTeam(name) } catch (e) { t = null }
  if (!t) {
    try { t = sb.addPlayerTeam(name) } catch (e2) { t = null }
    if (!t) {
      try { t = sb.getPlayerTeam(name) } catch (e3) { t = null }
    }
  }
  if (!t) return false
  try {
    if (String(t.getNameTagVisibility()) !== (named ? 'ALWAYS' : 'NEVER')) {
      t.setNameTagVisibility(named ? $PneVisVisibility.ALWAYS : $PneVisVisibility.NEVER)
    }
    if (String(t.getCollisionRule()) !== 'ALWAYS') t.setCollisionRule($PneVisCollision.ALWAYS)
    if (String(t.isAllowFriendlyFire()) !== 'true') t.setAllowFriendlyFire(true)
    if (String(t.canSeeFriendlyInvisibles()) !== 'true') t.setSeeFriendlyInvisibles(true)
  } catch (e4) {
    return false
  }
  try { t = sb.getPlayerTeam(name) } catch (e5) { t = null }
  return t ? pneVisTeamGood(t, named) : false
}

// Sets up and checks all 8 clade teams (the caller charged PNE_CORE_COST.sweep). All 8 passing makes the teams ready;
// otherwise the next try waits PNE_VIS_TEAMS_RETRY ticks, doubling per consecutive failure up to
// PNE_VIS_TEAMS_RETRY_MAX, and the PNE_VIS_TEAMS_WARN_AT-th failure logs the one warning. Returns the teams that passed.
// Never before the start: the scoreboard exists earlier, but Recruits resets every team's friendly-fire options in its
// own start listener, which runs after KubeJS's loaded event.
function pneVisEnsureTeams(srv) {
  var names = pneVisTeamNames()
  var sb = null
  var ok = 0
  var i
  var wait
  if (!pneVisStarted()) return 0
  sb = pneVisScoreboard(srv)
  if (sb && $PneVisVisibility && $PneVisCollision) {
    for (i = 0; i < names.length; i++) {
      if (pneVisTeamSetup(sb, names[i], i % 2 === 1)) ok++
    }
  }
  pneVisTeamsOk = ok
  if (ok === names.length) {
    pneVisTeamsReady = true
    pneVisTeamsFails = 0
    return ok
  }
  pneVisTeamsReady = false
  pneVisTeamsFails++
  wait = PNE_VIS_TEAMS_RETRY
  for (i = 1; i < pneVisTeamsFails && wait < PNE_VIS_TEAMS_RETRY_MAX; i++) wait *= 2
  pneVisTeamsRetryAt = pneCoreTick + Math.min(PNE_VIS_TEAMS_RETRY_MAX, wait)
  if (pneVisTeamsFails === PNE_VIS_TEAMS_WARN_AT) {
    pneCoreWarn('visual', 'teams', 'clade teams not ready after ' + pneVisTeamsFails + ' tries (' + ok + '/' + names.length +
      ' pass; ' + (!sb ? 'scoreboard unreadable' : (!$PneVisVisibility || !$PneVisCollision) ? 'team option classes missing' : 'options did not stick') +
      '); retrying every ' + PNE_VIS_TEAMS_RETRY_MAX + ' ticks at most', 1)
  }
  return ok
}

// How many of the 8 clade teams pass right now (the status line), -1 when the scoreboard cannot be read.
function pneVisTeamsCount(srv) {
  var sb = srv ? pneVisScoreboard(srv) : null
  var names = pneVisTeamNames()
  var n = 0
  var i
  var t
  if (!sb) return -1
  for (i = 0; i < names.length; i++) {
    t = null
    try { t = sb.getPlayerTeam(names[i]) } catch (e) { t = null }
    if (t && pneVisTeamGood(t, i % 2 === 1)) n++
  }
  return n
}

// The two membership writes on a scoreboard sb the caller already holds, after the start (the caller checks it). cur is
// the entry's team as the caller just read it (pneVisTeamOfSb), so no second read comes before the write. Each returns
// the entry's team as read back after its write (cur when nothing was written): a write counts only when that read
// shows it. Joining moves the entry off any other team of ours; the callers never pass an entry on a foreign team. A
// missing team is not created here: it clears pneVisTeamsReady, so the tick sets the teams up again.
function pneVisJoinSb(sb, u, name, cur) {
  var t = null
  if (cur === name) return cur
  try { t = sb.getPlayerTeam(name) } catch (e) { t = null }
  if (!t) {
    pneVisTeamsReady = false
    return cur
  }
  try { sb.addPlayerToTeam(u, t) } catch (e2) { }
  return pneVisTeamOfSb(sb, u)
}

// Takes the entry off our team cur; an entry on no team, a foreign team or an unreadable one is left alone.
function pneVisLeaveSb(sb, u, cur) {
  if (cur === null || cur === '' || !pneVisOurTeam(cur)) return cur
  try { sb.removePlayerFromTeam(u) } catch (e) { }
  return pneVisTeamOfSb(sb, u)
}

// Puts the entry on our team `name` (moving it off any other team of ours). True only when pneVisTeamOf then reads
// `name`.
function pneVisTeamJoin(srv, u, name) {
  var sb
  if (!pneVisStarted()) return false
  sb = pneVisScoreboard(srv)
  if (!sb) return false
  return pneVisJoinSb(sb, u, name, pneVisTeamOfSb(sb, u)) === name
}

// Takes the entry off whichever of our teams it is on; a foreign team is never touched. True only when pneVisTeamOf
// then reads no team of ours (none, or a foreign one); false when the scoreboard cannot be read or it is still on ours.
function pneVisTeamLeave(srv, u) {
  var sb
  var cur
  if (!pneVisStarted()) return false
  sb = pneVisScoreboard(srv)
  if (!sb) return false
  cur = pneVisLeaveSb(sb, u, pneVisTeamOfSb(sb, u))
  return cur !== null && (cur === '' || !pneVisOurTeam(cur))
}

// Takes every entry off our team `name`; returns how many removals were read back.
function pneVisTeamEmpty(srv, name) {
  var list = pneVisTeamMembers(srv, name)
  var n = 0
  var i
  if (!list || !pneVisStarted()) return 0
  for (i = 0; i < list.length; i++) {
    if (pneVisTeamOf(srv, list[i]) === name && pneVisTeamLeave(srv, list[i])) n++
  }
  return n
}

// All entries of our teams as a JS array of strings, or null when the scoreboard cannot be read.
function pneVisTeamEntries(srv) {
  var sb = srv ? pneVisScoreboard(srv) : null
  var names = pneVisTeamNames()
  var out = []
  var i
  var t
  var it
  if (!sb) return null
  try {
    for (i = 0; i < names.length; i++) {
      t = sb.getPlayerTeam(names[i])
      if (!t) continue
      it = t.getPlayers().iterator()
      while (it.hasNext()) out.push(String(it.next()))
    }
  } catch (e) {
    return null
  }
  return out
}

function pneVisF(x) {
  var v = Number(x)
  if (!isFinite(v)) v = 0
  return String(Math.round(v * 10000) / 10000) + 'f'
}

function pneVisUuidInts(u) {
  var h = String(u).replace(/-/g, '')
  var out = []
  var i
  for (i = 0; i < 32; i += 8) out.push(String(parseInt(h.substring(i, i + 8), 16) | 0))
  return 'I;' + out.join(',')
}

// Deterministic graft UUID for a host: the host UUID with its first 8 hex digits replaced by an FNV-1a
// hash. A rejoining host finds its own graft again without any stored state.
function pneVisGraftUuid(hostU) {
  var h = pneCoreFnv1a('pne_graft|' + hostU)
  var head = ('00000000' + h.toString(16)).slice(-8)
  if (head === String(hostU).substring(0, 8)) head = ('00000000' + ((h ^ 1) >>> 0).toString(16)).slice(-8)
  return head + String(hostU).substring(8)
}

// The record's graft UUID, computed on first use and kept (pneVisGraftUuid hashes the host UUID: about 33 us in Rhino).
function pneVisRecGu(rec) {
  if (rec.gu === '') rec.gu = pneVisGraftUuid(rec.u)
  return rec.gu
}

function pneVisHostScale(mob) {
  var w = NaN
  try { w = Number(mob.getBbWidth()) } catch (e) { w = NaN }
  if (!(w > 0)) return 1
  return pneCoreClamp(w / 0.6, 0.6, 2.5)
}

// Body yaw: LivingEntity.getVisualRotationYInDegrees() returns yBodyRot. The fallback is the entity yaw under its
// KubeJS name getYaw(): KubeJS renames Entity.getYRot with @RemapForJS("getYaw"), so getYRot() does not exist in game.
function pneVisYaw(mob) {
  var y = NaN
  try { y = Number(mob.getVisualRotationYInDegrees()) } catch (e) { y = NaN }
  if (!isFinite(y)) {
    try { y = Number(mob.getYaw()) } catch (e2) { y = NaN }
  }
  return y
}

// Grafts are on unless the core defines the config key vis_grafts (requested from the lead) and it is 0.
function pneVisGraftsOn() {
  if (!PNE_CORE_DEFAULTS.hasOwnProperty('vis_grafts')) return true
  return Number(pneCoreCfg('vis_grafts')) === 1
}

function pneVisNoGraftType(mob) {
  var id = String(pneCoreTypeId(mob))
  return PNE_VIS_NO_GRAFT.hasOwnProperty(id)
}

// Which graft variant a display is (its pne_gv<k> tag), 0 when it carries none.
function pneVisDispVariant(disp) {
  var k
  for (k = 1; k <= PNE_VIS_GRAFTS.length; k++) {
    if (pneCoreHasTag(disp, PNE_VIS_TAG_VAR + k)) return k
  }
  return 0
}

function pneVisAngleDiff(a, b) {
  var d = ((Number(a) - Number(b)) % 360 + 540) % 360 - 180
  return d < 0 ? -d : d
}

// The host's passengers: { graft: our tagged display or null, foreign: whether anything else rides it }.
// getPassengers() is vanilla's List or KubeJS's EntityArrayList (both have size/get).
function pneVisRiders(mob) {
  var out = { graft: null, foreign: false }
  var ps = null
  var n = 0
  var i
  var p
  try { ps = mob.getPassengers() } catch (e) { return out }
  if (!ps) return out
  try { n = Number(ps.size()) } catch (e2) { n = 0 }
  for (i = 0; i < n; i++) {
    p = ps.get(i)
    if (!p) continue
    if (pneCoreHasTag(p, PNE_VIS_TAG)) {
      if (!out.graft) out.graft = p
    } else {
      out.foreign = true
    }
  }
  return out
}

// The passenger display that carries our tag, or null.
function pneVisGraftOf(mob) {
  return pneVisRiders(mob).graft
}

// Dominant counter-trait: index of the largest expressed counter gene (ties -> lower index), -1 if none.
function pneVisDominant(e) {
  var best = -1
  var bv = 0
  var i
  var v
  if (!e) return -1
  for (i = 0; i < PNE_VIS_COUNTER_GENES; i++) {
    v = Number(e[i])
    if (isFinite(v) && v > bv) {
      bv = v
      best = i
    }
  }
  return best
}

// 'ours' (an apex name set here), 'foreign' (any other CustomName) or 'none', plus our translation key.
function pneVisNameState(mob) {
  var has = false
  var c = null
  var key = ''
  var txt = ''
  try { has = mob.hasCustomName() ? true : false } catch (e) { has = false }
  if (!has) return { state: 'none', key: '' }
  try { c = mob.getCustomName() } catch (e2) { c = null }
  if (!c) return { state: 'none', key: '' }
  try { key = String(c.getContents().getKey()) } catch (e3) { key = '' }
  if (key.indexOf(PNE_VIS_NAME_KEY) === 0) return { state: 'ours', key: key }
  try { txt = String(c.getString()) } catch (e4) { txt = '' }
  if (txt.indexOf(PNE_VIS_NAME_TEXT) === 0) return { state: 'ours', key: '' }
  return { state: 'foreign', key: '' }
}

function pneVisNameKey(trait) {
  return PNE_VIS_NAME_KEY + (trait >= 0 ? PNE_VIS_GENES[trait].toLowerCase() : 'any')
}

// SNBT for CustomName: a translatable component whose fallback is the English text (1.19.4+), so no
// language file is needed and a later translation can reuse the keys pne.vis.apex.<gene>.
function pneVisNameSnbt(trait) {
  var text = PNE_VIS_NAME_TEXT + (trait >= 0 ? ': ' + PNE_VIS_TRAIT[trait] : '')
  return '\'{"translate":"' + pneVisNameKey(trait) + '","fallback":"' + text + '","color":"dark_red","italic":false}\''
}

// ---------------------------------------------------------------------------------------------
// Records

function pneVisRecord(u, mob) {
  var r = pneVisHosts[u]
  if (!r) {
    // team: the team of ours the scoreboard showed after the last write ('' none); foreign: the host is on a team that
    // is not ours (another mod's or an operator's), which VISUAL never touches
    r = { u: u, mob: mob, key: '', clade: -1, apex: false, trait: -1, variant: 0, gvar: 0, team: '', foreign: false, name: 'none',
      disp: '', gu: '', yaw: NaN, partial: false, eng: false, engT: -1000000, gseq: 0, failN: 0, retryT: -1000000 }
    pneVisHosts[u] = r
    pneVisHostN++
  }
  r.mob = mob
  return r
}

function pneVisSetDisp(rec, d) {
  var had = rec.disp !== ''
  rec.disp = d ? String(d) : ''
  if (had && rec.disp === '') pneVisGraftN--
  if (!had && rec.disp !== '') {
    pneVisGraftN++
    pneVisGraftSeq++
    rec.gseq = pneVisGraftSeq
    rec.yaw = NaN
  }
  pneVisGraftDirty = true
}

function pneVisSetEng(rec, on) {
  var e = on ? true : false
  if (e !== rec.eng) {
    pneVisEngN += e ? 1 : -1
    rec.eng = e
  }
  if (e) rec.engT = pneCoreTick
}

function pneVisDropRecord(u) {
  var r = pneVisHosts[u]
  if (!r) return
  if (r.disp !== '') pneVisGraftN--
  if (r.eng) pneVisEngN--
  delete pneVisHosts[u]
  pneVisHostN--
  pneVisGraftDirty = true
}

// Exact counts from the records (cheap: no Java calls).
function pneVisRecount() {
  var k
  var r
  var hosts = 0
  var grafts = 0
  var eng = 0
  for (k in pneVisHosts) {
    if (!pneVisHosts.hasOwnProperty(k)) continue
    r = pneVisHosts[k]
    hosts++
    if (r.disp !== '') grafts++
    if (r.eng) eng++
  }
  pneVisHostN = hosts
  pneVisGraftN = grafts
  pneVisEngN = eng
  pneVisGraftDirty = true
}

// At most PNE_VIS_SHARE of the engaged hive carries a graft (TDD 3.5.2), so fewer than 7 engaged hosts carry none.
function pneVisGraftCap() {
  return Math.floor(PNE_VIS_SHARE * pneVisEngN + 1e-9)
}

function pneVisCapOk() {
  return pneVisGraftN + 1 <= pneVisGraftCap()
}

// A host carries its graft only while it is engaged, and for PNE_VIS_LINGER ticks after it stopped being engaged
// (a target lost for a moment does not make the graft flicker).
function pneVisShouldCarry(rec, now) {
  if (rec.variant <= 0) return false
  return rec.eng || now - rec.engT <= PNE_VIS_LINGER
}

// ---------------------------------------------------------------------------------------------
// Grafts

function pneVisWant(mob, info) {
  var c = Math.floor(Number(info.clade))
  var g = Math.floor(Number(info.graft))
  var st = Math.floor(Number(info.stage))
  var apex = info.apex === true || String(info.apex) === 'true'
  var e = info.e || null
  var hi
  var trait = -1
  var gvar = 0
  var variant = 0
  if (!(c >= 0 && c < PNE_VIS_CLADES)) c = -1
  if (!isFinite(st)) st = 0
  // gvar: the graft this host should carry by the hive's occupancy index, the stage rule and the species rule;
  // variant: what it carries while engaged (0 while vis_grafts is off).
  if (g > 0 && st >= PNE_VIS_MIN_STAGE && !pneVisNoGraftType(mob)) gvar = ((g - 1) % PNE_VIS_GRAFTS.length) + 1
  variant = pneVisGraftsOn() ? gvar : 0
  if (apex) {
    if (!e) {
      hi = pneCoreHiveInfo(mob)
      e = hi ? hi.e : null
    }
    trait = pneVisDominant(e)
  }
  return { clade: c, apex: apex, trait: trait, variant: variant, gvar: gvar, stage: st,
    key: c + '|' + (apex ? 1 : 0) + '|' + trait + '|' + variant }
}

function pneVisSpawnGraft(srv, mob, u, gu, variant) {
  var g = PNE_VIS_GRAFTS[variant - 1]
  var k = pneVisHostScale(mob)
  var s = pneVisF(g.s * k)
  var nbt = '{UUID:[' + pneVisUuidInts(gu) + '],Tags:["' + PNE_VIS_TAG + '","' + PNE_VIS_TAG_VAR + variant + '"],' +
    'KubeJSPersistentData:{pne_host:"' + u + '"},' +
    'item:{id:"' + g.item + '",Count:1b},item_display:"fixed",view_range:0.5f,shadow_radius:0f,' +
    'transformation:{left_rotation:[' + pneVisF(g.rot[0]) + ',' + pneVisF(g.rot[1]) + ',' + pneVisF(g.rot[2]) + ',' + pneVisF(g.rot[3]) + '],' +
    'right_rotation:[0f,0f,0f,1f],translation:[' + pneVisF(g.pos[0] * k) + ',' + pneVisF(g.pos[1] * k) + ',' + pneVisF(g.pos[2] * k) + '],' +
    'scale:[' + s + ',' + s + ',' + s + ']}}'
  if (pneVisCmd(srv, 'execute at ' + u + ' run summon ' + PNE_VIS_DISPLAY + ' ~ ~ ~ ' + nbt) <= 0) return false
  if (pneVisCmd(srv, 'ride ' + gu + ' mount ' + u) > 0) return true
  pneVisCmd(srv, 'kill ' + gu)
  return false
}

// Brings the host's graft in line with the record. Returns what happened:
//   'none'     no graft wanted now (variant 0, or the host is not engaged): any riding graft was removed
//   'kept'     a riding display of the right variant (or of unknown variant, from before variant tags) was adopted
//   'granted'  a lone display with the host's graft UUID was re-mounted, or a new one summoned
//   'later'    a graft is wanted but spawn is false (the apply path; the scan grants it)
//   'foreign'  the host carries something else, so it gets no graft now
//   'wait', 'cap', 'budget', 'failed'   refused: retry backoff, the 15% cap, the token budget, a failed summon
// A display of another variant is replaced. A display with the host's graft UUID that rides nothing is re-mounted in
// the same dimension; in another dimension it is an orphan left by a dimension change and is removed first (a UUID
// selector takes the first level that has it, so this must happen while the new graft does not exist yet). A summon
// and its ride charge two visApply tokens on top of whatever the caller charged. The graft UUID is only computed on
// the paths that need it, once per record (pneVisRecGu).
function pneVisGraftStep(srv, mob, u, rec, now, spawn) {
  var rd = pneVisRiders(mob)
  var disp = rd.graft
  var gu
  var dv
  var lone
  if (!pneVisShouldCarry(rec, now)) {
    if (disp) pneVisCmd(srv, 'kill ' + (pneCoreUuid(disp) || pneVisRecGu(rec)))
    else if (rec.disp !== '') pneVisCmd(srv, 'kill ' + rec.disp)
    pneVisSetDisp(rec, '')
    return 'none'
  }
  if (disp) {
    dv = pneVisDispVariant(disp)
    if (dv === 0 || dv === rec.variant) {
      pneVisSetDisp(rec, pneCoreUuid(disp) || pneVisRecGu(rec))
      return 'kept'
    }
    pneVisCmd(srv, 'kill ' + (pneCoreUuid(disp) || pneVisRecGu(rec)))
  }
  pneVisSetDisp(rec, '')
  if (rd.foreign) return 'foreign'
  if (!spawn) return 'later'
  if (now < rec.retryT) return 'wait'
  if (!pneVisCapOk()) return 'cap'
  if (!pneCoreTake(2 * PNE_CORE_COST.visApply)) return 'budget'
  gu = pneVisRecGu(rec)
  lone = pneVisFindIn(pneVisLevelOf(mob), gu)
  if (lone && !pneVisGone(lone)) {
    dv = pneVisDispVariant(lone)
    if ((dv === 0 || dv === rec.variant) && pneVisCmd(srv, 'ride ' + gu + ' mount ' + u) > 0) {
      pneVisSetDisp(rec, gu)
      rec.failN = 0
      return 'granted'
    }
    pneVisCmd(srv, 'kill ' + gu)
  } else {
    lone = pneVisFind(srv, gu, null)
    if (lone && !pneVisGone(lone)) pneVisCmd(srv, 'kill ' + gu)
  }
  if (pneVisSpawnGraft(srv, mob, u, gu, rec.variant)) {
    pneVisSetDisp(rec, gu)
    rec.failN = 0
    return 'granted'
  }
  rec.failN = rec.failN >= 4 ? 4 : rec.failN + 1
  rec.retryT = now + PNE_VIS_RETRY * (1 << (rec.failN - 1))
  return 'failed'
}

// ---------------------------------------------------------------------------------------------
// Apply

function pneVisApplyNow(mob, u, w) {
  var srv = pneVisServer(mob)
  var rec
  var ns
  var key
  var team
  var sb
  var cur
  if (!srv) return
  rec = pneVisRecord(u, mob)
  // 1. Apex name first: it decides which of the two clade teams the host joins.
  ns = pneVisNameState(mob)
  if (w.apex && ns.state !== 'foreign') {
    key = pneVisNameKey(w.trait)
    if (ns.state !== 'ours' || ns.key !== key) {
      if (pneVisCmd(srv, 'data merge entity ' + u + ' {CustomName:' + pneVisNameSnbt(w.trait) + '}') > 0) ns = { state: 'ours', key: key }
    }
  } else if (!w.apex && ns.state === 'ours') {
    if (pneVisCmd(srv, 'data remove entity ' + u + ' CustomName') > 0) ns = { state: 'none', key: '' }
  }
  pneVisApexTag(srv, mob, u, ns.state === 'ours')
  rec.name = ns.state
  // 2. Clade team (one entry per host; joining another team moves the entry). A mob that another mod or an
  // operator put on a team of their own keeps it. rec.team is what the scoreboard shows afterwards (the read-back of
  // the write, or the first read when nothing was written): a join that did not stick (teams not set up yet, an
  // unreadable scoreboard) leaves it '' and the scan tries again. One scoreboard fetch and at most two reads per apply.
  team = w.clade >= 0 ? pneVisTeamName(w.clade, ns.state !== 'none') : ''
  sb = pneVisScoreboard(srv)
  cur = pneVisTeamOfSb(sb, u)
  rec.foreign = cur !== null && cur !== '' && !pneVisOurTeam(cur)
  if (!rec.foreign && cur !== null && pneVisStarted()) {
    cur = team === '' ? pneVisLeaveSb(sb, u, cur) : pneVisJoinSb(sb, u, team, cur)
  }
  rec.team = pneVisOurName(cur)
  rec.clade = w.clade
  rec.apex = w.apex
  rec.trait = w.trait
  rec.variant = w.variant
  rec.gvar = w.gvar
  rec.partial = false
  // 3. Graft: kept, replaced or removed here; a new one is summoned by the scan while the host is engaged (its first
  // scan visit comes after every older record was re-checked, so the cap never counts hosts that already unloaded).
  pneVisSetEng(rec, pneVisEngaged(mob))
  pneVisGraftStep(srv, mob, u, rec, pneCoreTick, false)
  rec.key = w.key
}

// Tag PNE_VIS_TAG_APEX follows our apex name, so the pillar switch finds named hosts even after they were unloaded.
function pneVisApexTag(srv, mob, u, on) {
  if (pneCoreHasTag(mob, PNE_VIS_TAG_APEX) === on) return
  pneVisCmd(srv, 'tag ' + u + (on ? ' add ' : ' remove ') + PNE_VIS_TAG_APEX)
}

function pneVisDefer(u, mob, info) {
  if (!pneVisApplyPending.hasOwnProperty(u)) {
    if (pneVisApplyOrder.length >= PNE_VIS_Q_MAX) {
      pneCoreWarn('visual', 'applyq', 'deferred apply queue is full; dropping new entries until it drains')
      return
    }
    pneVisApplyOrder.push(u)
  }
  // Copy the fields: the caller may reuse its info object before the queue drains.
  pneVisApplyPending[u] = { mob: mob, info: { clade: info.clade, apex: info.apex, graft: info.graft, stage: info.stage,
    strain: info.strain, e: info.e || null } }
}

// Contract 3.6: idempotent; the hive calls it after every expression (newborn and rejoin). Charges
// PNE_CORE_COST.visApply (name and team); when the budget refuses, the apply waits in VISUAL's own queue. Before the
// start (rule 15 (a)) it only queues: the queue drains in VISUAL's tick, after the teams are set up.
function pneVisApply(mob, info) {
  var u
  var w
  var rec
  if (!pneVisReady || !mob || !info || !pneCoreOn('visual')) return
  u = pneCoreUuid(mob)
  if (!u) return
  if (!pneVisStarted()) {
    pneVisDefer(u, mob, info)
    return
  }
  w = pneVisWant(mob, info)
  rec = pneVisHosts[u]
  if (rec && !rec.partial && rec.key === w.key && !pneVisGone(rec.mob)) return
  if (!pneCoreTake(PNE_CORE_COST.visApply)) {
    pneVisDefer(u, mob, info)
    return
  }
  pneVisApplyNow(mob, u, w)
}

// ---------------------------------------------------------------------------------------------
// Remove

function pneVisRemoveNow(srv, u, level, disp) {
  var gu = disp || pneVisGraftUuid(u)
  var g
  pneVisTeamLeave(srv, u)
  // The removed host already ejected its passengers, so look the display up by its UUID.
  g = pneVisFind(srv, gu, level)
  if (g && pneCoreHasTag(g, PNE_VIS_TAG)) pneVisCmd(srv, 'kill ' + gu)
  else if (!g && disp && !$PneVisUUID) pneVisCmd(srv, 'kill ' + gu)
}

// Contract 3.6: team leave + graft discard; the hive calls it on KILLED/DISCARDED. Works with the
// visual pillar off (cleanup). A refused budget defers the removal (drained every tick, even when off), and so does a
// call before the start (rule 15 (a)).
function pneVisRemove(mob) {
  var u
  var rec
  var level
  var disp
  var srv
  if (!pneVisReady || !mob) return
  u = pneCoreUuid(mob)
  if (!u) return
  rec = pneVisHosts[u]
  disp = rec ? rec.disp : ''
  level = pneVisLevelOf(mob)
  if (pneVisApplyPending.hasOwnProperty(u)) delete pneVisApplyPending[u]
  pneVisDropRecord(u)
  srv = pneVisServer(mob)
  if (!srv) return
  if (!pneVisStarted() || !pneCoreTake(PNE_CORE_COST.visApply)) {
    if (!pneVisRemovePending.hasOwnProperty(u)) {
      if (pneVisRemoveOrder.length >= PNE_VIS_Q_MAX) {
        pneCoreWarn('visual', 'removeq', 'deferred removal queue is full; the sweep will catch the rest')
        return
      }
      pneVisRemoveOrder.push(u)
    }
    pneVisRemovePending[u] = { level: level, disp: disp }
    return
  }
  pneVisRemoveNow(srv, u, level, disp)
}

// ---------------------------------------------------------------------------------------------
// The scan (every tick): engagement, names and grafts of every known host, round robin

// Keeps the clade team in step with the host's name: a name given later (a name tag) moves the host to the _named
// team, where the name stays visible, and a name that went away moves it back. An apex name set here that was
// replaced or removed loses its PNE_VIS_TAG_APEX tag. A join that did not stick (rec.team differs from the wanted
// team) is tried again here once the teams are ready. Hosts on another team or without a clade are left alone.
function pneVisNameCheck(srv, u, r) {
  var has = false
  var ns
  var want
  var sb
  var cur
  if (r.clade < 0 || r.foreign) return
  if (r.name === 'ours') {
    ns = pneVisNameState(r.mob)
    if (ns.state !== 'ours') {
      r.name = ns.state
      pneVisApexTag(srv, r.mob, u, false)
    }
  } else {
    try { has = r.mob.hasCustomName() ? true : false } catch (e) { return }
    if (has !== (r.name !== 'none')) r.name = has ? 'foreign' : 'none'
  }
  want = pneVisTeamName(r.clade, r.name !== 'none')
  if (want === r.team || !pneVisTeamsReady || !pneVisStarted()) return
  sb = pneVisScoreboard(srv)
  cur = pneVisTeamOfSb(sb, u)
  if (cur === null) return
  if (cur !== '' && !pneVisOurTeam(cur)) {
    r.foreign = true
    r.team = ''
    return
  }
  r.team = pneVisOurName(pneVisJoinSb(sb, u, want, cur))
}

// One host record: dropped when the host is gone (removed, unloaded or dead), engagement refreshed, team kept in step
// with the name, graft kept in step with engagement. allow = { g: grafts that may still be summoned, d: grafts that
// may still be removed } for this call's pass. Returns 'gone', 'granted', 'dropped' or ''.
function pneVisCheckRecord(srv, u, now, allow) {
  var r = pneVisHosts[u]
  if (!r) return ''
  if (pneVisGone(r.mob)) {
    pneVisDropRecord(u)
    return 'gone'
  }
  pneVisSetEng(r, pneVisEngaged(r.mob))
  pneVisNameCheck(srv, u, r)
  if (pneVisShouldCarry(r, now)) {
    if (r.disp !== '') {
      if (pneVisGraftOf(r.mob)) return ''
      pneVisSetDisp(r, '')   // no longer riding: re-mounted or replaced below
    }
    if (allow.g <= 0 || !pneVisGraftsOn() || now < r.retryT || !pneVisCapOk()) return ''
    if (pneVisGraftStep(srv, r.mob, u, r, now, true) !== 'granted') return ''
    allow.g--
    return 'granted'
  }
  if (r.disp === '' || allow.d <= 0 || !pneCoreTake(PNE_CORE_COST.graftSync)) return ''
  pneVisGraftStep(srv, r.mob, u, r, now, false)
  allow.d--
  return 'dropped'
}

// maxN records per call, round robin over a snapshot of the record keys: records added during a cycle are checked
// first in the next one, after every older record (so a host's first grant never counts hosts that unloaded before
// it joined). One graftSync charge per PNE_VIS_SCAN_PER_TOKEN records; a refused charge ends this tick's pass.
function pneVisScanStep(srv, maxN) {
  var k
  var n = 0
  var now = pneCoreTick
  var allow = { g: PNE_VIS_GRANT_MAX, d: PNE_VIS_DROP_MAX }
  if (!pneVisScanKeys || pneVisScanAt >= pneVisScanKeys.length) {
    pneVisScanKeys = []
    for (k in pneVisHosts) {
      if (pneVisHosts.hasOwnProperty(k)) pneVisScanKeys.push(k)
    }
    pneVisScanAt = 0
    pneVisScanCycles++
  }
  while (pneVisScanAt < pneVisScanKeys.length && n < maxN) {
    if (n % PNE_VIS_SCAN_PER_TOKEN === 0 && !pneCoreTake(PNE_CORE_COST.graftSync)) break
    pneVisCheckRecord(srv, pneVisScanKeys[pneVisScanAt], now, allow)
    pneVisScanAt++
    n++
  }
  return n
}

// Every record at once (/pne visual sweep): drops gone records, refreshes engagement and names, removes grafts of
// hosts that are no longer engaged. It summons nothing (the scan does).
function pneVisPrune(srv) {
  var keys = []
  var k
  var i
  var allow = { g: 0, d: 1000000 }
  for (k in pneVisHosts) {
    if (pneVisHosts.hasOwnProperty(k)) keys.push(k)
  }
  for (i = 0; i < keys.length; i++) pneVisCheckRecord(srv, keys[i], pneCoreTick, allow)
  pneVisRecount()
}

// Holds the cap when the engaged hive shrinks: while grafts exceed floor(15% of the engaged hosts), grafts go,
// those of hosts no longer engaged first, then the newest. Engaged records are re-checked for removal first (at most
// PNE_VIS_TRIM_CHECK), so hosts that just unloaded do not hold the cap up. At most maxN removals per call.
function pneVisTrim(srv, maxN) {
  var list = []
  var gone = []
  var k
  var i
  var r
  var n = 0
  var checked = 0
  if (pneVisGraftN <= 0) return 0
  for (k in pneVisHosts) {
    if (!pneVisHosts.hasOwnProperty(k)) continue
    r = pneVisHosts[k]
    if (r.eng && checked < PNE_VIS_TRIM_CHECK) {
      checked++
      if (pneVisGone(r.mob)) gone.push(k)
    }
  }
  for (i = 0; i < gone.length; i++) pneVisDropRecord(gone[i])
  if (pneVisGraftN <= pneVisGraftCap()) return 0
  for (k in pneVisHosts) {
    if (pneVisHosts.hasOwnProperty(k) && pneVisHosts[k].disp !== '') list.push(pneVisHosts[k])
  }
  list.sort(function (a, b) {
    if (a.eng !== b.eng) return a.eng ? 1 : -1
    if (a.gseq !== b.gseq) return b.gseq - a.gseq
    return a.u < b.u ? -1 : (a.u > b.u ? 1 : 0)
  })
  for (i = 0; i < list.length && n < maxN && pneVisGraftN > pneVisGraftCap(); i++) {
    r = list[i]
    if (!pneVisHosts.hasOwnProperty(r.u) || r.disp === '') continue
    if (pneVisGone(r.mob)) {
      pneVisDropRecord(r.u)
      continue
    }
    pneVisCmd(srv, 'kill ' + r.disp)
    pneVisSetDisp(r, '')
    n++
  }
  return n
}

// ---------------------------------------------------------------------------------------------
// Sweep (contract 3.6: orphan grafts and stale team entries; scheduled at t % 200 === 106)

// A display with no vehicle is an orphan (its host despawned, died, changed dimension or never came back).
function pneVisSweepOrphans(srv) {
  var sel = '@e[type=' + PNE_VIS_DISPLAY + ',tag='
  pneVisCmd(srv, 'tag ' + sel + PNE_VIS_TAG + '] add ' + PNE_VIS_TAG_CHK)
  pneVisCmd(srv, 'execute as ' + sel + PNE_VIS_TAG_CHK + '] on vehicle on passengers run tag @s remove ' + PNE_VIS_TAG_CHK)
  return pneVisCmd(srv, 'kill ' + sel + PNE_VIS_TAG_CHK + ']')
}

// Members of one of our teams as a JS array of strings ([] if the team is missing, null if unreadable).
function pneVisTeamMembers(srv, name) {
  var sb = srv ? pneVisScoreboard(srv) : null
  var out = []
  var t
  var it
  if (!sb) return null
  try {
    t = sb.getPlayerTeam(name)
    if (!t) return out
    it = t.getPlayers().iterator()
    while (it.hasNext()) out.push(String(it.next()))
  } catch (e) {
    return null
  }
  return out
}

// Stale team entries (leaks): entries whose entity is not loaded, or is removed, leave the team. A host that is
// merely unloaded gets its entry back when it rejoins, because the hive re-applies after every rejoin. Vanilla
// already drops a destroyed entity's entry (ServerLevel onDestroyed -> Scoreboard.entityRemoved), so this only
// catches entities that vanished without that callback. Walks a snapshot of one team at a time, kept across
// calls; hosts VISUAL knows to be alive are skipped without a lookup. Per call at most maxScan entries, maxLookups
// lookups (a UUID parse and one getEntity per level) and maxRemove removals. Every entry is re-checked before it
// is removed, so a snapshot that went stale is harmless. Returns how many entries it removed.
function pneVisStaleStep(srv, maxScan, maxLookups, maxRemove) {
  var names = pneVisTeamNames()
  var scanned = 0
  var looked = 0
  var removed = 0
  var teams = 0
  var u
  var r
  var e
  while (scanned < maxScan && looked < maxLookups && removed < maxRemove && teams < names.length) {
    if (!pneVisStaleList) {
      pneVisStaleList = pneVisTeamMembers(srv, names[pneVisStaleTeam % names.length])
      pneVisStaleAt = 0
      if (pneVisStaleList === null) return removed
    }
    while (pneVisStaleAt < pneVisStaleList.length && scanned < maxScan && looked < maxLookups && removed < maxRemove) {
      u = pneVisStaleList[pneVisStaleAt]
      pneVisStaleAt++
      scanned++
      if (!PNE_VIS_UUID_RX.test(u)) continue
      r = pneVisHosts[u]
      if (r && !pneVisGone(r.mob)) continue
      looked++
      e = pneVisFind(srv, u, null)
      if (e && !pneVisRemovedObj(e)) continue
      // counted only when the entry was on one of our teams and the scoreboard no longer shows it there
      if (pneVisOurTeamOf(srv, u) !== '' && pneVisTeamLeave(srv, u)) removed++
    }
    if (pneVisStaleAt >= pneVisStaleList.length) {
      pneVisStaleList = null
      pneVisStaleTeam = (pneVisStaleTeam + 1) % names.length
      teams++
    }
  }
  return removed
}

function pneVisRemovedObj(entity) {
  try { return entity.isRemoved() ? true : false } catch (e) { return false }
}

// Config vis_grafts (when the core defines it). Off: every graft goes at each sweep (also grafts that load from
// disk), teams and names stay, and the records keep the graft they should carry (gvar). Back on: those hosts get
// their graft from the scan again while they are engaged. Returns how many displays it removed.
function pneVisGraftsCheck(srv) {
  var on = pneVisGraftsOn()
  var n = 0
  var k
  var r
  if (!on) {
    n = pneVisCmd(srv, 'kill @e[type=' + PNE_VIS_DISPLAY + ',tag=' + PNE_VIS_TAG + ']')
    for (k in pneVisHosts) {
      if (!pneVisHosts.hasOwnProperty(k)) continue
      r = pneVisHosts[k]
      r.variant = 0
      r.key = ''
      if (r.disp !== '') pneVisSetDisp(r, '')
    }
  } else if (!pneVisGraftsWas) {
    for (k in pneVisHosts) {
      if (!pneVisHosts.hasOwnProperty(k)) continue
      r = pneVisHosts[k]
      if (r.gvar > 0 && r.disp === '' && !r.partial) {
        r.variant = r.gvar
        r.key = ''
      }
    }
  }
  pneVisGraftsWas = on
  return n
}

// Visual switched off: every graft goes, our apex names go (from every loaded host with PNE_VIS_TAG_APEX, so also
// from hosts that were unloaded at the switch and load later), the teams are emptied once, and VISUAL forgets its
// records. Later sweeps keep removing grafts and apex names that load from disk while the pillar is off.
function pneVisSweepOff(srv) {
  var n = pneVisCmd(srv, 'kill @e[type=' + PNE_VIS_DISPLAY + ',tag=' + PNE_VIS_TAG + ']')
  var names
  var i
  var left = 0
  var m
  pneVisCmd(srv, 'execute as @e[tag=' + PNE_VIS_TAG_APEX + '] run data remove entity @s CustomName')
  pneVisCmd(srv, 'tag @e[tag=' + PNE_VIS_TAG_APEX + '] remove ' + PNE_VIS_TAG_APEX)
  if (!pneVisOffClean) {
    // the teams count as emptied only when the scoreboard shows every one of them empty; otherwise the next off sweep
    // tries again
    names = pneVisTeamNames()
    for (i = 0; i < names.length; i++) {
      n += pneVisTeamEmpty(srv, names[i])
      m = pneVisTeamMembers(srv, names[i])
      if (m === null || m.length) left++
    }
    pneVisHosts = {}
    pneVisHostN = 0
    pneVisGraftN = 0
    pneVisEngN = 0
    pneVisScanKeys = null
    pneVisApplyOrder = []
    pneVisApplyPending = {}
    pneVisGraftDirty = true
    pneVisOffClean = left === 0
  }
  pneVisSwept += n
  return n
}

// Contract 3.6. Returns how many orphan grafts and stale team entries it removed, in one full pass (used by
// /pne visual sweep). VISUAL schedules the same work itself in three budgeted phases (pneVisSweepPhaseStep).
function pneVisSweep(server) {
  var srv = server || pneCoreServer
  var n = 0
  if (!pneVisReady || !srv) return 0
  if (!pneCoreOn('visual')) return pneVisSweepOff(srv)
  pneVisOffClean = false
  n += pneVisGraftsCheck(srv)
  n += pneVisSweepOrphans(srv)
  pneVisPrune(srv)
  pneVisTrim(srv, 1000000)
  pneVisStaleTeam = 0
  pneVisStaleList = null
  n += pneVisStaleStep(srv, 1000000, 1000000, 1000000)
  pneVisRecount()
  pneVisSwept += n
  return n
}

// One phase of the scheduled sweep (the caller charged PNE_CORE_COST.sweep): 1 the vis_grafts switch and orphans,
// 2 the cap trim and an exact recount, 3 a stale-entry window. With the pillar off, phase 1 is the off sweep and
// ends the cycle.
function pneVisSweepPhaseStep(srv) {
  var n = 0
  if (!pneCoreOn('visual')) {
    pneVisSweepPhase = 0
    return pneVisSweepOff(srv)
  }
  pneVisOffClean = false
  if (pneVisSweepPhase === 1) {
    n = pneVisGraftsCheck(srv) + pneVisSweepOrphans(srv)
  } else if (pneVisSweepPhase === 2) {
    pneVisTrim(srv, PNE_VIS_TRIM_MAX)
    pneVisRecount()
  } else if (pneVisSweepPhase === 3) {
    n = pneVisStaleStep(srv, PNE_VIS_STALE_SCAN, PNE_VIS_STALE_LOOKUPS, PNE_VIS_STALE_MAX)
  }
  pneVisSweepPhase = pneVisSweepPhase >= 3 ? 0 : pneVisSweepPhase + 1
  pneVisSwept += n
  return n
}

// ---------------------------------------------------------------------------------------------
// Periodic work

function pneVisRebuildGraftList() {
  var k
  pneVisGraftList = []
  for (k in pneVisHosts) {
    if (pneVisHosts.hasOwnProperty(k) && pneVisHosts[k].disp !== '') pneVisGraftList.push(k)
  }
  pneVisGraftDirty = false
  if (pneVisSyncCursor >= pneVisGraftList.length) pneVisSyncCursor = 0
}

// Copies the host's body yaw onto its graft (only when it moved by PNE_VIS_YAW_EPS degrees or more). The client
// applies a display's rotation as it arrives (Display has no lerpTo override and DisplayRenderer reads the current
// yaw), so the graft turns in steps every 3 ticks while the host's body turns smoothly; TDD 3.5.2 accepts 2-5 ticks.
// One graftSync charge per command; a refused budget ends this pass (the next one is 3 ticks later).
function pneVisSyncYaw(srv) {
  var n
  var k
  var u
  var r
  var y
  var sent = 0
  if (pneVisGraftDirty) pneVisRebuildGraftList()
  n = pneVisGraftList.length
  for (k = 0; k < n; k++) {
    u = pneVisGraftList[(pneVisSyncCursor + k) % n]
    r = pneVisHosts[u]
    if (!r || r.disp === '' || pneVisGone(r.mob)) continue
    y = pneVisYaw(r.mob)
    if (!isFinite(y)) continue
    if (isFinite(r.yaw) && pneVisAngleDiff(y, r.yaw) < PNE_VIS_YAW_EPS) continue
    if (!pneCoreTake(PNE_CORE_COST.graftSync)) {
      pneVisSyncCursor = (pneVisSyncCursor + k) % n
      return sent
    }
    // A same-level tp keeps a passenger riding (Entity.teleportTo: moveTo + teleportPassengers, no unRide) and
    // only changes its rotation here (position = its own seat). 'data merge' would reload the whole display NBT
    // and re-send its item stack to every client on each sync.
    if (pneVisCmd(srv, 'execute as ' + r.disp + ' at @s run tp @s ~ ~ ~ ' + pneCoreFmt(y) + ' 0') > 0) {
      r.yaw = y
      sent++
    } else {
      // The graft is gone (killed, or left behind by a dimension change): the scan grants a new one.
      pneVisSetDisp(r, '')
    }
  }
  return sent
}

// A few dim particles of the dominant trait around apex hosts near a survival player, 0.5 Hz.
function pneVisFx(srv) {
  var list = []
  var k
  var i
  var r
  var lv
  var x
  var y
  var z
  var h = 1
  var n = 0
  for (k in pneVisHosts) {
    if (pneVisHosts.hasOwnProperty(k) && pneVisHosts[k].apex && !pneVisHosts[k].partial) list.push(k)
  }
  if (!list.length) return 0
  if (pneVisFxCursor >= list.length) pneVisFxCursor = 0
  for (i = 0; i < list.length && n < PNE_VIS_FX_MAX; i++) {
    r = pneVisHosts[list[(pneVisFxCursor + i) % list.length]]
    if (pneVisGone(r.mob)) continue
    lv = pneVisLevelOf(r.mob)
    try {
      x = Number(r.mob.getX())
      y = Number(r.mob.getY())
      z = Number(r.mob.getZ())
    } catch (e) { continue }
    if (!pneCorePlayersNear(lv, x, y, z, PNE_VIS_FX_RADIUS).length) continue
    if (!pneCoreTake(PNE_CORE_COST.graftSync)) break
    try { h = Number(r.mob.getBbHeight()) * 0.6 } catch (e2) { h = 1 }
    if (!(h > 0)) h = 1
    pneVisCmd(srv, 'execute at ' + r.u + ' run particle minecraft:' + (r.trait >= 0 ? PNE_VIS_TRAIT_FX[r.trait] : 'mycelium') +
      ' ~ ~' + pneCoreFmt(h) + ' ~ 0.3 0.4 0.3 0 ' + PNE_VIS_FX_COUNT + ' normal')
    n++
  }
  pneVisFxCursor = (pneVisFxCursor + i) % list.length
  return n
}

// After a (re)load VISUAL has no records, but grafts that rode their hosts through it are still in the
// world. One incremental pass over a snapshot of the loaded entities (KubeJS server.getEntities())
// rebuilds partial records, so yaw sync, the scan and the cap see them. PNE_CORE_COST.sweep per step, even ticks.
function pneVisRediscover(srv) {
  var st = pneVisRedisc
  var k
  var e
  var v
  var vu
  var du
  var dv
  var rec
  if (!st) {
    st = { list: null, i: 0, n: 0 }
    try { st.list = srv.getEntities() } catch (e0) { st.list = null }
    if (!st.list) {
      pneVisRediscPending = false
      return
    }
    try { st.n = Number(st.list.size()) } catch (e1) { st.n = 0 }
    pneVisRedisc = st
  }
  if (!pneCoreTake(PNE_CORE_COST.sweep)) return
  for (k = 0; k < PNE_VIS_REDISC_STEP && st.i < st.n; k++) {
    e = null
    try { e = st.list.get(st.i) } catch (e2) { e = null }
    st.i++
    if (!e || pneCoreTypeId(e) !== PNE_VIS_DISPLAY || !pneCoreHasTag(e, PNE_VIS_TAG) || pneVisGone(e)) continue
    v = null
    try { v = e.getVehicle() } catch (e3) { v = null }
    if (!v || pneVisGone(v)) continue
    vu = pneCoreUuid(v)
    du = pneCoreUuid(e)
    if (!vu || !du || pneVisHosts.hasOwnProperty(vu)) continue
    rec = pneVisRecord(vu, v)
    rec.partial = true
    dv = pneVisDispVariant(e)
    rec.variant = dv > 0 ? dv : 1
    rec.gvar = rec.variant
    rec.engT = pneCoreTick   // a linger's grace until the scan sees whether it is engaged
    pneVisSetDisp(rec, du)
  }
  if (st.i >= st.n) {
    pneVisRedisc = null
    pneVisRediscPending = false
  }
}

function pneVisDrainApplies() {
  var u
  var p
  while (pneVisApplyOrder.length) {
    if (!pneCoreTake(PNE_CORE_COST.visApply)) return
    u = pneVisApplyOrder.shift()
    p = pneVisApplyPending[u]
    delete pneVisApplyPending[u]
    if (!p || pneVisGone(p.mob)) continue
    pneVisApplyNow(p.mob, u, pneVisWant(p.mob, p.info))
  }
}

function pneVisDrainRemoves(srv) {
  var u
  var p
  while (pneVisRemoveOrder.length) {
    if (!pneCoreTake(PNE_CORE_COST.visApply)) return
    u = pneVisRemoveOrder.shift()
    p = pneVisRemovePending[u]
    delete pneVisRemovePending[u]
    if (p) pneVisRemoveNow(srv, u, p.level, p.disp)
  }
}

// ---------------------------------------------------------------------------------------------
// Handlers, commands, status

function pneVisOnTick(event) {
  var srv
  var t = pneCoreTick
  if (PNE_VIS_B_TICK.off) return
  try {
    srv = event.server
    // Team setup (collisionRule always keeps vanilla pushing between team members, players and every other mob, see
    // the header): on the first tick after the start, which also repairs teams an older version made with another rule
    // and the friendly-fire options Recruits resets at every start; after a failed check, on the backoff. A refused
    // take retries on the next tick. It runs before the drains, so the first applies find the teams.
    if (!pneVisTeamsReady && pneVisStarted() && pneCoreTick >= pneVisTeamsRetryAt && pneCoreTake(PNE_CORE_COST.sweep)) pneVisEnsureTeams(srv)
    if (pneVisRemoveOrder.length) pneVisDrainRemoves(srv)
    if (pneCoreOn('visual')) {
      if (pneVisRediscPending && t % 2 === 0) pneVisRediscover(srv)
      if (pneVisApplyOrder.length) pneVisDrainApplies()
      pneVisScanStep(srv, PNE_VIS_SCAN_STEP)
      if (t % PNE_VIS_SYNC_EVERY === 0) pneVisSyncYaw(srv)
      if (t % PNE_VIS_FX_EVERY === PNE_VIS_FX_AT) pneVisFx(srv)
    }
    // Fixed-schedule job (contract 7.2): starts at t % 200 === 106 and runs one phase per even tick (106, 108, 110),
    // so it never shares a tick with a breed (t % 4 === 3) or a dream slice (t % 4 === 1). Each phase is charged
    // PNE_CORE_COST.sweep; a refused take retries on the next even tick.
    if (t % PNE_VIS_SWEEP_EVERY === PNE_VIS_SWEEP_AT && pneVisSweepPhase === 0) pneVisSweepPhase = 1
    if (pneVisSweepPhase > 0 && t % 2 === 0 && pneCoreTake(PNE_CORE_COST.sweep)) pneVisSweepPhaseStep(srv)
    pneCoreOk(PNE_VIS_B_TICK)
  } catch (err) {
    pneCoreFail(PNE_VIS_B_TICK, err)
  }
}

function pneVisOnToggle(on, server) {
  if (on) {
    pneVisOffClean = false
    pneVisTeamsReady = false
    pneVisTeamsRetryAt = 0
    pneVisTeamsFails = 0
    pneVisRediscPending = true
  } else {
    pneVisSweepPhase = 1
  }
}

// "teams N/8": the clade teams whose options read back as wanted right now ('?' when the scoreboard cannot be read).
// Every reply goes out as a tellraw command, and Recruits takes over any console command whose text holds "team" and
// also "add", "remove", "join" or "leave" anywhere (plain substrings, the target UUID included). So no text VISUAL
// sends contains "team" next to one of those words: the status line keeps the word "teams" (contract 1.5, spec E) and
// avoids the other four; the help and sweep texts say "clade" instead.
function pneVisStatusLine(player) {
  var e = pneVisTeamEntries(pneCoreServer)
  var t = pneVisTeamsCount(pneCoreServer)
  return 'teams ' + (t < 0 ? '?' : t) + '/' + (2 * PNE_VIS_CLADES) + (pneVisTeamsReady ? '' : ' (setting up)') + ', ' +
    (e === null ? '?' : e.length) + ' entries, grafts ' + pneVisGraftN + '/' + pneVisGraftCap() +
    ' on ' + pneVisEngN + ' engaged of ' + pneVisHostN + ' hosts, queued ' + pneVisApplyOrder.length + '+' +
    pneVisRemoveOrder.length + ', swept ' + pneVisSwept + (pneVisGraftsOn() ? '' : ' (grafts off: vis_grafts 0)') +
    (pneCoreOn('visual') ? '' : ' (pillar off)')
}

function pneVisCmdStatus(ctx) {
  if (ctx.args.length !== 1 || String(ctx.args[0]).toLowerCase() !== 'status') return false
  ctx.reply('visual: ' + pneVisStatusLine(ctx.player), 'gold')
  return true
}

function pneVisCmdSweep(ctx) {
  var n
  if (ctx.args.length !== 1 || String(ctx.args[0]).toLowerCase() !== 'sweep') return false
  n = pneVisSweep(ctx.server)
  ctx.reply('visual sweep cleared ' + n + ' orphan grafts or stale clade entries', 'gold')
  return true
}

if (!pneVisReady) console.error('[pne_visual] pne_00_core.js did not load; this module stays off')
if (pneVisReady) {
  ServerEvents.tick(pneVisOnTick)
  pneCoreOnToggle('visual', pneVisOnToggle)
  pneCoreCommand('visual', { run: pneVisCmdStatus, help: 'visual status: clade setup, clade entries and grafts' })
  pneCoreCommand('visual', { run: pneVisCmdSweep, help: 'visual sweep: clear orphan grafts and stale clade entries now', admin: true })
  pneCoreStatus('visual', pneVisStatusLine)
}
