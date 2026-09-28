// Suite hive-conversion-replay: conversions through the real startup leave listener and the hive runtime, then a replay
// of the GA log. Runs in Node and in the instance's Rhino jar (tools/hive/run_hive.py conv). Files, in order:
// tools/tests/kjs_mocks.js, tools/hive/hive_prelude.js, pne_00_core.js, pne_hive_core.js, pne_hive.js,
// startup_scripts/pne_hive_events.js, this file. Result: pneConvResult ('PASS n digest=<hash>' or 'FAIL ...'). ES5.
//
// Vanilla Mob.convertTo adds the new mob (EntityJoinLevelEvent) BEFORE it discards the old one (EntityLeaveLevelEvent),
// both inside one tick. The hive drains newborns only when they joined in an earlier tick and drains leave records
// first, so the carrier's removal is buffered when its newborn is linked (TDD 3.3.1). Scenarios:
//   A join-before-leave in one tick          -> linked (J src L, carrier id and genome), carrier scored (I), pne_gp
//   B leave-before-join in one tick          -> linked
//   C join one tick after the leave          -> linked (within 2 ticks)
//   D join three ticks after the leave       -> not linked
//   E join 3 blocks away                     -> not linked
//   F join in another dimension              -> not linked
//   G carrier despawned naturally            -> not buffered, not scored, not linked
//   H carrier removed by the pacing backstop -> ignored
//   I a carrier links at most one newborn
//   J, K a conversion behind a leave backlog of 100 / 300 records links (the newborn waits for the backlog)
// Then PNE_HIVE_GA.replay(seed, snapshot, events since the snapshot) and replay(seed, null, whole log) reproduce the
// live state bit for bit (hash and hashAll), with rbad 0. The mock levels answer only to getTime() (contract F37: KubeJS
// hides getGameTime()), so a leave listener calling the hidden name would link nothing here, as in game.

var pneCv = { n: 0, fails: [] }

// The load epoch's salt is random in game (pneHiveEpochSalt, from java.util.UUID, the real class in Rhino); a fixed
// non-zero salt keeps the Node and Rhino digests identical and still replays a salted, non-consecutive epoch.
pneHiveEpochSalt = function () { return 7 }

function pneCvOk(cond, msg) {
  pneCv.n++
  if (!cond) pneCv.fails.push(msg)
}

function pneCvLastJ(since) {
  var ev = PNE_HIVE_GA.events(pneHiveSt, since)
  var i
  var j = null
  for (i = 0; i < ev.length; i++) {
    if (ev[i].split('|')[0] === 'J') j = ev[i].split('|')
  }
  return j
}

function pneCvCount(code, since) {
  var ev = PNE_HIVE_GA.events(pneHiveSt, since)
  var i
  var n = 0
  for (i = 0; i < ev.length; i++) {
    if (ev[i].split('|')[0] === code) n++
  }
  return n
}

// An engaged genome carrier near the player (it will have evidence for an outcome).
function pneCvCarrier(srv, p, type, x, z) {
  var c = __pneHiveSaved(srv, type, { SPD: 30000, ACU: 20000, MOR: 12345 }, { x: x, z: z || 0 })
  __pneMock.tick(srv, 1)
  c.target = p
  __pneMock.tick(srv, 22)
  return c
}

// A carrier converts while n unrelated genome removals (far away, natural despawns) wait in the startup leave queue.
function pneCvBacklog(srv, p, n, x, name) {
  var c = pneCvCarrier(srv, p, 'epca:infested_villager', x)
  var gi = String(c.persistentData.getString('pne_gi'))
  var seqA = PNE_HIVE_GA.seq(pneHiveSt)
  var q = pneHiveQLeave()
  var child
  var j
  var i
  var g = String(c.persistentData.getString('pne_g'))
  for (i = 0; i < n; i++) {
    q.add('l|00000000-0000-4000-9000-' + ('000000000000' + i).slice(-12) + '|DISCARDED|' + g + '|z' + i + '|' + (900 + i) + '.00|64.00|900.00|minecraft:overworld|' +
      srv.gameTime + '|0|epca:ripper')
  }
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: x + 0.5 })
  c.discard()
  __pneMock.tick(srv, 6)
  j = pneCvLastJ(seqA)
  pneCvOk(!child.removed && j && j[3] === 'L' && j[4] === gi && String(child.persistentData.getString('pne_gp')) === gi && pneHiveQueueSize(q) === 0,
    name + ': a conversion behind a leave backlog of ' + n + ' links and is not discarded next to a player in mercy')
}

function pneCvRun() {
  var srv = __pneMock.server({ tickCount: 5000, gameTime: 200000 })
  var p
  var saved0
  var seq0
  var seqA
  var c
  var child
  var j
  var gi
  var rst
  var rst2
  var nether
  var h
  var i

  __pneMock.fire('ServerEvents.loaded', { server: srv })
  p = __pneMock.player(srv, 'A', 'aaaa0000-0000-4000-8000-000000000001', { x: 0 })
  // the startup leave listener must read the game time the way scripts can in game (getTime; getGameTime is hidden, F37)
  pneCvOk(typeof srv.level.getGameTime === 'undefined' && typeof srv.level.getTime === 'function', 'mock level: getTime only, as in game')
  // some history first, so the replay starts from a non-trivial snapshot
  for (i = 0; i < 12; i++) {
    child = __pneHiveSpawn(srv, i % 2 ? 'epca:ripper' : 'spore:knight', { x: 4 + i, z: 3 })
    __pneMock.tick(srv, 3)
    child.target = p
    __pneMock.tick(srv, 22)
    __pneHiveRemove(srv, child, 'KILLED')
    __pneMock.tick(srv, 6)
  }
  __pneMock.tick(srv, 30)
  saved0 = PNE_HIVE_GA.save(pneHiveSt)
  seq0 = PNE_HIVE_GA.seq(pneHiveSt)

  // A: join, then discard, in one tick
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 10)
  gi = String(c.persistentData.getString('pne_gi'))
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 10.4 })
  c.discard()
  __pneMock.tick(srv, 1)
  pneCvOk(String(child.persistentData.getString('pne_g')) === '' && pneHiveConv.length === 1, 'A: carrier buffered first, newborn still waiting')
  __pneMock.tick(srv, 1)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] === 'L' && j[4] === gi && j[5] === String(c.persistentData.getString('pne_g')), 'A: J event with the carrier link (id and genome)')
  pneCvOk(j && /\.[0-9]+$/.test(j[6]) && j[6].substring(j[6].lastIndexOf('.') + 1) === String(pneHiveEpoch) &&
    j[6] === String(child.persistentData.getString('pne_gi')) && String(child.persistentData.getString('pne_gp')) === gi,
    'A: pne_gp = carrier id; pne_gi = the GA id, which carries the load epoch itself (PNE_HIVE_GA.epoch)')
  __pneMock.tick(srv, 8)
  pneCvOk(pneCvCount('I', seqA) === 1 && PNE_HIVE_GA.events(pneHiveSt, seqA).join('\n').indexOf('I|') >= 0 &&
    PNE_HIVE_GA.events(pneHiveSt, seqA).join('\n').indexOf('|' + gi + '|') >= 0, 'A: the conversion discard is scored (I event for the carrier)')

  // B: discard, then join, in one tick
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 14)
  gi = String(c.persistentData.getString('pne_gi'))
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  c.discard()
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 14.3 })
  __pneMock.tick(srv, 2)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] === 'L' && j[4] === gi, 'B: leave-before-join also links')

  // C: join one tick after the leave
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 18)
  gi = String(c.persistentData.getString('pne_gi'))
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  c.discard()
  __pneMock.tick(srv, 1)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 18.2 })
  __pneMock.tick(srv, 2)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] === 'L' && j[4] === gi, 'C: a join one tick after the removal links')

  // D: join three ticks after the leave
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 22)
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  c.discard()
  __pneMock.tick(srv, 3)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 22.2 })
  __pneMock.tick(srv, 2)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] !== 'L', 'D: a join three ticks later does not link')

  // E: 3 blocks away
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 26)
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 29 })
  c.discard()
  __pneMock.tick(srv, 2)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] !== 'L', 'E: 3 blocks away does not link')

  // F: another dimension
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 30)
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  nether = { getTime: function () { return srv.gameTime }, getDimension: function () { return 'minecraft:the_nether' },
    players: function () { return __pneMock.list([]) }, getDayTime: function () { return srv.gameTime }, isClientSide: function () { return false },
    canSeeSky: function () { return false }, getBiome: function () { throw new Error('no biome') } }
  child = __pneMock.mob(srv, 'epca:ripper', { x: 30.2 })
  child.getLevel = function () { return nether }
  __pneHiveJoin(srv, child, false)
  c.discard()
  __pneMock.tick(srv, 2)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] !== 'L', 'F: another dimension does not link')

  // G: natural despawn (nobody within 32, idle for 600 ticks)
  c = __pneHiveSaved(srv, 'epca:infested_villager', { SPD: 30000 }, { x: 300 })
  __pneMock.tick(srv, 1)
  pneHiveMobs[c.uuid].tel.loc = true
  pneHiveMobs[c.uuid].lastEng = srv.gameTime - 1000
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  c.discard()
  __pneMock.tick(srv, 1)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 300.2 })
  __pneMock.tick(srv, 8)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] !== 'L' && pneCvCount('I', seqA) === 0, 'G: a natural despawn is neither buffered nor scored')

  // H: pacing backstop discard is ignored
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 34)
  c.persistentData.putByte('pne_pacing_discard', 1)
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 34.2 })
  c.discard()
  __pneMock.tick(srv, 8)
  j = pneCvLastJ(seqA)
  pneCvOk(j && j[3] !== 'L' && pneCvCount('I', seqA) === 0, 'H: a pacing discard is ignored (no link, no score)')

  // I: one carrier, two newborns: only one link
  c = pneCvCarrier(srv, p, 'epca:infested_villager', 38)
  seqA = PNE_HIVE_GA.seq(pneHiveSt)
  child = __pneHiveSpawn(srv, 'epca:ripper', { x: 38.2 })
  __pneHiveSpawn(srv, 'epca:ripper', { x: 38.4 })
  c.discard()
  __pneMock.tick(srv, 3)
  var ev = PNE_HIVE_GA.events(pneHiveSt, seqA)
  var links = 0
  for (i = 0; i < ev.length; i++) {
    if (ev[i].split('|')[0] === 'J' && ev[i].split('|')[3] === 'L') links++
  }
  pneCvOk(links === 1, 'I: a carrier links exactly one newborn')

  // J, K: a conversion while the leave queue holds a backlog of other genome removals (a horde-cull pass): the newborn
  // waits until no queued record can be its carrier's, the leave drain speeds up meanwhile, so the child is linked and
  // never discarded by the backstop next to a player in mercy (R-HIVE-R3). K's backlog is larger than one boosted drain.
  p.addTag('pne_mercy')
  pneCvBacklog(srv, p, 100, 42, 'J')
  pneCvBacklog(srv, p, 300, 46, 'K')
  p.removeTag('pne_mercy')

  __pneMock.tick(srv, 40)
  // replay from the snapshot with the events since, and from genesis with the whole log
  rst = PNE_HIVE_GA.replay(pneHiveSeed, saved0, PNE_HIVE_GA.events(pneHiveSt, seq0))
  pneCvOk(rst && rst.rbad === 0 && rst.rn > 0, 'replay(snapshot, events since) applies every event (rbad ' + (rst ? rst.rbad + ' ' + rst.rmsg : 'null') + ')')
  pneCvOk(rst && PNE_HIVE_GA.hash(rst) === PNE_HIVE_GA.hash(pneHiveSt) && PNE_HIVE_GA.hashAll(rst) === PNE_HIVE_GA.hashAll(pneHiveSt),
    'replay from the snapshot reproduces the live state bit for bit')
  rst2 = PNE_HIVE_GA.replay(pneHiveSeed, null, PNE_HIVE_GA.events(pneHiveSt, 0))
  pneCvOk(rst2 && rst2.rbad === 0 && PNE_HIVE_GA.hashAll(rst2) === PNE_HIVE_GA.hashAll(pneHiveSt), 'replay from genesis with the whole log reproduces it too (rbad ' +
    (rst2 ? rst2.rbad + ' ' + rst2.rmsg : 'null') + ')')
  h = PNE_HIVE_GA.hashAll(pneHiveSt)
  if (pneCv.fails.length) return 'FAIL ' + pneCv.fails.length + '/' + pneCv.n + ': ' + pneCv.fails.join(' | ')
  return 'PASS ' + pneCv.n + ' conversion and replay assertions (' + (__pneHiveIsRhino ? 'rhino' : 'node') + ') digest=' + h +
    ' links=' + pneHiveStats.links + ' events=' + PNE_HIVE_GA.seq(pneHiveSt)
}

var pneConvResult = (function () {
  try {
    return pneCvRun()
  } catch (e) {
    return 'FAIL threw: ' + e + (e && e.stack ? ' ' + String(e.stack).split('\n').slice(0, 4).join(' / ') : '')
  }
})()
