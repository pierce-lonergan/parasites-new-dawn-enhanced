# HIVE-RUNTIME: the live Hive Genome (`pne_hive.js`, `pne_hive_events.js`)

Module notes for `overrides/kubejs/server_scripts/pne_hive.js` (priority 60) and
`overrides/kubejs/startup_scripts/pne_hive_events.js`, implementing [IMPLEMENTATION.md](../IMPLEMENTATION.md) 3.3 (with
3.4, 4 and 7 where they touch the hive) and [TDD.md](../TDD.md) 3.1-3.7 on top of `PNE_HIVE_GA`
([ga-core.md](ga-core.md)).

## Data flow

```
EntityJoinLevelEvent (startup)  -> pne_fresh = 1b on EPCA/Spore mobs not loaded from disk (cleared on chunk loads)
EntityEvents.spawned (server)   -> rejoin queue (has pne_g) or newborn queue (hive tick number, join time and place)
LivingDamageEvent (startup)     -> global.pneHiveQDamage: d / x / p records
LivingHurtEvent (startup)       -> PRJ projectile scaling (pne_prj)
EntityLeaveLevelEvent (startup) -> global.pneHiveQLeave: l records (genome mobs only)
ServerEvents.tick (server)      -> load epoch (first tick after a load), silent pass, GA save step, drains, GA work,
                                   light pass, samples, per-player step, save write steps, housekeeping
```

Every event handler is O(1) and never cancels anything (F19). The startup producers enqueue only while
`Number(global.pneOnHive) === 1` and drop records once a queue holds 4096. Every listener returns on a client level
(single player fires join/leave on the client thread too).

The startup listeners call the method names scripts see in game (F37): the game time is `level.getTime()`
(`getGameTime()` is hidden by KubeJS), the damage msgId `source.getType()` and the causing entity `source.getActual()`
(`getMsgId()` / `getEntity()` are hidden); the Mojang names are tried only as fallbacks for mocks. When no game time can
be read, the damage or leave record is skipped without an error. Each of the four listeners (join, damage, hurt, leave)
has its own breaker (first three errors logged, off after 20), so a failing damage or leave listener can never switch off
the join listener that sets `pne_fresh`, the backstop's precondition. The per-player step reads the player's yaw with
`getYaw()` (KubeJS's name for `getYRot()`), so turning in place counts as movement for the AFK rule.

### Startup record formats (`|`-separated, JS strings on both ends)

| Record | Fields | Written when |
| --- | --- | --- |
| `d` | attacker uuid, player uuid, amount x 1000, k_mercy (0/1), projectile (0/1), game time | a parasite (causing entity; the owner for projectiles) damages a player |
| `x` | player uuid, damage msgId, game time | a blow is at least the player's health (fatal) |
| `p` | mob uuid, player uuid, game time | a player hits a genome mob |
| `l` | uuid, removal reason, genome hex, genome id, x, y, z, dimension, game time, pacing (0/1), type id | a genome mob leaves the level |

`k = (hp <= 0.30 maxHp || live grace || tag pne_mercy) ? 0 : 1`, read with the pre-damage health (F21); live grace is
tag `pne_grace` with `pne_grace_until` ahead of the game time by at most 2400 ticks, exactly `pneCoreGraceLive`.

### Queues

- **Rejoin queue**: one entry per UUID (`pneHiveRejoinSet` maps the UUID to its entry). When a newer object with a queued
  UUID joins (its chunk unloaded and loaded again, or it changed dimension, before the drain), it replaces the queued
  object, so the drain always expresses and tracks the live object. The rediscovery pass after `/reload` does the same
  for an entry whose object is gone.
- **Newborn queue**: entries carry the join time (game time, kept non-decreasing, so the queue is sorted) and the join
  position and dimension. A newborn is drained once it joined in an earlier tick **and** no queued leave record can still
  be its carrier's: the leave queue is in event order, so once its head was recorded more than 2 ticks after the join,
  so were all others. While a newborn waits on leave records, up to 128 of them are drained per tick instead of 32. The
  wait is bounded at 40 ticks (a buffered removal expires by then anyway). So a conversion is linked (and never
  discarded by the backstop) even behind a backlog such as a horde-cull pass.

## Tick schedule (contract 7.2) and what is charged

| Order | Job | When | Charged |
| --- | --- | --- | --- |
| 0 | load epoch: `PNE_HIVE_GA.epoch(st, ep)` | the first hive tick after every load, before anything that can generate a genome id | - (O(1)) |
| 1 | silent pass: each silent mob every 20 ticks, every 4 while a player is within 8 blocks; then the 30% cap | every tick | `silentVisit` per visit (ash command included), `emit` per L8 tell (one per survival player within 12 blocks whose pair is due); a visit or tell that does not fit makes the mob audible |
| 2 | incremental pool save, GA half: the start (`PNE_HIVE_GA.saveBegin` + runtime string), then one `PNE_HIVE_GA.savePart` piece per step (`saveEnd` after the last) | when due (every 6000 ticks at `t%6000 === 6`, at dawn, at a switch-off, after `/pne hive prev drop`), one step per free save slot: even ticks outside slots 0 and 10; refused, retried at the next free slot | `gaSavePart` 0.4 per piece; the start `gaSavePart` + `save` (0.52: it also builds the runtime string) |
| 3 | leave records (32, or 128 while a newborn waits on them), then damage records (32) | every tick | `leaveOut` per KILLED record, `leaveOut` + `convRec` per newborn in the conversion window per DISCARDED record, `mobSample` otherwise |
| 4 | rejoins (re-expression, idempotent) | every tick, <= 12 | max(`rejoin`, 0.12) |
| 5 | newborns (joined in an earlier tick, carrier removal buffered) | every tick, <= 4 | max(`newborn`, 0.32) |
| 6 | PRC axes | as queued | 2 x `emit` |
| 7 | GA: dawn; else the tick's own job (breed on `t%4 === 3`, dream slice on `t%4 === 1`, each retried on later ticks) while no drain is pending; then outcomes on odd ticks (1, or 2 while the outcome queue is over half full) | never on slots 0 and 10 | `dawn` 1.2 (the dawn job: inputs, `PNE_HIVE_GA.dawn`, bookkeeping), `breed`, `dreamSlice`, `outcome` 0.33 |
| 8 | light aversion | `t%100 === 42` if `light_aversion`, retried | `lightPass` + 2 x `emit` per tier command |
| 9 | telemetry samples, round robin (3-block rule for silent mobs on this path too) | every tick, <= 20, with what is left | `mobSample` |
| 10 | per-player step (AFK, position history, light, tactic evidence, hive deaths), then the player's `pneHiveNear` entry | the player's telemetry slot | max(`upkeep`, 0.03), then `nearBase` + `nearRec` per record in the 3x3 grid cells |
| 11 | save, write half: 16 base IntArrays per step (up to 4 steps a tick), then the swap | every tick after `saveEnd` | max(`save`, 0.12) per step, 2 x that for the swap |
| 12 | housekeeping: conversion buffer expiry, dawn detection (slot 5), ledger pruning (slot 12) | every tick | - |

GA work runs before the samples so that a breed never shares its tick with drains (TDD 3.7); the samples take what is
left. The GA save step runs before the drains so a due save always progresses; it sits on even ticks, so it never shares
a tick with a breed (`t%4 === 3`), a dream slice (`t%4 === 1`) or the outcomes (odd ticks). The one-call save at server
stop and the load at server start run outside the budget.

**The I9 save exception is gone**: the periodic, dawn and switch-off saves are incremental (GA-CORE's
`saveBegin`/`savePart`/`saveEnd`, copy on write), one piece of at most `gaSavePart` 0.4 ms per free save slot, so no save
step claims a tick of its own, waits for DREAD/PANIC to pass, or takes the rest of the budget. At the maximum state (512
contexts, a pending dream in its children phase, the full log, 64 players seen, a full species ring) a save is the start
plus 13 pieces (pool, queue, state, 1 samples chunk, 8 base slices of 64, log), then 32 base-write steps and the swap:
about 35 ticks for the GA half (8 free slots in 20 ticks) and 9 for the write half. Only the synchronous save at server
stop is one call (`PNE_HIVE_GA.save`, 4.6-12 ms p50 at the maximum state in NbtSizeTest's barely warm JVM, outside the
budget).

### Measured costs (hive-rhino-bench)

The instance's Rhino interpreter, JDK 17, Java stand-in mobs (real reflection dispatch), the real SRG `CompoundTag` and
`AttributeModifier`, 8 players, about 500 tracked genome mobs clustered around them; p50 per unit (commands cost nothing
in the mock world; their share is charged as `emit`):

| Item | Measured p50 | Core constant | Hive charges |
| --- | --- | --- | --- |
| rejoin (re-expression) | 0.10 ms | `rejoin` 0.043 | 0.12 |
| newborn (join + expression) | 0.20 ms | `newborn` 0.18 | 0.32 |
| telemetry sample / damage record | 0.006 / 0.007 ms | `mobSample` 0.0096 | 0.0096 |
| KILLED leave record (tracked) / DISCARDED, no newborns | 0.013 / 0.007 ms | - | `leaveOut` 0.03 |
| DISCARDED with 108 newborns in its window (a 100-join burst, 4096 queued) | 0.071 ms | - | 0.03 + 108 x `convRec` 0.0007 = 0.106 |
| per-player step | 0.020 ms | `upkeep` 0.01 | 0.03 |
| `pneHiveNear` table entry (about 260 records in the cells) | 0.12 ms | - | `nearBase` 0.015 + 0.0007 per record |
| `pneHiveNear` read (director) | 0.004 ms | (in `director`) | - (O(1)) |
| silent visit (without its command) | 0.028 ms | - | `silentVisit` 0.06 (includes `emit` for the ash command) |
| outcome insert | 0.20 ms | - | `outcome` 0.33 |
| dawn job (`pneHiveDawn`: inputs, `PNE_HIVE_GA.dawn` with a pending-dream schedule, bookkeeping; full 48-entry pool) | 0.51 ms | `dawn` 1.2 | 1.2 |
| incremental save start (`saveBegin` + runtime string; maximum state and tables) | 0.37 ms | `gaSavePart` 0.4 | `gaSavePart` + `save` = 0.52 |
| one incremental save piece (`savePart`, `saveEnd` after the last; maximum state, the state changing between pieces; all piece kinds) | 0.13 ms (p90 0.24) | `gaSavePart` 0.4 | 0.4 |
| the heaviest piece, the samples chunk (maximum state) | 0.27 ms | `gaSavePart` 0.4 | 0.4 |
| one-call save: GA save + runtime string (bench state; server stop only) | 0.53 ms | `gaSave` 2.0 | outside the budget |
| save write: 16 base entries / swap | 0.09 / 0.11 ms | `save` 0.12 | 0.12 / 0.24 |
| SCT `moveTo` | not measurable offline | - | `steer` 1.0 (placeholder) |

Tick simulation (3 trials per phase; the gates use the best trial; incremental saves every 400 ticks and at each dawn in
the quiet phase): saturated drains 1.84-1.92 ms mean against 2.48 ms charged (best p90 1.94-2.02, p99 2.05-2.17);
GA-heavy quiet phase 0.64-0.81 ms mean (best p99 1.12-1.21) with breeds, dream slices, 7-10 saves and every outcome; a
mixed Hive Night phase 0.90-1.16 ms (best p99 1.44-1.69) with no outcome dropped; a 4000-deep newborn queue with 32
DISCARDED records per tick 1.29-1.37 ms mean (best p99 1.45-1.57). Charged never exceeds 2.5 ms in a tick.

`PNE_HIVE_MEASURED` in `pne_hive.js` holds these values: an item is charged the higher of its core constant and the
measured value (keys without a core constant are charged the measured value), so the shared budget stays true to the
work until the lead updates `PNE_CORE_COST`.

## Backstop (contract 3.3)

Exactly the contract's conditions, in the newborn drain before any RNG draw: `pne_fresh`, no genome, no conversion link,
no CustomName, not persistence-required, `spawn_backstop` 1, and `pneCoreNaturalMultAt(level, x, y, z, 48) === 0`. The
core formula reads the players' live positions; nothing from the hive's own 1 Hz player table (which lags a respawn, an
ender pearl or a portal by up to a second) takes part, so a fresh horde mob next to a player who has just respawned in
grace is discarded.

## Removal classification (TDD 3.2)

- `UNLOADED_TO_CHUNK`, `UNLOADED_WITH_PLAYER`, `CHANGED_DIMENSION`: no outcome, no buffering (the record only drops the
  table entry, and only when the tracked entity object is really removed: a rejoin or dimension copy may already have
  replaced it).
- pacing discard (`pne_pacing_discard`): ignored.
- `DISCARDED` with a newborn waiting within 2.5 blocks and 2 ticks: a conversion (buffered and scored). The search is a
  binary search on the sorted newborn queue plus a walk over the joins within 2 ticks (at most 256), comparing the stored
  join positions: O(log n + window) however deep the queue.
- `DISCARDED` with no survival player within 32 blocks and no engagement in the last 600 ticks: natural despawn
  (neither buffered nor scored). Player positions are read once per tick.
- any other `KILLED` / `DISCARDED`: buffered (40 ticks) for linking, and scored if the mob ever engaged.
- `pneCoreVisRemove` on every KILLED/DISCARDED genome mob that the hive tracks.

A newborn links to the nearest buffered removal in the same dimension within 2.5 blocks (of where it joined) whose
removal time is within 2 ticks of the join, at most one newborn per removal; it inherits the carrier genome mutated once
(`PNE_HIVE_GA.join(st, link)`).

## Expression (TDD 3.1)

`B = PNE_HIVE_GA.budget(stage, gov, graceNear)` with `pneCoreStage(level)` and graceNear = a survival player within 48
blocks (live positions) with a hive-caused death in the last 6000 ticks; `e = PNE_HIVE_GA.express(g, PNE_HIVE_GA.mask(type), B)`.

| Gene | Phenotype |
| --- | --- |
| SPD | `generic.movement_speed` (and `generic.flying_speed` where present) multiply_base +0.125 e |
| ACU | `generic.follow_range` +24 e, capped at 48 absolute |
| SCT | tag `pne_sct1..3` (tier floor(4e)); breadcrumb pursuit (the player's position 3 s ago, same dimension) through `Mob#getNavigation` only with config `debug` 1, at most one `moveTo` per tick |
| LUX | tag `pne_lux0..2` (tier; tier 3 immune, no tag) for the light-aversion selectors |
| FLK | tag `pne_flk` at e >= 0.5, and the expressed value itself as `HiveInfo.flk` (below) for DIRECTOR's reinforcement and ambient spawn placement in the player's rear arc (TDD 3.1); never live steering |
| SIL | Silent (`setSilent`) at e >= 0.5 for newborns while a tell can play; `pne_sil` |
| KBR | `generic.knockback_resistance` +0.5 e |
| PRJ | `pne_prj = round(1000 e)` (startup projectile scaling x (1 - 0.45 e)); graft occupancy min(4, floor(5e)) for VISUAL |
| ARM | `generic.armor` +4 e |
| PRC | `generic.attack_knockback` +0.5 e; at e >= 0.5 an iron axe in an empty main hand (`AttributeModifiers:[]`, Efficiency I at 0.65, II at 0.8, `HandDropChances` main hand 0, Spore hosts `CustomModelData:7301`) |
| HPX | `generic.max_health` multiply_base +0.5 e, permanent, check-then-add, healed once (`pne_healed`) |
| DMG | `generic.attack_damage` multiply_base +0.4 e (masked on the 24 species without the attribute) |
| TEL | none |
| MOR | clade (`PNE_HIVE_GA.clade`) for VISUAL |

Modifier UUIDs `706e6500-4869-7665-0000-0000000000NN` (NN = gene index in hex), names `pne.gene.<ID>`. Transient
modifiers are removed and re-added on every expression (idempotent); the permanent max-health modifier is never
removed. `pne_wk` marks species whose base attack damage is at least 6 (Weakness in the light-aversion rule).

### Silent gene

Silence only while the director can play a tell (`pneResTell` present, resonance on, its API breaker intact). The silent
pass runs first in the hive's tick. Each silent mob is visited every 20 ticks, every 4 while a survival player is within
8 blocks: within 3 blocks of a survival player it becomes audible for good; within 16 an ash particle (at most every 20
ticks).

**L8 tells for every survival player within 12 blocks** (the open decision, resolved): at a visit, every survival player
within 12 blocks whose (mob, player) pair was not tried in the last 100 ticks gets `pneCoreTell(mob, player)`, so each
tell goes through that player's own ledger and switches. The mob keeps a small map `player UUID -> {t, ok}` of its last
attempt per player while it is inside the 100-tick window (also while the player steps away, so leaving and coming back
never shortens the cadence); a player in range is told every 100 ticks (5 s: visits fall on multiples of 4 and 20 ticks).
A refused tell (`false`) drops Silent and `pne_sil` for good **only when no nearby player could be told**: after the
visit's tells, the mob stays silent while at least one player within 12 blocks heard a tell inside the window, and
becomes audible when every player within 12 blocks was refused (for example when the one player who heard it steps
beyond 12 blocks and the others' ledgers refuse). Fairness is a floor, not a budget item: a visit or a tell that does not
fit the budget drops Silent instead of leaving the mob silent without its tells (a visit telling n players is charged
`silentVisit` + n x `emit`). The first attack (any damage record from the mob) and a telemetry sample that finds the mob
within 3 blocks of its target also drop it. At most floor(30% of the engaged genome mobs) stay silent while engaged,
checked every tick. Switching the hive off, a tripped silent pass or a missing GA core unsilences every tracked or
rejoining silent mob.

## Telemetry and fitness inputs

dmg = k-weighted damage capped at 12 HP; engagedSec from samples with the target a player within 24 blocks; located =
the first sample whose target is a player; killShare = the mob's share of k-weighted damage to a player in the 200
ticks before that player's hive-caused death (detected from the core's `pne_hd` ring at the player's step; no credit
when the fatal blow was fall, void or /kill); fastKill = located less than 30 ticks before that death; teamPressure =
the k-weighted hive damage to the mob's target while it was engaged, divided by the genome mobs engaged on that target;
cheese = the mob died by fall, void or /kill (`pneCoreDeathCause`), or more than half of its engaged samples targeted
an AFK (60 s without moving) or non-survival player. A mob that never engaged contributes no sample. Outcome records
carry only the genome, its expression and these channels (no arousal, no player health: I2).

## `pneHiveInfo` (through `pneCoreHiveInfo`)

`{ g, clade, sil, apex, e, strain, flk }`: the contract's HiveInfo (3.3) plus **`flk`**, a number in [0, 1]: the
expressed FLK gene (`e[4]`, `PNE_HIVE_GA.GENE_IDS` index 4) exactly as the hive applied it at the mob's last expression
(budget-scaled by stage and governor, combination caps applied, 0 where the species masks it or the genome carries no FLK).
For a genome mob the hive does not track yet, the same expression is computed from its genome at the current stage. It is
the strength of the mob's flank bias (TDD 3.1: reinforcements and ambient spawns placed in the player's rear 120-degree
arc at low block light); the hive's own tag `pne_flk` marks `flk >= 0.5`. `null` (no `flk`) for a mob without a genome,
or while the hive is off, absent or cut off. The other fields are unchanged; `e` is a copy.

## `pneHiveNear`

O(1): the player's entry from the hive's per-player step (dominant clade among engaged genome mobs within 24 blocks,
ties to the lower clade; an apex genome within 24; silent-gene mobs within 12 that have not attacked). The entry is
computed and charged in HIVE's own step (by the records it scans), so the director's `director` constant only covers a
table read. An entry older than 40 ticks, or none yet, gives the neutral answer `{clade: -1, apex: false, silent: 0}`.

## Tactic evidence (T_est inputs) and dawn

Each second, for each survival player the hive is engaged on, weighted by `pneCoreGaWeight(player)` (PANIC 0.5;
RELEASE, mercy, grace 0): +w to the Oracle style bucket (`hide`/`kite`/`turtle`, fresh verdicts only), +w when the block
light at the player is >= 11, +w per light source placed (up to 3); +w to `audio` when a player hits a genome mob before
it located anyone. At dawn (overworld day index increases) `PNE_HIVE_GA.dawn` gets `deaths3d =
pneCoreHiveDeathsAll(72000)`, `target = gov_deaths x players x 3 / gov_days` (players = distinct pids seen
survival-online in the last 72000 ticks), today's evidence normalised to sum 1, and the overworld stage; the state is
saved afterwards. The dream is sliced on `t%4 === 1` with the mask of the most common species among the last 400 engaged
outcomes and B at the overworld stage.

Intra-day governor: at a player's step, a new entry in that player's `pne_hd` with `pneCoreHiveDeaths(player, 24000) >= 2`
calls `PNE_HIVE_GA.govStep` once (deaths from before the server run are history).

## Persistence (`server.persistentData.pne_hive`)

`v` (int 1), `pool`, `queue`, `state`, `log` (the GA's strings), `samples.0..n` (<= 48,000 characters each), `base`
(compound: context key -> IntArray `[dmg, engaged, team EMA x 1e6, count, LRU rank]`; the rank restores the GA's
least-recently-used order, which a CompoundTag would lose), `wid` (world id, read by ORACLE), `hv` (runtime string:
day index, load epoch `ep`, today's evidence x 1000, `pid:lastSeen` of up to 64 players, the outcome species ring), and
`prev` only while an unreadable earlier state is kept. The whole tag is built detached and swapped in with one `put`, so
an overworld autosave never sees half a state. Largest string at the maximum state: 44,819 bytes (the log tail); 9 tags
(10 with `prev`; 14 strings and a 73.6 KB compressed file with a maximum-size `prev`).

Saves: every 6000 ticks, at dawn, when the hive is switched off (by `/pne hive off` or `/pne config on_hive 0`; the off
ticks complete it, the GA state no longer changes meanwhile), after `/pne hive prev drop` and after a load that found no
readable stored state (see the load epoch below), each as an **incremental
save**: `PNE_HIVE_GA.saveBegin` and the runtime string `hv` taken at the same moment, then one `PNE_HIVE_GA.savePart`
per free save slot, then `PNE_HIVE_GA.saveEnd`, which returns exactly what `PNE_HIVE_GA.save` returned at `saveBegin`
however the state changed in between (copy on write). The result is written through the same steps as the one-call save
(detached compound, base IntArrays, one swap), so both store identical compounds (`hive-node` compares them byte for byte
on the mocks, `hive-nbt-size` with real `CompoundTag`s and NbtIo at the maximum state). A save that is superseded (a newer
`saveBegin`: `savePart`/`saveEnd` give null), that throws (counted by the `hive.save` breaker), or whose state is no
longer the live one starts over at the next free slot; nothing of it is ever written, so the stored `pne_hive` is always
a complete earlier save. A save due while one runs follows it. At server stop (`ServerEvents.unloaded`, the last save
before shutdown) the save is the synchronous one-call `PNE_HIVE_GA.save`, which abandons an incremental save still
running (its older snapshot is never written afterwards).

**Load epoch**: every load computes a new epoch, `max(persisted ep, GA state's own epoch) + 1 + salt` (`ep` persisted in
`hv`; the salt is 0..1023, the last 10 bits of a random `java.util.UUID`, none within 1024 of the 2^31 - 1 that
`PNE_HIVE_GA.load` accepts), records it in the stored compound at once, and declares it to the GA with
`PNE_HIVE_GA.epoch(st, ep)` on the first hive tick after the load, before any drain or GA work can generate an id (a load
followed by a save with no hive tick in between, such as a quick restart, round-trips the GA state unchanged). From then
on every id the GA generates carries it (`b12.3`, `j42.3`, dream inserts `d130.3`), including the ids that never pass
through HIVE. The id a mob gets (`pne_gi`) is the GA's id as it is when it carries this run's epoch; a queued child bred
before the last save keeps the id it was bred with (`b17.2`) and would be handed out again after a rollback to that save,
so it gets this run's epoch appended (`b17.2.3`), which no GA id (one dot) can equal.

When ids can and cannot repeat:
- `/reload`, and a restart after a clean stop: the load starts from a counter at or above every epoch used before, so the
  new epoch is always new and no id repeats. A load that finds no compound to record its epoch in (a fresh world, or an
  unreadable state kept whole as `prev`, which is never written) makes a save due at once; a `/reload` in the few seconds
  before that save completes starts from the same counter again, and only the salt keeps the epochs apart.
- A crash before the first world save that follows a load: KubeJS writes `server.persistentData` to disk only when the
  overworld saves (`serverLevelSaved`), while a mob's `pne_gi` reaches disk whenever its chunk unloads, so the next start
  reads the older `hv` and the GA counters roll back with the state. Unsalted, it would declare the lost run's epoch
  again and reissue that run's ids to new genomes (a mob saved by the lost run would then share its id with a different
  genome and pass it its lineage credit). Salted, the two epochs are equal only by chance: 1 in 1024 for each epoch the
  lost run declared after its last world save, and the same again for a later load while the epoch is still below the
  lost one's (a load adds about 512 on average, so rarely more than one): about 1 in 1000 in all.
- Closing the crash case entirely would need a write that reaches disk at the load itself (a file of its own, or a forced
  world save), which contract 4.1 does not provide; it is an open decision for the lead.

**Unreadable state**: when `PNE_HIVE_GA.load` rejects the saved compound (schema bump, a range check) or reading it
throws, the hive starts a fresh pool, logs an error, and keeps the old compound as `pne_hive.prev` (or, if it already
carried one, that older child: the original memory). Every later save and load carries `prev` along until an admin runs
`/pne hive prev drop`; `/pne hive prev` tells whether one is kept. Nothing is overwritten.

## `/reload` and switching

`/reload` resets module state: GA progress since the last save (<= 6000 ticks) is lost (there is no hook before the
scripts reload). Genome mobs already in the world are re-adopted by a rediscovery pass over `server.getEntities()` (64
per tick); newborns still queued at the reload stay genome-less until they rejoin. Every load declares a new load epoch
(above). Switching the hive off makes a save due (completed incrementally by the off ticks), then clears the runtime and
unsilences every tracked silent mob.

## Deviations and interpretations (reported to the lead)

- `pne_gi` (genome id) on mobs: needed for lineage credit (join returns the id, outcome needs it); not in 4.4.
- Mob tags `pne_sct1..3`, `pne_flk`, `pne_lux0..2`, `pne_wk`: not in 4.4.
- `pne_hive` keys `v`, `hv` and (only while kept) `prev`: not in 4.1.
- Light aversion uses tag selectors per lit player (`execute as <player> at @s run effect give @e[tag=pne_luxK,...]`),
  at most 6 commands per player, instead of one command per mob.
- Outcomes are charged `outcome` 0.33 (the core constant now matches the hive's measurement) and run on the odd GA ticks
  after the tick's breed or dream. The dawn job is charged `dawn`.
- The incremental save's start is charged `gaSavePart` + `save` (0.52): besides `saveBegin` it builds the runtime string
  (0.37 ms p50 together at the maximum state and tables); every piece is charged `gaSavePart`.
- Costs: the measured values above exceed the core constants for `rejoin`, `newborn`, `upkeep` and `save`, and cover
  items without a constant (`outcome`, `leaveOut`/`convRec`, `silentVisit`, `nearBase`/`nearRec`, `steer`).
- SCT steering runs only with config `debug` 1 until spark measures `moveTo` (lead request: a `hive_steer` key);
  FLK never steers live: it is the tag and `HiveInfo.flk` for DIRECTOR's spawn placement.
- L8 tells go to every survival player within 12 blocks (TDD 3.1), which resolves the open decision; contract 3.3 still
  says "for the nearest survival player" (lead request to update it).
- `HiveInfo.flk` is an extra field (allowed by contract 3; the lead adds it to the 3.3 shape).
- `/pne hive prev [drop]` (admin) is a HIVE subcommand not listed in 6.3.

## Tests (`python tools/run_tests.py --only hive`)

| Suite | File | What |
| --- | --- | --- |
| `hive-node` | `tools/hive/test_hive.js` | 233 runtime assertions on the shared mocks with the real startup listeners: queues, next-tick newborns, spawned never cancelled, backstop (before RNG; loaded-from-disk, named, persistent, far, config off, stale grace; right after a respawn and a dimension change), idempotent re-expression, permanent HP across a chunk reload, rejoin replaced by a reload while queued (also twice, and in the rediscovery pass), links, SIL tells/3-block (visit and sample path)/fast revisits/attack/cap every tick/no-director/budget fail-safe, PRC axe, PRJ scaling, telemetry and k_mercy, kill share and fall cheese, outcomes and I2, GA slots (breed and dream beside a stream of outcomes), the incremental save's schedule (one step per free save slot: even ticks outside 0 and 10, charged `gaSavePart`, retried when refused, a due save following a running one), the incremental save storing byte for byte what the one-call save stored while the GA state and runtime evidence change between its pieces, a superseded or failed save never writing and starting over, the dawn charged `dawn` (it waits with room for a breed only), player yaw through `getYaw()` (turning is movement), incremental saves on switch-off, the one-call save at stop abandoning a running incremental save, persistence round trip, kept unreadable state, load epoch (declared on the first tick after a load, GA ids used as they are, a rolled-back queued child gets the run epoch appended, a lagging persisted counter recorded in the stored `hv` at the load itself; a crash before the next world save: two starts from the same stored counter get different salted epochs, so the rolled-back counter's newborn gets a different id; the salt's bits, fallbacks and limit; a fresh world and an unreadable state make a save due at the load, and a `/reload` after it starts above its epoch; the salt is pinned to 0 elsewhere so epochs are exact), L8 tells for every survival player within 12 blocks (per-pair cadence also across leaving and coming back, Silent kept while one player could be told, dropped when none could, both refused in one visit, the charge per player told), `HiveInfo.flk` (the applied FLK, tag threshold, untracked mobs, hive off), light aversion, governor, dawn inputs, audio tactic, API shapes and the O(1) `pneHiveNear` table, steering gates, deep-queue conversion search and window charge, newborn wait on leave records, hive switch, queue caps |
| `hive-rhino` | same file in Rhino | the same with a real HashMap `global` and real ArrayList queues |
| `hive-kmercy-rhino` | `tools/hive/test_kmercy.js` | the k_mercy formula (boundary 0.30, mercy tag, live/stale/far grace), producers gated on the wrapped `global.pneOnHive`, record formats, cap, fresh-flag rules, leave records, PRJ scaling, all through the names scripts see in game (`getTime`, `getType`, `getActual`; the mocks have no hidden Mojang names), the Mojang names as mock fallbacks, records skipped without an error when no game time reads, and one breaker per listener (a tripped damage or leave listener leaves `pne_fresh`, PRJ scaling and the other records running); Rhino and Node |
| `hive-conversion-replay` | `tools/hive/test_conversion.js` | (mock levels answer only to `getTime()`, as in game) join-before-leave, leave-before-join, one-tick, three-tick, distance, dimension, despawn, pacing, one link per carrier, conversions behind leave backlogs of 100 and 300 records; GA replay from a snapshot and from genesis bit for bit; identical digest in Node and Rhino (the load epoch's salt pinned to 7: it is random in game, and `java.util.UUID` is the real class in Rhino) |
| `hive-nbt-size` | `tools/genome/test/NbtSizeTest.java` + `tools/hive/nbt_max.js` | maximum state (plus a maximum-size kept `prev`) saved by the real `pneHiveSave` into a real CompoundTag in Rhino, NbtIo write/read, every string <= 60,000 bytes, reload reproduces the GA state and carries `prev`; then an incremental save of the maximum state, the state changing between every two GA pieces, stores a compound equal to the one-call save's with identical NbtIo bytes (steps timed and printed) |
| `hive-rhino-bench` | `tools/hive/HiveBench.java` + `tools/hive/bench_world.js` | unit costs and the tick simulation above; gates: charged <= 2.5 ms every tick, measured mean <= charged mean + 0.1 and p90 <= 2.75 ms in every phase, p99 <= 3 ms (I9) in the quiet, mixed and deep phases, every gated unit case within its charge (including the dawn job against `dawn`, and at the maximum state the incremental save's start against `gaSavePart` + `save`, one save piece and the heaviest piece (samples) against `gaSavePart`), breeds/dream slices/no dropped outcome in each quiet trial, no dropped outcome in each mixed trial |

## In-game checks (M3)

See the final report of the HIVE-RUNTIME build (and of its review fixes) for the list the lead adds to
`docs/TESTING.md`.
