"""Merch on Demand mockup link -> the art PNG link.

Amazon builds a Merch product photo from layers and writes them into the link:
  https://m.media-amazon.com/images/I/A1dbsmzbGeL._CLa%7C2140%2C2000%7C810h9YfWbQL.png%7C...
  -> https://m.media-amazon.com/images/I/810h9YfWbQL.png
The first .png layer after _CLa is taken (front print). Anything that doesn't
match exactly is left alone (returns None).
"""
import re
from urllib.parse import unquote, urlsplit

AMAZON_HOST = "m.media-amazon.com"
# _CLa|<canvas w>,<canvas h>|<art id>.png|
_LAYER = re.compile(r"\._CLa\|\d{2,5},\d{2,5}\|([A-Za-z0-9+\-]{6,20})\.png\|")
_ID = re.compile(r"^[A-Za-z0-9+\-]{6,20}$")


def art_url(url):
    """The art PNG link for a Merch mockup link, or None."""
    if not isinstance(url, str) or len(url) > 2048:
        return None
    parts = urlsplit(url)
    if parts.scheme != "https" or parts.hostname != AMAZON_HOST or parts.port is not None:
        return None
    if parts.username or parts.password:
        return None
    path = unquote(parts.path)
    if not path.startswith("/images/I/"):
        return None
    m = _LAYER.search(path)
    if not m or not _ID.match(m.group(1)):
        return None
    return f"https://{AMAZON_HOST}/images/I/{m.group(1)}.png"
