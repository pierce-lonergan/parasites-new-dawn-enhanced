// Node side of director-parity: runs pne_resonance.js's pure core (loaded as KubeJS would, with the mocks and
// the core) over the input traces and writes the outputs, together with the pace and gov1h of the core's difficulty
// profile table PNE_CORE_DIFF (contract 1.5; the input field diff picks the row, default 3).
//   node tools/director/parity_js.js IN.json OUT.json
'use strict'
const fs = require('fs')
const P = require('./pack.js')

const c = P.load([P.MOCKS, P.CORE, P.EMPTY_CAT, P.RES])
const traces = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const out = traces.map(tr => {
  const st = { fsm: c.pneResFsmNew(), tier: c.pneResTierNew() }
  return tr.map(x => {
    const o = c.pneResPureStep(st, x)
    return { state: o.state, tier: o.tier, raw: o.raw, spawn: o.spawn, aggro: o.aggro, beckon: o.beckon, ga: o.ga, gov: o.gov, hard: o.hard, e: o.e }
  })
})
const table = c.PNE_CORE_DIFF.map(r => ({ id: r.id, pace: r.pace, gov1h: r.gov1h }))
fs.writeFileSync(process.argv[3], JSON.stringify({ out, table }))
console.log('node parity: ' + out.reduce((n, t) => n + t.length, 0) + ' steps')
