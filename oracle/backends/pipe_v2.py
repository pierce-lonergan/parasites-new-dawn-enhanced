"""The v2 binary frame protocol (TDD 4.4.3), used over the TPU worker's stdin/stdout (and, later, TCP or a
named pipe for a native mod).

Frame: u32 payload length, then the payload. Everything little-endian except pid (16 raw bytes, RFC 4122
order: the 32-hex pseudonym as bytes). Payload header (20 bytes): 'PNEO' . ver u8 = 2 . type u8 . seq u32 .
tick u64 . n u16. Bodies:
  INFER          n x (pid 16 B + 31 x f32)                       features for this second (stateful server)
  INFER_WINDOW   n x (pid 16 B + 496 x int8)                     pre-quantised windows (stateless worker)
  RESULT         backend u8 . infer_us u32 . n x (pid 16 B + 11 x f32 probabilities + conf f32 + flags u8)
  HELLO, WELCOME, ERROR, PING, PONG, EXIT: a UTF-8 JSON object (may be empty)
Flow control: a window of 1 (one request outstanding); results whose seq is not the latest are dropped.
"""
import json
import struct

import numpy as np

MAGIC = b"PNEO"
VERSION = 2
HEADER = struct.Struct("<4sBBIQH")
LEN = struct.Struct("<I")
MAX_FRAME = 16 * 1024 * 1024

HELLO, WELCOME, INFER, INFER_WINDOW, RESULT, ERROR, PING, PONG, EXIT = 1, 2, 3, 4, 5, 6, 7, 8, 9
TYPE_NAMES = {1: "HELLO", 2: "WELCOME", 3: "INFER", 4: "INFER_WINDOW", 5: "RESULT", 6: "ERROR", 7: "PING", 8: "PONG", 9: "EXIT"}
ERROR_CODES = ("NO_MODEL", "BAD_SHAPE", "OVERLOADED", "DEVICE_LOST", "VERSION_MISMATCH")

FLAG_FALLBACK = 1  # the result for this player came from a fallback path inside the worker

_RES_HEAD = struct.Struct("<BI")
_RES_ROW = 16 + 11 * 4 + 4 + 1


class ProtocolError(Exception):
    """A frame that does not follow the v2 protocol."""


def pid_bytes(pid):
    s = str(pid)
    if len(s) != 32:
        raise ProtocolError("pid must be 32 hex characters")
    try:
        return bytes.fromhex(s)
    except ValueError:
        raise ProtocolError("pid must be 32 hex characters")


def pid_hex(b):
    return bytes(b).hex()


def frame(mtype, seq=0, tick=0, n=0, body=b""):
    payload = HEADER.pack(MAGIC, VERSION, int(mtype), int(seq) & 0xFFFFFFFF, int(tick) & 0xFFFFFFFFFFFFFFFF, int(n) & 0xFFFF) + body
    return LEN.pack(len(payload)) + payload


def json_frame(mtype, obj=None, seq=0, tick=0):
    return frame(mtype, seq, tick, 0, json.dumps(obj or {}, separators=(",", ":")).encode("utf-8"))


def parse(payload):
    """payload bytes -> (type, seq, tick, n, body). Raises ProtocolError."""
    if len(payload) < HEADER.size:
        raise ProtocolError("short payload")
    magic, ver, mtype, seq, tick, n = HEADER.unpack_from(payload, 0)
    if magic != MAGIC:
        raise ProtocolError("bad magic")
    if ver != VERSION:
        raise ProtocolError("VERSION_MISMATCH")
    if mtype not in TYPE_NAMES:
        raise ProtocolError("unknown message type %d" % mtype)
    return mtype, seq, tick, n, payload[HEADER.size:]


def body_json(body):
    if not body:
        return {}
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ProtocolError("bad JSON body")
    if not isinstance(obj, dict):
        raise ProtocolError("JSON body must be an object")
    return obj


def read_exact(stream, n):
    buf = b""
    while len(buf) < n:
        chunk = stream.read(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def read_frame(stream):
    """Reads one frame's payload from a binary stream; None on a clean EOF. Raises ProtocolError."""
    head = read_exact(stream, LEN.size)
    if head is None:
        return None
    (size,) = LEN.unpack(head)
    if size < HEADER.size or size > MAX_FRAME:
        raise ProtocolError("frame length %d out of range" % size)
    payload = read_exact(stream, size)
    if payload is None:
        raise ProtocolError("EOF inside a frame")
    return payload


def infer_window_frame(seq, tick, pids, q):
    q = np.ascontiguousarray(q, dtype=np.int8)
    if q.ndim != 2 or q.shape[1] != 496 or q.shape[0] != len(pids):
        raise ProtocolError("BAD_SHAPE")
    parts = []
    for i, pid in enumerate(pids):
        parts.append(pid_bytes(pid))
        parts.append(q[i].tobytes())
    return frame(INFER_WINDOW, seq, tick, len(pids), b"".join(parts))


def parse_infer_window(n, body):
    row = 16 + 496
    if len(body) != n * row:
        raise ProtocolError("BAD_SHAPE")
    pids = []
    q = np.empty((n, 496), dtype=np.int8)
    for i in range(n):
        o = i * row
        pids.append(pid_hex(body[o:o + 16]))
        q[i] = np.frombuffer(body, dtype=np.int8, count=496, offset=o + 16)
    return pids, q


def infer_frame(seq, tick, pids, feats):
    f = np.ascontiguousarray(feats, dtype="<f4")
    if f.ndim != 2 or f.shape[1] != 31 or f.shape[0] != len(pids):
        raise ProtocolError("BAD_SHAPE")
    parts = []
    for i, pid in enumerate(pids):
        parts.append(pid_bytes(pid))
        parts.append(f[i].tobytes())
    return frame(INFER, seq, tick, len(pids), b"".join(parts))


def parse_infer(n, body):
    row = 16 + 31 * 4
    if len(body) != n * row:
        raise ProtocolError("BAD_SHAPE")
    pids = []
    f = np.empty((n, 31), dtype=np.float32)
    for i in range(n):
        o = i * row
        pids.append(pid_hex(body[o:o + 16]))
        f[i] = np.frombuffer(body, dtype="<f4", count=31, offset=o + 16)
    return pids, f


def result_frame(seq, tick, backend_code, infer_us, pids, probs, flags=None):
    p = np.asarray(probs, dtype="<f4")
    if p.ndim != 2 or p.shape[1] != 11 or p.shape[0] != len(pids):
        raise ProtocolError("BAD_SHAPE")
    parts = [_RES_HEAD.pack(int(backend_code) & 0xFF, max(0, min(0xFFFFFFFF, int(infer_us))))]
    for i, pid in enumerate(pids):
        conf = float(p[i, 0:4].max())
        parts.append(pid_bytes(pid))
        parts.append(p[i].tobytes())
        parts.append(struct.pack("<fB", conf, int(flags[i]) if flags is not None else 0))
    return frame(RESULT, seq, tick, len(pids), b"".join(parts))


def parse_result(n, body):
    """-> (backend_code, infer_us, pids, probs [n, 11] float32, conf [n], flags [n])."""
    if len(body) != _RES_HEAD.size + n * _RES_ROW:
        raise ProtocolError("BAD_SHAPE")
    code, us = _RES_HEAD.unpack_from(body, 0)
    pids, flags = [], []
    probs = np.empty((n, 11), dtype=np.float32)
    conf = np.empty(n, dtype=np.float32)
    for i in range(n):
        o = _RES_HEAD.size + i * _RES_ROW
        pids.append(pid_hex(body[o:o + 16]))
        probs[i] = np.frombuffer(body, dtype="<f4", count=11, offset=o + 16)
        c, fl = struct.unpack_from("<fB", body, o + 16 + 44)
        conf[i] = c
        flags.append(fl)
    return code, us, pids, probs, conf, flags
