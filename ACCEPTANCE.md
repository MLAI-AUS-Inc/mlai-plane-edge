# Staging edge acceptance — 1 August 2026

This is evidence for a disposable Cloudflare/loopback rehearsal. It does not
represent a persistent named Tunnel, Access policy, or production cutover.

## Automated gates

- `bun install --frozen-lockfile` passed.
- `bun run check` passed: TypeScript, 31 Workerd tests, and a production
  Wrangler dry run.
- The suite covers request-cookie isolation, response-cookie domain handling,
  streaming, redirects, WebSocket response preservation, forwarding-header
  replacement, fail-closed configuration, and legacy logout compatibility.

## Live Worker rehearsal

The live rehearsal used the preceding 29-test revision; the two subsequent
tests cover the immutable source-disclosure gate and do not change proxy/cookie
behavior. The authenticated MLAI Cloudflare account deployed only the staging Worker at
`mlai-plane-edge-staging.mlai-530.workers.dev`. No `mlai.au` route or production
Worker was changed.

1. Version `428e48eb-b80d-4cdf-b127-db6675f2a793` proxied through a disposable
   Quick Tunnel to the fresh local Plane stack. A live request returned `200`,
   Plane `1.4.0`, setup complete, telemetry disabled, `X-Robots-Tag: noindex`,
   `X-Frame-Options: DENY`, and no parent-domain response cookie.
2. Version `dd8f158b-c95e-45df-bc4d-f1236a2f52ef` proxied to a temporary canary
   that reported cookie-name presence as booleans only. A request containing
   `access_token`, `refresh_token`, `sessionid`, `CF_Authorization`, and
   `__Host-plane-session` proved all four denylisted names absent and the Plane
   session name present at origin. Two response cookies remained distinct and
   neither retained `Domain=.mlai.au`.
3. The temporary tunnels were stopped. Version
   `9cf020c5-ec7a-4468-bc92-5d5c688660a8` restored the checked-in `.invalid`
   origin, and a fresh request proved the staging Worker now fails closed with
   `503`.

No cookie values, generated passwords, sessions, or origin credentials were
recorded. A persistent named staging Tunnel with the exact public-host rewrite,
live OAuth/logout, signed upload/download host validation, browser, WebSocket
`101`, Access, WAF, and monitoring tests remain required.
