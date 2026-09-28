"""
pne_meter: loudness and signal metrics for The Resonance (port of the measured prototype, TDD 2.6 and Appendix B).

  - ITU-R BS.1770-4 K-weighting with the exact 48 kHz biquad coefficients (other rates: re-derived from the
    analog prototypes, libebur128 method, < 0.01 dB in the audible band);
  - gated integrated loudness (LUFS-I, 400 ms blocks at 75% overlap as BS.1770-4 requires), momentary (400 ms) and
    short-term (3 s) curves on a 10 ms hop (so a maximum or a rise cannot hide between the blocks of a 100 ms grid:
    EBU Tech 3341 max-momentary / max-short-term cases), EBU Tech 3342 LRA (short-term at 10 Hz, as 3342 specifies);
  - 4x-oversampled true peak (BS.1770-4 Annex 2 approximation with scipy's polyphase FIR, computed per channel in
    blocks so a 50 s stereo bed needs a few MB, not 300), sample peak, crest;
  - spectral peaks, spectral centroid, band energy, LF share;
  - Hilbert envelope analysis: envelope spectrum peak (prototype), normalised modulation spectrum with a
    sinusoid-equivalent line depth, per-cycle peak-to-trough depth;
  - spectral line levels (for AM sideband checks) and the in-file level-rise measure used by gate V15.

Self-test (EBU Tech 3341 / 3342 synthetic cases, true peak, K-weighting at 19 Hz):

    python tools/resonance/pne_meter.py            prints every check, last line PASS or FAIL, exit 0/1

Pure numpy + scipy. Every function takes float arrays shaped (n,) (mono) or (n, channels).
"""
import sys

import numpy as np
from scipy import fft as sfft
from scipy import ndimage, signal

FS = 48000
HOP_S = 0.01          # momentary / short-term curve hop (V15 rises, M-max, S-max)
LRA_HOP_S = 0.1       # EBU Tech 3342: short-term loudness at 10 Hz for the loudness range

# BS.1770-4 Table 1 / Table 2 (fs = 48000)
_S1_B48 = np.array([1.53512485958697, -2.69169618940638, 1.19839281085285])
_S1_A48 = np.array([1.0, -1.69065929318241, 0.73248077421585])
_S2_B48 = np.array([1.0, -2.0, 1.0])
_S2_A48 = np.array([1.0, -1.99004745483398, 0.99007225036621])


def _kweight_coeffs(fs):
    if fs == 48000:
        return (_S1_B48, _S1_A48), (_S2_B48, _S2_A48)
    # analog-prototype re-derivation (libebur128 method)
    f0 = 1681.974450955533
    G = 3.999843853973347
    Q = 0.7071752369554196
    K = np.tan(np.pi * f0 / fs)
    Vh = 10 ** (G / 20.0)
    Vb = Vh ** 0.4996667741545416
    a0 = 1.0 + K / Q + K * K
    b1 = np.array([(Vh + Vb * K / Q + K * K) / a0, 2.0 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0])
    a1 = np.array([1.0, 2.0 * (K * K - 1.0) / a0, (1.0 - K / Q + K * K) / a0])
    f0 = 38.13547087602444
    Q = 0.5003270373238773
    K = np.tan(np.pi * f0 / fs)
    a2 = np.array([1.0, 2.0 * (K * K - 1.0) / (1.0 + K / Q + K * K), (1.0 - K / Q + K * K) / (1.0 + K / Q + K * K)])
    b2 = np.array([1.0, -2.0, 1.0])
    return (b1, a1), (b2, a2)


def as2d(x):
    x = np.asarray(x, dtype=np.float64)
    return x[:, None] if x.ndim == 1 else x


def mono(x):
    """Channel average (what Dynamic Surroundings' downmix does to a stereo /playsound source)."""
    return as2d(x).mean(axis=1)


def kweight(x, fs=FS):
    (b1, a1), (b2, a2) = _kweight_coeffs(fs)
    y = signal.lfilter(b1, a1, as2d(x), axis=0)
    return signal.lfilter(b2, a2, y, axis=0)


def kweight_gain_db(f, fs=FS):
    """K-weighting magnitude response at frequency f (dB)."""
    (b1, a1), (b2, a2) = _kweight_coeffs(fs)
    w = 2 * np.pi * np.atleast_1d(np.asarray(f, dtype=np.float64)) / fs
    _, h1 = signal.freqz(b1, a1, w)
    _, h2 = signal.freqz(b2, a2, w)
    return 20 * np.log10(np.abs(h1 * h2))


def _block_power(y, fs, win_s, hop_s):
    n = int(round(win_s * fs))
    h = int(round(hop_s * fs))
    if y.shape[0] < n:
        return np.zeros((0,))
    starts = np.arange(0, y.shape[0] - n + 1, h)
    cs = np.cumsum(np.vstack([np.zeros((1, y.shape[1])), y * y]), axis=0)
    z = (cs[starts + n] - cs[starts]) / n          # mean square per channel
    G = np.ones(y.shape[1])                         # L, R, C = 1.0 (surround weights not used)
    return (z * G).sum(axis=1)


def _lk(p):
    return -0.691 + 10 * np.log10(np.maximum(p, 1e-20))


def integrated_lufs(x, fs=FS):
    p = _block_power(kweight(x, fs), fs, 0.4, 0.1)
    if p.size == 0:
        return float('-inf')
    lv = _lk(p)
    p = p[lv > -70.0]
    if p.size == 0:
        return float('-inf')
    rel = _lk(p.mean()) - 10.0
    p2 = p[_lk(p) > rel]
    return float(_lk(p2.mean())) if p2.size else float('-inf')


def momentary_curve(x, fs=FS, hop_s=HOP_S):
    """Momentary loudness (400 ms rectangular window) every hop_s (default 10 ms); window k starts at k * hop_s."""
    p = _block_power(kweight(x, fs), fs, 0.4, hop_s)
    return _lk(p) if p.size else np.array([])


def momentary_max(x, fs=FS, hop_s=HOP_S):
    c = momentary_curve(x, fs, hop_s)
    return float(c.max()) if c.size else float('-inf')


def short_term(x, fs=FS, hop_s=HOP_S):
    """Short-term loudness (3 s rectangular window) every hop_s (default 10 ms)."""
    p = _block_power(kweight(x, fs), fs, 3.0, hop_s)
    return _lk(p) if p.size else np.array([])


def short_term_max(x, fs=FS, hop_s=HOP_S):
    c = short_term(x, fs, hop_s)
    return float(c.max()) if c.size else float('-inf')


def lra(x, fs=FS):
    st = short_term(x, fs, LRA_HOP_S)
    if st.size < 2:
        return 0.0
    p = 10 ** ((st + 0.691) / 10)
    keep = st > -70
    if keep.sum() < 2:
        return 0.0
    rel = _lk(p[keep].mean()) - 20.0
    s = st[keep & (st > rel)]
    if s.size < 2:
        return 0.0
    return float(np.percentile(s, 95) - np.percentile(s, 10))


_TP_BLOCK = 1 << 17      # input samples per oversampling block
_TP_MARGIN = 256         # context on each side of a block (the 4x FIR spans 81 taps = about 20 input samples)


def _oversampled_blocks(x1, os):
    """Yield (start, abs of the os-times oversampled signal for input samples start..start+len) for one channel,
    block by block. Each output equals the same samples of signal.resample_poly(x1, os, 1) over the whole array
    (every output is the same FIR sum over the same inputs; the margins cover the filter support), so the result
    does not depend on the block size, while memory stays at a few MB for any file length."""
    n = x1.shape[0]
    if n <= _TP_BLOCK + 2 * _TP_MARGIN:
        yield 0, np.abs(signal.resample_poly(x1, os, 1))
        return
    for s in range(0, n, _TP_BLOCK):
        e = min(n, s + _TP_BLOCK)
        a, b = max(0, s - _TP_MARGIN), min(n, e + _TP_MARGIN)
        seg = np.zeros(b - a + (_TP_MARGIN if a == 0 else 0) + (_TP_MARGIN if b == n else 0))
        off = _TP_MARGIN if a == 0 else 0
        seg[off:off + (b - a)] = x1[a:b]
        y = signal.resample_poly(seg, os, 1)
        i0 = (off + (s - a)) * os
        yield s, np.abs(y[i0:i0 + (e - s) * os])


def true_peak_dbtp(x, fs=FS, os=4):
    x2 = as2d(x)
    m = 0.0
    for ch in range(x2.shape[1]):
        for _, y in _oversampled_blocks(np.ascontiguousarray(x2[:, ch]), os):
            if y.size:
                m = max(m, float(y.max()))
    return float(20 * np.log10(max(m, 1e-12)))


def true_peak_envelope(x, os=4):
    """Per-sample true-peak estimate: max |x| over the os oversampled points of each input sample (all channels)."""
    x2 = as2d(x)
    n = x2.shape[0]
    out = np.zeros(n)
    for ch in range(x2.shape[1]):
        for s, y in _oversampled_blocks(np.ascontiguousarray(x2[:, ch]), os):
            k = min(n - s, y.size // os)
            np.maximum(out[s:s + k], y[:k * os].reshape(k, os).max(axis=1), out=out[s:s + k])
    return out


def sample_peak_abs(x):
    return float(np.abs(np.asarray(x)).max()) if np.asarray(x).size else 0.0


def sample_peak_dbfs(x):
    return float(20 * np.log10(max(sample_peak_abs(x), 1e-12)))


def rms(x):
    x = as2d(x)
    return float(np.sqrt(max(np.mean(x * x), 1e-40)))


def rms_dbfs(x):
    x = as2d(x)
    return float(10 * np.log10(max(np.mean(x * x), 1e-20)))


def crest_db(x):
    return sample_peak_dbfs(x) - rms_dbfs(x)


def spectrum_peaks(x, fs=FS, n=8, fmin=5, fmax=20000):
    x = mono(x)
    w = np.hanning(len(x))
    X = np.abs(np.fft.rfft(x * w))
    f = np.fft.rfftfreq(len(x), 1 / fs)
    X = X / (w.sum() / 2)
    sel = (f >= fmin) & (f <= fmax)
    idx = signal.find_peaks(X * sel, distance=max(1, int(3 / (f[1] - f[0]))))[0]
    idx = idx[np.argsort(X[idx])[::-1][:n]]
    return sorted([(round(float(f[i]), 2), round(float(20 * np.log10(X[i] + 1e-12)), 1)) for i in idx])


def spectral_centroid(x, fs=FS):
    x = mono(x)
    X = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / fs)
    tot = X.sum()
    return float((f * X).sum() / tot) if tot > 0 else 0.0


def band_energy_db(x, fs=FS, lo=1.0, hi=20.0):
    """Unweighted FFT energy in [lo, hi) Hz relative to the total (dB)."""
    x = mono(x)
    X = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / fs)
    tot = X.sum()
    b = X[(f >= lo) & (f < hi)].sum()
    return float(10 * np.log10(max(b / max(tot, 1e-40), 1e-20)))


def sub_band_energy_db(x, fs=FS, hi=20.0):
    """Gate V4 (TDD 2.6: 'unweighted FFT energy below 20 Hz'): energy in [0, hi) Hz, DC included, relative to the
    total, with Parseval-exact one-sided weights (bins other than DC and Nyquist count twice). Per channel; the
    worst channel is returned, so a stereo bed cannot hide one channel's sub-bass in the channel average."""
    x2 = as2d(x)
    n = x2.shape[0]
    f = np.fft.rfftfreq(n, 1 / fs)
    wgt = np.full(f.shape, 2.0)
    wgt[0] = 1.0
    if n % 2 == 0:
        wgt[-1] = 1.0
    sel = f < hi
    worst = -400.0
    for ch in range(x2.shape[1]):
        P = np.abs(np.fft.rfft(x2[:, ch])) ** 2 * wgt
        tot = P.sum()
        worst = max(worst, float(10 * np.log10(max(P[sel].sum() / max(tot, 1e-40), 1e-40))))
    return worst


def lf_share(x, fs=FS, fc=100.0):
    """Fraction of total power below fc (gate V5)."""
    x = mono(x)
    X = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / fs)
    tot = X.sum()
    return float(X[f < fc].sum() / tot) if tot > 0 else 0.0


def bandpass(x, fs, lo, hi, order=4):
    """Butterworth band-pass, `order` per skirt (order 4 = 24 dB/oct each side), single-pass sosfilt."""
    sos = signal.butter(order, [lo, hi], 'bandpass', fs=fs, output='sos')
    return signal.sosfilt(sos, as2d(x), axis=0)


def frame_rms(x, fs, frame_s=0.01):
    """RMS per non-overlapping frame of the channel-summed power."""
    x = as2d(x)
    n = int(round(frame_s * fs))
    m = x.shape[0] // n
    if m == 0:
        return np.zeros(0), n
    p = (x[:m * n] ** 2).sum(axis=1).reshape(m, n).mean(axis=1)
    return np.sqrt(p), n


def active_band_rms(x, fs, lo, hi, floor_db=20.0, frame_s=0.01):
    """Band-limited RMS over the active frames: frames whose band RMS is within floor_db of the loudest frame.
    Used for the whisper level in gate V10 (the prototype measured during the bursts only)."""
    y = bandpass(x, fs, lo, hi)
    fr, n = frame_rms(y, fs, frame_s)
    if fr.size == 0:
        return 0.0, 0.0
    thr = fr.max() * 10 ** (-floor_db / 20)
    act = fr >= thr
    return float(np.sqrt(np.mean(fr[act] ** 2))), float(act.mean())


def span_band_rms(x, fs, lo, hi, floor_db=30.0, frame_s=0.005):
    """Band-limited RMS from the first to the last frame within floor_db of the loudest frame (gaps included).
    Used for the tell level in gate V16 (conservative: the gaps between clicks count)."""
    y = bandpass(x, fs, lo, hi)
    fr, n = frame_rms(y, fs, frame_s)
    if fr.size == 0:
        return 0.0, 0.0
    idx = np.nonzero(fr >= fr.max() * 10 ** (-floor_db / 20))[0]
    seg = fr[idx[0]:idx[-1] + 1]
    return float(np.sqrt(np.mean(seg ** 2))), float(len(seg) * frame_s)


# ---------------------------------------------------------------------------------------------- envelopes

def envelope_spectrum_peak(x, fs=FS, fmin=0.5, fmax=60):
    """Hilbert-envelope modulation spectrum peak (prototype function, kept for reference)."""
    x = mono(x)
    env = np.abs(signal.hilbert(x))
    env = env - env.mean()
    E = np.abs(np.fft.rfft(env * np.hanning(len(env))))
    f = np.fft.rfftfreq(len(env), 1 / fs)
    sel = (f >= fmin) & (f <= fmax)
    i = np.argmax(E * sel)
    return float(f[i])


def analytic_envelope(x, nf=None):
    """|hilbert(x, nf)|[:len(x)] (scipy.signal.hilbert's definition) with about half its temporary memory."""
    n = len(x)
    nf = nf or n
    X = sfft.fft(x, nf)
    if nf % 2 == 0:
        X[1:nf // 2] *= 2.0
        X[nf // 2 + 1:] = 0.0
    else:
        X[1:(nf + 1) // 2] *= 2.0
        X[(nf + 1) // 2:] = 0.0
    a = sfft.ifft(X, overwrite_x=True)
    del X
    return np.abs(a[:n])


def envelope(x, fs=FS, lp_hz=60.0, out_fs=1000):
    """Smoothed Hilbert envelope (zero-phase Butterworth BW4 low-pass at lp_hz, as the prototype's env_depth),
    decimated to out_fs. Returns (env, out_fs)."""
    x = mono(x)
    n = len(x)
    nf = sfft.next_fast_len(n)
    env = analytic_envelope(x, nf)
    sos = signal.butter(4, lp_hz, 'low', fs=fs, output='sos')
    env = signal.sosfiltfilt(sos, env)
    step = max(1, int(round(fs / out_fs)))
    return np.maximum(env[::step], 0.0), fs / step


def modulation(x, fs=FS, fmin=0.5, fmax=60.0, lp_hz=60.0, norm_s=None, valid_db=-20.0):
    """Modulation analysis of the envelope, robust to fades and slow level changes.

    The smoothed envelope is divided by its slow upper envelope (running maximum over norm_s, default
    1.25 / fmin, then a moving average of the same length), over the region where that upper envelope is
    within valid_db of its maximum. Returns a dict:
      peak_hz     frequency of the largest line in [fmin, fmax] (zero-padded to <= 0.005 Hz)
      line_depth  sinusoid-equivalent modulation index of that line, 2|X(f)| / X(0)
      depth_at    function f -> line depth at f (for rule checks at a known rate)
      env, efs, upper, valid (arrays used by periodic_depth)
    """
    env, efs = envelope(x, fs, lp_hz)
    if norm_s is None:
        norm_s = 1.25 / max(fmin, 1e-3)
    w = max(3, int(round(norm_s * efs)))
    up = ndimage.maximum_filter1d(env, w, mode='nearest')
    up = ndimage.uniform_filter1d(up, w, mode='nearest')
    up = np.maximum(up, 1e-12)
    valid = up >= up.max() * 10 ** (valid_db / 20)
    idx = np.nonzero(valid)[0]
    res = {'env': env, 'efs': efs, 'upper': up, 'valid': valid, 'peak_hz': 0.0, 'line_depth': 0.0}
    if idx.size < 8:
        res['depth_at'] = lambda f: 0.0
        return res
    seg = (env / up)[idx[0]:idx[-1] + 1]
    win = np.hanning(len(seg))
    dc = float((seg * win).sum())
    s0 = seg - (seg * win).sum() / win.sum()
    nfft = max(sfft.next_fast_len(len(seg)), int(2 ** np.ceil(np.log2(efs / 0.005))))
    X = np.abs(np.fft.rfft(s0 * win, nfft))
    f = np.fft.rfftfreq(nfft, 1 / efs)
    sel = (f >= fmin) & (f <= fmax)
    if not sel.any() or dc <= 0:
        res['depth_at'] = lambda fq: 0.0
        return res
    i = int(np.argmax(np.where(sel, X, -1.0)))
    res['peak_hz'] = float(f[i])
    res['line_depth'] = float(2 * X[i] / dc)
    res['spectrum'] = (f, 2 * X / dc)

    def depth_at(fq, half_bw=0.1):
        m = (f >= fq - half_bw) & (f <= fq + half_bw)
        return float((2 * X[m] / dc).max()) if m.any() else 0.0
    res['depth_at'] = depth_at
    return res


def max_line_depth(mod, fmin, fmax):
    """Largest sinusoid-equivalent line depth of a modulation() result in [fmin, fmax] Hz."""
    if 'spectrum' not in mod:
        return 0.0, 0.0
    f, d = mod['spectrum']
    m = (f >= fmin) & (f <= fmax)
    if not m.any():
        return 0.0, 0.0
    i = int(np.argmax(np.where(m, d, -1.0)))
    return float(d[i]), float(f[i])


def periodicity_peak(mod, fmin, fmax, harmonics=3):
    """Envelope periodicity: the peak in [fmin, fmax] of the harmonic sum sum_h D(h f) / h of the line-depth
    spectrum of a modulation() result (sharper than the single line through short fades)."""
    if 'spectrum' not in mod:
        return 0.0
    f, d = mod['spectrum']
    P = np.zeros_like(d)
    for h in range(1, harmonics + 1):
        P += np.interp(f * h, f, d, right=0.0) / h
    sel = (f >= fmin) & (f <= fmax)
    return float(f[int(np.argmax(np.where(sel, P, -1.0)))])


def periodic_depth(mod, rate_hz, core_db=-6.0):
    """Median per-cycle peak-to-trough depth (max - min) / (max + min) of the smoothed envelope, over whole
    cycles of 1 / rate_hz inside the core region (upper envelope within core_db of its maximum)."""
    env, efs, up = mod['env'], mod['efs'], mod['upper']
    core = np.nonzero(up >= up.max() * 10 ** (core_db / 20))[0]
    if core.size == 0 or rate_hz <= 0:
        return 0.0
    L = int(round(efs / rate_hz))
    if L < 3:
        return 0.0
    a, b = core[0], core[-1] + 1
    depths = []
    k = a
    while k + L <= b:
        c = env[k:k + L]
        mx, mn = c.max(), c.min()
        if mx + mn > 0:
            depths.append((mx - mn) / (mx + mn))
        k += L
    return float(np.median(depths)) if depths else 0.0


def line_level(x, fs, f_center, search_hz=1.0, pad_to_hz=0.01):
    """Frequency and level (dB, amplitude) of the strongest spectral line within f_center +- search_hz
    (Hann window). The spectrum is evaluated only inside the search band, on exactly the bins of a Hann-windowed
    FFT zero-padded to nfft = 2^ceil(log2(fs / pad_to_hz)) points (0.0057 Hz at 48 kHz), with a chirp-z zoom
    transform: the same numbers as that FFT, but O(n) memory instead of a 2^23-point array per call."""
    x = mono(x)
    w = np.hanning(len(x))
    nfft = max(len(x), int(2 ** np.ceil(np.log2(fs / pad_to_hz))))
    df = fs / nfft
    k0 = max(0, int(np.ceil((f_center - search_hz) / df - 1e-9)))
    k1 = min(nfft // 2, int(np.floor((f_center + search_hz) / df + 1e-9)))
    m = k1 - k0 + 1
    X = np.abs(signal.zoom_fft(x * w, [k0 * df, k1 * df], m=m, fs=fs, endpoint=True)) / (w.sum() / 2)
    i = int(np.argmax(X))
    return float((k0 + i) * df), float(20 * np.log10(max(X[i], 1e-15)))


def max_rise(curve, span_s, hop_s=0.1, start=0):
    """Largest rise of a loudness curve within span_s: max over i >= start of max(c[i..i+span]) - c[i]
    (the prototype l6_check2 definition)."""
    c = np.asarray(curve, dtype=np.float64)
    if c.size == 0 or start >= c.size:
        return 0.0
    s = int(round(span_s / hop_s))
    best = 0.0
    for i in range(start, c.size):
        j = min(c.size, i + s + 1)
        best = max(best, float(np.max(c[i:j]) - c[i]))
    return best


def max_rise_fast(curve, span_s, hop_s=HOP_S, start=0):
    """max_rise, vectorised (same result): max over i >= start of max(c[i..i+s]) - c[i]. The curve is padded at the
    end with its last value, which is already inside every truncated window, so the window maxima are exact."""
    c = np.asarray(curve, dtype=np.float64)
    if c.size == 0 or start >= c.size:
        return 0.0
    s = int(round(span_s / hop_s))
    pad = np.concatenate([c, np.full(s, c[-1])])
    fwd = np.lib.stride_tricks.sliding_window_view(pad, s + 1).max(axis=1)
    return max(0.0, float(np.max(fwd[start:] - c[start:])))


def rise_after(x, fs, start_s, window_s, hop_s=HOP_S):
    """Gate V15 measure: the largest rise of momentary (400 ms) and of short-term (3 s) loudness within window_s,
    over windows that start at or after start_s (the end of the file's onset fade: the onset itself is the
    ledger's level-jump concern, TDD 2.3.4). Curves on a 10 ms hop, so the result does not depend on where
    playback starts relative to a 100 ms block grid. Returns (max, momentary rise, short-term rise)."""
    k = int(np.ceil(start_s / hop_s - 1e-9))
    cm = momentary_curve(x, fs, hop_s)
    cs = short_term(x, fs, hop_s)
    rm = max_rise_fast(cm, window_s, hop_s, k) if cm.size > k else 0.0
    rs = max_rise_fast(cs, window_s, hop_s, k) if cs.size > k else 0.0
    return max(rm, rs), rm, rs


def report(name, x, fs=FS):
    return {
        'name': name,
        'dur_s': round(len(x) / fs, 2),
        'lufs_i': round(integrated_lufs(x, fs), 2),
        'lufs_m_max': round(momentary_max(x, fs), 2),
        'lra_lu': round(lra(x, fs), 2),
        'sample_peak_dbfs': round(sample_peak_dbfs(x), 2),
        'true_peak_dbtp': round(true_peak_dbtp(x, fs), 2),
        'rms_dbfs': round(rms_dbfs(x), 2),
        'crest_db': round(crest_db(x), 2),
    }


# ---------------------------------------------------------------------------------------------- self-test

def _tone(level_dbfs, dur, fs=FS, stereo=True, f=1000.0):
    t = np.arange(int(round(dur * fs))) / fs
    s = 10 ** (level_dbfs / 20) * np.sin(2 * np.pi * f * t)
    return np.stack([s, s], axis=1) if stereo else s


def _seq(parts, fs=FS):
    return np.concatenate([_tone(lv, d, fs) for lv, d in parts], axis=0)


def selftest():
    """Returns a list of (name, measured, expected, tolerance, ok). EBU Tech 3341 cases 1-5 and 12 (synthetic
    1 kHz stereo sequences), EBU Tech 3342 LRA cases 1-4, true peak of an fs/4 sine at 45 degrees (samples at
    +-0.707, true peak 0 dBFS), the 44.1 kHz coefficient derivation, and K-weighting at 19 Hz (TDD V4 note)."""
    out = []

    def chk(name, val, exp, tol):
        out.append((name, round(float(val), 3), exp, tol, bool(abs(val - exp) <= tol)))

    chk('EBU3341 case 1: 20 s 1 kHz at -23 dBFS, LUFS-I', integrated_lufs(_seq([(-23, 20)])), -23.0, 0.1)
    chk('EBU3341 case 2: 20 s 1 kHz at -33 dBFS, LUFS-I', integrated_lufs(_seq([(-33, 20)])), -33.0, 0.1)
    chk('EBU3341 case 3: -36/-23/-36 dBFS 10/60/10 s, LUFS-I', integrated_lufs(_seq([(-36, 10), (-23, 60), (-36, 10)])), -23.0, 0.1)
    chk('EBU3341 case 4: -72/-36/-23/-36/-72, LUFS-I',
        integrated_lufs(_seq([(-72, 10), (-36, 10), (-23, 60), (-36, 10), (-72, 10)])), -23.0, 0.1)
    chk('EBU3341 case 5: -26/-20/-26 dBFS 20/20.1/20 s, LUFS-I', integrated_lufs(_seq([(-26, 20), (-20, 20.1), (-26, 20)])), -23.0, 0.1)
    m = momentary_curve(_seq([(-23, 10)]))
    chk('steady -23 dBFS tone: momentary max', float(m.max()), -23.0, 0.1)
    chk('steady -23 dBFS tone: momentary min', float(m.min()), -23.0, 0.1)
    s = short_term(_seq([(-23, 10)]))
    chk('steady -23 dBFS tone: short-term median', float(np.median(s)), -23.0, 0.1)
    # EBU Tech 3341 case 9: 20 x (1.34 s at -20 dBFS + 1.66 s at -30 dBFS): short-term constant -23 +-0.1 after 3 s
    s = short_term(_seq([(-20, 1.34), (-30, 1.66)] * 20))
    chk('EBU3341 case 9: 1.34/1.66 s at -20/-30 dBFS, short-term max', float(s.max()), -23.0, 0.1)
    chk('EBU3341 case 9: 1.34/1.66 s at -20/-30 dBFS, short-term min', float(s.min()), -23.0, 0.1)
    # EBU Tech 3341 case 12: 20 x (0.18 s at -20 dBFS + 0.22 s at -30 dBFS): momentary constant -23 +-0.1
    m = momentary_curve(_seq([(-20, 0.18), (-30, 0.22)] * 20))
    chk('EBU3341 case 12: 0.18/0.22 s at -20/-30 dBFS, momentary max', float(m.max()), -23.0, 0.1)
    chk('EBU3341 case 12: 0.18/0.22 s at -20/-30 dBFS, momentary min', float(m.min()), -23.0, 0.1)
    # EBU Tech 3341 max-momentary / max-short-term cases: a lone 0.4 s (3 s) burst at -23 dBFS must read -23 +-0.1
    # wherever it starts relative to the block grid (a 100 ms grid under-reads an off-grid burst by up to 0.6 LU)
    for off_ms in (0, 3, 27, 50, 77, 95):
        sil = np.zeros((int(round(off_ms * FS / 1000)) + FS // 2, 2))
        b = np.concatenate([sil, _tone(-23, 0.4), np.zeros((FS // 2, 2))])
        chk('0.4 s burst at -23 dBFS starting %d ms off the grid: momentary max' % off_ms, momentary_max(b), -23.0, 0.1)
    for off_ms in (0, 41, 88):
        sil = np.zeros((int(round(off_ms * FS / 1000)) + FS, 2))
        b = np.concatenate([sil, _tone(-23, 3.0), np.zeros((FS, 2))])
        chk('3 s burst at -23 dBFS starting %d ms off the grid: short-term max' % off_ms, short_term_max(b), -23.0, 0.1)
    chk('mono 1 kHz at 0 dBFS, LUFS-I', integrated_lufs(_tone(0, 10, stereo=False)), -3.01, 0.05)
    chk('EBU3342 case 1: -20/-30 dBFS 20/20 s, LRA', lra(_seq([(-20, 20), (-30, 20)])), 10.0, 1.0)
    chk('EBU3342 case 2: -20/-15 dBFS 20/20 s, LRA', lra(_seq([(-20, 20), (-15, 20)])), 5.0, 1.0)
    chk('EBU3342 case 3: -40/-20 dBFS 20/20 s, LRA', lra(_seq([(-40, 20), (-20, 20)])), 20.0, 1.0)
    chk('EBU3342 case 4: -50/-35/-20/-35/-50 dBFS, LRA',
        lra(_seq([(-50, 20), (-35, 20), (-20, 20), (-35, 20), (-50, 20)])), 15.0, 1.0)
    t = np.arange(FS * 2) / FS
    isp = np.sin(2 * np.pi * (FS / 4) * t + np.pi / 4)
    chk('fs/4 sine at 45 deg: sample peak dBFS', sample_peak_dbfs(isp), -3.01, 0.02)
    chk('fs/4 sine at 45 deg: true peak dBTP (4x)', true_peak_dbtp(isp), 0.0, 0.2)
    chk('1 kHz at -6 dBFS: true peak dBTP', true_peak_dbtp(_tone(-6, 1, stereo=False)), -6.0, 0.05)
    t44 = np.arange(441000) / 44100
    s44 = 10 ** (-23 / 20) * np.sin(2 * np.pi * 1000 * t44)
    chk('44.1 kHz derivation: 1 kHz -23 dBFS stereo, LUFS-I', integrated_lufs(np.stack([s44, s44], 1), 44100), -23.0, 0.1)
    chk('K-weighting at 19 Hz relative to 1 kHz (dB)', float(kweight_gain_db(19)[0] - kweight_gain_db(1000)[0]), -14.68, 0.02)
    # envelope helpers: 200 + 206 Hz monaural beat (TDD M6: envelope peak 6.0 Hz, depth 0.94+)
    beat = np.sin(2 * np.pi * 200 * t) + np.sin(2 * np.pi * 206 * t)
    mod = modulation(np.concatenate([beat, beat, beat, beat]), FS, 2.0, 20.0)
    chk('200+206 Hz beat: envelope peak (Hz)', mod['peak_hz'], 6.0, 0.02)
    chk('200+206 Hz beat: per-cycle envelope depth (TDD M6 measured 0.94)', periodic_depth(mod, 6.0), 0.94, 0.01)
    am = (1 + 0.5 * np.sin(2 * np.pi * 4 * np.arange(FS * 8) / FS)) * np.sin(2 * np.pi * 1000 * np.arange(FS * 8) / FS)
    mod = modulation(am, FS, 2.0, 20.0)
    chk('1 kHz AM 4 Hz m=0.5: line depth', mod['line_depth'], 0.5, 0.02)
    fc, lc = line_level(am, FS, 1000.0)
    fl, ll = line_level(am, FS, 996.0)
    chk('1 kHz AM 4 Hz m=0.5: sideband level re carrier (dB)', ll - lc, 20 * np.log10(0.25), 0.1)
    return out


def main():
    rows = selftest()
    bad = 0
    for name, val, exp, tol, ok in rows:
        bad += not ok
        print(f"  {'ok  ' if ok else 'FAIL'}  {name}: {val} (expect {exp} +- {tol})")
    print(('PASS' if not bad else 'FAIL') + f" pne_meter self-test: {len(rows) - bad}/{len(rows)} checks")
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
