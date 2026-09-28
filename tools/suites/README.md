# Test suite manifests

Each module adds exactly one file here, `tools/suites/<module>.json`, and `tools/run_tests.py` picks it up.
Do not edit `tools/run_tests.py` to add a suite. The format and the placeholders are documented at the top of
`tools/run_tests.py` and in `docs/IMPLEMENTATION.md` (section 9).

| File | Owner |
| --- | --- |
| `core.json` | CORE (lead): the contract 1.5 suites of the core (`core-diff-node`, `core-diff-rhino`, `diff-events-rhino`, `pack-lint-recruits`); its older suites stay built into `tools/run_tests.py` |
| `ga-core.json` | GA-CORE |
| `hive.json` | HIVE-RUNTIME |
| `resonance.json` | RESONANCE-PIPELINE |
| `director.json` | DIRECTOR |
| `oracle.json` | ORACLE |
| `visual.json` | VISUAL |
| `pack.json` | lead / integration: the pack-level suites of `tools/tests/pack` (smoke, degradation and, since 1.5, difficulty runs, plain and `-strict`; the lint's duplicate-name and hidden-name tests; the install steps) |
| `milestones.json` | lead: the suite names each milestone requires, and per milestone the items no suite can decide (`pending`) |

Suite names are binding: `docs/IMPLEMENTATION.md` section 9.4 lists the names each module must register, and
`python tools/run_tests.py --milestone M0` (up to `M5`) fails when a required suite is not registered, skips or
fails. A plain `python tools/run_tests.py` only fails on FAIL; a SKIP never meets a milestone. While a milestone has
`pending` items (user decisions, deferred scope) a passing run prints them and says "MET for the automated criteria".

The core's own suites (kjs-lint, validate, rhino-compile, core-node, core-rhino, core-hub-brigadier,
no-process-kill) are built into `tools/run_tests.py`.
