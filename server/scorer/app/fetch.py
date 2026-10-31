import asyncio
from dataclasses import dataclass
import ipaddress
import socket
import time
from urllib.parse import urljoin, urlsplit

import httpx

from . import config

@dataclass
class Fetched:
    url: str
    status: str
    data: bytes = None
    ms: float = 0.0
    http_status: int = None

def allowed_hosts(cfg):
    return set(cfg["hosts"].values())

def check_url(url, cfg):
    if not isinstance(url, str) or len(url) > 2048:
        return "host_not_allowed"
    try:
        p = urlsplit(url)
        port = p.port
    except ValueError:
        return "host_not_allowed"
    if p.scheme != "https" or port not in (None, 443) or p.username or p.password:
        return "host_not_allowed"
    if (p.hostname or "").lower() not in allowed_hosts(cfg):
        return "host_not_allowed"
    return None

def public_ip(text):
    try:
        ip = ipaddress.ip_address(text.split("%")[0])
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_global and not (ip.is_multicast or ip.is_reserved or ip.is_link_local or ip.is_loopback or ip.is_private)

async def system_resolver(host):
    infos = await asyncio.get_running_loop().getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    return sorted({i[4][0] for i in infos})

async def fetch_one(client, url, cfg=None, resolver=system_resolver):
    cfg = cfg or config.get()
    lim = cfg["limits"]
    start = time.perf_counter()
    done = lambda status, **kw: Fetched(url, status, ms=round((time.perf_counter() - start) * 1000, 1), **kw)
    current = url
    try:
        async with asyncio.timeout(lim["fetchTimeoutMs"] / 1000):
            for _ in range(lim["maxRedirects"] + 1):
                reason = check_url(current, cfg)
                if reason:
                    return done(reason)
                try:
                    addrs = await resolver(urlsplit(current).hostname)
                except OSError:
                    return done("fetch_failed")
                if not addrs or not all(public_ip(a) for a in addrs):
                    return done("blocked_address")
                async with client.stream("GET", current, follow_redirects=False) as r:
                    if r.status_code in (301, 302, 303, 307, 308):
                        loc = r.headers.get("location")
                        if not loc:
                            return done("fetch_failed", http_status=r.status_code)
                        current = urljoin(current, loc)
                        continue
                    if r.status_code != 200:
                        return done("fetch_failed", http_status=r.status_code)
                    try:
                        if int(r.headers.get("content-length", "0")) > lim["maxImageBytes"]:
                            return done("too_large", http_status=200)
                    except ValueError:
                        pass
                    buf = bytearray()
                    async for chunk in r.aiter_bytes():
                        buf += chunk
                        if len(buf) > lim["maxImageBytes"]:
                            return done("too_large", http_status=200)
                    return done("ok", data=bytes(buf), http_status=200)
            return done("fetch_failed")
    except (TimeoutError, httpx.TimeoutException):
        return done("timeout")
    except httpx.HTTPError:
        return done("fetch_failed")

def make_client(cfg=None, transport=None):
    cfg = cfg or config.get()
    lim = cfg["limits"]
    t = lim["fetchTimeoutMs"] / 1000
    return httpx.AsyncClient(
        transport=transport,
        timeout=httpx.Timeout(t, connect=min(t, 4.0)),
        limits=httpx.Limits(max_connections=lim["fetchConcurrency"], max_keepalive_connections=lim["fetchConcurrency"]),
        headers={"User-Agent": "copycat-vision/0.1", "Accept": "image/avif,image/webp,image/png,image/jpeg,*/*;q=0.5"},
        follow_redirects=False,
        trust_env=False,
    )

async def fetch_all(client, urls, cfg=None, resolver=system_resolver):
    cfg = cfg or config.get()
    sem = asyncio.Semaphore(cfg["limits"]["fetchConcurrency"])

    async def one(u):
        async with sem:
            return await fetch_one(client, u, cfg, resolver)

    return await asyncio.gather(*(one(u) for u in urls))
