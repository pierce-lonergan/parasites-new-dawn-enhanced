// ES5 check of the generated catalog, evaluated right after overrides/kubejs/server_scripts/pne_res_catalog.js in
// the same scope, both in Node (tools/tests/kjs_node.js) and in the instance's Rhino jar (tools/rhino/pne_rhino.py run).
// No stereo bed ships (IMPLEMENTATION.md section 5, lead decision 1.3): an event with amb true or a bed_ class, or a
// bed_ pool, fails the check. The amb field itself stays in the format.
// Result: the string in pneResCatalogCheck, starting with PASS or FAIL.
var pneResCatalogCheck = (function () {
  var c
  var fails = []
  var n = 0
  var k
  var e
  var p
  var i
  var fields = ['layer', 'cls', 'lufs', 'mmax', 'dur', 'cat', 'comfort', 'normal', 'att', 'stream', 'lf', 'reserve', 'amb']
  var types = ['string', 'string', 'number', 'number', 'number', 'string', 'boolean', 'boolean', 'number', 'boolean', 'boolean', 'boolean', 'boolean']
  var needPools = ['hollow.dry', 'hollow.dread', 'hollow.muffled', 'hollow.t_dry_dread', 'hollow.t_dread_muffled', 'hollow.t_dry_muffled',
    'undertone.a', 'pulse.heartbeat', 'pulse.heartbeat_c', 'pulse.flutter',
    'pulse.rough', 'beat.slow', 'beat.tense', 'whisper.amb', 'whisper.near', 'approach.n', 'approach.c', 'spike.a', 'tell.a']
  if (typeof PNE_RES_CATALOG !== 'object' || PNE_RES_CATALOG === null) return 'FAIL PNE_RES_CATALOG is not an object'
  c = PNE_RES_CATALOG
  if (c.v !== 1) fails.push('v is not 1')
  if (typeof c.gen !== 'string' || c.gen.length !== 12) fails.push('gen is not 12 hex')
  for (k in c.events) {
    if (!c.events.hasOwnProperty(k)) continue
    n++
    e = c.events[k]
    for (i = 0; i < fields.length; i++) {
      if (typeof e[fields[i]] !== types[i]) fails.push(k + '.' + fields[i])
    }
    if (k.indexOf('pne:res.') !== 0) fails.push(k + ' id')
    if (e.amb !== false || String(e.cls).indexOf('bed_') === 0 || k.indexOf('.bed_') >= 0) fails.push(k + ' is a stereo bed (none ships)')
    if (e.layer === 'L8' && e.att !== 24) fails.push(k + ' tell att')
    if (e.layer === 'L5' && e.att !== 32) fails.push(k + ' whisper att')
    if (e.lufs > -13 || e.mmax > -13) fails.push(k + ' too loud')
  }
  for (k in c.pools) {
    if (c.pools.hasOwnProperty(k) && k.indexOf('bed_') >= 0) fails.push('pool ' + k + ' is a stereo bed pool (none ships)')
  }
  for (i = 0; i < needPools.length; i++) {
    p = c.pools[needPools[i]]
    if (!p || p.length < (needPools[i].indexOf('whisper.') === 0 ? 12 : 6)) fails.push('pool ' + needPools[i])
  }
  if (fails.length) return 'FAIL catalog: ' + fails.slice(0, 12).join(', ')
  return 'PASS catalog: ' + n + ' events, ' + needPools.length + ' required pools, no stereo bed'
})()
