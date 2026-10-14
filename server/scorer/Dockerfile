# copycat-vision on Cloud Run. Google builds this image
# in the cloud; nothing runs on the owner's PC.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# OpenCV headless still needs these shared libraries at import time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends libglib2.0-0 libgl1 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY config ./config

# Non-root user; the app keeps no files and no images on disk.
RUN useradd --system --uid 10001 app
USER app

# Cloud Run sends traffic to $PORT (8080 by default).
CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8080} --workers 1 --no-access-log"]
