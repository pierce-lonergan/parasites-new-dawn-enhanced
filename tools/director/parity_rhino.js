// Rhino side of director-parity (ES5). Files before it: kjs_mocks.js, pne_00_core.js, a catalog,
// pne_resonance.js and a generated file defining PNE_PAR_IN (the input traces). Result: pneParResult =
// 'PASS ' + JSON of [state, tier, raw, spawn, aggro, beckon, ga, gov, hard, e] per step.

function pneParRun() {
  var out = []
  var i
  var j
  var st
  var o
  var tr
  var x
  var row
  for (i = 0; i < PNE_PAR_IN.length; i++) {
    st = { fsm: pneResFsmNew(), tier: pneResTierNew() }
    tr = []
    for (j = 0; j < PNE_PAR_IN[i].length; j++) {
      x = PNE_PAR_IN[i][j]
      o = pneResPureStep(st, x)
      row = [o.state, o.tier, o.raw, o.spawn, o.aggro, o.beckon, o.ga, o.gov, o.hard, o.e]
      tr.push(row)
    }
    out.push(tr)
  }
  return 'PASS ' + JSON.stringify(out)
}

var pneParResult = 'FAIL not run'
try {
  pneParResult = pneParRun()
} catch (err) {
  pneParResult = 'FAIL ' + err
}
