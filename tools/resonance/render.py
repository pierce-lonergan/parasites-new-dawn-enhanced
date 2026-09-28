"""
render.py: The Resonance asset renderer (TDD 2.3.1 global chain G1-G11, 2.3.2 master table, 2.6 step 1-2).

    python tools/resonance/render.py                      render every asset of spec/layers.json into out/
    python tools/resonance/render.py --only "pulse/*"     render a subset (names are <slug>/<cls>_vNN)
    python tools/resonance/render.py --out DIR --fresh    other output folder; start from an empty render log
    python tools/resonance/render.py --wav                also write float32 WAVs (large: the beds are stereo)

Output (default tools/resonance/out/, git-ignored): ogg/res/<slug>/<cls>_vNN.ogg and render_log.json (per asset:
seed, resolved parameters, solved targets, limiter gain reduction, float and OGG hashes). render.py never writes
anywhere else. verify.py then decodes every OGG and runs gates V1-V16, and verify.py --install copies only the
classes that ship (ships(): not the stereo beds, lead decision 1.3) into overrides/; gen_sounds_json.py writes
sounds.json, the subtitles and the catalog from that shipped set.

Chain per asset, in this order (TDD 2.3.1):
  G1  synthesis at 48 kHz in float64, seed = FNV-1a('<slug>/<cls>_vNN')
  G2  noise sources are generated in the FFT domain with every bin below 30 Hz zeroed
  G3  DC block: Butterworth high-pass, 1st order, 5 Hz
  G4  sub guard: Butterworth high-pass, 4th order, 28 Hz, single-pass sosfilt (never zero-phase)
  G5  ultrasonic guard: Butterworth low-pass, 8th order, 16 kHz
  G6  layer processing (filters, modulation, mixing) per the master table
  G7  envelopes and fades; no file-edge fade shorter than 20 ms (the normal-mode stinger attack is the exception)
  G8  gain to the target LUFS-I (BS.1770-4, gated), iterated with G9 up to 3 times
  G9  true-peak limiter: 5 ms look-ahead, 50 ms release, 4x-oversampled detection, ceiling -2.0 dBTP
  G10 OGG Vorbis through libsndfile, compression_level 0.3; the Ogg stream serial is set from the asset name and
      the page CRCs recomputed, so identical audio gives identical bytes
  G11 decode and verify: verify.py
Deterministic: the same spec gives bit-identical float renders (float_sha256) and identical OGG bytes.
"""
import argparse
import fnmatch
import functools
import hashlib
import io
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np
import soundfile as sf
from scipy import ndimage, signal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import pne_meter as pm  # noqa: E402

SPEC_PATH = os.path.join(HERE, 'spec', 'layers.json')
DEFAULT_OUT = os.path.join(HERE, 'out')


# ---------------------------------------------------------------------------------------------- spec

def fnv1a32(s):
    """FNV-1a 32-bit over the UTF-8 bytes of s (equals pneCoreFnv1a for printable ASCII)."""
    h = 0x811C9DC5
    for b in s.encode('utf-8'):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


@functools.lru_cache(maxsize=4)
def load_spec(path=SPEC_PATH):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def class_spec(spec, layer, cls):
    return spec['layers'][layer]['classes'][cls]


BED_PREFIX = 'bed_'


def ships(spec, layer, cls):
    """True when the pack ships this class under overrides/. A class marked "ship": false in the spec (the stereo
    AmbientSounds beds hollow.bed_*: lead decision 1.3, IMPLEMENTATION.md section 5) is rendered and verified into
    the build folder (tools/resonance/out/, git-ignored) only: verify.py --install never copies it into overrides/
    and the committed manifest, sounds.json and catalog never list it. A stereo bed (amb, bed_*) never ships,
    whatever its ship flag says."""
    c = class_spec(spec, layer, cls)
    return c.get('ship', True) is not False and not c.get('amb') and not cls.startswith(BED_PREFIX)


def not_shipped_classes(spec):
    """'<slug>.<cls>' of every class of the spec that does not ship, sorted."""
    return sorted('%s.%s' % (lay['slug'], cls) for L, lay in spec['layers'].items() for cls in lay['classes'] if not ships(spec, L, cls))


def expand(spec):
    """Every asset of the spec, sorted by sounds.json key."""
    out = []
    for L in sorted(spec['layers']):
        lay = spec['layers'][L]
        for cls in sorted(lay['classes']):
            c = lay['classes'][cls]
            variants = c.get('variants') or [{} for _ in range(int(c.get('count', 0)))]
            for i, v in enumerate(variants, 1):
                name = '%s/%s_v%02d' % (lay['slug'], cls, i)
                out.append({
                    'layer': L, 'slug': lay['slug'], 'cls': cls, 'v': i, 'name': name,
                    'event': 'pne:res.%s.%s.v%02d' % (lay['slug'], cls, i),
                    'key': 'res.%s.%s.v%02d' % (lay['slug'], cls, i),
                    'file': 'res/%s/%s_v%02d.ogg' % (lay['slug'], cls, i),
                    'seed': fnv1a32(name), 'variant': dict(v),
                })
    out.sort(key=lambda a: a['key'])
    return out


def lf_sha256(path):
    """sha256 of a text file with CRLF normalised to LF: the repository has no .gitattributes and core.autocrlf may
    be true, so a Windows checkout can turn the generated JSON into CRLF; the hash must not change with it."""
    with open(path, 'rb') as f:
        return hashlib.sha256(f.read().replace(b'\r\n', b'\n')).hexdigest()


def rng_for(seed, stream):
    return np.random.default_rng([int(seed), int(stream)])


# ---------------------------------------------------------------------------------------------- chain parts

@functools.lru_cache(maxsize=64)
def _butter(order, hz, btype, fs):
    if isinstance(hz, tuple):
        hz = list(hz)
    return signal.butter(order, hz, btype, fs=fs, output='sos')


def noise(rng, n, kind, fs, floor_hz):
    """G2: white/pink/brown noise generated in the FFT domain, bins below floor_hz zeroed, unit RMS."""
    X = np.fft.rfft(rng.standard_normal(n))
    f = np.fft.rfftfreq(n, 1.0 / fs)
    X[f < floor_hz] = 0.0
    if kind == 'pink':
        X[1:] /= np.sqrt(f[1:])
    elif kind == 'brown':
        X[1:] /= f[1:]
    y = np.fft.irfft(X, n)
    return y / np.sqrt(np.mean(y * y))


def guards(x, spec):
    """G3 DC block, G4 sub guard (single-pass sosfilt), G5 ultrasonic guard; along axis 0."""
    fs = spec['fs']
    ch = spec['chain']
    g3, g4, g5 = ch['G3_dc_block'], ch['G4_sub_guard'], ch['G5_ultrasonic_guard']
    y = signal.sosfilt(_butter(g3['order'], g3['hz'], 'highpass', fs), x, axis=0)
    y = signal.sosfilt(_butter(g4['order'], g4['hz'], 'highpass', fs), y, axis=0)
    return signal.sosfilt(_butter(g5['order'], g5['hz'], 'lowpass', fs), y, axis=0)


def guards_phase(f_hz, spec):
    """Phase (rad) of the G3-G5 cascade at f_hz, for cosine-phase pre-compensation of harmonic stacks."""
    fs = spec['fs']
    ch = spec['chain']
    tot = 0.0
    for g, bt in ((ch['G3_dc_block'], 'highpass'), (ch['G4_sub_guard'], 'highpass'), (ch['G5_ultrasonic_guard'], 'lowpass')):
        _, h = signal.sosfreqz(_butter(g['order'], g['hz'], bt, fs), [2 * np.pi * f_hz / fs])
        tot += float(np.angle(h[0]))
    return tot


def tv_lowpass(x, fc_path, order, fs, block=256):
    """Butterworth low-pass whose cutoff follows fc_path (Hz per sample), coefficients updated per block with the
    filter state carried over."""
    y = np.empty_like(x)
    zi = None
    n = len(x)
    for s in range(0, n, block):
        e = min(n, s + block)
        fc = float(min(max(fc_path[(s + e) // 2], 20.0), 0.45 * fs))
        so = signal.butter(order, fc, 'lowpass', fs=fs, output='sos')
        if zi is None:
            zi = np.zeros((so.shape[0], 2))
        y[s:e], zi = signal.sosfilt(so, x[s:e], zi=zi)
    return y


def peaking_sos(f0, gain_db, q, fs):
    """RBJ peaking equaliser as one second-order section."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * f0 / fs
    al = np.sin(w0) / (2 * q)
    b = np.array([1 + al * A, -2 * np.cos(w0), 1 - al * A])
    a = np.array([1 + al / A, -2 * np.cos(w0), 1 - al / A])
    return signal.tf2sos(b / a[0], a / a[0])


def walk(rng, n, fs, band, comps=3):
    """Smooth random walk in [-1, 1]: a sum of `comps` sinusoids at rates drawn from `band` (Hz)."""
    t = np.arange(n) / fs
    f = rng.uniform(band[0], band[1], comps)
    a = rng.uniform(0.5, 1.0, comps)
    ph = rng.uniform(0, 2 * np.pi, comps)
    w = np.zeros(n)
    for k in range(comps):
        w += a[k] * np.sin(2 * np.pi * f[k] * t + ph[k])
    return w / a.sum()


def fade_curve(n, n_in, n_out, shape):
    """Fade-in / fade-out gain curve. equal_power: sin / cos quarter waves (independent overlapping segments keep
    constant power); raised_cosine: Hann halves."""
    e = np.ones(n)
    if n_in > 0:
        u = np.arange(n_in) / n_in
        e[:n_in] = np.sin(0.5 * np.pi * u) if shape == 'equal_power' else 0.5 - 0.5 * np.cos(np.pi * u)
    if n_out > 0:
        u = (np.arange(n_out) + 1) / n_out
        e[n - n_out:] *= np.cos(0.5 * np.pi * u) if shape == 'equal_power' else 0.5 + 0.5 * np.cos(np.pi * u)
    return e


def rc_ramp(n, rising=True):
    u = np.arange(n) / max(n, 1)
    r = 0.5 - 0.5 * np.cos(np.pi * u)
    return r if rising else r[::-1]


def _apply(x, g):
    return x * (g[:, None] if x.ndim == 2 else g)


# ---------------------------------------------------------------------------------------------- reference bed

@functools.lru_cache(maxsize=2)
def reference_bed(spec_path=SPEC_PATH):
    """Reference bed for gates V10 / V16: the hollow dry synthesis (no walks), 20 s mono, scaled to the
    AmbientSounds bed median (-29 LUFS)."""
    spec = load_spec(spec_path)
    fs = spec['fs']
    lay = spec['layers']['L1']
    src = lay['source']
    n = 20 * fs
    seed = fnv1a32('hollow/reference')
    s = src['pink'] * noise(rng_for(seed, 1), n, 'pink', fs, spec['chain']['G2_floor_hz']) + \
        src['brown'] * noise(rng_for(seed, 2), n, 'brown', fs, spec['chain']['G2_floor_hz'])
    s = guards(s, spec)
    s = signal.sosfilt(_butter(src['lp_order'], lay['states']['dry']['lp_hz'], 'lowpass', fs), s)
    s = signal.sosfilt(peaking_sos(src['peak_hz'], src['peak_db'], src['peak_q'], fs), s)
    s = s[fs:]   # drop the filter start-up second
    target = spec['reference']['ambientsounds_bed_median_lufs']
    return s * 10 ** ((target - pm.integrated_lufs(s, fs)) / 20)


def ref_band_rms(lo, hi, spec_path=SPEC_PATH):
    spec = load_spec(spec_path)
    b = pm.bandpass(reference_bed(spec_path), spec['fs'], lo, hi)[spec['fs'] // 2:]
    return pm.rms(b)


def leff_gain(vol, d, att, eps=1e-6):
    """Linear gain of the vanilla linear distance model with volume (TDD 2.3.4 L_eff)."""
    return min(vol, 1.0) * max(eps, 1.0 - d / (max(vol, 1.0) * att))


def whisper_snr_db(x, spec, spec_path=SPEC_PATH):
    """Gate V10 quantity: 300-3400 Hz whisper-to-bed ratio at the reference geometry (dB)."""
    g = spec['gates']['V10']
    geo = spec['reference']['whisper_geometry']
    lo, hi = g['band_hz']
    wr, _ = pm.active_band_rms(x, spec['fs'], lo, hi, g['active_floor_db'])
    br = ref_band_rms(lo, hi, spec_path)
    return 20 * np.log10(max(leff_gain(geo['vol'], geo['d'], geo['att']) * wr, 1e-12) / br)


def tell_margin_db(x, spec, spec_path=SPEC_PATH):
    """Gate V16 quantity: tell band level at 12 blocks (att 24, vol 1) minus the reference bed band level (dB)."""
    g = spec['gates']['V16']
    geo = spec['reference']['tell_geometry']
    lo, hi = g['band_hz']
    tr, _ = pm.span_band_rms(x, spec['fs'], lo, hi)
    br = ref_band_rms(lo, hi, spec_path)
    return 20 * np.log10(max(leff_gain(geo['vol'], geo['d'], geo['att']) * tr, 1e-12) / br)


# ---------------------------------------------------------------------------------------------- layers

def _hollow_source(spec, seed, n, stream):
    lay = spec['layers']['L1']
    src = lay['source']
    fs = spec['fs']
    fl = spec['chain']['G2_floor_hz']
    s = src['pink'] * noise(rng_for(seed, 10 * stream + 1), n, 'pink', fs, fl) + \
        src['brown'] * noise(rng_for(seed, 10 * stream + 2), n, 'brown', fs, fl)
    return guards(s, spec)


def _hollow_filter(spec, s, fc_path):
    src = spec['layers']['L1']['source']
    fs = spec['fs']
    y = tv_lowpass(s, fc_path, src['lp_order'], fs)
    return signal.sosfilt(peaking_sos(src['peak_hz'], src['peak_db'], src['peak_q'], fs), y)


def synth_hollow(spec, a, c):
    """L1 segment (mono) or bed (stereo, independent channel seeds): 60% pink + 40% brown, LP BW2 with a +-30%
    walk, -4 dB peak at 2.5 kHz, a slow level walk solved for LRA 3 LU, equal-power fades."""
    fs = spec['fs']
    lay = spec['layers']['L1']
    src = lay['source']
    dur = float(a['variant']['dur'])
    n = int(round(dur * fs))
    fc0 = lay['states'][c['state']]['lp_hz']
    w_lp = walk(rng_for(a['seed'], 3), n, fs, src['walk_hz'])
    fc = fc0 * (1 + src['lp_walk'] * w_lp)
    chans = [_hollow_filter(spec, _hollow_source(spec, a['seed'], n, k), fc) for k in range(c['channels'])]
    x = np.stack(chans, axis=1) if c['channels'] == 2 else chans[0]
    fade = fade_curve(n, int(round(c['fade_in_s'] * fs)), int(round(c['fade_out_s'] * fs)), c['fade'])
    lw = src['level_walk']
    target, tol, dmax = lw['target_lra'], lw['tol'], lw['max_db']
    v15 = spec['gates']['V15']['comfort']
    seg = c['kind'] == 'segment'
    band = lw['segment_hz'] if seg else lw['bed_hz']
    best = None
    for attempt in range(16):
        # segments: one slow swell (a single sinusoid); beds: a 3-component walk
        w_lv = walk(rng_for(a['seed'], 20 + attempt), n, fs, band, 1 if seg else 3)

        def build(D):
            return _apply(x, 10 ** (D * w_lv / 20) * fade)

        def L(D):
            return pm.lra(build(D), fs)
        lo, hi = 0.0, dmax
        l_lo, l_hi = L(lo), L(hi)
        if l_lo >= target:
            D, got = 0.0, l_lo
        elif l_hi <= target:
            D, got = dmax, l_hi
        else:
            D, got = hi, l_hi
            for _ in range(14):
                mid = 0.5 * (lo + hi)
                lm = L(mid)
                if lm < target:
                    lo = mid
                else:
                    hi, D, got = mid, mid, lm
                if abs(got - target) <= 0.05:
                    break
        y = build(D)
        # keep clear of V15 (comfort: +6 LU per 2 s) and V2 (M-max - I <= 4) with margin
        rise = pm.rise_after(y, fs, c['fade_in_s'], v15['window_s'])[0]
        mmi = pm.momentary_max(y, fs) - pm.integrated_lufs(y, fs)
        if rise > v15['max_lu'] - 1.5 or mmi > c['mmax_minus_i_max'] - 0.5:
            continue
        cand = (abs(got - target), attempt, D, got)
        if best is None or cand < best:
            best, best_y = cand, y
        if abs(got - target) <= tol:
            break
    if best is None:
        raise ValueError('%s: no level walk meets LRA, V15 and M-max limits' % a['name'])
    _, attempt, D, got = best
    y = best_y
    return y, {'lp_hz': fc0, 'level_walk_db': round(D, 4), 'lra_design': round(got, 3), 'walk_attempt': attempt,
               'fade_in_s': c['fade_in_s'], 'fade_out_s': c['fade_out_s']}


def synth_transition(spec, a, c):
    """L1 baked transition segment: steady from-state, a 1.5 s raised-cosine sweep of the LP cutoff (log) and of
    the gain (dB) to the to-state, steady to-state; equal-power fades. Section levels are set by construction."""
    fs = spec['fs']
    lay = spec['layers']['L1']
    src = lay['source']
    A, B = lay['states'][c['from']], lay['states'][c['to']]
    dur = float(a['variant']['dur'])
    n = int(round(dur * fs))
    s = _hollow_source(spec, a['seed'], n, 0)
    w_lp = walk(rng_for(a['seed'], 3), n, fs, src['walk_hz'])
    fcA = A['lp_hz'] * (1 + src['lp_walk'] * w_lp)
    fcB = B['lp_hz'] * (1 + src['lp_walk'] * w_lp)
    gA = A['lufs'] - pm.integrated_lufs(_hollow_filter(spec, s, fcA)[fs:], fs)
    gB = B['lufs'] - pm.integrated_lufs(_hollow_filter(spec, s, fcB)[fs:], fs)
    t = np.arange(n) / fs
    u = np.clip((t - c['sweep_start_s']) / c['sweep_s'], 0.0, 1.0)
    sw = 0.5 - 0.5 * np.cos(np.pi * u)
    fc = np.exp(np.log(fcA) * (1 - sw) + np.log(fcB) * sw)
    g_db = gA * (1 - sw) + gB * sw
    y = _hollow_filter(spec, s, fc) * 10 ** (g_db / 20)
    y *= fade_curve(n, int(round(c['fade_in_s'] * fs)), int(round(c['fade_out_s'] * fs)), c['fade'])
    head = [c['fade_in_s'], c['sweep_start_s']]
    tail = [c['sweep_start_s'] + c['sweep_s'], dur - c['fade_out_s']]
    return y, {'from': c['from'], 'to': c['to'], 'from_lufs': A['lufs'], 'to_lufs': B['lufs'], 'head_s': head, 'tail_s': tail,
               'fade_in_s': c['fade_in_s'], 'fade_out_s': c['fade_out_s'], 'section_target': True}


def synth_undertone(spec, a, c):
    """L2: cosine-phase harmonic tiers on f0 (amplitude 1/sqrt(n), tier gains 0/-6/-18 dB), phases pre-compensated
    for G3-G5 so the stack is in cosine phase at the output; breathing AM 0.1 Hz depth 0.2; fades 3 s / 4 s."""
    fs = spec['fs']
    v = a['variant']
    f0, dur = float(v['f0']), float(v['dur'])
    n = int(round(dur * fs))
    t = np.arange(n) / fs
    x = np.zeros(n)
    for tier in c['tiers']:
        g = 10 ** (tier['db'] / 20)
        for h in range(tier['h'][0], tier['h'][1] + 1):
            x += g * np.cos(2 * np.pi * h * f0 * t - guards_phase(h * f0, spec)) / np.sqrt(h)
    x = guards(x, spec)
    ph = rng_for(a['seed'], 0).uniform(0, 2 * np.pi)
    x *= 1 + c['breath_depth'] * np.sin(2 * np.pi * c['breath_hz'] * t + ph)
    x *= fade_curve(n, int(round(c['fade_in_s'] * fs)), int(round(c['fade_out_s'] * fs)), c['fade'])
    return x, {'f0': f0, 'breath_phase': round(float(ph), 6), 'fade_in_s': c['fade_in_s'], 'fade_out_s': c['fade_out_s']}


def pulse_carrier(spec, seed, n, c, plan=None):
    """The unmodulated L3 carrier after G3-G5 (80 Hz sine + 2-pole narrowband noise, or the Rough carrier), exactly
    as synth_pulse builds it from the asset seed. verify.py uses it as the carrier reference that measures the
    decoded file's modulation depth m (TDD comfort rule: heartbeat_c m <= 0.3)."""
    fs = spec['fs']
    lay = spec['layers']['L3']
    t = np.arange(n) / fs
    plan = rng_for(seed, 0) if plan is None else plan
    car = lay['carrier_rough'] if c.get('rough') else lay['carrier']
    sine = np.sin(2 * np.pi * car['sine_hz'] * t + plan.uniform(0, 2 * np.pi))
    wn = noise(rng_for(seed, 1), n, 'white', fs, spec['chain']['G2_floor_hz'])
    if c.get('rough'):
        nz = signal.sosfilt(_butter(2, (250.0, 400.0), 'bandpass', fs), wn)
    else:
        b, aa = signal.iirpeak(135.0, 135.0 / 40.0, fs=fs)
        nz = signal.lfilter(b, aa, wn)
    nz = nz / pm.rms(nz) * pm.rms(sine) * 10 ** (car['noise_db'] / 20)
    return guards(sine + nz, spec), car


def heartbeat_train(n, fs, rate, off, c):
    """Heartbeat pulse train P(t) in [0, 1]: raised-cosine pulses of c['pulse_s'], a lub at off + k / rate and a dub
    c['lub_dub_s'] later at c['dub_db']. The envelope is 1 + m (2P - 1)."""
    t = np.arange(n) / fs
    dur = n / fs
    P = np.zeros(n)
    w = c['pulse_s']
    dub = 10 ** (c['dub_db'] / 20)
    k = -1
    while True:
        t0 = off + k / rate
        if t0 - w > dur:
            break
        for dt, amp in ((0.0, 1.0), (c['lub_dub_s'], dub)):
            tc = t0 + dt
            i0, i1 = max(0, int((tc - w / 2) * fs)), min(n, int((tc + w / 2) * fs) + 1)
            if i1 > i0:
                seg = amp * (0.5 + 0.5 * np.cos(2 * np.pi * (t[i0:i1] - tc) / w))
                seg[np.abs(t[i0:i1] - tc) > w / 2] = 0.0
                P[i0:i1] = np.maximum(P[i0:i1], seg)
        k += 1
    return P


def synth_pulse(spec, a, c):
    """L3: 80 Hz sine + 2-pole narrowband noise at 110-160 Hz (-6 dB), or for Rough a 300 Hz sine + 250-400 Hz band
    noise; heartbeat double pulse (lub-dub 120 ms, dub -3 dB) or sinusoidal AM; depth m = (max-min)/(max+min)."""
    fs = spec['fs']
    v = a['variant']
    dur = float(v['dur'])
    n = int(round(dur * fs))
    t = np.arange(n) / fs
    plan = rng_for(a['seed'], 0)
    x, car = pulse_carrier(spec, a['seed'], n, c, plan)
    m = float(c['m'])
    info = {'carrier_hz': car['sine_hz'], 'm': m}
    if c['mod'] == 'heartbeat':
        r = float(v['rate'])
        off = plan.uniform(0, 1.0 / r)
        P = heartbeat_train(n, fs, r, off, c)
        e = 1 + m * (2 * P - 1)
        info.update({'rate': r, 'phase_s': round(float(off), 6)})
    else:
        fm = float(v['fm'])
        ph = plan.uniform(0, 2 * np.pi)
        e = 1 + m * np.sin(2 * np.pi * fm * t + ph)
        info.update({'fm': fm})
    x = x * e * fade_curve(n, int(round(c['fade_in_s'] * fs)), int(round(c['fade_out_s'] * fs)), c['fade'])
    info.update({'fade_in_s': c['fade_in_s'], 'fade_out_s': c['fade_out_s']})
    return x, info


def synth_beat(spec, a, c):
    """L4: two equal sines f1, f1 + delta (monaural beat); optional beating 2nd-harmonic pair at -12 dB with the
    same null times; fades 3 s / 4 s."""
    fs = spec['fs']
    v = a['variant']
    f1, d, dur = float(v['f1']), float(v['delta']), float(v['dur'])
    n = int(round(dur * fs))
    t = np.arange(n) / fs
    plan = rng_for(a['seed'], 0)
    ph = plan.uniform(0, 2 * np.pi)
    x = np.sin(2 * np.pi * f1 * t + ph) + np.sin(2 * np.pi * (f1 + d) * t + ph)
    if v.get('harm2'):
        ph2 = plan.uniform(0, 2 * np.pi)
        g = 10 ** (c['harm2']['db'] / 20)
        x += g * (np.sin(2 * np.pi * 2 * f1 * t + ph2) + np.sin(2 * np.pi * (2 * f1 + d) * t + ph2))
    x = guards(x, spec)
    x *= fade_curve(n, int(round(c['fade_in_s'] * fs)), int(round(c['fade_out_s'] * fs)), c['fade'])
    return x, {'f1': f1, 'delta': d, 'harm2': bool(v.get('harm2')), 'fade_in_s': c['fade_in_s'], 'fade_out_s': c['fade_out_s']}


def synth_whisper(spec, a, c):
    """L5: white noise into three parallel 2-pole resonators (formants glide +-10% per burst), a randomly gated
    4-8 kHz sibilance band (BW4, -12 dB), syllabic AM (index 0.45, 3.5-5 Hz), bursts 150-450 ms with 20 ms attack /
    80 ms release, 2-5 bursts per phrase with 80-250 ms gaps. Never words: no consonant or vowel sequencing."""
    fs = spec['fs']
    vo = spec['layers']['L5']['voice']
    pr = vo['plan_redraw']
    win = spec['gates']['V15']['comfort']['window_s']
    fade_in = vo['pad_in_s'] + vo['attack_s']
    centre = c['snr_db'] + pr['lufs_offset']
    for attempt in range(64):
        y, bursts = _whisper_render(spec, a, vo, rng_for(a['seed'], 0 if attempt == 0 else 100 + attempt))
        if pm.rise_after(y, fs, fade_in, win)[0] > pr['max_comfort_rise_lu']:
            continue
        k = 10 ** ((c['snr_db'] - whisper_snr_db(y, spec)) / 20)
        if abs(pm.integrated_lufs(y * k, fs) - centre) <= pr['lufs_window']:
            break
    else:
        raise ValueError('%s: no phrase plan within the comfort rise and pool-centre limits' % a['name'])
    return y, {'bursts': bursts, 'plan_attempt': attempt, 'fade_in_s': round(fade_in, 5),
               'fade_out_s': round(vo['pad_out_s'] + vo['release_s'], 5)}


def _whisper_render(spec, a, vo, plan):
    bursts, dur = _whisper_plan(vo, plan)
    n = int(round(dur * spec['fs']))
    return whisper_synth(spec, a['seed'], bursts, n), bursts


def _whisper_plan(vo, plan):
    """Draw one phrase plan: 2-5 bursts with their formants, glide, syllabic rate and phase, sibilance windows.
    Values are rounded as recorded in the render log, and the synthesis reads the rounded values, so a recorded
    plan re-synthesises exactly (verify.py's syllabic-AM reference)."""
    nb = int(plan.integers(vo['bursts'][0], vo['bursts'][1] + 1))
    bursts = []
    t0 = vo['pad_in_s']
    for i in range(nb):
        d = float(plan.uniform(*vo['burst_s']))
        fr = [float(plan.uniform(*f['hz'])) for f in vo['formants']]
        glide = float(plan.uniform(1 - vo['glide'], 1 + vo['glide']))
        syl = float(plan.uniform(*vo['syllabic_hz']))
        sph = float(plan.uniform(0, 2 * np.pi))
        nwin = int(plan.integers(vo['sibilance']['gate_windows'][0], vo['sibilance']['gate_windows'][1] + 1))
        wins = []
        for _ in range(nwin):
            wl = float(plan.uniform(*vo['sibilance']['gate_s']))
            ws = float(plan.uniform(0, max(1e-3, d - wl)))
            wins.append([round(ws, 5), round(wl, 5)])
        bursts.append({'t0': round(t0, 5), 'dur': round(d, 5), 'formants': [round(q, 3) for q in fr], 'glide': round(glide, 5),
                       'syl_hz': round(syl, 4), 'syl_phase': round(sph, 5), 'sib': wins})
        t0 += d
        if i < nb - 1:
            t0 += float(plan.uniform(*vo['gap_s']))
    return bursts, t0 + vo['pad_out_s']


def whisper_synth(spec, seed, bursts, n, syllabic_depth=None):
    """Synthesise a whisper phrase of n samples from a (recorded) burst plan. syllabic_depth None = the spec's
    index (0.45); 0 = the same phrase without the syllabic AM, which verify.py divides out to measure the AM."""
    fs = spec['fs']
    vo = spec['layers']['L5']['voice']
    depth = vo['syllabic_depth'] if syllabic_depth is None else float(syllabic_depth)
    exc = guards(noise(rng_for(seed, 1), n, 'white', fs, spec['chain']['G2_floor_hz']), spec)
    sib_src = pm.bandpass(exc, fs, vo['sibilance']['band_hz'][0], vo['sibilance']['band_hz'][1], vo['sibilance']['order'])[:, 0]
    y = np.zeros(n)
    for b in bursts:
        i0 = int(round(b['t0'] * fs))
        m = int(round(b['dur'] * fs))
        seg = exc[i0:i0 + m]
        m = len(seg)
        tt = np.arange(m) / fs
        u = tt / b['dur']
        fa = np.zeros(m)
        fb = np.zeros(m)
        for f, fc in zip(vo['formants'], b['formants']):
            g = 10 ** (f['db'] / 20)
            bb, aa = signal.iirpeak(fc, fc / f['bw'], fs=fs)
            fa += g * signal.lfilter(bb, aa, seg)
            fc2 = fc * b['glide']
            bb, aa = signal.iirpeak(fc2, fc2 / f['bw'], fs=fs)
            fb += g * signal.lfilter(bb, aa, seg)
        voice = fa * (1 - u) + fb * u
        voice /= max(pm.rms(voice), 1e-12)
        sib = sib_src[i0:i0 + m] / max(pm.rms(sib_src[i0:i0 + m]), 1e-12) * 10 ** (vo['sibilance']['db'] / 20)
        gate = np.zeros(m)
        r = int(round(vo['sibilance']['ramp_s'] * fs))
        for ws, wl in b['sib']:
            s0, s1 = int(ws * fs), min(m, int((ws + wl) * fs))
            if s1 - s0 > 2 * r:
                gate[s0:s1] = 1.0
                gate[s0:s0 + r] = rc_ramp(r)
                gate[s1 - r:s1] = rc_ramp(r, False)
        syl = 1 + depth * np.cos(2 * np.pi * b['syl_hz'] * tt + b['syl_phase'])
        env = np.ones(m)
        na, nr = int(round(vo['attack_s'] * fs)), int(round(vo['release_s'] * fs))
        env[:na] = rc_ramp(na)
        env[m - nr:] *= rc_ramp(nr, False)
        y[i0:i0 + m] += (voice + sib * gate) * syl * env
    return y


def synth_approach(spec, a, c):
    """L6 looming: pink noise (HP 40 Hz BW4) + 55 Hz-rooted buzz (harmonics 2-8), 1st-order LP swept exponentially,
    gain rise quadratic (normal, +6 dB) or linear in dB (comfort, +4 dB); 100 ms fade-in, 30 ms end fade, 30 ms pad."""
    fs = spec['fs']
    src = spec['layers']['L6']['source']
    T = float(a['variant']['T'])
    n = int(round(T * fs))
    t = np.arange(n) / fs
    nz = noise(rng_for(a['seed'], 1), n, 'pink', fs, spec['chain']['G2_floor_hz'])
    buzz = np.zeros(n)
    for k in range(src['buzz_harmonics'][0], src['buzz_harmonics'][1] + 1):
        buzz += (1.0 / k) * np.sin(2 * np.pi * src['buzz_hz'] * k * t)
    buzz /= np.std(buzz)
    nz, buzz = guards(nz, spec), guards(buzz, spec)
    nz = signal.sosfilt(_butter(src['noise_hp_order'], src['noise_hp_hz'], 'highpass', fs), nz)
    x = src['mix_noise'] * nz / np.std(nz) + src['mix_buzz'] * buzz
    f0, f1 = c['lp_hz']
    fc = f0 * (f1 / f0) ** (t / T)
    al = np.exp(-2 * np.pi * fc / fs)
    y = np.empty(n)
    s = 0.0
    for i in range(n):
        s = (1 - al[i]) * x[i] + al[i] * s
        y[i] = s
    uu = t / T
    g_db = -c['rise_db'] * (1 - uu ** 2) if c['curve'] == 'quad' else -c['rise_db'] * (1 - uu)
    y *= 10 ** (g_db / 20)
    fi = int(round(src['fade_in_s'] * fs))
    y[:fi] *= rc_ramp(fi)
    fo = int(round(src['end_fade_s'] * fs))
    y[-fo:] *= np.linspace(1, 0, fo)
    y = np.concatenate([y, np.zeros(int(round(src['pad_out_s'] * fs)))])
    return y, {'T': T, 'rise_db': c['rise_db'], 'curve': c['curve'], 'lp_hz': list(c['lp_hz']),
               'fade_in_s': src['fade_in_s'], 'fade_out_s': src['end_fade_s'] + src['pad_out_s']}


def synth_spike(spec, a, c):
    """L7 stinger (normal mode only): minor-second / tritone cluster + noise burst (HP 60 Hz BW2), roughness AM
    50 Hz depth 0.5, 25 ms attack, exponential decay tau 350 ms, 50 ms end fade."""
    fs = spec['fs']
    v = a['variant']
    f, dur = float(v['f']), float(v['dur'])
    n = int(round(dur * fs))
    t = np.arange(n) / fs
    plan = rng_for(a['seed'], 0)
    cl = np.zeros(n)
    for ratio in (1.0, 2 ** (1 / 12), 2 ** (6 / 12)):
        cl += np.sin(2 * np.pi * f * ratio * t + plan.uniform(0, 2 * np.pi))
    cl /= np.std(cl)
    nz = noise(rng_for(a['seed'], 1), n, 'white', fs, spec['chain']['G2_floor_hz'])
    nz, cl = guards(nz, spec), guards(cl, spec)
    nz = signal.sosfilt(_butter(c['noise_hp_order'], c['noise_hp_hz'], 'highpass', fs), nz)
    x = c['mix_noise'] * nz / np.std(nz) + c['mix_cluster'] * cl
    x *= 1 + c['am_depth'] * np.sin(2 * np.pi * c['am_hz'] * t + plan.uniform(0, 2 * np.pi))
    na = int(round(c['attack_s'] * fs))
    env = np.exp(-np.maximum(t - c['attack_s'], 0.0) / c['tau_s'])
    env[:na] *= rc_ramp(na)
    fo = int(round(c['end_fade_s'] * fs))
    env[-fo:] *= rc_ramp(fo, False)
    y = np.concatenate([x * env, np.zeros(int(round(c['pad_out_s'] * fs)))])
    return y, {'f': f, 'cluster_hz': [round(f, 3), round(f * 2 ** (1 / 12), 3), round(f * 2 ** 0.5, 3)],
               'fade_in_s': c['attack_s'], 'fade_out_s': c['end_fade_s'] + c['pad_out_s'], 'attack_exempt': True}


def synth_tell(spec, a, c):
    """L8 tell: 3-6 dry chitter clicks (15-40 ms, 2 ms attack, exponential decay), onsets 80-140 ms apart,
    band-pass BW4 2.0-3.2 kHz on the click train; silent pads at both edges; total 0.4-0.8 s."""
    fs = spec['fs']
    v = a['variant']
    plan = rng_for(a['seed'], 0)
    k = int(v['clicks'])
    clicks = []
    t0 = c['pad_in_s']
    for i in range(k):
        d = float(plan.uniform(*c['click_s']))
        clicks.append([round(t0, 5), round(d, 5)])
        if i < k - 1:
            t0 += max(float(plan.uniform(*c['spacing_s'])), d + 0.02)
    end = clicks[-1][0] + clicks[-1][1] + c['pad_out_s']
    dur = max(end, c['dur_range'][0] + 0.05)
    n = int(round(dur * fs))
    wn = guards(noise(rng_for(a['seed'], 1), n, 'white', fs, spec['chain']['G2_floor_hz']), spec)
    train = np.zeros(n)
    na = int(round(c['click_attack_s'] * fs))
    for cs, d in clicks:
        i0 = int(round(cs * fs))
        m = int(round(d * fs))
        tt = np.arange(m) / fs
        e = np.exp(-4.0 * tt / d)
        e[:na] *= rc_ramp(na)
        e[-min(m, 48):] *= rc_ramp(min(m, 48), False)
        train[i0:i0 + m] += wn[i0:i0 + m] * e
    y = pm.bandpass(train, fs, c['band_hz'][0], c['band_hz'][1], c['band_order'])[:, 0]
    tail = int(round(c['pad_out_s'] * 0.5 * fs))
    y[n - tail:] *= rc_ramp(tail, False)   # the band-pass ring-out ends well inside the silent pad
    return y, {'clicks': clicks, 'fade_in_s': c['pad_in_s'], 'fade_out_s': c['pad_out_s']}


SYNTH = {'segment': synth_hollow, 'bed': synth_hollow, 'transition': synth_transition, 'undertone': synth_undertone,
         'pulse': synth_pulse, 'beat': synth_beat, 'whisper': synth_whisper, 'approach': synth_approach,
         'spike': synth_spike, 'tell': synth_tell}


# ---------------------------------------------------------------------------------------------- G8 / G9 / G10

def limiter(x, fs, ceiling_dbtp=-2.0, lookahead_ms=5.0, release_ms=50.0, os_factor=4):
    """Look-ahead true-peak limiter. The gain is the look-ahead minimum of the required gain, smoothed so that it
    reaches the minimum before each peak (attack = look-ahead), then released with a one-pole of release_ms.
    Returns (y, max gain reduction in dB). No reduction at all when the true peak is already under the ceiling."""
    c = 10 ** (ceiling_dbtp / 20)
    p = pm.true_peak_envelope(x, os_factor)
    if p.max() <= c:
        return x.copy(), 0.0
    L = max(1, int(round(lookahead_ms * 1e-3 * fs)))
    ar = math.exp(-1.0 / (release_ms * 1e-3 * fs))
    eff = c
    y, gr = x, 0.0
    for _ in range(6):
        greq = np.minimum(1.0, eff / np.maximum(p, 1e-12))
        gmin = ndimage.minimum_filter1d(greq, 2 * L + 1, mode='nearest')
        g = np.minimum(ndimage.uniform_filter1d(gmin, L | 1, mode='nearest'), greq)
        out = np.ones_like(g)
        idx = np.nonzero(g < 1.0)[0]
        if idx.size:
            a0 = idx[0]
            a1 = min(len(g), idx[-1] + int(12 * release_ms * 1e-3 * fs))
            prev = g[a0]
            seg = g[a0:a1]
            res = np.empty_like(seg)
            for i in range(len(seg)):
                v = seg[i]
                prev = v if v < prev else prev + (1 - ar) * (v - prev)
                res[i] = prev
            out[a0:a1] = res
        y = _apply(x, out)
        gr = float(-20 * np.log10(out.min()))
        tp = pm.true_peak_dbtp(y, fs, os_factor)
        if tp <= ceiling_dbtp + 0.005:
            break
        eff *= 10 ** ((ceiling_dbtp - tp - 0.01) / 20)
    return y, gr


def normalise(x, fs, target, lim, iters=3, converge=0.05):
    """G8 + G9: gain to the target LUFS-I, limit, re-measure; up to `iters` passes."""
    i0 = pm.integrated_lufs(x, fs)
    gain = target - i0
    y = x * 10 ** (gain / 20)
    yl, gr, lufs, it = y, 0.0, i0, 0
    for it in range(1, iters + 1):
        yl, gr = limiter(y, fs, lim['ceiling_dbtp'], lim['lookahead_ms'], lim['release_ms'], lim['oversample'])
        lufs = pm.integrated_lufs(yl, fs)
        if abs(lufs - target) <= converge:
            break
        y = y * 10 ** ((target - lufs) / 20)
        gain += target - lufs
    return yl, {'gain_db': round(gain, 4), 'limiter_gr_db': round(gr, 4), 'g8_iterations': it,
                'pre_lufs': round(lufs, 4), 'pre_tp_dbtp': round(pm.true_peak_dbtp(yl, fs), 4)}


_CRC = []
for _i in range(256):
    _r = _i << 24
    for _ in range(8):
        _r = ((_r << 1) ^ 0x04C11DB7) if _r & 0x80000000 else (_r << 1)
        _r &= 0xFFFFFFFF
    _CRC.append(_r)


def ogg_crc(data):
    crc = 0
    tab = _CRC
    for byte in data:
        crc = ((crc << 8) & 0xFFFFFFFF) ^ tab[((crc >> 24) ^ byte) & 0xFF]
    return crc


def set_ogg_serial(path, serial):
    """Rewrite the stream serial of every Ogg page and recompute the page CRCs (libsndfile picks a random serial).
    Checks each original CRC first, so a wrong CRC implementation can never corrupt a file silently."""
    with open(path, 'rb') as f:
        b = bytearray(f.read())
    pos = 0
    sb = int(serial).to_bytes(4, 'little')
    while pos < len(b):
        if b[pos:pos + 4] != b'OggS':
            raise ValueError('%s: not an Ogg page at byte %d' % (path, pos))
        nseg = b[pos + 26]
        plen = 27 + nseg + sum(b[pos + 27:pos + 27 + nseg])
        old = int.from_bytes(b[pos + 22:pos + 26], 'little')
        b[pos + 22:pos + 26] = b'\0\0\0\0'
        if ogg_crc(b[pos:pos + plen]) != old:
            raise ValueError('%s: page CRC mismatch at byte %d' % (path, pos))
        b[pos + 14:pos + 18] = sb
        b[pos + 22:pos + 26] = ogg_crc(b[pos:pos + plen]).to_bytes(4, 'little')
        pos += plen
    with open(path, 'wb') as f:
        f.write(bytes(b))


def compression_level(spec, c):
    """G10 quality: the chain default (0.3) unless the class carries a documented override."""
    return float(c.get('compression_level', spec['chain']['G10_encode']['compression_level']))


def _write_ogg(target, y, spec, level):
    enc = spec['chain']['G10_encode']
    ch = 1 if y.ndim == 1 else y.shape[1]
    # libsndfile's Vorbis writer overflows the stack when one call carries a long stereo buffer: write in blocks
    with sf.SoundFile(target, 'w', spec['fs'], ch, subtype=enc['subtype'], format=enc['format'], compression_level=level) as f:
        for s in range(0, y.shape[0], 4096):
            f.write(y[s:s + 4096])


def codec_roundtrip(y, spec, level):
    """Encode to memory with the G10 settings and decode again (what the game will play)."""
    buf = io.BytesIO()
    _write_ogg(buf, y, spec, level)
    buf.seek(0)
    d, _ = sf.read(buf, dtype='float64')
    return d


def encode(y, path, spec, serial, level):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    _write_ogg(path, y, spec, level)
    set_ogg_serial(path, serial)


def _clean(o):
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    if isinstance(o, (np.floating, float)):
        return round(float(o), 6)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    return o


def render_asset(a, spec_path=SPEC_PATH):
    """Synthesis through G9 for one asset. Returns (float64 signal, record)."""
    spec = load_spec(spec_path)
    fs = spec['fs']
    c = class_spec(spec, a['layer'], a['cls'])
    x, info = SYNTH[c['kind']](spec, a, c)
    min_fade = spec['chain']['G7_min_fade_s']
    if info['fade_out_s'] < min_fade - 1e-9 or (info['fade_in_s'] < min_fade - 1e-9 and not info.get('attack_exempt')):
        raise ValueError('%s: fade shorter than %.0f ms (G7)' % (a['name'], min_fade * 1000))
    if c['kind'] == 'whisper':
        snr = whisper_snr_db(x, spec, spec_path)
        k = 10 ** ((c['snr_db'] - snr) / 20)
        target = round(pm.integrated_lufs(x * k, fs), 2)
        info['v10_solve'] = {'snr_raw_db': round(snr, 4), 'snr_target_db': c['snr_db']}
    elif info.get('section_target'):
        target = round(pm.integrated_lufs(x, fs), 2)
    else:
        target = float(c['lufs'])
    lim = spec['chain']['G9_limiter']
    g8 = spec['chain']['G8']
    y, g = normalise(x, fs, target, lim, g8['iterations'], g8['converge_lu'])
    level = compression_level(spec, c)
    if c['kind'] != 'whisper':
        # G8 against the decoded file: Vorbis moves LUFS-I by about 0.1-0.2 LU, so re-gain through the codec
        eff = target
        for _ in range(2):
            dec = pm.integrated_lufs(codec_roundtrip(y, spec, level), fs)
            if abs(dec - target) <= 0.03:
                break
            eff += target - dec
            y, g = normalise(x, fs, eff, lim, g8['iterations'], g8['converge_lu'])
        g['g8_codec_target'] = round(eff, 4)
    if c['kind'] == 'whisper':
        # V10 on the decoded file: the codec drops some low-level content, so correct the target through it
        passes = []
        for _ in range(4):
            snr = whisper_snr_db(codec_roundtrip(y, spec, level), spec, spec_path)
            passes.append(round(snr, 4))
            if abs(snr - c['snr_db']) <= 0.05:
                break
            target = round(target + (c['snr_db'] - snr), 2)
            y, g = normalise(x, fs, target, lim, g8['iterations'], g8['converge_lu'])
        info['v10_solve']['decoded_passes_db'] = passes
    rec = {
        'event': a['event'], 'key': a['key'], 'file': a['file'], 'name': a['name'], 'layer': a['layer'], 'slug': a['slug'],
        'cls': a['cls'], 'v': a['v'], 'seed': a['seed'], 'channels': int(c['channels']), 'samples': int(y.shape[0]),
        'dur': round(y.shape[0] / fs, 6), 'target_lufs': target, 'tol': c['tol'], 'params': info,
        'compression_level': compression_level(spec, c),
        'float_sha256': hashlib.sha256(np.ascontiguousarray(y, dtype='<f8').tobytes()).hexdigest(),
    }
    rec.update(g)
    return y, _clean(rec)


def _worker(job):
    a, out_dir, wav, spec_path = job
    spec = load_spec(spec_path)
    t0 = time.time()
    y, rec = render_asset(a, spec_path)
    path = os.path.join(out_dir, 'ogg', a['file'])
    encode(y, path, spec, a['seed'] & 0x7FFFFFFF, compression_level(spec, class_spec(spec, a['layer'], a['cls'])))
    with open(path, 'rb') as f:
        rec['ogg_sha256'] = hashlib.sha256(f.read()).hexdigest()
    rec['ogg_bytes'] = os.path.getsize(path)
    if wav:
        wp = os.path.join(out_dir, 'wav', a['file'][:-4] + '.wav')
        os.makedirs(os.path.dirname(wp), exist_ok=True)
        sf.write(wp, y, spec['fs'], subtype='FLOAT')
    rec['render_s'] = round(time.time() - t0, 2)
    return rec


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--spec', default=SPEC_PATH)
    ap.add_argument('--out', default=DEFAULT_OUT)
    ap.add_argument('--only', default='', help='comma-separated fnmatch patterns on <slug>/<cls>_vNN')
    ap.add_argument('--fresh', action='store_true', help='ignore an existing render log')
    ap.add_argument('--wav', action='store_true', help='also write float32 WAVs to out/wav/')
    try:
        env_jobs = int(os.environ.get('PNE_JOBS', '0'))
    except ValueError:
        env_jobs = 0
    ap.add_argument('--jobs', type=int, default=env_jobs if env_jobs >= 1 else min(16, os.cpu_count() or 1),
                    help='worker processes (default: env PNE_JOBS, else min(16, CPUs))')
    args = ap.parse_args(argv)
    spec_path = os.path.abspath(args.spec)
    spec = load_spec(spec_path)
    assets = expand(spec)
    if args.only:
        pats = [p.strip() for p in args.only.split(',') if p.strip()]
        assets = [a for a in assets if any(fnmatch.fnmatch(a['name'], p) for p in pats)]
    os.makedirs(args.out, exist_ok=True)
    log_path = os.path.join(args.out, 'render_log.json')
    log = {}
    if os.path.isfile(log_path) and not args.fresh:
        try:
            with open(log_path, encoding='utf-8') as f:
                log = {r['key']: r for r in json.load(f)['assets']}
        except Exception:
            log = {}
    t0 = time.time()
    jobs = [(a, args.out, args.wav, spec_path) for a in assets]
    if args.jobs > 1 and len(jobs) > 1:
        # the long stereo beds first, so the pool finishes evenly
        jobs.sort(key=lambda j: -float(j[0]['variant'].get('dur', 1.0)) * class_spec(spec, j[0]['layer'], j[0]['cls'])['channels'])
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            recs = list(ex.map(_worker, jobs))
    else:
        recs = [_worker(j) for j in jobs]
    for r in recs:
        log[r['key']] = r
    valid = {a['key'] for a in expand(spec)}
    out = {'schema': 1, 'spec_sha256': lf_sha256(spec_path),
           'assets': [log[k] for k in sorted(log) if k in valid]}
    with open(log_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, indent=1, sort_keys=True)
        f.write('\n')
    gr = [r for r in recs if r['limiter_gr_db'] > 0]
    print('rendered %d asset(s) in %.1f s (%d with limiter gain reduction: %s)' % (
        len(recs), time.time() - t0, len(gr), ', '.join('%s %.2f dB' % (r['name'], r['limiter_gr_db']) for r in gr[:8])))
    return 0


if __name__ == '__main__':
    sys.exit(main())
