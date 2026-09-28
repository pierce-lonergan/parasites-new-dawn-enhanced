"""
declip_local.py: OPTIONAL local install step (TDD 2.3.4, "Existing hot assets"). Regenerates de-clipped,
loudness-preserving copies of the user's OWN Spore sounds with ffmpeg's adeclip filter, as a local resource pack.

Output goes only to the user's instance (<instance>/resourcepacks/pne_spore_declipped/) or to the temp folder
(%TEMP%). It never writes inside this repository, never modifies a jar and is never committed: the copies are
derived from closed-source audio, so they stay on the user's machine.

    python tools/resonance/declip_local.py --instance "<instance>"            dry run: list the clipped files
    python tools/resonance/declip_local.py --instance "<instance>" --write    write the resource pack into the instance
    python tools/resonance/declip_local.py --jar "<spore jar>" --out "%TEMP%\\pne_declip" --write

For every assets/spore/sounds/**/*.ogg in the Spore jar: decode it and count the samples at |x| >= 0.999 (what the
game's 16-bit clamp turns into hard clipping). Files with more than --min-clipped such samples are run through
ffmpeg's adeclip filter (to 32-bit float WAV), then through the pipeline's true-peak limiter (-2 dBTP, so <= -1 dBTP
decoded) and encoded as OGG Vorbis with the pipeline's G10 settings.

Loudness is KEPT, not normalised. DIRECTOR's per-sound volume trims in kubejs/assets/spore/sounds.json were computed
from the original files (the louder of the float decode and the 16-bit-clamped decode, tools/director/trims.py) and
multiply on top of whatever file plays, so the copy must play at the level the trim assumed: its gain is 0 dB, or
negative when adeclip made it louder than that reference (never louder). The limiter can only lower loudness: most
clipped Spore files get their loudness from clipping (measured on the instance's jar: 205 clipped files, median limiter
reduction 6.8 dB, median loudness change -4.3 LU), so a clean copy is quieter. A file whose loudness would drop by
more than --max-lu-change (default 3 LU, the +-3 dB L_eff residual the contract accepts at M2; 84 of the 205 files
qualify, 31 at 1 LU) is SKIPPED: not written, so the original keeps playing, clipped but at the trimmed level. Every
written copy is at most as loud as the level the trims assume, so the ledger's external-sound values err on the safe
side by at most that margin.
Every file's reference level, gain, limiter gain reduction and loudness change go into declip_report.json next to
pack.mcmeta. The pack carries pack.mcmeta (pack_format 15, Minecraft 1.20.1); the user enables it in Options >
Resource Packs.
Baked-in distortion is reduced, not removed: adeclip interpolates the clipped runs.
"""
import argparse
import glob
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile

import numpy as np
import soundfile as sf

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
import pne_meter as pm  # noqa: E402
import render as R  # noqa: E402

PACK_NAME = 'pne_spore_declipped'
PACK_MCMETA = {'pack': {'pack_format': 15, 'description': 'PNE local: de-clipped Spore sounds, generated from your own jar. Do not share.'}}
MAX_LU_CHANGE = 3.0   # the +-3 dB L_eff residual the contract accepts at M2 (IMPLEMENTATION 10)


def find_ffmpeg(explicit=''):
    for c in (explicit, os.environ.get('PNE_FFMPEG', ''), shutil.which('ffmpeg') or '', r'C:\ffmpeg\bin\ffmpeg.exe'):
        if c and os.path.isfile(c):
            return c
    return ''


def _inside(path, base):
    path, base = os.path.normcase(os.path.realpath(path)), os.path.normcase(os.path.realpath(base))
    return path == base or path.startswith(base.rstrip('\\/') + os.sep)


def check_out_dir(out_dir, instance=''):
    """The output folder must be inside the instance or the temp folder, and never inside this repository."""
    if _inside(out_dir, ROOT):
        raise SystemExit('refused: %s is inside the repository; de-clipped copies of closed-source audio never go there' % out_dir)
    allowed = [tempfile.gettempdir()]
    if os.environ.get('PNE_TMP'):
        allowed.append(os.environ['PNE_TMP'])
    if instance:
        allowed.append(instance)
    if not any(_inside(out_dir, a) for a in allowed if a):
        raise SystemExit('refused: %s is neither inside the instance nor inside the temp folder' % out_dir)


def find_spore_jar(instance):
    jars = sorted(glob.glob(os.path.join(instance, 'mods', 'spore*.jar')))
    return jars[0] if jars else ''


def clipped_count(data):
    x, fs = sf.read(io.BytesIO(data), dtype='float64')
    return int(np.count_nonzero(np.abs(x) >= 0.999)), x, fs


def reference_levels(x, fs):
    """(LUFS-I, M-max) the trims were computed from: the louder of the float decode and the 16-bit-clamped decode
    (tools/director/trims.py measures both and uses the louder one)."""
    xc = np.clip(x, -1.0, 32767.0 / 32768.0)
    return (max(pm.integrated_lufs(x, fs), pm.integrated_lufs(xc, fs)), max(pm.momentary_max(x, fs), pm.momentary_max(xc, fs)))


def declip_one(data, ffmpeg, work, max_lu_change=MAX_LU_CHANGE):
    """adeclip through ffmpeg, then a gain of min(0, reference - LUFS) and the -2 dBTP limiter. Returns
    (float array, or None when the file is skipped, fs, report)."""
    _, x0, fs0 = clipped_count(data)
    ref_i, ref_m = reference_levels(x0, fs0)
    src = os.path.join(work, 'in.ogg')
    dst = os.path.join(work, 'out.wav')
    with open(src, 'wb') as f:
        f.write(data)
    r = subprocess.run([ffmpeg, '-nostdin', '-hide_banner', '-v', 'error', '-y', '-i', src, '-af', 'adeclip',
                        '-c:a', 'pcm_f32le', dst], capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError('ffmpeg failed: ' + (r.stderr or '').strip()[:300])
    y, fs = sf.read(dst, dtype='float64')
    lufs = pm.integrated_lufs(y, fs)
    gain = min(0.0, ref_i - lufs) if np.isfinite(lufs) and np.isfinite(ref_i) else 0.0
    y = y * 10 ** (gain / 20)
    y, gr = R.limiter(y, fs, -2.0, 5.0, 50.0, 4)
    out_i, out_m = pm.integrated_lufs(y, fs), pm.momentary_max(y, fs)
    rep = {'ref_lufs': round(float(ref_i), 2), 'ref_mmax': round(float(ref_m), 2), 'declipped_lufs': round(float(lufs), 2),
           'gain_db': round(float(gain), 2), 'limiter_gr_db': round(gr, 2), 'lufs_out': round(float(out_i), 2),
           'mmax_out': round(float(out_m), 2), 'lufs_change': round(float(out_i - ref_i), 2), 'tp_out_dbtp': round(pm.true_peak_dbtp(y, fs), 2)}
    if not np.isfinite(out_i) or out_i - ref_i < -max_lu_change or out_i - ref_i > 0.05:
        rep['skipped'] = 'loudness would change by %.2f LU (limits -%.1f / +0.05): the trimmed original keeps playing' % (out_i - ref_i, max_lu_change)
        return None, fs, rep
    return y, fs, rep


def run(jar, out_dir, ffmpeg, write, min_clipped, limit=0, instance='', max_lu_change=MAX_LU_CHANGE):
    check_out_dir(out_dir, instance)
    spec = R.load_spec()
    rows = []
    with zipfile.ZipFile(jar) as z:
        names = sorted(n for n in z.namelist() if n.startswith('assets/spore/sounds/') and n.endswith('.ogg'))
        work = tempfile.mkdtemp(prefix='pne_declip_')
        try:
            for n in names:
                data = z.read(n)
                try:
                    k, _, _ = clipped_count(data)
                except Exception as e:
                    rows.append({'name': n, 'error': str(e)[:120]})
                    continue
                if k <= min_clipped:
                    continue
                row = {'name': n, 'clipped_samples': k}
                if write:
                    y, fs, rep = declip_one(data, ffmpeg, work, max_lu_change)
                    row.update(rep)
                    if y is not None:
                        out = os.path.join(out_dir, *n.split('/'))
                        os.makedirs(os.path.dirname(out), exist_ok=True)
                        if y.ndim == 2 and y.shape[1] == 1:
                            y = y[:, 0]
                        R.encode(y, out, dict(spec, fs=fs), R.fnv1a32(n) & 0x7FFFFFFF, spec['chain']['G10_encode']['compression_level'])
                        row['written'] = True
                rows.append(row)
                if limit and len([r for r in rows if 'clipped_samples' in r]) >= limit:
                    break
        finally:
            shutil.rmtree(work, ignore_errors=True)
    if write:
        os.makedirs(out_dir, exist_ok=True)
        with open(os.path.join(out_dir, 'pack.mcmeta'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump(PACK_MCMETA, f, indent=2)
            f.write('\n')
        with open(os.path.join(out_dir, 'declip_report.json'), 'w', encoding='utf-8', newline='\n') as f:
            json.dump({'max_lu_change': max_lu_change, 'files': rows}, f, indent=1, sort_keys=True)
            f.write('\n')
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--instance', default=os.environ.get('PNE_INSTANCE', ''), help='the CurseForge instance folder')
    ap.add_argument('--jar', default='', help='the Spore jar (default: <instance>/mods/spore*.jar)')
    ap.add_argument('--out', default='', help='output pack folder (default: <instance>/resourcepacks/%s)' % PACK_NAME)
    ap.add_argument('--write', action='store_true', help='write the pack (default: dry run)')
    ap.add_argument('--min-clipped', type=int, default=10, help='clipped samples needed to process a file (default 10)')
    ap.add_argument('--limit', type=int, default=0, help='stop after this many clipped files (0 = all)')
    ap.add_argument('--ffmpeg', default='')
    ap.add_argument('--max-lu-change', type=float, default=MAX_LU_CHANGE,
                    help='skip a file whose loudness the limiter would lower by more than this (default 3 LU)')
    args = ap.parse_args(argv)
    jar = args.jar or (find_spore_jar(args.instance) if args.instance else '')
    if not jar or not os.path.isfile(jar):
        print('no Spore jar found: pass --instance "<instance>" or --jar <path>')
        return 2
    out = args.out or (os.path.join(args.instance, 'resourcepacks', PACK_NAME) if args.instance else '')
    if not out:
        print('pass --out (inside %%TEMP%%) or --instance')
        return 2
    ffmpeg = find_ffmpeg(args.ffmpeg)
    if args.write and not ffmpeg:
        print('ffmpeg not found (pass --ffmpeg or set PNE_FFMPEG)')
        return 2
    rows = run(jar, out, ffmpeg, args.write, args.min_clipped, args.limit, args.instance, args.max_lu_change)
    clipped = [r for r in rows if 'clipped_samples' in r]
    for r in clipped:
        if 'skipped' in r:
            tail = '  ->  SKIPPED: %s' % r['skipped']
        elif 'lufs_out' in r:
            tail = '  ->  %.1f LUFS (reference %.1f, change %+.2f LU, limiter %.1f dB), %.1f dBTP' % (
                r['lufs_out'], r['ref_lufs'], r['lufs_change'], r['limiter_gr_db'], r['tp_out_dbtp'])
        else:
            tail = ''
        print('  %-60s clipped %6d%s' % (r['name'], r['clipped_samples'], tail))
    for r in rows:
        if 'error' in r:
            print('  skipped %s: %s' % (r['name'], r['error']))
    written = len([r for r in clipped if r.get('written')])
    skipped = len([r for r in clipped if 'skipped' in r])
    if args.write:
        print('%d clipped file(s): %d written to %s, %d skipped (loudness would change by more than %.1f LU)' % (
            len(clipped), written, out, skipped, args.max_lu_change))
    else:
        print('%d clipped file(s) (dry run: add --write)' % len(clipped))
    return 0


if __name__ == '__main__':
    sys.exit(main())
