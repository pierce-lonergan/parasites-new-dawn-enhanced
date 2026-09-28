// Node runner that evaluates ES5 files in ONE shared context, like one KubeJS script pack.
//
//   node tools/tests/kjs_node.js EXPR FILE...
//
// Prints the value of EXPR after the files ran; exits 1 if a file throws or EXPR is not a string
// starting with "PASS". The context gets `console` and `global`, which behaves like KubeJS's shared
// java.util.HashMap as seen from Rhino: a stored number or string comes back as a wrapper object
// (typeof 'object', so === and !== against a number or string fail and only Number(x) / String(x) are
// safe), and a missing key reads as undefined. Use tools/tests/kjs_mocks.js as the first file to get the
// KubeJS event groups.
'use strict'
const fs = require('fs')
const path = require('path')
const vm = require('vm')

function main (argv) {
  if (argv.length < 4) {
    console.log('usage: node tools/tests/kjs_node.js EXPR FILE...')
    return 2
  }
  const logs = []
  const quiet = {
    info: (m) => logs.push('[info] ' + m),
    warn: (m) => logs.push('[warn] ' + m),
    error: (m) => logs.push('[error] ' + m),
    log: (m) => logs.push('[log] ' + m),
    debug: () => {}
  }
  const store = Object.create(null)
  const globalMap = new Proxy(store, {
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
  const ctx = vm.createContext({ global: globalMap, console: quiet })
  try {
    for (const f of argv.slice(3)) {
      vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: path.basename(f) })
    }
    const r = String(vm.runInContext(argv[2], ctx, { filename: 'expr' }))
    console.log(r)
    if (r.indexOf('PASS') !== 0) {
      console.log(logs.join('\n'))
      return 1
    }
    return 0
  } catch (e) {
    console.log('FAIL ' + (e && e.stack ? e.stack : e))
    console.log(logs.join('\n'))
    return 1
  }
}

process.exitCode = main(process.argv)
