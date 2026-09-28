# Dread director and sound ledger (M2)

The pacing FSM, the audio intensity controller, the per-player sound ledger, the natural-spawn gate and the routing
of every `pne_horror.js` sound through the ledger: TDD 2.3.3-2.5 and 2.7, IMPLEMENTATION.md 3.2, 3.2.1, 3.4, 4, 6.3
and 7.

## Files

| File | Role |
| --- | --- |
| `overrides/kubejs/server_scripts/pne_resonance.js` (priority 70) | Pacing FSM, fusion, audio tier, pacing outputs, ledger (`pneResEmit`, `pneResEmitAt`, `pneResTell`), Resonance layers L0-L7 from `PNE_RES_CATALOG`, first-run notice, `/pne comfort`, `/pne audio`, `/pne resonance ...` |
| `overrides/kubejs/startup_scripts/pne_res_gate.js` | Natural-spawn gate on Forge `MobSpawnEvent$PositionCheck` (`setResult(DENY)`), formula of contract 3.4; game time from `level.getTime()` (F37), and with no readable time mercy and low health still gate (grace and `pne_gate` cannot; logged once as `[pne_res_gate] spawn gate failed`) |
| `overrides/kubejs/server_scripts/pne_horror.js` | Every sound through `pneCoreEmit` / `pneCoreEmitAt`; old whisper pool retired; `tag=!pne_pace_soft` in `PNE_H_SURVIVORS`; pacing multipliers on beckons and Mobs Inside; 1 Hz work on the core housekeeping slot; FLK flank placement of reinforcement beckons (below) |
| `overrides/kubejs/assets/{epca,spore}/sounds.json` | `"replace": true` volume trims (59 EPCA and 163 Spore events): every sound at <= -20 LUFS integrated and M-max <= -14. The mod's own references in its own order; only `volume` is added. No audio is copied. |
| `tools/director/director.py` | Line-for-line Python port of the pure core (parity-checked against Node and Rhino) |
| `tools/director/proto_director.py` | The measured TDD prototype FSM, vendored unchanged; the parity suite checks the shipped FSM against it |
| `tools/director/trims.py` | `measure` (reads the instance jars and vanilla assets read-only; numbers only), `build`, `check` |
| `tools/director/data/external_levels.json` | Per-file integrated and max momentary loudness, duration and LF share for every EPCA/Spore sound and the two vanilla events `pne_horror.js` plays. Integrated values equal `asset_measurements.json` (553 files, max difference 0.00 LU); M-max was added. |

## Pacing and audio

- Fusion: `w = min(1, conf / 0.45)` when the verdict is fresh (age <= 60 ticks), else 0; `e_raw = w E_O + (1 - w) S_H`;
  asymmetric EMA with the literal constants 0.3934693402873666 (tau 2 s) and 0.15351827510938587 (tau 6 s), which are
  bit-identical to the prototype's `1 - exp(-1/tau)`.
- FSM: the TDD 2.5.3 table (holds, 8 s dwell, hard triggers, PANIC only to RELEASE, 45 s cap, RELEASE 30 s or 60 s
  after the third panic in 10 min) **plus one condition the table leaves out**: RELEASE ends only while e < 0.50
  (`d.e < C.up[1]`); while e stays >= 0.50 RELEASE holds (spawn 0.2, GA 0). That is the measured prototype's rule
  (`tdd/final/cl/director.py`: `elif d['inState'] >= d['releaseLen'] and d['e'] < C['up'][1]`), so the TDD's claim
  that its table "matches the measured prototype exactly" is off by this condition (reported to the lead). Replaying
  the prototype's measured MLP trace (6 sessions, 10,710 steps) through the shipped FSM reproduces the recorded
  prototype states 10,710 / 10,710.
- Audio tier from theta only; ceilings in TDD order (e > 0.60 caps at UNEASE, RELEASE and mercy/grace force QUIET; PANIC
  is a layer override). `Pace.tier` is the capped tier.
- Audio modes: PANIC and RELEASE take precedence over mercy/grace (each override can only lower the audio), so a
  player at 30% health or in respawn grace still gets the PANIC drain (no bed, L2, L3 flutter/rough, L4 or whispers)
  and the 10 s RELEASE hush. Mercy/grace then also remove L2, L3 (the PANIC heartbeat included), L4, L6 and L7 in
  every mode. The ledger enforces the same three rules for the director's own layers from the cached Pace (refusals
  `panic_a5`, `release_hush`, `vuln_layer`), as a backstop to the scheduler.
- L0 (a) holds in every QUIET mode that plays a bed: normal, mercy/grace (muffled bed) and RELEASE after its hush all
  play the bed in runs of 2-5 segments followed by a silence of at least half the run.
- Bed segments: `bed.cur` is the class the player hears and changes only when the ledger issued the segment. A refused
  segment is retried 1 s later from the same class (so a refused `t_dry_dread` cannot let the next event jump
  dread -> muffled, A6); once the last issued segment has ended the bed counts as silent and restarts in any class.
  A vacuum's approach is scheduled 2-4 s after the segment that brought the bed to muffled was actually issued (the
  `t_*_muffled` transition, or a muffled segment when the bed was already muffled or silent), never after a refusal.
- PANIC stinger (L7): only on the first sighting in a PANIC, which needs a line-of-sight report from this tick's ORACLE
  snapshot (`hostileSeen`); probe sensing has no line of sight and never plays it. Not under mercy/grace or comfort.
- Shuffle bags (A1, A2): between two plays of one variant at least `h = max(min(4, n - 2) (>= 1), ceil(n / 2))` other
  picks of the pool (`h <= n - 1`; 6 for the 12-variant whisper pools). Each bag plays every open variant once; it is
  built so the item at index i has been out of play for >= h - i picks, which keeps the halves of the pool mixing
  (putting the recent items last in every bag would pin one half of the pool to the end of every bag).
- Pacing outputs per the TDD 2.5.5 table on Hard; mercy and grace give spawn 0, beckon false, GA 0, aggression <= 0.8
  in every profile; the hourly governor multiplies spawns by `max(floor, 1 - slope (hive deaths in the last 72000
  ticks - free))`, on Hard `max(0.5, 1 - 0.15 (deaths - 1))`. Since contract 1.5 both come from the difficulty profile
  (next section).
- Published once per second at the player's telemetry slot: the cached Pace, `pne_m` / `pne_m_t`, `pne_gate` (m < 1)
  and `pne_pace_soft` (aggression 0.8 always, 0.9 on odd 100-tick runs).
- Sensing: this tick's ORACLE snapshot when it is at most 20 ticks old, else the director's own probes: `execute if
  entity @e[type=#pne:hive|#pne:spore,distance=..R]` for R = 32, 16, 8, 4 (each charged `COST.emit`), light at the
  player, health, and `pne_lph` for the damage age. A probe the token budget refuses is missing data, not "no parasite
  near": the scan stops, the last complete reading is reused if it is at most 3 s old (`sensing probe-stale` in
  `/pne resonance status`), otherwise the step is skipped (the player waits for the next slot; `pneCorePace` falls back
  after 40 ticks and `pne_gate` expires after 100).

## Difficulty profiles (contract 1.5)

The profile id (0 Peaceful, 1 Easy, 2 Normal, 3 Hard) follows the vanilla difficulty, hardcore counts as Hard, and
`/pne config diff_profile 1-4` pins it (CORE, `pneCoreDiffId()`; a pause-menu change is seen within 1 s). The numbers
live in the core's `PNE_CORE_DIFF` table and the director reads them there. Its only copies are the Hard values it
falls back to when the core is absent (`PNE_RES_PACING` and `PNE_RES_GOV1H`, `PNE_H_DIFF_HARD`) and `director.py`'s
`PROFILES`; `director-diff` and `director-parity` hold each of them equal to the core's table.

| Where | Peaceful | Easy | Normal | Hard (release 1.4) |
| --- | --- | --- | --- | --- |
| Director spawn CALM / UNEASE / DREAD / PANIC / RELEASE | 0 everywhere | 1.00 / 0.95 / 0.65 / 0 / 0.10 | 1.10 / 1.00 / 0.75 / 0 / 0.15 | 1.25 / 1.10 / 0.80 / 0 / 0.20 |
| Aggression, beckons, GA | 0.8, none, 0 | as Hard, DREAD aggression 0.9 | as Hard | 1 1 1 0.9 0.8; on on off off off; 1 1 1 0.5 0 |
| Hourly governor floor / slope / free | none (1) | 0.40 / 0.25 / 0 | 0.45 / 0.20 / 1 | 0.50 / 0.15 / 1 |
| Night buffs (`pneHNightAggression`) | none | Speed I on EPCA within 32 | Speed I (EPCA, Spore basic) within 48; Strength I (EPCA) from overworld stage 1 | Speed I (EPCA, Spore basic) + Strength I (EPCA) within 48 |
| Mobs Inside chance / flesh share / flesh count / cap | none | 35% / 27% / 1-2 / 4 | 50% / 38% / 2-3 / 6 | 65% / 50% / 2-3 / 8 |
| Reinforcement beckon: from stage, chance, cap, cooldown | never | 4, 1% + 0.5% per stage, 4%, 400 t | 3, 1.5% + 0.75%, 6%, 200 t | 3, 2% + 1%, 9%, 100 t |
| Doom clock (lead decision L1) | no raises, no query | the Hard days | the Hard days | 6, 12, 20, 32, 48, 62, 76, 88, 96, 100 |

- `pne_resonance.js`: `pneResPaceOut(state, mercy, grace, deaths1h, P)` takes the row (`P.pace[state]`,
  `P.gov1h`); without one it uses `PNE_RES_PACING` and the 1.4 governor, which equal the Hard row. The pure step takes
  the id as an input (`inp.diff`, default 3; `pneResDiffIn` turns anything absent or outside 0..3 into 3) and looks
  the row up in `PNE_CORE_DIFF`; the live step passes `pneCoreDiffId()` and keeps it on the Pace (`Pace.diff`). So the
  natural-spawn gate follows the profile through `pne_m` (Peaceful: `pne_m` 0 near every player, so natural parasite
  spawns are denied there; `pne_res_gate.js` is unchanged).
- `pne_horror.js`: `pneHDiff()` returns the core's row (`pneCoreDiff()`), or `PNE_H_DIFF_HARD`, a local copy of the
  Hard fields it reads, when the core is absent. Every call reads it again, so a change applies at the next death,
  night run or doom-clock run. The Math.random draws keep their order; on Hard every factor is the 1.4 constant, so the
  commands and draws are the same bit for bit (lead decision L5, suite `director-diff`). Normal's Strength needs the
  overworld stage, which is read only when the row asks for it (never on Hard). Peaceful issues no night query, no
  night buff and no doom query; gore, sounds, Hive Night atmosphere and death lines stay.
- Start gating (Appendix A rule 15): the two death handlers of `pne_horror.js` return while `pneCoreStarted` is false.
  In the director the ledger refuses (`not_started`) before anything is recorded, `pneResTellraw` returns whether it
  issued the command (false before the start), the first-run notice is marked as seen only when all of its lines went
  out, and the probes and the PANIC `stopsound` are skipped until the start (they only run in the tick, after it).

## Ledger (every horror sound)

Order: per-player switches (tells ignore them), comfort (asset flags, no stingers, LF classes, comfort volumes, the
2 Hz onset rule), A8 (per-instance cap, one LF source at a time counting `spore:heart_beat` and `epca:slam`, rest 2x /
4x, rolling 10-min duty 10% / 5%, the comfort slam gap, L2/L3 suppressed for 10 s after a slam), stinger rate rules,
then three level ceilings: the level-jump limit (+10 LU / 3 s normal, +6 LU / 2 s comfort; stingers +18 LU above the
trailing 3 s short-term level, skipped below 0.3 of the requested volume), the -18 LU bus ceiling (attenuate at most
6 dB, else skip) and the Resonance-only per-minute budget (-27 / -30 LU). The volume is lowered to the tightest ceiling
or the sound is refused. L_eff follows TDD 2.3.4 with the Minecraft details: the client multiplies the command volume
by the event's `sounds.json` volume, range = `max(vol x sv, 1) x att`, distance from the eyes, and the server only
sends the sound within `16 x max(1, vol)` blocks. With the resonance pillar off only Resonance layers are refused.
A Resonance file shorter than `PNE_RES_SHORT_S` (0.6 s) enters the level-jump rule at its catalog `mmax` instead of its
`lufs` (contract 5: a file too short for an in-file rise, V15 not applicable, takes its mmax as the onset step). The
manifest's set is `tell.a` v01/v04 and `whisper.near` v06; the 0.6 s rule also covers the other tells (0.54-0.59 s,
at most 1.3 dB quieter as a result).

`pneResTell` returns false when the pillar is off or no tell asset exists (contract 3.2), and also when the ledger
cannot make the tell audible: even 0.3 of its volume would break the level-jump limit or the bus ceiling right after
a loud onset (refusals `tell_level_jump`, `tell_bus_ceiling`, `tell_attenuated`). HIVE then drops that mob's `Silent`,
so silence stays fair. This is wider than the contract's wording; reported to the lead.

The 2 s onset spacing applies to the director's own onsets only (Resonance layers after any other onset, beds
excepted). TDD 1's data-flow row says "at most 1 per 2 s per player, all sources combined", but the ledger never drops
an existing pack sound for spacing (gore slam and squish land on the same tick by design); the level-jump, bus and LF
rules still bind them. Reported to the lead as a TDD clarification ("Resonance onsets").

Design values the TDD leaves open (all in the header of `pne_resonance.js`): the -32 LU quiet floor the level-jump rule
measures from; L4, L6, DREAD-LF and PANIC-heartbeat hazards; QUIET bed runs of 2-5 segments followed by a silence of at
least half the run (L0 a); at most 2 onsets per second in comfort mode; Resonance onsets at least 2 s after any other
onset (beds excepted).

## FLK flank placement of reinforcement beckons (TDD 3.1 gene 4)

The FLK gene's Minecraft phenotype is "reinforcements and ambient spawns biased to the player's rear 120° arc at low
block light". `pne_horror.js` implements it for the one spawn a script places, the reinforcement beckon that a dying
parasite may root (`pneHReinforce`). It is a pure placement bias: FLK changes **where** a beckon stands, never
**whether** one appears.

1. Every rule of today's beckon runs first and unchanged: the 100-tick server-wide cooldown, stage 3 or higher, the
   chance roll (2% + 1% per stage above 3, at most 9%; these are the Hard numbers, and since contract 1.5 each
   profile's `beckon` row applies, see Difficulty profiles), `pneCoreBeckonAt` at the dying mob (every survival player
   within 48 blocks may have a beckon: CALM or UNEASE, not in mercy or grace) and `pneCoreSpawnCount(1, m)` with the
   scripted-spawn multiplier there (0 skips).
2. Only then is the dying mob asked for its expressed FLK, `pneCoreHiveInfo(mob).flk` (HIVE's field, 0..1: `e[4]` as
   the hive applied it). No genome, the hive off, absent or cut off, or `flk` < 0.5: today's placement.
3. The player is the nearest survival player within 64 blocks of the dying mob. The block light at that player's feet
   block (`level.getBlock(x, y, z).getBlockLight()`, the block light only, as HIVE reads it) must be at most 7, and the
   facing comes from `player.getYaw()` (KubeJS's name; `getYRot()` does not exist in game, F37, and stays only as the
   mock fallback). The rear arc is taken from that facing, not from the direction of the dying mob. An unreadable
   light or facing keeps today's placement.
4. With probability FLK (one `Math.random()` draw, made only when 2 and 3 qualify), and only when **today's chain
   would summon at the dying mob**, the beckon is moved. That last condition is asked with `pneHBeckonTest`: the same
   execute chain without its `run summon` (an `execute` whose last `if block` passes returns 1 and changes nothing;
   one command). So a kill within 24 blocks of any player, a mob dying on planks, in the air, within 32 blocks of
   another beckon or near a Hive Night horde still calls nothing, exactly as before: FLK never adds a reinforcement,
   and the director's pacing and closed-loop models keep their rate.
5. The move: at most **8 probes**, each drawing an angle within 58° of straight behind the player and a horizontal
   distance of 25-39 blocks, then taking the centre of that block column, so the spot always lies 24-40 blocks away
   and inside the rear 120°. A probe finds the ground by block reads only, within 6 blocks of the player's feet level
   and with no command: the highest non-solid block standing on a solid `#pne:beckon_ground` block
   (`BlockContainerJS.hasTag`, KubeJS's own method). A tree canopy (`#minecraft:leaves`) is passed through to the
   ground under it; any other solid surface that is not natural ground (a roof, a floor, planks) ends the search in
   that column, so no spot is looked for under a roof. If the tag cannot be read, the surface is taken and the
   chain's own `#pne:beckon_ground` test decides. The probe then checks pacing at the spot (`pneCoreBeckonAt` and
   `pneCoreSpawnMultAt` above 0), so a player near the spot who may not have a beckon, or whose multiplier is 0,
   refuses it even when they are far from the dying mob. Then it runs **the same execute chain as today** at the spot
   (`pneHBeckonCmd`: a survival player within 64, no player within 24, no Hive Night horde within 128, no beckon within
   32, replaceable feet and head, `#pne:beckon_ground` below). The first chain that summons wins.
6. If no probe summons, the beckon falls back to today's placement at the dying mob (the same chain there, which the
   test in 4 has just passed in the same tick). With `k = 2` (multiplier 1.25) the second run is the chain at the
   placed spot, which the 32-block beckon rule refuses, so at most one beckon still appears.
7. The bell and the stage-1 call sound where the beckon actually stands (through the ledger as before), so a flanking
   beckon is heard from behind. Nothing moves the camera or the player.

Cost: at most once per beckon cooldown server-wide (100 ticks on Hard, 200 on Normal, 400 on Easy): one HiveInfo, one
light read, one test command, at most 8 x 14 block reads, 8 x 14 tag reads (a surface needs a non-solid block above it,
so at most 7 surfaces per column, 2 tag reads each) and 8 chain commands, inside the death handler like today's chain.
The probe spots are at most 40 blocks (3 chunks) from a player, so their chunks should be the ones the server keeps
loaded around that player (inferred, not measured: a block read of an unloaded chunk would load it; in-game check
below). The chain's own `if block` tests fail on an unloaded position like any vanilla `execute if block`. An error in
the flank code is caught, logged at most three times, and falls back to today's placement. `pneHFlkStats` counts tests,
refused tests, plans, probes, block reads, tag reads, unreadable tags, chain commands, placements, fallbacks and errors.

**Natural and ambient spawns are not placed by this change.** Natural spawns and ambient spawns (the game's
`NaturalSpawner`, EPCA's and Spore's own spawn logic, The Hordes waves) choose their own positions, and the hooks this
pack uses can only let such a spawn through or stop it: the startup gate `pne_res_gate.js` answers Forge
`MobSpawnEvent$PositionCheck` with DENY or the default (F18), HIVE's backstop can discard a fresh newborn, and a KubeJS
`spawned` handler must never cancel a parasite (F19). There is one pre-join hook where a script could move a natural
spawn: Forge `MobSpawnEvent$FinalizeSpawn` (what `EntityEvents.checkSpawn` maps to, F17) fires with the mob before
`NaturalSpawner` adds it to the world, so a startup `ForgeEvents` handler could call `moveTo` on it there (inferred
from Forge's patched `NaturalSpawner` and F17; not tested in game, and whether EPCA's, Spore's and The Hordes' own
spawns fire it is not checked). This change does not do that: the vanilla spawn rules, the light check, the
`PositionCheck` gate and pacing have all been evaluated at the original position, and a move there would skip every
one of them at the new position. So the FLK phenotype acts on scripted reinforcement beckons only, and the TDD's
"and ambient spawns" half stays open for a lead decision.

In-game checks (for docs/TESTING.md): at stage 3 or higher, on open natural ground with no light source near your feet,
kill genome mobs that carry the hive's `pne_flk` tag (FLK >= 0.5; for example
`/execute if entity @e[tag=pne_flk,distance=..32]`) **from more than 24 blocks away** (a bow; a kill within 24 blocks
roots no beckon, with or without FLK), until a reinforcement beckon appears (on Hard up to 9% per kill, one per 100
ticks; Normal and Easy are slower, see Difficulty profiles). It should stand 24-40 blocks behind you, relative to where
you face, also when the mob died off to your side, and its bell should come from behind. Repeat facing north, east,
south and west. Next to a torch (block light 8 or more at your feet) the beckon appears where the mob died. At the edge
of a dark forest the beckon may stand on the ground under the canopy, never on the leaves; behind a building with a roof
it never stands under the roof. spark shows no chunk load on the death tick of a flanking beckon.

## Tests

| Suite | What it checks |
| --- | --- |
| `director-node` | FSM invariants on 108,000 synthetic steps (dwell, PANIC only to RELEASE, 45 s cap, spawn <= 0.2 in PANIC / RELEASE / mercy / grace), the ceiling never raises the tier and is monotone in e, Pace publication and tags, commands, notice, ledger rules (comfort Hive Night heartbeat >= 70 s apart), bags (A1 half-pool rule on every catalog pool and a 12-variant pool, bag halves keep mixing), L0 rules (vacuum before the approach, RELEASE hush), PANIC/RELEASE overrides under mercy and the ledger backstop, L0 (a) under mercy, the first-sighting stinger, refused bed segments, refused probes |
| `director-parity` | Python = Node = Rhino, every field, e bit for bit, for all 4 difficulty profiles (the input `diff`; Hard traces carry none, as in 1.4; one trace switches profile every 100 steps), and `director.py`'s `PROFILES` equals the pace and governor of the core's `PNE_CORE_DIFF`; shipped Python = TDD prototype (state, e, spawn; aggression outside grace) |
| `director-ledger-sim` | One simulated hour per mode, synthetic and generated catalogs, re-checked by an independent model built from the command text; includes the TDD 2.5.4 overrides from the pacing state at each onset (A5 in PANIC, the RELEASE hush, mercy/grace layers), the Hive Night heartbeat interval, and L0 (a) over all QUIET time and over the mercy/grace seconds alone (the player respawns at base). Follows RESONANCE's asset gate: the level-jump check uses the catalog `mmax` for the files the manifest marks V15 not applicable (and checks `PNE_RES_SHORT_S` covers them), and comfort-mode onsets of the `tdd_pins.PENDING_CE` pools (L5 phrase gating, L8 click trains) are reported as PENDING a lead decision, never as passes (the set must equal the manifest's CE pending list) |
| `director-closed-loop` | 150 players x 1 h: at a 60% natural share gated deaths/hr <= 1.10 (TDD 1.03) and at least 0.10 below the ungated run; arousal increase <= 0.04 at k = 0.3; dread audio outside encounters <= 0.01% as a raw fraction |
| `director-routing` | No `playsound` left in `pne_horror.js`; flags per call; the real file on the mocks |
| `director-flank` | The FLK flank placement on the mocks with a terrain model (block states, block light and block tags through `level.getBlock`) and an interpreter of the beckon chain as written, with and without its summon: FLK 0.8 at block light 0 over 400 deaths with facings all around the compass puts every moved beckon 24-40 blocks from the player and inside the rear 120° of `getYaw()`, at the rate FLK; the arc follows the facing, not the dying mob (mobs dying beside and behind the player, and 300 deaths with facing and bearing drawn independently); the light is read at the player's feet block (a light that differs there from everywhere else); the boundaries FLK 0.5 / light 7 (in) and draw >= FLK / light 8 (out); high light, FLK < 0.5 and FLK 0 give a command stream identical to a world without the hive (no extra random draw); no `flk`, NaN, the hive off, no readable facing or light, no survival player near: today's placement; FLK changes where, never whether: the same 270 deaths with FLK 1 and without a genome give the same beckon count death by death (a kill 3 blocks away, kills within 24 blocks, on planks, near a beckon, near a creative player, in a horde: no beckon either way); every rule binds the flank spot (planks, also with a lying or unreadable tag read, deep water, cliffs, a player within 24, a horde behind, beckons within 32, the multiplier 0 / 1.25, mercy, grace and PANIC near the spot, cooldown, stage, chance, beckon and flesh deaths); the ground search passes through a canopy to the grass below and stops at a roof; at most 8 probes, 14 block reads and 14 tag reads per probe (reached exactly by an alternating leaves column), then today's placement; the nearest survival player is the one flanked; the bell through the ledger at the spot. `PNE_FLANK_HORROR=<file>` runs it on another copy of `pne_horror.js` (when this was written, each of 32 hand-made mutants of the placement failed it, including one that takes the arc from the mob's bearing, two that read the light at the mob or the eyes, one without the test and one that only checks players within 24, and it passed under 20/20 `PNE_TEST_SEED` seeds) |
| `director-gate` | The gate formula in Rhino on a game-shaped level (`getTime()` only, F37), including `spawn_gate` 0 in `global`, stale tags, the `getGameTime()` mock fallback, and a level with no readable time (mercy and low health still deny; one logged, counted failure; the gate stays on) |
| `director-gate-parity` | The gate's multiplier equals `pneCoreNaturalMult(At)` on 9,000 random player states, its clock equals the core's, and the `PositionCheck` handler's decision equals `random >= m` on 3,000 events with `Math.random` pinned (Rhino, game-shaped level) |
| `director-rhino`, `director-horror-rhino` | Rhino smoke of `pne_resonance.js` (empty, missing and inline catalogs) and of `pne_horror.js` with the core and the director, including the FLK flank placement in real Rhino (no `Math.PI` there, F26): the spot is finite, 24-40 blocks away and inside the rear 120° of `getYaw()`, also with the mob 90° off the facing; the light is read at the player's feet block; today's placement at block light 12; a kill 3 blocks away moves nothing. Contract 1.5 in Rhino: `pneHDiff()` is the core's row, the Easy night command reads `distance=..32`, the doom floors, Peaceful issues nothing at night, the director's pacing per profile, and no horror command or tellraw before the first tick or after a `/reload` until the next |
| `director-trims` | Committed trims against the table and the jars |
| `director-diff` | Contract 1.5. **Hard is release 1.4 bit for bit**: `tools/director/diff_world.js` plays 20 minutes (24,000 ticks) of a scripted world with three players (telemetry and probe sensing, fights with mercy, deaths and respawns, a Hive Night horde, parasites of every kind dying every 17 ticks, some in the air, some with FLK, day 0 to day 110 so every doom floor is raised), and the command stream of `pne_horror.js` and `pne_resonance.js` (13,232 commands), the Pace at every 1 Hz step (3,600), `pneResPaceOut` over its grid and `pneResPureStep` over 8 traces must equal, text for text, `tools/director/fixtures/horror_hard_baseline.json`, recorded from the 1.4 scripts before editing (`record_hard_baseline.js`, which refuses to overwrite it; the 1.4 core of the last commit gives the same bytes). Also on a pinned Hard over vanilla Easy and on hardcore over vanilla Peaceful; two planted mutants must break it. Profiles 0-2 (and Hard): Mobs Inside burst, flesh-burst and product rates over 4 x 10^5 host kills at CALM within 1% of the row (spec row 4a: 0, 0.49, 1.18, 1.75; checked over 10 seeds, worst 0.43%), cap and roll boundaries; beckon chance per stage 0-13 at its exact boundary and the cooldown; the night command strings; the doom floors per day 0-200 and the day-factor rounding; the pacing table and governor per profile; the live step following the pause menu and the pin; start gating; the other profiles in the scripted world. It also checks this file: the Difficulty profiles table states the numbers of `PNE_CORE_DIFF` and the horror doom days, the API it names exists, every suite in `tools/suites/director.json` has a row in this table, and this row quotes the fixture's counts. Planted edits must fail that check: the profile section removed (as in the release 1.4 file), this row removed, one number changed (`PNE_DIFF_DOC=<file>` checks another copy of the file) |

The Node suites are deterministic: `tools/director/pack.js` gives every mock world a seeded `Math.random`, so the
random player pids (and with them the director's RNG, seeded worldSeed ^ pidHash ^ day) repeat on every run. Set
`PNE_TEST_SEED=<n>` to run them under other seeds (director-node passed 60/60 seeds and the ledger simulation 25/25
when this was written; both 12/12 again after the mmax onset step and the PENDING_CE reporting were added).

## Not shipped: AmbientSounds bed regions (lead decision needed before M2 sign-off)

The contract gives DIRECTOR `overrides/kubejs/assets/ambientsounds/**`, section 5 says RESONANCE's stereo beds
(`amb: true`) are referenced only by those regions, and the section 10 M2 in-game row asks for "AmbientSounds regions
discovered at the confirmed path". None ship, so as written that row cannot be met and the stereo beds are unused.

What the jar allows (AmbientSounds 6.3.8, read-only bytecode): regions load with `listResourceStacks("<engine>/regions")`
from every resource pack, so a file would live at `assets/ambientsounds/basic/regions/<name>.json` (KubeJS serves
`kubejs/assets` as a client resource pack). A region's conditions (`AmbientCondition`) are client-side world state:
time, biome, rain, height, light, sky, air, temperature, features, other regions, and an `entity` condition
(`AmbientEntityCondition`: type, name, tag, team, nbt, scores, distance, count). Sounds have `mute` and
`mute-priority`. The stock `warden` region shows the pattern the TDD's A5 intends (mute 0.8 while a warden is within
40 blocks), so a region could fade when a parasite type is near.

Why the director does not ship one: the client cannot see the server-side state the contract makes binding for
Resonance audio. A region would keep playing through the RELEASE hush (L0 c) and the vacuum (L0 b), ignore
`/pne resonance self off` (`pne_res_off`, "all Resonance audio off for this player"), comfort and the per-layer
switches, and bypass the ledger's bus, level-jump and per-minute rules (I5), and it would double the director's own
L1 segments. Its PANIC behaviour could only be approximated with an entity-distance mute.

Options for the lead: (1) amend section 2.3, section 5 and the section 10 M2 row so the director's positional segments
are the only L1 route for now, and tell RESONANCE the `amb` beds are not needed at M2; or (2) accept those deviations
and have DIRECTOR ship one conservative region (for example night, low sky light, no parasite within 24 blocks via
the `entity` condition with `mute`), with the director's L1 fallback kept or dropped. Until then the director's
positional segments are the only bed.

## Behaviour changes and contract deviations to report

- **`pne_horror.js` features that were dead before M2 now run.** The pre-M2 `pneHDim` returned
  `String(entity.level.dimension)`; in game `entity.level` is the Mojang method `level()` (contract F27), so the result
  was the string `undefined` and every `execute in undefined ...` command failed silently: gore particles and slams,
  Mobs Inside bursts (summons) and reinforcement beckons never happened in play (the retired whisper pool too). The
  rewrite (`pneHLevel` / `pneHDim` through `pneCoreDim`) fixes that, so all three run for the first time, now scaled by
  the scripted-spawn multiplier (up to x1.25 in CALM on Hard, `floor(count x m + random)`). No code change was made for
  this; it needs in-game checks and the lead may want a config switch for bursts and beckons.
- **No core, no horror sounds.** Without `pne_00_core.js`, `pneHEmitPlayer` / `pneHEmitAt` skip every horror sound
  (gore particles, bursts, beckons, the doom clock and messages still run). Contract section 8 (CORE row, "Existing
  horror") says "unchanged (pre-M2 behaviour)", which conflicts with sections 9.4 and 10 (no `playsound` string may
  remain in `pne_horror.js`); `director-routing` asserts the skip. Skipping is the fail-safe choice (no uncontrolled
  level jumps, stingers or heartbeat duty for comfort players); the lead should amend the section 8 row to "sounds
  skipped; everything else unchanged".
- **FLK now has its placement phenotype (reinforcement beckons only).** Contract 3.2.1 says nothing in `pne_horror.js`
  changes behaviour beyond the routing; the FLK flank placement above is a deliberate addition on the lead's request.
  It is a pure placement bias (a beckon is moved only when today's chain would summon at the dying mob), so the
  reinforcement rate and the director's pacing and closed-loop models are unchanged. It reads HIVE's `HiveInfo.flk` (an
  extra field, allowed by section 3) through `pneCoreHiveInfo`, and it works in the death handler like the existing
  reinforcement chain (section 7.1 says event handlers only enqueue; the chain already ran there, and the added work is
  bounded and at most once per 100 ticks). The "FLK spawn placement" open decision should record that reinforcement
  beckons are placed and that the natural/ambient half is still open (see above: only the `FinalizeSpawn` hook could
  move such a spawn, at the cost of skipping the spawn rules at the new position); the TDD 3.1 note that FLK is
  tag-only and HIVE's `hive.md` sentence that ambient spawns are placed in the rear arc need the same update.
