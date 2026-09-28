# GA-CORE: the Hive Genome engine (`pne_hive_core.js`)

Module notes for `overrides/kubejs/server_scripts/pne_hive_core.js`, the single object `PNE_HIVE_GA` of
[IMPLEMENTATION.md](../IMPLEMENTATION.md) section 3.7, implementing [TDD.md](../TDD.md) 3.1-3.3 and 3.6. HIVE-RUNTIME is
the only caller. This file also holds the **replay log grammar** that section 3.7 assigns to GA-CORE.

## What the core does and does not do

- Pure ES5, priority 95, no handlers, no KubeJS binding, no Java class, no clock, no `Math.random` and no
  transcendental `Math`. The same file is `require`d by the Node tests (`module.exports` guard on the last line).
- Everything replay needs lives in the state object `st` (from `newState`, `load` or `replay`). HIVE keeps one `st`
  per world and persists `save(st)`, or the same result spread over ticks (`saveBegin` / `savePart` / `saveEnd`).
- Every runtime call (`breed`, `join`, `outcome`, `dawn`, `govStep`, `dreamSlice`, `epoch`) appends its replay event to
  `st`. HIVE reads new events with `PNE_HIVE_GA.events(st, afterSeq)` (and the current sequence number with
  `PNE_HIVE_GA.seq(st)`) if it wants to write them anywhere; it never builds event strings itself.
- The core does not know about entities, players, ticks or budgets. HIVE charges the token budget, decides what is an
  outcome (TDD 3.2 removal rules, "ever engaged"), applies k_mercy to the damage channels at the source, computes
  `tDay`, `deaths3d`, `target`, the stage and `graceNear`, and passes the species mask (`mask(typeId)`).

## API notes (shapes are fixed by IMPLEMENTATION.md 3.7; these are the semantics chosen inside them)

| Call | Notes |
| --- | --- |
| `hex(g)` / `unhex(s)` / `clade(g)` | 56 lowercase hex; `unhex` returns null unless the string is exactly 56 hex digits. `clade = floor(g[MOR] * 4 / 65536)`. Every call that takes a genome also accepts the 56-hex string or a Java array/List. |
| `newState(seed32)` | Seed is `pneCoreSeed32(server)`. Initial sigma 0.08, pm 1/14, gov 1, T_est and both tactic EMAs uniform 0.2. |
| `breed(st)` | `breedOne` (TDD 3.3.1: shrinkage K0 = 2, fitness sharing sigma 0.18 through the cache below, tournament k = 3 with the lower index winning ties, BLX-0.3 in [0,1] space with per-gene mutation, 10% immigrants while hypermutating, random mutants while the pool has < 4 entries) into the queue. Returns false (and logs nothing) when the queue holds 16. Bred ids are `b<births>` (`b<births>.<ep>` once an epoch is declared, see `epoch`). |
| `join(st, link)` | Draws `rngFor('pne_join', joins)` first (TDD order), then: a conversion link inherits `link.g` with one mutation pass (parents `[link.id]`); otherwise the **oldest** queued genome is popped (FIFO: a spawn gets a genome bred at most 16 breeds ago; measured to make no difference to alignment against LIFO); otherwise `mutantClone`. Returns `{g, hex, id, parents}` with `parents` a comma-separated string. Linked and cloned ids are `j<joins>` (`j<joins>.<ep>` with an epoch); a popped genome keeps the id it was bred with. |
| `mask(typeId)` | 1 for every gene except TEL (no Minecraft phenotype) and DMG on the 24 species without `generic.attack_damage` (TDD 3.1, registry ids read from the EPCA and Spore registries). |
| `budget(stage, gov, graceNear)` | `(3.0 + 0.35 * stage) * gov * (graceNear ? 0.7 : 1)`; stage clamped to 0..10; a missing or non-positive gov counts as 1. |
| `express(g, mask, B)` | `e = mask * raw * min(1, B / max(sum(COST_MC * mask * raw), 1e-9))`, then SIL*DMG <= 0.36 and SPD*ARM <= 0.40 by lowering the smaller gene. Masked genes express 0; `B` <= 0 or not finite gives all zeros; never NaN. |
| `outcome(st, rec)` | Fitness of TDD 3.2 with lambda 0.3: context baselines (running mean for 20 samples, then EMA 0.05, 512 contexts, least recently used evicted), `r(x) = min(x / max(base, floor), 3) / 3`, fast kill halves the kill term, cheese gives 0, blended with `sum_t T_est[t] * counterScore_t(e)` and clamped to [0, 1] (it is in [0, 1] by construction; the clamp only guards a hostile `e`). Then the sample ring (400), `insertCrowding` (aging and lineage credit, nearest neighbour replaced only if the shrunk estimate is higher) and `gen++`. Telemetry is clamped: **dmg <= 12 HP** (TDD 3.2 "capped at 12 HP per encounter"; one record is one encounter, and the core is the single place the cap is enforced, so HIVE may pass the raw sum), engagedSec <= 2000, teamPressure <= 1000, located/killShare to 0..1, so every stored EMA fits an NBT int. Unknown context: default baselines dmg 4, engaged 15 s, team 4 (as the prototype). Returns f; a malformed record returns 0 and changes nothing. Every string field may be a `java.lang.String`, `parents` a comma string or a Java List, `e` a JS array, Java array or List, numbers boxed. |
| `dawn(st, inp)` | In order: `dawns++`; governor step (skipped when `target` <= 0 or not finite); fast/slow tactic EMAs (0.35 / 0.06; the first day with data initialises both); T_est (alpha 0.206, floor 0.10 per tactic by water-filling, L1 change capped at 0.10 per dawn); shift detection (L1 fast-slow > 0.35 and more than 15 dawns since the last shift; slow pinned to fast for 10 dawns); hypermutation countdown **before** a new shift sets it; sigma from the mean pairwise L1 (x1.25 below 0.10, x0.85 above 0.28) and stall (8 days without a better day-best: x1.10), clamped to 0.02..0.25; on a shift: hyper 6, sigma >= 0.18, pm 2/14, samples cleared; then the dream is scheduled when there are >= 42 samples and >= 8 pool entries. A day without tactic data (all zero) leaves the EMAs and T_est unchanged. |
| `govStep(st)` | gov x 0.85, floor 0.6 (HIVE calls it after 2 hive-caused deaths of one player within 20 real minutes). |
| `dreamSlice(st, mask, B)` | One slice of the pending dream; returns true when the dream is finished (and true without doing anything when no dream is pending). See below. |
| `epoch(st, ep)` | Declares the load epoch: from then on every GA-generated id (`b`, `j`, and the dream's `d<births>`) carries `.<ep>`, and the state saves `ep`. The new epoch is `max(ep, current + 1)` (it only grows; a repeated call or a lagging counter still gives a new one); logs `E` and returns it. See "Load epoch". |
| `saveBegin(st)` / `savePart(ctx)` / `saveDone(ctx)` / `saveEnd(ctx)` | The incremental save (see "Persistence"): `saveBegin` returns a context (null for anything that is not a state), `savePart` returns the next piece `{part, i, value}` or null when none is left, `saveDone` says whether any piece is left, `saveEnd` returns exactly what `save(st)` returned at `saveBegin` (it runs any pieces still left) and ends the copy on write. One incremental save runs at a time: a newer `saveBegin` supersedes the running one, whose `savePart` and `saveEnd` then return null. |
| `apexSet(st)` | Hex of the entries that are in the top `ceil(5%)` of the pool by shrunk estimate **and** have n >= 6. |
| `hash(st)` | FNV-1a (8 hex) over the persisted pool, queue and state strings. `hashAll(st)` also covers samples and baselines. |
| `replay(seed32, saved, events)` | See "Replay". |

Every entry point accepts what HIVE really holds in game (IMPLEMENTATION.md F6): strings read back from NBT or `global` are
`java.lang.String` objects (`typeof` is `'object'`), numbers are boxed, NBT IntArrays are `int[]`, queues are Java Lists.
`tools/genome/test/java_values.js` checks load, replay, join, outcome, dawn, dreamSlice and the pure helpers with those
values in the real Rhino jar (part of `ga-core-replay`).

Extra functions (allowed by 3.7): `saveBegin`, `savePart`, `saveDone`, `saveEnd`, `epoch`, `ep`, `hyper`, `pm`, `tEst`,
`dreamPending`, `seq`, `events`, `counterScore`, `meanL1`, `hashAll`; `fitness`, `learn`, `setPool`, `nextGen` for the
generational simulator; `prim` (primitives for the tests).

### The sharing-denominator cache (M3 entry criterion)

The pool keeps an integer matrix of L1 sums, an integer matrix of sharing kernels `floor((1 - (L1 / 0.18)^2) * 2^20 + 0.5)`
and each entry's denominator (their row sum). An insert updates one row and column. Because every number is an integer,
the incremental result is exactly what a rebuild gives, so a reload (which rebuilds) cannot change a replay. `load` builds
the cache, so the first breed after a restart is an ordinary breed (0.12 ms p95 in the bench) instead of a 4-26 ms rebuild
inside a budgeted tick. Rhino benchmark (warm JVM, pool 48): breed + insert 0.33 ms p50 with the cache against 3.0 ms
without it (x9).

### The dawn dream, sliced

TDD 3.3.1 `dawnDream`: ridge regression `f ~ w . [e, 1]` (lambda 1.0, 15 x 15 Gaussian elimination with partial pivoting)
over the sample ring, 5 generations of `nextGeneration` from the pool genomes (sort by predicted score with an index
tie-break, 2 elites at L1 >= 0.02, 10% immigrants while hypermutating, sharing tournament, BLX, mutation sigma 0.04),
then `insertDreamed` for every final genome with the prediction capped at the best observed f (and floored at 0).
The Gram matrix of the ridge fit is kept **exactly** in integers as samples enter and leave the ring, so the dawn only
solves a 15 x 15 system (about 1 ms in Rhino).

Slices: per generation `ceil(P / 16)` score steps, 1 elite step, `ceil(P(P-1)/2 / 150)` sharing-distance steps, 1 sharing
step and `ceil(P / 8)` steps of 8 children; then 4 inserts per slice. A dream over a full pool (P = 48) takes 5 x 19 + 12 =
107 slices. mask and B are read at the first step of each generation and of the insert phase and kept in the dream state
(so they are part of the replay). `load` of a save taken mid-dream rebuilds the current generation's derived data at once,
so the first slice after a restart costs an ordinary slice. Rhino (warm JVM), per-call p95 by step type: score 0.14-0.19,
elite 0.29-0.31, pairs 0.32-0.37, share 0.40-0.56, children 0.37-0.48, insert 0.42-0.45 ms; the first slice after a
mid-dream load 0.37-0.39 ms.

`insertDreamed` follows TDD 3.3.1 literally: the dreamed genome replaces its nearest neighbour **among dreamed entries and
entries with n <= 1 only**, when `shrunk(fpred, 0.5)` beats that entry's shrunk estimate; the new entry has n = 0.5 and no
aging or lineage credit happens. Measured consequence (tools/genome/test/sweep_steady.js, 10 seeds, pool 48): live-mode
alignment with the dream is 0.461 at 3000 spawns (1,200 evaluations; 0.391 without the dream) and reaches 0.542 by 6000
spawns (0.411 without). A scratch copy with the TDD prototype's pool of 32 reached 0.495 at 3000 spawns (review measurement). The TDD's 0.615 came from a prototype whose dream inserted through ordinary crowding; with that
insert the same harness gives 0.54-0.555 at 3000 spawns, and removing only the eligibility restriction gives 0.535.
`ga-core-dream-align` gates at the TDD's measuring point (3000 spawns), so it reports **SKIP (lead decision pending)** until
the lead either relaxes the eligibility rule or amends TDD 3.3.3 / 6.3 and IMPLEMENTATION 9.4; a SKIP does not satisfy
`run_tests.py --milestone M3`.

## Replay log grammar

One event per line, fields separated by `|`. Field 2 is always `seq`, the state's event counter after the event (1, 2,
3, ...). Integers are plain base-10 (no exponent, no decimal point); genomes are 56 lowercase hex; ids and context keys
are limited to `[A-Za-z0-9_:./-]` (anything else becomes `_`; context keys are cut to 64 characters, ids to 40). The last
fields of each event are outputs, written so that a replay can check itself.

| Event | Fields after `code|seq` | Written by |
| --- | --- | --- |
| `B` | `births` (after the breed) | `breed` |
| `P` | `births`, `id` of the popped queue entry | `join`, immediately before its `J` |
| `J` | `joins` (after), `src` (`L` link, `P` popped, `C` mutantClone), `linkId` or `-`, `linkHex` or `-`, `childId`, `childHex` | `join` |
| `I` | `gen` (after), `id`, `hex`, `parents` (comma list, may be empty), `ctx`, `e` (14 comma integers, e x 1e6), `tel` (7 comma integers x 1e6: dmg, engagedSec, located, killShare, teamPressure, fastKill, cheese), `fq` (fitness x 1e6) | `outcome` |
| `D` | `dawns` (after), `deaths3d`, `target` x 1e6 (0 = no governor update), `tDay` (5 comma integers x 1e6, TACTICS order), `stage`, `dream` (1 if a dream was scheduled) | `dawn` |
| `G` | `gsteps` (after), `gov` x 1e6 | `govStep` |
| `R` | `dslices` (after), `births` (after), `mask` (14-bit integer, bit j = gene j), `B` x 1e6, `phase.gen.sub` after the slice or `end` | `dreamSlice` (one per slice) |
| `E` | `ep`, the epoch now in force | `epoch` |

Examples: `B|1|1`, `P|17|16|b0`, `J|18|1|P|-|-|b0|<56 hex>`, `G|1|1|850000`, `R|940|12|207|12287|4050000|0.3.5`, `E|5120|7`
(after which ids read `b1234.7`, `j880.7`, `d1301.7`).

Inputs are canonicalised before use (numbers become integers x 1e6, genomes become u16), and the live call computes
from the canonical values, so the logged integers are exactly what the computation used. `R` carries one event per
dream slice (not one per insert), because every slice consumes `mask` and `B`.

### Log tail and `save().log`

`st` keeps the newest events up to 45,000 characters (oldest dropped first); `save(st).log` is that tail joined by
newlines, and `load` restores it. The tail is enough to replay from any earlier snapshot whose `seq` is at least the
tail's first `seq` minus 1. With about 1,500 breeds per 5 minutes during Hive Night the tail covers the last minute or
two, not the whole time since the previous 6000-tick save; HIVE can stream `events(st, lastSeq)` elsewhere if it wants
full logs.

## Replay

`replay(seed32, saved, events)` starts from `load(saved, seed32)` (or `newState(seed32)` when `saved` is null) and applies
the events in order by calling the same runtime functions with the logged inputs. `events` is an array or Java List of
strings, or one newline-joined string of any kind: `save(newer).log` read back from NBT is a `java.lang.String`, and it
replays like a JS string. Events whose `seq` is already in the starting state are skipped (counted in `st.rskip`); the
first event must then continue the sequence exactly (a `P` is held until its `J`). After each event the regenerated
string must equal the logged one. A line that is not an event (or a non-string, non-list `events`) stops the replay with
`rbad` 1 instead of replaying nothing. The result is the replayed `st` with `st.rbad` (0 on success), `st.rmsg` (the first
problem) and `st.rn` (steps applied; a `P` and its `J` count as one); replay stops at the first gap or divergence. It
returns null only when `saved` does not load.

## Load epoch (`epoch`)

The GA's counters (`births`, `joins`) live in the state, so loading a save again (`/reload`, which reloads the last hive
save, or a restart after a crash) rolls them back, and the next genomes would get ids that genomes created after that save
already had. HIVE suffixes the ids it writes on mobs (`pne_gi`) with its own load counter, but the dream's `d<births>` ids
never pass through HIVE: they sit in the pool and reach mobs through `pne_gp` (a bred child's parents), so after a
rollback a new dreamed genome could take the lineage credit of an older one still named by mobs in the world. `epoch(st,
ep)` puts a load epoch into every id the GA generates: HIVE calls it once after each `load` with the counter it persists
outside the GA state (in `hv`, written into the stored compound at load), so each load after a rollback uses a different
epoch. The call is an `E` event, so replay reproduces it; the state saves `ep` (only once it is above 0, so older saves
and every golden are unchanged, and they load with epoch 0). With a GA epoch HIVE's own suffix is redundant (it would
read `j42.7.7`); dropping it is HIVE's call. `tools/genome/test/test_save_parts.js` loads the same save twice and runs the
same 300 actions after each: with epochs 21 and 22 the runs share no generated id, without an epoch they share all of them.

## Persistence (`save` / `load`)

All strings, integers and hex only; no floating-point text.

- `pool`: entries `id|hex|f x 1e6|n x 2|age|dreamed` joined by `;` (48 entries, about 4 KB).
- `queue`: entries `id|hex|parents` joined by `;` (parents comma-separated).
- `state`: `key=value` pairs joined by `;`: `v` (schema 1), counters (`seq`, `births`, `joins`, `gen`, `dawns`, `gsteps`,
  `dslices`), `sigma`, `pm`, `gov`, `best`, `dbest` (x 1e6), `hyper`, `stall`, `lshift`, `pin`, `tinit`, `fast`, `slow`,
  `test` (5 comma integers x 1e6), `ep` (the load epoch, only when above 0; `load` accepts 0..2^31-1); while a dream is
  pending also `dream` (phase, generation, step, mask, B x 1e6, immigrants, inserts done, cap x 1e6), `dw` (15 ridge
  weights x 1e9), `dpop` and `dnext` (concatenated hex). Under 8 KB.
- `samples`: the ring in chronological order, entries `hex(e)|f x 1e6` joined by `;`, in chunks of at most 48,000
  characters (400 entries = about 26 KB = one chunk).
- `base`: `[{k: context key, v: [dmg, engaged, team EMA x 1e6, count, LRU rank]}]` (at most 512), least recently used
  first. The rank (0 = least recently used) carries the eviction order, because HIVE stores `base` as a CompoundTag, which
  returns its keys in hash order: `load` orders the contexts by rank (then key), never by list position. A 4-element value
  (no rank) loads in list order. The TDD's `pne_hive.base` row (IntArray `[3 x EMA*1e6, count]`) gains this fifth integer.
  In memory the baselines also form a doubly linked list in recency order (each use moves the entry to the tail), so
  eviction takes the head in O(1) and a save walks the list: no 512-key comparator sort (which alone took 1.3 ms of the
  2.7 ms a save cost at the maximum state).
- `log`: the tail above.

`load` returns null for a missing state, a different schema or any malformed part (it never throws), including values the
runtime can never produce: pool `f` outside 0..1e6, `n x 2` outside 1..24, negative `age`, `dreamed` other than 0/1; `gov`
outside 0.6..1.15, `sigma` outside 0.02..0.25, `hyper` above 6, negative counters, T_est / tactic EMA entries outside
0..1e6, inconsistent dream fields; sample `f` outside 0..1e6; baselines with negative values, a count below 1, a
duplicate key or more than 512 entries. Every persisted number is kept canonical in memory as well (an integer, or an
integer / 1e6), so `save -> load -> save` is exact and a reloaded state continues exactly like the live one, including a
dream interrupted mid-way and a baseline table that is past its 512-context cap.

`load` also rebuilds the derived data (the sharing cache and, mid-dream, the current generation's scores, elites,
kernels and sharing), so HIVE should call it once in `ServerEvents.loaded` or on the first tick **outside** the token
budget. Measured in Rhino (warm JVM, `ga-core-breed-bench`): `save` 0.50 ms p95 at the bench state and 1.38-1.41 ms at the
maximum state (before the list and the snapshot code: 2.7 ms warm, 5-17 ms in a cold JVM); `load` 14-15 ms including the
Gram matrix of the 400 samples and the cache (a cold JVM at world load is slower: 20-27 ms were measured).

### The incremental save (`saveBegin` / `savePart` / `saveDone` / `saveEnd`)

`save(st)` is one call; at the maximum state (48 pool entries with 40-character ids, 16 queued, 400 samples, 512
baselines with 64-character keys, the 45,000-character log, a dream in its children phase) it was the one GA call that
did not fit a tick. The periodic save and the dawn save can instead run one piece per tick:

```
ctx = PNE_HIVE_GA.saveBegin(st)       // the snapshot (one tick)
piece = PNE_HIVE_GA.savePart(ctx)      // later ticks, one each: { part, i, value } or null when nothing is left
    // part 'pool' | 'queue' | 'state' | 'log': value is the string for that key
    // part 'samples': value is the string for samples.<i> (each at most 48,000 characters)
    // part 'base': value is [{k, v}] for at most 64 contexts, i = the LRU rank of the first (their v[4] = i, i+1, ...)
    // order: pool, queue, state, samples..., base..., log
sv = PNE_HIVE_GA.saveEnd(ctx)          // when saveDone(ctx): the same {pool, queue, state, samples, base, log} as save()
```

`saveEnd(ctx)` is exactly `save(st)` as it was at `saveBegin`, whatever `breed`, `join`, `outcome`, `dawn`, `govStep`,
`dreamSlice` or `epoch` did in between: `saveBegin` builds the counters' part of the state string and the pool string (pool
entries change in place), copies the queue array, the sample ring arrays, the log tail and the dream's scalars and
children (queue entries, genome arrays, `dr.w` and `dr.pop` never change in place), and lists the baseline entries in LRU
order; an outcome that changes a listed baseline first copies its four values into the entry for this save (copy on
write), and an evicted entry is never changed again. `save(st)` runs the same code without a pause, so the two paths give
identical strings. HIVE may write each piece into its new compound as it arrives or take everything from `saveEnd`.
A newer `saveBegin` supersedes a running one (its `savePart` / `saveEnd` return null, so HIVE starts over); `save(st)`
never interferes with a running incremental save. Nothing in the snapshot is persisted or hashed.

Measured per step at the maximum state in Rhino while the state changes between steps (`ga-core-breed-bench`, warm JVM,
60 saves): begin 0.15 / 0.19-0.21 ms (p50 / p95), pool 0.01, queue 0.02-0.03, state 0.20 / 0.23, samples 0.26 / 0.28,
base (each slice of 64) 0.10 / 0.12, log 0.02 / 0.05, end 0.01 / 0.02; a full save is 15 steps. In a barely warmed JVM
(just after building the state) every step stayed under 1.9 ms (samples, the heaviest, 1.0-1.3 ms p50). An outcome while
a save is registered costs what it costs without one (p50 0.274 against 0.276 ms at the maximum state).

## What HIVE charges against the token budget

Measured per call in the instance's Rhino jar on a warm JVM (`ga-core-breed-bench`, p95; a cold JVM in the first
minutes after start is several times slower). IMPLEMENTATION 7.3's `breed` row (2.26 ms, "breedOne + insertCrowding")
predates the API split: `breed()` only breeds, and the insert happens in `outcome()`, which HIVE calls from its leave
drain.

| Call | Where HIVE runs it | Measured p95 | Constant |
| --- | --- | --- | --- |
| `breed()` | breed tick (`t % 4 === 3`) | 0.09-0.11 ms (first breed after load 0.12) | `breed` 0.5 |
| `outcome()` | leave drain, every tick, one charge per call | 0.29-0.30 ms (0.32 at the maximum state, with or without a registered save) | `outcome` 0.33 (the core's; GA-CORE had asked 0.7 for cold-JVM margin) |
| `dreamSlice()` | dream tick (`t % 4 === 1`) | heaviest step type 0.42-0.56 ms | `dreamSlice` stays 1.5 |
| `dawn()` | dawn tick | 0.52-0.64 ms | `dawn` 1.2 |
| `save()` | server stop, pillar switch-off | 0.50 ms at the bench state, 1.38-1.41 ms at the maximum state | `gaSave` 2.0 |
| `saveBegin()` / `savePart()` / `saveEnd()` | pool-save tick (`t % 6000 === 6`) and dawn, then one step per tick | heaviest step (samples) 0.28 ms at the maximum state; begin 0.21 | new `gaSavePart` 0.4 (p95 + 30%), or `gaSave` per step |
| `join()` / `express()` | newborn drain (`newborn` 0.18 covers both) | 0.08 / 0.02 ms | unchanged |

The bench gates each call against the core's constant; `gaSavePart` does not exist yet, so the incremental save steps are gated against `gaSave`.

## Determinism

Node and the instance's Rhino jar give identical results for every golden (`tools/genome/test/golden_expected.json`):
primitives, a live API run with links, dreams and governor steps, the generational simulator and the steady-state
simulator, down to 15-digit float probes; and identical final states for 24 random interleavings of B/P/J/I/D/R/G
(`replay_golden.js`). Rules: IEEE basic operations only, 32-bit mixing through the 16-bit split multiply, FNV over an
ASCII `indexOf` table, integer sharing kernels and Gram sums, total-order comparators, sums in index order, `var` at the
top of every function, canonical persisted numbers.

## Tests (`python tools/run_tests.py --only ga-core`)

| Suite | File | What |
| --- | --- | --- |
| `ga-core-node` | `test/run_tests.js` | API shape and purity, primitives against reference implementations, codec, mask, budget, expression, breed/join/outcome/dawn/govStep/dream semantics, insertDreamed eligibility, cache parity, persistence (also mid-dream and Java-style lists), LRU order across a reload with the base list in any order (> 512 contexts), load range checks, derived data rebuilt by load, the 12 HP dmg cap, replay of every string kind, determinism (same seed identical, seed + 1 diverges), goldens |
| `ga-core-golden-rhino` | `rhino/run.py golden` | the golden digest in Node and in real Rhino against `golden_expected.json`; the guard test in Rhino |
| `ga-core-replay` | `rhino/run.py replay` | `test/replay_golden.js` in Node and in Rhino: genesis, snapshot and snapshot-plus-saved-tail replays, tamper detection, identical digest; then `test/java_values.js` in the PneRhino harness (java.lang.String logs and save strings, Java Lists, int[] and boxed numbers through load, replay, join, outcome, dawn, dreamSlice, epoch and the incremental save) |
| `ga-core-save-parts` | `rhino/run.py saveparts` | `test/test_save_parts.js` in Node and in Rhino (same digest): 24 incremental saves at the limits while a random legal driver changes the state between every two pieces, each equal to `save()` at its `saveBegin`, reassembled from its pieces, loadable to the same `hashAll`, with coverage of copy on write, evictions, overwritten samples, replaced pool entries, dawns, shifts, dream slices, epochs and links inside open saves; supersede, early `saveEnd`, `save()` in the middle, an empty state, invalid contexts; the LRU list against a reference model; the epoch (ids, `E`, load, replay, tampering, rollback uniqueness) |
| `ga-core-mercy` | `test/test_mercy.js` | test (a) over 40 paired seeds with an ablation, in the batch simulator and in the live steady-state path; dawn with target 0 |
| `ga-core-guard` | `test/test_guard.js` | test (c) and NaN safety under hostile input |
| `ga-core-adaptation` | `test/test_adapt.js` | crossover <= 3 generations in >= 18/20 seeds, shift detection, diversity >= 0.15 |
| `ga-core-governor` | `test/test_governor.js` | death rate within +-0.01 of targets 0.03 / 0.04 / 0.05, stationary run, small counts (1 and 3 deaths per 3 days, Poisson, within 25% and not pinned at the bounds), step bounds, intra-day step |
| `ga-core-dream-align` | `test/sweep_steady.js` | live-mode alignment with the dream >= 0.5 at the TDD measuring point (3000 spawns) and >= 0.05 over no dream; SKIP (exit 77, lead decision pending) while only the 0.5 gate misses |
| `ga-core-breed-bench` | `rhino/run.py bench` | per-call p95 in Rhino (warm JVM) of breed, outcome, the first breed after load, every dream step type, the first slice after a mid-dream load, dawn and save, each against the constant HIVE charges (or the requested value above); the sharing cache pays off; at the maximum state every step type of the incremental save and the one-call save against `PNE_CORE_COST.gaSave`, every incremental save equal to `save()` at its `saveBegin`, and copy on write adding at most 0.03 ms to an outcome's p50 |

`tools/genome/rhino/run.sh` is a POSIX wrapper that pins JDK 17 and calls `run.py`.
