// Maximum-size hive state for tools/genome/test/NbtSizeTest.java (suite hive-nbt-size). ES5, evaluated in the instance's
// Rhino jar with the SRG Minecraft jar on the classpath and the game's remapper installed, after tools/tests/kjs_mocks.js,
// tools/hive/hive_prelude.js, pne_00_core.js, pne_hive_core.js and pne_hive.js.
//
// pneNbtBuild() drives PNE_HIVE_GA and the hive's runtime tables to their limits and saves them with the real
// pneHiveSave into a REAL net.minecraft.nbt.CompoundTag (the server's persistentData), which it returns:
//   pool 48 entries with 40-character ids; queue 16 entries whose parents are two 40-character ids; 400 samples;
//   512 context baselines with 64-character keys and 10-digit EMAs; the 45,000-character log tail; a pending dawn
//   dream in its children phase (dpop and dnext); 64 players seen; a 400-entry outcome species ring of long ids; and a
//   kept unreadable earlier state of the same size (pne_hive.prev, a copy of the first save).
// pneNbtReload(tag) loads that tag back through pneHiveEnsureLoaded (after the server's first tick: the hive loads only once
// the server started, contract 1.5); pneNbtHashAll() / pneNbtSaved() report the state.
// pneNbtIncBegin / pneNbtIncStep / pneNbtIncChurn / pneNbtIncCheck: the incremental save at the maximum state against the
// one-call save, in real CompoundTags (NbtSizeTest compares them).

var pneNbtSrv = null
var pneNbtHash0 = ''

function pneNbtId(prefix, i) {
  var s = prefix + i + '_'
  while (s.length < 40) s += 'x'
  return s.substring(0, 40)
}

function pneNbtCtx(i) {
  var s = 'spore:a_very_long_species_identifier_' + i + '/1/3/surface/'
  while (s.length < 64) s += 'y'
  return s.substring(0, 64)
}

function pneNbtBuild() {
  var GA = PNE_HIVE_GA
  var CT = Java.loadClass('net.minecraft.nbt.CompoundTag')
  var st
  var i
  var k
  var ch
  var mk = GA.mask('spore:knight')
  var e
  var guard = 0
  pneNbtSrv = __pneMock.server({ tickCount: 100, gameTime: 5000000 })
  pneNbtSrv.persistentData = new CT()
  pneNbtSrv.getPersistentData = function () { return pneNbtSrv.persistentData }
  __pneMock.fire('ServerEvents.loaded', { server: pneNbtSrv })
  // the server's first tick: the core marks the start and the hive loads there (contract 1.5), so pneNbtReload below can load
  __pneMock.tick(pneNbtSrv, 1)
  st = GA.newState(2890182371)
  // 700 outcomes with 40-character ids and 64-character contexts: pool 48, samples 400, 512 baselines (LRU),
  // log tail full; maximal telemetry so every EMA has ten digits
  for (i = 0; i < 700; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    e = GA.express(ch.g, mk, 6.5)
    GA.outcome(st, {
      id: pneNbtId('outcome_', i), g: ch.g, parents: [pneNbtId('parent_a', i), pneNbtId('parent_b', i)], ctx: pneNbtCtx(i), e: e,
      tel: { dmg: 999.999999, engagedSec: 1999.999999, located: 1, killShare: 0.999999, teamPressure: 999.999999, fastKill: false, cheese: false }
    })
  }
  // full queue: 16 bred children whose parents are the 40-character pool ids
  for (i = 0; i < 20; i++) GA.breed(st)
  // a pending dream stopped in its children phase (dnext partly filled)
  GA.dawn(st, { deaths3d: 99, target: 1, tDay: [0.2, 0.2, 0.2, 0.2, 0.2], stage: 10 })
  while (st.dream && (st.dream.ph !== 0 || st.dream.gen < 4 || st.dream.next.length < 40) && guard++ < 2000) GA.dreamSlice(st, mk, 6.5)
  pneHiveSt = st
  pneHiveLoadTried = true
  pneHiveDay = 123456
  pneHiveTDay = [9999.5, 9999.5, 9999.5, 9999.5, 9999.5]
  pneHivePids = {}
  for (i = 0; i < 64; i++) {
    k = ('00000000' + (i * 2654435761 >>> 0).toString(16)).slice(-8)
    pneHivePids[k + k + k + k] = 5000000 - i
  }
  pneHiveSpRing = []
  pneHiveSpHead = 0
  for (i = 0; i < 400; i++) pneHiveSpRing.push('spore:a_very_long_species_identifier_number_' + (i % 60))
  pneHiveWid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  if (!pneHiveSave(pneNbtSrv)) throw new Error('pneHiveSave returned false')
  // worst case for the file: an unreadable earlier state of the same maximum size kept as pne_hive.prev
  pneHivePrev = pneNbtSrv.persistentData.getCompound('pne_hive').copy()
  if (!pneHiveSave(pneNbtSrv)) throw new Error('pneHiveSave returned false (with prev)')
  pneNbtHash0 = GA.hashAll(st)
  return pneNbtSrv.persistentData
}

function pneNbtDesc() {
  var st = pneHiveSt
  return 'pool=' + PNE_HIVE_GA.poolSize(st) + ' queue=' + PNE_HIVE_GA.queueSize(st) + ' samples=' + st.se.length + ' contexts=' + st.baseN +
    ' logChars=' + st.evc + ' dream=' + (st.dream ? 'pending(next ' + st.dream.next.length + ')' : 'none')
}

// Loads the read-back tag the way a server start does and checks that it reproduces the saved state exactly.
function pneNbtReload(tag) {
  var saved = PNE_HIVE_GA.save(pneHiveSt)
  var again
  pneNbtSrv.persistentData = tag
  pneHiveClearRuntime()
  pneHiveSt = null
  pneHiveLoadTried = false
  pneHiveWid = ''
  pneHiveSpRing = []
  pneHivePids = {}
  pneHiveDay = -1
  pneHivePrev = null
  pneHiveEnsureLoaded(pneNbtSrv)
  if (!pneHiveSt) return 'FAIL nothing loaded'
  again = PNE_HIVE_GA.save(pneHiveSt)
  if (PNE_HIVE_GA.hashAll(pneHiveSt) !== pneNbtHash0) return 'FAIL hashAll differs after the NbtIo round trip'
  if (again.pool !== saved.pool || again.queue !== saved.queue || again.state !== saved.state || again.log !== saved.log ||
    again.samples.join('/') !== saved.samples.join('/')) return 'FAIL save strings differ after the NbtIo round trip'
  if (pneHiveWid !== 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' || pneHiveDay !== 123456 || pneHiveSpRing.length !== 400) return 'FAIL runtime string (wid, day, species ring) not restored'
  if (!pneHivePrev || String(pneHivePrev.getString('log')) !== saved.log) return 'FAIL the kept pne_hive.prev was not carried through the load'
  return 'OK hashAll=' + pneNbtHash0 + ', prev kept'
}

// The incremental save against the one-call save in real CompoundTags, at the maximum state (after pneNbtReload): the
// one-call save stores the reference (pneNbtIncRef, the very tag object, so no copy changes its layout); then an
// incremental save of the same state runs one step at a time (NbtSizeTest times each), the GA state and the runtime
// evidence changing between every two GA pieces (pneNbtIncChurn). NbtSizeTest compares the stored compound with the
// reference (CompoundTag.equals and the NbtIo bytes).
var pneNbtIncRef = null

function pneNbtIncBegin() {
  var spd = pneNbtSrv.persistentData
  if (!pneHiveSave(pneNbtSrv)) return 'FAIL the one-call save returned false'
  pneNbtIncRef = spd.getCompound('pne_hive')
  spd.remove('pne_hive')
  pneHiveStats.saveParts = 0
  pneHiveStats.saveRestarts = 0
  pneHiveSaving = null
  pneHiveSaveDue = true
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  pneHiveSaveGaJob(pneNbtSrv, 2, 2)
  return (pneHiveSaving && pneHiveSaving.ph === 'ga') ? 'ga' : 'FAIL the incremental save did not begin'
}

// One step, exactly as the hive runs it: a GA piece (charged gaSavePart) while in the GA phase, else a write step. Returns
// the phase after the step, or 'done'.
function pneNbtIncStep() {
  pneCoreLeftMs = PNE_CORE_BUDGET_MS
  if (pneHiveSaving && pneHiveSaving.ph === 'ga') pneHiveSaveGaJob(pneNbtSrv, 2, 2)
  else if (pneHiveSaving) pneHiveSaveJob(pneNbtSrv)
  return pneHiveSaving ? String(pneHiveSaving.ph) : 'done'
}

// Untimed, between two GA pieces: outcomes on listed baselines (copy on write) and on new contexts (evictions past 512),
// a join, breeds, a dream slice, today's evidence.
function pneNbtIncChurn(k) {
  var GA = PNE_HIVE_GA
  var st = pneHiveSt
  var mk = GA.mask('spore:knight')
  var ch = GA.join(st, null)
  var tel = { dmg: 5, engagedSec: 30, located: 1, killShare: 0, teamPressure: 3, fastKill: false, cheese: false }
  GA.outcome(st, { id: pneNbtId('churn_', k), g: ch.g, parents: ch.parents, ctx: pneNbtCtx(200 + (k * 37) % 500), e: GA.express(ch.g, mk, 6.5), tel: tel })
  GA.outcome(st, { id: pneNbtId('churnnew_', k), g: ch.g, parents: ch.parents, ctx: pneNbtCtx(5000 + k), e: GA.express(ch.g, mk, 6.5), tel: tel })
  GA.breed(st)
  GA.dreamSlice(st, mk, 6.5)
  pneHiveTDay[k % 5] += 1
  return 'ok'
}

function pneNbtIncCheck() {
  var got = pneNbtSrv.persistentData.getCompound('pne_hive')
  if (pneHiveSaving !== null) return 'FAIL the incremental save did not finish'
  if (pneHiveStats.saveRestarts !== 0) return 'FAIL the incremental save restarted ' + pneHiveStats.saveRestarts + ' time(s)'
  if (String(got.getString('state')) === PNE_HIVE_GA.save(pneHiveSt).state) return 'FAIL the state did not change between the pieces'
  if (String(got.getString('hv')) === pneHiveRuntimeStr()) return 'FAIL the runtime evidence did not change between the pieces'
  return 'OK ' + pneHiveStats.saveParts + ' GA pieces'
}
