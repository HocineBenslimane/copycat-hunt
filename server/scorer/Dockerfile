FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN mkdir -p /srv/models && python -c "import hashlib, urllib.request; M = [('https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/d15189d7028b43f1d3e65039190477f6af591c2a/onnx/vision_model_quantized.onnx', 'clip_vision_q8.onnx', '583fd1110a514667812fee7d684952aaf82a99b959760c8d7dca7e0ab9839299'),      ('https://huggingface.co/Xenova/dinov2-small/resolve/c2bb04a51fab207c420665f1946016107bffc701/onnx/model_quantized.onnx', 'dinov2_small_q8.onnx', '3afdc8bc63b50558d6e5770f5b799bb82455c2311183a2de43803f343a29d917')]; [(lambda d, name, want: (open('/srv/models/' + name, 'wb').write(d), None if hashlib.sha256(d).hexdigest() == want else (_ for _ in ()).throw(SystemExit(name + ': checksum mismatch'))))(urllib.request.urlopen(u, timeout=120).read(), n, h) for u, n, h in M]"

COPY app ./app
COPY config ./config

RUN useradd --system --uid 10001 app
USER app

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-access-log"]
