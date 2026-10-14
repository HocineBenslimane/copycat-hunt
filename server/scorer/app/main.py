"""HTTP API. Reached only through the copycat-vision Worker (service binding),
which sits behind copycat-hunt-api's license check; it has no public address.

  GET  /v1/health  -> {ok, version}
  POST /v1/score   -> ranked results with separate signals

Errors: 400 bad input / design unusable, 413 too large, 415 not JSON,
503 busy. No request bodies, image bytes or URLs are logged.
"""
import asyncio
from contextlib import asynccontextmanager
import json
import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from . import config, service
from .fetch import make_client, system_resolver
from .schemas import ScoreIn

log = logging.getLogger("copycat-vision")


def create_app(cfg=None, transport=None, resolver=None):
    cfg = cfg or config.get()
    lim = cfg["limits"]
    state = {"client": None}

    @asynccontextmanager
    async def lifespan(_app):
        yield
        if state["client"] is not None:
            await state["client"].aclose()

    app = FastAPI(title="copycat-vision", version=service.VERSION, docs_url=None, redoc_url=None,
                  openapi_url=None, lifespan=lifespan)
    busy = asyncio.Semaphore(lim["maxConcurrentRequests"])

    def client():
        if state["client"] is None:
            state["client"] = make_client(cfg, transport)
        return state["client"]

    def err(code, error, reason=None):
        body = {"error": error}
        if reason:
            body["reason"] = reason
        return JSONResponse(body, status_code=code)

    @app.get("/v1/health")
    async def health():
        return {"ok": True, "version": service.VERSION}

    @app.post("/v1/score")
    async def score(request: Request):
        if request.headers.get("content-type", "").split(";")[0].strip() != "application/json":
            return err(415, "content_type")
        try:
            if int(request.headers.get("content-length", "0")) > lim["maxBodyBytes"]:
                return err(413, "too_large")
        except ValueError:
            return err(400, "bad_request")
        raw = bytearray()
        async for chunk in request.stream():
            raw += chunk
            if len(raw) > lim["maxBodyBytes"]:
                return err(413, "too_large")
        try:
            body = ScoreIn.model_validate(json.loads(raw))
        except (ValueError, ValidationError):
            return err(400, "bad_request")
        if len(body.candidates) > lim["maxCandidates"]:
            return err(400, "too_many_candidates")
        if busy.locked():
            return err(503, "busy")
        async with busy:
            try:
                out = await service.score(body, client(), cfg, resolver or system_resolver)
            except service.OriginalUnavailable as e:
                return err(400, "original", e.reason)
        log.info("score n=%d ok=%d fetchMs=%s computeMs=%s", len(out["results"]),
                 sum(r["status"] == "ok" for r in out["results"]), out["timing"]["fetchMs"], out["timing"]["computeMs"])
        return out

    return app


app = create_app()
