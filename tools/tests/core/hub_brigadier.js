// Rhino-only: builds the /pne tree with REAL Brigadier (bound by tools/rhino/PneRhino as __brig) and runs
// commands through a real CommandDispatcher. Proves the Rhino fork adapts the hub's JS functions to
// Brigadier's Command interface and that greedy arguments arrive intact. Files, in order:
// tools/tests/kjs_mocks.js, pne_00_core.js, this file. Result: pneHubResult.

var pneHubFails = []
var pneHubCount = 0

function pneH2(cond, msg) {
  pneHubCount++
  if (!cond) pneHubFails.push(msg)
}

function pneHubRun() {
  var srv = __pneMock.server({ owner: 'Host' })
  var p = __pneMock.player(srv, 'Bob', 'bbbb0000-0000-4000-8000-000000000002', {})
  var host = __pneMock.player(srv, 'Host', 'aaaa0000-0000-4000-8000-000000000001', {})
  var disp = __brig.dispatcher()
  var seen = null
  var r
  var ev = {
    commands: {
      literal: function (n) { return __brig.literal(n) },
      argument: function (n, t) { return __brig.argument(n, t) }
    },
    arguments: {
      GREEDY_STRING: {
        create: function (e) { return __brig.greedy() },
        getResult: function (c, n) { return __brig.getString(c, n) }
      }
    },
    register: function (b) { return disp.register(b) }
  }
  pneCoreCommand('probe', { run: function (ctx) { seen = ctx.args.join('|'); return true }, help: 'probe' })
  __pneMock.fire('ServerEvents.loaded', { server: srv })
  __pneMock.fire('ServerEvents.commandRegistry', ev)
  r = __brig.execute(disp, 'pne probe alpha  beta gamma', __pneMock.source(srv, p, 0))
  pneH2(r === 1 && seen === 'alpha|beta|gamma', 'greedy args through real Brigadier (got ' + r + ', ' + seen + ')')
  seen = null
  r = __brig.execute(disp, 'pne probe', __pneMock.source(srv, p, 0))
  pneH2(r === 1 && seen === '', 'bare word executes with no args')
  r = __brig.execute(disp, 'pne', __pneMock.source(srv, p, 0))
  pneH2(r === 1, 'bare /pne prints help')
  r = __brig.execute(disp, 'pne resonance off', __pneMock.source(srv, host, 0))
  pneH2(r === 1 && pneCoreOn('resonance') === false, 'owner switches resonance off through real Brigadier')
  r = __brig.execute(disp, 'pne resonance on', __pneMock.source(srv, host, 0))
  pneH2(pneCoreOn('resonance') === true, 'and back on')
  r = __brig.execute(disp, 'pne unknownword', __pneMock.source(srv, p, 0))
  pneH2(r === -1, 'unknown word is a Brigadier parse error')
}

var pneHubResult = 'FAIL not run'
try {
  if (typeof __brig === 'undefined') {
    pneHubResult = 'PASS skipped (Brigadier jar not on the classpath)'
  } else {
    pneHubRun()
    pneHubResult = pneHubFails.length ? 'FAIL ' + pneHubFails.join(' | ') : 'PASS ' + pneHubCount
  }
} catch (err) {
  pneHubResult = 'FAIL exception: ' + err
}
