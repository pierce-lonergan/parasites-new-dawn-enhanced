# ORACLE module (M5): telemetry, file bridge, sidecar

The binding contract is [IMPLEMENTATION.md](../IMPLEMENTATION.md) section 3.5; the design is [TDD.md](../TDD.md)
sections 4.3 to 4.5. This page says where things live and how to run them.

## In the game: `overrides/kubejs/server_scripts/pne_oracle_bridge.js` (priority 80)

- **Telemetry extractor.** Once per second, at each survival player's slot (`pneCorePlayersAtSlot`), 31 features
  in the TDD 4.3 order: one entity query (`getEntitiesWithin`, box +-32/+-16/+-32), at most 4 line-of-sight checks
  on the nearest parasites within 24 blocks, the held-item class, `place30` and `torch_rate` from
  `BlockEvents.placed`, the 9-neighbour enclosure, `dealt` from hurt events with a player source (repeats on the same
  victim within 10 ticks count only the excess, like invulnerability frames), and night. Published as the snapshot
  (`pneOraSnap`, read through `pneCoreSnap`). It runs while any of resonance, hive or oracle is on.
- **Bridge.** `telemetry.json` at slot 0 (`JsonIO.write`, which truncates the file and rewrites it in place),
  `verdict.json` at slot 10 (`JsonIO.read`): accepted only when `boot_id` matches this run and `seq` is newer than the
  last applied (and not newer than the last written). A verdict's age counts from the tick at which this run wrote the
  telemetry it answers (remembered for the last 64 writes; else the echoed tick if it lies in the past; else it counts
  as stale), so a late answer from a stalled sidecar is applied (seq and the purge hand-shake move on) but never
  reported fresh. Fresh = at most 60 ticks old with a backend. `status.json` is read only for the purge hand-shake and
  for `/pne oracle status`. A refused token-budget take retries on the next tick; failed writes back off to one try per
  30 s after 5 in a row. The bridge is off on a dedicated server (or an unknown server type) unless the world config
  `bridge_dedicated` is 1.
- **Privacy.** Only the random pseudonym `pne_pid` goes into files; no UUID, name or x/z position. Logging is
  `player.persistentData.pne_log`, and turning it on takes two steps: `/pne oracle log on` only sends the caller a
  one-time code (12 hex digits from `UUID.randomUUID`, valid 60 s) as a clickable `/pne oracle log confirm <code>` link
  in a tellraw addressed to that player's UUID, and only that confirm sets `pne_log` to 1. Any confirm attempt uses the
  code up (no guessing), and a second prompt is not sent within 5 s (no chat spam). This is needed because
  `/execute as <player> run pne oracle log on` makes an operator, the console, a command block or a function look
  exactly like that player to the command (`CommandSourceStack.getPlayer()` is the re-targeted entity, and the original
  source has no public getter); they never see the code. `/pne oracle log off` and `/pne oracle purge` act at once, since
  they only reduce data. A logging player gets a chat notice at each login. `/pne oracle purge` rotates the caller's pid;
  the old pid rides in `telemetry.json` `purge` until the sidecar lists it in `purged` (kept meanwhile in
  `server.persistentData.pne_ora.purge`).
- **Retention wording.** The 7-day retention and the 50 MB cap are applied by the sidecar whenever it runs (at start,
  once a minute, at stop); the chat texts say so rather than promising "at most 7 days" while no sidecar runs.
- **Determinism boundary.** The verdict's `style` (argmax of `styleP` when it is at least 0.5, else `none`) and `band`
  (`min(3, floor(4 EO))`) are computed once, when a verdict is accepted; `pneOraBuckets(player)` returns only those.
  Probabilities never reach a log line.

## Next to the game: `oracle/` (the sidecar)

Install (a lead step for `tools/apply.py`): copy `sidecar.py`, `sidecar_lock.py`, `sidecar_logs.py`,
`tpu_worker.py`, `backends/`, `models/`, `launch_oracle.cmd` and `stop_oracle.cmd` into
`<instance>\local\pne_oracle\`. Start it with `launch_oracle.cmd` (Python 3.9+ with numpy); it stops by itself after
10 minutes without telemetry. `stop_oracle.cmd` only creates `stop.flag`; a flag left over while no sidecar ran is
removed by the next start (it is older than that process) instead of stopping it. While a sidecar runs, its open
`sidecar.lock.guard` keeps Windows from renaming or deleting the bridge folder; stop it first. Nothing in the sidecar,
the launcher or the tests ever ends another process.

| File | Role |
| --- | --- |
| `sidecar.py` | supervisor: 25 ms tolerant polling (an empty or partial `telemetry.json` is a torn read, retried; the read handle shares read, write and delete access), seq/boot_id, 16-step windows, cpu_np, per-head softmax and E_O, verdict/status writes (private tmp names), a "starting" heartbeat before the model loads, flags, logs, idle exit, `--exit-after`. File errors never end it with a traceback: writes return False, a loop pass that raises `OSError` is recorded in `status.errors`, each shutdown step runs on its own, and a bridge folder missing for 60 s (`--bridge-gone-s`) stops it cooperatively |
| `sidecar_lock.py` | single instance without trusting PIDs: an OS-level exclusive lock on `sidecar.lock.guard` (msvcrt.locking / flock) held for the life of the process, released by the OS however the process ends; plus the informational `sidecar.lock` record (pid + creation time + exe + command line + fresh status nonce), re-read every second: another nonce in it makes the sidecar leave |
| `sidecar_logs.py` | opt-in NDJSON logs, 50 MB cap, 7 days (enforced while the sidecar runs), purge that reports what is left: a file held open by another program keeps the purge pending (`PURGE_PENDING`, retried every second) and the pid is acknowledged only when its files are gone |
| `backends/cpu_np.py` | float32 MLP 496-64-32-11 (34,251 parameters) |
| `backends/cpu_tfl.py` | int8 TFLite (worker only): manifest checks, `.tflite` operator reader |
| `backends/pipe_v2.py`, `backends/worker_client.py`, `tpu_worker.py` | v2 frame protocol, watchdog (5 ms soft, 250 ms hard, backoff 1-60 s), TPU worker. The handshake never blocks the loop (`start()` spawns and sends HELLO, `poll()` completes it; cpu_np serves meanwhile). A released worker is not waited for; while one is still running after EXIT no new one is spawned (state `blocked`), so at most one stuck worker can exist |
| `models/oracle_manifest.json` | generated by `train/make_manifest.py` (sha256 of every model file) |
| `sim/`, `train/`, `eval/` | simulator, numpy trainer, WSL export and S4b check (M6, not run), closed loop |
| `tools/usbports.ps1` | read-only USB lane check for the Coral |

## Tests (`python tools/run_tests.py --only oracle`)

`oracle-features-node` / `-rhino` (parity with the prototype on a recorded trace, adapter checks),
`oracle-bridge` (Node, and real Rhino where the JsonIO stand-in parses with the real Gson and the Rhino fork's own
`JsonUtils.toObject`, so numbers arrive as `LazilyParsedNumber` and so does the numeric `boot_id` string, exactly as
in game; includes the two-step opt-in against an operator's `execute as` source and a verdict answering telemetry 500
ticks old), `oracle-sidecar` (also slow truncating writes, a stale `stop.flag`, an unwritable `status.json`, a failing
loop pass and shutdown step), `oracle-stale-lock` (also 20 concurrent starts 0-100 ms apart and a taken-over lock),
`oracle-check-overrides`, `oracle-telemetry-bench` (MockWorld, 150 entities), `oracle-worker` (also the non-blocking
handshake, a stuck worker that ignores EXIT, and a supervisor whose worker never answers HELLO), `oracle-logs` (also a
purge while a log file is held open), `oracle-offline` and `oracle-bridge-e2e` (the real bridge in Rhino against the
real sidecar; its JsonIO stand-in truncates in place like the jar, and every second write pauses halfway so the
sidecar's torn-read path runs). All files go to `%TEMP%\pne_tests`.

## Measured (this PC, 2026-09-27)

| What | Value |
| --- | --- |
| Per-player telemetry sample, real Rhino, MockWorld 150 entities / 75 parasites in range / 4 line-of-sight checks | p50 0.255 ms, p90 0.29 ms, mean 0.27 ms, p99 0.84 ms; 300 entities: p50 0.46 ms. Value for `PNE_CORE_COST.playerTel`: 0.30 ms. Re-run 2026-09-28 with the yaw read through `getYaw()`: p50 0.237 ms, p90 0.243 ms, p99 0.260 ms (the core's 0.35 still covers it) |
| cpu_np forward + softmax, one window | p50 about 19 us |
| Bridge end to end (real bridge in Rhino, real sidecar, real files, half of the writes paused 60 ms mid-file) | 20/20 fresh reads at slot 10; the partial files were seen as torn reads and retried, `telemetry.json` never missing; stale 60 ticks after stop.flag |

## Platform notes found while building this module

- `JsonIO.read` returns numbers as `com.google.gson.internal.LazilyParsedNumber`, and a JSON **string** that parses as
  a double (for example `"1759000000000"`) comes back as a `LazilyParsedNumber` too (`JsonUtils.toPrimitive`). `Number(v)`
  and `String(v)` give the right values (the original text for strings); `===` against a raw value is always false.
- The Rhino fork has no `Math` constants: `Math.PI`, `Math.E`, `Math.LN2` ... are undefined (measured with the instance's
  jar), so `180 / Math.PI` is NaN in game. The bridge uses a literal.
- `JsonIO.write(Path, JsonObject)` in KubeJS 2001.6.5 does **not** delete first: it calls `Files.deleteIfExists` only for a
  null or JSON-null object, and otherwise `Files.newBufferedWriter(path)` with the default options CREATE,
  TRUNCATE_EXISTING, WRITE (javap of the installed jar). A reader therefore sees an empty or partial file (torn), not a
  missing one. Java opens that writer with every share flag, and it only needs other handles to share write access, so
  a reader using Python's `open()` does not make the game's write fail; the sidecar's extra delete share is defensive.
- `/execute as <player>` changes what `CommandSourceStack.getPlayer()` returns, so a command cannot tell a player's own
  call from an operator's call made "as" that player. Consent must come through something only the player sees (here a
  one-time code in their own chat).
- KubeJS hides three Mojang names the bridge needs (IMPLEMENTATION F37): the yaw is `getYaw()` (not `getYRot()`), the
  damage causer is `source.getActual()` (not `getEntity()`), and the server type is `server.isDedicated()` (not
  `isDedicatedServer()`). A call of the hidden name throws and was caught silently, so `look_rate` read 0 every second
  (the TDD counts look rate among the strongest features), `dealt` stayed 0, and only the `Platform` fallback decided
  the server type. The bridge now calls the KubeJS names first and keeps the Mojang names only as fallbacks. The test
  mocks (`tools/oracle/ora_mocks.js`, `TelemetryBench.java`) expose only the in-game names, `oracle-features-*` asserts a
  non-zero `look_rate` when the yaw changes and `dealt` from `getActual()`, and the benchmark fails unless the yaw is
  read through `getYaw()`. `heading_rate` was not affected: it follows the motion, not the yaw.
