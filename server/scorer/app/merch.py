import re
from urllib.parse import unquote, urlsplit

AMAZON_HOST = "m.media-amazon.com"
_LAYER = re.compile(r"\._CLa\|\d{2,5},\d{2,5}\|([A-Za-z0-9+\-]{6,20})\.png\|")
_ID = re.compile(r"^[A-Za-z0-9+\-]{6,20}$")

def art_url(url):
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
