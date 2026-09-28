"""
Suite resonance-determinism: renders are reproducible (TDD 2.3.1 G1, 3.3.3 spirit).

  - FNV-1a 32-bit reference vectors ('' , 'a', 'foobar') and the seed recorded for every committed asset;
  - the committed manifest is the spec's shipped set: every class that ships (render.ships) and none of the stereo
    beds, which render into tools/resonance/out/ only (IMPLEMENTATION.md section 5, lead decision 1.3), and no bed_*
    file sits under overrides/kubejs/assets/pne/sounds;
  - one variant of every shipped class (19 assets: the mono L1 director segments dry/dread/muffled/t_*, and L2-L8) is
    re-rendered into PNE_TMP by render.py in a fresh process: its float64 render hash must equal the manifest's
    float_sha256 and its OGG bytes must equal the committed file (Ogg serial pinned, page CRCs recomputed); a stale
    render log in PNE_TMP is removed first, so a render that writes elsewhere cannot pass on an old log;
  - the renders (the re-render and the probe's) write nothing into the repository: every file under overrides/ and
    tools/resonance/ (the install target and the default build folder tools/resonance/out/; __pycache__ ignored)
    keeps its size and mtime, and no entry appears in or leaves the repository root or tools/ (render.py's working
    directory; names only there). The guard is proven on a probe tree in PNE_TMP first: a render.py run into the
    watched tree, a changed file, a removed file and a new top-level entry must all be reported;
  - the Ogg page CRC implementation agrees with libogg (set_ogg_serial validates every original CRC first).

    python tools/resonance/tests/test_determinism.py [--all]     last line PASS or FAIL (--all: every shipped asset)
"""
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(RES))
sys.path.insert(0, RES)
import render as R  # noqa: E402

TMP = os.environ.get('PNE_TMP') or os.path.join(tempfile.gettempdir(), 'pne_tests')
OUT = os.path.join(TMP, 'resonance_determinism')
ASSETS = os.path.join(ROOT, 'overrides', 'kubejs', 'assets', 'pne', 'sounds')
# where a render.py regression could land: the install target, the default build folder (tools/resonance/out/) and
# render.py's own working directory (the repository root; names only there and in tools/, so other modules' trees
# are not walked)
WATCH_TREES = [os.path.join(ROOT, 'overrides'), RES]
WATCH_NAMES = [ROOT, os.path.join(ROOT, 'tools')]
SKIP = {'__pycache__', '.git'}
problems = []


def snapshot(trees, names, base):
    """{path relative to base: (size, mtime_ns)} for every file under trees, plus {entry/: None} for the entries
    directly in each of names."""
    snap = {}
    for top in trees:
        for dp, dns, fns in os.walk(top):
            dns[:] = [d for d in dns if d not in SKIP]
            for fn in fns:
                p = os.path.join(dp, fn)
                try:
                    st = os.stat(p)
                except OSError:
                    continue
                snap[os.path.relpath(p, base).replace(os.sep, '/')] = (st.st_size, st.st_mtime_ns)
    for d in names:
        for n in os.listdir(d):
            if n not in SKIP:
                snap.setdefault(os.path.relpath(os.path.join(d, n), base).replace(os.sep, '/') + '/', None)
    return snap


def tree_changes(before, after):
    """(added, removed, changed) between two snapshots."""
    return (sorted(set(after) - set(before)), sorted(set(before) - set(after)),
            sorted(k for k in set(before) & set(after) if before[k] != after[k]))


def change_report(before, after):
    parts = []
    for what, lst in zip(('added', 'removed', 'changed'), tree_changes(before, after)):
        if lst:
            parts.append('%s %d (%s%s)' % (what, len(lst), ', '.join(lst[:4]), ', ...' if len(lst) > 4 else ''))
    return '; '.join(parts)


def render_cmd(out, pats, jobs):
    return [sys.executable, os.path.join(RES, 'render.py'), '--fresh', '--out', out, '--only', pats, '--jobs', jobs]


# the repository as it is before any render (the probe's render below runs from the repository root too)
repo_before = snapshot(WATCH_TREES, WATCH_NAMES, ROOT)

# the guard catches what it claims to: a render into a watched tree, a changed file, a removed file, a new entry
probe = os.path.join(TMP, 'resonance_determinism_guard')
shutil.rmtree(probe, ignore_errors=True)
os.makedirs(os.path.join(probe, 'tree'))
for fn in ('keep.txt', 'gone.txt'):
    with open(os.path.join(probe, 'tree', fn), 'w', encoding='utf-8') as f:
        f.write('x')
p_trees, p_names = [os.path.join(probe, 'tree')], [probe]
before = snapshot(p_trees, p_names, probe)
rp = subprocess.run(render_cmd(os.path.join(probe, 'tree', 'leak'), 'hollow/dry_v01', '1'),
                    capture_output=True, text=True, cwd=ROOT, timeout=600)
with open(os.path.join(probe, 'tree', 'keep.txt'), 'a', encoding='utf-8') as f:
    f.write('y')
os.remove(os.path.join(probe, 'tree', 'gone.txt'))
os.makedirs(os.path.join(probe, 'stray'))
added, removed, changed = tree_changes(before, snapshot(p_trees, p_names, probe))
want_added = {'tree/leak/render_log.json', 'tree/leak/ogg/res/hollow/dry_v01.ogg', 'stray/'}
if rp.returncode != 0 or not want_added <= set(added) or removed != ['tree/gone.txt'] or changed != ['tree/keep.txt']:
    problems.append('the write guard did not report the planted changes on its probe tree '
                    '(render rc %d; added %s; removed %s; changed %s)' % (rp.returncode, added[:5], removed, changed))
guard_proven = not problems
shutil.rmtree(probe, ignore_errors=True)

for s, want in (('', 0x811C9DC5), ('a', 0xE40C292C), ('foobar', 0xBF9CF968)):
    if R.fnv1a32(s) != want:
        problems.append('fnv1a32(%r) = %08x, want %08x' % (s, R.fnv1a32(s), want))

spec = R.load_spec()
with open(os.path.join(RES, 'manifest.json'), encoding='utf-8') as f:
    man = json.load(f)
for k, e in man['assets'].items():
    name = '%s/%s_v%02d' % (e['slug'], e['cls'], e['v'])
    if e['render']['seed'] != R.fnv1a32(name):
        problems.append('%s: recorded seed %s is not FNV-1a(%r)' % (k, e['render']['seed'], name))

# the committed set is the shipped set: no stereo bed in the manifest or on disk (lead decision 1.3)
shipped = [a for a in R.expand(spec) if R.ships(spec, a['layer'], a['cls'])]
if set(man['assets']) != {a['key'] for a in shipped}:
    extra = sorted(set(man['assets']) - {a['key'] for a in shipped})
    problems.append('the committed manifest is not the spec\'s shipped set (%d vs %d assets; not shipped but listed: %s)' % (
        len(man['assets']), len(shipped), ', '.join(extra[:4]) or 'none'))
for dp, _, fns in os.walk(ASSETS):
    for fn in fns:
        if fn.lower().startswith(R.BED_PREFIX):
            problems.append('stereo bed file under overrides/: %s' % os.path.relpath(os.path.join(dp, fn), ROOT).replace(os.sep, '/'))

every = '--all' in sys.argv
classes = sorted({(a['slug'], a['cls']) for a in shipped})
pats = ','.join('%s/%s_v%s' % (slug, cls, '*' if every else '01') for slug, cls in classes)
jobs = os.environ.get('PNE_JOBS') or '4'
log_path = os.path.join(OUT, 'render_log.json')
if os.path.isfile(log_path):
    os.remove(log_path)
r = subprocess.run(render_cmd(OUT, pats, jobs), capture_output=True, text=True, cwd=ROOT, timeout=1800)
leaked = change_report(repo_before, snapshot(WATCH_TREES, WATCH_NAMES, ROOT))
if leaked:
    problems.append('render.py --out PNE_TMP (probe and re-render) changed the repository: ' + leaked)
if r.returncode != 0:
    problems.append('render.py failed: ' + (r.stdout + r.stderr).strip()[-400:])
    log = {'assets': []}
elif not os.path.isfile(log_path):
    problems.append('render.py exited 0 but wrote no render log into PNE_TMP/%s' % os.path.basename(OUT))
    log = {'assets': []}
else:
    with open(log_path, encoding='utf-8') as f:
        log = json.load(f)
checked = 0
l1 = []
for rec in log['assets']:
    e = man['assets'].get(rec['key'])
    if not e:
        problems.append('%s rendered but not in the manifest' % rec['key'])
        continue
    checked += 1
    if rec['float_sha256'] != e['render']['float_sha256']:
        problems.append('%s: float render differs from the committed build' % rec['key'])
    with open(os.path.join(ASSETS, e['file']), 'rb') as f:
        committed = hashlib.sha256(f.read()).hexdigest()
    if rec['ogg_sha256'] != committed:
        problems.append('%s: OGG bytes differ from the committed file' % rec['key'])
    if abs(rec['target_lufs'] - e['render']['target_lufs']) > 1e-9:
        problems.append('%s: solved target %.2f vs committed %.2f' % (rec['key'], rec['target_lufs'], e['render']['target_lufs']))
    if e['slug'] == 'hollow':
        l1.append(e['cls'])
want = len(shipped) if every else len(classes)
if checked < want:
    problems.append('only %d of %d asset(s) re-rendered' % (checked, want))
for p in problems:
    print('  FAIL  ' + p)
print(('PASS' if not problems else 'FAIL') + ' resonance-determinism: %d shipped asset(s) re-rendered bit-identical (float64 and OGG bytes; '
      'L1 director segments %s); seeds are FNV-1a; the committed set is the spec\'s %d shipped assets, no stereo bed; '
      'the render changed nothing under overrides/ or tools/resonance/ (guard %s on a probe tree)' % (
          checked, '/'.join(sorted(set(l1))) or 'none', len(shipped), 'proven' if guard_proven else 'NOT proven'))
sys.exit(1 if problems else 0)
