# Canva → Instagram publisher

Publish a Canva design straight to Instagram from your own app. The Canva editor
never opens: the design is rendered server-side through the **Canva Connect API**
and pushed to the **Instagram Content Publishing API**.

```
  Canva design ──► POST /rest/v1/exports ──► poll job ──► JPG url(s)
                                                             │
                            (optional re-host through /media)│
                                                             ▼
                    POST /{ig-user}/media  ──►  wait FINISHED  ──►  POST /{ig-user}/media_publish
```

---

## One important correction up front

The page you linked — [`intents/content/prepare_content_publisher`](https://www.canva.dev/docs/apps/api/latest/intents-content-prepare-content-publisher/)
— is an **Apps SDK** API. It runs *inside* a Canva app iframe and fires when a
user clicks **Share → your app** in the editor. It is the opposite direction from
what you asked for: it requires the editor to be open, and it's how Canva hands a
design *to* your platform.

For "publish to Instagram from my own app, no Canva UI", the pieces are:

| Need | API | Why |
|---|---|---|
| Render the design to an image | **Canva Connect API** (REST, OAuth) | The only server-side way to export a design |
| Put that image on Instagram | **Instagram Graph API** | Canva has no Instagram publishing endpoint |

Canva does **not** post to Instagram for you. This project is the bridge between
the two, which is what "publish the Insta post via Canva" actually reduces to.

---

## Setup

### 1. Canva integration

Create one at <https://www.canva.com/developers/integrations>:

* **Scopes**: `design:meta:read`, `design:content:read`
* **Redirect URL**: `http://127.0.0.1:3000/auth/canva/callback`
* Copy the client ID and secret into `.env`

### 2. Instagram

Content publishing requires an Instagram **Business or Creator** account and a
Meta app. Personal accounts cannot publish through the API. Two token flavours
work — pick one and set `IG_GRAPH_HOST` to match:

| Login type | `IG_GRAPH_HOST` | Permissions |
|---|---|---|
| Instagram Login (Business Login) | `graph.instagram.com` | `instagram_business_basic`, `instagram_business_content_publish` |
| Facebook Login for Business | `graph.facebook.com` | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement` |

Leave `IG_USER_ID` blank and the server discovers it from the token at boot.

### 3. Run

```bash
cp .env.example .env      # fill in the four credentials
npm install
npm run dev               # http://127.0.0.1:3000
```

Open the page, click **Connect Canva**, pick a design, write a caption, publish.
Tick **Dry run** first — it exports and validates without posting anything.

---

## Headless CLI

No browser at all:

```bash
npm run publish:cli -- --list
npm run publish:cli -- --design DAGxxxxxxx --caption "New drop 🔥" --dry-run
npm run publish:cli -- --design DAGxxxxxxx --caption "New drop 🔥"
npm run publish:cli -- --design DAGxxxxxxx --mode carousel --pages 1,2,3
```

The CLI reads the Canva token from `.tokens.json` and refreshes it automatically,
so authorize once through the web flow and it keeps working.

---

## HTTP API

| Route | Purpose |
|---|---|
| `GET /auth/canva` | Start the PKCE OAuth flow |
| `GET /auth/canva/callback` | Token exchange; stores (and optionally returns) the token |
| `GET /auth/status` | Connection state, scopes, expiry |
| `POST /auth/logout` | Drop the stored token |
| `GET /api/designs?query=` | List the user's Canva designs |
| `GET /api/instagram/account` | Resolved IG account + remaining daily quota |
| `POST /api/publish` | Publish, returns the full report as JSON |
| `POST /api/publish/stream` | Same, streamed as SSE progress events |
| `GET /media/:id.jpg` | Re-hosted export (only used when `MEDIA_MODE=proxy`) |

```bash
curl -X POST http://127.0.0.1:3000/api/publish \
  -H 'Content-Type: application/json' \
  -d '{
        "designId": "DAGxxxxxxx",
        "caption": "Shipped 🚀",
        "mode": "auto",
        "dryRun": false
      }'
```

```jsonc
{
  "designId": "DAGxxxxxxx",
  "mode": "carousel",
  "images": [{ "page": 1, "dimensions": {"width":1080,"height":1350}, "aspectRatio": 0.8 }],
  "mediaId": "17912345678901234",
  "permalink": "https://www.instagram.com/p/Cxxxxxxxxxx/",
  "quota": { "quotaUsage": 3, "quotaTotal": 100 },
  "warnings": [],
  "elapsedMs": 8421
}
```

---

## Where the Canva token lives

`TOKEN_STORE` decides this.

* **`browser`** (what you described) — after the callback the access token is
  handed to the page in a URL fragment, kept in `localStorage`, and replayed on
  every publish as the `x-canva-token` header.
* **`server`** (recommended for anything real) — the token stays in `.tokens.json`
  and never reaches the page.

Either way **the Canva API call itself happens on the server**, and that is not a
design choice I made — Canva's CORS policy blocks `api.canva.com` from a browser
page, and the token endpoint needs the client secret. A browser-only version of
this is not possible.

Treat `browser` mode as a convenience for local work: anything with access to
that page's `localStorage` (an XSS, a browser extension) can read the design
token.

---

## Things that will bite you

**Instagram only accepts JPEG.** Not PNG, not WebP. The exporter always requests
`format: {type: "jpg"}` for this reason.

**Aspect ratio.** Feed posts must sit between 4:5 (0.8) and 1.91:1. A 1080×1920
story-sized design gets rejected *before* anything is sent, with the fix spelled
out. Pass `ignoreAspectRatio: true` to publish anyway and let Instagram crop.
Safe Canva sizes: **1080×1080**, **1080×1350**, **1080×566**.

**Instagram fetches the image itself**, so the URL must be publicly reachable —
`localhost` will not work. `MEDIA_MODE` controls what it gets:

* `canva` (default) — hand over the Canva export URL directly. Works with no
  tunnel; the URLs are signed and expire after 24h.
* `proxy` — download and re-host at `PUBLIC_BASE_URL/media/<id>.jpg`. Needs the
  server publicly reachable (ngrok, cloudflared, or a real deployment). The
  startup guard rejects a private `PUBLIC_BASE_URL` rather than letting you find
  out from an opaque Instagram error.

**Rate limit:** 100 published posts per rolling 24 hours. The current usage comes
back in every publish report.

**Multi-page designs** become carousels automatically (2–10 pages). Anything past
10 is dropped with a warning. Force it either way with `mode`.

**Premium Canva elements** fail the export with `license_required` — the design
has to be licensed in Canva first. That error is passed through in plain English.

---

## Tests

```bash
npm test
```

58 assertions across three suites, run against mock Canva and Instagram servers —
no credentials or network needed. They cover the async export-job poll, single and
carousel publishing, the page cap, dry runs, the aspect-ratio gate and its
override, export failures, caption limits, proxy re-hosting (the mock actually
fetches the URL and checks the JPEG magic bytes), and the private-host guard.

```
src/
├── canva/       OAuth (PKCE) + Connect API client
├── instagram/   Graph API publishing client
├── publish/     the pipeline that joins them
├── routes/      auth, api, media
├── store/       token persistence + refresh, media re-host cache
└── lib/         http retry, PKCE, JPEG dimension reader
```

---

## Route B — post through Canva's own share flow (no Meta token)

Uses the Instagram account already linked **inside** your Canva account, by driving
Canva's real UI in a browser. No Instagram API token, no Meta app.

```bash
npm run dev          # then use the "post through Canva's own share flow" panel
# or headless-free CLI:
npm run canva:login                                        # sign in once
npm run canva:post -- --design DAGxxxxxxxxx --dry-run
npm run canva:post -- --design DAGxxxxxxxxx --caption "hi"
npm run canva:post -- --design DAGxxxxxxxxx --inspect       # dump Canva's current controls
```

### Two ways to sign in

The web UI's step 1 has a tab for each:

| | How | Notes |
|---|---|---|
| **Paste cookies** | copy your Canva session | no password leaves your machine; breaks when the session expires |
| **Email & password** | Canva's own login page, driven in the browser | handles 2FA: if Canva asks for an authenticator or emailed code, the UI prompts for it |

Canva prompts for a second factor on a new device. The UI tells you *which* kind
it wants — an authenticator-app code (rotating, 30s) reads very differently from
an emailed one, and sending someone to their inbox for a TOTP wastes their time.
Credentials are used to drive the login form and are never written to disk.

In the cookie tab you paste your Canva session instead of signing in. Get it from
**DevTools → Network → any canva.com request → Request Headers → the whole `Cookie:` line**.
`document.cookie` in the console will *not* work — the session cookie is `httpOnly`.
Pasted cookies go into a throwaway browser context and are never written to disk.

### Known constraints, measured not assumed

**Canva blocks headless browsers.** `canva.com` answers headless Chrome with a
Cloudflare challenge (HTTP 403, *"Just a moment..."*) and a headed window with
HTTP 200. So this route needs a real display — it cannot run on a headless server.
The CLI refuses to start without `DISPLAY`.

**There is no API contract here.** Route B depends on Canva's DOM, which can change
without notice or versioning. Every step tries several selector strategies,
screenshots itself into `.canva-debug/`, and on failure prints the step name plus
every visible control it could see, so a renamed button is diagnosable rather than a
blank timeout. Use `--inspect` to see current labels.

**It also likely conflicts with Canva's Terms of Service.** Automating the UI is not
something Canva sanctions; the account at risk is your own.

### Route A vs Route B

| | A — Instagram Graph API | B — Canva share flow |
|---|---|---|
| Setup | Meta app + token (~5 min) | paste cookies |
| Stability | versioned, supported | breaks whenever Canva ships |
| Headless / server | yes | no — needs a display |
| Credential held | IG token, publish-scoped | full Canva session |
| Multi-network | one token per network | whatever Canva has linked |

Route A is in `src/instagram/`, Route B in `src/canva-ui/`. They share the same
export pipeline.

---

## Route B in CI — GitHub Actions

`.github/workflows/canva-publish.yml` runs the same flow unattended on a runner.

```
Run workflow ▾
  design_id  DAGxxxxxxxxx
  platform   Instagram
  account    (blank = whatever Canva has selected)
  caption    New drop 🔥
  dry_run    ✓  ← leave ticked for the first run
```

### Why the workflow looks the way it does

Every unusual step is forced by one measured fact: **Canva answers headless
Chrome with a Cloudflare interstitial** (HTTP 403, *"Just a moment..."*) and a
headed window with HTTP 200. So:

| Step | Reason |
|---|---|
| `Xvfb :99` | a runner has no display, and the browser cannot be headless (see below) |
| ungoogled-chromium (pinned `149.0.7827.53-1`) | same build the url-scraper workflows use, so Cloudflare behaves identically |
| cf-autoclick extension | clears the Turnstile checkbox; Chrome won't load extensions headless either |
| `--no-sandbox --disable-dev-shm-usage` | required on GitHub runners |
| warm-up navigation before anything else | lets cf-autoclick clear the challenge and `cf_clearance` settle before the real work |

The browser stack is identical to `url-scraper-local-2`, deliberately — one
Cloudflare story to maintain, not two.

### Why not headless?

Tested rather than assumed. Identical code, cookies and stack, minutes apart:

| Mode | Result |
|---|---|
| **headed** + cf-autoclick | first load is `Home - Canva`, never challenged, full run in **~42s** |
| **headless** + cf-autoclick | `Just a moment...`, cleared once after ~16s, then **re-challenged on the next navigation** and never cleared again within 60s |
| headless, no extension | blocked outright |

cf-autoclick can beat a single Turnstile headless — but Cloudflare fingerprints
the headless browser and re-arms the challenge on every navigation, which
clicking cannot fix. Hence Xvfb.

`CANVA_HEADLESS=1` still exists to re-test if that ever changes; it warns loudly
and will most likely fail.

### Setup

Add one repository secret:

| Secret | Value |
|---|---|
| `CANVA_COOKIES` | your Canva session — the `Cookie:` header, a `cookies.txt`, or a JSON export |

Nothing else is needed: the runner downloads Chromium and cf-autoclick itself.

**Cookies expire.** That is the maintenance cost of this route — when the run
fails with *"Cookies did not produce a signed-in Canva session"*, re-copy the
cookie and update the secret. Password sign-in is not usable in CI, because
Canva asks for a 2FA code on every fresh browser and nothing in a runner can
answer it.

### Output

* `.canva-debug/summary.json` — machine-readable result, also printed to the job summary
* screenshots of every step, uploaded as an artifact (7-day retention)

Since Canva's DOM has no API contract, those screenshots are the debugging
story when a selector breaks.

### Running it locally the same way

```bash
# one-off vendor setup
mkdir -p vendor
curl -fsSL -o /tmp/chromium.tar.xz \
  https://github.com/ungoogled-software/ungoogled-chromium-portablelinux/releases/download/149.0.7827.53-1/ungoogled-chromium-149.0.7827.53-1-x86_64_linux.tar.xz
tar -xJf /tmp/chromium.tar.xz -C vendor/ && mv vendor/ungoogled-chromium-* vendor/ungoogled-chromium
git clone --depth 1 https://github.com/tenacious6/cf-autoclick.git vendor/cf-autoclick

# then
CANVA_COOKIES_FILE=./cookies.txt \
CANVA_DESIGN_ID=DAGxxxxxxxxx \
CANVA_CAPTION="hello" \
CANVA_DRY_RUN=1 \
CHROME_BIN=vendor/ungoogled-chromium/chrome \
CF_AUTOCLICK_DIR=vendor/cf-autoclick \
npm run ci:publish
```

Omit `CHROME_BIN`/`CF_AUTOCLICK_DIR` and it falls back to your system Chrome,
which is what the web UI uses locally.

---

## If you did want the in-editor flow too

The intent API from your link is worth building *as well as* this, not instead of
it — it puts your publisher inside **Share → your app** for users already in
Canva. It's a separate Canva App (`@canva/intents/content`) whose `publishContent`
callback would post to this server's `/api/publish`. The Instagram half here is
reusable as-is.
