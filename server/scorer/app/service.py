import asyncio
import base64
import binascii
import time
import uuid

from . import config, meaning, pipeline, rank
from .decode import DecodeError
from .fetch import fetch_all, fetch_one
from .merch import art_url
from .original import OriginalError

VERSION = "0.2.1"

class OriginalUnavailable(Exception):
    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason

def _prepare(data, cfg):
    return pipeline.prepare_bytes(data, cfg, design=True)

async def _prepare_from_url(client, url, cfg, resolver):
    tried = []
    art = art_url(url)
    for src, link in (("merch_art", art), ("url", url)):
        if not link:
            continue
        f = await fetch_one(client, link, cfg, resolver)
        if f.status != "ok":
            tried.append(f.status)
            continue
        try:
            prepared = await asyncio.to_thread(_prepare, f.data, cfg)
        except (DecodeError, OriginalError) as e:
            tried.append(e.code)
            continue
        if src == "merch_art" and prepared.kind != "png":
            tried.append("art_not_transparent")
            continue
        return prepared, src
    raise OriginalUnavailable(tried[-1] if tried else "no_source")

async def score(body, client, cfg=None, resolver=None):
    from .fetch import system_resolver
    cfg = cfg or config.get()
    resolver = resolver or system_resolver
    t0 = time.perf_counter()
    warnings = []

    if body.original.kind == "png":
        try:
            data = base64.b64decode(body.original.dataBase64, validate=True)
        except (binascii.Error, ValueError):
            raise OriginalUnavailable("bad_base64") from None
        try:
            original = await asyncio.to_thread(_prepare, data, cfg)
        except (DecodeError, OriginalError) as e:
            raise OriginalUnavailable(e.code) from None
        source = "upload"
    else:
        original, source = await _prepare_from_url(client, body.original.url, cfg, resolver)
    await asyncio.to_thread(pipeline.keyed, original, cfg)
    await asyncio.to_thread(meaning.design_vectors, original, cfg)
    if original.kind == "photo":
        warnings.append("design is a product photo, not a transparent PNG")

    t_fetch = time.perf_counter()
    links = [(c, art_url(c.url) or c.url) for c in body.candidates]
    fetched = await fetch_all(client, [l for _, l in links], cfg, resolver)
    fetch_ms = (time.perf_counter() - t_fetch) * 1000

    t_comp = time.perf_counter()
    sem = asyncio.Semaphore(cfg["limits"]["computeWorkers"])

    def work(data):
        cand = pipeline.prepare_bytes(data, cfg)
        return pipeline.compare(original, cand, cfg)

    async def one(c, link, f):
        r = {"id": c.id, "status": f.status, "rank": None, "copyProbability": None, "band": None,
             "source": "merch_art" if link != c.url else "url", "signals": None, "warnings": [],
             "timing": {"fetchMs": f.ms}}
        if f.status != "ok":
            return r
        async with sem:
            try:
                out = await asyncio.to_thread(work, f.data)
            except DecodeError as e:
                r["status"] = e.code
                return r
            except OriginalError as e:
                r["status"] = "bad_image"
                r["warnings"].append(e.code)
                return r
        r["candidateKind"] = out["candidateKind"]
        r["signals"] = out["signals"]
        r["timing"].update(out["timing"])
        return r

    results = list(await asyncio.gather(*(one(c, l, f) for (c, l), f in zip(links, fetched))))
    compute_ms = (time.perf_counter() - t_comp) * 1000
    rank.rank(results, original.kind)
    if not body.options.includeDiagnostics:
        for r in results:
            r.pop("timing", None)
    return {
        "requestId": uuid.uuid4().hex,
        "version": VERSION,
        "rankRule": rank.rule(results),
        "timing": {"fetchMs": round(fetch_ms, 1), "computeMs": round(compute_ms, 1),
                   "totalMs": round((time.perf_counter() - t0) * 1000, 1)},
        "original": {"kind": original.kind, "source": source,
                     "hadTransparency": original.kind == "png", "warnings": warnings + list(original.warnings)},
        "results": results,
    }
