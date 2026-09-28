"""oracle_manifest.json: loading and validation (TDD 4.2 S6, 4.4.1 rejection rule).

A model is accepted only when the manifest is well formed and the model file's sha256 equals the manifest's.
Any failure raises BadModel; the supervisor then records BAD_MODEL in status.errors and keeps its previous backend.
"""
import hashlib
import json
import math
import os

from . import N_FEATURES, WINDOW, AROUSAL, STYLES, FE

SCHEMA = 1


class BadModel(Exception):
    """The manifest or a model file failed validation (reported as BAD_MODEL)."""


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _floats(xs, n, what):
    if not isinstance(xs, list) or len(xs) != n:
        raise BadModel("%s must be a list of %d numbers" % (what, n))
    out = []
    for v in xs:
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(float(v)):
            raise BadModel("%s holds a non-finite or non-numeric value" % what)
        out.append(float(v))
    return out


def load(path):
    """Parse and validate the manifest. Returns the dict (with 'dir' added). Raises BadModel."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            m = json.load(f)
    except FileNotFoundError:
        raise BadModel("manifest not found: %s" % os.path.basename(path))
    except (OSError, ValueError) as e:
        raise BadModel("manifest unreadable: %s" % e)
    if not isinstance(m, dict) or m.get("schema") != SCHEMA:
        raise BadModel("manifest schema must be %d" % SCHEMA)
    names = m.get("feature_names")
    if not isinstance(names, list) or len(names) != N_FEATURES or not all(isinstance(s, str) for s in names):
        raise BadModel("feature_names must list %d names" % N_FEATURES)
    if m.get("window") != WINDOW:
        raise BadModel("window must be %d" % WINDOW)
    heads = m.get("heads") or {}
    if list(heads.get("arousal") or []) != list(AROUSAL) or list(heads.get("style") or []) != list(STYLES) or list(heads.get("fe") or []) != list(FE):
        raise BadModel("heads must be arousal %s, style %s, fe %s" % (list(AROUSAL), list(STYLES), list(FE)))
    layout = m.get("output_layout") or {}
    if layout.get("arousal") != [0, 4] or layout.get("style") != [4, 8] or layout.get("fe") != [8, 11]:
        raise BadModel("output_layout must be arousal [0,4], style [4,8], fe [8,11]")
    m["mu"] = _floats(m.get("mu"), N_FEATURES, "mu")
    m["sd"] = _floats(m.get("sd"), N_FEATURES, "sd")
    if min(m["sd"]) <= 0:
        raise BadModel("sd must be positive")
    if not isinstance(m.get("backends"), dict) or "cpu_np" not in m["backends"]:
        raise BadModel("manifest lists no cpu_np backend")
    m["dir"] = os.path.dirname(os.path.abspath(path))
    return m


def backend_file(m, name, verify=True):
    """Path of a backend's model file, checked against the manifest's sha256. Raises BadModel."""
    b = (m.get("backends") or {}).get(name)
    if not isinstance(b, dict) or not b.get("file"):
        raise BadModel("manifest has no %s model" % name)
    fn = b["file"]
    if os.path.basename(fn) != fn:
        raise BadModel("%s model file must be a plain file name" % name)
    path = os.path.join(m["dir"], fn)
    if not os.path.isfile(path):
        raise BadModel("%s model file missing: %s" % (name, fn))
    if verify:
        want = b.get("sha256")
        if not isinstance(want, str) or len(want) != 64:
            raise BadModel("%s model has no sha256 in the manifest" % name)
        if sha256_file(path) != want.lower():
            raise BadModel("%s model sha256 does not match the manifest" % name)
    return path


def model_id(m):
    b = (m.get("backends") or {}).get("cpu_np") or {}
    return "%s@%s" % (m.get("model", "oracle"), str(b.get("sha256") or "")[:8])
