"""
Suite resonance-consistency: sounds.json, the generated catalog, the subtitles, the manifest and the OGG files agree
(IMPLEMENTATION.md sections 4.6 and 5, TDD 2.3.2 / 2.6).

  - the catalog is exactly 3 lines: '// priority: 90', the generator comment, 'var PNE_RES_CATALOG = ' + strict JSON;
    keys sorted, numbers with at most 2 decimals, no NaN; gen = the manifest's sha256 (12 hex)
  - every catalog event has a sounds.json entry and an OGG, and nothing else exists (no strays either way)
  - the shipped set is exactly the spec's (render.ships): every class but the stereo beds, which stay in
    tools/resonance/out/ (IMPLEMENTATION.md section 5, lead decision 1.3); the manifest records the not-shipped classes
    and they equal tdd_pins.NOT_SHIPPED
  - no stereo bed anywhere under overrides/: no catalog event with amb: true or a bed_* class, no bed_* pool,
    sounds.json key, sound name or OGG, no stereo OGG, and no text file under overrides/ naming a res.<slug>.bed_*
    event (verify.bed_leaks). The FAIL paths are proven on planted copies in PNE_TMP: a bed file, sounds.json entry
    and catalog event (bed_leaks); a manifest that lists a bed (verify.inventory_problems, and gen_sounds_json.py must
    refuse it); a catalog with a bed event (catalog_check.js must fail)
  - every event carries the section 5 fields with the right types (amb stays in the format, always false);
    categories, attenuation distances (whispers 32, tells 24, others 128), mode flags and LF flags follow the contract
    table; stream exactly for files > 10 s; preload only for L7
  - pools: every '<slug>.<cls>' pool sorted and complete; >= 6 variants per class, >= 12 per whisper tier
  - every subtitle key resolves in lang/en_us.json and lang holds no key that no sounds.json entry uses; the tell
    subtitle reads "Something skitters nearby"
  - gen_sounds_json.py --check: the committed files are exactly what the manifest generates, also on a copy with CRLF
    line endings (a Windows checkout with core.autocrlf=true), where the catalog gen and the spec hash must not change
  - the catalog evaluates in Node (tools/tests/kjs_node.js) with tools/resonance/tests/catalog_check.js

    python tools/resonance/tests/test_consistency.py      last line PASS or FAIL
"""
import copy
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(RES))
sys.path.insert(0, RES)
import gen_sounds_json as GSJ  # noqa: E402
import render as R  # noqa: E402
import tdd_pins as T  # noqa: E402
import verify as V  # noqa: E402

ASSETS = os.path.join(ROOT, 'overrides', 'kubejs', 'assets', 'pne')
CATALOG = os.path.join(ROOT, GSJ.REL_CATALOG)
MANIFEST = os.path.join(RES, 'manifest.json')
TMP = os.environ.get('PNE_TMP') or os.path.join(tempfile.gettempdir(), 'pne_tests')
FIELDS = {'layer': str, 'cls': str, 'lufs': float, 'mmax': float, 'dur': float, 'cat': str, 'comfort': bool, 'normal': bool,
          'att': int, 'stream': bool, 'lf': bool, 'reserve': bool, 'amb': bool}
# contract table (IMPLEMENTATION.md section 5): slug -> {cls: (comfort, normal)}. The stereo beds bed_dry, bed_dread and
# bed_muffled are not shipped (lead decision 1.3) and must not appear at all.
MODES = {
    'hollow': {c: (True, True) for c in ('dry', 'dread', 'muffled', 't_dry_dread', 't_dread_muffled', 't_dry_muffled')},
    'undertone': {'a': (False, True)},
    'pulse': {'heartbeat': (False, True), 'heartbeat_c': (True, False), 'flutter': (False, True), 'rough': (False, True)},
    'beat': {'slow': (True, True), 'tense': (False, True)},
    'whisper': {'amb': (True, True), 'near': (True, True)},
    'approach': {'n': (False, True), 'c': (True, False)},
    'spike': {'a': (False, True)},
    'tell': {'a': (True, True)},
}
LAYER = {'hollow': 'L1', 'undertone': 'L2', 'pulse': 'L3', 'beat': 'L4', 'whisper': 'L5', 'approach': 'L6', 'spike': 'L7', 'tell': 'L8'}
CAT = {'L1': 'ambient', 'L2': 'ambient', 'L3': 'ambient', 'L4': 'ambient', 'L5': 'voice', 'L6': 'hostile', 'L7': 'hostile', 'L8': 'hostile'}
ATT = {'L5': 32, 'L8': 24}
BED = R.BED_PREFIX
problems = []
notes = []


def bad(msg):
    problems.append(msg)


SPEC = R.load_spec()
with open(MANIFEST, 'rb') as f:
    raw = f.read().replace(b'\r\n', b'\n')   # the same LF-normalised bytes gen_sounds_json.py hashes
man = json.loads(raw.decode('utf-8'))
if not man['summary']['pass']:
    bad('manifest records failing gates: %s' % man['summary']['failed'])

# the shipped set (IMPLEMENTATION.md section 5, lead decision 1.3)
not_shipped = R.not_shipped_classes(SPEC)
pinned = sorted('%s.%s' % (T.LAYERS[k.split('.')[0]]['slug'], k.split('.')[1]) for k in T.NOT_SHIPPED)
if not_shipped != pinned:
    bad('classes the spec does not ship %s are not tdd_pins.NOT_SHIPPED %s' % (not_shipped, pinned))
if man.get('not_shipped') != not_shipped:
    bad('manifest not_shipped %r is not the spec\'s %r' % (man.get('not_shipped'), not_shipped))
spec_ship = {a['key'] for a in R.expand(SPEC) if R.ships(SPEC, a['layer'], a['cls'])}
spec_held = {a['key'] for a in R.expand(SPEC) if not R.ships(SPEC, a['layer'], a['cls'])}
man_keys = set(man['assets'])
if man_keys != spec_ship:
    bad('manifest assets are not the spec\'s shipped set: %d extra (%s), %d missing (%s)' % (
        len(man_keys - spec_ship), ', '.join(sorted(man_keys - spec_ship)[:4]), len(spec_ship - man_keys), ', '.join(sorted(spec_ship - man_keys)[:4])))
if man_keys & spec_held:
    bad('manifest lists %d asset(s) of classes that do not ship: %s' % (len(man_keys & spec_held), ', '.join(sorted(man_keys & spec_held)[:4])))
if man['summary']['count'] != len(spec_ship):
    bad('manifest summary count %d, spec shipped set %d' % (man['summary']['count'], len(spec_ship)))

cat, lines = GSJ.read_catalog(CATALOG)
if lines[0] != '// priority: 90':
    bad('catalog line 1 is %r' % lines[0])
if not lines[1].startswith('// Generated by tools/resonance/gen_sounds_json.py'):
    bad('catalog line 2 is not the generator comment')
if len(lines) != 4 or lines[3] != '':
    bad('catalog must be exactly 3 lines plus the final newline (has %d)' % len(lines))
body = lines[2][len(GSJ.CATALOG_PREFIX):]
if body != json.dumps(cat, sort_keys=True):
    bad('catalog JSON is not in canonical sorted form')
if re.search(r'NaN|Infinity', body):
    bad('catalog contains NaN or Infinity')
for num in re.findall(r'(?<![\w"])-?\d+\.(\d+)', body):
    if len(num) > 2:
        bad('catalog number with more than 2 decimals: .%s' % num)
        break
if sorted(cat) != ['events', 'gen', 'pools', 'v'] or cat['v'] != 1:
    bad('catalog top-level keys or version wrong: %s' % sorted(cat))
if cat['gen'] != hashlib.sha256(raw).hexdigest()[:12]:
    bad('catalog gen %s is not the manifest sha256 prefix %s' % (cat['gen'], hashlib.sha256(raw).hexdigest()[:12]))

with open(os.path.join(ASSETS, 'sounds.json'), encoding='utf-8') as f:
    sounds = json.load(f)
with open(os.path.join(ASSETS, 'lang', 'en_us.json'), encoding='utf-8') as f:
    lang = json.load(f)

events = cat['events']
man_by_event = {e['event']: e for e in man['assets'].values()}
if set(events) != set(man_by_event):
    bad('catalog events differ from the manifest (%d vs %d)' % (len(events), len(man_by_event)))
keys_expected = set()
for ev, e in sorted(events.items()):
    m = re.fullmatch(r'pne:res\.([a-z]+)\.([a-z0-9_]+)\.v(\d\d)', ev)
    if not m:
        bad('bad event id %s' % ev)
        continue
    slug, cls, nn = m.group(1), m.group(2), m.group(3)
    for fld, typ in FIELDS.items():
        v = e.get(fld)
        if typ is float:
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                bad('%s.%s is not a number' % (ev, fld))
        elif typ is int:
            if not isinstance(v, int) or isinstance(v, bool):
                bad('%s.%s is not an int' % (ev, fld))
        elif not isinstance(v, typ):
            bad('%s.%s is not %s' % (ev, fld, typ.__name__))
    extra = set(e) - set(FIELDS)
    if extra:
        bad('%s has fields outside the contract: %s' % (ev, sorted(extra)))
    if e.get('amb') is not False or cls.startswith(BED):
        bad('%s is a stereo bed in the catalog (amb %r): none ships, lead decision 1.3' % (ev, e.get('amb')))
    if slug not in LAYER or e['layer'] != LAYER[slug] or e['cls'] != cls:
        bad('%s layer/cls mismatch' % ev)
        continue
    if e['cat'] != CAT[e['layer']]:
        bad('%s category %s' % (ev, e['cat']))
    if e['att'] != ATT.get(e['layer'], 128):
        bad('%s attenuation %s' % (ev, e['att']))
    mode = MODES[slug].get(cls)
    if mode is None:
        notes.append('extra class %s.%s (allowed: the director ignores unknown classes)' % (slug, cls))
    elif (e['comfort'], e['normal']) != mode:
        bad('%s comfort/normal %s, contract %s' % (ev, (e['comfort'], e['normal']), mode))
    if e['lf'] != (e['layer'] in ('L2', 'L3')):
        bad('%s lf flag' % ev)
    if e['stream'] != (e['dur'] > 10.0):
        bad('%s stream %s for %.2f s' % (ev, e['stream'], e['dur']))
    key = ev[len('pne:'):]
    keys_expected.add(key)
    s = sounds.get(key)
    if not s:
        bad('%s has no sounds.json entry' % ev)
        continue
    snd = s['sounds']
    if len(snd) != 1:
        bad('%s must have exactly one sound (one event per variant)' % key)
        continue
    snd = snd[0]
    want = 'pne:res/%s/%s_v%s' % (slug, cls, nn)
    if snd.get('name') != want:
        bad('%s sound name %s, want %s' % (key, snd.get('name'), want))
    if snd.get('attenuation_distance') != e['att']:
        bad('%s attenuation_distance %s vs catalog %s' % (key, snd.get('attenuation_distance'), e['att']))
    if bool(snd.get('stream', False)) != e['stream']:
        bad('%s sounds.json stream flag' % key)
    if bool(snd.get('preload', False)) != (e['layer'] == 'L7'):
        bad('%s preload flag' % key)
    sub = s.get('subtitle')
    if sub is not None and sub not in lang:
        bad('%s subtitle key %s missing from lang' % (key, sub))
    ogg = os.path.join(ASSETS, 'sounds', 'res', slug, '%s_v%s.ogg' % (cls, nn))
    if not os.path.isfile(ogg):
        bad('%s OGG missing' % ev)
        continue
    info = sf.info(ogg)
    me = man_by_event.get(ev, {})
    if info.channels != 1:
        bad('%s has %d channel(s): only mono ships (the stereo beds stay in tools/resonance/out/)' % (ev, info.channels))
    if info.samplerate != 48000 or info.frames != me.get('samples'):
        bad('%s decodes to %d frames at %d Hz, manifest says %s' % (ev, info.frames, info.samplerate, me.get('samples')))
    with open(ogg, 'rb') as f:
        if hashlib.sha256(f.read()).hexdigest() != me.get('ogg_sha256'):
            bad('%s OGG bytes differ from the manifest' % ev)
if set(sounds) != keys_expected:
    bad('sounds.json keys not in the catalog: %s' % sorted(set(sounds) - keys_expected)[:5])
for key, s in sorted(sounds.items()):
    names = [x.get('name', '') if isinstance(x, dict) else str(x) for x in s.get('sounds', [])]
    if ('.' + BED) in key or any(('/' + BED) in n for n in names):
        bad('sounds.json entry %s is a stereo bed (%s): none ships' % (key, ', '.join(names)))
used_subs = {s['subtitle'] for s in sounds.values() if s.get('subtitle')}
if set(lang) != used_subs:
    bad('lang keys no sounds.json entry uses: %s' % sorted(set(lang) - used_subs))
on_disk = set()
for dp, _, fns in os.walk(os.path.join(ASSETS, 'sounds')):
    for fn in fns:
        on_disk.add(os.path.relpath(os.path.join(dp, fn), os.path.join(ASSETS, 'sounds')).replace(os.sep, '/'))
listed = {e['file'] for e in man['assets'].values()}
if on_disk != listed:
    bad('files under assets/pne/sounds not matching the manifest: %s' % sorted(on_disk ^ listed)[:5])
for p in V.inventory_problems(SPEC, V.records_from_manifest(man), on_disk):
    bad(p)
for p in V.bed_leaks(ROOT):
    bad(p)

pools = cat['pools']
for pk, lst in pools.items():
    if BED in pk:
        bad('catalog pool %s is a stereo bed pool: none ships' % pk)
    if lst != sorted(lst):
        bad('pool %s not sorted' % pk)
    for ev in lst:
        e = events.get(ev)
        if not e or '%s.%s' % (ev.split('.')[1], e['cls']) != pk:
            bad('pool %s lists %s' % (pk, ev))
if sorted(ev for lst in pools.values() for ev in lst) != sorted(events):
    bad('pools do not cover every event exactly once')
for slug, classes in MODES.items():
    for cls in classes:
        n = len(pools.get('%s.%s' % (slug, cls), []))
        need = 12 if slug == 'whisper' else 6
        if n < need:
            bad('pool %s.%s has %d variant(s), needs %d' % (slug, cls, n, need))
if lang.get('subtitles.pne.res.tell') != 'Something skitters nearby':
    bad('L8 subtitle is %r' % lang.get('subtitles.pne.res.tell'))

r = subprocess.run([sys.executable, os.path.join(RES, 'gen_sounds_json.py'), '--check'], capture_output=True, text=True, cwd=ROOT)
if r.returncode != 0:
    bad('gen_sounds_json.py --check: ' + (r.stdout + r.stderr).strip().splitlines()[-1])

# a Windows checkout with core.autocrlf=true (the repository has no .gitattributes) turns these text files into CRLF:
# the catalog's gen, the spec hash and gen_sounds_json --check must give the same answers on such a copy
tmp_root = os.path.join(TMP, 'resonance_crlf')
shutil.rmtree(tmp_root, ignore_errors=True)
for rel in (GSJ.REL_SOUNDS, GSJ.REL_LANG, GSJ.REL_CATALOG, os.path.join('tools', 'resonance', 'manifest.json'), os.path.join('tools', 'resonance', 'spec', 'layers.json')):
    dst = os.path.join(tmp_root, rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(os.path.join(ROOT, rel), 'rb') as f:
        data = f.read().replace(b'\r\n', b'\n').replace(b'\n', b'\r\n')
    with open(dst, 'wb') as f:
        f.write(data)
r = subprocess.run([sys.executable, os.path.join(RES, 'gen_sounds_json.py'), '--check', '--out-root', tmp_root,
                    '--manifest', os.path.join(tmp_root, 'tools', 'resonance', 'manifest.json'),
                    '--spec', os.path.join(tmp_root, 'tools', 'resonance', 'spec', 'layers.json')], capture_output=True, text=True, cwd=ROOT)
if r.returncode != 0:
    bad('gen_sounds_json.py --check on a CRLF checkout: ' + (r.stdout + r.stderr).strip().splitlines()[-1])
if R.lf_sha256(os.path.join(tmp_root, 'tools', 'resonance', 'spec', 'layers.json')) != man['spec_sha256']:
    bad('the spec hash changes on a CRLF checkout (verify --committed would report the spec as changed)')
cat_crlf, _ = GSJ.read_catalog(os.path.join(tmp_root, GSJ.REL_CATALOG))
if cat_crlf != cat:
    bad('the catalog reads differently from a CRLF checkout')

node = os.environ.get('PNE_NODE') or shutil.which('node')


def node_catalog_check(path):
    rr = subprocess.run([node, os.path.join(ROOT, 'tools', 'tests', 'kjs_node.js'), 'pneResCatalogCheck', path,
                         os.path.join(HERE, 'catalog_check.js')], capture_output=True, text=True, cwd=ROOT)
    out = [ln for ln in (rr.stdout + rr.stderr).splitlines() if ln.strip()]
    return rr.returncode, (out[-1].strip() if out else '')


if node:
    rc, last = node_catalog_check(CATALOG)
    if rc != 0 or not last.startswith('PASS'):
        bad('Node catalog check: ' + (last or 'no output'))
    else:
        notes.append('Node: ' + last)
else:
    bad('node not found for the catalog evaluation')

# The FAIL paths, on planted copies in PNE_TMP (never in overrides/): a stereo bed must be caught wherever it appears.
probe = os.path.join(TMP, 'resonance_bed_probe')
shutil.rmtree(probe, ignore_errors=True)
bed_ev = 'pne:res.hollow.bed_dry.v01'
p_ogg = os.path.join(probe, 'overrides', 'kubejs', 'assets', 'pne', 'sounds', 'res', 'hollow', 'bed_dry_v01.ogg')
os.makedirs(os.path.dirname(p_ogg), exist_ok=True)
shutil.copyfile(os.path.join(ASSETS, 'sounds', 'res', 'hollow', 'dry_v01.ogg'), p_ogg)
p_snd = os.path.join(probe, GSJ.REL_SOUNDS)
with open(p_snd, 'w', encoding='utf-8') as f:
    json.dump({'res.hollow.bed_dry.v01': {'sounds': [{'name': 'pne:res/hollow/bed_dry_v01', 'stream': True}]}}, f)
p_cat_dir = os.path.join(probe, 'overrides', 'kubejs', 'server_scripts')
os.makedirs(p_cat_dir, exist_ok=True)
cat_bed = copy.deepcopy(cat)
cat_bed['events'][bed_ev] = dict(next(iter(cat['events'].values())), cls='bed_dry', amb=True, stream=True, dur=45.5)
cat_bed['pools']['hollow.bed_dry'] = [bed_ev]
p_cat = os.path.join(p_cat_dir, 'pne_res_catalog.js')
with open(p_cat, 'w', encoding='utf-8', newline='\n') as f:
    f.write(GSJ.catalog_text(cat_bed))
leaks = V.bed_leaks(probe)
got = {('file' if 'bed file' in p else 'sounds' if 'sounds.json' in p else 'catalog' if 'pne_res_catalog' in p else '?') for p in leaks}
if got != {'file', 'sounds', 'catalog'}:
    bad('bed_leaks missed a planted bed (found %s): %s' % (sorted(got), leaks))
# a manifest that lists a bed: verify --committed's inventory check and gen_sounds_json.py must both refuse it
man_bed = copy.deepcopy(man)
src_key = sorted(k for k in man['assets'] if k.startswith('res.hollow.dry.'))[0]
bed = copy.deepcopy(man['assets'][src_key])
bed.update({'event': bed_ev, 'key': 'res.hollow.bed_dry.v01', 'file': 'res/hollow/bed_dry_v01.ogg', 'cls': 'bed_dry', 'amb': True, 'v': 1})
man_bed['assets'][bed['key']] = bed
inv = V.inventory_problems(SPEC, V.records_from_manifest(man_bed), on_disk | {bed['file']})
if not any('does not ship' in p for p in inv) or not any('stereo bed file' in p for p in inv):
    bad('verify.inventory_problems missed a bed in the manifest or on disk: %s' % inv)
p_man = os.path.join(probe, 'manifest_with_bed.json')
V.write_json(p_man, man_bed)
r = subprocess.run([sys.executable, os.path.join(RES, 'gen_sounds_json.py'), '--check', '--out-root', probe, '--manifest', p_man],
                   capture_output=True, text=True, cwd=ROOT)
if r.returncode == 0 or 'do not ship' not in (r.stdout + r.stderr):
    bad('gen_sounds_json.py accepted a manifest that lists a stereo bed: ' + (r.stdout + r.stderr).strip()[-200:])
if node:
    rc, last = node_catalog_check(p_cat)
    if not last.startswith('FAIL') or 'bed' not in last:
        bad('catalog_check.js passed a catalog with a stereo bed event: ' + last)
leak_probes = 'bed_leaks %d/3, inventory %d, gen_sounds_json refused, catalog_check %s' % (len(got & {'file', 'sounds', 'catalog'}), len(inv),
                                                                                         'failed' if node else 'n/a')
notes.append('planted-bed probes caught: ' + leak_probes)

for n_ in notes:
    print('  note  ' + n_)
for p in problems:
    print('  FAIL  ' + p)
print(('PASS' if not problems else 'FAIL') + ' resonance-consistency: %d events, %d pools, %d sounds.json entries, %d subtitle keys; shipped set = '
      'the spec\'s %d assets (%.2f MB of OGG), not shipped: %s, no stereo bed under overrides/%s' % (
          len(events), len(pools), len(sounds), len(lang), len(spec_ship), man['summary']['ogg_bytes'] / 1e6, ', '.join(not_shipped) or 'none',
          '' if not problems else '; %d problem(s)' % len(problems)))
sys.exit(1 if problems else 0)
