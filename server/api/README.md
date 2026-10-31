# Copycat Hunt API (Cloudflare Worker)

**Live:** `https://api.copycathunt.com` (version 1.8.0)

- Worker name: `copycat-hunt-api`
- Account: `djawedbns@gmail.com`
- First deployed: Oct 7, 2026

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

Checking a license needs no Keygen token and no Keygen call. Since 1.4.0 the
billing part (below) does call Keygen, with a product token that can only
create, read, update, suspend and reinstate licenses. No Keygen admin token
and no Keygen private key live here.

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
  - `503` scorer busy or no Google key, `502`/`504` scorer error or timeout;
  - `403 { error: "scorer-not-approved" }` (1.7.0) when the owner hasn't
    approved the image scorer for this license.
- `POST /v1/scorer/access` (1.7.0) takes `{ evidence, ask }` and answers
  `{ status: "none" | "requested" | "approved" | "revoked" }`; `ask: true`
  sends the request to the owner. Approval is stored on the Keygen license,
  so it arrives inside the signed license answer.
- `GET /v1/announcements` (1.7.0) lists the live messages for the extension;
  `?history=1` (1.8.0) also the ended ones of the last 60 days, newest first,
  each with `live`. Messages are written on the owner's admin page (`ops.js`,
  KV storage `OPS`), which sits on a secret path (`ADMIN_PATH`) and signs in
  by a one-time link emailed to the support address.
- `GET /v1/checkout?plan=starter_monthly|starter_yearly` (1.4.0) answers
  `303` to a new Stripe Checkout page (subscription). Unknown plan → `400`
  page; more than 20 tries from one address in 10 minutes → `429`; Stripe
  unreachable → `503` page. The price is found by its Stripe `lookup_key`.
- `POST /v1/stripe/webhook` (1.4.0) takes Stripe events, signed with
  `STRIPE_WEBHOOK_SECRET` (bad or older than 5 minutes → `400`). Any error →
  `500`, so Stripe retries (for up to 3 days).
- `GET /thanks?session_id=cs_…` (1.4.0) is the page Stripe sends the buyer to.
  It shows the license key with a Copy button and the steps to paste it.
- `GET /checkout/cancelled` says nothing was charged.

## Billing (1.4.0)

The extension opens `/v1/checkout?plan=…` in a new tab. After paying, the
buyer lands on `/thanks` and copies the key into the setup page by hand
(nothing is activated automatically).

- **Which license.** Each Stripe subscription has one Keygen license. Its key
  is made from the subscription id with `LICENSE_KEY_SECRET` (HMAC), in the
  form `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. So the webhook, the thank-you page
  and Stripe's retries all arrive at the same key, and Keygen's unique-key
  rule stops duplicates, even when two of them run at once. The license also
  carries `stripeSubscription` in its metadata. If the secret ever changes,
  renewals still find the license that way.
- **Expiry.** The expiry is the end of the paid period plus 3 days. It is set
  on every `invoice.paid` (first payment and each renewal) and is never
  shortened. That's why yearly plans get a year even though the Keygen
  policy says 32 days. If a renewal fails, the license just runs out.
- **Suspend.** `customer.subscription.deleted`, or `.updated` to `unpaid`,
  `canceled` or `incomplete_expired`, suspends the license. A later paid
  invoice reinstates it, but not while the subscription has ended.
- **Email.** On `checkout.session.completed` the key is emailed once through
  Resend (from `licenses@h-bns.shop`, reply-to `support@`; the domain is
  verified in Resend, region eu-west-1). The subscription is then marked
  `key_emailed=1`, and Resend's `Idempotency-Key` (`license-key/<sub id>`)
  also stops a second copy. This is skipped while `RESEND_API_KEY` isn't set.
- **Plans.** Plans live in `PLANS` (price lookup_key → tier) and `POLICIES`
  (tier → Keygen policy) at the top of the billing section.
- **Webhook events to enable in Stripe.** `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `invoice.paid`,
  `customer.subscription.updated`, `customer.subscription.deleted`.
- **Customer portal.** The `PORTAL_LOGIN_URL` var in `wrangler.toml` is
  Stripe's billing sign-in page. It is shown on the thank-you page and in the
  email.
- **Logs.** Each grant or suspend logs the first 8 characters of the license
  id and the date it now runs until. No emails or keys are logged.

Secrets for billing: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`KEYGEN_TOKEN`, `LICENSE_KEY_SECRET` (random, 32+ characters) and
`RESEND_API_KEY`. They are Cloudflare secrets, never in this repository.

## Updating it

Since Oct 13, 2026 it is deployed with wrangler (the dashboard editor is then
read-only):

1. Run the tests first: `node ../ebay-item-finder-dev-tests/server_api_test.js`,
   `worker_score_test.js`, `worker_billing_test.js` and `hijack_text_test.js`.
2. From this folder: `npx wrangler login` (once), then `npx wrangler deploy`.
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
