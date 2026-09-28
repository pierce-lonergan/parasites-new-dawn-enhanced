"""
Gate unit tests (suite resonance-gates): every gate V1-V16 (plus CE and G9) is fed at least one synthetic input
that must FAIL, and a control that must PASS, so a gate that silently always passes is caught. It also replays the
review probes of round 1: a rise visible only off the 100 ms block grid, the committed comfort whispers and slow
beats at every 10 ms start offset, a whisper with syllabic AM 0.8, heartbeat_c renders at m 0.6 and at 2.6 Hz from
a spec copy that allows them, a 6.5 LU vacuum drop, a DC offset and an anti-phase sub-bass pair for V4, and the TDD
rate / depth caps on spec-consistent but non-compliant inputs.

    python tools/resonance/tests/test_gates.py        last line PASS or FAIL; writes only to PNE_TMP
"""
import copy
import json
import math
import os
import sys
import tempfile

import numpy as np
import soundfile as sf
from scipy import signal

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(RES))
sys.path.insert(0, RES)
import pne_meter as pm  # noqa: E402
import render as R  # noqa: E402
import verify as V  # noqa: E402

FS = 48000
SPEC = R.load_spec()
GS = SPEC['gates']
TMP = os.environ.get('PNE_TMP') or os.path.join(tempfile.gettempdir(), 'pne_tests')
ASSETS = os.path.join(ROOT, 'overrides', 'kubejs', 'assets', 'pne', 'sounds')
results = []


def check(name, gate, expect_pass):
    ok = bool(gate['pass']) == expect_pass
    results.append((name, ok, gate))


def t(dur):
    return np.arange(int(round(dur * FS))) / FS


def fade(x, a=0.5, r=0.5):
    return x * R.fade_curve(len(x), int(a * FS), int(r * FS), 'raised_cosine')


def to_lufs(x, target):
    return x * 10 ** ((target - pm.integrated_lufs(x, FS)) / 20)


def cls(layer, c):
    return SPEC['layers'][layer]['classes'][c]


def committed(name):
    x, fs = sf.read(os.path.join(ASSETS, 'res', name + '.ogg'), dtype='float64')
    return x


with open(os.path.join(RES, 'manifest.json'), encoding='utf-8') as _f:
    MAN = json.load(_f)
RECS = {r['key']: r for r in V.records_from_manifest(MAN)}


def rec_of(name):
    """Render record of a committed asset, name = '<slug>/<cls>_vNN'."""
    slug, rest = name.split('/')
    cls_, v = rest.rsplit('_v', 1)
    return RECS['res.%s.%s.v%s' % (slug, cls_, v)]


def spec_copy(tag, edit):
    """A modified copy of spec/layers.json in PNE_TMP (the review's probe renders: a spec that allows a
    non-compliant asset must still make verify fail)."""
    s = copy.deepcopy(SPEC)
    edit(s)
    p = os.path.join(TMP, 'res_gate_spec_%s.json' % tag)
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(s, f)
    return p


def render_probe(spec_path, name, tag):
    """render.py G1-G10 for one asset of a spec copy, encoded into PNE_TMP; returns (path, record)."""
    sp = R.load_spec(spec_path)
    a = [x for x in R.expand(sp) if x['name'] == name][0]
    y, rec = R.render_asset(a, spec_path)
    c = R.class_spec(sp, a['layer'], a['cls'])
    p = os.path.join(TMP, 'res_gate_probe_%s.ogg' % tag)
    R.encode(y, p, sp, a['seed'] & 0x7FFFFFFF, R.compression_level(sp, c))
    return p, rec


rng = np.random.default_rng(1234)

# V1 format: real files in PNE_TMP
os.makedirs(TMP, exist_ok=True)
tone = 0.1 * np.sin(2 * np.pi * 440 * t(1.0))
paths = {}
for label, fs, ch, fmt, sub in (('ok', 48000, 1, 'OGG', 'VORBIS'), ('44k', 44100, 1, 'OGG', 'VORBIS'), ('stereo', 48000, 2, 'OGG', 'VORBIS'), ('wav', 48000, 1, 'WAV', 'PCM_16')):
    p = os.path.join(TMP, 'res_gate_v1_%s.%s' % (label, 'wav' if fmt == 'WAV' else 'ogg'))
    data = tone if ch == 1 else np.stack([tone, tone], 1)
    with sf.SoundFile(p, 'w', fs, ch, format=fmt, subtype=sub) as f:
        f.write(data)
    i = sf.info(p)
    paths[label] = {'format': i.format, 'subtype': i.subtype, 'samplerate': i.samplerate, 'channels': i.channels}
check('V1 mono 48 kHz OGG Vorbis passes', V.v1_format(paths['ok'], 1, GS['V1']), True)
check('V1 44.1 kHz fails', V.v1_format(paths['44k'], 1, GS['V1']), False)
check('V1 stereo for a mono class fails', V.v1_format(paths['stereo'], 1, GS['V1']), False)
check('V1 WAV fails', V.v1_format(paths['wav'], 1, GS['V1']), False)
check('V1 stereo bed passes', V.v1_format(paths['stereo'], 2, GS['V1']), True)

# V2 loudness (a committed dry segment is the passing control)
seg = committed('hollow/dry_v01')
c_dry = cls('L1', 'dry')
check('V2 committed dry segment passes', V.v2_loudness(seg, FS, c_dry, 'segment', -30.0, SPEC)[0], True)
check('V2 +2 LU off target fails', V.v2_loudness(seg * 10 ** (2 / 20), FS, c_dry, 'segment', -30.0, SPEC)[0], False)
flat = to_lufs(fade(pm.bandpass(rng.standard_normal(FS * 7), FS, 100, 4000)[:, 0], 1.5, 1.5), -30.0)
check('V2 bed without level movement (LRA < 2) fails', V.v2_loudness(flat, FS, c_dry, 'segment', -30.0, SPEC)[0], False)
c_wh = cls('L5', 'amb')
burst = np.zeros(FS)
burst[FS // 2:FS // 2 + 4800] = rng.standard_normal(4800)
burst = to_lufs(pm.bandpass(burst, FS, 500, 3000)[:, 0], -30.0)
check('V2 whisper with M-max over -22 fails', V.v2_loudness(burst * 10 ** (8 / 20), FS, c_wh, 'whisper', -22.0, SPEC)[0], False)
tr = committed('hollow/t_dry_muffled_v01')
trp = {'head_s': [1.5, 2.75], 'tail_s': [4.25, 5.25], 'from_lufs': -30.0, 'to_lufs': -36.0}
c_tr = cls('L1', 't_dry_muffled')
check('V2 committed transition passes', V.v2_loudness(tr, FS, c_tr, 'transition', 0.0, SPEC, trp)[0], True)
check('V2 transition with the tail 3 LU too loud fails',
      V.v2_loudness(np.concatenate([tr[:int(4.25 * FS)], tr[int(4.25 * FS):] * 10 ** (3 / 20)]), FS, c_tr, 'transition', 0.0, SPEC, trp)[0], False)
# TDD 2.3.3 L0 (b): the vacuum drops <= 6 LU. A tail 0.6 dB lower keeps it inside -36 +-1 but drops about 6.5 LU:
# |from - to| + tol (7 LU) would pass it, the TDD cap must not
deep = np.concatenate([tr[:int(4.25 * FS)], tr[int(4.25 * FS):] * 10 ** (-0.6 / 20)])
g_deep, m_deep = V.v2_loudness(deep, FS, c_tr, 'transition', 0.0, SPEC, trp)
check('V2 probe construction: drop %.2f LU in (6, 7), tail %.2f within -36 +-1' % (m_deep['drop_lu'], m_deep['tail_lufs']),
      {'pass': 6.0 < m_deep['drop_lu'] < 7.0 and abs(m_deep['tail_lufs'] + 36) <= 1.0}, True)
check('V2 vacuum transition dropping %.2f LU (> 6) fails' % m_deep['drop_lu'], g_deep, False)
c_tr_other = dict(c_tr)
c_tr_other.pop('max_drop_lu', None)
check('V2 the same drop passes without the TDD cap (the case the cap exists for)', V.v2_loudness(deep, FS, c_tr_other, 'transition', 0.0, SPEC, trp)[0], True)

# V3 true peak
check('V3 sine at -6 dBFS passes', V.v3_peak(0.5 * np.sin(2 * np.pi * 997 * t(1)), FS, GS['V3'])[0], True)
check('V3 sine at -0.5 dBFS fails', V.v3_peak(10 ** (-0.5 / 20) * np.sin(2 * np.pi * 997 * t(1)), FS, GS['V3'])[0], False)
clip = 0.3 * np.sin(2 * np.pi * 997 * t(1))
clip[1000] = 0.9995
check('V3 one sample at 0.9995 fails', V.v3_peak(clip, FS, GS['V3'])[0], False)

# V4 sub guard
s60 = fade(np.sin(2 * np.pi * 60 * t(4)))
check('V4 60 Hz tone passes', V.v4_sub(s60, FS, GS['V4'])[0], True)
check('V4 60 Hz + 12 Hz at -20 dB fails', V.v4_sub(s60 + fade(0.1 * np.sin(2 * np.pi * 12 * t(4))), FS, GS['V4'])[0], False)
check('V4 60 Hz tone with a DC offset (-17 dB of DC power) fails: DC counts as below 20 Hz', V.v4_sub(s60 + 0.1, FS, GS['V4'])[0], False)
sub12 = fade(0.1 * np.sin(2 * np.pi * 12 * t(4)))
anti = np.stack([s60 + sub12, s60 - sub12], axis=1)
check('V4 stereo pair with anti-phase 12 Hz in each channel fails (the channel average would cancel it)', V.v4_sub(anti, FS, GS['V4'])[0], False)
check('V4 control: the anti-phase pair measured on its channel average would pass', {'pass': pm.band_energy_db(anti, FS, 1.0, 20.0) <= GS['V4']['max_db']}, True)

# V5 LF share
check('V5 1 kHz passes', V.v5_lf(np.sin(2 * np.pi * 1000 * t(2)), FS, GS['V5'], False)[0], True)
check('V5 60 Hz-heavy non-throb asset fails', V.v5_lf(np.sin(2 * np.pi * 60 * t(2)) + 0.3 * np.sin(2 * np.pi * 1000 * t(2)), FS, GS['V5'], False)[0], False)
check('V5 throb asset is exempt', V.v5_lf(np.sin(2 * np.pi * 60 * t(2)), FS, GS['V5'], True)[0], True)


# V6 undertone
def stack(f0, dur, schroeder=False):
    tt = t(dur)
    x = np.zeros(len(tt))
    for tier in cls('L2', 'a')['tiers']:
        g = 10 ** (tier['db'] / 20)
        hs = list(range(tier['h'][0], tier['h'][1] + 1))
        for k, h in enumerate(hs):
            ph = math.pi * k * (k - 1) / len(hs) if schroeder else 0.0
            x += g * np.cos(2 * np.pi * h * f0 * tt + ph) / math.sqrt(h)
    return to_lufs(x * R.fade_curve(len(x), 3 * FS, 4 * FS, 'raised_cosine'), -32)


good = stack(18.0, 8.2)
check('V6 cosine stack at f0 passes', V.v6_undertone(good, FS, 18.0, 0.0, GS['V6'])[0], True)
check('V6 Schroeder-phase stack (shallow envelope) fails', V.v6_undertone(stack(18.0, 8.2, True), FS, 18.0, 0.0, GS['V6'])[0], False)
check('V6 stack at 18.5 Hz against f0 19.0 fails', V.v6_undertone(stack(18.5, 8.2), FS, 19.0, 0.0, GS['V6'])[0], False)
check('V6 limiter gain reduction 0.3 dB fails', V.v6_undertone(good, FS, 18.0, 0.3, GS['V6'])[0], False)
check('V6 a stack at f0 23 Hz fails even when the spec asks for 23 Hz (TDD 17-21 Hz)', V.v6_undertone(stack(23.0, 8.2), FS, 23.0, 0.0, GS['V6'])[0], False)


# V7 sidebands
def am(fc, fm, m, dur=6.5):
    tt = t(dur)
    return fade(np.sin(2 * np.pi * fc * tt) * (1 + m * np.sin(2 * np.pi * fm * tt)), 2, 3)


check('V7 80 Hz AM 6 Hz m 0.6 passes', V.v7_sidebands(am(80, 6, 0.6), FS, 80, 6, 0.6, False, GS['V7'])[0], True)
check('V7 depth 0.3 against spec 0.6 fails (sidebands -16.5 dB)', V.v7_sidebands(am(80, 6, 0.3), FS, 80, 6, 0.6, False, GS['V7'])[0], False)
check('V7 fm 7 Hz against spec 6 Hz fails (spacing)', V.v7_sidebands(am(80, 6.6, 0.6), FS, 80, 6, 0.6, False, GS['V7'])[0], False)
check('V7 rough carrier 200 Hz fails', V.v7_sidebands(am(200, 40, 0.6), FS, 200, 40, 0.6, True, GS['V7'])[0], False)
check('V7 rough carrier 300 Hz passes', V.v7_sidebands(am(300, 40, 0.6), FS, 300, 40, 0.6, True, GS['V7'])[0], True)
check('V7 m 0.9 fails even when the spec asks for 0.9 (TDD m <= 0.6)', V.v7_sidebands(am(80, 6, 0.9), FS, 80, 6, 0.9, False, GS['V7'])[0], False)
check('V7 rough fm 90 Hz fails even when the spec asks for 90 Hz (TDD 30-70 Hz)', V.v7_sidebands(am(400, 90, 0.6), FS, 400, 90, 0.6, True, GS['V7'])[0], False)


# V8 heartbeat rate
def hb(rate, dur=6.5, m=0.6):
    tt = t(dur)
    P = np.zeros_like(tt)
    for k in range(int(dur * rate) + 2):
        for dt, amp in ((0.0, 1.0), (0.12, 0.708)):
            c = k / rate + dt
            sel = np.abs(tt - c) < 0.045
            P[sel] = np.maximum(P[sel], amp * (0.5 + 0.5 * np.cos(2 * np.pi * (tt[sel] - c) / 0.09)))
    return fade(np.sin(2 * np.pi * 80 * tt) * (1 + m * (2 * P - 1)), 2, 3)


check('V8 heartbeat at 1.2 Hz passes', V.v8_pulse(hb(1.2), FS, 1.2, GS['V8'])[0], True)
check('V8 heartbeat at 1.2 Hz against spec 1.3 Hz fails', V.v8_pulse(hb(1.2), FS, 1.3, GS['V8'])[0], False)
check('V8 heartbeat at 2.0 Hz fails even when the spec asks for 2.0 Hz (TDD 1.0-1.4 Hz)', V.v8_pulse(hb(2.0), FS, 2.0, GS['V8'])[0], False)
# comfort heartbeat (TDD 2.3.2 Comfort rule: m <= 0.3, <= 8 s; rate 1.0-1.4 Hz), measured with the carrier reference.
# The review's probes: spec copies that ask for m 0.6 or 2.6 Hz rendered every gate green before this fix.
hc_name = 'pulse/heartbeat_c_v01'
hc_rec = rec_of(hc_name)
hc_c = cls('L3', 'heartbeat_c')
g_hc, m_hc = V.v8_pulse(committed(hc_name), FS, float(hc_rec['params']['rate']), GS['V8'], hc_rec, hc_c, SPEC, 'pulse.heartbeat_c')
check('V8 committed heartbeat_c v01 passes (measured m %.3f)' % m_hc['m_measured'], g_hc, True)


def _hc_m06(s):
    s['layers']['L3']['classes']['heartbeat_c']['m'] = 0.6


def _hc_fast(s):
    s['layers']['L3']['classes']['heartbeat_c']['variants'][0]['rate'] = 2.6


for tag, edit, what in (('hc_m06', _hc_m06, 'm 0.6'), ('hc_26hz', _hc_fast, 'rate 2.6 Hz')):
    sp_path = spec_copy(tag, edit)
    pth, prec = render_probe(sp_path, hc_name, tag)
    ent = V.verify_asset(pth, prec, sp_path)
    check('V8 heartbeat_c rendered at %s from a spec copy that allows it fails (m %.3f, periodicity %.2f Hz)' % (
        what, ent['metrics'].get('m_measured', -1), ent['metrics']['env_periodicity_hz']), ent['gates']['V8'], False)
    check('  ... and the asset as a whole fails verify', {'pass': ent['pass']}, False)


# V9 beats
def beat(f1, d, single_h2_db=None, dur=8.2):
    tt = t(dur)
    x = np.sin(2 * np.pi * f1 * tt) + np.sin(2 * np.pi * (f1 + d) * tt)
    if single_h2_db is not None:
        x += 2 * 10 ** (single_h2_db / 20) * np.sin(2 * np.pi * 2 * f1 * tt)
    return x * R.fade_curve(len(x), 3 * FS, 4 * FS, 'raised_cosine')


check('V9 equal partials delta 5 Hz passes', V.v9_beat(beat(240, 5.0), FS, 5.0, False, GS['V9'])[0], True)
check('V9 single 2f1 partial at -6 dB (depth < 0.85) fails', V.v9_beat(beat(240, 5.0, -6.0), FS, 5.0, False, GS['V9'])[0], False)
check('V9 delta 1.3 Hz against spec 1.5 Hz fails', V.v9_beat(beat(240, 1.3), FS, 1.5, True, GS['V9'])[0], False)
check('V9 comfort slow beat at 2.4 Hz fails even when the spec asks for 2.4 Hz (TDD slow 0.5-1.5, comfort <= 2 Hz)',
      V.v9_beat(beat(240, 2.4), FS, 2.4, True, GS['V9'], comfort=True)[0], False)
check('V9 tense beat at 9 Hz fails even when the spec asks for 9 Hz (TDD 4-7 Hz)', V.v9_beat(beat(240, 9.0), FS, 9.0, False, GS['V9'])[0], False)

# V10 whisper SNR (a committed whisper is the control)
wh = committed('whisper/amb_v01')
check('V10 committed ambiguous whisper passes', V.v10_whisper(wh, FS, -12.0, SPEC)[0], True)
check('V10 the same whisper 3 dB hotter fails', V.v10_whisper(wh * 10 ** (3 / 20), FS, -12.0, SPEC)[0], False)
check('V10 an ambiguous whisper against the near target fails', V.v10_whisper(wh, FS, -6.0, SPEC)[0], False)

# V11 duration and fades
nz = pm.bandpass(rng.standard_normal(FS * 3), FS, 100, 4000)[:, 0]
check('V11 faded 3 s noise passes', V.v11_duration(fade(nz, 0.2, 0.2), FS, [1.0, 5.0], False, False, GS['V11'])[0], True)
check('V11 hard start fails', V.v11_duration(fade(nz, 0.0005, 0.2), FS, [1.0, 5.0], False, False, GS['V11'])[0], False)
check('V11 attack-exempt stinger with a hard start passes', V.v11_duration(fade(nz, 0.0005, 0.2), FS, [1.0, 5.0], False, True, GS['V11'])[0], True)
check('V11 attack-exempt stinger with a hard end fails', V.v11_duration(fade(nz, 0.0005, 0.0005), FS, [1.0, 5.0], False, True, GS['V11'])[0], False)
check('V11 duration outside the range fails', V.v11_duration(fade(nz, 0.2, 0.2), FS, [4.0, 8.0], False, False, GS['V11'])[0], False)
long_dir = fade(pm.bandpass(rng.standard_normal(FS * 11), FS, 100, 4000)[:, 0], 1, 1)
check('V11 director layer over 10 s fails', V.v11_duration(long_dir, FS, [5.0, 20.0], True, False, GS['V11'])[0], False)


# V12 and V13 set gates (synthetic entries)
def entry(slug, c, v, lufs, dur, ch=1, amb=False):
    return {'slug': slug, 'cls': c, 'v': v, 'metrics': {'lufs_i': lufs}, 'dur': dur, 'samples': int(dur * FS), 'channels': ch,
            'stream': dur > 10, 'amb': amb}


ok_set = {'a%d' % i: entry('beat', 'slow', i, -34 + 0.3 * i, 8.1) for i in range(6)}
ok_set.update({'b%d' % i: entry('hollow', 'bed_dry', i, -30.0, 46.0, 2, True) for i in range(6)})
sg = V.set_gates(ok_set, SPEC)
check('V12 pool spread 1.5 LU passes', sg['V12'], True)
check('V13 small static set passes', sg['V13'], True)
bad = dict(ok_set)
bad['a9'] = entry('beat', 'slow', 9, -38.5, 8.1)
check('V12 pool spread 4.5 LU fails', V.set_gates(bad, SPEC)['V12'], False)
big = {'x%d' % i: entry('pulse', 'rough', i, -32.0, 9.9) for i in range(80)}
check('V13 static PCM over 64 MB fails', V.set_gates(big, SPEC)['V13'], False)
wrong = dict(ok_set)
wrong['b0'] = dict(wrong['b0'], stream=False)
check('V13 bed not streamed fails', V.set_gates(wrong, SPEC)['V13'], False)
fall14 = V.director_fall_db(14.0, SPEC)
check('V13 director fall at sprint for 10 s is <= 5 dB', {'pass': V.director_fall_db(10.0, SPEC) <= GS['V13']['max_fall_db']}, True)
check('V13 director fall at sprint for 14 s is > 5 dB (fails)', {'pass': fall14 <= GS['V13']['max_fall_db']}, False)

# V14 report
check('V14 report of a tone passes', V.v14_report(np.sin(2 * np.pi * 440 * t(1)), FS, GS['V14'])[0], True)
nan = np.sin(2 * np.pi * 440 * t(1))
nan[100] = np.nan
check('V14 a non-finite signal fails', V.v14_report(nan, FS, GS['V14'])[0], False)


# V15 in-file rise
def ramp(ramp_s, rise_db, dur=6.0, start=1.0):
    """Band noise, flat, then a linear-in-dB rise of rise_db over ramp_s starting at `start`, then flat."""
    x = pm.bandpass(rng.standard_normal(int(dur * FS)), FS, 100, 4000)[:, 0]
    u = np.clip((t(dur) - start) / ramp_s, 0.0, 1.0)
    return fade(x * 10 ** ((-rise_db * (1 - u)) / 20), 0.05, 0.05)


check('V15 normal +7 dB over 3.5 s passes', V.v15_rise(ramp(3.5, 7), FS, 0.05, False, True, False, GS['V15'])[0], True)
check('V15 normal +14 dB over 3 s fails', V.v15_rise(ramp(3.0, 14), FS, 0.05, False, True, False, GS['V15'])[0], False)
check('V15 comfort +4 dB over 4 s passes', V.v15_rise(ramp(4.0, 4), FS, 0.05, True, False, False, GS['V15'])[0], True)
check('V15 comfort +9 dB over 2 s fails', V.v15_rise(ramp(2.0, 9), FS, 0.05, True, False, False, GS['V15'])[0], False)
check('V15 +9 dB over 2.4 s passes as a normal-only asset', V.v15_rise(ramp(2.4, 9), FS, 0.05, False, True, False, GS['V15'])[0], True)
check('V15 the same ramp fails as a both-mode asset (comfort 6 LU / 2 s)', V.v15_rise(ramp(2.4, 9), FS, 0.05, True, True, False, GS['V15'])[0], False)
check('V15 stinger (L7) is exempt', V.v15_rise(ramp(1.0, 20), FS, 0.05, False, True, True, GS['V15'])[0], True)
# R1: a rise that only shows off the 100 ms block grid. A 1 kHz tone at 0 dB, a 0.41 s dip to -7.5 dB starting at
# 1.045 s, then 0 dB again: a 400 ms window fits inside the dip only for starts in 1.045-1.055 s, which a 100 ms grid
# never hits (it reads the dip about 1.8 dB shallow, a 5.7 LU rise), while the real rise is 7.5 LU per 2 s.
tt = t(4.0)
lvl = np.where((tt >= 1.045) & (tt < 1.455), 10 ** (-7.5 / 20), 1.0)
offgrid = fade(0.1 * np.sin(2 * np.pi * 1000 * tt) * lvl, 0.05, 0.05)
grid_rise = pm.rise_after(offgrid, FS, 0.05, 2.0, hop_s=0.1)[0]
check('V15 probe construction: the 100 ms grid reads the off-grid dip as %.2f LU (<= 6, would pass)' % grid_rise, {'pass': grid_rise <= 6.0}, True)
check('V15 comfort rise visible only off the 100 ms grid (7.5 LU per 2 s) fails', V.v15_rise(offgrid, FS, 0.05, True, False, False, GS['V15'])[0], False)
# R1: the review's method on the committed comfort whispers and slow beats: prepend 0-90 ms of silence (playback
# starting anywhere on the old grid) and measure with the old 100 ms grid; every offset must stay <= 6 LU per 2 s
worst_off = (0.0, '')
for k, e in sorted(MAN['assets'].items()):
    if not e['comfort'] or e['slug'] not in ('whisper', 'beat'):
        continue
    xk = committed('%s/%s_v%02d' % (e['slug'], e['cls'], e['v']))
    fi = float(e['render']['params'].get('fade_in_s', 0.0))
    for sh in range(0, 100, 10):
        y = np.concatenate([np.zeros(int(sh * FS / 1000)), xk])
        r = pm.rise_after(y, FS, fi + sh / 1000.0, 2.0, hop_s=0.1)[0]
        if r > worst_off[0]:
            worst_off = (r, '%s +%d ms' % (k, sh))
check('V15 committed comfort whispers and slow beats at every 10 ms start offset (100 ms grid): worst %.2f LU (%s) <= 6' % worst_off,
      {'pass': worst_off[0] <= GS['V15']['comfort']['max_lu']}, True)
# S-RES-SPEC-6: a file too short to have an in-file rise is reported as not applicable, never as a full-margin pass
g_short = V.v15_rise(committed('tell/a_v01'), FS, 0.04, True, True, False, GS['V15'])[0]
check('V15 a 0.45 s tell is not applicable (na, no margin), not a pass with margin 6', {'pass': g_short['pass'] and g_short['na'] and 'margin' not in g_short}, True)

# V16 tell audibility (a committed tell is the control)
tell = committed('tell/a_v01')
check('V16 committed tell passes', V.v16_tell(tell, FS, SPEC)[0], True)
check('V16 the same tell 30 dB quieter fails', V.v16_tell(tell * 10 ** (-30 / 20), FS, SPEC)[0], False)
low = np.zeros(int(0.6 * FS))
for k in range(5):
    i0 = int((0.04 + 0.1 * k) * FS)
    low[i0:i0 + 1200] = rng.standard_normal(1200) * np.exp(-np.arange(1200) / 300)
low = to_lufs(pm.bandpass(low, FS, 300, 700)[:, 0], -22)
check('V16 clicks at 300-700 Hz (outside the bed dip) fail', V.v16_tell(low, FS, SPEC)[0], False)

# CE comfort envelope rule
car = pm.bandpass(rng.standard_normal(FS * 8), FS, 200, 2000)[:, 0]
check('CE comfort asset with 6 Hz AM depth 0.8 fails', V.ce_rule(car * (1 + 0.8 * np.sin(2 * np.pi * 6 * t(8))), FS, True, '', GS['CE'])[0], False)
check('CE comfort asset with 1 Hz AM depth 0.8 passes (rate <= 2 Hz)', V.ce_rule(car * (1 + 0.8 * np.sin(2 * np.pi * 1 * t(8))), FS, True, '', GS['CE'])[0], True)
check('CE normal-only asset is not applicable', V.ce_rule(car * (1 + 0.8 * np.sin(2 * np.pi * 6 * t(8))), FS, False, '', GS['CE'])[0], True)
# S-RES-SPEC-1: the L5 syllabic AM is measured (no blanket whisper exemption). The same phrase plan and noise as a
# committed whisper, synthesised with syllabic depth 0.8 and brought to the committed level, must fail CE; at the
# spec's 0.45 it must pass. The phrase-level gating stays attached as PENDING, never as the pass reason.
wh_name = 'whisper/amb_v01'
wh_rec = rec_of(wh_name)
wh_x = committed(wh_name)
wh_n = len(wh_x)
for depth, expect in ((0.8, False), (0.45, True)):
    y = R.whisper_synth(SPEC, int(wh_rec['seed']), wh_rec['params']['bursts'], wh_n, depth)
    y = to_lufs(y, float(wh_rec['target_lufs']))
    pth = os.path.join(TMP, 'res_gate_syl_%02d.ogg' % int(depth * 100))
    R.encode(y, pth, SPEC, 1, 0.3)
    yd, _ = sf.read(pth, dtype='float64')
    g_syl, m_syl = V.ce_rule(yd, FS, True, V.ce_pending(wh_rec, SPEC), GS['CE'], wh_rec, SPEC, 'whisper')
    check('CE whisper with syllabic AM depth %.2f %s (measured %.3f)' % (depth, 'passes' if expect else 'fails', m_syl['syllabic_depth']), g_syl, expect)
    check('  ... its phrase-level gating is attached as PENDING, not graded', {'pass': bool(g_syl.get('pending'))}, True)
g_cw, m_cw = V.ce_rule(wh_x, FS, True, V.ce_pending(wh_rec, SPEC), GS['CE'], wh_rec, SPEC, 'whisper')
check('CE committed whisper amb v01: syllabic depth %.3f passes' % m_cw['syllabic_depth'], g_cw, True)
tl_rec = rec_of('tell/a_v01')
g_tl = V.ce_rule(committed('tell/a_v01'), FS, True, V.ce_pending(tl_rec, SPEC), GS['CE'], tl_rec, SPEC, 'tell')[0]
check('CE committed tell: na + PENDING (measured, not reported as a pass)', {'pass': g_tl['na'] and bool(g_tl.get('pending')) and 'margin' not in g_tl}, True)
bare = copy.deepcopy(SPEC)
bare['gates']['CE']['pending_lead_decision'] = {'whisper': 'a slug-level entry'}
check('CE a bare slug-level entry no longer matches any class', {'pass': V.ce_pending(wh_rec, bare) == ''}, True)

# G9 zero gain reduction
check('G9 L3 with 0 dB reduction passes', V.g9_zero_gr(0.0, 'L3', SPEC), True)
check('G9 L2 with 0.3 dB reduction fails', V.g9_zero_gr(0.3, 'L2', SPEC), False)
check('G9 L7 may limit', V.g9_zero_gr(1.7, 'L7', SPEC), True)

# R2: a worker that runs out of memory must not decide the result: build_manifest retries serially. Run in its own
# process (tests/retry_probe.py): Windows spawns pool workers by re-importing the main module, and this script does
# all its work at module level.
import subprocess  # noqa: E402
rp = subprocess.run([sys.executable, os.path.join(HERE, 'retry_probe.py')], capture_output=True, text=True, timeout=600)
try:
    rj = json.loads([ln for ln in rp.stdout.splitlines() if ln.startswith('{')][-1])
except (IndexError, ValueError):
    rj = {'error': (rp.stdout + rp.stderr).strip()[-300:]}
check('verify: MemoryError in every worker -> serial retry with the same verdicts and metrics (%s)' % rj,
      {'pass': rp.returncode == 0 and rj.get('retried') and rj.get('assets') == 3 and rj.get('pass') and rj.get('same_as_serial')}, True)
check('verify: --committed honours --jobs / PNE_JOBS (default min(4, CPUs))', {'pass': V.default_jobs() == (int(os.environ['PNE_JOBS']) if os.environ.get('PNE_JOBS') else min(4, os.cpu_count() or 1))}, True)

bad = [r for r in results if not r[1]]
for name, ok, g in results:
    print('  %s  %s%s' % ('ok  ' if ok else 'FAIL', name, '' if ok else ' -> %s' % g))
covered = sorted({n.split()[0] for n, _, _ in results if n.split()[0] in V.GATE_ORDER})
print(('PASS' if not bad else 'FAIL') + ' resonance-gates: %d/%d checks; gates covered: %s' % (len(results) - len(bad), len(results), ' '.join(covered)))
sys.exit(1 if bad else 0)
