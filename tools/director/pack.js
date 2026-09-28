// Node helper for the director tests: evaluates KubeJS files in ONE vm context (one script pack), exactly
// like tools/tests/kjs_node.js (same wrapped `global`: stored numbers and strings come back as wrapper
// objects, as from KubeJS's java.util.HashMap), and hands the context back so a test can drive it from Node.
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const ROOT = path.resolve(__dirname, '..', '..')
const MOCKS = 'tools/tests/kjs_mocks.js'
const CORE = 'overrides/kubejs/server_scripts/pne_00_core.js'
const RES = 'overrides/kubejs/server_scripts/pne_resonance.js'
const HORROR = 'overrides/kubejs/server_scripts/pne_horror.js'
const GATE = 'overrides/kubejs/startup_scripts/pne_res_gate.js'
const TEST_CAT = 'tools/director/fixtures/test_catalog.js'
const EMPTY_CAT = 'tools/director/fixtures/empty_catalog.js'

function makeGlobal () {
  const store = Object.create(null)
  return new Proxy(store, {
    get (t, k) {
      if (typeof k !== 'string' || !(k in t)) return undefined
      const v = t[k]
      if (typeof v === 'number') return new Number(v) // eslint-disable-line no-new-wrappers
      if (typeof v === 'string') return new String(v) // eslint-disable-line no-new-wrappers
      return v
    },
    set (t, k, v) { t[k] = v; return true },
    has (t, k) { return k in t },
    deleteProperty (t, k) { delete t[k]; return true }
  })
}

// Every world gets a seeded Math.random (xorshift32), so the random player pids the core creates, and with
// them the director's own RNG (seeded worldSeed ^ pidHash ^ day), are the same on every run: a failure always
// reproduces. The seed is PNE_TEST_SEED (to sweep seeds by hand) or a fixed default, plus a per-world counter,
// so worlds in one test differ from each other.
let worldN = 0
function seedOf () {
  const env = Number(process.env.PNE_TEST_SEED)
  return ((isFinite(env) && env > 0 ? env : 20260927) + 7919 * (++worldN)) >>> 0
}

function load (files, extra) {
  const logs = []
  const quiet = {
    info: (m) => logs.push('[info] ' + m),
    warn: (m) => logs.push('[warn] ' + m),
    error: (m) => logs.push('[error] ' + m),
    log: (m) => logs.push('[log] ' + m),
    debug: () => {}
  }
  const sandbox = Object.assign({ global: makeGlobal(), console: quiet }, extra || {})
  const ctx = vm.createContext(sandbox)
  vm.runInContext('(function () { var s = ' + (seedOf() || 1) + '; Math.random = function () { s ^= s << 13; s >>>= 0; ' +
    's ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } })()', ctx)
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.resolve(ROOT, f), 'utf8'), ctx, { filename: path.basename(f) })
  }
  ctx.__logs = logs
  return ctx
}

// A tiny assertion collector shared by the Node tests.
function checker (name) {
  const fails = []
  let n = 0
  return {
    ok (cond, msg) { n++; if (!cond) fails.push(msg) },
    eq (a, b, msg) { n++; if (a !== b) fails.push(msg + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')') },
    done (extra) {
      if (fails.length) {
        for (const f of fails.slice(0, 60)) console.log('  FAIL ' + f)
        console.log('FAIL ' + name + ': ' + fails.length + '/' + n + ' checks failed' + (extra ? ' (' + extra + ')' : ''))
        process.exitCode = 1
      } else {
        console.log('PASS ' + name + ': ' + n + ' checks' + (extra ? ' (' + extra + ')' : ''))
      }
    },
    get count () { return n },
    get fails () { return fails }
  }
}

module.exports = { load, checker, ROOT, MOCKS, CORE, RES, HORROR, GATE, TEST_CAT, EMPTY_CAT }
