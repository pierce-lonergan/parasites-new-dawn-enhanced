"""
Suite resonance-declip: the optional local de-clip tool (declip_local.py) refuses to write into the repository or
anywhere outside the instance / temp folder, dry-runs by default, and on synthetic clipped files (a fake "Spore" jar
built in PNE_TMP; no closed-source audio is used):

  - a mildly clipped file is written de-clipped at <= -1 dBTP with no sample at or above 0.999, and at the loudness
    DIRECTOR's trims assume (within 1 LU of the louder of its float and 16-bit-clamped decodes, never louder): it is
    NOT normalised to -20 LUFS, which would attenuate the trimmed Spore cues twice (review finding R-RES-R4);
  - a file the limiter would have to lower by more than --max-lu-change is skipped (not written) and reported: the
    heavy test file (about -1.5 LU) is written under the default 3 LU and skipped under --max-lu-change 1;
  - pack.mcmeta and declip_report.json (reference level, gain, limiter reduction, loudness change) are written.

    python tools/resonance/tests/test_declip.py        last line PASS or FAIL; exit 77 (skip) without ffmpeg
"""
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
RES = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(RES))
sys.path.insert(0, RES)
import declip_local as D  # noqa: E402
import pne_meter as pm  # noqa: E402

TMP = os.environ.get('PNE_TMP') or os.path.join(tempfile.gettempdir(), 'pne_tests')
WORK = os.path.join(TMP, 'resonance_declip')
problems = []
ffmpeg = D.find_ffmpeg()
if not ffmpeg:
    print('SKIP ffmpeg not found')
    sys.exit(77)
shutil.rmtree(WORK, ignore_errors=True)
os.makedirs(WORK)

# synthetic, deliberately clipped signals (made here, not taken from any mod)
fs = 48000
t = np.arange(3 * fs) / fs
mild = 0.5 * np.sin(2 * np.pi * 220 * t)
for c in (0.6, 1.5, 2.4):                      # three 60 ms swells to 1.25 that clip at full scale
    sel = (t >= c) & (t < c + 0.06)
    mild[sel] *= 2.5
mild = np.clip(mild, -1.0, 1.0)
th = np.arange(fs) / fs
heavy = np.clip(1.6 * np.sin(2 * np.pi * 220 * th) * np.exp(-th * 2), -1.0, 1.0)
jar = os.path.join(WORK, 'spore_fake.jar')
with zipfile.ZipFile(jar, 'w') as z:
    for name, sig in (('test_mild', mild), ('test_heavy', heavy)):
        ogg = os.path.join(WORK, name + '.ogg')
        sf.write(ogg, sig, fs, format='OGG', subtype='VORBIS')
        z.write(ogg, 'assets/spore/sounds/%s.ogg' % name)
    z.writestr('assets/spore/sounds/unreadable.ogg', b'')   # an undecodable entry must be skipped, not crash the run

tool = os.path.join(RES, 'declip_local.py')


def run(*args):
    return subprocess.run([sys.executable, tool] + list(args), capture_output=True, text=True, cwd=ROOT, timeout=300)


inside_repo = os.path.join(ROOT, 'tools', 'resonance', 'out', 'declip_should_not_exist')
r = run('--jar', jar, '--out', inside_repo, '--write')
if r.returncode == 0 or os.path.exists(inside_repo):
    problems.append('an output folder inside the repository was not refused')
elsewhere = os.path.join(os.path.splitdrive(ROOT)[0] + os.sep, 'pne_declip_not_allowed_here')
r = run('--jar', jar, '--out', elsewhere, '--write')
if r.returncode == 0 or os.path.exists(elsewhere):
    problems.append('an output folder outside the instance and the temp folder was not refused')
out = os.path.join(WORK, 'pack')
r = run('--jar', jar, '--out', out)
if r.returncode != 0 or os.path.exists(out) or '2 clipped file(s)' not in r.stdout:
    problems.append('dry run wrote files or did not report the 2 clipped files: ' + r.stdout.strip()[-200:])
r = run('--jar', jar, '--out', out, '--write', '--ffmpeg', ffmpeg, '--max-lu-change', '1')
res = os.path.join(out, 'assets', 'spore', 'sounds', 'test_mild.ogg')
rep_path = os.path.join(out, 'declip_report.json')
if r.returncode != 0 or not os.path.isfile(res) or not os.path.isfile(rep_path):
    problems.append('write run failed: ' + (r.stdout + r.stderr).strip()[-300:])
else:
    with open(rep_path, encoding='utf-8') as f:
        rep = {os.path.basename(e['name']): e for e in json.load(f)['files'] if 'name' in e}
    y, fs2 = sf.read(res, dtype='float64')
    x0, _ = sf.read(os.path.join(WORK, 'test_mild.ogg'), dtype='float64')
    ref_i, _ = D.reference_levels(x0, fs)
    out_i = pm.integrated_lufs(y, fs2)
    if pm.sample_peak_abs(y) >= 0.999 or pm.true_peak_dbtp(y, fs2) > -1.0:
        problems.append('de-clipped copy still peaks at %.4f / %.2f dBTP' % (pm.sample_peak_abs(y), pm.true_peak_dbtp(y, fs2)))
    if not (ref_i - 1.0 <= out_i <= ref_i + 0.1):
        problems.append('de-clipped copy at %.2f LUFS, the trims assume %.2f (must stay within -1 / +0.1 LU)' % (out_i, ref_i))
    if ref_i < -15.0 or out_i < -15.0:
        problems.append('the mild test file must sit well above -20 LUFS to show the loudness is kept (%.2f / %.2f)' % (ref_i, out_i))
    m = rep.get('test_mild.ogg', {})
    if not m.get('written') or abs(m.get('lufs_change', 99)) > 1.0 or m.get('gain_db', 1) > 0.0:
        problems.append('report for the mild file is wrong: %s' % m)
    h = rep.get('test_heavy.ogg', {})
    if os.path.exists(os.path.join(out, 'assets', 'spore', 'sounds', 'test_heavy.ogg')) or 'skipped' not in h:
        problems.append('the heavily clipped file (limiter change %s LU) was not skipped' % h.get('lufs_change'))
    if not os.path.isfile(os.path.join(out, 'pack.mcmeta')):
        problems.append('pack.mcmeta missing')
    print('  note  mild: reference %.2f LUFS -> %.2f LUFS (gain %s dB, limiter %s dB); heavy at --max-lu-change 1: %s' % (
        ref_i, out_i, m.get('gain_db'), m.get('limiter_gr_db'), h.get('skipped', 'written')))
    out3 = os.path.join(WORK, 'pack_default')
    r3 = run('--jar', jar, '--out', out3, '--write', '--ffmpeg', ffmpeg)
    heavy3 = os.path.join(out3, 'assets', 'spore', 'sounds', 'test_heavy.ogg')
    if r3.returncode != 0 or not os.path.isfile(heavy3):
        problems.append('with the default 3 LU limit the heavy file (%s LU) should be written' % h.get('lufs_change'))
    else:
        yh, _ = sf.read(heavy3, dtype='float64')
        xh, _ = sf.read(os.path.join(WORK, 'test_heavy.ogg'), dtype='float64')
        rh, _ = D.reference_levels(xh, fs)
        lh = pm.integrated_lufs(yh, fs)
        if not (rh - 3.0 <= lh <= rh + 0.1) or pm.true_peak_dbtp(yh, fs) > -1.0:
            problems.append('heavy copy under the default: %.2f LUFS against reference %.2f, %.2f dBTP' % (lh, rh, pm.true_peak_dbtp(yh, fs)))
        print('  note  heavy under the default 3 LU: reference %.2f LUFS -> %.2f LUFS' % (rh, lh))
for p in problems:
    print('  FAIL  ' + p)
print(('PASS' if not problems else 'FAIL') + ' resonance-declip: repository and foreign paths refused, dry run by default, loudness kept '
      '(trims stay valid), over-limited file skipped')
sys.exit(1 if problems else 0)
