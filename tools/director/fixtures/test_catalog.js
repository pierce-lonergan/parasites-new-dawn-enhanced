// Synthetic Resonance catalog for the director tests only (never shipped). Same layout as the generated
// overrides/kubejs/server_scripts/pne_res_catalog.js (docs/IMPLEMENTATION.md 5): every layer and class the
// director uses, with the TDD 2.3.2 master-table levels, durations and flags, two reserve variants per layer
// (none for the L1 segments and L8), and stereo beds (amb: true) that the director must never issue.
// ES5, so the same file loads in Node and in the Rhino harness.

var PNE_RES_CATALOG = { v: 1, gen: 'test', events: {}, pools: {} }

function pneTestCatAdd(layer, slug, cls, n, lufs, mOff, dur, cat, comfort, normal, att, lf, reserve, amb) {
  var i
  var id
  var key = slug + '.' + cls
  PNE_RES_CATALOG.pools[key] = []
  for (i = 1; i <= n; i++) {
    id = 'pne:res.' + slug + '.' + cls + '.v' + (i < 10 ? '0' : '') + i
    PNE_RES_CATALOG.events[id] = {
      layer: layer, cls: cls, lufs: lufs, mmax: lufs + mOff, dur: dur, cat: cat, comfort: comfort, normal: normal,
      att: att, stream: dur > 10, lf: lf, reserve: i > n - reserve, amb: amb === true
    }
    PNE_RES_CATALOG.pools[key].push(id)
  }
}

pneTestCatAdd('L1', 'hollow', 'dry', 6, -30, 4, 7.0, 'ambient', true, true, 128, false, 0)
pneTestCatAdd('L1', 'hollow', 'dread', 6, -32, 4, 7.0, 'ambient', true, true, 128, false, 0)
pneTestCatAdd('L1', 'hollow', 'muffled', 6, -36, 4, 7.0, 'ambient', true, true, 128, false, 0)
pneTestCatAdd('L1', 'hollow', 't_dry_dread', 2, -31, 4, 7.0, 'ambient', true, true, 128, false, 0)
pneTestCatAdd('L1', 'hollow', 't_dread_muffled', 2, -34, 4, 7.0, 'ambient', true, true, 128, false, 0)
pneTestCatAdd('L1', 'hollow', 't_dry_muffled', 2, -33, 4, 7.0, 'ambient', true, true, 128, false, 0)
pneTestCatAdd('L1', 'hollow', 'bed_dry', 6, -30, 4, 60.0, 'ambient', true, true, 128, false, 0, true)
pneTestCatAdd('L2', 'undertone', 'a', 6, -32, 6, 9.0, 'ambient', false, true, 128, true, 2)
pneTestCatAdd('L3', 'pulse', 'heartbeat', 6, -32, 6, 8.0, 'ambient', false, true, 128, true, 2)
pneTestCatAdd('L3', 'pulse', 'heartbeat_c', 6, -34, 6, 7.5, 'ambient', true, false, 128, true, 2)
pneTestCatAdd('L3', 'pulse', 'flutter', 6, -32, 6, 8.0, 'ambient', false, true, 128, true, 2)
pneTestCatAdd('L3', 'pulse', 'rough', 6, -32, 6, 8.0, 'ambient', false, true, 128, true, 2)
pneTestCatAdd('L4', 'beat', 'slow', 6, -34, 6, 9.0, 'ambient', true, true, 128, false, 2)
pneTestCatAdd('L4', 'beat', 'tense', 6, -34, 6, 9.0, 'ambient', false, true, 128, false, 2)
pneTestCatAdd('L5', 'whisper', 'amb', 12, -28, 6, 3.0, 'voice', true, true, 32, false, 2)
pneTestCatAdd('L5', 'whisper', 'near', 12, -28, 6, 3.0, 'voice', true, true, 32, false, 2)
pneTestCatAdd('L6', 'approach', 'n', 6, -24, 4.13, 3.5, 'hostile', false, true, 128, false, 2)
pneTestCatAdd('L6', 'approach', 'c', 6, -28, 2.26, 4.0, 'hostile', true, false, 128, false, 2)
pneTestCatAdd('L7', 'spike', 'a', 6, -20, 6, 1.5, 'hostile', false, true, 128, false, 2)
pneTestCatAdd('L8', 'tell', 'a', 6, -22, 6, 0.6, 'hostile', true, true, 24, false, 0)
