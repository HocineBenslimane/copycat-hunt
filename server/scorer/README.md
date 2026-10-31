# Copycat Hunt scorer (copycat-vision)

A small Python service that answers one question: **how much of a seller's
design shows up in each of these product photos?** It runs on Google Cloud Run
with no public access; only the Copycat Hunt API Worker can call it, after it
has checked the user's license.

## What it measures

For one design and up to 70 result photos:

- **Merch art layer**: when a link is an Amazon Merch mockup, the transparent
  art PNG is taken from it, so the real artwork is compared, not the mockup.
- **Drawing and text apart**: a design PNG is split into its lettering and its
  drawing (`app/parts.py`), and each is matched on its own. A shared phrase
  alone doesn't make a copy.
- **Placement**: ORB keypoints + RANSAC find where the design sits in the photo,
  with checks that the placement is physically plausible (`app/features.py`).
- **Outline match**: the photo is straightened into the design's frame and the
  outlines are compared in a 4 × 4 grid (`app/edges.py`).
- **Photo hashes**: pHash and dHash (`app/hashes.py`).
- **Art against art**: a pixel difference when both sides are transparent PNGs
  (`app/pixels.py`, pixelmatch's colour rule and CIEDE2000).
- **Same idea** (0.2.0): two image models, CLIP ViT-B/32 and DINOv2-small, as
  8-bit ONNX files on the CPU (`app/meaning.py`). They find redraws and eBay
  photos where no line matches. `sameIdea` = CLIP + DINOv2 similarity.
- **Art only, never the mockup** (0.2.1): when the design is itself a product
  photo, `app/printarea.py` finds the printed art (the backdrop from the
  photo's edge, the product colour, then what the fabric surrounds; white on
  white, skin, hems and seams handled) and only that art is matched. Sellers
  reuse the same shirt photo for many designs, and before this its sleeves
  made unrelated designs look like copies. Small design photos (eBay
  thumbnails) are enlarged for matching; a match on a curved mug that only
  partly lines up still counts when 100+ points agree.

Results are ranked by a plain rule (`app/rank.py`): eBay results by
`sameIdea`, Amazon results by a line placement first, then `sameIdea`. There is
**no copy probability yet**: the numbers are raw signals.

## Measured on hand-labelled shirts

499 results I labelled by hand (143 copies), 38 searches. Version 0.2.1
against 0.2.0, with the extension's own "Sort by score" rules:

| | 0.2.0 | 0.2.1 |
|---|---|---|
| Real copies with a line placement | 62 of 92 | **74 of 92** |
| Non-copies with a (wrong) placement | 16 of 322 | **11 of 322** |
| Real copies hidden by Sort by score | 1 | **0** |
| Non-copies hidden by Sort by score | 64 | **75** |

Tried and left off: showing the "same idea" models only the cut art. It
separated look-alike characters better, but hid 3 to 6 real copies on this
set (switches in `config/default.yaml`, `meaning.artCut`).

## Run it locally

Python 3.12:

```bash
cd server/scorer
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt      # Windows (Linux/macOS: .venv/bin/pip)
.venv/Scripts/python -m uvicorn app.main:app --host 127.0.0.1 --port 8765
curl http://127.0.0.1:8765/v1/health
```

`POST /v1/score` takes:

```json
{
  "original": { "kind": "url", "url": "https://m.media-amazon.com/images/I/....png" },
  "candidates": [{ "id": "amazon:B0XXXXXXXX", "url": "https://m.media-amazon.com/images/I/....jpg" }]
}
```

(`original` can also be `{ "kind": "png", "dataBase64": "..." }`.) Photos are
only downloaded from `m.media-amazon.com` and `i.ebayimg.com`, with a public-IP
check, size and time limits, and no redirects to other hosts (`app/fetch.py`).

Every limit and threshold is in `config/default.yaml`, none in the code.

## Deploy (Google Cloud Run)

```bash
gcloud run deploy copycat-vision --source . --no-allow-unauthenticated \
  --region europe-west1 --memory 4Gi --cpu 8 --concurrency 1 --max-instances 6 \
  --timeout 60 --cpu-boost --set-env-vars COPYCAT_COMPUTE_WORKERS=8
```

One search per server, 8 CPUs each: a 70-photo search takes about 10 s of
compute (42 s on 2 CPUs). Google builds the image from the `Dockerfile`
(Python 3.12 slim, non-root user, no images kept on disk); the build downloads
the two model files from a pinned commit and checks their SHA-256. The models
load and warm up at start; `/v1/health` says `sameIdea: true` when they did. `--no-allow-unauthenticated` means a call
without a Google identity token gets 403; the Worker's service account is the
only caller with the Cloud Run Invoker role.

## Files

| File | What it does |
|---|---|
| `app/main.py` | HTTP API (`/v1/health`, `/v1/score`) |
| `app/service.py` | One request: prepare the design, download photos, compare, rank |
| `app/pipeline.py` | One design against one photo: all signals |
| `app/original.py`, `app/crops.py`, `app/decode.py` | Image decoding, design preparation, print-area crops |
| `app/printarea.py` | Finds the printed art on a product photo (0.2.1) |
| `app/meaning.py` | "Same idea": CLIP + DINOv2 (0.2.0) |
| `app/parts.py` | Drawing vs text split |
| `app/features.py`, `app/edges.py`, `app/hashes.py`, `app/pixels.py` | The signals |
| `app/aligned.py` | Extra "after lining up" signals, off by default (measurement only) |
| `app/fetch.py` | Safe downloads |
| `app/merch.py` | Merch mockup link → art PNG link |
| `app/rank.py` | Ranking rule |
| `config/default.yaml` | All settings |
