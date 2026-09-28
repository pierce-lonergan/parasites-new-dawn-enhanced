// Java-typed inputs (IMPLEMENTATION.md F6): what HIVE really hands the GA core in game. Strings read back from NBT or
// from global are java.lang.String objects (typeof 'object'), numbers are boxed Doubles, NBT IntArrays are int[], and the
// startup queues are java.util.ArrayList. Every PNE_HIVE_GA entry point must treat them exactly like the JS values.
// Rhino only (it needs global and Java.loadClass): run by `python tools/genome/rhino/run.py replay` through
// tools/rhino/pne_rhino.py (the PneRhino harness: global HashMap, KubeJS class filter). Result in pneJvResult.
// ES5, every var at the top of its function.

var pneJvFails = []
var pneJvCount = 0
var pneJvAL = null
var pneJvIS = null

function pneJvT(cond, msg) {
  pneJvCount++
  if (!cond) pneJvFails.push(msg)
}

// java.lang.String / boxed Double / boxed Boolean, exactly as a value read back from global (F6).
function pneJvStr(s) {
  global.pne_jv_s = String(s)
  return global.pne_jv_s
}

function pneJvNum(x) {
  global.pne_jv_n = x
  return global.pne_jv_n
}

function pneJvBool(x) {
  global.pne_jv_b = x ? true : false
  return global.pne_jv_b
}

function pneJvList(a, conv) {
  var L = new pneJvAL()
  var i
  for (i = 0; i < a.length; i++) L.add(conv ? conv(a[i]) : a[i])
  return L
}

// An int[] like CompoundTag.getIntArray returns.
function pneJvInts(a) {
  var b = pneJvIS.builder()
  var i
  for (i = 0; i < a.length; i++) b.add(Math.floor(Number(a[i])))
  return b.build().toArray()
}

function pneJvSer(sv) {
  var parts = [String(sv.pool), String(sv.queue), String(sv.state), sv.samples.join('/'), String(sv.log)]
  var i
  for (i = 0; i < sv.base.length; i++) parts.push(sv.base[i].k + '=' + sv.base[i].v.join(','))
  return parts.join('#')
}

// The save as HIVE would pass it after reading its CompoundTag: every string a java.lang.String, samples a Java List,
// base a Java List of { k: java String, v: int[] } (or of Java Lists of boxed numbers).
function pneJvSave(sv, asList) {
  var base = new pneJvAL()
  var i
  for (i = 0; i < sv.base.length; i++) base.add({ k: pneJvStr(sv.base[i].k), v: asList ? pneJvList(sv.base[i].v, pneJvNum) : pneJvInts(sv.base[i].v) })
  return { pool: pneJvStr(sv.pool), queue: pneJvStr(sv.queue), state: pneJvStr(sv.state), samples: pneJvList(sv.samples, pneJvStr), base: base, log: pneJvStr(sv.log) }
}

function pneJvRec(GA, ch, i, mk) {
  return {
    id: ch.id, g: ch.g, parents: ch.parents, ctx: (i % 3 === 0 ? 'spore:mound' : 'epca:ripper') + '|' + (i % 2) + '|' + (i % 4) + '|cave',
    e: GA.express(ch.g, mk, 4.05),
    tel: { dmg: (i * 7) % 13, engagedSec: 5 + (i * 11) % 30, located: i % 4 !== 0, killShare: i % 9 === 0 ? 0.5 : 0, teamPressure: (i % 5) / 2, fastKill: i % 23 === 0, cheese: i % 37 === 0 }
  }
}

function pneJvLast(GA, st) {
  var ev = GA.events(st, GA.seq(st) - 1)
  return ev.length ? ev[0] : ''
}

function pneJvRun() {
  var GA = PNE_HIVE_GA
  var seed = 4040
  var mk = GA.mask('epca:ripper')
  var st
  var sv0
  var sv1
  var seq0
  var jsv
  var A
  var B
  var r
  var i
  var ch
  var a
  var b
  var ra
  var rb
  var ea
  var eb
  var same
  var rec
  var jrec
  var lines
  var svE
  var seqE
  var pa
  var pb
  pneJvAL = Java.loadClass('java.util.ArrayList')
  pneJvIS = Java.loadClass('java.util.stream.IntStream')
  st = GA.newState(seed)
  for (i = 0; i < 700; i++) {
    GA.breed(st)
    ch = GA.join(st, null)
    if (i % 5 !== 1) GA.outcome(st, pneJvRec(GA, ch, i, mk))
    if (i % 60 === 59) GA.dawn(st, { deaths3d: i % 3, target: 1.5, tDay: [0.1, 0.3, 0.2, 0.3, 0.1], stage: 3 })
    if (GA.dreamPending(st) && i % 2 === 0) GA.dreamSlice(st, mk, 4.05)
    if (i === 671) {
      sv0 = GA.save(st)
      seq0 = GA.seq(st)
    }
  }
  sv1 = GA.save(st)
  pneJvT(Number(String(sv1.log).split('\n')[0].split('|')[1]) <= seq0 + 1, 'test setup: the saved tail must reach back to the snapshot')

  // load: java.lang.String fields, a Java List of chunks, base values as int[] and as Java Lists of boxed numbers
  jsv = pneJvSave(sv0, false)
  pneJvT(typeof jsv.state === 'object', 'test setup: a value read from global is a wrapped java.lang.String')
  a = GA.load(jsv, seed)
  pneJvT(a !== null && pneJvSer(GA.save(a)) === pneJvSer(sv0), 'load() of Java-typed strings, Lists and int[] reproduces the save')
  b = GA.load(pneJvSave(sv0, true), pneJvNum(seed))
  pneJvT(b !== null && pneJvSer(GA.save(b)) === pneJvSer(sv0), 'load() with base values as Java Lists of boxed numbers and a boxed seed')
  if (sv0.samples.length === 1) {
    b = GA.load({ pool: jsv.pool, queue: jsv.queue, state: jsv.state, samples: pneJvStr(sv0.samples[0]), base: jsv.base, log: jsv.log }, seed)
    pneJvT(b !== null && pneJvSer(GA.save(b)) === pneJvSer(sv0), 'load() with samples as one java.lang.String chunk')
  }

  // replay: the log as a java.lang.String (what getString returns), and as a Java List of event strings
  r = GA.replay(seed, jsv, pneJvStr(sv1.log))
  pneJvT(r !== null && r.rbad === 0 && r.rn > 0 && GA.hashAll(r) === GA.hashAll(st), 'replay(save, java String log) replays the tail: rbad ' +
    (r ? r.rbad + ' rn ' + r.rn + ' ' + r.rmsg : 'null'))
  r = GA.replay(seed, sv0, pneJvList(GA.events(st, seq0), pneJvStr))
  pneJvT(r !== null && r.rbad === 0 && r.rn > 0 && GA.hashAll(r) === GA.hashAll(st), 'replay(save, Java List of java Strings)')
  // tamper with the first B event after the snapshot (events up to the snapshot are skipped by design)
  lines = String(sv1.log).split('\n')
  for (i = 0; i < lines.length; i++) {
    if (lines[i].charAt(0) === 'B' && Number(lines[i].split('|')[1]) > seq0 + 1) {
      lines[i] = 'B|' + lines[i].split('|')[1] + '|999999'
      break
    }
  }
  r = GA.replay(seed, jsv, pneJvStr(lines.join('\n')))
  pneJvT(i < lines.length && r !== null && r.rbad > 0, 'a tampered java String log is detected (rbad ' + (r ? r.rbad : 'null') + ')')
  r = GA.replay(seed, jsv, pneJvStr('not a log'))
  pneJvT(r !== null && r.rbad > 0, 'a java String that is not a log is reported, not silently replayed as nothing')
  r = GA.replay(seed, jsv, pneJvNum(5))
  pneJvT(r !== null && r.rbad > 0, 'a boxed number as the log is reported')

  // Runtime calls: the same call with JS values and with Java values on two identical clones gives the same result
  // and logs the same event.
  A = GA.load(sv1, seed)
  B = GA.replay(seed, jsv, pneJvStr(sv1.log))
  ch = GA.join(A, { id: 'carrier1', g: st.pool[3].h })
  b = GA.join(B, { id: pneJvStr('carrier1'), g: pneJvStr(st.pool[3].h) })
  pneJvT(ch.hex === b.hex && ch.parents === b.parents && pneJvLast(GA, A) === pneJvLast(GA, B), 'join() with a java String link id and genome')
  ch = GA.join(A, { id: 'carrier2', g: st.pool[4].g })
  b = GA.join(B, { id: pneJvStr('carrier2'), g: pneJvInts(st.pool[4].g) })
  pneJvT(ch.hex === b.hex && pneJvLast(GA, A) === pneJvLast(GA, B), 'join() with an int[] genome')
  ch = GA.join(A, { id: 'carrier3', g: st.pool[5].g })
  b = GA.join(B, { id: pneJvStr('carrier3'), g: pneJvList(st.pool[5].g, pneJvNum) })
  pneJvT(ch.hex === b.hex && pneJvLast(GA, A) === pneJvLast(GA, B), 'join() with a Java List genome')
  rec = pneJvRec(GA, ch, 9, mk)
  rec.parents = 'carrier3,p9'
  jrec = {
    id: pneJvStr(rec.id), g: pneJvStr(GA.hex(rec.g)), parents: pneJvStr(rec.parents), ctx: pneJvStr(rec.ctx), e: pneJvList(rec.e, pneJvNum),
    tel: { dmg: pneJvNum(rec.tel.dmg), engagedSec: pneJvNum(rec.tel.engagedSec), located: pneJvBool(rec.tel.located), killShare: pneJvNum(rec.tel.killShare),
      teamPressure: pneJvNum(rec.tel.teamPressure), fastKill: pneJvBool(rec.tel.fastKill), cheese: pneJvBool(rec.tel.cheese) }
  }
  ra = GA.outcome(A, rec)
  rb = GA.outcome(B, jrec)
  pneJvT(ra === rb && ra > 0 && pneJvLast(GA, A) === pneJvLast(GA, B), 'outcome() with java Strings, a Java List e and boxed telemetry (' + ra + ' vs ' + rb + ')')
  jrec.parents = pneJvList(['carrier3', 'p9'], pneJvStr)
  jrec.id = pneJvStr('again')
  rec.id = 'again'
  ra = GA.outcome(A, rec)
  rb = GA.outcome(B, jrec)
  pneJvT(ra === rb && pneJvLast(GA, A) === pneJvLast(GA, B), 'outcome() with parents as a Java List of java Strings')
  jrec.tel.dmg = pneJvNum(500)
  rec.tel.dmg = 12
  jrec.id = pneJvStr('cap')
  rec.id = 'cap'
  ra = GA.outcome(A, rec)
  rb = GA.outcome(B, jrec)
  pneJvT(ra === rb && pneJvLast(GA, A).split('|')[8].split(',')[0] === '12000000' && pneJvLast(GA, A) === pneJvLast(GA, B),
    'boxed dmg 500 is capped at 12 HP like a JS 12')
  GA.dawn(A, { deaths3d: 2, target: 1.5, tDay: [0.2, 0.1, 0.3, 0.2, 0.2], stage: 4 })
  GA.dawn(B, { deaths3d: pneJvNum(2), target: pneJvNum(1.5), tDay: pneJvList([0.2, 0.1, 0.3, 0.2, 0.2], pneJvNum), stage: pneJvNum(4) })
  pneJvT(pneJvLast(GA, A) === pneJvLast(GA, B) && GA.gov(A) === GA.gov(B), 'dawn() with boxed numbers and a Java List tDay')
  pneJvT(GA.dreamPending(A) && GA.dreamPending(B), 'test setup: the dawn scheduled a dream')
  same = true
  for (i = 0; i < 30 && GA.dreamPending(A); i++) {
    GA.dreamSlice(A, GA.mask('spore:mound'), 4.4)
    GA.dreamSlice(B, pneJvInts(GA.mask(pneJvStr('spore:mound'))), pneJvNum(4.4))
    if (pneJvLast(GA, A) !== pneJvLast(GA, B)) same = false
  }
  pneJvT(same, 'dreamSlice() with an int[] mask and a boxed B')
  // epoch(): HIVE's load counter may come back from NBT boxed; the E event replays from a java.lang.String log
  svE = GA.save(A)
  seqE = GA.seq(A)
  ra = GA.epoch(A, 7)
  rb = GA.epoch(B, pneJvNum(7))
  pneJvT(ra === 7 && rb === 7 && pneJvLast(GA, A) === pneJvLast(GA, B), 'epoch() with a boxed number')
  GA.breed(A)
  GA.breed(B)
  ch = GA.join(A, { id: 'carrier4', g: st.pool[6].g })
  b = GA.join(B, { id: pneJvStr('carrier4'), g: pneJvStr(st.pool[6].h) })
  pneJvT(ch.id === b.id && /\.7$/.test(ch.id) && pneJvLast(GA, A) === pneJvLast(GA, B), 'ids carry the epoch after a boxed epoch() (' + ch.id + ')')
  r = GA.replay(seed, pneJvSave(svE, false), pneJvStr(GA.events(A, seqE).join('\n')))
  pneJvT(r !== null && r.rbad === 0 && GA.hashAll(r) === GA.hashAll(A), 'replay of a java String log with an E event' + (r ? ' ' + r.rmsg : ''))
  // the incremental save of the replayed clone equals save() of the live one
  pa = GA.saveBegin(B)
  while (!GA.saveDone(pa)) GA.savePart(pa)
  pb = GA.saveEnd(pa)
  pneJvT(pb !== null && pneJvSer(pb) === pneJvSer(GA.save(A)), 'saveBegin/savePart/saveEnd of the Java-fed clone equals save() of the JS-fed one')
  pneJvT(GA.govStep(A) === GA.govStep(B) && pneJvSer(GA.save(A)) === pneJvSer(GA.save(B)), 'the two clones end in the same state')

  // Pure helpers
  pneJvT(GA.budget(pneJvNum(4), pneJvNum(0.9), pneJvBool(true)) === GA.budget(4, 0.9, true), 'budget() with boxed values')
  pneJvT(GA.budget(pneJvNum(4), pneJvNum(0.9), pneJvBool(false)) === GA.budget(4, 0.9, false), 'budget() with a boxed false')
  ea = GA.express(st.pool[7].h, GA.mask('epca:curbug'), 5.2)
  eb = GA.express(pneJvStr(st.pool[7].h), pneJvInts(GA.mask('epca:curbug')), pneJvNum(5.2))
  pneJvT(ea.join(',') === eb.join(','), 'express() with a java String genome, an int[] mask and a boxed B')
  pneJvT(GA.mask(pneJvStr('epca:curbug')).join('') === GA.mask('epca:curbug').join(''), 'mask() with a java String id')
  pneJvT(GA.clade(pneJvStr(st.pool[2].h)) === GA.clade(st.pool[2].g) && GA.unhex(pneJvStr(st.pool[2].h)).join(',') === st.pool[2].g.join(','),
    'clade() and unhex() with a java String')
  pneJvT(GA.events(st, pneJvNum(GA.seq(st) - 2)).length === 2, 'events() with a boxed seq')
  return pneJvFails.length ? 'FAIL ' + pneJvFails.length + '/' + pneJvCount + ': ' + pneJvFails.join(' | ') : 'PASS ' + pneJvCount + ' Java-typed checks'
}

var pneJvResult
try {
  pneJvResult = pneJvRun()
} catch (err) {
  pneJvResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
