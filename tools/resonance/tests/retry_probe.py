"""
Helper for tests/test_gates.py (review finding R-RES-R2): verify.build_manifest on three committed assets with two
worker processes while PNE_VERIFY_FAULT=memory makes every worker raise MemoryError. The parent must retry serially
and return the same verdicts. Run as its own process because Windows spawns workers by re-importing the main module.

    python tools/resonance/tests/retry_probe.py        prints one JSON line
"""
import contextlib
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.dirname(HERE)
sys.path.insert(0, RES)
import render as R  # noqa: E402
import verify as V  # noqa: E402


def main():
    with open(os.path.join(RES, 'manifest.json'), encoding='utf-8') as f:
        man = json.load(f)
    recs = {r['key']: r for r in V.records_from_manifest(man)}
    sub = [recs[k] for k in ('res.tell.a.v01', 'res.tell.a.v02', 'res.whisper.near.v06')]
    err = io.StringIO()
    os.environ['PNE_VERIFY_FAULT'] = 'memory'
    try:
        with contextlib.redirect_stderr(err):
            out = V.build_manifest(sub, V.ASSETS_DIR, R.SPEC_PATH, jobs=2)
    finally:
        del os.environ['PNE_VERIFY_FAULT']
    ref = V.build_manifest(sub, V.ASSETS_DIR, R.SPEC_PATH, jobs=1)
    same = all(out['assets'][k]['pass'] == ref['assets'][k]['pass'] and out['assets'][k]['metrics'] == ref['assets'][k]['metrics'] for k in ref['assets'])
    print(json.dumps({'retried': 'retrying serially' in err.getvalue(), 'assets': len(out['assets']), 'pass': out['summary']['pass'], 'same_as_serial': same}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
