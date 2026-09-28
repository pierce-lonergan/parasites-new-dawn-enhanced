"""
Suite resonance-tdd-pins: spec/layers.json against the TDD numbers pinned in tools/resonance/tdd_pins.py.

verify.py takes its targets and most limits from spec/layers.json, and verify.py --install rewrites the manifest from
whatever the spec says, so without this suite a spec edit that relaxes a TDD limit (V4 -35 -> -30, CE 0.5 -> 1.5,
heartbeat_c -34 -> -30 LUFS, approach.c +4 -> +5 dB, beat.slow delta 1.9 Hz, ...) would re-render, re-verify and
stay green. This suite fails on any difference that is not listed in tdd_pins.DEVIATIONS, checks that each listed
deviation still describes the spec, and checks that the CE pending list is exactly the pinned set (no slug-level
entries). It checks that the classes marked "ship": false are exactly tdd_pins.NOT_SHIPPED (the stereo beds, lead
decision 1.3: kept in the spec, rendered into tools/resonance/out/ only) and that render.ships agrees, so a spec edit
cannot put a bed back under overrides/. It also mutates a copy of the spec in memory with the review's examples and
requires each to be caught.

    python tools/resonance/tests/test_tdd_pins.py      last line PASS or FAIL
"""
import copy
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.dirname(HERE)
sys.path.insert(0, RES)
import render as R  # noqa: E402
import tdd_pins as T  # noqa: E402

EPS = 1e-9


def problems(spec):
    out = []

    def eq(label, got, want):
        if isinstance(want, float) or isinstance(got, float):
            ok = got is not None and want is not None and abs(float(got) - float(want)) <= EPS
        else:
            ok = got == want
        if not ok:
            out.append('%s: spec %r, TDD %r' % (label, got, want))

    def within(label, vals, lo, hi):
        vals = list(vals)
        if not vals or min(vals) < lo - EPS or max(vals) > hi + EPS:
            out.append('%s: spec %r outside the TDD %r-%r' % (label, vals, lo, hi))

    ch, g, ref, L = spec['chain'], spec['gates'], spec['reference'], spec['layers']
    # 2.3.1 chain
    eq('fs', spec['fs'], T.CHAIN['fs'])
    eq('G2 floor', ch['G2_floor_hz'], T.CHAIN['G2_floor_hz'])
    for k, sk in (('G3', 'G3_dc_block'), ('G4', 'G4_sub_guard'), ('G5', 'G5_ultrasonic_guard')):
        eq(k + ' order', ch[sk]['order'], T.CHAIN[k]['order'])
        eq(k + ' Hz', ch[sk]['hz'], T.CHAIN[k]['hz'])
    eq('G4 single-pass sosfilt', ch['G4_sub_guard'].get('single_pass_sosfilt'), True)
    eq('G7 minimum fade', ch['G7_min_fade_s'], T.CHAIN['G7_min_fade_s'])
    eq('G8 iterations', ch['G8']['iterations'], T.CHAIN['G8_iterations'])
    for k in ('ceiling_dbtp', 'lookahead_ms', 'release_ms', 'oversample', 'zero_gr_layers'):
        eq('G9 ' + k, ch['G9_limiter'][k], T.CHAIN['G9'][k])
    for k in ('format', 'subtype', 'compression_level'):
        eq('G10 ' + k, ch['G10_encode'][k], T.CHAIN['G10'][k])
    # 2.3.2 caps and 2.6 gates
    for gate, vals in T.GATES.items():
        if gate == 'global_mmax_max':
            eq('global M-max', g['global_mmax_max'], vals)
        elif gate == 'V15':
            for mode in ('normal', 'comfort'):
                for k in ('max_lu', 'window_s'):
                    eq('V15 %s %s' % (mode, k), g['V15'][mode][k], vals[mode][k])
        else:
            for k, v in vals.items():
                eq('%s %s' % (gate, k), g[gate].get(k), v)
    # reference geometry
    eq('AmbientSounds bed median', ref['ambientsounds_bed_median_lufs'], T.REFERENCE['ambientsounds_bed_median_lufs'])
    for geo in ('whisper_geometry', 'tell_geometry', 'director_placement'):
        for k, v in T.REFERENCE[geo].items():
            eq('%s %s' % (geo, k), ref[geo][k], v)
    # layers: slug, category, attenuation (IMPLEMENTATION 5)
    for lay, vals in T.LAYERS.items():
        for k, v in vals.items():
            eq('%s %s' % (lay, k), L[lay].get(k), v)
    # classes: levels, caps, modes, durations
    for key, vals in T.CLASSES.items():
        lay, cls = key.split('.')
        c = L[lay]['classes'].get(cls)
        if c is None:
            out.append('%s missing from the spec' % key)
            continue
        for k in ('lufs', 'tol', 'mmax_minus_i_max', 'mmax_cap', 'snr_db', 'max_drop_lu'):
            if k in vals:
                eq('%s %s' % (key, k), c.get(k), vals[k])
        if 'lra' in vals:
            eq(key + ' LRA window', c.get('lra'), vals['lra'])
        eq(key + ' modes (comfort, normal)', (c['comfort'], c['normal']), vals['modes'])
        if 'dur' in vals:
            dev = T.DEVIATIONS.get(key + '.dur')
            if dev:
                eq(key + ' dur (deviation)', c['dur_range'], dev['spec'])
                within(key + ' dur (deviation inside the TDD maximum)', c['dur_range'][1:], dev['tdd'][0], dev['tdd'][1])
            else:
                within(key + ' dur_range', c['dur_range'], vals['dur'][0], vals['dur'][1])
        if 'dur_max' in vals and c['dur_range'][1] > vals['dur_max'] + EPS:
            out.append('%s dur_range %r exceeds the TDD maximum %r s' % (key, c['dur_range'], vals['dur_max']))
        if 'fade_s' in vals:
            eq(key + ' fade in', c.get('fade_in_s'), vals['fade_s'])
            eq(key + ' fade out', c.get('fade_out_s'), vals['fade_s'])
        if 'sweep_s' in vals:
            eq(key + ' sweep', c.get('sweep_s'), vals['sweep_s'])
        if 'count_min' in vals and int(c.get('count', len(c.get('variants') or []))) < vals['count_min']:
            out.append('%s has fewer than %d variants' % (key, vals['count_min']))
        n = len(c.get('variants') or []) or int(c.get('count', 0))
        if n < 6:
            out.append('%s has %d variants (TDD A1: >= 6)' % (key, n))
    # L1
    src = L['L1']['source']
    for k in ('pink', 'brown', 'lp_order', 'peak_hz', 'peak_db', 'peak_q', 'lp_walk', 'walk_hz'):
        eq('L1 ' + k, src[k], T.L1[k])
    for st, hz in T.L1['lp_hz'].items():
        eq('L1 %s low-pass' % st, L['L1']['states'][st]['lp_hz'], hz)
        eq('L1 %s state LUFS' % st, L['L1']['states'][st]['lufs'], T.CLASSES['L1.' + st]['lufs'])
    # L2
    a = L['L2']['classes']['a']
    eq('L2 tiers', a['tiers'], T.L2['tiers'])
    for k in ('amp_law', 'breath_hz', 'breath_depth', 'fade_in_s', 'fade_out_s'):
        eq('L2 ' + k, a[k], T.L2[k])
    f0s = [v['f0'] for v in a['variants']]
    within('L2 f0', f0s, T.L2['f0_hz'][0], T.L2['f0_hz'][1])
    if any(abs(round(f / T.L2['f0_step_hz']) * T.L2['f0_step_hz'] - f) > EPS for f in f0s):
        out.append('L2 f0 not in %.1f Hz steps: %r' % (T.L2['f0_step_hz'], f0s))
    dev = T.DEVIATIONS['L2.a.compression_level']
    eq('L2 compression_level (deviation)', a.get('compression_level'), dev['spec'])
    # L3
    L3 = L['L3']
    eq('L3 carrier', L3['carrier']['sine_hz'], T.L3['carrier_hz'])
    eq('L3 rough carrier', L3['carrier_rough']['sine_hz'], T.L3['rough_carrier_hz'])
    eq('L3 noise level', L3['carrier']['noise_db'], T.L3['noise_db'])
    eq('L3 rough noise level', L3['carrier_rough']['noise_db'], T.L3['noise_db'])
    for cls, c in L3['classes'].items():
        cap = T.COMFORT['pulse.' + cls]['m_max'] if ('pulse.' + cls) in T.COMFORT else T.L3['m_max']
        if c['m'] > cap + EPS:
            out.append('L3 %s m %r exceeds the TDD %r' % (cls, c['m'], cap))
        if c['fade_in_s'] < T.L3['fade_in_min_s'] - EPS or c['fade_out_s'] < T.L3['fade_out_min_s'] - EPS:
            out.append('L3 %s fades %r / %r under the TDD minimum' % (cls, c['fade_in_s'], c['fade_out_s']))
        if c['mod'] == 'heartbeat':
            rates = T.COMFORT['pulse.' + cls]['rate_hz'] if ('pulse.' + cls) in T.COMFORT else T.L3['heartbeat_rate_hz']
            within('L3 %s rate' % cls, [v['rate'] for v in c['variants']], rates[0], rates[1])
            eq('L3 %s lub-dub' % cls, c['lub_dub_s'], T.L3['lub_dub_s'])
            eq('L3 %s dub level' % cls, c['dub_db'], T.L3['dub_db'])
            cm = T.COMFORT.get('pulse.' + cls)
            if cm and c['dur_range'][1] > cm['dur_max_s'] + EPS:
                out.append('L3 %s dur_range %r exceeds the comfort maximum %r s' % (cls, c['dur_range'], cm['dur_max_s']))
        elif c.get('rough'):
            within('L3 rough fm', [v['fm'] for v in c['variants']], T.L3['rough_fm_hz'][0], T.L3['rough_fm_hz'][1])
        else:
            within('L3 flutter fm', [v['fm'] for v in c['variants']], T.L3['flutter_fm_hz'], T.L3['flutter_fm_hz'])
    # L4
    for cls in ('slow', 'tense'):
        c = L['L4']['classes'][cls]
        within('L4 %s f1' % cls, [v['f1'] for v in c['variants']], T.L4['f1_hz'][0], T.L4['f1_hz'][1])
        rng = T.L4['slow_delta_hz'] if cls == 'slow' else T.L4['tense_delta_hz']
        deltas = [v['delta'] for v in c['variants']]
        within('L4 %s delta' % cls, deltas, rng[0], rng[1])
        eq('L4 %s harm2 level' % cls, c['harm2']['db'], T.L4['harm2_db'])
        eq('L4 %s fade in' % cls, c['fade_in_s'], T.L4['fade_in_s'])
        eq('L4 %s fade out' % cls, c['fade_out_s'], T.L4['fade_out_s'])
        if c['comfort'] and max(deltas) > T.COMFORT['beat.slow']['rate_max_hz'] + EPS:
            out.append('L4 %s plays in comfort with delta %r > %r Hz' % (cls, max(deltas), T.COMFORT['beat.slow']['rate_max_hz']))
    dev = T.DEVIATIONS['L4.slow.delta_hz']
    eq('L4 slow delta range (deviation)', [min(v['delta'] for v in L['L4']['classes']['slow']['variants']),
                                           max(v['delta'] for v in L['L4']['classes']['slow']['variants'])], dev['spec'])
    # L5
    vo = L['L5']['voice']
    eq('L5 formants', vo['formants'], T.L5['formants'])
    for k in ('band_hz', 'order', 'db'):
        eq('L5 sibilance ' + k, vo['sibilance'][k], T.L5['sibilance'][k])
    for k in ('syllabic_hz', 'syllabic_depth', 'glide', 'bursts', 'burst_s', 'gap_s', 'attack_s', 'release_s'):
        eq('L5 ' + k, vo[k], T.L5[k])
    # L6
    s6 = L['L6']['source']
    eq('L6 noise high-pass', s6['noise_hp_hz'], T.L6['noise_hp_hz'])
    eq('L6 noise high-pass order', s6['noise_hp_order'], T.L6['noise_hp_order'])
    eq('L6 buzz root', s6['buzz_hz'], T.L6['buzz_hz'])
    if s6['buzz_hz'] * s6['buzz_harmonics'][0] < T.L6['buzz_min_harmonic_hz'] - EPS:
        out.append('L6 buzz harmonics start below %r Hz' % T.L6['buzz_min_harmonic_hz'])
    eq('L6 end fade', s6['end_fade_s'], T.L6['end_fade_s'])
    for cls in ('n', 'c'):
        c = L['L6']['classes'][cls]
        for k in ('rise_db', 'curve', 'lp_hz'):
            eq('L6 %s %s' % (cls, k), c[k], T.L6[cls][k])
        within('L6 %s ramp T' % cls, [v['T'] for v in c['variants']], T.L6[cls]['T_s'][0], T.L6[cls]['T_s'][1])
    # L7
    c7 = L['L7']['classes']['a']
    for k in ('attack_s', 'tau_s', 'am_hz', 'am_depth', 'noise_hp_hz', 'noise_hp_order'):
        eq('L7 ' + k, c7[k], T.L7[k])
    within('L7 cluster', [f * r for v in c7['variants'] for f in [v['f']] for r in (1.0, 2 ** (1 / 12), 2 ** 0.5)],
           T.L7['cluster_hz'][0], T.L7['cluster_hz'][1])
    eq('L7 preload', L['L7'].get('preload'), T.L7['preload'])
    # L8
    c8 = L['L8']['classes']['a']
    eq('L8 band', c8['band_hz'], T.L8['band_hz'])
    eq('L8 band order', c8['band_order'], T.L8['band_order'])
    within('L8 click length', c8['click_s'], T.L8['click_s'][0], T.L8['click_s'][1])
    clicks = [v['clicks'] for v in c8['variants']]
    eq('L8 clicks (deviation)', [min(clicks), max(clicks)], T.DEVIATIONS['L8.a.clicks']['spec'])
    within('L8 clicks', clicks, T.L8['clicks'][0], T.L8['clicks'][1])
    eq('L8 spacing (deviation)', c8['spacing_s'], T.DEVIATIONS['L8.a.spacing_s']['spec'])
    within('L8 spacing', c8['spacing_s'], T.L8['spacing_s'][0], T.L8['spacing_s'][1])
    eq('L8 subtitle', L['L8']['subtitle_text'], T.L8['subtitle'])
    # deviations that describe a structure, not a number
    for cls in ('slow', 'tense'):
        if 'beating pair' not in T.DEVIATIONS['L4.%s.harm2' % cls]['spec']:
            out.append('L4 %s harm2 deviation text changed' % cls)
    # CE: the pending list is exactly the pinned set; no bare slugs; no old-style exemptions
    ce = g['CE']
    if 'exempt' in ce:
        out.append('CE carries an "exempt" list: comfort classes are graded or PENDING, never exempt')
    pend = ce.get('pending_lead_decision', {})
    if sorted(pend) != sorted(T.PENDING_CE):
        out.append('CE pending list %r is not the pinned set %r' % (sorted(pend), sorted(T.PENDING_CE)))
    if any('.' not in k for k in pend):
        out.append('CE pending list has a slug-level entry: %r' % [k for k in pend if '.' not in k])
    for k in pend:
        if '.' not in k:
            continue
        lay = [ll for ll, v in T.LAYERS.items() if v['slug'] == k.split('.')[0]]
        if not lay or not L[lay[0]]['classes'].get(k.split('.')[1], {}).get('comfort'):
            out.append('CE pending entry %s is not a comfort class' % k)
    # IMPLEMENTATION 5 / lead decision 1.3: the classes that do not ship are exactly the pinned stereo beds
    flagged = []
    for lay in sorted(L):
        for cls in sorted(L[lay]['classes']):
            c = L[lay]['classes'][cls]
            key = '%s.%s' % (lay, cls)
            if 'ship' in c and not isinstance(c['ship'], bool):
                out.append('%s ship flag %r is not a boolean' % (key, c['ship']))
            if c.get('ship', True) is False:
                flagged.append(key)
            if (c.get('amb') or cls.startswith(R.BED_PREFIX)) and key not in T.NOT_SHIPPED:
                out.append('%s is a stereo AmbientSounds bed but not in tdd_pins.NOT_SHIPPED: no bed ships (lead decision 1.3)' % key)
    if flagged != sorted(T.NOT_SHIPPED):
        out.append('classes marked "ship": false %r are not the pinned not-shipped set %r (IMPLEMENTATION 5, lead decision 1.3)' % (
            flagged, sorted(T.NOT_SHIPPED)))
    for key in sorted(T.NOT_SHIPPED):
        lay, cls = key.split('.')
        if cls not in L.get(lay, {}).get('classes', {}):
            out.append('%s is pinned as not shipped but missing from the spec (the beds stay in the spec and render into '
                       'tools/resonance/out/)' % key)
        elif R.ships(spec, lay, cls):
            out.append('render.ships says %s ships' % key)
    return out


spec = R.load_spec()
found = problems(spec)
rows = [('spec/layers.json agrees with tdd_pins (%d difference(s))' % len(found), not found, '; '.join(found[:12]))]


def mutated(edit):
    s = copy.deepcopy(spec)
    edit(s)
    return problems(s)


def m_v4(s):
    s['gates']['V4']['max_db'] = -30.0


def m_ce(s):
    s['gates']['CE']['max_depth'] = 1.5


def m_hc(s):
    s['layers']['L3']['classes']['heartbeat_c']['lufs'] = -30.0


def m_hc_m(s):
    s['layers']['L3']['classes']['heartbeat_c']['m'] = 0.6


def m_ac(s):
    s['layers']['L6']['classes']['c']['rise_db'] = 5.0


def m_ac_lp(s):
    s['layers']['L6']['classes']['c']['lp_hz'] = [600.0, 5000.0]


def m_slow(s):
    s['layers']['L4']['classes']['slow']['variants'][5]['delta'] = 1.9


def m_pend(s):
    s['gates']['CE']['pending_lead_decision']['whisper'] = 'blanket'


def m_syl(s):
    s['layers']['L5']['voice']['syllabic_depth'] = 0.8


def m_drop(s):
    del s['layers']['L1']['classes']['t_dry_muffled']['max_drop_lu']


def m_v15(s):
    s['gates']['V15']['comfort']['max_lu'] = 8.0


def m_bed_ship(s):
    del s['layers']['L1']['classes']['bed_dry']['ship']


def m_bed_ship_true(s):
    s['layers']['L1']['classes']['bed_dread']['ship'] = True


def m_dry_held(s):
    s['layers']['L1']['classes']['dry']['ship'] = False


def m_bed_gone(s):
    del s['layers']['L1']['classes']['bed_muffled']


def m_new_amb(s):
    s['layers']['L1']['classes']['bed_extra'] = dict(s['layers']['L1']['classes']['bed_dry'], ship=True)


for label, edit in (('stereo bed bed_dry shipped again ("ship": false removed)', m_bed_ship), ('bed_dread "ship": true', m_bed_ship_true),
                    ('director segment hollow.dry marked "ship": false', m_dry_held), ('bed_muffled dropped from the spec', m_bed_gone),
                    ('a new amb bed class that ships', m_new_amb)):
    got = mutated(edit)
    rows.append(('a spec edit "%s" is caught' % label, bool(got), got[0] if got else 'NOT CAUGHT'))

for label, edit in (('V4 max_db -35 -> -30', m_v4), ('CE max_depth 0.5 -> 1.5', m_ce), ('heartbeat_c LUFS -34 -> -30', m_hc),
                    ('heartbeat_c m 0.3 -> 0.6', m_hc_m), ('approach.c rise 4 -> 5 dB', m_ac), ('approach.c LP 600-3000 -> 600-5000 Hz', m_ac_lp),
                    ('beat.slow delta 1.5 -> 1.9 Hz', m_slow), ('a slug-level CE pending entry', m_pend), ('L5 syllabic depth 0.45 -> 0.8', m_syl),
                    ('vacuum max_drop_lu removed', m_drop), ('V15 comfort 6 -> 8 LU', m_v15)):
    got = mutated(edit)
    rows.append(('a spec edit "%s" is caught' % label, bool(got), got[0] if got else 'NOT CAUGHT'))

bad = [r for r in rows if not r[1]]
for name, ok, d in rows:
    print('  %s  %s%s' % ('ok  ' if ok else 'FAIL', name, (': ' + d) if d else ''))
print(('PASS' if not bad else 'FAIL') + ' resonance-tdd-pins: %d/%d checks; %d documented deviation(s): %s; not shipped (build folder only): %s' % (
    len(rows) - len(bad), len(rows), len(T.DEVIATIONS), ', '.join(sorted(T.DEVIATIONS)), ', '.join(sorted(T.NOT_SHIPPED))))
sys.exit(1 if bad else 0)
