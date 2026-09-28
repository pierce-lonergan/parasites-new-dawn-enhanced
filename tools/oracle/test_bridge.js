// File-bridge tests for pne_oracle_bridge.js. ES5; runs in Node (kjs_node.js) and in real Rhino, where JsonIO.read
// returns java.util.LinkedHashMap / ArrayList with java.lang.Double / String values like KubeJS does.
// Files, in order: tools/tests/kjs_mocks.js, tools/oracle/ora_mocks.js, pne_00_core.js, pne_oracle_bridge.js, this file.
// Result: pneOraBridgeResult ("PASS n" or "FAIL ...").

var pneOraBFails = []
var pneOraBCount = 0
var PNE_ORA_B_TELP = 'local/pne_oracle/telemetry.json'
var PNE_ORA_B_VERP = 'local/pne_oracle/verdict.json'
var PNE_ORA_B_STAP = 'local/pne_oracle/status.json'

function pneOraB(cond, msg) {
  pneOraBCount++
  if (!cond) pneOraBFails.push(msg)
}

function pneOraBToSlot(srv, slot) {
  var k = 0
  __pneMock.tick(srv, 1)
  while (pneCoreSlot !== slot && k < 40) {
    __pneMock.tick(srv, 1)
    k++
  }
}

function pneOraBEntry(tel, pid) {
  var i
  for (i = 0; i < tel.players.length; i++) {
    if (tel.players[i].pid === pid) return tel.players[i]
  }
  return null
}

// verdict.json text as the sidecar would write it, with integers spelled 2.0 like Gson / Rhino
function pneOraBVerdictText(boot, seq, tick, backend, entries, purged) {
  var ps = []
  var i
  var e
  for (i = 0; i < entries.length; i++) {
    e = entries[i]
    ps.push('{"pid": "' + e.pid + '", "arousal": ' + JSON.stringify(e.a) + ', "style": ' + JSON.stringify(e.s) + ', "fe": ' +
      JSON.stringify(e.f) + ', "conf": 0.5, "window_fill": 16.0}')
  }
  return '{"v": 2.0, "boot_id": "' + boot + '", "seq": ' + seq + '.0, "tick": ' + tick + '.0, "ts_ms": 1759001234611.0, ' +
    (backend === null ? '' : '"backend": "' + backend + '", ') + '"model": "oracle-mlp-496-64-32-11@00000000", "infer_us": 21.0, ' +
    (purged ? '"purged": ' + JSON.stringify(purged) + ', ' : '') + '"players": [' + ps.join(', ') + ']}'
}

function pneOraBHasCmd(srv, frag, from) {
  var i
  for (i = from || 0; i < srv.cmds.length; i++) {
    if (srv.cmds[i].indexOf(frag) >= 0) return true
  }
  return false
}

// The logging confirmation code sent to `uuid` since command index `from` ('' if none).
function pneOraBCode(srv, uuid, from) {
  var i
  var m
  for (i = from || 0; i < srv.cmds.length; i++) {
    m = /log confirm ([0-9a-f]{12})/.exec(srv.cmds[i])
    if (m && srv.cmds[i].indexOf('tellraw ' + uuid + ' ') === 0) return m[1]
  }
  return ''
}

// Every command since `from` that mentions `frag` is a tellraw to `uuid` (and there is at least one).
function pneOraBOnlyTo(srv, frag, uuid, from) {
  var i
  var n = 0
  for (i = from || 0; i < srv.cmds.length; i++) {
    if (srv.cmds[i].indexOf(frag) < 0) continue
    if (srv.cmds[i].indexOf('tellraw ' + uuid + ' ') !== 0) return false
    n++
  }
  return n > 0
}

function pneOraBTimes(srv, frag, from) {
  var i
  var n = 0
  for (i = from || 0; i < srv.cmds.length; i++) {
    if (srv.cmds[i].indexOf(frag) >= 0) n++
  }
  return n
}

function pneOraBRun() {
  var srv = __pneMock.server({ tickCount: 5000 })
  var brig = __pneMock.brig()
  var A = __pneOraMock.equip(__pneMock.player(srv, 'Ann', '11111111-0000-4000-8000-00000000000a', { x: 0.5, y: 64, z: 0.5 }), {})
  var B = __pneOraMock.equip(__pneMock.player(srv, 'Bob', '22222222-0000-4000-8000-00000000000b', { x: 8.5, y: 64, z: 0.5 }), {})
  var tel
  var tel2
  var raw
  var ea
  var pidA
  var pidB
  var oldA
  var v
  var i
  var k
  var seq
  var writes
  var cmd0
  var r
  var boot
  var cost
  var goodA = { a: [0.1, 0.2, 0.3, 0.4], s: [0.6, 0.2, 0.1, 0.1], f: [0.7, 0.2, 0.1] }
  var pdS
  var code
  var code2
  var uA
  var uB
  var t0

  __pneOraMock.world(srv)
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  __pneMock.fire('ServerEvents.commandRegistry', brig.event())
  __pneMock.fire('PlayerEvents.loggedIn', { player: A })
  __pneMock.fire('PlayerEvents.loggedIn', { player: B })
  pidA = pneCorePid(A)
  pidB = pneCorePid(B)
  __pneMock.tick(srv, 45)

  // --- telemetry.json (TDD 4.4.2)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  raw = __pneOraMock.raw(PNE_ORA_B_TELP)
  pneOraB(tel !== null, 'telemetry.json written')
  pneOraB(tel.v === 2 && /^[0-9]+$/.test(tel.boot_id) && tel.seq >= 1 && Math.floor(tel.seq) === tel.seq, 'v 2, boot_id epoch string, integer seq')
  pneOraB(tel.tick % 20 === 0 && typeof tel.ts_ms === 'number' && tel.ts_ms > 1.6e12 && tel.want_oracle === true, 'written at slot 0 with ts_ms and want_oracle')
  pneOraB(tel.players.length === 2, 'both survival players in the file (' + tel.players.length + ')')
  ea = pneOraBEntry(tel, pidA)
  pneOraB(ea !== null && /^[0-9a-f]{32}$/.test(ea.pid), 'players carry the 32-hex pseudonym')
  pneOraB(ea.f.length === 31 && typeof ea.f[5] === 'number' && Math.round(ea.f[3] * 10000) / 10000 === ea.f[3], '31 features, 4 decimals')
  pneOraB(ea.dim === 'minecraft:overworld' && ea.comfort === true && ea.log === false && typeof ea.t === 'number', 'dim, comfort on by default, log off by default, sample tick')
  pneOraB(ea.ev && ea.ev.died === false && ea.ev.respawned === false && ea.ev.enc_start === false && ea.ev.enc_end === false, 'ev flags present')
  pneOraB(raw.indexOf('11111111-0000') < 0 && raw.indexOf('22222222-0000') < 0 && raw.indexOf('Ann') < 0 && raw.indexOf('Bob') < 0,
    'no UUID or name anywhere in telemetry.json')
  pneOraB(raw.indexOf('"x"') < 0 && raw.indexOf('"z"') < 0, 'no x or z position in telemetry.json')
  seq = tel.seq
  boot = tel.boot_id
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(tel.seq === seq + 1 && tel.boot_id === boot, 'seq +1 per second, same boot_id')

  // --- verdict acceptance (integers written as 2.0; Java maps and Doubles in Rhino)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, tel.tick, 'cpu_np', [{ pid: pidA, a: goodA.a, s: goodA.s, f: goodA.f }], null)
  pneOraB(pneCoreVerdict(A) === null, 'no verdict before the read slot')
  if (__pneOraMock.gson) {
    k = JsonIO.read(PNE_ORA_B_VERP)
    pneOraB(typeof k.get('boot_id') === 'object' && typeof k.get('boot_id').doubleValue === 'function' && typeof k.get('seq') === 'object' &&
      Number(k.get('seq')) === tel.seq && String(k.get('boot_id')) === boot,
    'Rhino: JsonIO.read hands out LazilyParsedNumber for numbers and for the numeric boot_id string (real Gson + JsonUtils)')
  }
  pneOraBToSlot(srv, 10)
  v = pneCoreVerdict(A)
  pneOraB(v !== null && v.fresh === true && v.age === pneCoreTick - tel.tick && v.age === 10, 'verdict accepted at slot 10, fresh, age from the answered tick')
  pneOraB(v && Math.abs(v.EO - (0.2 + 0.6 + 1.2) / 3) < 1e-9 && v.band === 2 && Math.abs(v.conf - 0.4) < 1e-9, 'EO, band and conf computed from arousal')
  pneOraB(v && v.style === 'hide' && Math.abs(v.pFlee - 0.2) < 1e-9 && Math.abs(v.pEngage - 0.1) < 1e-9 && v.backend === 'cpu_np', 'style bucket, pFlee, pEngage, backend')
  pneOraB(v && v.arousal.length === 4 && v.styleP.length === 4 && v.fe.length === 3 && typeof v.arousal[0] === 'number', 'probability arrays as JS numbers')
  pneOraB(pneCoreVerdict(B) === null, 'a player missing from the verdict has none')
  r = pneOraBuckets(A)
  pneOraB(r && r.style === 'hide' && r.band === 2 && r.fresh === true && r.arousal === undefined, 'bucket view carries only style, band, fresh')

  // wrong boot_id, old seq, seq never written: all rejected (the last verdict is kept)
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText('1', tel.seq, tel.tick, 'cpu_np', [{ pid: pidA, a: [1, 0, 0, 0], s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  pneOraB(pneCoreVerdict(A).band === 2, 'a verdict from another boot is ignored')
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq - 1, tel.tick, 'cpu_np', [{ pid: pidA, a: [1, 0, 0, 0], s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  pneOraB(pneCoreVerdict(A).band === 2, 'a verdict whose seq is not newer is ignored')
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq + 50, tel.tick, 'cpu_np', [{ pid: pidA, a: [1, 0, 0, 0], s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  pneOraB(pneCoreVerdict(A).band === 2, 'a verdict for a seq never written is ignored')
  k = pneOraIo.rBad
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, tel.tick, 'cpu_np', [{ pid: pidA, a: [1, 0, 0, 0], s: goodA.s, f: goodA.f }], null).replace('"v": 2.0', '"v": 1.0')
  pneOraBToSlot(srv, 10)
  pneOraB(pneCoreVerdict(A).band === 2 && pneOraIo.rBad === k + 1, 'a verdict with another file version is ignored and counted')
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, tel.tick, 'cpu_np', [{ pid: pidA, a: [0.9, 0.9, 0, 0], s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  pneOraB(pneCoreVerdict(A).band === 2 && pneOraApplied === tel.seq, 'probabilities that do not sum to 1 are skipped (the file itself is accepted)')

  // malformed entries are skipped, good ones kept; style below 0.5 is 'none'
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, tel.tick, 'cpu_np', [
    { pid: pidA, a: [0.7, 0.1, 0.1, 0.1], s: [0.4, 0.3, 0.2, 0.1], f: [0.5, 0.3, 0.2] },
    { pid: pidB, a: [0.5, 0.5, 0.5], s: goodA.s, f: goodA.f },
    { pid: 'not-a-pid', a: goodA.a, s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  v = pneCoreVerdict(A)
  pneOraB(v.fresh && v.band === 0 && v.style === 'none', 'new verdict applied: band 0, style none below 0.5')
  pneOraB(pneCoreVerdict(B) === null, 'malformed arousal (3 values) is skipped')

  // staleness: fresh up to 60 ticks after the answered tick, stale after
  k = tel.tick
  while (pneCoreTick < k + 60) __pneMock.tick(srv, 1)
  pneOraB(pneCoreVerdict(A).fresh === true && pneCoreVerdict(A).age === 60, 'still fresh at age 60')
  __pneMock.tick(srv, 1)
  pneOraB(pneCoreVerdict(A).fresh === false && pneCoreVerdict(A).age === 61, 'stale at age 61 (no newer verdict)')

  // missing backend: accepted but never fresh
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, tel.tick, null, [{ pid: pidA, a: goodA.a, s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  pneOraB(pneCoreVerdict(A).fresh === false && pneCoreVerdict(A).backend === '', 'a verdict without backend is not fresh')

  // torn and missing reads: the last verdict stays, nothing trips
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, tel.tick, 'cpu_np', [{ pid: pidA, a: goodA.a, s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  k = pneOraIo.rTorn
  __pneOraMock.io.torn[PNE_ORA_B_VERP] = true
  pneOraBToSlot(srv, 10)
  pneOraB(pneOraIo.rTorn === k + 1 && pneCoreVerdict(A).band === 2 && !PNE_ORA_B_TICK.off, 'a torn verdict.json keeps the last verdict and trips nothing')
  __pneOraMock.io.torn[PNE_ORA_B_VERP] = false
  delete __pneOraMock.io.files[PNE_ORA_B_VERP]
  k = pneOraIo.rMissing
  pneOraBToSlot(srv, 10)
  pneOraB(pneOraIo.rMissing === k + 1 && pneCoreVerdict(A) !== null, 'a missing verdict.json is counted, last verdict kept')

  // a late answer (the sidecar stalled for 25 s): applied, so seq moves on, but never reported fresh
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  seq = tel.seq
  t0 = tel.tick
  while (pneCoreTick < t0 + 500) __pneMock.tick(srv, 1)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, seq, t0, 'cpu_np', [{ pid: pidA, a: [0.1, 0.1, 0.1, 0.7], s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  v = pneCoreVerdict(A)
  pneOraB(pneOraApplied === seq && v.band === 3 && v.fresh === false && v.age >= 500,
    'a verdict answering telemetry written 500+ ticks ago is applied but not fresh (age ' + (v ? v.age : '-') + ', fresh ' + (v ? v.fresh : '-') + ')')
  // the age counts from this run's own record of the write, not from the echoed tick
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, 0, 'cpu_np', [{ pid: pidA, a: goodA.a, s: goodA.s, f: goodA.f }], null)
  pneOraBToSlot(srv, 10)
  v = pneCoreVerdict(A)
  pneOraB(v.fresh === true && v.age === 10 && v.band === 2, 'an echoed tick of 0 does not change the age: it counts from the recorded write (age ' + v.age + ')')
  pneOraB(pneCoreTick - pneOraVerdictBase(123456789, NaN) > PNE_ORA_STALE && pneCoreTick - pneOraVerdictBase(123456789, pneCoreTick + 40) > PNE_ORA_STALE &&
    pneOraVerdictBase(123456789, pneCoreTick - 5) === pneCoreTick - 5, 'an unknown seq is dated by a past echoed tick, else counted as stale (missing or future tick)')

  // budget refusal: the slot-0 write retries on the next tick
  cost = PNE_CORE_COST.bridgeWrite
  PNE_CORE_COST.bridgeWrite = 99
  pneOraBToSlot(srv, 0)
  k = __pneOraMock.get(PNE_ORA_B_TELP).seq
  PNE_CORE_COST.bridgeWrite = cost
  __pneMock.tick(srv, 1)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(tel.seq === k + 1 && tel.tick % 20 === 1, 'a write refused by the token budget runs on the next tick')

  // write failures: skipped cycles, back-off after 5 in a row, recovery, no breaker trip
  __pneOraMock.io.failWrite = true
  writes = pneOraIo.wFail
  for (i = 0; i < 6; i++) pneOraBToSlot(srv, 0)
  pneOraB(pneOraIo.wFail - writes === 5 && pneOraIo.nextTry > pneCoreTick && !PNE_ORA_B_TICK.off, 'five failed writes, then back-off (' + (pneOraIo.wFail - writes) + ')')
  pneOraB(pneOraStatusLine(null).indexOf('failing') >= 0, 'status line shows the failing bridge')
  __pneOraMock.io.failWrite = false
  k = pneOraSeq
  __pneMock.tick(srv, 640)
  pneOraB(pneOraSeq > k && pneOraIo.consec === 0, 'writes resume after the back-off')

  // --- logging opt-in: two steps, only the caller, never for someone else (not even through "execute as")
  uA = pneCoreUuid(A)
  uB = pneCoreUuid(B)
  cmd0 = srv.cmds.length
  r = brig.run('pne oracle log on', __pneMock.source(srv, A, 0))
  code = pneOraBCode(srv, uA, cmd0)
  pneOraB(r === 1 && Number(pneCorePD(A).getByte('pne_log')) === 0 && /^[0-9a-f]{12}$/.test(code),
    '/pne oracle log on alone does not enable logging: it sends the caller a one-time code (' + code + ')')
  pneOraB(pneOraBOnlyTo(srv, code, uA, cmd0) && pneOraBHasCmd(srv, '"clickEvent":{"action":"run_command","value":"/pne oracle log confirm ' + code + '"}', cmd0),
    'the code goes to the caller alone (tellraw by UUID) as a clickable /pne oracle log confirm link')
  r = brig.run('pne oracle log confirm ' + code, __pneMock.source(srv, A, 0))
  pneOraB(r === 1 && Number(pneCorePD(A).getByte('pne_log')) === 1 && Number(pneCorePD(B).getByte('pne_log')) === 0, 'the caller\'s own confirm sets only the caller')
  pneCorePD(A).putByte('pne_log', 0)
  r = brig.run('pne oracle log confirm ' + code, __pneMock.source(srv, A, 0))
  pneOraB(r === 1 && Number(pneCorePD(A).getByte('pne_log')) === 0, 'a code works once')
  pneCorePD(A).putByte('pne_log', 1)
  // "execute as Bob run pne oracle log on" typed by an operator (or run by the console, a command block, a function)
  cmd0 = srv.cmds.length
  r = brig.run('pne oracle log on', __pneMock.source(srv, B, 4))
  code = pneOraBCode(srv, uB, cmd0)
  pneOraB(r === 1 && Number(pneCorePD(B).getByte('pne_log')) === 0, '"execute as Bob run pne oracle log on" by an operator leaves Bob\'s logging off')
  pneOraB(code !== '' && pneOraBOnlyTo(srv, code, uB, cmd0), 'the code is shown to Bob only; the operator never sees it')
  r = brig.run('pne oracle log confirm 0123456789ab', __pneMock.source(srv, B, 4))
  pneOraB(r === 1 && Number(pneCorePD(B).getByte('pne_log')) === 0, 'a guessed code is refused')
  r = brig.run('pne oracle log confirm ' + code, __pneMock.source(srv, B, 4))
  pneOraB(Number(pneCorePD(B).getByte('pne_log')) === 0, 'any failed try uses the code up: guessing cannot work')
  cmd0 = srv.cmds.length
  brig.run('pne oracle log on', __pneMock.source(srv, B, 0))
  code = pneOraBCode(srv, uB, cmd0)
  brig.run('pne oracle log on', __pneMock.source(srv, B, 0))
  brig.run('pne oracle log on', __pneMock.source(srv, B, 4))
  pneOraB(code !== '' && pneOraBTimes(srv, 'log confirm', cmd0) === 1, 'repeated log on within 5 s sends no further prompt (no chat spam)')
  k = pneCoreTick
  while (pneCoreTick <= k + 1200) __pneMock.tick(srv, 1)
  r = brig.run('pne oracle log confirm ' + code, __pneMock.source(srv, B, 0))
  pneOraB(r === 1 && Number(pneCorePD(B).getByte('pne_log')) === 0, 'a code older than 60 s is refused')
  cmd0 = srv.cmds.length
  brig.run('pne oracle log on', __pneMock.source(srv, B, 0))
  code2 = pneOraBCode(srv, uB, cmd0)
  r = brig.run('pne oracle log confirm ' + code2.toUpperCase(), __pneMock.source(srv, B, 0))
  pneOraB(r === 1 && code2 !== code && Number(pneCorePD(B).getByte('pne_log')) === 1, 'Bob\'s own confirm of a fresh code turns his logging on')
  r = brig.run('pne oracle log off', __pneMock.source(srv, B, 4))
  pneOraB(r === 1 && Number(pneCorePD(B).getByte('pne_log')) === 0, 'log off takes effect at once (it only reduces data)')
  r = brig.run('pne oracle log on Bob', __pneMock.source(srv, null, 4))
  pneOraB(r === 0 && Number(pneCorePD(B).getByte('pne_log')) === 0, 'an operator cannot name another player')
  r = brig.run('pne oracle log on', __pneMock.source(srv, null, 4))
  pneOraB(r === 1 && Number(pneCorePD(B).getByte('pne_log')) === 0, 'the console gets a refusal and nothing changes')
  r = brig.run('pne oracle log confirm ' + code2, __pneMock.source(srv, null, 4))
  pneOraB(r === 1 && Number(pneCorePD(B).getByte('pne_log')) === 0, 'the console cannot confirm for anyone')
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(pneOraBEntry(tel, pidA).log === true && pneOraBEntry(tel, pidB).log === false, 'telemetry log flag follows each player')
  cmd0 = srv.cmds.length
  __pneMock.fire('PlayerEvents.loggedIn', { player: A })
  __pneMock.fire('PlayerEvents.loggedIn', { player: B })
  pneOraB(pneOraBHasCmd(srv, 'tellraw ' + pneCoreUuid(A), cmd0) && pneOraBHasCmd(srv, 'logging is ON', cmd0), 'login notice for a logging player')
  pneOraB(!pneOraBHasCmd(srv, 'tellraw ' + pneCoreUuid(B), cmd0), 'no notice for a player who does not log')

  // --- status command
  __pneOraMock.put(PNE_ORA_B_STAP, { v: 2, backend: 'cpu_np', worker: { state: 'off', restarts: 0 }, uptime_s: 12.5, infer_p50_us: 20, errors: [], purged: [] })
  cmd0 = srv.cmds.length
  r = brig.run('pne oracle status', __pneMock.source(srv, A, 0))
  pneOraB(r === 1 && pneOraBHasCmd(srv, 'Oracle: bridge on', cmd0) && pneOraBHasCmd(srv, 'status.json: backend cpu_np', cmd0) &&
    pneOraBHasCmd(srv, 'logging is ON', cmd0), '/pne oracle status shows bridge, sidecar and the caller\'s logging')

  // --- purge hand-shake
  oldA = pidA
  r = brig.run('pne oracle purge', __pneMock.source(srv, A, 0))
  pidA = pneCorePid(A)
  pneOraB(r === 1 && pidA !== oldA && /^[0-9a-f]{32}$/.test(pidA), 'purge rotates the caller\'s pid')
  pdS = String(pneCorePD(srv).getCompound('pne_ora').getString('purge'))
  pneOraB(pdS === oldA, 'the old pid is kept in server.persistentData.pne_ora until acknowledged')
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(tel.purge && tel.purge.length === 1 && tel.purge[0] === oldA && pneOraBEntry(tel, pidA) !== null && pneOraBEntry(tel, oldA) === null,
    'telemetry carries purge [old pid] and the new pid for the player')
  pneOraPurge = null
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  pneOraB(pneOraPurgeList(srv).length === 1, 'the purge list survives a reload (persistent data)')
  __pneOraMock.put(PNE_ORA_B_STAP, { v: 2, backend: 'cpu_np', purged: ['0123456789abcdef0123456789abcdef', oldA] })
  pneOraBToSlot(srv, 10)
  __pneMock.tick(srv, 2)
  pneOraB(pneOraPurgeList(srv).length === 0 && String(pneCorePD(srv).getCompound('pne_ora').getString('purge')) === '', 'status.json purged acknowledges and clears it')
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(tel.purge === undefined, 'telemetry stops carrying the purge list')
  brig.run('pne oracle purge', __pneMock.source(srv, B, 0))
  k = pneOraPurgeList(srv)[0]
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  __pneOraMock.io.files[PNE_ORA_B_VERP] = pneOraBVerdictText(boot, tel.seq, tel.tick, 'cpu_np', [], [k])
  pneOraBToSlot(srv, 10)
  pneOraB(pneOraPurgeList(srv).length === 0, 'a purged list in verdict.json acknowledges too')
  pidB = pneCorePid(B)

  // --- event flags: died now; respawned rides with the first sample after the respawn
  __pneMock.fire('EntityEvents.death:minecraft:player', { entity: B, source: __pneMock.damage('mob', null) })
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(pneOraBEntry(tel, pidB).ev.died === true, 'died flag written')
  __pneMock.fire('PlayerEvents.respawned', { player: B })
  pneOraBToSlot(srv, 0)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  ea = pneOraBEntry(tel, pidB)
  pneOraB(ea.ev.died === false && ea.ev.respawned === true && ea.t > pneOraSt[pneCoreUuid(B)].respAt - 2, 'died cleared after one write; respawned with a post-respawn sample')
  pneOraBToSlot(srv, 0)
  pneOraB(pneOraBEntry(__pneOraMock.get(PNE_ORA_B_TELP), pidB).ev.respawned === false, 'respawned cleared after it was written')
  __pneOraMock.addMob(srv, 'epca:ripper', 4.5, 64, 0.5, false)
  pneOraBToSlot(srv, 0)
  pneOraB(pneOraBEntry(__pneOraMock.get(PNE_ORA_B_TELP), pidA).ev.enc_start === true, 'enc_start when a parasite comes within 24')
  srv.level.mobs = []
  pneOraBToSlot(srv, 0)
  pneOraB(pneOraBEntry(__pneOraMock.get(PNE_ORA_B_TELP), pidA).ev.enc_end === true, 'enc_end when it is gone')

  // --- world id (read from the hive's compound) rides along for the sidecar's worlds/<wid>/
  k = pneCorePD(srv).getCompound('pne_hive')
  k.putString('wid', '0f0e0d0c-0b0a-4908-8706-050403020100')
  pneCorePD(srv).put('pne_hive', k)
  pneOraWidAt = -1000000
  pneOraBToSlot(srv, 0)
  pneOraB(__pneOraMock.get(PNE_ORA_B_TELP).wid === '0f0e0d0c-0b0a-4908-8706-050403020100', 'wid copied into telemetry.json')

  // --- /pne oracle off: one last file with want_oracle false, then silence; telemetry keeps running
  r = brig.run('pne oracle off', __pneMock.source(srv, null, 4))
  __pneMock.tick(srv, 1)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(r === 1 && tel.want_oracle === false && tel.players.length === 0, 'one last telemetry.json with want_oracle false')
  writes = __pneOraMock.io.writes
  k = __pneOraMock.io.reads
  __pneMock.tick(srv, 60)
  pneOraB(__pneOraMock.io.writes === writes && __pneOraMock.io.reads === k, 'no bridge writes or reads while the oracle is off')
  pneOraB(pneCoreVerdict(A) === null && pneOraVerdict(A) === null, 'verdicts are null with the oracle off')
  pneOraB(pneOraSnap(A) !== null && pneCoreTick - pneOraSnap(A).tick < 20, 'telemetry extraction continues with the oracle off')
  r = brig.run('pne oracle on', __pneMock.source(srv, null, 4))
  seq = pneOraSeq
  __pneMock.tick(srv, 21)
  tel = __pneOraMock.get(PNE_ORA_B_TELP)
  pneOraB(tel.want_oracle === true && tel.seq === seq + 1 && tel.players.length === 2, 'bridge resumes after /pne oracle on')

  // --- dedicated servers: off unless bridge_dedicated is 1; unknown server type fails closed
  srv.dedicated = true
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  writes = __pneOraMock.io.writes
  __pneMock.tick(srv, 40)
  pneOraB(__pneOraMock.io.writes === writes && pneOraStatusLine(null).indexOf('dedicated server') >= 0, 'bridge off on a dedicated server by default')
  pneCoreCfgSet(srv, 'bridge_dedicated', 1)
  __pneMock.tick(srv, 40)
  pneOraB(__pneOraMock.io.writes > writes, 'bridge_dedicated 1 enables it')
  pneCoreCfgSet(srv, 'bridge_dedicated', 0)
  // The server mock has only isDedicated(), the name KubeJS shows for MinecraftServer.isDedicatedServer() (F37)
  pneOraB(typeof srv.isDedicatedServer === 'undefined' && typeof srv.isDedicated === 'function', 'the server mock has isDedicated only (in-game shape)')
  k = srv.isDedicated
  srv.isDedicated = null
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  writes = __pneOraMock.io.writes
  __pneMock.tick(srv, 40)
  pneOraB(__pneOraMock.io.writes === writes && pneOraStatusLine(null).indexOf('unknown') >= 0, 'unknown server type: bridge stays off')
  srv.isDedicated = k
  srv.dedicated = false
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  __pneMock.tick(srv, 40)
  pneOraB(__pneOraMock.io.writes > writes, 'integrated server (isDedicated() false): bridge on')
  // A server shape that shows only the Mojang name still decides (fallback); the KubeJS name wins when both exist
  srv.isDedicated = null
  srv.isDedicatedServer = function () { return true }
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  writes = __pneOraMock.io.writes
  __pneMock.tick(srv, 40)
  pneOraB(__pneOraMock.io.writes === writes && pneOraStatusLine(null).indexOf('dedicated server') >= 0, 'isDedicatedServer() fallback: dedicated, bridge off')
  srv.isDedicated = k
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  __pneMock.tick(srv, 40)
  pneOraB(__pneOraMock.io.writes > writes, 'isDedicated() false wins over isDedicatedServer() true: bridge on')
  delete srv.isDedicatedServer
  pneOraB(pneOraIsDedicated(null) === null && pneOraIsDedicated({}) === null &&
    pneOraIsDedicated({ isDedicated: function () { return true } }) === true &&
    pneOraIsDedicated({ isDedicatedServer: function () { return false } }) === false,
  'pneOraIsDedicated: null server and no method give null (Platform absent here); isDedicated(); the isDedicatedServer() fallback')

  // --- handlers never threw
  pneOraB(!PNE_ORA_B_TICK.off && PNE_ORA_B_EVENTS.total === 0 && PNE_ORA_B_CMD.total === 0 && PNE_ORA_B_TICK.total === 0,
    'no handler failure (tick ' + PNE_ORA_B_TICK.total + ', events ' + PNE_ORA_B_EVENTS.total + ', commands ' + PNE_ORA_B_CMD.total + ')')
}

var pneOraBridgeResult = 'FAIL not run'
try {
  pneOraBRun()
  pneOraBridgeResult = pneOraBFails.length ? 'FAIL ' + pneOraBFails.length + '/' + pneOraBCount + ': ' + pneOraBFails.join(' | ') : 'PASS ' + pneOraBCount
} catch (err) {
  pneOraBridgeResult = 'FAIL exception: ' + err + (err && err.stack ? ' ' + err.stack : '')
}
