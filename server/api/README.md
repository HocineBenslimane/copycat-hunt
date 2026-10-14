# Copycat Hunt API (Cloudflare Worker)

The extension's server side for licensed features. Worker name
`copycat-hunt-api`, deployed on Cloudflare Workers since Oct 7, 2026.

## What it does

It runs the listing-text hijack comparison: the "Full hijack", "Title copied",
"Bullets copied" and "part" results, plus the "common wording" detection.
Since v3.14.0 the extension no longer contains this code, so a copy of the
extension with its license checks removed doesn't have it.

## How it knows the license is real

The extension sends the signed Keygen `validate-key` answer it already holds.
The Worker accepts it only if all of this is true:

- The Ed25519 signature checks out with the account's public key.
- `keyid` is our account and the algorithm is `ed25519`.
- The digest matches the body exactly.
- `valid: true` and `code: VALID`.
- The product and account are ours.
- The license hasn't expired.
- Keygen signed it less than 48 hours ago (the extension checks once a day),
  and not more than 10 minutes in the
  future.

That answer is Keygen's own JSON, so it contains the license key and the
installation fingerprint. The Worker doesn't store them, and logs only the
first 8 characters of the license id and fingerprint.

No Keygen admin or product token and no Keygen private key live here, and it
never calls Keygen itself.

Since 1.2.0 there is one secret, `GCP_SA_KEY`: the JSON key of the Google
service account `copycat-hunt-worker`. Its only permission is Cloud Run
Invoker on the `copycat-vision` service, so all it can do is ask the image
scorer for scores. It is set as an encrypted secret in the Cloudflare
dashboard (Settings → Variables and Secrets), never in this file and never in
the extension.

## Endpoints

- `GET /v1/health` returns `{ ok, version }`.
- `POST /v1/compare` (`Content-Type: application/json`, at most 512 KB) takes
  `{ evidence, mine, others: [≤60 {id,…}], titles: [≤200] }`. It returns:
  - `200 { ok, common, results }`;
  - `401 { error: "license", reason }`, where reason is one of `evidence`,
    `signature`, `digest`, `date`, `stale`, `not-valid`, `scope` or `expired`;
  - `400` bad input, `413` too large, `415` wrong content type;
  - `429` when one license makes more than 120 calls in 10 minutes on the same
    Worker instance.
- `POST /v1/score` (1.2.0, at most 3 MB) takes `{ evidence, original, candidates }`:
  `original` is `{ kind: "url", url }` or `{ kind: "png", dataBase64 }`;
  `candidates` is up to 70 `{ id: "amazon:…" | "ebay:…", url }`. Photo links must
  be https on `m.media-amazon.com` or `i.ebayimg.com`. It checks the license,
  then calls the copycat-vision scorer on Google Cloud Run. It returns:
  - `200 { ok, rankRule, original, timing, results: [{ id, status, rank, source, signals }] }`;
  - `401` license, `400` bad input, `413`, `415`, `429` (more than 30 in 10 minutes);
  - `422 { error: "design", reason }` when the scorer can't use the design image;
  - `503` scorer busy or no Google key, `502`/`504` scorer error or timeout.

## Updating it

Deployed with wrangler (Node 20+):

```bash
cd server/api
npx wrangler login      # once
npx wrangler dev        # run it locally on http://localhost:8787
npx wrangler deploy     # publish
```

`wrangler.toml` has the name, the entry file and `preview_urls = false`.

Secrets are not in `wrangler.toml` and a deploy leaves them as they are.
`GCP_SA_KEY` is set in the dashboard (Settings → Variables and Secrets).
To replace it: make a new key for `copycat-hunt-worker` in Google Cloud, paste
it there, then delete the old key in Google Cloud.

## Monitoring

Go to Workers & Pages → `copycat-hunt-api` → Logs. Each comparison logs one
line with the time, the first 8 characters of the license id and fingerprint,
the number of listings, and the country.

A license that suddenly shows up from many countries, or makes far more calls
than others, is probably being shared. You can then suspend it in Keygen.

## Limits (free Workers plan)

- 100,000 requests a day. Each text check or hijack check is one request.
- The rate limit is per instance: good against runaway loops, not a global
  quota.
