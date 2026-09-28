"""
Minimal PNG reader and writer, standard library only (zlib, struct), for the visual tools.

    img = read_png(data)          # bytes -> Image (RGBA, 8 bits per channel)
    data = write_png(img)         # Image -> bytes (RGBA8, deterministic output)

Reads every colour type (grey, RGB, palette, grey+alpha, RGBA), bit depths 1/2/4/8/16, tRNS transparency and
Adam7 interlacing. Writes RGBA8 with filter type 0 and zlib level 9, so the same pixels always give the same
bytes. Ancillary chunks (gamma, text, ...) are ignored.
"""
import struct
import zlib

SIGNATURE = b"\x89PNG\r\n\x1a\n"
_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
_ADAM7 = ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))


class PngError(ValueError):
    pass


class Image:
    """RGBA8 image: width, height and a flat bytearray of width * height * 4 bytes (row-major)."""

    def __init__(self, width, height, rgba=None):
        self.width = int(width)
        self.height = int(height)
        self.rgba = bytearray(rgba) if rgba is not None else bytearray(self.width * self.height * 4)
        if len(self.rgba) != self.width * self.height * 4:
            raise PngError("pixel buffer does not match the image size")

    def pixel(self, x, y):
        i = (y * self.width + x) * 4
        return tuple(self.rgba[i:i + 4])

    def alpha_bytes(self):
        return bytes(self.rgba[3::4])


def _chunks(data):
    if data[:8] != SIGNATURE:
        raise PngError("not a PNG file")
    pos = 8
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos:pos + 8])
        body = data[pos + 8:pos + 8 + length]
        crc = data[pos + 8 + length:pos + 12 + length]
        if len(body) != length or len(crc) != 4:
            raise PngError("truncated chunk " + kind.decode("latin-1"))
        if struct.unpack(">I", crc)[0] != (zlib.crc32(kind + body) & 0xFFFFFFFF):
            raise PngError("bad CRC in chunk " + kind.decode("latin-1"))
        yield kind, body
        pos += 12 + length
        if kind == b"IEND":
            return
    raise PngError("missing IEND")


def _paeth(a, b, c):
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _unfilter(raw, width, height, bpp_bits, channels_bits):
    """raw: decompressed scanlines of one (sub)image. Returns a list of row bytearrays."""
    stride = (width * bpp_bits + 7) // 8
    bpp = max(1, bpp_bits // 8)
    rows = []
    prev = bytearray(stride)
    pos = 0
    for _ in range(height):
        if pos + 1 + stride > len(raw):
            raise PngError("image data too short")
        ftype = raw[pos]
        line = bytearray(raw[pos + 1:pos + 1 + stride])
        pos += 1 + stride
        if ftype == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif ftype == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif ftype == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif ftype == 4:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                upleft = prev[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + _paeth(left, prev[i], upleft)) & 0xFF
        elif ftype != 0:
            raise PngError("unknown filter type %d" % ftype)
        rows.append(line)
        prev = line
    return rows, pos


def _samples(line, width, depth, channels):
    """Unpacks one scanline into a list of integer samples (width * channels)."""
    n = width * channels
    if depth == 8:
        return list(line[:n])
    if depth == 16:
        return [(line[2 * i] << 8) | line[2 * i + 1] for i in range(n)]
    out = []
    per = 8 // depth
    mask = (1 << depth) - 1
    for i in range(n):
        byte = line[i // per]
        shift = 8 - depth * (i % per + 1)
        out.append((byte >> shift) & mask)
    return out


def read_png(data):
    header = None
    palette = None
    trns = None
    idat = bytearray()
    for kind, body in _chunks(bytes(data)):
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"PLTE":
            palette = [tuple(body[i:i + 3]) for i in range(0, len(body), 3)]
        elif kind == b"tRNS":
            trns = bytes(body)
        elif kind == b"IDAT":
            idat += body
    if header is None:
        raise PngError("missing IHDR")
    width, height, depth, ctype, comp, filt, interlace = header
    if ctype not in _CHANNELS or comp != 0 or filt != 0 or interlace not in (0, 1):
        raise PngError("unsupported PNG header %r" % (header,))
    if width <= 0 or height <= 0:
        raise PngError("empty image")
    channels = _CHANNELS[ctype]
    if ctype == 3 and palette is None:
        raise PngError("palette image without PLTE")
    raw = zlib.decompress(bytes(idat))
    img = Image(width, height)
    bits = depth * channels
    maxv = (1 << depth) - 1

    def put(x, y, s):
        i = (y * width + x) * 4
        if ctype == 3:
            idx = s[0]
            r, g, b = palette[idx] if idx < len(palette) else (0, 0, 0)
            a = trns[idx] if trns is not None and idx < len(trns) else 255
        elif ctype in (0, 4):
            v = s[0] * 255 // maxv
            r = g = b = v
            if ctype == 4:
                a = s[1] * 255 // maxv
            else:
                a = 0 if trns is not None and len(trns) >= 2 and s[0] == struct.unpack(">H", trns[:2])[0] else 255
        else:
            r, g, b = (s[0] * 255 // maxv, s[1] * 255 // maxv, s[2] * 255 // maxv)
            if ctype == 6:
                a = s[3] * 255 // maxv
            else:
                a = 255
                if trns is not None and len(trns) >= 6 and tuple(s[:3]) == struct.unpack(">HHH", trns[:6]):
                    a = 0
        img.rgba[i:i + 4] = bytes((r, g, b, a))

    if interlace == 0:
        rows, _ = _unfilter(raw, width, height, bits, bits)
        for y, line in enumerate(rows):
            vals = _samples(line, width, depth, channels)
            for x in range(width):
                put(x, y, vals[x * channels:(x + 1) * channels])
        return img
    pos = 0
    for x0, y0, dx, dy in _ADAM7:
        pw = (width - x0 + dx - 1) // dx if width > x0 else 0
        ph = (height - y0 + dy - 1) // dy if height > y0 else 0
        if pw == 0 or ph == 0:
            continue
        rows, used = _unfilter(raw[pos:], pw, ph, bits, bits)
        pos += used
        for j, line in enumerate(rows):
            vals = _samples(line, pw, depth, channels)
            for i in range(pw):
                put(x0 + i * dx, y0 + j * dy, vals[i * channels:(i + 1) * channels])
    return img


def _chunk(kind, body):
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def write_png(img):
    """RGBA8 PNG bytes. Deterministic: filter type 0 on every row and zlib level 9 (textures are small, so
    speed matters more than the last few percent of compression)."""
    w, h = img.width, img.height
    stride = w * 4
    src = bytes(img.rgba)
    raw = b"".join(b"\x00" + src[y * stride:(y + 1) * stride] for y in range(h))
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return SIGNATURE + _chunk(b"IHDR", ihdr) + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b"")


def encode_raw(width, height, rows, depth, ctype, palette=None, trns=None, interlace=False):
    """Test helper: builds a PNG from already-packed scanlines (list of bytes, in file order; for an interlaced
    image that is pass by pass) with filter 0. The tests use it to make palette, grey, 16-bit and interlaced
    inputs without any imaging library."""
    ihdr = struct.pack(">IIBBBBB", width, height, depth, ctype, 0, 0, 1 if interlace else 0)
    body = _chunk(b"IHDR", ihdr)
    if palette is not None:
        body += _chunk(b"PLTE", b"".join(bytes(c) for c in palette))
    if trns is not None:
        body += _chunk(b"tRNS", bytes(trns))
    raw = b"".join(b"\x00" + bytes(r) for r in rows)
    return SIGNATURE + body + _chunk(b"IDAT", zlib.compress(raw, 9)) + _chunk(b"IEND", b"")
