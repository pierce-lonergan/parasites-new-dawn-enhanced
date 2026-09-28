// priority: 95
// Parasites New Dawn - Enhanced :: The Hive Remembers, GA core (pure ES5 library, no handlers)
//
// The Hive Genome engine of docs/TDD.md 3.1-3.3 and 3.6 behind the single object of docs/IMPLEMENTATION.md
// section 3.7. It uses no KubeJS binding and no Java class, so the same file runs inside KubeJS (Rhino fork)
// and in Node for the tests under tools/genome. The replay log grammar is in docs/modules/ga-core.md.
//
// Determinism rules (each measured in the instance's own Rhino jar against Node):
//  - only IEEE-754 + - * / and Math.floor/abs/min/max; no transcendental Math, no Math.random, no clock;
//  - 32-bit mixing through a local 16-bit split multiply; FNV-1a over an ASCII indexOf table, because
//    charCodeAt returns a java.lang.Character in the Rhino fork;
//  - every persisted number is kept canonical (an integer, or an integer / 1e6), so that save, load and
//    replay reproduce the live state bit for bit;
//  - sums run in index order, comparators are total orders with an index tie-break, and the sharing
//    kernel is an integer (2^-20 steps), so its cached sums are exact whatever the update order;
//  - every var sits at the top of its function (Rhino scopes var to its block).

var PNE_HIVE_GA = (function () {
  var G = 14
  var Q = 65535
  var GQ = 917490
  var CAP = 48
  var QUEUE_MAX = 16
  var SCHEMA = 1
  var K0 = 2
  var NMAX = 12
  var SIGMA_SHARE = 0.18
  var TOUR_K = 3
  var BLX_A = 0.3
  var BLX_W = 1 + 2 * 0.3
  var KS = 1048576
  var RING = 400
  var BASE_MAX = 512
  var LOG_CHARS = 45000
  var CHUNK = 48000
  var BASE_PART = 64
  var LAMBDA_LIVE = 0.3
  var LAMBDA_BATCH = 0.15
  var DREAM_MIN_SAMPLES = 42
  var DREAM_MIN_POOL = 8
  var DREAM_GENS = 5
  var DREAM_SCORE = 16
  var DREAM_PAIRS = 150
  var DREAM_KIDS = 8
  var DREAM_INS = 4
  var DREAM_SIGMA = 0.04
  var ELITE_MIN = 0.02
  var T_ALPHA = 0.206
  var T_FLOOR = 0.10
  var T_STEP = 0.10
  // Telemetry clamps. dmg is capped at 12 HP per encounter (TDD 3.2; one outcome record is one encounter), so one
  // explosion cannot drag a context baseline up for the next ~50 samples. The others keep every stored EMA inside an
  // NBT int (x 1e6).
  var TEL_MAX = [12, 2000, 1, 1, 1000, 1, 1]
  var INT_MAX = 2147483647

  var GENE_IDS = ['SPD', 'ACU', 'SCT', 'LUX', 'FLK', 'SIL', 'KBR', 'PRJ', 'ARM', 'PRC', 'HPX', 'DMG', 'TEL', 'MOR']
  var COST_MC = [1.4, 0.8, 0.8, 0.6, 0.6, 0.7, 0.8, 0.9, 1.2, 1.0, 1.3, 1.5, 0, 0]
  var COST_GEN = [1.4, 0.8, 0.8, 0.6, 0.6, 0.7, 0.8, 0.9, 1.2, 1.0, 1.3, 1.5, 0.9, 0]
  var TACTICS = ['hide', 'kite', 'turtle', 'light', 'audio']
  // Counter genes per tactic (TDD 3.2 table), as [gene index, weight] in TACTICS order.
  var COUNTERS = [
    [[1, 0.55], [2, 0.45]],
    [[0, 0.45], [6, 0.30], [7, 0.25]],
    [[9, 0.7], [11, 0.3]],
    [[3, 0.6], [4, 0.4]],
    [[5, 1.0]]
  ]
  var I_SPD = 0
  var I_SIL = 5
  var I_ARM = 8
  var I_DMG = 11
  var I_TEL = 12
  var I_MOR = 13

  // Species without generic.attack_damage (TDD 3.1, read from the EPCA 0.147i and Spore 2.2.0j bytecode;
  // class names mapped to registry ids through the jars' registries). SPD always has a speed attribute
  // (movement_speed comes from the LivingEntity base; flyers also have flying_speed); TEL has no phenotype
  // in Minecraft, so its mask bit is 0 everywhere.
  var NO_DMG = {
    'epca:curbug': 1, 'epca:living_flesh_size0': 1, 'epca:living_flesh_size1': 1, 'epca:living_flesh_size2': 1,
    'epca:living_flesh_size3': 1, 'epca:living_flesh_size4': 1, 'epca:infested_slime_size0': 1,
    'epca:infested_slime_size1': 1, 'epca:infested_slime_size3': 1,
    'spore:spitter': 1, 'spore:howit_arm': 1, 'spore:licker': 1, 'spore:sieger_tail': 1, 'spore:stahl_arm': 1,
    'spore:braurei': 1, 'spore:delusioner': 1, 'spore:mound': 1, 'spore:usurper': 1, 'spore:verva': 1,
    'spore:vigil': 1, 'spore:reconstructor': 1, 'spore:tendril': 1, 'spore:scent': 1, 'spore:tumoroid_nuke': 1
  }

  var ASCII = ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~'
  var HEXD = '0123456789abcdef'
  var SAFE = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_:./-'
  var DIGITS = '0123456789'
  var HEX56 = /^[0-9a-f]{56}$/
  var HEXB = []
  var hb
  for (hb = 0; hb < 256; hb++) HEXB.push(HEXD.charAt(hb >>> 4) + HEXD.charAt(hb & 15))

  // ---------------------------------------------------------------------------------------------
  // Deterministic primitives

  function imul32(a, b) {
    var ah = (a >>> 16) & 0xffff
    var al = a & 0xffff
    var bh = (b >>> 16) & 0xffff
    var bl = b & 0xffff
    return ((al * bl) + ((((ah * bl + al * bh) & 0xffff) << 16) >>> 0)) >>> 0
  }

  function fmix32(h) {
    var x = h >>> 0
    x = (x ^ (x >>> 16)) >>> 0
    x = imul32(x, 0x85ebca6b)
    x = (x ^ (x >>> 13)) >>> 0
    x = imul32(x, 0xc2b2ae35)
    x = (x ^ (x >>> 16)) >>> 0
    return x
  }

  // FNV-1a 32 over c = ASCII.indexOf(ch) + 32 (the same function as pneCoreFnv1a).
  function fnv1a(s) {
    var str = String(s)
    var h = 0x811c9dc5
    var i
    for (i = 0; i < str.length; i++) {
      h = (h ^ (ASCII.indexOf(str.charAt(i)) + 32)) >>> 0
      h = imul32(h, 16777619)
    }
    return h >>> 0
  }

  function mixSeed(parts) {
    var h = 0x9e3779b9
    var i
    for (i = 0; i < parts.length; i++) h = fmix32((h ^ (parts[i] >>> 0)) >>> 0)
    return h >>> 0
  }

  // mulberry32 (public domain), with the 16-bit split multiply of imul32 written inline: this is the hottest code
  // in Rhino's interpreter. Every event reseeds it (rngFor), so its 32-bit state does not matter here.
  function Rng(seed) {
    this.s = seed >>> 0
  }
  Rng.prototype.u32 = function () {
    var t
    var a
    var b
    this.s = (this.s + 0x6d2b79f5) >>> 0
    t = this.s
    a = (t ^ (t >>> 15)) >>> 0
    b = (t | 1) >>> 0
    t = ((a & 0xffff) * (b & 0xffff) + (((((a >>> 16) * (b & 0xffff) + (a & 0xffff) * (b >>> 16)) & 0xffff) << 16) >>> 0)) >>> 0
    a = (t ^ (t >>> 7)) >>> 0
    b = (t | 61) >>> 0
    b = ((a & 0xffff) * (b & 0xffff) + (((((a >>> 16) * (b & 0xffff) + (a & 0xffff) * (b >>> 16)) & 0xffff) << 16) >>> 0)) >>> 0
    t = (t ^ ((t + b) >>> 0)) >>> 0
    return (t ^ (t >>> 14)) >>> 0
  }
  Rng.prototype.next = function () {
    var t
    var a
    var b
    this.s = (this.s + 0x6d2b79f5) >>> 0
    t = this.s
    a = (t ^ (t >>> 15)) >>> 0
    b = (t | 1) >>> 0
    t = ((a & 0xffff) * (b & 0xffff) + (((((a >>> 16) * (b & 0xffff) + (a & 0xffff) * (b >>> 16)) & 0xffff) << 16) >>> 0)) >>> 0
    a = (t ^ (t >>> 7)) >>> 0
    b = (t | 61) >>> 0
    b = ((a & 0xffff) * (b & 0xffff) + (((((a >>> 16) * (b & 0xffff) + (a & 0xffff) * (b >>> 16)) & 0xffff) << 16) >>> 0)) >>> 0
    t = (t ^ ((t + b) >>> 0)) >>> 0
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  // Irwin-Hall: sum of 4 uniforms, centred and scaled by sqrt(3); bounded by 3.46.
  Rng.prototype.gauss = function () {
    var s = this.next() + this.next() + this.next() + this.next()
    return (s - 2) * 1.7320508075688772
  }

  var TAG_HIVE = fnv1a('pne_hive')
  var TAG_JOIN = fnv1a('pne_join')
  var TAG_DREAM = fnv1a('pne_dream')
  var TAG_BATCH = fnv1a('pne_batch')

  function rngFor(st, tagHash, counter) {
    return new Rng(mixSeed([st.seed, tagHash, counter]))
  }

  // ---------------------------------------------------------------------------------------------
  // Numbers and strings

  function clamp01(x) {
    return x > 0 ? (x < 1 ? x : 1) : 0
  }

  function quant1(x) {
    return Math.floor(clamp01(x) * Q + 0.5)
  }

  // Canonical integer (x * 1e6 rounded); non-finite or absurd values become 0.
  function q6(x) {
    var v = Number(x)
    if (!(v > -9e9 && v < 9e9)) return 0
    return Math.floor(v * 1e6 + 0.5)
  }

  function c6(x) {
    return q6(x) / 1e6
  }

  function q9(x) {
    var v = Number(x)
    if (!(v > -9e6 && v < 9e6)) return 0
    return Math.floor(v * 1e9 + 0.5)
  }

  function truthy(x) {
    var s
    if (x === true) return true
    if (x === false || x === null || x === undefined) return false
    s = String(x)
    return s === 'true' || s === '1' || s === '1.0'
  }

  function safeStr(x, max) {
    var s = (x === null || x === undefined) ? '' : String(x)
    var out = ''
    var i
    var c
    if (s.length > max) s = s.substring(0, max)
    for (i = 0; i < s.length; i++) {
      c = s.charAt(i)
      out += SAFE.indexOf(c) >= 0 ? c : '_'
    }
    return out.length ? out : '_'
  }

  function isInt(s) {
    var i
    var start = 0
    if (!s.length) return false
    if (s.charAt(0) === '-') start = 1
    if (start >= s.length || s.length > 17) return false
    for (i = start; i < s.length; i++) if (DIGITS.indexOf(s.charAt(i)) < 0) return false
    return true
  }

  function toInt(s) {
    var str = String(s)
    return isInt(str) ? Number(str) : NaN
  }

  // A string of any kind: a JS string, a JS String object or a java.lang.String (what HIVE reads back from NBT or
  // global is a wrapped Java String: typeof 'object', F6). Arrays and Java Lists have no split method.
  function isStr(x) {
    if (typeof x === 'string') return true
    if (x === null || x === undefined || typeof x !== 'object') return false
    try {
      return typeof x.split === 'function' && typeof x.size !== 'function'
    } catch (err) {
      return false
    }
  }

  // A JS array, a Java array or a Java List as a JS array (null if none of these, and null for any string).
  function toArr(x) {
    var out = []
    var n
    var i
    if (x === null || x === undefined) return null
    if (typeof x !== 'object' && typeof x !== 'function') return null
    if (isStr(x)) return null
    n = x.length
    if (typeof n === 'number') {
      for (i = 0; i < n; i++) out.push(x[i])
      return out
    }
    try {
      n = Number(x.size())
      for (i = 0; i < n; i++) out.push(x.get(i))
    } catch (err) {
      return null
    }
    return out
  }

  // ---------------------------------------------------------------------------------------------
  // Genome codec

  function zeros(n) {
    var a = []
    var i
    for (i = 0; i < n; i++) a.push(0)
    return a
  }

  function unhex(s) {
    var str
    var g = []
    var i
    if (s === null || s === undefined) return null
    str = String(s).toLowerCase()
    if (str.length !== 56 || !HEX56.test(str)) return null
    for (i = 0; i < 56; i += 4) g.push(parseInt(str.substring(i, i + 4), 16))
    return g
  }

  // number[14] of integers 0..65535 from an array (JS or Java) or a 56-hex string; null if malformed.
  function toG(x) {
    var a
    var g = []
    var i
    var v
    if (x === null || x === undefined) return null
    if (isStr(x)) return unhex(x)
    a = toArr(x)
    if (!a) return unhex(String(x))
    if (a.length !== G) return null
    for (i = 0; i < G; i++) {
      v = Number(a[i])
      if (!(v > 0)) v = 0
      if (v > Q) v = Q
      g.push(Math.floor(v + 0.5))
    }
    return g
  }

  // 56 hex characters of a valid u16 genome (byte table; the string is cached on pool, queue and sample entries).
  function hexRaw(a) {
    return HEXB[a[0] >>> 8] + HEXB[a[0] & 255] + HEXB[a[1] >>> 8] + HEXB[a[1] & 255] + HEXB[a[2] >>> 8] + HEXB[a[2] & 255] +
      HEXB[a[3] >>> 8] + HEXB[a[3] & 255] + HEXB[a[4] >>> 8] + HEXB[a[4] & 255] + HEXB[a[5] >>> 8] + HEXB[a[5] & 255] +
      HEXB[a[6] >>> 8] + HEXB[a[6] & 255] + HEXB[a[7] >>> 8] + HEXB[a[7] & 255] + HEXB[a[8] >>> 8] + HEXB[a[8] & 255] +
      HEXB[a[9] >>> 8] + HEXB[a[9] & 255] + HEXB[a[10] >>> 8] + HEXB[a[10] & 255] + HEXB[a[11] >>> 8] + HEXB[a[11] & 255] +
      HEXB[a[12] >>> 8] + HEXB[a[12] & 255] + HEXB[a[13] >>> 8] + HEXB[a[13] & 255]
  }

  function hex(g) {
    return hexRaw(toG(g) || zeros(G))
  }

  function clade(g) {
    var a = toG(g)
    if (!a) return 0
    return Math.floor(a[I_MOR] * 4 / 65536)
  }

  function randomGenome(rng) {
    var g = []
    var i
    for (i = 0; i < G; i++) g.push(rng.u32() & 0xffff)
    return g
  }

  function copyG(g) {
    var c = []
    var i
    for (i = 0; i < G; i++) c.push(g[i])
    return c
  }

  // Integer L1 distance of two u16 genomes, unrolled (it is the inner loop of crowding and sharing).
  function sumAbs(a, b) {
    var s
    var x
    x = a[0] - b[0]
    s = x < 0 ? -x : x
    x = a[1] - b[1]
    s += x < 0 ? -x : x
    x = a[2] - b[2]
    s += x < 0 ? -x : x
    x = a[3] - b[3]
    s += x < 0 ? -x : x
    x = a[4] - b[4]
    s += x < 0 ? -x : x
    x = a[5] - b[5]
    s += x < 0 ? -x : x
    x = a[6] - b[6]
    s += x < 0 ? -x : x
    x = a[7] - b[7]
    s += x < 0 ? -x : x
    x = a[8] - b[8]
    s += x < 0 ? -x : x
    x = a[9] - b[9]
    s += x < 0 ? -x : x
    x = a[10] - b[10]
    s += x < 0 ? -x : x
    x = a[11] - b[11]
    s += x < 0 ? -x : x
    x = a[12] - b[12]
    s += x < 0 ? -x : x
    x = a[13] - b[13]
    s += x < 0 ? -x : x
    return s
  }

  // Sharing kernel max(0, 1 - (L1 / sigma_share)^2) as an integer in 2^-20 steps (exact sums).
  function kern(d) {
    var l = d / GQ
    var r
    if (!(l < SIGMA_SHARE)) return 0
    r = l / SIGMA_SHARE
    return Math.floor((1 - r * r) * KS + 0.5)
  }

  // mutate(norm(g), rng, sigma, pm), quantised back to u16.
  function mutateG(g, rng, sigma, pm) {
    var c = []
    var j
    var v
    for (j = 0; j < G; j++) {
      v = g[j] / Q
      if (rng.next() < pm) v = clamp01(v + sigma * rng.gauss())
      c.push(quant1(v))
    }
    return c
  }

  // BLX-0.3 in [0,1] space with the per-gene mutation of TDD 3.3.1, quantised back to u16.
  function blxChild(a, b, rng, sigma, pm) {
    var c = []
    var j
    var x
    var y
    var lo
    var hi
    var span
    var v
    for (j = 0; j < G; j++) {
      x = a[j] / Q
      y = b[j] / Q
      if (x < y) {
        lo = x
        hi = y
      } else {
        lo = y
        hi = x
      }
      span = hi - lo
      v = clamp01(lo - BLX_A * span + rng.next() * BLX_W * span)
      if (rng.next() < pm) v = clamp01(v + sigma * rng.gauss())
      c.push(quant1(v))
    }
    return c
  }

  function tournament(sel, k, rng) {
    var n = sel.length
    var best = Math.floor(rng.next() * n)
    var i
    var c
    for (i = 1; i < k; i++) {
      c = Math.floor(rng.next() * n)
      if (sel[c] > sel[best] || (sel[c] === sel[best] && c < best)) best = c
    }
    return best
  }

  // ---------------------------------------------------------------------------------------------
  // Species mask, budget and expression (TDD 3.1, 3.3.1 expressWith, 3.6)

  function mask(speciesId) {
    var m = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1]
    var id = (speciesId === null || speciesId === undefined) ? '' : String(speciesId)
    if (NO_DMG[id] === 1) m[I_DMG] = 0
    return m
  }

  function toMask(m) {
    var a = toArr(m)
    var out = []
    var i
    if (!a || a.length !== G) return mask('')
    for (i = 0; i < G; i++) out.push(Number(a[i]) >= 0.5 ? 1 : 0)
    return out
  }

  function maskInt(m) {
    var v = 0
    var i
    for (i = G - 1; i >= 0; i--) v = v * 2 + (m[i] ? 1 : 0)
    return v
  }

  function maskOf(v) {
    var m = []
    var i
    var x = v
    for (i = 0; i < G; i++) {
      m.push(x % 2)
      x = Math.floor(x / 2)
    }
    return m
  }

  function budget(stage, gov, graceNear) {
    var s = Number(stage)
    var v = Number(gov)
    if (!(s > 0)) s = 0
    if (s > 10) s = 10
    s = Math.floor(s)
    if (gov === null || gov === undefined || !(v > 0 && v <= 2)) v = 1
    return (3.0 + 0.35 * s) * v * (truthy(graceNear) ? 0.7 : 1)
  }

  function capPair(e, a, b, cap) {
    var p = e[a] * e[b]
    if (p > cap) {
      if (e[a] >= e[b]) e[b] = cap / e[a]
      else e[a] = cap / e[b]
    }
  }

  // e = mask * raw * min(1, B / max(sum(COST_MC * mask * raw), 1e-9)), then the combo caps.
  function expressRaw(a, mk, B) {
    var e = []
    var denom = 0
    var scale
    var i
    if (!(B > 0)) return zeros(G)
    for (i = 0; i < G; i++) denom += COST_MC[i] * mk[i] * (a[i] / Q)
    if (denom < 1e-9) denom = 1e-9
    scale = B / denom
    if (!(scale < 1)) scale = 1
    for (i = 0; i < G; i++) e.push(mk[i] ? (a[i] / Q) * scale : 0)
    capPair(e, I_SIL, I_DMG, 0.36)
    capPair(e, I_SPD, I_ARM, 0.40)
    return e
  }

  function express(g, m, B) {
    var a = toG(g)
    if (!a) return zeros(G)
    return expressRaw(a, toMask(m), Number(B))
  }

  function counterScore(e, t) {
    var row = COUNTERS[t]
    var s = 0
    var i
    for (i = 0; i < row.length; i++) s += row[i][1] * e[row[i][0]]
    return s
  }

  // ---------------------------------------------------------------------------------------------
  // State

  function newState(seed32) {
    return {
      seed: Number(seed32) >>> 0,
      pool: [],
      queue: [],
      births: 0,
      joins: 0,
      gen: 0,
      dawns: 0,
      seq: 0,
      gsteps: 0,
      dslices: 0,
      sigma: 0.08,
      pm: c6(1 / 14),
      hyper: 0,
      stall: 0,
      bestEver: -1,
      dayBest: -1,
      gov: 1,
      lastShift: -100,
      pin: 0,
      tinit: 0,
      fast: [0.2, 0.2, 0.2, 0.2, 0.2],
      slow: [0.2, 0.2, 0.2, 0.2, 0.2],
      test: [0.2, 0.2, 0.2, 0.2, 0.2],
      ep: 0,
      base: {},
      baseN: 0,
      clock: 0,
      bh: null,
      bt: null,
      cow: null,
      cowN: 0,
      se: [],
      sh: [],
      sf: [],
      shead: 0,
      gram: zeros(120),
      gy: zeros(15),
      dream: null,
      ev: [],
      evc: 0,
      C: null
    }
  }

  function logEv(st, code, fields) {
    var s
    st.seq++
    s = code + '|' + st.seq + (fields.length ? '|' + fields.join('|') : '')
    st.ev.push(s)
    st.evc += s.length + 1
    while (st.evc > LOG_CHARS && st.ev.length > 1) st.evc -= st.ev.shift().length + 1
    return s
  }

  // A GA-generated genome id ('b' bred, 'j' linked or cloned, 'd' dreamed): the code, the counter and, once HIVE has
  // declared a load epoch (epoch()), '.' and that epoch. The counters roll back with the state when a save is loaded
  // again (/reload, a crash), so without the epoch a new genome could reuse the id of a mob still in the world (or of
  // a parent named in its pne_gp) and take its lineage credit.
  function gid(st, code, k) {
    return st.ep > 0 ? code + k + '.' + st.ep : code + k
  }

  function poolMean(st) {
    var P = st.pool
    var s = 0
    var i
    for (i = 0; i < P.length; i++) s += P[i].f
    return P.length ? s / P.length : 0
  }

  function shrunk(f, n, prior) {
    return (n * f + K0 * prior) / (n + K0)
  }

  function estimates(st) {
    var P = st.pool
    var prior = poolMean(st)
    var out = []
    var i
    for (i = 0; i < P.length; i++) out.push(shrunk(P[i].f, P[i].n, prior))
    return out
  }

  // ---------------------------------------------------------------------------------------------
  // Sharing-denominator cache (the M3 entry criterion). D holds integer L1 sums, K the integer kernels,
  // m the per-entry denominators; all exact, so incremental updates equal a rebuild from scratch.

  function cacheBuild(st) {
    var P = st.pool
    var n = P.length
    var D = zeros(CAP * CAP)
    var K = zeros(CAP * CAP)
    var m = zeros(CAP)
    var i
    var j
    var d
    var k
    var s
    for (i = 0; i < n; i++) {
      K[i * CAP + i] = KS
      for (j = i + 1; j < n; j++) {
        d = sumAbs(P[i].g, P[j].g)
        k = kern(d)
        D[i * CAP + j] = d
        D[j * CAP + i] = d
        K[i * CAP + j] = k
        K[j * CAP + i] = k
      }
    }
    for (i = 0; i < n; i++) {
      s = 0
      for (j = 0; j < n; j++) s += K[i * CAP + j]
      m[i] = s
    }
    st.C = { n: n, D: D, K: K, m: m }
    return st.C
  }

  function cacheGet(st) {
    return (st.C && st.C.n === st.pool.length) ? st.C : cacheBuild(st)
  }

  // Entry k was replaced (k < C.n) or appended (k === C.n); drow[j] = sumAbs(new g, pool[j].g) for j != k.
  function cacheRow(st, k, drow) {
    var C = st.C
    var n = st.pool.length
    var j
    var d
    var nk
    var old
    var s = 0
    if (!C) return
    if (k > C.n || (k === C.n && n !== C.n + 1) || (k < C.n && n !== C.n)) {
      st.C = null
      return
    }
    for (j = 0; j < n; j++) {
      if (j === k) continue
      d = drow[j]
      nk = kern(d)
      old = k < C.n ? C.K[k * CAP + j] : 0
      C.D[k * CAP + j] = d
      C.D[j * CAP + k] = d
      C.K[k * CAP + j] = nk
      C.K[j * CAP + k] = nk
      C.m[j] += nk - old
    }
    C.D[k * CAP + k] = 0
    C.K[k * CAP + k] = KS
    for (j = 0; j < n; j++) s += C.K[k * CAP + j]
    C.m[k] = s
    C.n = n
  }

  function meanL1(st) {
    var n = st.pool.length
    var C
    var s = 0
    var i
    var j
    if (n < 2) return 0
    C = cacheGet(st)
    for (i = 0; i < n; i++) for (j = i + 1; j < n; j++) s += C.D[i * CAP + j]
    return s / (n * (n - 1) / 2) / GQ
  }

  // ---------------------------------------------------------------------------------------------
  // Breeding (TDD 3.3.1 breedOne, mutantClone)

  function breedOne(st) {
    var k = st.births
    var rng = rngFor(st, TAG_HIVE, k)
    var P = st.pool
    var n = P.length
    var C
    var est
    var sel = []
    var i
    var a
    var b
    var g
    var parents = []
    st.births = k + 1
    if (n < 4) {
      g = mutateG(randomGenome(rng), rng, st.sigma, 1)
    } else if (st.hyper > 0 && rng.next() < 0.10) {
      g = randomGenome(rng)
    } else {
      C = cacheGet(st)
      est = estimates(st)
      for (i = 0; i < n; i++) sel.push(est[i] * KS / C.m[i])
      a = tournament(sel, TOUR_K, rng)
      b = tournament(sel, TOUR_K, rng)
      g = blxChild(P[a].g, P[b].g, rng, st.sigma, st.pm)
      parents.push(P[a].id)
      if (P[b].id !== P[a].id) parents.push(P[b].id)
    }
    return { id: gid(st, 'b', k), g: g, parents: parents }
  }

  function mutantClone(st, rng) {
    var P = st.pool
    var p
    if (!P.length) return { g: mutateG(randomGenome(rng), rng, st.sigma, 1), parents: [] }
    p = tournament(estimates(st), TOUR_K, rng)
    return { g: mutateG(P[p].g, rng, st.sigma, st.pm), parents: [P[p].id] }
  }

  // ---------------------------------------------------------------------------------------------
  // Insertion (TDD 3.3.1 insertCrowding, insertDreamed)

  function insertCrowding(st, c, fc) {
    var P = st.pool
    var n = P.length
    var i
    var j
    var en
    var hit
    var drow = []
    var best = -1
    var bd = 2 * GQ
    var d
    var prior
    for (i = 0; i < n; i++) {
      en = P[i]
      en.age++
      if (en.age > 4 * CAP) en.f = c6(en.f * 0.995)
      hit = false
      for (j = 0; j < c.parents.length; j++) if (c.parents[j] === en.id) hit = true
      if (hit) {
        en.n = en.n + 1 > NMAX ? NMAX : en.n + 1
        en.f = c6(en.f + (fc - en.f) / en.n)
      }
    }
    for (i = 0; i < n; i++) {
      d = sumAbs(c.g, P[i].g)
      drow.push(d)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    if (n < CAP) {
      P.push({ id: c.id, g: c.g, h: c.h, f: fc, n: 1, age: 0, dr: 0 })
      cacheRow(st, n, drow)
      return true
    }
    prior = poolMean(st)
    if (shrunk(fc, 1, prior) > shrunk(P[best].f, P[best].n, prior)) {
      P[best] = { id: c.id, g: c.g, h: c.h, f: fc, n: 1, age: 0, dr: 0 }
      cacheRow(st, best, drow)
      return true
    }
    return false
  }

  function insertDreamed(st, g, fpred) {
    var P = st.pool
    var id = gid(st, 'd', st.births)
    var i
    var d
    var best = -1
    var bd = 2 * GQ
    var prior
    var drow
    st.births++
    for (i = 0; i < P.length; i++) {
      if (!(P[i].dr || P[i].n <= 1)) continue
      d = sumAbs(g, P[i].g)
      if (d < bd) {
        bd = d
        best = i
      }
    }
    if (best < 0) return false
    prior = poolMean(st)
    if (!(shrunk(fpred, 0.5, prior) > shrunk(P[best].f, P[best].n, prior))) return false
    drow = []
    for (i = 0; i < P.length; i++) drow.push(i === best ? 0 : sumAbs(g, P[i].g))
    P[best] = { id: id, g: g, h: hexRaw(g), f: fpred, n: 0.5, age: 0, dr: 1 }
    cacheRow(st, best, drow)
    return true
  }

  // ---------------------------------------------------------------------------------------------
  // Context baselines (TDD 3.2): running mean for 20 samples, then EMA 0.05; LRU-capped at 512 contexts.
  // The entries also form a doubly linked list in recency order (st.bh least, st.bt most recently used; t is the clock
  // of the last use, so the list is sorted by t): eviction takes the head in O(1), and save() lists the contexts in
  // LRU order by walking the list instead of sorting 512 keys. While an incremental save is running (st.cow, see
  // saveBegin), the first change of an entry keeps its old values in e.co (copy on write) for that save.

  function baseGet(st, ctx) {
    var b = st.base['k' + ctx]
    return b === undefined ? null : b
  }

  function baseUnlink(st, e) {
    if (e.pv !== null) e.pv.nx = e.nx
    else st.bh = e.nx
    if (e.nx !== null) e.nx.pv = e.pv
    else st.bt = e.pv
    e.pv = null
    e.nx = null
  }

  function baseAppend(st, e) {
    e.pv = st.bt
    e.nx = null
    if (st.bt !== null) st.bt.nx = e
    else st.bh = e
    st.bt = e
  }

  function baseNew(st, key, dmg, eng, team, n) {
    var e = { key: key, dmg: dmg, eng: eng, team: team, n: n, t: st.clock, pv: null, nx: null, cw: 0, co: null }
    st.base[key] = e
    baseAppend(st, e)
    st.baseN++
    return e
  }

  function learn(st, ctx, tel) {
    var key = 'k' + ctx
    var b = st.base[key]
    var a
    var old
    st.clock++
    if (b === undefined) {
      if (st.baseN >= BASE_MAX) {
        // the least recently used context goes (an entry an incremental save still lists keeps its values: an evicted
        // entry is never changed again)
        old = st.bh
        baseUnlink(st, old)
        delete st.base[old.key]
        st.baseN--
      }
      baseNew(st, key, tel.dmg, tel.eng, tel.team, 1)
      return
    }
    if (st.cow !== null && b.cw !== st.cow.id) {
      b.co = [b.dmg, b.eng, b.team, b.n]
      b.cw = st.cow.id
    }
    a = b.n < 20 ? 1 / (b.n + 1) : 0.05
    b.dmg = c6(b.dmg + a * (tel.dmg - b.dmg))
    b.eng = c6(b.eng + a * (tel.eng - b.eng))
    b.team = c6(b.team + a * (tel.team - b.team))
    b.n = b.n < 1000000000 ? b.n + 1 : b.n
    b.t = st.clock
    if (b !== st.bt) {
      baseUnlink(st, b)
      baseAppend(st, b)
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Fitness (TDD 3.2)

  function ratio(x, m, floor) {
    var v = x / (m > floor ? m : floor)
    if (!(v > 0)) v = 0
    if (v > 3) v = 3
    return v / 3
  }

  // tel: canonical doubles { dmg, eng, loc, kill, team, fast, cheese }; e: canonical expression.
  function fitCore(st, tel, ctx, e, lambda) {
    var b = baseGet(st, ctx)
    var bd = b ? b.dmg : 4
    var be = b ? b.eng : 15
    var bt = b ? b.team : 4
    var F
    var s = 0
    var t
    if (tel.cheese) return 0
    F = 0.30 * ratio(tel.dmg, bd, 0.5) + 0.15 * ratio(tel.eng, be, 2) + 0.20 * tel.loc +
      0.25 * tel.kill * (tel.fast ? 0.5 : 1) + 0.10 * ratio(tel.team, bt, 0.5)
    for (t = 0; t < 5; t++) s += st.test[t] * counterScore(e, t)
    // F and the tactic term are both in [0, 1] by construction; the clamp only guards a hostile e (it keeps every
    // stored fitness inside the range that load() accepts).
    return c6(clamp01((1 - lambda) * F + lambda * s))
  }

  // Canonical integer form of an outcome record (the I event payload); null if the genome is malformed.
  function canonRec(rec) {
    var g
    var ea
    var e = []
    var tq = []
    var tel
    var parents = []
    var pa
    var i
    var v
    if (!rec) return null
    g = toG(rec.g)
    if (!g) return null
    ea = toArr(rec.e)
    for (i = 0; i < G; i++) e.push(ea && ea.length === G ? q6(clamp01(Number(ea[i]))) : 0)
    tel = rec.tel || {}
    tq.push(q6(Math.min(TEL_MAX[0], Math.max(0, Number(tel.dmg) || 0))))
    tq.push(q6(Math.min(TEL_MAX[1], Math.max(0, Number(tel.engagedSec) || 0))))
    tq.push(q6(clamp01(Number(tel.located) || (truthy(tel.located) ? 1 : 0))))
    tq.push(q6(clamp01(Number(tel.killShare) || 0)))
    tq.push(q6(Math.min(TEL_MAX[4], Math.max(0, Number(tel.teamPressure) || 0))))
    tq.push(truthy(tel.fastKill) ? 1000000 : 0)
    tq.push(truthy(tel.cheese) ? 1000000 : 0)
    pa = toArr(rec.parents)
    if (!pa) pa = rec.parents ? String(rec.parents).split(',') : []
    for (i = 0; i < pa.length; i++) {
      v = String(pa[i])
      if (v.length) parents.push(safeStr(v, 40))
    }
    return { id: safeStr(rec.id, 40), g: g, parents: parents, ctx: safeStr(rec.ctx, 64), e: e, t: tq }
  }

  function telOf(tq) {
    return { dmg: tq[0] / 1e6, eng: tq[1] / 1e6, loc: tq[2] / 1e6, kill: tq[3] / 1e6, team: tq[4] / 1e6, fast: tq[5] > 0, cheese: tq[6] > 0 }
  }

  function eOf(eq) {
    var e = []
    var i
    for (i = 0; i < G; i++) e.push(eq[i] / 1e6)
    return e
  }

  // ---------------------------------------------------------------------------------------------
  // Samples ring (400) and its exact integer Gram matrix for the ridge surrogate

  // Adds (sign 1) or removes (sign -1) one sample's x x^T and x f, with x = [e (u16), 1]; upper triangle, row order.
  function gramAdd(st, e, fq, sign) {
    var gm = st.gram
    var gy = st.gy
    var i
    var j
    var p = 0
    var xi
    for (i = 0; i < 15; i++) {
      xi = i < 14 ? sign * e[i] : sign
      for (j = i; j < 14; j++) {
        gm[p] += xi * e[j]
        p++
      }
      gm[p] += xi
      p++
      gy[i] += xi * fq
    }
  }

  function pushSample(st, e, fq, h) {
    if (st.se.length < RING) {
      st.se.push(e)
      st.sh.push(h)
      st.sf.push(fq)
    } else {
      gramAdd(st, st.se[st.shead], st.sf[st.shead], -1)
      st.se[st.shead] = e
      st.sh[st.shead] = h
      st.sf[st.shead] = fq
      st.shead = (st.shead + 1) % RING
    }
    gramAdd(st, e, fq, 1)
  }

  function clearSamples(st) {
    st.se = []
    st.sh = []
    st.sf = []
    st.shead = 0
    st.gram = zeros(120)
    st.gy = zeros(15)
  }

  // Ridge regression f ~ w . [e, 1] (lambda 1.0), Gaussian elimination with partial pivoting.
  function ridge(st) {
    var M = 15
    var A = []
    var y = []
    var w = []
    var i
    var j
    var r
    var p = 0
    var piv
    var tmp
    var fct
    var sum
    var qq = Q * Q
    for (i = 0; i < M; i++) {
      A.push(zeros(M))
      y.push(0)
    }
    for (i = 0; i < M; i++) {
      for (j = i; j < M; j++) {
        if (i < 14 && j < 14) A[i][j] = st.gram[p] / qq
        else if (i < 14) A[i][j] = st.gram[p] / Q
        else A[i][j] = st.gram[p]
        A[j][i] = A[i][j]
        p++
      }
      y[i] = i < 14 ? st.gy[i] / (Q * 1e6) : st.gy[i] / 1e6
    }
    for (i = 0; i < M; i++) A[i][i] += 1.0
    for (i = 0; i < M; i++) {
      piv = i
      for (r = i + 1; r < M; r++) if (Math.abs(A[r][i]) > Math.abs(A[piv][i])) piv = r
      tmp = A[i]
      A[i] = A[piv]
      A[piv] = tmp
      tmp = y[i]
      y[i] = y[piv]
      y[piv] = tmp
      for (r = i + 1; r < M; r++) {
        fct = A[r][i] / A[i][i]
        for (j = i; j < M; j++) A[r][j] -= fct * A[i][j]
        y[r] -= fct * y[i]
      }
    }
    for (i = 0; i < M; i++) w.push(0)
    for (i = M - 1; i >= 0; i--) {
      sum = y[i]
      for (j = i + 1; j < M; j++) sum -= A[i][j] * w[j]
      w[i] = q9(sum / A[i][i]) / 1e9
    }
    return w
  }

  function predict(w, e) {
    var s = w[14]
    var i
    for (i = 0; i < G; i++) s += w[i] * e[i]
    return s
  }

  // ---------------------------------------------------------------------------------------------
  // Generational step shared by the dawn dream (sliced) and the batch simulator (TDD 3.3.1 nextGeneration)

  function genElites(pop, sc) {
    var order = []
    var el = []
    var i
    var j
    var ok
    for (i = 0; i < pop.length; i++) order.push(i)
    order.sort(function (a, b) {
      return (sc[b] - sc[a]) || (a - b)
    })
    for (i = 0; i < order.length && el.length < 2; i++) {
      ok = true
      for (j = 0; j < el.length; j++) if (sumAbs(pop[order[i]], pop[el[j]]) / GQ < ELITE_MIN) ok = false
      if (ok) el.push(order[i])
    }
    return el
  }

  // x = derived data of one generation: { sc, el, K (P*P integer kernels), done (pairs), ci, cj, sel }
  function genPairs(pop, x, upto) {
    var P = pop.length
    var k
    while (x.done < upto && x.ci < P - 1) {
      k = kern(sumAbs(pop[x.ci], pop[x.cj]))
      x.K[x.ci * P + x.cj] = k
      x.K[x.cj * P + x.ci] = k
      x.done++
      x.cj++
      if (x.cj >= P) {
        x.ci++
        x.cj = x.ci + 1
      }
    }
  }

  function genSel(pop, x) {
    var P = pop.length
    var i
    var j
    var m
    var s
    if (x.sel) return x.sel
    genPairs(pop, x, P * (P - 1) / 2)
    x.sel = []
    for (i = 0; i < P; i++) {
      m = 0
      for (j = 0; j < P; j++) m += i === j ? KS : x.K[i * P + j]
      s = x.sc[i] > 0 ? x.sc[i] : 0
      x.sel.push(s * KS / m)
    }
    return x.sel
  }

  function genDerived(pop, sc) {
    var P = pop.length
    return { sc: sc, el: genElites(pop, sc), K: zeros(P * P), done: 0, ci: 0, cj: 1, sel: null }
  }

  function genChild(pop, x, c, nImm, rng, sigma, pm) {
    var a
    var b
    if (c < x.el.length) return copyG(pop[x.el[c]])
    if (c < x.el.length + nImm) return randomGenome(rng)
    genSel(pop, x)
    a = tournament(x.sel, TOUR_K, rng)
    b = tournament(x.sel, TOUR_K, rng)
    return blxChild(pop[a], pop[b], rng, sigma, pm)
  }

  // ---------------------------------------------------------------------------------------------
  // Dawn dream (TDD 3.3.1 dawnDream), sliced so that no slice costs more than about 1 ms in Rhino. Each of the
  // 5 generations runs as ceil(P / 16) score steps, 1 elite step, ceil(pairs / 150) sharing-distance steps,
  // 1 sharing step and ceil(P / 8) steps of 8 children (19 steps for P = 48); the final population is then offered
  // through insertDreamed, 4 per slice (12 slices), so a dream over a full pool takes 107 slices. mask and B are
  // taken at the first step of each generation (and of the insert phase) and kept in the dream state. Derived data
  // (scores, elites, kernels, sharing) is not persisted: after a reload it is rebuilt from the population, which
  // gives the same numbers, so a resumed dream ends exactly like an uninterrupted one.

  function dreamPlan(P) {
    var nS = Math.ceil(P / DREAM_SCORE)
    var nP = Math.ceil(P * (P - 1) / 2 / DREAM_PAIRS)
    var nC = Math.ceil(P / DREAM_KIDS)
    return { nS: nS, eS: nS, p0: nS + 1, nP: nP, sS: nS + 1 + nP, total: nS + 2 + nP + nC }
  }

  function dreamScores(dr, x, upto) {
    var mk = maskOf(dr.mk)
    var B = dr.bq / 1e6
    while (x.sc.length < upto) x.sc.push(predict(dr.w, expressRaw(dr.pop[x.sc.length], mk, B)))
  }

  // Derived data that the earlier steps of the current generation produced (rebuilt after a reload).
  function dreamEnsure(st) {
    var dr = st.dream
    var P = dr.pop.length
    var pl = dreamPlan(P)
    var x
    if (!dr.x) dr.x = { sc: [], el: null, K: null, done: 0, ci: 0, cj: 1, sel: null }
    x = dr.x
    if (dr.sub > 0) dreamScores(dr, x, Math.min(P, dr.sub * DREAM_SCORE))
    if (dr.sub > pl.eS && !x.el) {
      x.el = genElites(dr.pop, x.sc)
      x.K = zeros(P * P)
    }
    if (dr.sub > pl.p0) genPairs(dr.pop, x, Math.min(P * (P - 1) / 2, (dr.sub - pl.p0) * DREAM_PAIRS))
    if (dr.sub > pl.sS) genSel(dr.pop, x)
    return x
  }

  function dreamStep(st, mk, bq) {
    var dr = st.dream
    var rng = rngFor(st, TAG_DREAM, st.dslices)
    var P = dr.pop.length
    var pl = dreamPlan(P)
    var x
    var c
    var end
    var e
    var pr
    var done = false
    if (dr.ph === 0) {
      if (dr.sub === 0) {
        dr.mk = mk
        dr.bq = bq
        dr.ni = st.hyper > 0 ? Math.floor(0.1 * P) : 0
        dr.x = null
      }
      x = dreamEnsure(st)
      if (dr.sub < pl.nS) {
        dreamScores(dr, x, Math.min(P, (dr.sub + 1) * DREAM_SCORE))
      } else if (dr.sub === pl.eS) {
        x.el = genElites(dr.pop, x.sc)
        x.K = zeros(P * P)
      } else if (dr.sub < pl.sS) {
        genPairs(dr.pop, x, Math.min(P * (P - 1) / 2, (dr.sub - pl.p0 + 1) * DREAM_PAIRS))
      } else if (dr.sub === pl.sS) {
        genSel(dr.pop, x)
      } else {
        end = Math.min(P, dr.next.length + DREAM_KIDS)
        for (c = dr.next.length; c < end; c++) dr.next.push(genChild(dr.pop, x, c, dr.ni, rng, DREAM_SIGMA, st.pm))
      }
      dr.sub++
      if (dr.sub >= pl.total) {
        dr.pop = dr.next
        dr.next = []
        dr.x = null
        dr.gen++
        dr.sub = 0
        if (dr.gen >= DREAM_GENS) {
          dr.ph = 1
          dr.ins = 0
        }
      }
    } else {
      if (dr.sub === 0) {
        dr.mk = mk
        dr.bq = bq
      }
      end = Math.min(P, dr.ins + DREAM_INS)
      for (c = dr.ins; c < end; c++) {
        e = expressRaw(dr.pop[c], maskOf(dr.mk), dr.bq / 1e6)
        pr = predict(dr.w, e)
        if (pr > dr.fcap) pr = dr.fcap
        insertDreamed(st, dr.pop[c], c6(pr > 0 ? pr : 0))
      }
      dr.ins = end
      dr.sub++
      if (dr.ins >= P) done = true
    }
    st.dslices++
    if (done) st.dream = null
    return done
  }

  function dreamSchedule(st) {
    var pop = []
    var fcap = 0
    var i
    for (i = 0; i < st.pool.length; i++) pop.push(copyG(st.pool[i].g))
    for (i = 0; i < st.sf.length; i++) if (st.sf[i] / 1e6 > fcap) fcap = st.sf[i] / 1e6
    st.dream = { ph: 0, gen: 0, sub: 0, mk: maskInt(mask('')), bq: 0, ni: 0, ins: 0, fcap: c6(fcap), w: ridge(st), pop: pop, next: [], x: null }
  }

  // ---------------------------------------------------------------------------------------------
  // Tactic profile (TDD 3.2 T_est): floor 0.10 then renormalise (water-filling), change <= 0.10 L1 per dawn.

  function floorRenorm(v) {
    var fixed = [0, 0, 0, 0, 0]
    var changed = true
    var it
    var i
    var nf
    var free
    var sum
    for (it = 0; it < 6 && changed; it++) {
      changed = false
      nf = 0
      sum = 0
      for (i = 0; i < 5; i++) {
        if (fixed[i]) nf++
        else sum += v[i]
      }
      free = 1 - T_FLOOR * nf
      for (i = 0; i < 5; i++) {
        if (fixed[i]) continue
        v[i] = sum > 0 ? v[i] * free / sum : free / (5 - nf)
      }
      for (i = 0; i < 5; i++) {
        if (!fixed[i] && v[i] < T_FLOOR) {
          fixed[i] = 1
          v[i] = T_FLOOR
          changed = true
        }
      }
    }
    return v
  }

  function l1t(a, b) {
    var s = 0
    var i
    for (i = 0; i < 5; i++) s += Math.abs(a[i] - b[i])
    return s
  }

  // ---------------------------------------------------------------------------------------------
  // Runtime (each call logs its replay event)

  function breed(st) {
    var ch
    if (st.queue.length >= QUEUE_MAX) return false
    ch = breedOne(st)
    ch.h = hexRaw(ch.g)
    st.queue.push(ch)
    logEv(st, 'B', [st.births])
    return true
  }

  function linkOf(link) {
    var g
    if (link === null || link === undefined || link === false) return null
    g = toG(link.g)
    if (!g) return null
    return { id: safeStr(link.id, 40), g: g }
  }

  function join(st, link) {
    var k = st.joins
    var rng = rngFor(st, TAG_JOIN, k)
    var L = linkOf(link)
    var ch
    var src
    var q
    st.joins = k + 1
    if (L) {
      ch = { id: gid(st, 'j', k), g: mutateG(L.g, rng, st.sigma, st.pm), parents: [L.id] }
      ch.h = hexRaw(ch.g)
      src = 'L'
    } else if (st.queue.length) {
      q = st.queue.shift()
      logEv(st, 'P', [st.births, q.id])
      ch = q
      src = 'P'
    } else {
      q = mutantClone(st, rng)
      ch = { id: gid(st, 'j', k), g: q.g, h: hexRaw(q.g), parents: q.parents }
      src = 'C'
    }
    logEv(st, 'J', [st.joins, src, L ? L.id : '-', L ? hexRaw(L.g) : '-', ch.id, ch.h])
    return { g: copyG(ch.g), hex: ch.h, id: ch.id, parents: ch.parents.join(',') }
  }

  function outcomeC(st, cr) {
    var e = eOf(cr.e)
    var tel = telOf(cr.t)
    var f = fitCore(st, tel, cr.ctx, e, LAMBDA_LIVE)
    var fq = q6(f)
    var se = []
    var h = hexRaw(cr.g)
    var i
    if (fq < 0) {
      fq = 0
      f = 0
    }
    learn(st, cr.ctx, tel)
    for (i = 0; i < G; i++) se.push(quant1(e[i]))
    pushSample(st, se, fq, hexRaw(se))
    insertCrowding(st, { id: cr.id, g: cr.g, h: h, parents: cr.parents }, f)
    st.gen++
    if (f > st.dayBest) st.dayBest = f
    logEv(st, 'I', [st.gen, cr.id, h, cr.parents.join(','), cr.ctx, cr.e.join(','), cr.t.join(','), fq])
    return f
  }

  function outcome(st, rec) {
    var cr = canonRec(rec)
    if (!cr) return 0
    return outcomeC(st, cr)
  }

  function dawnC(st, dq, tq6, tdq, stage) {
    var T
    var rel
    var sum = 0
    var td = []
    var tn = []
    var i
    var shift
    var d
    var dream = false
    st.dawns++
    if (tq6 > 0) {
      T = tq6 / 1e6
      rel = (dq - T) / T
      if (rel > 1) rel = 1
      if (rel < -1) rel = -1
      st.gov = st.gov - 0.1 * rel
      if (st.gov < 0.6) st.gov = 0.6
      if (st.gov > 1.15) st.gov = 1.15
      st.gov = c6(st.gov)
    }
    for (i = 0; i < 5; i++) sum += tdq[i]
    if (sum > 0) {
      for (i = 0; i < 5; i++) td.push(tdq[i] / sum)
      if (!st.tinit) {
        for (i = 0; i < 5; i++) {
          st.fast[i] = c6(td[i])
          st.slow[i] = c6(td[i])
        }
        st.tinit = 1
      } else {
        for (i = 0; i < 5; i++) {
          st.fast[i] = c6(0.35 * td[i] + 0.65 * st.fast[i])
          st.slow[i] = c6(0.06 * td[i] + 0.94 * st.slow[i])
        }
      }
      for (i = 0; i < 5; i++) tn.push(st.test[i] + T_ALPHA * (td[i] - st.test[i]))
      floorRenorm(tn)
      d = l1t(tn, st.test)
      for (i = 0; i < 5; i++) {
        if (d > T_STEP) tn[i] = st.test[i] + (tn[i] - st.test[i]) * (T_STEP / d)
      }
      for (i = 0; i < 5; i++) st.test[i] = c6(tn[i])
    }
    shift = l1t(st.fast, st.slow) > 0.35 && (st.dawns - st.lastShift) > 15
    if (shift) {
      st.lastShift = st.dawns
      st.pin = 10
    }
    if (st.pin > 0) {
      st.pin--
      for (i = 0; i < 5; i++) st.slow[i] = st.fast[i]
    }
    if (st.hyper > 0) {
      st.hyper--
      if (st.hyper === 0) st.pm = c6(1 / 14)
    }
    if (st.pool.length >= 2) {
      d = meanL1(st)
      if (d < 0.10) st.sigma *= 1.25
      if (d > 0.28) st.sigma *= 0.85
    }
    if (st.dayBest >= 0) {
      if (st.dayBest > st.bestEver + 1e-9) {
        st.bestEver = st.dayBest
        st.stall = 0
      } else {
        st.stall++
      }
    }
    if (st.stall >= 8) {
      st.sigma *= 1.10
      st.stall = 0
    }
    if (st.sigma < 0.02) st.sigma = 0.02
    if (st.sigma > 0.25) st.sigma = 0.25
    st.sigma = c6(st.sigma)
    if (shift) {
      st.hyper = 6
      if (st.sigma < 0.18) st.sigma = 0.18
      st.pm = c6(2 / 14)
      clearSamples(st)
      st.bestEver = -1
    }
    st.dayBest = -1
    if (st.se.length >= DREAM_MIN_SAMPLES && st.pool.length >= DREAM_MIN_POOL) {
      dreamSchedule(st)
      dream = true
    } else {
      st.dream = null
    }
    logEv(st, 'D', [st.dawns, dq, tq6, tdq.join(','), stage, dream ? 1 : 0])
    return { dream: dream }
  }

  function dawn(st, inp) {
    var o = inp || {}
    var dv = Number(o.deaths3d)
    var tv = Number(o.target)
    var sv = Number(o.stage)
    var ta = toArr(o.tDay)
    var tdq = []
    var i
    var v
    var dq = (dv > 0 && dv < 1e6) ? Math.floor(dv + 0.5) : 0
    var tq6 = (tv > 0 && tv < 1e6) ? q6(tv) : 0
    for (i = 0; i < 5; i++) {
      v = ta && ta.length === 5 ? Number(ta[i]) : 0
      tdq.push((v > 0 && v < 1000) ? q6(v) : 0)
    }
    sv = (sv > 0) ? Math.floor(Math.min(10, sv)) : 0
    return dawnC(st, dq, tq6, tdq, sv)
  }

  function govStep(st) {
    var g = st.gov * 0.85
    st.gov = c6(g < 0.6 ? 0.6 : g)
    st.gsteps++
    logEv(st, 'G', [st.gsteps, q6(st.gov)])
    return st.gov
  }

  // E: declares the load epoch that GA-generated ids carry from now on (gid). HIVE calls it once after every load with
  // its own load counter, which it persists outside the GA state (a rollback to an older save rolls the GA's counters
  // back, not HIVE's). The epoch only grows: the new value is max(ep, current + 1), so a counter that lags (or a repeated
  // call) still gives ids never used by this state's line. Returns the epoch now in force.
  function epoch(st, ep) {
    var v = Number(ep)
    v = (v > 0 && v <= INT_MAX) ? Math.floor(v) : 0
    if (!(v > st.ep)) v = st.ep + 1
    if (v > INT_MAX) v = INT_MAX
    st.ep = v
    logEv(st, 'E', [v])
    return v
  }

  function dreamSliceC(st, mk, bq) {
    var done
    var dr = st.dream
    if (!dr) return true
    done = dreamStep(st, mk, bq)
    logEv(st, 'R', [st.dslices, st.births, mk, bq, done ? 'end' : (dr.ph + '.' + dr.gen + '.' + dr.sub)])
    return done
  }

  function dreamSlice(st, m, B) {
    var b = Number(B)
    return dreamSliceC(st, maskInt(toMask(m)), (b > 0 && b < 1000) ? q6(b) : 0)
  }

  // ---------------------------------------------------------------------------------------------
  // Batch helpers (the generational simulator of TDD 3.3.3 and the tests)

  function fitness(st, rec, lambda) {
    var cr = canonRec(rec)
    var lam = Number(lambda)
    if (!cr) return 0
    if (!(lam >= 0 && lam <= 1)) lam = LAMBDA_BATCH
    return fitCore(st, telOf(cr.t), cr.ctx, eOf(cr.e), lam)
  }

  function learnRec(st, rec) {
    var cr = canonRec(rec)
    if (cr) learn(st, cr.ctx, telOf(cr.t))
  }

  function setPool(st, genomes, fs) {
    var i
    var f
    var g
    st.pool = []
    st.dayBest = -1
    for (i = 0; i < genomes.length && i < CAP; i++) {
      f = c6(clamp01(Number(fs[i])))
      g = toG(genomes[i]) || zeros(G)
      st.pool.push({ id: 'p' + i, g: g, h: hexRaw(g), f: f, n: 1, age: 0, dr: 0 })
      if (f > st.dayBest) st.dayBest = f
    }
    st.C = null
  }

  function nextGen(st, pop, scores, counter) {
    var rng = rngFor(st, TAG_BATCH, counter)
    var P = pop.length
    var x = genDerived(pop, scores)
    var nImm = st.hyper > 0 ? Math.floor(0.1 * P) : 0
    var out = []
    var c
    for (c = 0; c < P; c++) out.push(genChild(pop, x, c, nImm, rng, st.sigma, st.pm))
    return out
  }

  // ---------------------------------------------------------------------------------------------
  // Persistence (integers and hex only)
  //
  // save(st) builds the whole saved form at once (server stop, pillar switch-off, tests). For the periodic and the dawn
  // save HIVE spreads the same work over ticks: saveBegin(st) takes a snapshot (the counters and the pool as strings, the
  // queue, sample ring and log tail as array copies, the baselines as the LRU-ordered list of their entries, whose values
  // are then kept by copy on write), savePart(ctx) returns one piece per call (pool, queue, state, each samples chunk,
  // base in slices of 64 contexts, log), and saveEnd(ctx) returns exactly what save(st) returned at saveBegin, however the
  // state changed in between. save(st) is that same code run without a pause, so both paths give identical strings.

  function poolStr(st) {
    var P = st.pool
    var out = []
    var i
    for (i = 0; i < P.length; i++) out.push(P[i].id + '|' + P[i].h + '|' + q6(P[i].f) + '|' + (P[i].n * 2) + '|' + P[i].age + '|' + P[i].dr)
    return out.join(';')
  }

  // Queue entries are never changed in place (breed pushes new ones, join shifts), so a copy of the array is a snapshot.
  function queueStrOf(q) {
    var out = []
    var i
    for (i = 0; i < q.length; i++) out.push(q[i].id + '|' + q[i].h + '|' + q[i].parents.join(','))
    return out.join(';')
  }

  function queueStr(st) {
    return queueStrOf(st.queue)
  }

  function q6list(a) {
    var out = []
    var i
    for (i = 0; i < a.length; i++) out.push(q6(a[i]))
    return out.join(',')
  }

  // The counters of the state string ('key=value' items joined by ';'); ep only once an epoch was declared, so a state
  // that never saw one saves exactly as before.
  function stateHead(st) {
    var s = ['v=' + SCHEMA, 'seq=' + st.seq, 'births=' + st.births, 'joins=' + st.joins, 'gen=' + st.gen, 'dawns=' + st.dawns,
      'gsteps=' + st.gsteps, 'dslices=' + st.dslices, 'sigma=' + q6(st.sigma), 'pm=' + q6(st.pm), 'hyper=' + st.hyper,
      'stall=' + st.stall, 'best=' + q6(st.bestEver), 'dbest=' + q6(st.dayBest), 'gov=' + q6(st.gov),
      'lshift=' + st.lastShift, 'pin=' + st.pin, 'tinit=' + st.tinit, 'fast=' + q6list(st.fast),
      'slow=' + q6list(st.slow), 'test=' + q6list(st.test)]
    if (st.ep > 0) s.push('ep=' + st.ep)
    return s.join(';')
  }

  // What the dream part of the state string needs. dr.w and dr.pop (and every genome array) are never changed in place
  // (a generation's end replaces dr.pop by dr.next and starts a new dr.next), and dr.next only grows, so a copy of the
  // scalars plus a slice of next is a snapshot.
  function dreamSnap(dr) {
    if (!dr) return null
    return { a: [dr.ph, dr.gen, dr.sub, dr.mk, dr.bq, dr.ni, dr.ins, q6(dr.fcap)], w: dr.w, pop: dr.pop, next: dr.next.slice(0) }
  }

  // Dream genomes are always valid u16 arrays, so hexRaw gives what hex() would, without its input conversion.
  function dreamStr(ds) {
    var w = []
    var ph = []
    var i
    var out
    for (i = 0; i < 15; i++) w.push(q9(ds.w[i]))
    for (i = 0; i < ds.pop.length; i++) ph.push(hexRaw(ds.pop[i]))
    out = 'dream=' + ds.a.join(',') + ';dw=' + w.join(',') + ';dpop=' + ph.join('')
    ph = []
    for (i = 0; i < ds.next.length; i++) ph.push(hexRaw(ds.next[i]))
    return out + ';dnext=' + ph.join('')
  }

  function stateOf(head, ds) {
    return ds ? head + ';' + dreamStr(ds) : head
  }

  function stateStr(st) {
    return stateOf(stateHead(st), dreamSnap(st.dream))
  }

  // The snapshot. id -1 (save) never matches an entry's copy-on-write mark; saveBegin registers a positive id.
  function saveSnap(st, id) {
    var be = []
    var e
    for (e = st.bh; e !== null; e = e.nx) be.push(e)
    return {
      pneSave: 1, id: id, st: st, k: 0, fin: false, dead: false,
      pool: poolStr(st), queue: st.queue.slice(0), head: stateHead(st), dream: dreamSnap(st.dream),
      sh: st.sh.slice(0), sf: st.sf.slice(0), sn: st.se.length, s0: st.se.length < RING ? 0 : st.shead, si: 0,
      be: be, bi: 0, ev: st.ev.slice(0),
      out: { pool: '', queue: '', state: '', samples: [], base: [], log: '' }
    }
  }

  // The next samples chunk: the ring in chronological order, entries 'hex(e)|f x 1e6' joined by ';', at most CHUNK
  // characters per chunk.
  function sampleChunk(c) {
    var cur = ''
    var item
    var i
    while (c.si < c.sn) {
      i = (c.s0 + c.si) % c.sn
      item = c.sh[i] + '|' + c.sf[i]
      if (cur.length && cur.length + 1 + item.length > CHUNK) break
      cur += (cur.length ? ';' : '') + item
      c.si++
    }
    return cur
  }

  // The next BASE_PART baselines in LRU order. v[4] is the LRU rank (0 = least recently used): HIVE stores base as a
  // CompoundTag, which gives its keys back in hash order, so the recency order travels inside the values. An entry
  // changed since the snapshot contributes the values it had then (e.co, copy on write); an entry evicted since then is
  // never changed again, so it still holds them.
  function baseSlice(c) {
    var end = c.bi + BASE_PART
    var out = []
    var i
    var e
    var o
    var b
    if (end > c.be.length) end = c.be.length
    for (i = c.bi; i < end; i++) {
      e = c.be[i]
      o = e.cw === c.id ? e.co : null
      if (o !== null) b = { k: e.key.substring(1), v: [q6(o[0]), q6(o[1]), q6(o[2]), o[3], i] }
      else b = { k: e.key.substring(1), v: [q6(e.dmg), q6(e.eng), q6(e.team), e.n, i] }
      out.push(b)
      c.out.base.push(b)
    }
    c.bi = end
    return out
  }

  // One piece: { part: 'pool' | 'queue' | 'state' | 'samples' | 'base' | 'log', i, value }, or null when nothing is
  // left. i is the chunk number for samples (HIVE's key samples.<i>) and the rank of the first context for base.
  function savePartC(c) {
    var v
    var i
    if (c.k === 0) {
      c.k = 1
      c.out.pool = c.pool
      return { part: 'pool', i: 0, value: c.out.pool }
    }
    if (c.k === 1) {
      c.k = 2
      c.out.queue = queueStrOf(c.queue)
      return { part: 'queue', i: 0, value: c.out.queue }
    }
    if (c.k === 2) {
      c.k = 3
      c.out.state = stateOf(c.head, c.dream)
      return { part: 'state', i: 0, value: c.out.state }
    }
    if (c.k === 3) {
      if (c.si < c.sn) {
        v = sampleChunk(c)
        c.out.samples.push(v)
        return { part: 'samples', i: c.out.samples.length - 1, value: v }
      }
      c.k = 4
    }
    if (c.k === 4) {
      if (c.bi < c.be.length) {
        i = c.bi
        return { part: 'base', i: i, value: baseSlice(c) }
      }
      c.k = 5
    }
    if (c.k === 5) {
      c.k = 6
      c.out.log = c.ev.join('\n')
      return { part: 'log', i: 0, value: c.out.log }
    }
    return null
  }

  function saveResult(c) {
    var o = c.out
    return { pool: o.pool, queue: o.queue, state: o.state, samples: o.samples.slice(0), base: o.base.slice(0), log: o.log }
  }

  function save(st) {
    var c = saveSnap(st, -1)
    var n = 0
    while (savePartC(c) !== null) n++
    return saveResult(c)
  }

  // Starts an incremental save and registers it for copy on write. One runs at a time: a newer saveBegin supersedes the
  // running one, which then gives null from savePart and saveEnd (its caller starts over). save() never interferes.
  function saveBegin(st) {
    var c
    if (st === null || st === undefined || typeof st !== 'object' || !st.pool || !st.base || st.cowN === undefined) return null
    st.cowN++
    c = saveSnap(st, st.cowN)
    if (st.cow !== null) st.cow.dead = true
    st.cow = c
    return c
  }

  function saveCtx(c) {
    return c !== null && c !== undefined && typeof c === 'object' && c.pneSave === 1 && !c.dead
  }

  function savePart(c) {
    if (!saveCtx(c) || c.fin) return null
    return savePartC(c)
  }

  // true when savePart has nothing left (the log is always the last piece), or the context is finished or unusable.
  function saveDone(c) {
    return !saveCtx(c) || c.fin || c.k >= 6
  }

  // Finishes the save: runs whatever parts are left (all of them when called right after saveBegin), ends the copy on
  // write and returns the same shape as save(), as of saveBegin. null for a superseded or unknown context; a second call
  // returns the result again.
  function saveEnd(c) {
    var n = 0
    if (!saveCtx(c)) return null
    if (!c.fin) {
      while (savePartC(c) !== null) n++
      c.fin = true
      if (c.st.cow === c) c.st.cow = null
    }
    return saveResult(c)
  }

  function parseG(s) {
    var g = unhex(s)
    if (!g) throw new Error('bad genome')
    return g
  }

  function parseIntS(s) {
    var v = toInt(s)
    if (v !== v) throw new Error('bad integer ' + s)
    return v
  }

  function parseList(s, n) {
    var parts = String(s).split(',')
    var out = []
    var i
    if (parts.length !== n) throw new Error('bad list')
    for (i = 0; i < n; i++) out.push(parseIntS(parts[i]))
    return out
  }

  function hexList(s) {
    var str = String(s)
    var out = []
    var i
    if (str.length % 56) throw new Error('bad genome list')
    for (i = 0; i < str.length; i += 56) out.push(parseG(str.substring(i, i + 56)))
    return out
  }

  // An integer that must lie in [lo, hi]; anything else means a corrupt or edited save (load then returns null).
  function inRange(v, lo, hi, what) {
    if (!(v >= lo && v <= hi)) throw new Error('out of range ' + what + ' ' + v)
    return v
  }

  function parseR(s, lo, hi, what) {
    return inRange(parseIntS(s), lo, hi, what)
  }

  function rangeList(a, lo, hi, what) {
    var i
    for (i = 0; i < a.length; i++) inRange(a[i], lo, hi, what)
    return a
  }

  function loadC(saved, seed32) {
    var st = newState(seed32)
    var kv = {}
    var parts
    var i
    var j
    var p
    var f
    var e
    var dl
    var dr
    var pl
    var samples
    var base
    var b
    var v
    var entries
    var w
    var rows = []
    var key
    var str = String(saved.state)
    parts = str.split(';')
    for (i = 0; i < parts.length; i++) {
      j = parts[i].indexOf('=')
      if (j > 0) kv[parts[i].substring(0, j)] = parts[i].substring(j + 1)
    }
    if (kv.v === undefined || toInt(kv.v) !== SCHEMA) return null
    // Every range below holds for any state the runtime can produce; a value outside it is a corrupt or edited save.
    st.seq = parseR(kv.seq, 0, 9e15, 'seq')
    st.births = parseR(kv.births, 0, 9e15, 'births')
    st.joins = parseR(kv.joins, 0, 9e15, 'joins')
    st.gen = parseR(kv.gen, 0, 9e15, 'gen')
    st.dawns = parseR(kv.dawns, 0, 9e15, 'dawns')
    st.gsteps = parseR(kv.gsteps, 0, 9e15, 'gsteps')
    st.dslices = parseR(kv.dslices, 0, 9e15, 'dslices')
    st.sigma = parseR(kv.sigma, 20000, 250000, 'sigma') / 1e6
    st.pm = parseR(kv.pm, 1, 1000000, 'pm') / 1e6
    st.hyper = parseR(kv.hyper, 0, 6, 'hyper')
    st.stall = parseR(kv.stall, 0, 9e15, 'stall')
    st.bestEver = parseR(kv.best, -1000000, 1000000, 'best') / 1e6
    st.dayBest = parseR(kv.dbest, -1000000, 1000000, 'dbest') / 1e6
    st.gov = parseR(kv.gov, 600000, 1150000, 'gov') / 1e6
    st.lastShift = parseR(kv.lshift, -100, 9e15, 'lshift')
    st.pin = parseR(kv.pin, 0, 10, 'pin')
    st.tinit = parseR(kv.tinit, 0, 1, 'tinit')
    st.fast = eOf5(rangeList(parseList(kv.fast, 5), 0, 1000000, 'fast'))
    st.slow = eOf5(rangeList(parseList(kv.slow, 5), 0, 1000000, 'slow'))
    st.test = eOf5(rangeList(parseList(kv.test, 5), 0, 1000000, 'test'))
    st.ep = kv.ep === undefined ? 0 : parseR(kv.ep, 0, INT_MAX, 'epoch')
    if (kv.dream !== undefined) {
      dl = parseList(kv.dream, 8)
      w = parseList(kv.dw, 15)
      dr = { ph: dl[0], gen: dl[1], sub: dl[2], mk: dl[3], bq: dl[4], ni: dl[5], ins: dl[6], fcap: dl[7] / 1e6, w: [], pop: hexList(kv.dpop), next: hexList(kv.dnext || ''), x: null }
      for (i = 0; i < 15; i++) dr.w.push(w[i] / 1e9)
      if (dr.pop.length < 2 || dr.pop.length > CAP) throw new Error('bad dream')
      pl = dreamPlan(dr.pop.length)
      inRange(dr.ph, 0, 1, 'dream phase')
      inRange(dr.gen, 0, DREAM_GENS, 'dream generation')
      inRange(dr.sub, 0, dr.ph === 0 ? pl.total - 1 : 9e15, 'dream step')
      inRange(dr.mk, 0, 16383, 'dream mask')
      inRange(dr.bq, 0, 1e9, 'dream B')
      inRange(dr.ni, 0, dr.pop.length, 'dream immigrants')
      inRange(dr.ins, 0, dr.pop.length, 'dream inserts')
      inRange(dl[7], 0, 1000000, 'dream cap')
      inRange(dr.next.length, 0, dr.pop.length, 'dream children')
      st.dream = dr
    }
    str = String(saved.pool === undefined || saved.pool === null ? '' : saved.pool)
    entries = str.length ? str.split(';') : []
    if (entries.length > CAP) throw new Error('pool too large')
    for (i = 0; i < entries.length; i++) {
      p = entries[i].split('|')
      if (p.length !== 6) throw new Error('bad pool entry')
      e = parseG(p[1])
      // f in [0, 1]; n in [0.5, NMAX] (stored x 2), age >= 0, dreamed 0/1. n = -2 would make shrunk() divide by 0.
      st.pool.push({ id: safeStr(p[0], 40), g: e, h: hexRaw(e), f: parseR(p[2], 0, 1000000, 'f') / 1e6, n: parseR(p[3], 1, 2 * NMAX, 'n') / 2,
        age: parseR(p[4], 0, 9e15, 'age'), dr: parseR(p[5], 0, 1, 'dreamed') })
    }
    str = String(saved.queue === undefined || saved.queue === null ? '' : saved.queue)
    entries = str.length ? str.split(';') : []
    if (entries.length > QUEUE_MAX) throw new Error('queue too large')
    for (i = 0; i < entries.length; i++) {
      p = entries[i].split('|')
      if (p.length !== 3) throw new Error('bad queue entry')
      e = parseG(p[1])
      st.queue.push({ id: safeStr(p[0], 40), g: e, h: hexRaw(e), parents: p[2].length ? p[2].split(',') : [] })
    }
    samples = isStr(saved.samples) ? [saved.samples] : (toArr(saved.samples) || [])
    for (i = 0; i < samples.length; i++) {
      str = String(samples[i])
      entries = str.length ? str.split(';') : []
      for (j = 0; j < entries.length; j++) {
        p = entries[j].split('|')
        if (p.length !== 2) throw new Error('bad sample')
        e = parseG(p[0])
        f = parseR(p[1], 0, 1000000, 'sample f')
        pushSample(st, e, f, hexRaw(e))
      }
    }
    // Baselines: v = [dmg, eng, team EMA x 1e6, count, LRU rank]. The recency order is rebuilt from the rank (ties
    // and rank-less 4-element values fall back to list order, then the key), never from the order of the list, which
    // for a CompoundTag is hash order.
    base = toArr(saved.base) || []
    if (base.length > BASE_MAX) throw new Error('too many baselines')
    for (i = 0; i < base.length; i++) {
      b = base[i]
      v = toArr(b.v)
      if (!v || (v.length !== 4 && v.length !== 5)) throw new Error('bad base')
      rows.push({ k: 'k' + safeStr(b.k, 64), dmg: inRange(toIntN(v[0]), 0, INT_MAX, 'base dmg'), eng: inRange(toIntN(v[1]), 0, INT_MAX, 'base eng'),
        team: inRange(toIntN(v[2]), 0, INT_MAX, 'base team'), n: inRange(toIntN(v[3]), 1, INT_MAX, 'base count'),
        r: v.length === 5 ? inRange(toIntN(v[4]), 0, INT_MAX, 'base rank') : i, i: i })
    }
    rows.sort(function (x, y) {
      return (x.r - y.r) || (x.k < y.k ? -1 : (x.k > y.k ? 1 : 0)) || (x.i - y.i)
    })
    for (i = 0; i < rows.length; i++) {
      key = rows[i].k
      if (st.base[key] !== undefined) throw new Error('duplicate baseline ' + key)
      st.clock++
      baseNew(st, key, rows[i].dmg / 1e6, rows[i].eng / 1e6, rows[i].team / 1e6, rows[i].n)
    }
    str = saved.log === undefined || saved.log === null ? '' : String(saved.log)
    entries = str.length ? str.split('\n') : []
    for (i = 0; i < entries.length; i++) {
      if (!entries[i].length) continue
      st.ev.push(entries[i])
      st.evc += entries[i].length + 1
    }
    while (st.evc > LOG_CHARS && st.ev.length > 1) st.evc -= st.ev.shift().length + 1
    // Derived data is rebuilt here, inside the one-off load (outside the token budget), so the first breed, dawn or
    // dream slice after a restart costs what it always costs instead of an O(n^2) rebuild in a budgeted tick.
    cacheBuild(st)
    if (st.dream && st.dream.ph === 0) dreamEnsure(st)
    return st
  }

  function toIntN(x) {
    var v = Number(x)
    if (!(v > -9e15 && v < 9e15)) throw new Error('bad number')
    return Math.floor(v)
  }

  function eOf5(a) {
    var out = []
    var i
    for (i = 0; i < 5; i++) out.push(a[i] / 1e6)
    return out
  }

  function load(saved, seed32) {
    if (!saved || saved.state === undefined || saved.state === null) return null
    try {
      return loadC(saved, seed32)
    } catch (err) {
      return null
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Introspection

  function hash(st) {
    var h = fnv1a(poolStr(st) + '#' + queueStr(st) + '#' + stateStr(st))
    return (h + 0x100000000).toString(16).substring(1)
  }

  function hashAll(st) {
    var sv = save(st)
    var parts = [sv.pool, sv.queue, sv.state, sv.samples.join('/')]
    var i
    for (i = 0; i < sv.base.length; i++) parts.push(sv.base[i].k + '=' + sv.base[i].v.join(','))
    return (fnv1a(parts.join('#')) + 0x100000000).toString(16).substring(1)
  }

  function apexSet(st) {
    var P = st.pool
    var est = estimates(st)
    var order = []
    var out = {}
    var k = Math.floor((P.length * 5 + 99) / 100)
    var i
    for (i = 0; i < P.length; i++) order.push(i)
    order.sort(function (a, b) {
      return (est[b] - est[a]) || (a - b)
    })
    for (i = 0; i < k && i < order.length; i++) if (P[order[i]].n >= 6) out[hex(P[order[i]].g)] = true
    return out
  }

  function evSeq(s) {
    var a = s.indexOf('|')
    var b = s.indexOf('|', a + 1)
    return toInt(b > a ? s.substring(a + 1, b) : s.substring(a + 1))
  }

  function events(st, afterSeq) {
    var out = []
    var after = Number(afterSeq) || 0
    var i
    for (i = 0; i < st.ev.length; i++) if (evSeq(st.ev[i]) > after) out.push(st.ev[i])
    return out
  }

  // ---------------------------------------------------------------------------------------------
  // Replay: events are log strings (an array or Java List of strings, or one string of any kind joined by newlines).
  // Events whose seq is already in the state are skipped (counted in st.rskip), so replay(seed, olderSave,
  // newerSave.log) also works; a line that is not an event stops the replay with rbad 1.

  function lastEv(st, back) {
    return st.ev.length > back ? st.ev[st.ev.length - 1 - back] : ''
  }

  function replayOne(st, s, p, pendingP) {
    var code = p[0]
    var link
    var parts
    var rec
    if (code === 'B') {
      breed(st)
    } else if (code === 'J') {
      link = p[5] === '-' ? null : { id: p[4], g: unhex(p[5]) }
      join(st, link)
      if (pendingP && lastEv(st, 1) !== pendingP) return 'P mismatch at ' + pendingP
    } else if (code === 'I') {
      parts = p[5].length ? p[5].split(',') : []
      rec = { id: p[3], g: parseG(p[4]), parents: parts, ctx: p[6], e: parseList(p[7], G), t: parseList(p[8], 7) }
      outcomeC(st, { id: safeStr(rec.id, 40), g: rec.g, parents: rec.parents, ctx: safeStr(rec.ctx, 64), e: rec.e, t: rec.t })
    } else if (code === 'D') {
      dawnC(st, parseIntS(p[3]), parseIntS(p[4]), parseList(p[5], 5), parseIntS(p[6]))
    } else if (code === 'G') {
      govStep(st)
    } else if (code === 'E') {
      epoch(st, parseIntS(p[2]))
    } else if (code === 'R') {
      if (!st.dream) return 'R without a pending dream at ' + s
      dreamSliceC(st, parseIntS(p[4]), parseIntS(p[5]))
    } else {
      return 'unknown event ' + s
    }
    if (lastEv(st, 0) !== s) return 'diverged at ' + s + ' (got ' + lastEv(st, 0) + ')'
    return ''
  }

  function replay(seed32, saved, events) {
    var st = saved ? load(saved, seed32) : newState(seed32)
    var list
    var i
    var s
    var p
    var sq
    var pendingP = null
    var msg
    if (!st) return null
    st.rbad = 0
    st.rmsg = ''
    st.rn = 0
    st.rskip = 0
    // A log read back from NBT or global is a java.lang.String (typeof 'object'), not a JS string: split any string
    // kind; take arrays and Java Lists element by element; anything else is read as one string (and then fails to
    // parse below instead of silently replaying nothing).
    if (events === null || events === undefined) list = []
    else list = toArr(events)
    if (!list) list = String(events).split('\n')
    for (i = 0; i < list.length; i++) {
      s = String(list[i])
      if (!s.length) continue
      p = s.split('|')
      sq = p.length > 1 ? toInt(p[1]) : NaN
      if (sq !== sq || p[0].length !== 1) {
        st.rbad++
        st.rmsg = 'unparseable event ' + s.substring(0, 80)
        break
      }
      if (!(sq > st.seq)) {
        st.rskip++
        continue
      }
      if (p[0] === 'P' && sq === st.seq + 1 && !pendingP) {
        pendingP = s
        continue
      }
      if (sq !== st.seq + (pendingP ? 2 : 1) || (pendingP && p[0] !== 'J')) {
        st.rbad++
        st.rmsg = 'gap or order error at ' + s
        break
      }
      try {
        msg = replayOne(st, s, p, pendingP)
      } catch (err) {
        msg = 'error ' + err + ' at ' + s
      }
      pendingP = null
      if (msg) {
        st.rbad++
        st.rmsg = msg
        break
      }
      st.rn++
    }
    if (!st.rbad && pendingP) {
      st.rbad++
      st.rmsg = 'dangling P ' + pendingP
    }
    return st
  }

  // ---------------------------------------------------------------------------------------------

  return {
    G: G, Q: Q, CAP: CAP, QUEUE_MAX: QUEUE_MAX, SCHEMA: SCHEMA,
    GENE_IDS: GENE_IDS, COST_MC: COST_MC, COST_GEN: COST_GEN, TACTICS: TACTICS,
    K0: K0, SIGMA_SHARE: SIGMA_SHARE, TOUR_K: TOUR_K, BLX_A: BLX_A, RING: RING,
    LAMBDA_LIVE: LAMBDA_LIVE, LAMBDA_BATCH: LAMBDA_BATCH,

    hex: hex, unhex: unhex, clade: clade,

    newState: newState, save: save, load: load,
    saveBegin: saveBegin, savePart: savePart, saveDone: saveDone, saveEnd: saveEnd, epoch: epoch,

    breed: breed, join: join, mask: mask, budget: budget, express: express, outcome: outcome,
    dawn: dawn, govStep: govStep, dreamSlice: dreamSlice,

    gov: function (st) { return st.gov },
    sigma: function (st) { return st.sigma },
    gen: function (st) { return st.gen },
    poolSize: function (st) { return st.pool.length },
    queueSize: function (st) { return st.queue.length },
    hyper: function (st) { return st.hyper },
    pm: function (st) { return st.pm },
    tEst: function (st) { return st.test.slice(0) },
    dreamPending: function (st) { return st.dream ? true : false },
    seq: function (st) { return st.seq },
    ep: function (st) { return st.ep },
    apexSet: apexSet, hash: hash, hashAll: hashAll, replay: replay, events: events,
    counterScore: counterScore, meanL1: meanL1,

    // batch simulator and tests
    fitness: fitness, learn: learnRec, setPool: setPool, nextGen: nextGen,
    prim: {
      imul32: imul32, fmix32: fmix32, fnv1a: fnv1a, mixSeed: mixSeed, Rng: Rng, kern: kern, sumAbs: sumAbs,
      rngFor: function (seed32, tag, counter) { return new Rng(mixSeed([Number(seed32) >>> 0, fnv1a(tag), counter])) },
      cacheCheck: function (st) {
        var inc = cacheGet(st)
        var inc2 = { n: inc.n, D: inc.D.slice(0), K: inc.K.slice(0), m: inc.m.slice(0) }
        var full = cacheBuild(st)
        var i
        for (i = 0; i < CAP * CAP; i++) if (inc2.D[i] !== full.D[i] || inc2.K[i] !== full.K[i]) return false
        for (i = 0; i < full.n; i++) if (inc2.m[i] !== full.m[i]) return false
        return inc2.n === full.n
      },
      dropCache: function (st) { st.C = null },
      ridge: ridge, predict: predict, floorRenorm: floorRenorm
    }
  }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = PNE_HIVE_GA
