"""Turn image bytes into a pixel array, safely.

Checks, in order, before any pixel is decoded: byte size, real file type from
the first bytes (not the URL or Content-Type), allowed format, and width x
height from the header (stops decompression bombs). Then decode, apply EXIF
orientation, and keep transparency only when the image really has some.
"""
from dataclasses import dataclass
import io
import warnings

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from . import config


class DecodeError(Exception):
    """code: too_large | bad_type | bad_image"""

    def __init__(self, code, detail=""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


@dataclass
class Decoded:
    pixels: np.ndarray  # H x W x 3 (RGB) or H x W x 4 (RGBA), uint8
    fmt: str            # PNG | JPEG | WEBP
    has_alpha: bool     # some pixels are at least partly transparent
    width: int
    height: int


def sniff(data):
    """File type from the first bytes, or None."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "PNG"
    if data[:3] == b"\xff\xd8\xff":
        return "JPEG"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "WEBP"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "GIF"
    return None


def decode(data, cfg=None):
    cfg = cfg or config.get()
    lim = cfg["limits"]
    if not isinstance(data, (bytes, bytearray)) or not data:
        raise DecodeError("bad_image", "empty")
    if len(data) > lim["maxImageBytes"]:
        raise DecodeError("too_large", f"{len(data)} bytes")
    kind = sniff(data)
    if kind not in lim["allowedFormats"]:
        raise DecodeError("bad_type", kind or "unknown")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            im = Image.open(io.BytesIO(data))
            if im.format != kind:
                raise DecodeError("bad_type", f"{kind} header, {im.format} body")
            w, h = im.size
            if w < 1 or h < 1 or w * h > lim["maxImagePixels"]:
                raise DecodeError("too_large", f"{w}x{h}")
            im.load()
            im = ImageOps.exif_transpose(im)
    except DecodeError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as e:
        raise DecodeError("too_large", str(e)) from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError) as e:
        raise DecodeError("bad_image", type(e).__name__) from None

    alpha = im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info)
    if alpha:
        rgba = np.asarray(im.convert("RGBA"))
        if int(rgba[..., 3].min()) < 255:
            return Decoded(rgba.copy(), kind, True, rgba.shape[1], rgba.shape[0])
    rgb = np.asarray(im.convert("RGB"))
    return Decoded(rgb.copy(), kind, False, rgb.shape[1], rgb.shape[0])
