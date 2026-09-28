"""
Suite resonance-meter-selftest: pne_meter's EBU Tech 3341 / 3342 self-test plus checks of the helpers the gates
rely on (exact BS.1770-4 coefficients, true-peak envelope, in-file rise, periodicity, spectral line levels).

    python tools/resonance/tests/test_meter.py        last line PASS or FAIL
"""
import os
import sys

import numpy as np
from scipy import fft as _sfft
from scipy import signal as _sig

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import pne_meter as pm  # noqa: E402

FS = 48000
rows = []


def chk(name, ok, detail=''):
    rows.append((name, bool(ok), detail))


for name, val, exp, tol, ok in pm.selftest():
    chk(name, ok, '%s (expect %s +- %s)' % (val, exp, tol))

# exact BS.1770-4 Table 1 / 2 coefficients at 48 kHz (the port must not re-derive them)
(b1, a1), (b2, a2) = pm._kweight_coeffs(48000)
chk('BS.1770-4 stage 1 coefficients exact', np.array_equal(b1, [1.53512485958697, -2.69169618940638, 1.19839281085285]) and
    np.array_equal(a1, [1.0, -1.69065929318241, 0.73248077421585]))
chk('BS.1770-4 stage 2 coefficients exact', np.array_equal(b2, [1.0, -2.0, 1.0]) and np.array_equal(a2, [1.0, -1.99004745483398, 0.99007225036621]))

t = np.arange(FS * 2) / FS
x = 0.7 * np.sin(2 * np.pi * (FS / 4) * t + np.pi / 4)
chk('true_peak_envelope max equals true_peak_dbtp', abs(20 * np.log10(pm.true_peak_envelope(x).max()) - pm.true_peak_dbtp(x)) < 1e-9)

# rise_after: a 6 dB linear ramp over 3 s inside flat noise; momentary rise per 3 s close to 6
rng = np.random.default_rng(5)
n = pm.bandpass(rng.standard_normal(FS * 8), FS, 200, 4000)[:, 0]
tt = np.arange(len(n)) / FS
g = -6 * (1 - np.clip((tt - 2) / 3, 0, 1))
r = pm.rise_after(n * 10 ** (g / 20), FS, 0.0, 3.0)
chk('rise_after: +6 dB over 3 s measures 5.5-6.5 LU per 3 s', 5.5 <= r[0] <= 6.5, '%.2f' % r[0])
r2 = pm.rise_after(n * 10 ** (g / 20), FS, 0.0, 1.0)
chk('rise_after: the same ramp measures about 2 LU per 1 s', 1.5 <= r2[0] <= 2.8, '%.2f' % r2[0])
chk('rise_after: a start after the ramp sees no rise', pm.rise_after(n * 10 ** (g / 20), FS, 5.2, 3.0)[0] < 1.0)

# periodicity through fades: 1.23 Hz heartbeat-like pulse train
env = np.zeros_like(tt)
for k in range(12):
    c = 0.3 + k / 1.23
    sel = np.abs(tt - c) < 0.05
    env[sel] = np.maximum(env[sel], 0.5 + 0.5 * np.cos(2 * np.pi * (tt[sel] - c) / 0.1))
sig = np.sin(2 * np.pi * 80 * tt) * (0.7 + 0.6 * env)
mod = pm.modulation(sig, FS, 0.5, 3.0, 30)
chk('periodicity_peak finds 1.23 Hz within 0.02', abs(pm.periodicity_peak(mod, 0.5, 3.0, 3) - 1.23) <= 0.02, '%.3f' % pm.periodicity_peak(mod, 0.5, 3.0, 3))

# line levels: a -20 dB partial next to a 0 dB one
tone = np.sin(2 * np.pi * 300 * tt) + 0.1 * np.sin(2 * np.pi * 340 * tt)
f1, l1 = pm.line_level(tone, FS, 300, 2)
f2, l2 = pm.line_level(tone, FS, 340, 2)
chk('line_level: -20 dB partial measured within 0.1 dB', abs((l2 - l1) + 20) < 0.1, '%.3f' % (l2 - l1))
chk('line_level: frequencies within 0.02 Hz', abs(f1 - 300) < 0.02 and abs(f2 - 340) < 0.02)

# R5: the 10 ms hop. A 0.4 s burst 50 ms off the 100 ms grid: the old grid under-reads M-max by about 0.6 LU (the
# self-test's burst cases fail on it), the 10 ms hop reads -23.0
bb = np.concatenate([np.zeros((FS // 2 + FS // 20, 2)), pm._tone(-23, 0.4), np.zeros((FS // 2, 2))])
chk('M-max of a burst 50 ms off the grid: 100 ms grid under-reads (%.2f < -23.3), 10 ms hop -23.0 +-0.1 (%.3f)' % (
    pm.momentary_max(bb, FS, 0.1), pm.momentary_max(bb)), pm.momentary_max(bb, FS, 0.1) < -23.3 and abs(pm.momentary_max(bb) + 23) <= 0.1)
cr = rng.standard_normal(700).cumsum()
chk('max_rise_fast equals the reference max_rise on a random curve (spans 0.4, 2, 3 s, starts 0 and 37)',
    all(abs(pm.max_rise_fast(cr, sp, 0.01, st) - pm.max_rise(cr, sp, 0.01, st)) < 1e-12 for sp in (0.4, 2.0, 3.0) for st in (0, 37)))

# R2: memory-lean helpers give the same numbers as the full-array versions
big = rng.standard_normal((FS * 7, 2)) * 0.1
full_tp = 20 * np.log10(np.abs(_sig.resample_poly(big, 4, 1, axis=0)).max())
chk('blocked true peak equals resample_poly over the whole array (7 s stereo, > 2 blocks)', abs(pm.true_peak_dbtp(big, FS) - full_tp) < 1e-9,
    '%.12f vs %.12f' % (pm.true_peak_dbtp(big, FS), full_tp))
full_env = np.abs(_sig.resample_poly(big, 4, 1, axis=0)).max(axis=1).reshape(-1, 4).max(axis=1)
chk('blocked true-peak envelope equals the whole-array envelope', np.array_equal(pm.true_peak_envelope(big), full_env))
am = (1 + 0.3 * np.sin(2 * np.pi * 7 * tt)) * np.sin(2 * np.pi * 311.3 * tt) + 0.01 * rng.standard_normal(len(tt))
w = np.hanning(len(am))
nfft = 2 ** 23
Xf = np.abs(np.fft.rfft(am * w, nfft)) / (w.sum() / 2)
ff = np.fft.rfftfreq(nfft, 1 / FS)
ok_ll = True
for fc0, sh in ((311.3, 2.0), (304.3, 1.0), (318.3, 1.0)):
    msk = (ff >= fc0 - sh) & (ff <= fc0 + sh)
    i = int(np.argmax(np.where(msk, Xf, -1.0)))
    f_new, l_new = pm.line_level(am, FS, fc0, sh)
    ok_ll = ok_ll and abs(f_new - ff[i]) < 1e-9 and abs(l_new - 20 * np.log10(Xf[i])) < 1e-6
del Xf, ff
chk('band-limited line_level equals the 2^23-point zero-padded FFT (frequency and level)', ok_ll)
xm = rng.standard_normal(100001)
nf = _sfft.next_fast_len(len(xm))
chk('analytic_envelope equals |scipy.signal.hilbert| (odd and fast lengths)',
    np.allclose(pm.analytic_envelope(xm), np.abs(_sig.hilbert(xm)), rtol=0, atol=1e-12) and
    np.allclose(pm.analytic_envelope(xm, nf), np.abs(_sig.hilbert(xm, nf))[:len(xm)], rtol=0, atol=1e-12))

# V4 helper: DC counts, Parseval-exact weights, worst channel
tone1k = np.sin(2 * np.pi * 1000 * tt)
e12 = pm.sub_band_energy_db(tone1k + 0.1 * np.sin(2 * np.pi * 12 * tt), FS, 20)
chk('sub_band_energy_db: 12 Hz at -20 dB re a 1 kHz tone = -20 dB', abs(e12 + 20.0) < 0.1, '%.3f' % e12)
edc = pm.sub_band_energy_db(tone1k + 0.1, FS, 20)
chk('sub_band_energy_db: a DC offset of 0.1 on a 0.707 RMS tone = -17 dB', abs(edc + 16.99) < 0.1, '%.3f' % edc)

# band energy and LF share
lo = np.sin(2 * np.pi * 50 * tt) + np.sin(2 * np.pi * 1000 * tt)
chk('lf_share: 50 Hz + 1 kHz equal sines = 0.5', abs(pm.lf_share(lo, FS) - 0.5) < 0.01, '%.3f' % pm.lf_share(lo, FS))
chk('band_energy_db: 12 Hz at -20 dB re a 1 kHz tone = -20 dB', abs(pm.band_energy_db(np.sin(2 * np.pi * 1000 * tt) + 0.1 * np.sin(2 * np.pi * 12 * tt), FS, 1, 20) + 20.04) < 0.1)

bad = [r for r in rows if not r[1]]
for name, ok, d in rows:
    print('  %s  %s %s' % ('ok  ' if ok else 'FAIL', name, d))
print(('PASS' if not bad else 'FAIL') + ' resonance-meter-selftest: %d/%d checks (EBU Tech 3341/3342 cases, true peak, K-weighting, gate helpers)' % (len(rows) - len(bad), len(rows)))
sys.exit(1 if bad else 0)
