# Resonance pipeline (M1)

Offline audio pipeline for The Resonance: TDD 2.1-2.3 and 2.6, IMPLEMENTATION.md sections 2.3 and 5.

## Build

```
python tools/resonance/render.py             # G1-G10 for every asset in spec/layers.json -> tools/resonance/out/ (git-ignored)
python tools/resonance/verify.py --install   # V1-V16 (+CE, G9) on every decoded OGG (-> out/manifest.json); only if all pass:
                                             #   the OGGs of the classes that ship -> overrides/kubejs/assets/pne/sounds/res/
                                             #   the manifest of that shipped set -> tools/resonance/manifest.json
                                             #   then gen_sounds_json.py writes sounds.json, lang/en_us.json and
                                             #   server_scripts/pne_res_catalog.js; fails if any bed is left under overrides/
python tools/run_tests.py --only resonance   # CI: re-verifies the committed files and diffs the manifest
```

**Stereo beds are build output only** (lead decision 1.3, IMPLEMENTATION.md section 5). The three `hollow.bed_*`
classes stay in `spec/layers.json` with `"ship": false` and render and verify into `tools/resonance/out/` like every
other class, for a later client-side route. Nothing else about them reaches the pack:

- `verify.py --install` copies only the classes `render.ships()` accepts;
- the committed manifest lists only that shipped set, and records the held-back classes under `not_shipped`;
- `gen_sounds_json.py` refuses any manifest that lists a bed, including `out/manifest.json`;
- `tdd_pins.NOT_SHIPPED` pins the exact not-shipped set.

What each check covers:

- `verify.py --committed` (suite `resonance-verify`) and `resonance-consistency` fail on a `bed_*` OGG, a `sounds.json`
  entry, a catalog event or pool, or any text anywhere under `overrides/` naming a bed (`verify.bed_leaks`: an audio
  file named `bed_*`, or a `.json`/`.js`/`.mcmeta`/`.txt`/`.toml`/`.snbt`/`.properties`/`.cfg` file naming a
  `res.<slug>.bed_*` event or a `res/<slug>/bed_*` sound). Only these two scan the whole `overrides/` tree.
- `resonance-catalog-rhino` fails on a bed event or pool in the catalog; it sees nothing else.
- `resonance-determinism` fails on a bed in the committed manifest or a `bed_*` file under `assets/pne/sounds`.
- `resonance-tdd-pins` fails on any spec change to the not-shipped set; it checks the spec only.

The catalog keeps the `amb` field in its format, always `false`. The director's mono `dry`/`dread`/`muffled`/`t_*`
segments are the L1 bed.

The full set, beds included, renders in about 25 s on 8 workers and verifies in about 12 s on 4. `--jobs N` (or the
environment variable `PNE_JOBS`) sets the worker count. verify.py defaults to min(4, CPUs); one verify job peaks at
about 60 MB, even for a 50 s stereo bed. If a worker still fails (a `MemoryError` or a broken pool), verify redoes
every job serially, so host memory pressure cannot decide a gate result.

Renders are deterministic. The float64 render hash and the OGG bytes of every shipped asset are recorded in the
manifest, and `resonance-determinism` re-renders one variant of every shipped class (19, including the six L1 director
segment classes) and compares them bit for bit. The Ogg stream serial is pinned per asset and the page CRCs are
recomputed, because libsndfile otherwise picks a random serial. The same suite checks that its renders write nothing
into the repository: every file under `overrides/` and `tools/resonance/` (including `out/`) keeps its size and
mtime, and no entry appears in or leaves the repository root or `tools/`. It proves that guard on a probe tree in
`PNE_TMP` first, and removes a stale render log before rendering, so a render that writes elsewhere cannot pass on an
old log.

## Files

| File | Role |
| --- | --- |
| `tools/resonance/spec/layers.json` | Every layer, class, variant, target and gate limit. Additions beyond the TDD are marked `added` with the reason. |
| `tools/resonance/tdd_pins.py` | The TDD numbers (section named per value). verify.py applies the comfort class limits and the L3/L4 rate and depth caps from here, not from the spec. `resonance-tdd-pins` fails when the spec disagrees with it, unless the difference is listed in `DEVIATIONS`. |
| `tools/resonance/render.py` | G1-G10. Seed = FNV-1a(`<slug>/<cls>_vNN`), which equals `pneCoreFnv1a` for ASCII. `pulse_carrier`, `heartbeat_train` and `whisper_synth` are shared with verify.py, which uses them as carrier references. |
| `tools/resonance/pne_meter.py` | Port of the prototype meter plus envelope, line and rise helpers. `python pne_meter.py` runs the EBU 3341/3342 self-test. |
| `tools/resonance/verify.py` | Gates on the decoded files; writes the manifest; `--committed` is the CI mode. |
| `tools/resonance/gen_sounds_json.py` | sounds.json, subtitles and the catalog from the manifest; `--check` reports whether they are stale. |
| `tools/resonance/declip_local.py` | Optional local step. It runs ffmpeg `adeclip` on the user's own Spore audio, keeps each file's loudness, and writes the result into the instance or `%TEMP%` only. It refuses paths inside the repo. |
| `tools/resonance/manifest.json` | Every metric and gate result for every committed (shipped) asset, plus the `not_shipped` classes. The catalog's `gen` is its sha256 prefix. The build folder's `out/manifest.json` also covers the beds. |

Suites (`tools/suites/resonance.json`):

- `resonance-meter-selftest`, `resonance-verify` and `resonance-consistency` are the M1 set;
- `resonance-gates`: every gate plus the round-1 review probes;
- `resonance-tdd-pins`;
- `resonance-determinism`;
- `resonance-catalog-rhino`;
- `resonance-declip`.

## Asset set (126 shipped; 144 built)

| Layer | Classes (variants) | Notes |
| --- | --- | --- |
| L1 hollow | dry, dread, muffled (6 each, mono 6.05-6.55 s); t_dry_dread, t_dread_muffled, t_dry_muffled (6 each, 6.75-7.0 s). Built but **not shipped**: bed_dry, bed_dread, bed_muffled (6 each, stereo 45.5-50 s, `stream`, `amb`) | -30 / -32 / -36 LUFS; the beds carry 4 s equal-power baked fades |
| L2 undertone | a (6: f0 17.0-19.5 Hz in 0.5 Hz steps) | normal only; encoded at compression_level 0.0 (see below) |
| L3 pulse | heartbeat, heartbeat_c, flutter, rough (6 each) | heartbeat_c is the comfort class (m 0.3, -34, <= 8 s); measured m 0.297-0.301 (heartbeat 0.599-0.601) |
| L4 beat | slow (6: delta 1.34-1.5 Hz), tense (6: 4-7 Hz) | slow plays in both modes |
| L5 whisper | amb (12), near (12) | file level solved from V10 on the decoded file: amb -37.7 to -39.4, near -31.8 to -32.7 LUFS |
| L6 approach | n (6), c (6) | |
| L7 spike | a (6) | normal only, `preload: true` |
| L8 tell | a (6) | subtitle "Something skitters nearby", attenuation 24 |

Attenuation distances: whispers 32, tells 24, everything else 128 (the "director layers" value, applied to L6 and L7
too). Static decoded PCM (16-bit, non-streamed files) comes to 60.3 MB of the 64 MB budget; nothing shipped streams.
The 126 shipped OGGs total 5.87 MB (5,871,644 bytes); `overrides/kubejs/assets/pne` holds 129 files, 5.90 MB. The 18
stereo beds (19.39 MB) stay in `tools/resonance/out/`.

## Gate interpretations (where the TDD left a choice)

- **Loudness curves** (M-max, S-max, V15 rises) use a 10 ms hop. On a 100 ms block grid the result depended on where
  playback started: four comfort whispers read 4.1-4.9 LU per 2 s on the grid but 6.5-7.4 LU off it. LUFS-I keeps
  BS.1770-4's 100 ms block step, and LRA keeps EBU 3342's 10 Hz short-term rate. The self-test includes EBU 3341
  cases 9 and 12, plus 0.4 s and 3 s bursts at several sub-100 ms offsets.
- **V2, transitions**: the head (after the fade-in, before the sweep) is checked at the from-state target and the tail
  (after the sweep) at the to-state target, each within the tolerance. The drop is capped at min(|from - to| + tol,
  `max_drop_lu`); the vacuum segment `t_dry_muffled` carries the TDD's 6 LU (2.3.3 L0 b). Its measured drops are
  5.62-5.93 LU. The integrated LUFS-I of a whole transition is only reported.
- **V2, bed LRA 2-4 LU** also applies to the mono director segments (the L1 row calls them bed segments). To reach it,
  a slow level walk is solved per variant for LRA 3.0 (`added` in the spec). Measured LRA is 2.88-3.06.
- **V4** counts everything from 0 Hz (DC included) to 20 Hz, with Parseval-exact weights, per channel, and takes the
  worst channel. Worst file: -35.90 dB.
- **V7 / V8 / V9 / V6** also check the TDD ranges from `tdd_pins`, not only the rate the spec asked for:
  - flutter fm 6 Hz, rough fm 30-70 Hz, sideband level at most 20 log10(0.6/2) + 1 dB;
  - heartbeat rate 1.0-1.4 Hz, with measured m <= 0.6, and for heartbeat_c m <= 0.3 and <= 8 s;
  - slow beats 0.5-1.5 Hz, tense 4-7 Hz, comfort beats <= 2 Hz;
  - f0 17-21 Hz.

  The heartbeat depth m is measured by a least-squares fit of the decoded file onto the unmodulated carrier,
  re-synthesised from the recorded seed, and the carrier times the recorded pulse train. It is accurate to about
  ±0.003. Envelope estimators read 0.49-0.59 on m = 0.3 files, because the narrowband-noise carrier fluctuates on
  its own.
- **V10** reference bed: our own hollow dry spectrum scaled to the AmbientSounds median of -29 LUFS. The margin
  against the director bed at 12 blocks (att 128) is also recorded in the manifest.
- **V11** "body" is the RMS of the whole file, which is the strictest reading. File edges are silent pads or fades of
  at least 20 ms. The L8 clicks (15-40 ms each) are the content, not fades.
- **V15** measures the rise after the file's onset fade; the onset itself is the ledger's level-jump concern. Assets
  that play in both modes must meet both windows. If the momentary windows that start after the onset fade span less
  than 0.1 s, V15 is reported as not applicable, never as a pass with full margin, and the onset step is the
  catalog's `mmax`. That applies to tell v01 and v04 and whisper near v06.
- **V16** uses the tell level over its whole span, gaps between clicks included (conservative), against the -29 LUFS
  reference bed.
- **V6 / V9 depth** is the per-cycle peak-to-trough depth of the Hilbert envelope smoothed at 60 Hz, as in the
  prototype's `env_depth`. **V8** uses a 3-harmonic periodicity sum of that envelope.
- **CE** (comfort envelope rule) is graded for every comfort class, with two exceptions. There is no exempt list:
  - **L5**: the binding part is the syllabic AM. The TDD says it passes at depth 0.45. It is measured per burst
    against the same phrase re-synthesised without the AM; measured 0.447-0.479 against 0.5.
  - **L5 phrase gating and L8 click trains**: the whisper bursts and gaps read 0.65-1.44, and the tell click trains
    1.62-1.81, against 0.5. The TDD does not cover either. They are measured and reported as **PENDING a lead
    decision** (`tdd_pins.PENDING_CE`), never as passes. verify's summary line says so.

## Deviations from the TDD (all forced by a TDD gate; pinned in `tdd_pins.DEVIATIONS`)

1. **L2 encoded at compression_level 0.0** instead of 0.3. At 0.3, libvorbis adds a noise floor below 20 Hz of about
   -34 dB relative to total to the peaky cosine stack; the float render is at -122 dB. That fails V4. At 0.0 the
   decoded value is -40.8 to -42.1 dB, for about 3 kB more per file. Every other LF-rich layer passes V4 at 0.3, at
   -35.9 dB or lower.
2. **L4 slow uses delta 1.34-1.5 Hz**, not 0.5-1.5. With equal partials (depth about 1, V9 needs >= 0.85), a beat
   below about 1.3 Hz swings the 400 ms momentary loudness by more than 6 LU within 2 s, which fails V15 in comfort
   mode. Slow is a comfort class. The worst slow beat reads 5.90 LU per 2 s on the 10 ms curve.
3. **Whisper plans are redrawn** (deterministically) until the comfort rise, measured on the 10 ms curve, stays
   <= 5 LU per 2 s and the V10-solved loudness sits within +-1 LU of the pool's centre. The pool spread is then
   1.7 / 0.9 LU against the 3 LU limit.
4. **Whisper file levels** come out at -37.7 to -39.4 LUFS (ambiguous) and -31.8 to -32.7 LUFS (near), well below the
   -28 LUFS nominal. The TDD makes V10 binding ("the file's LUFS target is solved from this gate").
5. **A6 says 4th-order low-pass state variants; the master table and L0 say BW2.** The master table is followed.
6. **L8 tells last 0.45-0.59 s** (TDD 0.3-0.8 s), because LUFS-I needs a 400 ms block. They use 4-6 clicks spaced
   80-140 ms apart, inside the TDD's 3-6 clicks and 60-140 ms.

## Optional local de-clip (`declip_local.py`)

DIRECTOR's `replace: true` volume trims in `kubejs/assets/spore/sounds.json` were computed from the original files
and multiply on top of whatever file plays. The de-clipped copies therefore keep each file's loudness: the gain is
0 dB, or negative when adeclip made the file louder than the trims' reference. The pipeline's -2 dBTP limiter then
takes the restored peaks. A file that the limiter would make more than 3 LU quieter (`--max-lu-change`) is skipped,
and the trimmed original keeps playing. The 3 LU default is the ±3 dB L_eff residual the contract accepts at M2.
`declip_report.json` lists every file's reference level, gain, limiter reduction and loudness change.

Measured on the instance's Spore jar (read-only, output to `%TEMP%`):

- 205 files clip;
- the median limiter reduction is 6.8 dB and the median loudness change -4.3 LU, because most of these files get
  their loudness from clipping;
- 84 files are written at the 3 LU default (31 at 1 LU);
- every written copy is at most as loud as the level the trims assume, so the ledger errs on the safe side.

## In-game checks

- kubejs/assets serves the `pne` namespace: `/playsound pne:res.tell.a.v01 hostile @s` is audible and shows the
  subtitle "Something skitters nearby".
- `/playsound pne:res.hollow.bed_dry.v01 ambient @s` plays nothing (the client log reports an unknown sound event):
  no stereo bed ships (lead decision 1.3). `/playsound pne:res.hollow.dry.v01 ambient @s` still plays a mono segment.
- The L7 stinger (`preload: true`) starts instantly on first use.
- The L_eff capture at M2 (DIRECTOR) confirms whisper and director-layer levels within +-3 dB.
- The comfort listening sign-off covers the whispers' burst rhythm and the tells, the two CE items pending a lead
  decision.
