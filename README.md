# MLAI Plane edge gateway

Production-oriented Cloudflare Worker for routing `admin.mlai.au` to a private
[Plane](https://github.com/makeplane/plane) origin while preventing MLAI's
parent-domain authentication cookies from crossing that trust boundary.

This is a standalone project. It is not part of the `mlai-au` React Router
Worker and it does not contain or fork Plane.

## Security invariants

In `plane` mode, the gateway:

- removes the exact request cookie names `access_token`, `refresh_token`, and
  `sessionid` before the request reaches Plane;
- removes additional exact names from `ADDITIONAL_DENIED_COOKIES` (production
  includes Cloudflare Access's `CF_Authorization` cookie);
- allows Plane cookies such as `session-id`, `admin-session-id`, `csrftoken`,
  and `__Host-plane-session` to pass unchanged;
- removes every outbound `Domain=.mlai.au` or `Domain=mlai.au` attribute from
  `Set-Cookie`, making the cookie host-only at `admin.mlai.au`;
- removes inbound origin service-token headers and injects only the configured
  secret values;
- replaces spoofable forwarding headers with Cloudflare's connecting IP and the
  public request host/protocol;
- never writes request headers, cookies, origin URLs, credentials, or thrown
  error messages to application logs;
- fails closed for missing, insecure, recursive, placeholder, or malformed
  origin configuration; and
- adds noindex and baseline browser security headers to every response; and
- publishes an immutable exact-commit source link on Plane responses and at
  `/.well-known/mlai-source`.

Cookie names are case-sensitive. Unknown cookies are intentionally forwarded:
this is a narrow denylist boundary that will not silently break future Plane
cookies. Add any newly discovered parent-domain credentials to
`ADDITIONAL_DENIED_COOKIES` before cutover.

In `legacy` mode, the gateway calls the existing `mlai-admin` Worker through a
service binding. It intentionally preserves incoming MLAI cookies because the
trusted legacy application needs them for authentication. It also preserves
distinct legacy `Set-Cookie` fields and their parent-domain attributes exactly,
which is required for `/logout` to clear the MLAI access, refresh, and session
cookies. This trust is limited to the legacy service-binding path; Plane mode
retains the strict isolation policy above.

## Data path

```text
Browser
  -> Cloudflare Access / WAF
  -> admin.mlai.au/* Worker route
  -> mlai-plane-edge
       | plane mode  -> HTTPS + optional Access service token -> private Plane origin
       |                Tunnel rewrites final Host to the public gateway host
       | legacy mode -> LEGACY_ADMIN service binding          -> mlai-admin Worker
```

The gateway passes request and response streams through without buffering. It
rebuilds the upstream response only to edit headers, retaining redirects,
distinct `Set-Cookie` fields, status text, and Cloudflare's proxied `webSocket`
property on a `101` response. Every response receives `X-Frame-Options: DENY`,
matching the pinned Plane proxy rather than weakening its framing policy.
The named Tunnel must also rewrite the final origin `Host` to the public gateway
host. The Worker supplies `X-Forwarded-Host`, but Plane v1.4 does not use that
header for every generated OAuth or MinIO URL; see the exact staging and
production invariants in the runbook.

## Local development

Requirements: Bun 1.3.5 or newer and a Cloudflare account for remote operations.

```sh
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
bun run dev
```

Replace `PLANE_ORIGIN_URL` in the untracked `.dev.vars`. The origin must be a
distinct HTTPS origin and must never be `admin.mlai.au`.

Run all local gates:

```sh
bun run check
```

This runs TypeScript, the Workerd/Vitest suite, and a production Wrangler dry
run. The tests run inside the Cloudflare Workers runtime, not a browser shim.

## Configuration

| Binding | Required | Treatment | Purpose |
| --- | --- | --- | --- |
| `ROUTING_MODE` | yes | Wrangler var | Exact value `legacy` or `plane`; any other value fails closed. |
| `PLANE_ORIGIN_URL` | Plane mode | Wrangler var | Distinct HTTPS origin with no path, query, fragment, or credentials. |
| `PLANE_SOURCE_URL` | Plane mode | Wrangler var | Exact 40-character commit URL in the public MLAI Plane fork. |
| `ADDITIONAL_DENIED_COOKIES` | no | Wrangler var | Comma/whitespace-separated exact cookie names. |
| `PLANE_ACCESS_CLIENT_ID` | no | Wrangler secret | Cloudflare Access service-token client ID for the private origin. |
| `PLANE_ACCESS_CLIENT_SECRET` | no | Wrangler secret | Matching service-token secret; configuring only one fails closed. |
| `LEGACY_ADMIN` | Legacy mode | service binding | Targets the existing `mlai-admin` Worker. |

Do not store production service-token values in `wrangler.jsonc`, `.dev.vars.example`,
shell history, issue trackers, or logs. Configure them interactively:

```sh
bunx wrangler secret put PLANE_ACCESS_CLIENT_ID --env production
bunx wrangler secret put PLANE_ACCESS_CLIENT_SECRET --env production
```

`wrangler.jsonc` deliberately starts production in `legacy` mode and uses an
`.invalid` Plane origin. A first deployment therefore cannot accidentally route
users into an unverified Plane installation.

## Operations

Follow [RUNBOOK.md](./RUNBOOK.md) for staging, cutover, verification, rollback,
and incident handling. The dated disposable edge rehearsal is recorded in
[ACCEPTANCE.md](./ACCEPTANCE.md). Do not deploy production solely from this
README.

Primary Cloudflare API references:

- [Headers and multiple Set-Cookie fields](https://developers.cloudflare.com/workers/runtime-apis/headers/)
- [Response streaming and proxied WebSockets](https://developers.cloudflare.com/workers/runtime-apis/response/)
- [Service bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/)
- [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
