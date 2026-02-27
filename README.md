# MASS

## Environment Variables

- `AUTH_SECRET` – required for stable auth tokens in production. If unset, the server now generates an ephemeral value and stores it in `data/.auth_secret`, but sessions will reset whenever the app redeploys. Configure a persistent secret via your hosting provider to avoid churn.
- `TRUST_PROXY` – controls which upstream proxies Express should trust. Defaults to `'loopback'` locally; set to `1` (or your platform-specific value) in production so rate limiting sees real client IPs without triggering validation errors.
- `FM_TIMEOUT_MS` – optional; override the default 45 000 ms FileMaker request timeout if your deployment needs a longer or shorter window.
- `FM_MAX_CONCURRENT_REQUESTS` / `FM_MIN_REQUEST_INTERVAL_MS` – tune the FileMaker concurrency guard rails. Defaults are 8 parallel requests and a 10 ms inter-request delay.
- `HTTP2_ENABLED`, `HTTP2_CERT_PATH`, `HTTP2_KEY_PATH` – serve the Express app over HTTP/2 when these are set (cert/key point to PEM files and `HTTP2_ENABLED` is `true`). The server falls back to HTTP/1.1 automatically if the files are missing.

The random-songs endpoint keeps a persisted seed in `data/random-songs-cache.json`. It is refreshed automatically after successful FileMaker pulls and lets the first request return instantly while a fresh batch is fetched in the background.
