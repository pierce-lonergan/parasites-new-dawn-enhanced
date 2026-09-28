"""
verify.py: gates V1-V16 on the DECODED Resonance assets (TDD 2.6), plus the comfort envelope rule (CE, TDD 2.3.2)
and the G9 rule (0 dB limiter gain reduction on L2, L3 and L4). Writes a manifest with every metric and exits 1
on any failure.

    python tools/resonance/verify.py                verify out/ogg/ with out/render_log.json -> out/manifest.json
                                                   (every asset of the spec, the not-shipped stereo beds included)
    python tools/resonance/verify.py --install      the same and, only if every gate passes, copy the OGGs of the
                                                   classes that ship (render.ships: not the stereo beds, lead
                                                   decision 1.3, IMPLEMENTATION.md section 5) into
                                                   overrides/kubejs/assets/pne/sounds/res/ (every other res OGG is
                                                   removed) and the manifest of that shipped set to
                                                   tools/resonance/manifest.json; then run gen_sounds_json.py and
                                                   fail if anything stereo-bed is left under overrides/
    python tools/resonance/verify.py --committed    CI: the committed asset set is exactly the spec's shipped set
                                                   (no bed_* file, sounds.json entry or catalog event anywhere
                                                   under overrides/); verify the committed OGGs, taking the
                                                   render-time fields (seeds, solved targets, limiter gain
                                                   reduction) from the committed manifest; write the fresh
                                                   manifest to PNE_TMP and diff it against
                                                   tools/resonance/manifest.json
    --jobs N                                       worker processes (default: env PNE_JOBS, else min(4, CPUs)); a
                                                   worker that runs out of memory makes the run retry serially

Gate definitions (spec/layers.json "gates" holds the limits; tdd_pins.py holds the TDD comfort and rate/depth caps
that a spec edit must not be able to relax):
  V1  OGG Vorbis, 48 kHz, 1 channel (2 only for the AmbientSounds beds, which stay in the build folder)
  V2  LUFS-I within tolerance of the target (whispers: the V10-solved target; transitions: head and tail sections
      at their state targets, drop <= min(|from - to| + tol, max_drop_lu): the vacuum segment drops <= 6 LU),
      M-max caps (absolute or relative), beds LRA 2-4 LU and M-max - I <= 4, L2-L5 M-max - I <= 6, no file above
      M-max -13 (M-max on a 10 ms hop)
  V3  true peak <= -1.0 dBTP (4x) and every |sample| < 0.999
  V4  unweighted FFT energy from 0 Hz (DC included) to 20 Hz <= -35 dB re total, worst channel
  V5  power below 100 Hz <= 0.6 of total, except throb assets (L2, L3)
  V6  L2: envelope spectrum peak = f0 +- 0.2 Hz and inside the TDD 17-21 Hz; per-cycle envelope depth >= 0.7;
      limiter reduction 0 dB
  V7  L3 flutter/rough: sideband spacing 2 fm +- 0.2 Hz (fm inside the TDD: flutter 6 Hz, rough 30-70 Hz); sideband
      level 20 log10(m/2) +- 1 dB and at most 20 log10(0.6/2) + 1 dB (TDD m <= 0.6); rough carrier >= 250 Hz
  V8  L3 heartbeat: envelope periodicity peak = pulse rate +- 0.05 Hz and inside the TDD 1.0-1.4 Hz (+-0.05);
      modulation depth m, measured by a least-squares fit onto the carrier re-synthesised from the recorded seed,
      <= 0.6 (heartbeat_c, the comfort class: <= 0.3, and <= 8 s), with a small model residual
  V9  L4: envelope peak = delta +- 0.1 Hz and inside the TDD range (slow 0.5-1.5, tense 4-7 Hz; comfort <= 2 Hz);
      depth >= 0.85
  V10 L5: 300-3400 Hz whisper-to-bed ratio at the reference geometry within +-1 dB of the tier target
  V11 duration within the spec range; first and last 20 ms RMS >= 20 dB under the whole-file RMS (L7: last only);
      director layers <= 10 s
  V12 pool loudness spread <= 3 LU
  V13 static decoded PCM (16-bit, non-streamed files) <= 64,000,000 bytes; stream exactly for files > 10 s;
      <= 4 streamed classes per director state; director layers (12 blocks up, att 128) fall <= 5 dB at sprint speed
  V14 crest factor, spectral centroid and the top 5 spectral peaks recorded
  V15 largest momentary / short-term rise after the onset fade, curves on a 10 ms hop: normal assets <= 10 LU per
      3 s, comfort assets <= 6 LU per 2 s (assets for both modes meet both); L7 exempt; not applicable when the
      windows after the onset fade span < 0.1 s (a 0.45 s tell): the onset step is the catalog's mmax, a ledger input
  V16 L8: tell exceeds the reference bed by >= 6 dB in 2.0-3.2 kHz at 12 blocks, att 24, volume 1
  CE  comfort assets: no envelope line above 2 Hz with sinusoid-equivalent depth > 0.5. L5: the syllabic AM is
      measured per burst against the phrase re-synthesised without it (binding). The L5 phrase-level burst gating
      and the L8 click train are measured and reported as PENDING a lead decision (tdd_pins.PENDING_CE), never as
      passes
  G9  L2, L3, L4: limiter gain reduction exactly 0 dB (render-time record)
"""
import argparse
import hashlib
import json
import math
import multiprocessing
import os
import re
import shutil
import subprocess
import sys
import tempfile
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pne_meter as pm  # noqa: E402
import render as R  # noqa: E402
import tdd_pins as T  # noqa: E402

ASSETS_DIR = os.path.join(ROOT, 'overrides', 'kubejs', 'assets', 'pne', 'sounds')
COMMITTED_MANIFEST = os.path.join(HERE, 'manifest.json')
# a stereo-bed reference in a text file: sounds.json key or sound name (res.hollow.bed_dry.v01, pne:res/hollow/bed_dry_v01)
# or catalog event id (pne:res.hollow.bed_dry.v01)
BED_REF_RX = re.compile(r'res[./][a-z0-9_]+[./]' + R.BED_PREFIX + r'[a-z0-9_]*')
BED_SCAN_TEXT = ('.json', '.js', '.mcmeta', '.txt', '.toml', '.snbt', '.properties', '.cfg')
BED_SCAN_AUDIO = ('.ogg', '.wav', '.flac', '.mp3')
GATE_ORDER = ['V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8', 'V9', 'V10', 'V11', 'V12', 'V13', 'V14', 'V15', 'V16', 'CE', 'G9']


def G(passed, margin=None, value=None, limit=None, detail='', na=False):
    r = {'pass': bool(passed), 'na': bool(na)}
    if margin is not None:
        r['margin'] = round(float(margin), 4)
    if value is not None:
        r['value'] = value if isinstance(value, (str, bool, list, dict)) else round(float(value), 4)
    if limit is not None:
        r['limit'] = limit
    if detail:
        r['detail'] = detail
    return r


def P(parts, value=None, limit=None, extra=''):
    """Multi-part gate: parts = [(label, margin, scale)]. Passes when every margin >= 0. The binding part is the
    one with the smallest margin relative to its scale; its margin is reported in its own unit (in the label)."""
    ok = all(p[1] >= 0 for p in parts)
    graded = [p for p in parts if p[2]] or parts   # scale None: an exact condition (for example GR == 0), never binding
    b = min(graded, key=lambda p: p[1] / (p[2] or 1.0))
    return G(ok, b[1], value=value, limit=limit, detail=('binding: %s' % b[0]) + (('; ' + extra) if extra else ''))


def NA(detail='not applicable'):
    return G(True, na=True, detail=detail)


def r4(v):
    return round(float(v), 4)


# ---------------------------------------------------------------------------------------------- gates

def v1_format(info, want_channels, g):
    ok_fmt = info['format'] == g['format'] and info['subtype'] == g['subtype']
    ok = ok_fmt and info['samplerate'] == g['fs'] and info['channels'] == want_channels
    return G(ok, value='%s/%s %d Hz %d ch' % (info['format'], info['subtype'], info['samplerate'], info['channels']),
             limit='%s/%s %d Hz %d ch' % (g['format'], g['subtype'], g['fs'], want_channels))


def v2_loudness(x, fs, c, kind, target, spec, params=None):
    """Returns (gate, metrics)."""
    I = pm.integrated_lufs(x, fs)
    M = pm.momentary_max(x, fs)
    met = {'lufs_i': r4(I), 'lufs_m_max': r4(M), 'lra': r4(pm.lra(x, fs)), 'mmax_minus_i': r4(M - I)}
    gmax = spec['gates']['global_mmax_max']
    parts = [('M-max <= %.0f' % gmax, gmax - M)]
    tol = float(c['tol'])
    if kind == 'transition':
        p = params or {}
        hs, ts = p['head_s'], p['tail_s']
        head = pm.integrated_lufs(x[int(hs[0] * fs):int(hs[1] * fs)], fs)
        tail = pm.integrated_lufs(x[int(ts[0] * fs):int(ts[1] * fs)], fs)
        A, B = float(p['from_lufs']), float(p['to_lufs'])
        met.update({'head_lufs': r4(head), 'tail_lufs': r4(tail), 'drop_lu': r4(head - tail)})
        # the vacuum segment carries the TDD's own number (2.3.3 L0 b: drop <= 6 LU), tighter than |A - B| + tol
        max_drop = min(abs(A - B) + tol, float(c.get('max_drop_lu', float('inf'))))
        parts += [('head at %.0f +-%.1f' % (A, tol), tol - abs(head - A)), ('tail at %.0f +-%.1f' % (B, tol), tol - abs(tail - B)),
                  ('drop <= %.1f' % max_drop, max_drop - (head - tail)),
                  ('M-max <= from + 4', A + 4 - M), ('LRA <= |from-to| + 4', abs(A - B) + 4 - met['lra'])]
    else:
        parts.append(('LUFS-I %.2f +-%.1f' % (target, tol), tol - abs(I - target)))
        if 'mmax_cap' in c:
            parts.append(('M-max <= %.0f' % c['mmax_cap'], c['mmax_cap'] - M))
        if 'mmax_minus_i_max' in c:
            parts.append(('M-max - I <= %.0f' % c['mmax_minus_i_max'], c['mmax_minus_i_max'] - (M - I)))
        if 'lra' in c:
            lo, hi = c['lra']
            parts += [('LRA >= %.0f' % lo, met['lra'] - lo), ('LRA <= %.0f' % hi, hi - met['lra'])]
    return P([(lab + ' [LU]', mg, 1.0) for lab, mg in parts]), met


def v3_peak(x, fs, g):
    tp = pm.true_peak_dbtp(x, fs)
    sp = pm.sample_peak_abs(x)
    m = min(g['max_dbtp'] - tp, 20 * math.log10(g['max_sample_abs'] / max(sp, 1e-12)))
    return G(tp <= g['max_dbtp'] and sp < g['max_sample_abs'], m, value=tp, limit=g['max_dbtp']), {'tp_dbtp': r4(tp), 'sample_peak_abs': r4(sp)}


def v4_sub(x, fs, g):
    e = pm.sub_band_energy_db(x, fs, g['below_hz'])
    return G(e <= g['max_db'], g['max_db'] - e, value=e, limit=g['max_db'], detail='0-%.0f Hz incl. DC, worst channel' % g['below_hz']), \
        {'sub20_db': r4(e)}


def v5_lf(x, fs, g, throb):
    s = pm.lf_share(x, fs, g['below_hz'])
    if throb:
        return G(True, na=True, value=s, detail='throb asset (LF-periodic by design): exempt'), {'lf_share': r4(s)}
    return G(s <= g['max_share'], g['max_share'] - s, value=s, limit=g['max_share']), {'lf_share': r4(s)}


def v6_undertone(x, fs, f0, gr_db, g):
    mod = pm.modulation(x, fs, g['search_hz'][0], g['search_hz'][1], g['env_lp_hz'])
    pk = mod['peak_hz']
    depth = pm.periodic_depth(mod, pk)
    lo, hi = T.L2['f0_hz']
    tol = T.GATES['V6']['f0_tol_hz']
    parts = [('envelope peak f0 %.2f +- %.2f [Hz]' % (f0, g['f0_tol_hz']), g['f0_tol_hz'] - abs(pk - f0), g['f0_tol_hz']),
             ('envelope peak inside the TDD f0 %.0f-%.0f Hz [Hz]' % (lo, hi), min(pk - (lo - tol), (hi + tol) - pk), tol),
             ('depth >= %.2f [depth]' % g['min_depth'], depth - g['min_depth'], 0.1),
             ('limiter GR 0 dB [dB]', 0.0 - gr_db + 0.0, None)]
    return P(parts, value=pk, extra='depth %.3f, line depth %.3f, limiter GR %.2f dB' % (depth, mod['line_depth'], gr_db)), \
        {'env_peak_hz': r4(pk), 'env_depth': r4(depth), 'env_line_depth': r4(mod['line_depth'])}


def v7_sidebands(x, fs, fc, fm, m, rough, g):
    fcar, lc = pm.line_level(x, fs, fc, 2.0)
    flo, llo = pm.line_level(x, fs, fc - fm, 1.0)
    fhi, lhi = pm.line_level(x, fs, fc + fm, 1.0)
    spacing = fhi - flo
    level = 0.5 * (llo + lhi) - lc
    expect = 20 * math.log10(m / 2)
    stol = T.GATES['V7']['spacing_tol_hz']
    ltol = T.GATES['V7']['level_tol_db']
    cap = 20 * math.log10(T.L3['m_max'] / 2) + ltol
    fm_lo, fm_hi = (T.L3['rough_fm_hz'] if rough else (T.L3['flutter_fm_hz'], T.L3['flutter_fm_hz']))
    parts = [('sideband spacing %.1f +- %.1f [Hz]' % (2 * fm, g['spacing_tol_hz']), g['spacing_tol_hz'] - abs(spacing - 2 * fm), g['spacing_tol_hz']),
             ('sideband level %.2f +- %.1f [dB]' % (expect, g['level_tol_db']), g['level_tol_db'] - abs(level - expect), g['level_tol_db']),
             ('sideband level <= %.2f dB (TDD m <= %.1f) [dB]' % (cap, T.L3['m_max']), cap - level, ltol),
             (('fm (spacing / 2) = TDD %.0f Hz +- %.2f [Hz]' % (fm_lo, stol / 2)) if fm_lo == fm_hi else ('fm (spacing / 2) inside the TDD %.0f-%.0f Hz [Hz]' % (fm_lo, fm_hi)),
              min(spacing / 2 - (fm_lo - stol / 2), (fm_hi + stol / 2) - spacing / 2), stol / 2)]
    if rough:
        parts.append(('carrier >= %.0f [Hz]' % g['rough_min_carrier_hz'], fcar - g['rough_min_carrier_hz'], 50.0))
    return P(parts, value=level, extra='carrier %.2f Hz, sidebands %.2f / %.2f Hz, spacing %.3f Hz, level %.2f dB' % (fcar, flo, fhi, spacing, level)), \
        {'carrier_hz': r4(fcar), 'sideband_spacing_hz': r4(spacing), 'sideband_level_db': r4(level)}


def heartbeat_depth(x, fs, rec, c, spec):
    """Modulation depth m of a decoded heartbeat, measured against a carrier reference: the unmodulated L3 carrier
    is re-synthesised from the recorded seed (render.pulse_carrier) with the recorded fades, the pulse train from
    the recorded rate and phase, and the decoded file is fitted by least squares as G u + G m (2P - 1) u.
    Returns (m, model residual in dB re the file). The envelope-based estimators read 0.49-0.59 on m = 0.3 files
    (the narrowband-noise carrier has its own envelope fluctuation); this fit reads m within +-0.003."""
    xm = pm.mono(x)
    n = len(xm)
    p = rec['params']
    u, _ = R.pulse_carrier(spec, int(rec['seed']), n, c)
    u = u * R.fade_curve(n, int(round(float(p['fade_in_s']) * fs)), int(round(float(p['fade_out_s']) * fs)), c['fade'])
    P = R.heartbeat_train(n, fs, float(p['rate']), float(p['phase_s']), c)
    M = np.stack([u, (2 * P - 1) * u], axis=1)
    coef, *_ = np.linalg.lstsq(M, xm, rcond=None)
    res = xm - M @ coef
    m = float(coef[1] / coef[0]) if coef[0] > 0 else float('inf')
    return m, float(20 * math.log10(max(pm.rms(res), 1e-15) / max(pm.rms(xm), 1e-15)))


def v8_pulse(x, fs, rate, g, rec=None, c=None, spec=None, cls_key=''):
    """V8 plus the TDD depth and rate caps. rate is the recorded pulse rate; the caps come from tdd_pins (L3 m <= 0.6
    and 1.0-1.4 Hz for every heartbeat; the comfort class heartbeat_c m <= 0.3 and <= 8 s), never from the spec."""
    mod = pm.modulation(x, fs, g['search_hz'][0], g['search_hz'][1], g['env_lp_hz'])
    pk = pm.periodicity_peak(mod, g['search_hz'][0], g['search_hz'][1], g.get('harmonics', 1))
    met = {'env_periodicity_hz': r4(pk), 'env_peak_hz': r4(mod['peak_hz']), 'env_line_depth': r4(mod['line_depth'])}
    tol = T.GATES['V8']['rate_tol_hz']
    comfort = T.COMFORT.get(cls_key)
    lo, hi = comfort['rate_hz'] if comfort else T.L3['heartbeat_rate_hz']
    parts = [('periodicity = recorded rate %.2f +- %.2f [Hz]' % (rate, g['rate_tol_hz']), g['rate_tol_hz'] - abs(pk - rate), g['rate_tol_hz']),
             ('periodicity inside the TDD %.1f-%.1f Hz +- %.2f [Hz]' % (lo, hi, tol), min(pk - (lo - tol), (hi + tol) - pk), tol)]
    extra = 'single-line peak %.3f Hz' % mod['peak_hz']
    if rec is not None:
        m_cap = comfort['m_max'] if comfort else T.L3['m_max']
        m_tol = comfort['m_tol'] if comfort else T.COMFORT['pulse.heartbeat_c']['m_tol']
        m, resid = heartbeat_depth(x, fs, rec, c, spec)
        m_rec = float(rec['params']['m'])
        met.update({'m_measured': r4(m), 'm_model_residual_db': r4(resid)})
        parts += [('measured m <= %.2f (+%.2f measurement tolerance) [m]' % (m_cap, m_tol), m_cap + m_tol - m, 0.05),
                  ('recorded m <= %.2f [m]' % m_cap, m_cap - m_rec, None),
                  ('carrier model residual <= %.0f dB [dB]' % g['model_residual_max_db'], g['model_residual_max_db'] - resid, 5.0)]
        extra += '; m measured %.4f (recorded %.2f), model residual %.1f dB' % (m, m_rec, resid)
        if comfort:
            dur = pm.as2d(x).shape[0] / fs
            parts.append(('comfort heartbeat <= %.0f s [s]' % comfort['dur_max_s'], comfort['dur_max_s'] - dur, 0.5))
    return P(parts, value=pk, limit='%.2f +- %.2f Hz' % (rate, g['rate_tol_hz']), extra=extra), met


def v9_beat(x, fs, delta, slow, g, comfort=False):
    lo, hi = g['search_slow_hz'] if slow else g['search_tense_hz']
    mod = pm.modulation(x, fs, lo, hi, g['env_lp_hz'])
    pk = mod['peak_hz']
    depth = pm.periodic_depth(mod, pk)
    tol = T.GATES['V9']['rate_tol_hz']
    tlo, thi = T.L4['slow_delta_hz'] if slow else T.L4['tense_delta_hz']
    parts = [('envelope peak %.2f +- %.2f [Hz]' % (delta, g['rate_tol_hz']), g['rate_tol_hz'] - abs(pk - delta), g['rate_tol_hz']),
             ('envelope peak inside the TDD %s %.1f-%.1f Hz +- %.1f [Hz]' % ('slow' if slow else 'tense', tlo, thi, tol), min(pk - (tlo - tol), (thi + tol) - pk), tol),
             ('depth >= %.2f [depth]' % g['min_depth'], depth - g['min_depth'], 0.1)]
    if comfort:
        cap = T.COMFORT['beat.slow']['rate_max_hz']
        parts.append(('comfort beat rate <= %.0f Hz [Hz]' % cap, cap - pk, tol))
    return P(parts, value=pk, extra='depth %.3f' % depth), {'env_peak_hz': r4(pk), 'env_depth': r4(depth)}


def v10_whisper(x, fs, snr_target, spec):
    g = spec['gates']['V10']
    snr = R.whisper_snr_db(x, spec)
    geo = spec['reference']['director_bed_geometry']
    alt = snr - 20 * math.log10(R.leff_gain(1.0, geo['d'], geo['att'])) - (geo['file_lufs'] - spec['reference']['ambientsounds_bed_median_lufs'])
    return G(abs(snr - snr_target) <= g['tol_db'], g['tol_db'] - abs(snr - snr_target), value=snr,
             limit='%.1f +- %.1f dB' % (snr_target, g['tol_db']),
             detail='vs the director bed at 12 blocks (att 128, -30 LUFS file): %.2f dB' % alt), {'v10_snr_db': r4(snr), 'v10_snr_director_bed_db': r4(alt)}


def v11_duration(x, fs, dur_range, director, attack_exempt, g):
    xm = pm.as2d(x)
    dur = xm.shape[0] / fs
    body = pm.rms(xm)
    ne = int(round(g['edge_s'] * fs))
    first = pm.rms(xm[:ne])
    last = pm.rms(xm[-ne:])
    d_first = 20 * math.log10(body / max(first, 1e-12))
    d_last = 20 * math.log10(body / max(last, 1e-12))
    parts = [('duration >= %.2f [s]' % dur_range[0], dur - dur_range[0], 0.5), ('duration <= %.2f [s]' % dur_range[1], dur_range[1] - dur, 0.5),
             ('last 20 ms >= 20 dB under the file RMS [dB]', d_last - g['min_edge_drop_db'], 10.0)]
    if not attack_exempt:
        parts.append(('first 20 ms >= 20 dB under the file RMS [dB]', d_first - g['min_edge_drop_db'], 10.0))
    if director:
        parts.append(('director layer <= 10 [s]', g['director_max_s'] - dur, 0.5))
    return P(parts, value=dur, extra='edges %.1f / %.1f dB under the file RMS' % (d_first, d_last)), \
        {'dur': r4(dur), 'edge_first_db': r4(d_first), 'edge_last_db': r4(d_last)}


def director_fall_db(dur, spec):
    p = spec['reference']['director_placement']
    g0 = R.leff_gain(1.0, p['height'], p['att'])
    d1 = math.hypot(p['height'], p['sprint_bps'] * dur)
    g1 = R.leff_gain(1.0, d1, p['att'])
    return 20 * math.log10(g0 / g1)


def v14_report(x, fs, g):
    met = {'crest_db': r4(pm.crest_db(x)), 'centroid_hz': r4(pm.spectral_centroid(x, fs)),
           'rms_dbfs': r4(pm.rms_dbfs(x)),
           'peaks': [[round(f, 2), round(d, 1)] for f, d in sorted(pm.spectrum_peaks(x, fs, n=g['peaks'], fmin=5, fmax=20000),
                                                                    key=lambda p: -p[1])]}
    ok = len(met['peaks']) >= 1 and all(np.isfinite([met['crest_db'], met['centroid_hz']]))
    return G(ok, detail='crest, centroid and top peaks recorded'), met


def v15_rise(x, fs, fade_in_s, comfort, normal, exempt, g):
    hop = float(g.get('hop_s', pm.HOP_S))
    dur = pm.as2d(x).shape[0] / fs
    if exempt:
        r = pm.rise_after(x, fs, fade_in_s, g['normal']['window_s'], hop)
        return G(True, na=True, value=r[0], detail='L7 exempt (reported: rise per 3 s)'), {'rise_normal_lu': r4(r[0])}
    met = {}
    parts = []
    if normal:
        r = pm.rise_after(x, fs, fade_in_s, g['normal']['window_s'], hop)
        met['rise_normal_lu'] = r4(r[0])
        parts.append(('normal <= %.0f LU / %.0f s' % (g['normal']['max_lu'], g['normal']['window_s']), g['normal']['max_lu'] - r[0]))
    if comfort:
        r = pm.rise_after(x, fs, fade_in_s, g['comfort']['window_s'], hop)
        met['rise_comfort_lu'] = r4(r[0])
        parts.append(('comfort <= %.0f LU / %.0f s' % (g['comfort']['max_lu'], g['comfort']['window_s']), g['comfort']['max_lu'] - r[0]))
    span = dur - 0.4 - fade_in_s
    if span < float(g.get('min_span_s', 0.0)) - 1e-9:
        # the 400 ms windows that start after the onset fade span less than min_span_s: there is no in-file rise to
        # measure, and a 0.0 would read as a pass with full margin. The onset step itself (M-max above silence) is the
        # catalog's mmax, which the director's level-jump check uses (TDD 2.3.4).
        return G(True, na=True, value=max([v for v in met.values()] or [0.0]),
                 detail='not applicable: the momentary windows after the %.2f s onset fade span %.2f s (< %.2f s); onset step = '
                        'M-max %.2f LUFS (catalog mmax, a ledger level-jump input); rises reported, not graded' % (
                            fade_in_s, max(span, 0.0), g['min_span_s'], pm.momentary_max(x, fs))), met
    return P([(lab + ' [LU]', mg, 1.0) for lab, mg in parts]), met


def v16_tell(x, fs, spec):
    g = spec['gates']['V16']
    m = R.tell_margin_db(x, spec)
    return G(m >= g['min_db'], m - g['min_db'], value=m, limit='>= %.0f dB' % g['min_db']), {'v16_band_margin_db': r4(m)}


def syllabic_depth(x, fs, rec, spec):
    """L5 syllabic AM on the decoded file, per burst: the recorded phrase plan is re-synthesised WITHOUT the syllabic
    AM (render.whisper_synth, depth 0: same noise, formants, glides, sibilance gates and burst envelopes), and each
    burst of the decoded file is fitted by least squares as u (a + b cos wt + c sin wt), w = the burst's recorded
    syllabic rate. Depth = sqrt(b^2 + c^2) / a (phase-free). The burst envelopes cancel in the fit, so this measures
    the syllabic modulation alone, which TDD 2.3.2 says passes the comfort envelope rule (depth 0.45).
    Returns (max depth, max model residual dB, [depth per burst], [rate per burst])."""
    xm = pm.mono(x)
    n = len(xm)
    bursts = rec['params']['bursts']
    u0 = R.whisper_synth(spec, int(rec['seed']), bursts, n, 0.0)
    depths, resid, rates = [], [], []
    for b in bursts:
        i0 = int(round(float(b['t0']) * fs))
        i1 = min(n, i0 + int(round(float(b['dur']) * fs)))
        uu, xx = u0[i0:i1], xm[i0:i1]
        w = 2 * np.pi * float(b['syl_hz']) * np.arange(i1 - i0) / fs
        M = np.stack([uu, np.cos(w) * uu, np.sin(w) * uu], axis=1)
        coef, *_ = np.linalg.lstsq(M, xx, rcond=None)
        depths.append(float(math.hypot(coef[1], coef[2]) / coef[0]) if coef[0] > 0 else float('inf'))
        resid.append(float(20 * math.log10(max(pm.rms(xx - M @ coef), 1e-15) / max(pm.rms(xx), 1e-15))))
        rates.append(float(b['syl_hz']))
    return max(depths), max(resid), depths, rates


def ce_rule(x, fs, comfort, pending_reason, g, rec=None, spec=None, kind=''):
    """Comfort envelope rule. Binding for every comfort class; for L5 the binding part is the syllabic AM (measured
    against the re-synthesised phrase), and the phrase-level burst gating is measured and attached as 'pending'.
    Classes in the spec's pending list (tdd_pins.PENDING_CE) are never reported as passes: the gate carries
    na + pending until the lead records the decision in the TDD."""
    if not comfort:
        return NA('normal-mode only'), {}
    mod = pm.modulation(x, fs, g['search_hz'][0], g['search_hz'][1], g['env_lp_hz'], norm_s=g['norm_s'])
    d, f = pm.max_line_depth(mod, g['min_rate_hz'], g['search_hz'][1])
    met = {'ce_depth': r4(d), 'ce_rate_hz': r4(f)}
    pend = {'value': r4(d), 'rate_hz': r4(f), 'limit': g['max_depth'], 'reason': pending_reason} if pending_reason else None
    if kind == 'whisper':
        sg = g['syllabic']
        dmax, rmax, depths, rates = syllabic_depth(x, fs, rec, spec)
        slo, shi = T.L5['syllabic_hz']
        met.update({'syllabic_depth': r4(dmax), 'syllabic_residual_db': r4(rmax)})
        parts = [('syllabic AM depth <= %.2f (per burst, max) [depth]' % g['max_depth'], g['max_depth'] - dmax, 0.1),
                 ('syllabic model residual <= %.0f dB [dB]' % sg['model_residual_max_db'], sg['model_residual_max_db'] - rmax, 5.0),
                 ('recorded syllabic rates inside the TDD %.1f-%.1f Hz [Hz]' % (slo, shi), min(min(rates) - slo, shi - max(rates)), None)]
        gate = P(parts, value=dmax, limit=g['max_depth'],
                 extra='syllabic depth per burst %s; phrase-level envelope line %.3f at %.2f Hz%s' % (
                     ' '.join('%.3f' % v for v in depths), d, f, ' PENDING lead decision' if pend else ''))
        if pend:
            gate['pending'] = pend
        return gate, met
    if pend:
        gate = G(True, na=True, value=d, detail='PENDING lead decision (measured, not graded): line %.3f at %.2f Hz against %.1f; %s' % (
            d, f, g['max_depth'], pending_reason))
        gate['pending'] = pend
        return gate, met
    return G(d <= g['max_depth'], g['max_depth'] - d, value=d, limit=g['max_depth'], detail='largest line at %.2f Hz' % f), met


def g9_zero_gr(gr, layer, spec):
    if layer not in spec['chain']['G9_limiter']['zero_gr_layers']:
        return G(True, na=True, value=gr, detail='limiter allowed on this layer')
    return G(gr == 0, 0.0 - gr + 0.0, value=gr, limit=0.0)


# ---------------------------------------------------------------------------------------------- one asset

def asset_meta(rec, spec):
    lay = spec['layers'][rec['layer']]
    c = lay['classes'][rec['cls']]
    n = len(c.get('variants') or []) or int(c.get('count', 0))
    return {
        'cat': lay['category'], 'att': int(lay['att']), 'comfort': bool(c['comfort']), 'normal': bool(c['normal']),
        'lf': bool(lay['lf']), 'amb': bool(c.get('amb', False)), 'reserve': rec['v'] > n - int(c.get('reserve', 0)),
        'preload': bool(lay.get('preload', False)),
        'subtitle': lay['subtitle'] if c.get('subtitle', True) else None,
    }


def ce_pending(rec, spec):
    """The pending-decision reason for this asset's class, matched on the exact '<slug>.<cls>' key only (no
    slug-level blanket entries)."""
    return spec['gates']['CE'].get('pending_lead_decision', {}).get('%s.%s' % (rec['slug'], rec['cls']), '')


def verify_asset(path, rec, spec_path=R.SPEC_PATH):
    spec = R.load_spec(spec_path)
    gs = spec['gates']
    lay = spec['layers'][rec['layer']]
    c = lay['classes'][rec['cls']]
    kind = c['kind']
    params = rec.get('params', {})
    meta = asset_meta(rec, spec)
    inf = sf.info(path)
    info = {'format': inf.format, 'subtype': inf.subtype, 'samplerate': inf.samplerate, 'channels': inf.channels}
    x, fs = sf.read(path, dtype='float64')
    gates = {}
    met = {}
    gates['V1'] = v1_format(info, int(c['channels']), gs['V1'])
    target = float(rec['target_lufs'])
    gates['V2'], m = v2_loudness(x, fs, c, kind, target, spec, params)
    met.update(m)
    gates['V3'], m = v3_peak(x, fs, gs['V3'])
    met.update(m)
    gates['V4'], m = v4_sub(x, fs, gs['V4'])
    met.update(m)
    gates['V5'], m = v5_lf(x, fs, gs['V5'], bool(lay['throb']))
    met.update(m)
    gates['V6'] = NA()
    gates['V7'] = NA()
    gates['V8'] = NA()
    gates['V9'] = NA()
    gates['V10'] = NA()
    gates['V16'] = NA()
    if kind == 'undertone':
        gates['V6'], m = v6_undertone(x, fs, float(params['f0']), float(rec['limiter_gr_db']), gs['V6'])
        met.update(m)
    if kind == 'pulse':
        if c['mod'] == 'heartbeat':
            gates['V8'], m = v8_pulse(x, fs, float(params['rate']), gs['V8'], rec, c, spec, '%s.%s' % (rec['slug'], rec['cls']))
        else:
            gates['V7'], m = v7_sidebands(x, fs, float(params['carrier_hz']), float(params['fm']), float(params['m']), bool(c.get('rough')), gs['V7'])
        met.update(m)
    if kind == 'beat':
        gates['V9'], m = v9_beat(x, fs, float(params['delta']), rec['cls'] == 'slow', gs['V9'], meta['comfort'])
        met.update(m)
    if kind == 'whisper':
        gates['V10'], m = v10_whisper(x, fs, float(c['snr_db']), spec)
        met.update(m)
    if kind == 'tell':
        gates['V16'], m = v16_tell(x, fs, spec)
        met.update(m)
    director = bool(c.get('director'))
    gates['V11'], m = v11_duration(x, fs, c['dur_range'], director, bool(params.get('attack_exempt')), gs['V11'])
    met.update(m)
    dur = x.shape[0] / fs
    stream = dur > gs['V13']['stream_above_s']
    if director:
        fall = director_fall_db(dur, spec)
        met['fall_sprint_db'] = r4(fall)
        gates['V13'] = G(fall <= gs['V13']['max_fall_db'] and stream == bool(meta['amb']), gs['V13']['max_fall_db'] - fall, value=fall,
                         limit=gs['V13']['max_fall_db'], detail='modelled level fall at sprint speed (12 blocks up, att 128)')
    else:
        ok = stream == bool(meta['amb'])
        gates['V13'] = G(ok, detail='stream %s (beds stream, everything else is static)' % stream)
    gates['V14'], m = v14_report(x, fs, gs['V14'])
    met.update(m)
    gates['V15'], m = v15_rise(x, fs, float(params.get('fade_in_s', 0.0)), meta['comfort'], meta['normal'], kind == 'spike', gs['V15'])
    met.update(m)
    gates['CE'], m = ce_rule(x, fs, meta['comfort'], ce_pending(rec, spec), gs['CE'], rec, spec, kind)
    met.update(m)
    gates['G9'] = g9_zero_gr(float(rec['limiter_gr_db']), rec['layer'], spec)
    gates['V12'] = NA('set-level gate (see set.V12)')
    with open(path, 'rb') as f:
        sha = hashlib.sha256(f.read()).hexdigest()
    entry = {
        'event': rec['event'], 'key': rec['key'], 'file': rec['file'], 'layer': rec['layer'], 'slug': rec['slug'],
        'cls': rec['cls'], 'v': rec['v'], 'channels': int(inf.channels), 'fs': int(fs), 'samples': int(x.shape[0]),
        'dur': r4(dur), 'ogg_bytes': os.path.getsize(path), 'ogg_sha256': sha, 'stream': bool(stream),
        'render': {k: rec[k] for k in ('seed', 'target_lufs', 'tol', 'limiter_gr_db', 'g8_iterations', 'gain_db', 'float_sha256', 'params',
                                        'compression_level')},
        'metrics': met, 'gates': {k: gates[k] for k in GATE_ORDER},
    }
    entry.update(meta)
    entry['pass'] = all(g['pass'] for g in gates.values())
    return entry


def _verify_job(job):
    path, rec, spec_path = job
    if os.environ.get('PNE_VERIFY_FAULT') == 'memory' and multiprocessing.parent_process() is not None:
        # test hook (tests/test_gates.py): a worker that runs out of memory; the parent must retry serially
        raise MemoryError('injected by PNE_VERIFY_FAULT=memory')
    return verify_asset(path, rec, spec_path)


# ---------------------------------------------------------------------------------------------- set level

def set_gates(entries, spec):
    gs = spec['gates']
    out = {}
    pools = {}
    for e in entries.values():
        pools.setdefault('%s.%s' % (e['slug'], e['cls']), []).append(e)
    spreads = {}
    worst = None
    for p, es in sorted(pools.items()):
        vals = [e['metrics']['lufs_i'] for e in es]
        s = max(vals) - min(vals)
        spreads[p] = r4(s)
        m = gs['V12']['max_spread_lu'] - s
        if worst is None or m < worst[0]:
            worst = (m, p)
    out['V12'] = G(worst[0] >= 0, worst[0], value=gs['V12']['max_spread_lu'] - worst[0], limit=gs['V12']['max_spread_lu'],
                   detail='margin in LU; widest pool %s' % worst[1])
    out['V12']['spreads'] = spreads
    bps = gs['V13']['pcm_bytes_per_sample']
    static = sum(e['samples'] * e['channels'] * bps for e in entries.values() if not e['stream'])
    streamed = sum(e['samples'] * e['channels'] * bps for e in entries.values() if e['stream'])
    stream_pools = {p for p, es in pools.items() if any(e['stream'] for e in es)}
    per_state = {st: len([p for p in cls if p in stream_pools]) for st, cls in spec['states'].items() if not st.startswith('_')}
    flags_ok = all(e['stream'] == (e['dur'] > gs['V13']['stream_above_s']) for e in entries.values()) and \
        all(e['stream'] for e in entries.values() if e['amb'])
    lim = gs['V13']['static_pcm_max_bytes']
    m = min((lim - static) / 1e6, gs['V13']['max_streams_per_state'] - max(per_state.values() or [0]))
    out['V13'] = G(static <= lim and flags_ok and max(per_state.values() or [0]) <= gs['V13']['max_streams_per_state'], m,
                   value=static, limit=lim, detail='margin in MB (or streams); static PCM %.2f MB of %.0f MB; streams per state %s' % (static / 1e6, lim / 1e6, per_state))
    out['V13'].update({'static_pcm_bytes': int(static), 'streamed_pcm_bytes': int(streamed), 'streams_per_state': per_state})
    return out


def summarise(entries, sets, spec):
    worst = {}
    for k, e in sorted(entries.items()):
        for gname, g in e['gates'].items():
            if g.get('na') or 'margin' not in g:
                continue
            if gname not in worst or g['margin'] < worst[gname]['margin']:
                worst[gname] = {'margin': g['margin'], 'key': k, 'detail': g.get('detail', '')[:90]}
    for gname, g in sets.items():
        if 'margin' in g and (gname not in worst or g['margin'] < worst[gname]['margin']):
            worst[gname] = {'margin': g['margin'], 'key': 'set', 'detail': g.get('detail', '')[:90]}
    by_layer = {}
    for e in entries.values():
        k = '%s %s' % (e['layer'], e['slug'])
        by_layer[k] = by_layer.get(k, 0) + 1
    failed = sorted([k for k, e in entries.items() if not e['pass']] + ['set.' + g for g, v in sets.items() if not v['pass']])
    pending = {}
    for k, e in sorted(entries.items()):
        for gname, g in e['gates'].items():
            if g.get('pending'):
                pending.setdefault(gname, []).append(k)
    comfort = [k for k, e in entries.items() if e['comfort']]
    ce_graded = [k for k in comfort if not entries[k]['gates']['CE'].get('na')]
    return {'count': len(entries), 'by_layer': dict(sorted(by_layer.items())), 'ogg_bytes': sum(e['ogg_bytes'] for e in entries.values()),
            'static_pcm_bytes': sets['V13']['static_pcm_bytes'], 'streamed_pcm_bytes': sets['V13']['streamed_pcm_bytes'],
            'failed': failed, 'pass': not failed, 'worst_margin': {g: worst[g] for g in GATE_ORDER if g in worst},
            'pending_lead_decision': pending,
            'ce': {'comfort_assets': len(comfort), 'graded': len(ce_graded),
                   'fully_passing': len([k for k in ce_graded if entries[k]['gates']['CE']['pass'] and not entries[k]['gates']['CE'].get('pending')]),
                   'pending': len(pending.get('CE', []))}}


def default_jobs():
    """Worker processes: env PNE_JOBS if set (>= 1), else min(4, CPUs). One verify job peaks at about 60 MB (a 50 s
    stereo bed), so 4 workers stay far below the memory other suites and agents may be using at the same time."""
    try:
        v = int(os.environ.get('PNE_JOBS', '0'))
    except ValueError:
        v = 0
    return v if v >= 1 else min(4, os.cpu_count() or 1)


def build_manifest(records, ogg_root, spec_path=R.SPEC_PATH, jobs=None):
    spec = R.load_spec(spec_path)
    jl = [(os.path.join(ogg_root, r['file']), r, spec_path) for r in records]
    jobs = jobs or default_jobs()
    res = None
    if jobs > 1 and len(jl) > 1:
        jl.sort(key=lambda j: -os.path.getsize(j[0]))
        try:
            with ProcessPoolExecutor(max_workers=jobs) as ex:
                res = list(ex.map(_verify_job, jl))
        except (MemoryError, BrokenProcessPool, OSError) as err:
            # host memory pressure must not decide a gate result: redo every job in this process, one at a time
            print('  note  parallel verify failed (%s: %s); retrying serially' % (type(err).__name__, str(err)[:160]), file=sys.stderr)
            res = None
    if res is None:
        res = [_verify_job(j) for j in jl]
    entries = {e['key']: e for e in res}
    sets = set_gates(entries, spec)
    spec_sha = R.lf_sha256(spec_path)
    return {
        'schema': 1, 'generator': 'tools/resonance/verify.py', 'spec_sha256': spec_sha,
        'reference': {'bed_lufs': spec['reference']['ambientsounds_bed_median_lufs'],
                      'bed_band_rms_300_3400': r4(R.ref_band_rms(300.0, 3400.0, spec_path) * 1e6) / 1e6,
                      'bed_band_rms_2000_3200': r4(R.ref_band_rms(2000.0, 3200.0, spec_path) * 1e6) / 1e6},
        'not_shipped': R.not_shipped_classes(spec),
        'assets': dict(sorted(entries.items())), 'set': sets, 'summary': summarise(entries, sets, spec),
    }


def shipped_manifest(man, spec):
    """The manifest of the shipped set: the build manifest without the assets of classes that do not ship (the
    stereo beds, lead decision 1.3), with the set-level gates and the summary recomputed over what remains. Per-asset
    entries do not depend on each other, so this equals build_manifest() over the shipped records alone (verify
    --committed rebuilds it that way and diffs)."""
    entries = {k: e for k, e in man['assets'].items() if R.ships(spec, e['layer'], e['cls'])}
    sets = set_gates(entries, spec)
    out = dict(man)
    out.update({'assets': dict(sorted(entries.items())), 'set': sets, 'summary': summarise(entries, sets, spec)})
    return out


def inventory_problems(spec, recs, on_disk):
    """The committed asset set against the spec (cheap, before any decoding): every manifest record is a class that
    ships, the manifest holds exactly the spec's shipped set, no bed_* file sits under assets/pne/sounds, and the files
    on disk are exactly the manifest's. on_disk: paths relative to assets/pne/sounds ('res/<slug>/<cls>_vNN.ogg')."""
    out = []
    listed = {r['file'].replace('\\', '/') for r in recs}
    for r in sorted(recs, key=lambda q: q['key']):
        if not R.ships(spec, r['layer'], r['cls']):
            out.append('manifest lists %s, a class that does not ship (%s.%s: the stereo beds stay in tools/resonance/out/, '
                       'lead decision 1.3)' % (r['key'], r['slug'], r['cls']))
    want = {a['file'] for a in R.expand(spec) if R.ships(spec, a['layer'], a['cls'])}
    miss = sorted(want - listed)
    if miss:
        out.append('manifest lacks %d asset(s) of the spec\'s shipped set: %s' % (len(miss), ', '.join(miss[:5])))
    for p in sorted(on_disk):
        if os.path.basename(p).lower().startswith(R.BED_PREFIX):
            out.append('stereo bed file under overrides/kubejs/assets/pne/sounds: %s (none ships: lead decision 1.3)' % p)
    for p in sorted(on_disk - listed):
        out.append('stray file not in the manifest: %s' % p)
    for p in sorted(listed - on_disk):
        out.append('manifest file missing on disk: %s' % p)
    return out


def bed_leaks(root=ROOT):
    """Anything stereo-bed under <root>/overrides/ (IMPLEMENTATION.md section 5, lead decision 1.3: no bed_* OGG,
    sounds.json entry or catalog event ships): an audio file named bed_*, or a text file (sounds.json, the catalog,
    lang, any script or config) that names a res.<slug>.bed_* event or res/<slug>/bed_* sound. Returns problems."""
    out = []
    base = os.path.join(root, 'overrides')
    for dp, dns, fns in os.walk(base):
        dns.sort()
        for fn in sorted(fns):
            p = os.path.join(dp, fn)
            rel = os.path.relpath(p, root).replace(os.sep, '/')
            low = fn.lower()
            if low.startswith(R.BED_PREFIX) and low.endswith(BED_SCAN_AUDIO):
                out.append('stereo bed file under overrides/: %s' % rel)
            elif low.endswith(BED_SCAN_TEXT):
                with open(p, encoding='utf-8', errors='replace') as f:
                    hits = sorted(set(BED_REF_RX.findall(f.read())))
                if hits:
                    out.append('%s names stereo bed event(s) or sound(s): %s' % (rel, ', '.join(hits[:4]) + (' ...' if len(hits) > 4 else '')))
    return out


def _rel(p):
    """p relative to the repo root when it lies inside it (console output carries no home paths), else as given."""
    try:
        r = os.path.relpath(os.path.abspath(p), ROOT)
    except ValueError:
        return p
    return p if r.startswith('..') else r.replace(os.sep, '/')


def sounds_on_disk(assets_dir):
    out = set()
    for dp, _, fns in os.walk(assets_dir):
        for fn in fns:
            out.add(os.path.relpath(os.path.join(dp, fn), assets_dir).replace(os.sep, '/'))
    return out


def write_json(path, obj):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, indent=1, sort_keys=True)
        f.write('\n')


def records_from_render_log(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)['assets']


def records_from_manifest(man):
    out = []
    for k, e in sorted(man['assets'].items()):
        r = {kk: e[kk] for kk in ('event', 'key', 'file', 'layer', 'slug', 'cls', 'v', 'channels')}
        r.update(e['render'])
        out.append(r)
    return out


def print_summary(man, out=sys.stdout):
    s = man['summary']
    print('assets: %d (%s)' % (s['count'], ', '.join('%s: %d' % kv for kv in s['by_layer'].items())), file=out)
    print('OGG bytes: %d (%.2f MB); static decoded PCM %.2f MB; streamed PCM %.2f MB' % (
        s['ogg_bytes'], s['ogg_bytes'] / 1e6, s['static_pcm_bytes'] / 1e6, s['streamed_pcm_bytes'] / 1e6), file=out)
    for g, w in s['worst_margin'].items():
        print('  worst margin %-4s %9.4f  %-28s %s' % (g, w['margin'], w['key'], w.get('detail', '')), file=out)
    for g, keys in sorted(s.get('pending_lead_decision', {}).items()):
        byc = {}
        for k in keys:
            e = man['assets'][k]
            byc.setdefault('%s.%s' % (e['slug'], e['cls']), []).append(e['gates'][g]['pending'])
        for c, pl in sorted(byc.items()):
            vals = [p['value'] for p in pl]
            print('  PENDING %s %s x%d: measured %.3f-%.3f against %.2f, not graded; waits for a lead decision (%s)' % (
                g, c, len(pl), min(vals), max(vals), pl[0]['limit'], pl[0]['reason'][:100]), file=out)
    for k in s['failed']:
        e = man['assets'].get(k)
        if e:
            bad = ['%s: %s' % (g, v.get('detail') or v.get('value')) for g, v in e['gates'].items() if not v['pass']]
            print('  FAILED %s: %s' % (k, '; '.join(bad)), file=out)
        else:
            print('  FAILED %s: %s' % (k, man['set'][k.split('.', 1)[1]].get('detail')), file=out)


# ---------------------------------------------------------------------------------------------- manifest diff

def _num_close(a, b):
    return abs(a - b) <= max(0.011, 1e-4 * max(abs(a), abs(b)))


def diff_values(a, b, path, out):
    if isinstance(a, dict) and isinstance(b, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                out.append('%s.%s: only in %s' % (path, k, 'committed' if k in a else 'fresh'))
            else:
                diff_values(a[k], b[k], path + '.' + k, out)
    elif isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            out.append('%s: length %d vs %d' % (path, len(a), len(b)))
        else:
            for i, (u, v) in enumerate(zip(a, b)):
                diff_values(u, v, '%s[%d]' % (path, i), out)
    elif isinstance(a, bool) or isinstance(b, bool) or isinstance(a, str) or isinstance(b, str) or a is None or b is None:
        if a != b:
            out.append('%s: %r vs %r' % (path, a, b))
    elif isinstance(a, (int, float)) and isinstance(b, (int, float)):
        if not _num_close(float(a), float(b)):
            out.append('%s: %r vs %r' % (path, a, b))
    elif a != b:
        out.append('%s: %r vs %r' % (path, a, b))


def pass_line(man, what):
    s = man['summary']
    ce = s['ce']
    return ('PASS %s: %d assets pass V1-V16 and G9 on the decoded files; comfort envelope rule: %d of %d comfort assets graded and '
            'passing, %d measured and PENDING a lead decision (%s)' % (
                what, s['count'], ce['fully_passing'], ce['comfort_assets'], ce['pending'],
                ', '.join(sorted({'%s.%s' % (man['assets'][k]['slug'], man['assets'][k]['cls']) for k in s['pending_lead_decision'].get('CE', [])})) or 'none'))


def committed_check(spec_path, man_path, assets_dir, tmp, jobs=None, root=ROOT):
    with open(man_path, encoding='utf-8') as f:
        man = json.load(f)
    problems = []
    if R.lf_sha256(spec_path) != man['spec_sha256']:
        problems.append('spec/layers.json changed since the manifest was built: re-render, verify --install and regenerate')
    spec = R.load_spec(spec_path)
    recs = records_from_manifest(man)
    problems += inventory_problems(spec, recs, sounds_on_disk(assets_dir))
    problems += bed_leaks(root)
    if problems:
        return None, problems
    fresh = build_manifest(recs, assets_dir, spec_path, jobs)
    write_json(os.path.join(tmp, 'resonance_manifest_fresh.json'), fresh)
    d = []
    diff_values(man, fresh, 'manifest', d)
    problems += d[:40]
    if len(d) > 40:
        problems.append('... %d more differences' % (len(d) - 40))
    return fresh, problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--spec', default=R.SPEC_PATH)
    ap.add_argument('--out', default=R.DEFAULT_OUT, help='build folder (render.py --out)')
    ap.add_argument('--install', action='store_true')
    ap.add_argument('--committed', action='store_true')
    ap.add_argument('--jobs', type=int, default=0)
    args = ap.parse_args(argv)
    spec_path = os.path.abspath(args.spec)
    if args.committed:
        tmp = os.environ.get('PNE_TMP') or os.path.join(tempfile.gettempdir(), 'pne_tests')
        fresh, problems = committed_check(spec_path, COMMITTED_MANIFEST, ASSETS_DIR, tmp, args.jobs or None)
        if fresh is not None:
            print_summary(fresh)
            if not fresh['summary']['pass']:
                problems.append('gate failures: %s' % ', '.join(fresh['summary']['failed']))
        for p in problems:
            print('  FAIL  ' + p)
        if problems:
            print('FAIL resonance-verify: %d problem(s)' % len(problems))
            return 1
        print(pass_line(fresh, 'resonance-verify') + '; the shipped set is exactly the spec\'s (%d assets, %.2f MB of OGG; not shipped: %s); '
              'manifest identical within tolerance' % (fresh['summary']['count'], fresh['summary']['ogg_bytes'] / 1e6,
                                                       ', '.join(fresh.get('not_shipped', [])) or 'none'))
        return 0
    recs = records_from_render_log(os.path.join(args.out, 'render_log.json'))
    man = build_manifest(recs, os.path.join(args.out, 'ogg'), spec_path, args.jobs or None)
    write_json(os.path.join(args.out, 'manifest.json'), man)
    print_summary(man)
    if not man['summary']['pass']:
        print('FAIL verify: %d failure(s); nothing installed' % len(man['summary']['failed']))
        return 1
    if args.install:
        spec = R.load_spec(spec_path)
        ship = [r for r in recs if R.ships(spec, r['layer'], r['cls'])]
        held = sorted(r['key'] for r in recs if not R.ships(spec, r['layer'], r['cls']))
        sman = shipped_manifest(man, spec)
        short = sorted({a['key'] for a in R.expand(spec) if R.ships(spec, a['layer'], a['cls'])} - {r['key'] for r in ship})
        if short:
            print('FAIL verify --install: the build folder lacks %d asset(s) of the spec\'s shipped set (%s); render them first. '
                  'Nothing installed' % (len(short), ', '.join(short[:4])))
            return 1
        res_dir = os.path.join(ASSETS_DIR, 'res')
        if os.path.isdir(res_dir):
            for dp, _, fns in os.walk(res_dir):
                for fn in fns:
                    if fn.endswith('.ogg'):
                        os.remove(os.path.join(dp, fn))
        for r in ship:
            dst = os.path.join(ASSETS_DIR, r['file'])
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(os.path.join(args.out, 'ogg', r['file']), dst)
        write_json(COMMITTED_MANIFEST, sman)
        sys.stdout.flush()
        rc = subprocess.call([sys.executable, os.path.join(HERE, 'gen_sounds_json.py')])
        if rc:
            print('FAIL gen_sounds_json.py exited %d' % rc)
            return rc
        leaks = inventory_problems(spec, records_from_manifest(sman), sounds_on_disk(ASSETS_DIR)) + bed_leaks(ROOT)
        for p in leaks:
            print('  FAIL  ' + p)
        if leaks:
            print('FAIL verify --install: %d problem(s) under overrides/ after the install' % len(leaks))
            return 1
        print('installed %d of %d OGGs (%.2f MB), tools/resonance/manifest.json, sounds.json, lang and catalog; %d asset(s) of the '
              'classes that do not ship (%s) stay in %s only' % (len(ship), len(recs), sman['summary']['ogg_bytes'] / 1e6, len(held),
                                                                 ', '.join(sman['not_shipped']) or 'none',
                                                                 _rel(os.path.join(args.out, 'ogg'))))
        print(pass_line(sman, 'verify --install (shipped set)'))
    print(pass_line(man, 'verify (build folder)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
