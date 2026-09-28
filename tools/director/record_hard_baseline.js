// Records the L5 oracle of suite director-diff: tools/director/fixtures/horror_hard_baseline.json.
//
// It was run ONCE, on 2026-09-28, from the release 1.4 scripts before the contract 1.5 edits of pne_horror.js and
// pne_resonance.js (git 8e2f433; the tree's contract 1.5 core and the 1.4 core of that commit give the same bytes).
// The fixture must never be regenerated from edited scripts: that would turn the oracle into a copy of whatever the
// scripts do now. So this tool refuses to overwrite an existing file. --out writes elsewhere (for a comparison run),
// and --core / --res / --horror point at other copies of the scripts (for example the 1.4 ones from git show).
//
//   node tools/director/record_hard_baseline.js [--out FILE] [--core FILE] [--res FILE] [--horror FILE]
//
// Contents (tools/director/diff_world.js describes the scripted world): the Hard command stream of pne_horror.js and
// pne_resonance.js (cmds), the director's Pace after every 1 Hz step (pace), pneResPaceOut over its whole input grid
// (paceOut, plain JSON) and pneResPureStep over 8 synthetic traces (pure). The three long sections are stored as
// base64 gzip of their JSON text, next to the SHA-256 of that text; director-diff compares the text itself.
'use strict'
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const D = require('./diff_world.js')

const FIXTURE = path.join(__dirname, 'fixtures', 'horror_hard_baseline.json')

function arg (name) {
  const i = process.argv.indexOf(name)
  return i > 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const gz = (s) => zlib.gzipSync(Buffer.from(s, 'utf8'), { level: 9 }).toString('base64')

function main () {
  const out = arg('--out') ? path.resolve(arg('--out')) : FIXTURE
  if (fs.existsSync(out)) {
    console.log('FAIL ' + out + ' exists: the Hard baseline is recorded once and never regenerated (write elsewhere with --out)')
    return 1
  }
  const files = {}
  if (arg('--core')) files.core = path.resolve(arg('--core'))
  if (arg('--res')) files.res = path.resolve(arg('--res'))
  if (arg('--horror')) files.horror = path.resolve(arg('--horror'))
  const src = Object.assign({}, D.FILES, files)
  const r = D.run({ files })
  const p = D.pacing(r.c)
  const cmds = JSON.stringify(r.W.stream)
  const pace = JSON.stringify(r.W.pace)
  const pure = JSON.stringify(p.pure)
  const paceOut = JSON.stringify(p.paceOut)
  const fileSha = {}
  for (const k of ['core', 'res', 'horror', 'cat', 'mocks']) {
    const f = path.isAbsolute(src[k]) ? src[k] : path.resolve(D.ROOT, src[k])
    fileSha[k] = sha(fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'))
  }
  const doc = {
    v: 1,
    what: 'Hard (profile 3) behaviour of pne_horror.js and pne_resonance.js, release 1.4, recorded before the contract 1.5 ' +
      'edits (lead decision L5: Hard stays bit for bit). Never regenerate; see tools/director/record_hard_baseline.js.',
    recorded: '2026-09-28',
    sources: fileSha,
    scenario: { ticks: D.TICKS, seed: D.SEED, world: 'tools/director/diff_world.js', catalog: D.FILES.cat },
    counts: { cmds: r.W.stream.length, pace: r.W.pace.length, paceOut: p.paceOut.length, pure: p.pure.length,
      allCmds: r.srv.cmds.length, beckons: r.W.beckons.length, products: r.W.products.length, flankPlaced: r.c.pneHFlkStats.placed },
    sha256: { cmds: sha(cmds), pace: sha(pace), paceOut: sha(paceOut), pure: sha(pure) },
    paceOut: p.paceOut,
    cmdsGz: gz(cmds),
    paceGz: gz(pace),
    pureGz: gz(pure)
  }
  fs.writeFileSync(out, JSON.stringify(doc, null, 1) + '\n')
  console.log('recorded ' + out + ': ' + JSON.stringify(doc.counts) + ' ' + JSON.stringify(doc.sha256))
  return 0
}

process.exitCode = main()
