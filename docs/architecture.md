# How Copycat Hunt is built

```
 Amazon / eBay page                       Chrome extension (Manifest V3)
 ┌────────────────────┐        ┌───────────────────────────────────────────────┐
 │ content.js         │◀──────▶│ background.js (service worker)                │
 │  floating button   │ msgs   │  message router + sender checks               │
 │  hunt window, tabs │        │  eBay request queue (timeouts, pauses)        │
 │  report form filler│        │  Amazon look-alike search                     │
 └────────────────────┘        │  Merch / eBay catalog sync ─┐                 │
                               │  licensing (Keygen) ─────┐  │                 │
 popup.html  (toolbar menu)    └──────────────────────────┼──┼─────────────────┘
 setup.html  (first setup)                                │  │
                                                          │  ▼
                         offscreen.html ─▶ db-worker.js: SQLite WASM (OPFS)
                                           your own listings, never flagged
                                                          │
            signed Keygen answer                          ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ Cloudflare Worker  copycat-hunt-api   (server/api)                         │
 │  checks the Ed25519 signature of the license answer (public key only)     │
 │  /v1/compare: listing-text hijack check                                   │
 │  /v1/score:   forwards to the scorer with a Google ID token               │
 │  /v1/checkout, /v1/stripe/webhook, /thanks: buying a license              │
 │    Stripe Checkout → signed webhook → Keygen license → key email (Resend) │
 └───────────────────────────────────────┬───────────────────────────────────┘
                                         ▼  (no public access: 403 without the token)
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ Google Cloud Run  copycat-vision   (server/scorer, Python / FastAPI)       │
 │  downloads Amazon/eBay photos safely, compares them with the design:      │
 │  Merch art layer, or the art found on a product photo (never the mockup), │
 │  drawing/text split, ORB + RANSAC placement, aligned outlines (4×4 grid), │
 │  pHash/dHash, art-vs-art pixels, "same idea" (CLIP + DINOv2, ONNX on CPU) │
 └───────────────────────────────────────────────────────────────────────────┘
```

## The three parts

**Extension (`extension/`)** — everything the user sees, and everything that
can run on their own computer. Searches eBay with its own image search and
Amazon with its look-alike search, from the user's browser session. Tracks
copies by design, recognises the user's own listings from a local database,
and fills eBay's and Amazon's report forms. It never ticks the legal
declaration boxes and never presses Submit: the user does.

**API Worker (`server/api/`)** — runs the features that shouldn't live in the
extension: the listing-text comparison, access to the scorer (approved per
license), the messages shown in the extension and the owner's admin page that
writes them (`ops.js`), and buying a
license (Stripe Checkout; a signed Stripe webhook creates or renews the Keygen
license, and the key is shown on a thank-you page and emailed through
Resend). It accepts a
request only with a fresh, signed license answer from Keygen and checks that
signature itself, so a copy of the extension with its checks removed gets
nothing.

**Scorer (`server/scorer/`)** — measures how much of a design appears in each
result photo, comparing the printed art only, never the shirt mockup around
it. It sits on Google Cloud Run with no public access; only the Worker can
call it. The extension's "Sort by score" (`extension/score-rules.js`) uses the
same ranking rule and shows the copies first.

## Data and privacy

- Stored on the user's computer only: tracked copies, report history, the
  synced list of their own listings (SQLite in the extension's private
  storage), their own contact details for Amazon reports (entered by them).
- Sent to the Worker: the license answer and, for the checks, public listing
  data (titles, bullet points, photo links). Nothing is stored there; logs keep
  only the first 8 characters of the license id.
- Sent to the scorer: the design and the public photo links of the results.
  Images are processed in memory and not kept.
- Buying a license: Stripe handles the payment and card details; the Worker
  only receives the subscription events it needs to create, renew or suspend
  the license, and sends the key once by email.
- No personal data is collected from Amazon or eBay pages.
