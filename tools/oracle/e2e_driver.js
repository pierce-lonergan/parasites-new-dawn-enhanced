// Driver for tools/oracle/BridgeE2E.java (real bridge + real sidecar). ES5.
// Two survival players; Ann opted into logging herself, Bob did not. One parasite in sight.
var pneOraE2eSrv = null
var pneOraE2eA = null
var pneOraE2eB = null

function pneOraE2eInit() {
  var srv = __pneMock.server({ tickCount: 40000 })
  __pneOraMock.world(srv)
  pneOraE2eA = __pneOraMock.equip(__pneMock.player(srv, 'Ann', '11111111-0000-4000-8000-00000000000a', { x: 0.5, y: 64, z: 0.5 }), { item: __pneOraMock.item('minecraft:bow') })
  pneOraE2eB = __pneOraMock.equip(__pneMock.player(srv, 'Bob', '22222222-0000-4000-8000-00000000000b', { x: 9.5, y: 64, z: 0.5 }), {})
  __pneOraMock.addMob(srv, 'epca:ripper', 6.5, 64, 4.5, true)
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  __pneMock.fire('PlayerEvents.loggedIn', { player: pneOraE2eA })
  __pneMock.fire('PlayerEvents.loggedIn', { player: pneOraE2eB })
  pneCorePD(pneOraE2eA).putByte('pne_log', 1)
  pneOraE2eSrv = srv
}

// One server tick; returns "slot fresh age" for Ann's verdict.
function pneOraE2eTick() {
  var v
  pneOraE2eA.x += 0.25
  pneOraE2eA.yaw = (pneOraE2eA.yaw + 11) % 360
  pneOraE2eB.sneak = (pneCoreTick % 200) < 100
  __pneMock.tick(pneOraE2eSrv, 1)
  v = pneCoreVerdict(pneOraE2eA)
  return pneCoreSlot + ' ' + (v !== null && v.fresh === true) + ' ' + (v ? v.age : -1)
}

function pneOraE2eState() {
  var a = pneCoreVerdict(pneOraE2eA)
  var b = pneCoreVerdict(pneOraE2eB)
  return 'written=' + pneOraSeq + ' applied=' + pneOraApplied + ' rOk=' + pneOraIo.rOk + ' rTorn=' + pneOraIo.rTorn +
    ' rMissing=' + pneOraIo.rMissing + ' wFail=' + pneOraIo.wFail + ' pidA=' + pneCorePid(pneOraE2eA) + ' pidB=' + pneCorePid(pneOraE2eB) +
    ' backendA=' + (a ? a.backend : '-') + ' fillA=' + (a ? a.fill : -1) + ' styleA=' + (a ? a.style : '-') + ' bandA=' + (a ? a.band : -1) +
    ' EOA=' + (a ? pneCoreFmt(a.EO) : '-') + ' verdictB=' + (b !== null) + ' breakers=' + PNE_ORA_B_TICK.total + '/' + PNE_ORA_B_EVENTS.total
}
